package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	oss "github.com/aliyun/aliyun-oss-go-sdk/oss"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type TransferType string

const (
	TransferTypeUpload   TransferType = "upload"
	TransferTypeDownload TransferType = "download"
)

type TransferStatus string

const (
	TransferStatusQueued     TransferStatus = "queued"
	TransferStatusInProgress TransferStatus = "in-progress"
	TransferStatusSuccess    TransferStatus = "success"
	TransferStatusError      TransferStatus = "error"
)

const (
	transferHistoryFileName        = "transfers.json"
	transferHistorySchemaVersion   = 2
	transferProfileAnonymous       = "__anonymous__"
	maxTransferHistoryRecords      = 3000
	transferHistoryPersistInterval = 500 * time.Millisecond
)

type TransferUpdate struct {
	ID               string         `json:"id"`
	ProfileName      string         `json:"profileName,omitempty"`
	Type             TransferType   `json:"type"`
	Status           TransferStatus `json:"status"`
	Name             string         `json:"name"`
	Bucket           string         `json:"bucket"`
	Key              string         `json:"key"`
	LocalPath        string         `json:"localPath,omitempty"`
	ParentID         string         `json:"parentId,omitempty"`
	IsGroup          bool           `json:"isGroup,omitempty"`
	FileCount        int            `json:"fileCount,omitempty"`
	DoneCount        int            `json:"doneCount,omitempty"`
	SuccessCount     int            `json:"successCount,omitempty"`
	ErrorCount       int            `json:"errorCount,omitempty"`
	TotalBytes       int64          `json:"totalBytes,omitempty"`
	DoneBytes        int64          `json:"doneBytes,omitempty"`
	SpeedBytesPerSec float64        `json:"speedBytesPerSec,omitempty"`
	EtaSeconds       int64          `json:"etaSeconds,omitempty"`
	Message          string         `json:"message,omitempty"`
	StartedAtMs      int64          `json:"startedAtMs,omitempty"`
	UpdatedAtMs      int64          `json:"updatedAtMs,omitempty"`
	FinishedAtMs     int64          `json:"finishedAtMs,omitempty"`
}

type transferHistoryStore struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Profiles      map[string][]TransferUpdate `json:"profiles"`
}

type transferLimiter struct {
	mu     sync.Mutex
	cond   *sync.Cond
	active int
	max    int
}

func newTransferLimiter(max int) *transferLimiter {
	if max < 1 {
		max = 1
	}
	l := &transferLimiter{max: max}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *transferLimiter) Acquire() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for l.active >= l.max {
		l.cond.Wait()
	}
	l.active++
}

func (l *transferLimiter) Release() {
	l.mu.Lock()
	if l.active > 0 {
		l.active--
	}
	l.mu.Unlock()
	l.cond.Broadcast()
}

func (l *transferLimiter) SetMax(max int) {
	if max < 1 {
		max = 1
	}
	l.mu.Lock()
	l.max = max
	l.mu.Unlock()
	l.cond.Broadcast()
}

func (s *OSSService) SetContext(ctx context.Context) {
	s.transferCtxMu.Lock()
	s.transferCtx = ctx
	s.transferCtxMu.Unlock()
}

func (s *OSSService) emitTransferUpdate(update TransferUpdate) {
	s.transferCtxMu.RLock()
	ctx := s.transferCtx
	s.transferCtxMu.RUnlock()
	if ctx == nil {
		return
	}
	runtime.EventsEmit(ctx, "transfer:update", update)
}

func (s *OSSService) emitTransfer(update TransferUpdate, onUpdate func(TransferUpdate)) {
	s.recordTransferUpdate(update)
	s.emitTransferUpdate(update)
	if onUpdate != nil {
		onUpdate(update)
	}
}

func (s *OSSService) getMaxTransferThreads() int {
	s.transferLimiterMu.RLock()
	defer s.transferLimiterMu.RUnlock()
	if s.transferLimiter == nil {
		return 1
	}
	return s.transferLimiter.max
}

func (s *OSSService) setMaxTransferThreads(max int) {
	s.transferLimiterMu.Lock()
	defer s.transferLimiterMu.Unlock()
	if s.transferLimiter == nil {
		s.transferLimiter = newTransferLimiter(max)
		return
	}
	s.transferLimiter.SetMax(max)
}

func transferSortTimestamp(update TransferUpdate) int64 {
	if update.UpdatedAtMs > 0 {
		return update.UpdatedAtMs
	}
	if update.FinishedAtMs > 0 {
		return update.FinishedAtMs
	}
	return update.StartedAtMs
}

func isTransferFinalStatus(status TransferStatus) bool {
	return status == TransferStatusSuccess || status == TransferStatusError
}

func normalizeTransferProfileName(profileName string) string {
	profileName = strings.TrimSpace(profileName)
	if profileName == "" {
		return transferProfileAnonymous
	}
	return profileName
}

func transferHistoryStorageID(profileName string, transferID string) string {
	return normalizeTransferProfileName(profileName) + "::" + strings.TrimSpace(transferID)
}

func normalizeTransferDefaultPath(defaultPath string) string {
	bucket, prefix, ok := parseDefaultPathLocation(defaultPath)
	if !ok {
		return strings.TrimSpace(defaultPath)
	}
	if prefix == "" {
		return fmt.Sprintf("oss://%s", bucket)
	}
	return fmt.Sprintf("oss://%s/%s", bucket, prefix)
}

func transferConfigSignature(config OSSConfig) string {
	return strings.Join([]string{
		strings.TrimSpace(config.AccessKeyID),
		strings.TrimSpace(config.AccessKeySecret),
		normalizeRegion(config.Region),
		normalizeEndpoint(config.Endpoint),
		normalizeTransferDefaultPath(config.DefaultPath),
	}, "\x1f")
}

func (s *OSSService) resolveTransferProfileName(config OSSConfig) string {
	target := transferConfigSignature(config)
	if target == "" {
		return transferProfileAnonymous
	}

	state, err := s.loadAppState()
	if err != nil {
		return transferProfileAnonymous
	}

	for _, profile := range state.Profiles {
		if transferConfigSignature(profile.Config) == target {
			return normalizeTransferProfileName(profile.Name)
		}
	}
	return transferProfileAnonymous
}

func decodeTransferHistoryPayload(data []byte) []TransferUpdate {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return []TransferUpdate{}
	}

	var store transferHistoryStore
	if err := json.Unmarshal([]byte(trimmed), &store); err == nil && (store.SchemaVersion > 0 || store.Profiles != nil) {
		out := make([]TransferUpdate, 0, 128)
		profileKeys := make([]string, 0, len(store.Profiles))
		for profileName := range store.Profiles {
			profileKeys = append(profileKeys, profileName)
		}
		sort.Strings(profileKeys)

		for _, profileName := range profileKeys {
			groupProfile := normalizeTransferProfileName(profileName)
			for _, item := range store.Profiles[profileName] {
				if strings.TrimSpace(item.ProfileName) == "" {
					item.ProfileName = groupProfile
				} else {
					item.ProfileName = normalizeTransferProfileName(item.ProfileName)
				}
				out = append(out, item)
			}
		}
		return out
	}

	var legacy []TransferUpdate
	if err := json.Unmarshal([]byte(trimmed), &legacy); err == nil {
		for i := range legacy {
			legacy[i].ProfileName = normalizeTransferProfileName(legacy[i].ProfileName)
		}
		return legacy
	}

	return []TransferUpdate{}
}

func buildTransferHistoryStore(history []TransferUpdate) transferHistoryStore {
	store := transferHistoryStore{
		SchemaVersion: transferHistorySchemaVersion,
		Profiles:      make(map[string][]TransferUpdate),
	}
	for _, item := range history {
		profileName := normalizeTransferProfileName(item.ProfileName)
		item.ProfileName = profileName
		store.Profiles[profileName] = append(store.Profiles[profileName], item)
	}
	return store
}

func (s *OSSService) findTransferProfileByIDLocked(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	for i := len(s.transferHistoryOrder) - 1; i >= 0; i-- {
		storageID := s.transferHistoryOrder[i]
		item, ok := s.transferHistoryByID[storageID]
		if !ok {
			continue
		}
		if strings.TrimSpace(item.ID) == id {
			return normalizeTransferProfileName(item.ProfileName)
		}
	}
	return ""
}

func (s *OSSService) transferHistoryPathIn(dir string) string {
	return filepath.Join(dir, transferHistoryFileName)
}

func (s *OSSService) copyTransferHistoryIfNeeded(previousDir string, nextDir string) {
	previousDir = normalizeWorkDirPath(previousDir, s.defaultConfigDir)
	nextDir = normalizeWorkDirPath(nextDir, s.defaultConfigDir)
	if previousDir == "" || nextDir == "" || previousDir == nextDir {
		return
	}

	previousPath := s.transferHistoryPathIn(previousDir)
	newPath := s.transferHistoryPathIn(nextDir)

	if _, err := os.Stat(newPath); err == nil {
		return
	}

	data, err := os.ReadFile(previousPath)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(newPath), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(newPath, data, 0o600)
}

func (s *OSSService) trimTransferHistoryByProfileLocked(profileName string) {
	profileName = normalizeTransferProfileName(profileName)
	if maxTransferHistoryRecords < 1 {
		return
	}

	count := 0
	for _, storageID := range s.transferHistoryOrder {
		item, ok := s.transferHistoryByID[storageID]
		if !ok {
			continue
		}
		if normalizeTransferProfileName(item.ProfileName) == profileName {
			count++
		}
	}

	overflow := count - maxTransferHistoryRecords
	if overflow <= 0 {
		return
	}

	nextOrder := make([]string, 0, len(s.transferHistoryOrder)-overflow)
	for _, storageID := range s.transferHistoryOrder {
		item, ok := s.transferHistoryByID[storageID]
		if !ok {
			continue
		}
		if overflow > 0 && normalizeTransferProfileName(item.ProfileName) == profileName {
			delete(s.transferHistoryByID, storageID)
			overflow--
			continue
		}
		nextOrder = append(nextOrder, storageID)
	}
	s.transferHistoryOrder = nextOrder
}

func (s *OSSService) trimTransferHistoryAllProfilesLocked() {
	profiles := make(map[string]struct{}, 8)
	for _, item := range s.transferHistoryByID {
		profiles[normalizeTransferProfileName(item.ProfileName)] = struct{}{}
	}
	for profileName := range profiles {
		s.trimTransferHistoryByProfileLocked(profileName)
	}
}

func (s *OSSService) transferHistorySnapshotLocked() []TransferUpdate {
	if len(s.transferHistoryByID) == 0 {
		return []TransferUpdate{}
	}
	items := make([]TransferUpdate, 0, len(s.transferHistoryByID))
	for _, id := range s.transferHistoryOrder {
		if item, ok := s.transferHistoryByID[id]; ok {
			items = append(items, item)
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		left := transferSortTimestamp(items[i])
		right := transferSortTimestamp(items[j])
		if left == right {
			return items[i].ID > items[j].ID
		}
		return left > right
	})
	return items
}

func (s *OSSService) transferHistoryPersistPlanLocked(force bool) (string, []TransferUpdate, bool) {
	now := time.Now()
	if !force && !s.transferHistoryLastPersistAt.IsZero() && now.Sub(s.transferHistoryLastPersistAt) < transferHistoryPersistInterval {
		return "", nil, false
	}
	s.transferHistoryLastPersistAt = now
	return s.transferHistoryPathIn(s.transferHistoryLoadedDir), s.transferHistorySnapshotLocked(), true
}

func (s *OSSService) persistTransferHistory(path string, history []TransferUpdate) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	store := buildTransferHistoryStore(history)
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func (s *OSSService) ensureTransferHistoryLoadedLocked() {
	dir := normalizeWorkDirPath(s.configDir, s.defaultConfigDir)
	if s.transferHistoryLoaded && s.transferHistoryLoadedDir == dir {
		if s.transferHistoryByID == nil {
			s.transferHistoryByID = make(map[string]TransferUpdate)
		}
		return
	}

	s.transferHistoryLoaded = true
	s.transferHistoryLoadedDir = dir
	s.transferHistoryLastPersistAt = time.Time{}
	s.transferHistoryByID = make(map[string]TransferUpdate)
	s.transferHistoryOrder = make([]string, 0, 128)

	data, err := os.ReadFile(s.transferHistoryPathIn(dir))
	if err != nil {
		return
	}

	history := decodeTransferHistoryPayload(data)

	now := time.Now().UnixMilli()
	for _, item := range history {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		item.ProfileName = normalizeTransferProfileName(item.ProfileName)

		if item.Status == TransferStatusQueued || item.Status == TransferStatusInProgress {
			item.Status = TransferStatusError
			if strings.TrimSpace(item.Message) == "" {
				item.Message = "Interrupted when application exited"
			}
			item.SpeedBytesPerSec = 0
			item.EtaSeconds = 0
			if item.FinishedAtMs == 0 {
				item.FinishedAtMs = now
			}
			if item.UpdatedAtMs == 0 || item.UpdatedAtMs < item.FinishedAtMs {
				item.UpdatedAtMs = item.FinishedAtMs
			}
		}

		storageID := transferHistoryStorageID(item.ProfileName, id)
		if existing, exists := s.transferHistoryByID[storageID]; exists {
			if transferSortTimestamp(item) >= transferSortTimestamp(existing) {
				s.transferHistoryByID[storageID] = item
			}
			continue
		}

		s.transferHistoryByID[storageID] = item
		s.transferHistoryOrder = append(s.transferHistoryOrder, storageID)
	}

	s.trimTransferHistoryAllProfilesLocked()
}

func (s *OSSService) recordTransferUpdate(update TransferUpdate) {
	id := strings.TrimSpace(update.ID)
	if id == "" {
		return
	}
	if update.UpdatedAtMs == 0 {
		update.UpdatedAtMs = time.Now().UnixMilli()
	}

	forcePersist := isTransferFinalStatus(update.Status)

	s.transferHistoryMu.Lock()
	s.ensureTransferHistoryLoadedLocked()

	profileName := normalizeTransferProfileName(update.ProfileName)
	if profileName == transferProfileAnonymous {
		if existingProfile := s.findTransferProfileByIDLocked(id); existingProfile != "" {
			profileName = existingProfile
		}
	}
	update.ProfileName = profileName
	storageID := transferHistoryStorageID(profileName, id)

	if _, exists := s.transferHistoryByID[storageID]; !exists {
		s.transferHistoryOrder = append(s.transferHistoryOrder, storageID)
	}
	s.transferHistoryByID[storageID] = update
	s.trimTransferHistoryByProfileLocked(profileName)

	path, snapshot, shouldPersist := s.transferHistoryPersistPlanLocked(forcePersist)
	s.transferHistoryMu.Unlock()

	if !shouldPersist {
		return
	}
	_ = s.persistTransferHistory(path, snapshot)
}

func (s *OSSService) GetTransferHistory() ([]TransferUpdate, error) {
	s.transferHistoryMu.Lock()
	s.ensureTransferHistoryLoadedLocked()
	path, snapshot, shouldPersist := s.transferHistoryPersistPlanLocked(false)
	s.transferHistoryMu.Unlock()

	if shouldPersist {
		_ = s.persistTransferHistory(path, snapshot)
	}
	return snapshot, nil
}

type uploadFilePlan struct {
	LocalPath   string
	RelativeKey string
	DisplayName string
	Size        int64
}

type uploadPlan struct {
	LocalPath string
	IsDir     bool
	RootName  string
	Files     []uploadFilePlan
	TotalSize int64
}

type transferGroupChildState struct {
	TotalBytes       int64
	DoneBytes        int64
	SpeedBytesPerSec float64
	Status           TransferStatus
	StartedAtMs      int64
	FinishedAtMs     int64
}

func normalizeTransferBucket(bucket string) string {
	return strings.Trim(strings.TrimSpace(bucket), "/")
}

func normalizeTransferPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	prefix = strings.TrimLeft(prefix, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

func normalizeTransferObjectKey(key string) string {
	return strings.TrimLeft(strings.TrimSpace(key), "/")
}

func normalizeTransferFolderKey(key string) string {
	key = normalizeTransferObjectKey(key)
	if key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	return key
}

func safeRelativeDownloadPath(relative string) (string, error) {
	relative = strings.TrimSpace(relative)
	relative = strings.TrimLeft(relative, "/")
	if relative == "" {
		return "", errors.New("empty relative path")
	}
	clean := filepath.Clean(filepath.FromSlash(relative))
	if filepath.IsAbs(clean) || filepath.VolumeName(clean) != "" {
		return "", fmt.Errorf("unsafe relative path: %s", relative)
	}
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe relative path: %s", relative)
	}
	return clean, nil
}

func (s *OSSService) newTransferID() string {
	return fmt.Sprintf("tr-%d-%d", time.Now().UnixMilli(), atomic.AddUint64(&s.transferSeq, 1))
}

func buildUploadPlan(localPath string) (uploadPlan, error) {
	localPath = strings.TrimSpace(localPath)
	if localPath == "" {
		return uploadPlan{}, errors.New("local path is empty")
	}
	localPath = filepath.Clean(localPath)

	stat, err := os.Stat(localPath)
	if err != nil {
		return uploadPlan{}, fmt.Errorf("stat local path failed: %w", err)
	}

	if !stat.IsDir() {
		name := filepath.Base(localPath)
		return uploadPlan{
			LocalPath: localPath,
			IsDir:     false,
			RootName:  name,
			Files: []uploadFilePlan{
				{
					LocalPath:   localPath,
					RelativeKey: filepath.ToSlash(name),
					DisplayName: name,
					Size:        stat.Size(),
				},
			},
			TotalSize: stat.Size(),
		}, nil
	}

	rootName := filepath.Base(localPath)
	if rootName == "." || rootName == string(filepath.Separator) || strings.TrimSpace(rootName) == "" {
		rootName = "folder"
	}

	plan := uploadPlan{
		LocalPath: localPath,
		IsDir:     true,
		RootName:  rootName,
		Files:     make([]uploadFilePlan, 0, 16),
	}

	err = filepath.WalkDir(localPath, func(current string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}

		info, infoErr := d.Info()
		if infoErr != nil {
			return infoErr
		}

		rel, relErr := filepath.Rel(localPath, current)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		rel = strings.TrimLeft(rel, "/")
		if rel == "" || rel == "." {
			return nil
		}

		relativeKey := path.Join(rootName, rel)
		plan.Files = append(plan.Files, uploadFilePlan{
			LocalPath:   current,
			RelativeKey: relativeKey,
			DisplayName: relativeKey,
			Size:        info.Size(),
		})
		if info.Size() > 0 {
			plan.TotalSize += info.Size()
		}
		return nil
	})
	if err != nil {
		return uploadPlan{}, fmt.Errorf("walk folder failed: %w", err)
	}

	if len(plan.Files) == 0 {
		return uploadPlan{}, errors.New("folder has no files to upload")
	}

	return plan, nil
}

func (s *OSSService) enqueueTransfer(config OSSConfig, update TransferUpdate, onUpdate func(TransferUpdate)) {
	if strings.TrimSpace(update.ProfileName) == "" {
		update.ProfileName = s.resolveTransferProfileName(config)
	}
	update.ProfileName = normalizeTransferProfileName(update.ProfileName)
	s.emitTransfer(update, onUpdate)
	go s.runTransfer(config, update, onUpdate)
}

func (s *OSSService) enqueueTransferGroup(config OSSConfig, group TransferUpdate, children []TransferUpdate) error {
	if len(children) == 0 {
		return errors.New("group has no child transfers")
	}

	if group.ID == "" {
		group.ID = s.newTransferID()
	}
	if strings.TrimSpace(group.ProfileName) == "" {
		group.ProfileName = s.resolveTransferProfileName(config)
	}
	group.ProfileName = normalizeTransferProfileName(group.ProfileName)
	group.IsGroup = true
	group.Status = TransferStatusQueued
	group.FileCount = len(children)
	group.DoneCount = 0
	group.SuccessCount = 0
	group.ErrorCount = 0
	group.UpdatedAtMs = time.Now().UnixMilli()
	group.ParentID = ""
	group.SpeedBytesPerSec = 0
	group.EtaSeconds = 0
	group.StartedAtMs = 0
	group.FinishedAtMs = 0
	s.emitTransfer(group, nil)

	childStates := make(map[string]transferGroupChildState, len(children))
	for i := range children {
		child := children[i]
		if child.ID == "" {
			child.ID = s.newTransferID()
		}
		if strings.TrimSpace(child.ProfileName) == "" {
			child.ProfileName = group.ProfileName
		}
		child.ProfileName = normalizeTransferProfileName(child.ProfileName)
		child.ParentID = group.ID
		child.Status = TransferStatusQueued
		child.UpdatedAtMs = time.Now().UnixMilli()
		children[i] = child
		childStates[child.ID] = transferGroupChildState{
			TotalBytes: child.TotalBytes,
			DoneBytes:  child.DoneBytes,
			Status:     TransferStatusQueued,
		}
		s.emitTransfer(child, nil)
	}

	var mu sync.Mutex
	emitInterval := 250 * time.Millisecond
	var lastEmit time.Time
	currentGroup := group

	emitGroupLocked := func(force bool) {
		now := time.Now()
		if !force && !lastEmit.IsZero() && now.Sub(lastEmit) < emitInterval {
			return
		}
		lastEmit = now

		totalBytes := int64(0)
		doneBytes := int64(0)
		speed := 0.0
		doneCount := 0
		successCount := 0
		errorCount := 0
		hasInProgress := false
		startedAt := int64(0)
		finishedAt := int64(0)

		for _, child := range childStates {
			if child.TotalBytes > 0 {
				totalBytes += child.TotalBytes
			}
			if child.DoneBytes > 0 {
				doneBytes += child.DoneBytes
			}
			if child.Status == TransferStatusInProgress && child.SpeedBytesPerSec > 0 {
				speed += child.SpeedBytesPerSec
			}

			switch child.Status {
			case TransferStatusSuccess:
				doneCount++
				successCount++
			case TransferStatusError:
				doneCount++
				errorCount++
			case TransferStatusInProgress:
				hasInProgress = true
			}

			if child.StartedAtMs > 0 && (startedAt == 0 || child.StartedAtMs < startedAt) {
				startedAt = child.StartedAtMs
			}
			if child.FinishedAtMs > finishedAt {
				finishedAt = child.FinishedAtMs
			}
		}

		next := currentGroup
		next.TotalBytes = totalBytes
		next.DoneBytes = doneBytes
		next.SpeedBytesPerSec = speed
		next.FileCount = len(childStates)
		next.DoneCount = doneCount
		next.SuccessCount = successCount
		next.ErrorCount = errorCount
		if totalBytes > 0 && speed > 0 && doneBytes >= 0 && doneBytes <= totalBytes {
			next.EtaSeconds = int64(float64(totalBytes-doneBytes) / speed)
		} else {
			next.EtaSeconds = 0
		}
		if startedAt > 0 {
			next.StartedAtMs = startedAt
		}
		next.UpdatedAtMs = now.UnixMilli()

		if doneCount >= len(childStates) {
			if errorCount > 0 {
				next.Status = TransferStatusError
				next.Message = fmt.Sprintf("%d succeeded, %d failed", successCount, errorCount)
			} else {
				next.Status = TransferStatusSuccess
				next.Message = ""
				if next.TotalBytes > 0 {
					next.DoneBytes = next.TotalBytes
				}
			}
			if finishedAt == 0 {
				finishedAt = now.UnixMilli()
			}
			next.FinishedAtMs = finishedAt
			next.SpeedBytesPerSec = 0
			next.EtaSeconds = 0
		} else if hasInProgress || doneCount > 0 || startedAt > 0 {
			next.Status = TransferStatusInProgress
			if errorCount > 0 {
				next.Message = fmt.Sprintf("%d failed", errorCount)
			} else {
				next.Message = ""
			}
		}

		currentGroup = next
		s.emitTransfer(next, nil)
	}

	onChildUpdate := func(child TransferUpdate) {
		mu.Lock()
		state := childStates[child.ID]
		if child.TotalBytes > 0 {
			state.TotalBytes = child.TotalBytes
		}
		if child.DoneBytes > 0 {
			state.DoneBytes = child.DoneBytes
		} else if child.Status == TransferStatusSuccess && state.TotalBytes > 0 {
			state.DoneBytes = state.TotalBytes
		}
		state.SpeedBytesPerSec = child.SpeedBytesPerSec
		state.Status = child.Status
		if child.StartedAtMs > 0 && (state.StartedAtMs == 0 || child.StartedAtMs < state.StartedAtMs) {
			state.StartedAtMs = child.StartedAtMs
		}
		if child.FinishedAtMs > 0 {
			state.FinishedAtMs = child.FinishedAtMs
		}
		childStates[child.ID] = state
		force := child.Status == TransferStatusSuccess || child.Status == TransferStatusError
		emitGroupLocked(force)
		mu.Unlock()
	}

	for _, child := range children {
		child := child
		go s.runTransfer(config, child, onChildUpdate)
	}

	return nil
}

func (s *OSSService) enqueueUploadPlan(config OSSConfig, bucket string, prefix string, plan uploadPlan) (string, error) {
	if len(plan.Files) == 0 {
		return "", errors.New("upload plan has no files")
	}

	if !plan.IsDir {
		file := plan.Files[0]
		key := prefix + file.RelativeKey
		update := TransferUpdate{
			ID:          s.newTransferID(),
			Type:        TransferTypeUpload,
			Status:      TransferStatusQueued,
			Name:        file.DisplayName,
			Bucket:      bucket,
			Key:         key,
			LocalPath:   file.LocalPath,
			TotalBytes:  file.Size,
			UpdatedAtMs: time.Now().UnixMilli(),
		}
		s.enqueueTransfer(config, update, nil)
		return update.ID, nil
	}

	group := TransferUpdate{
		ID:          s.newTransferID(),
		Type:        TransferTypeUpload,
		Status:      TransferStatusQueued,
		Name:        plan.RootName,
		Bucket:      bucket,
		Key:         prefix + path.Join(plan.RootName) + "/",
		LocalPath:   plan.LocalPath,
		TotalBytes:  plan.TotalSize,
		FileCount:   len(plan.Files),
		UpdatedAtMs: time.Now().UnixMilli(),
		IsGroup:     true,
	}

	children := make([]TransferUpdate, 0, len(plan.Files))
	for _, file := range plan.Files {
		children = append(children, TransferUpdate{
			ID:          s.newTransferID(),
			Type:        TransferTypeUpload,
			Status:      TransferStatusQueued,
			Name:        file.DisplayName,
			Bucket:      bucket,
			Key:         prefix + file.RelativeKey,
			LocalPath:   file.LocalPath,
			TotalBytes:  file.Size,
			UpdatedAtMs: time.Now().UnixMilli(),
		})
	}

	if err := s.enqueueTransferGroup(config, group, children); err != nil {
		return "", err
	}
	return group.ID, nil
}

func (s *OSSService) EnqueueUploadPaths(config OSSConfig, bucket string, prefix string, localPaths []string) ([]string, error) {
	bucket = normalizeTransferBucket(bucket)
	if bucket == "" {
		return nil, errors.New("bucket is empty")
	}

	prefix = normalizeTransferPrefix(prefix)

	plans := make([]uploadPlan, 0, len(localPaths))
	for _, localPath := range localPaths {
		localPath = strings.TrimSpace(localPath)
		if localPath == "" {
			continue
		}
		plan, err := buildUploadPlan(localPath)
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	if len(plans) == 0 {
		return nil, errors.New("no local paths to upload")
	}

	ids := make([]string, 0, len(plans))
	for _, plan := range plans {
		id, err := s.enqueueUploadPlan(config, bucket, prefix, plan)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func (s *OSSService) EnqueueUpload(config OSSConfig, bucket string, prefix string, localPath string) (string, error) {
	ids, err := s.EnqueueUploadPaths(config, bucket, prefix, []string{localPath})
	if err != nil {
		return "", err
	}
	if len(ids) == 0 {
		return "", errors.New("no transfer enqueued")
	}
	return ids[0], nil
}

func (s *OSSService) EnqueueDownload(config OSSConfig, bucket string, object string, localPath string, totalBytes int64) (string, error) {
	localPath = strings.TrimSpace(localPath)
	object = normalizeTransferObjectKey(object)
	bucket = normalizeTransferBucket(bucket)
	if localPath == "" {
		return "", errors.New("local path is empty")
	}
	if bucket == "" {
		return "", errors.New("bucket is empty")
	}
	if object == "" {
		return "", errors.New("object key is empty")
	}
	if strings.HasSuffix(object, "/") {
		return "", errors.New("object key points to a folder, use EnqueueDownloadFolder")
	}

	name := path.Base(object)
	if name == "." || name == "/" || name == "" {
		name = object
	}

	update := TransferUpdate{
		ID:          s.newTransferID(),
		Type:        TransferTypeDownload,
		Status:      TransferStatusQueued,
		Name:        name,
		Bucket:      bucket,
		Key:         object,
		LocalPath:   localPath,
		TotalBytes:  totalBytes,
		UpdatedAtMs: time.Now().UnixMilli(),
	}
	s.enqueueTransfer(config, update, nil)
	return update.ID, nil
}

func (s *OSSService) EnqueueDownloadFolder(config OSSConfig, bucket string, folderKey string, localDir string) (string, error) {
	bucket = normalizeTransferBucket(bucket)
	folderKey = normalizeTransferFolderKey(folderKey)
	localDir = strings.TrimSpace(localDir)

	if bucket == "" {
		return "", errors.New("bucket is empty")
	}
	if folderKey == "" {
		return "", errors.New("folder key is empty")
	}
	if localDir == "" {
		return "", errors.New("local directory is empty")
	}

	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return "", fmt.Errorf("create local directory failed: %w", err)
	}

	folderName := path.Base(strings.TrimSuffix(folderKey, "/"))
	if folderName == "" || folderName == "." || folderName == "/" {
		return "", errors.New("invalid folder key")
	}
	localRoot := filepath.Join(localDir, folderName)

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return "", err
	}
	bkt, err := client.Bucket(bucket)
	if err != nil {
		return "", fmt.Errorf("failed to open bucket: %w", err)
	}

	children := make([]TransferUpdate, 0, 32)
	totalBytes := int64(0)
	marker := ""
	for {
		lor, listErr := bkt.ListObjects(
			oss.Prefix(folderKey),
			oss.Marker(marker),
			oss.MaxKeys(1000),
		)
		if listErr != nil {
			return "", fmt.Errorf("failed to list folder objects: %w", listErr)
		}

		for _, object := range lor.Objects {
			key := normalizeTransferObjectKey(object.Key)
			if key == "" || !strings.HasPrefix(key, folderKey) || strings.HasSuffix(key, "/") {
				continue
			}

			relative := strings.TrimPrefix(key, folderKey)
			relative = strings.TrimLeft(relative, "/")
			if relative == "" {
				continue
			}

			relativeLocal, relErr := safeRelativeDownloadPath(relative)
			if relErr != nil {
				return "", relErr
			}

			localPath := filepath.Join(localRoot, relativeLocal)
			if mkdirErr := os.MkdirAll(filepath.Dir(localPath), 0o755); mkdirErr != nil {
				return "", fmt.Errorf("prepare local folder failed: %w", mkdirErr)
			}

			displayName := path.Join(folderName, strings.ReplaceAll(relativeLocal, string(filepath.Separator), "/"))
			children = append(children, TransferUpdate{
				ID:          s.newTransferID(),
				Type:        TransferTypeDownload,
				Status:      TransferStatusQueued,
				Name:        displayName,
				Bucket:      bucket,
				Key:         key,
				LocalPath:   localPath,
				TotalBytes:  object.Size,
				UpdatedAtMs: time.Now().UnixMilli(),
			})
			if object.Size > 0 {
				totalBytes += object.Size
			}
		}

		if !lor.IsTruncated || lor.NextMarker == "" {
			break
		}
		marker = lor.NextMarker
	}

	if len(children) == 0 {
		return "", errors.New("folder has no files to download")
	}

	group := TransferUpdate{
		ID:          s.newTransferID(),
		Type:        TransferTypeDownload,
		Status:      TransferStatusQueued,
		Name:        folderName,
		Bucket:      bucket,
		Key:         folderKey,
		LocalPath:   localRoot,
		TotalBytes:  totalBytes,
		FileCount:   len(children),
		UpdatedAtMs: time.Now().UnixMilli(),
		IsGroup:     true,
	}

	if err := s.enqueueTransferGroup(config, group, children); err != nil {
		return "", err
	}
	return group.ID, nil
}

var (
	reOKSize      = regexp.MustCompile(`(?i)\bOK\s*size:\s*([0-9][0-9,]*)(?:\b|$)`)
	reProgress    = regexp.MustCompile(`(?i)\bProgress:\s*([0-9]+(?:\.[0-9]+)?)\s*%`)
	reProgressAny = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*%`)
	reSpeedUnit   = regexp.MustCompile(`(?i)\bSpeed:\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?)(?:i)?b/s`)
	reSpeedLoose  = regexp.MustCompile(`(?i)\bspeed(?:\s+is)?\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\(\s*)?([kmgtp]?)(?:i)?(?:b|byte)/s`)
	reANSIEsc     = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
)

func stripANSI(s string) string {
	return reANSIEsc.ReplaceAllString(s, "")
}

func parseCommaInt64(s string) (int64, bool) {
	s = strings.ReplaceAll(s, ",", "")
	v, err := strconv.ParseInt(s, 10, 64)
	return v, err == nil
}

func speedToBps(value float64, unitPrefix string) float64 {
	switch strings.ToUpper(unitPrefix) {
	case "K":
		return value * 1024
	case "M":
		return value * 1024 * 1024
	case "G":
		return value * 1024 * 1024 * 1024
	case "T":
		return value * 1024 * 1024 * 1024 * 1024
	case "P":
		return value * 1024 * 1024 * 1024 * 1024 * 1024
	default:
		return value
	}
}

type parsedProgress struct {
	doneBytes  int64
	speedBps   float64
	percent    float64
	hasDone    bool
	hasSpeed   bool
	hasPercent bool
}

func parseProgressSegment(seg string) parsedProgress {
	clean := strings.TrimSpace(stripANSI(seg))
	clean = strings.TrimPrefix(clean, "\r")
	out := parsedProgress{}

	if m := reOKSize.FindStringSubmatch(clean); len(m) == 2 {
		if v, ok := parseCommaInt64(m[1]); ok {
			out.doneBytes = v
			out.hasDone = true
		}
	}

	if m := reProgress.FindStringSubmatch(clean); len(m) == 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			out.percent = v
			out.hasPercent = true
		}
	}
	if !out.hasPercent {
		if m := reProgressAny.FindStringSubmatch(clean); len(m) == 2 {
			if v, err := strconv.ParseFloat(m[1], 64); err == nil && v >= 0 {
				if v > 100 {
					v = 100
				}
				out.percent = v
				out.hasPercent = true
			}
		}
	}

	if m := reSpeedUnit.FindStringSubmatch(clean); len(m) == 3 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			out.speedBps = speedToBps(v, m[2])
			out.hasSpeed = true
		}
	}
	if !out.hasSpeed {
		if m := reSpeedLoose.FindStringSubmatch(clean); len(m) == 3 {
			if v, err := strconv.ParseFloat(m[1], 64); err == nil {
				out.speedBps = speedToBps(v, m[2])
				out.hasSpeed = true
			}
		}
	}

	return out
}

func splitOnCRLF(r io.Reader, emit func(string)) error {
	buf := make([]byte, 4096)
	var pending []byte
	for {
		n, err := r.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
			for {
				idx := bytes.IndexAny(pending, "\r\n")
				if idx == -1 {
					break
				}
				seg := string(pending[:idx])
				pending = pending[idx+1:]
				seg = strings.TrimSpace(seg)
				if seg != "" {
					emit(seg)
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if len(pending) > 0 {
					seg := strings.TrimSpace(string(pending))
					if seg != "" {
						emit(seg)
					}
				}
				return nil
			}
			return err
		}
	}
}

type ringBuffer struct {
	mu   sync.Mutex
	data []byte
	cap  int
}

func newRingBuffer(capacity int) *ringBuffer {
	if capacity < 1 {
		capacity = 1
	}
	return &ringBuffer{cap: capacity}
}

func (b *ringBuffer) AppendLine(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if line == "" {
		return
	}
	if !strings.HasSuffix(line, "\n") {
		line += "\n"
	}
	raw := []byte(line)
	if len(raw) >= b.cap {
		b.data = append([]byte{}, raw[len(raw)-b.cap:]...)
		return
	}
	if len(b.data)+len(raw) > b.cap {
		trim := len(b.data) + len(raw) - b.cap
		b.data = append([]byte{}, b.data[trim:]...)
	}
	b.data = append(b.data, raw...)
}

func (b *ringBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(string(b.data))
}

func (s *OSSService) runTransfer(config OSSConfig, update TransferUpdate, onUpdate func(TransferUpdate)) {
	s.transferLimiterMu.RLock()
	limiter := s.transferLimiter
	s.transferLimiterMu.RUnlock()
	if limiter == nil {
		limiter = newTransferLimiter(1)
		s.transferLimiterMu.Lock()
		if s.transferLimiter == nil {
			s.transferLimiter = limiter
		} else {
			limiter = s.transferLimiter
		}
		s.transferLimiterMu.Unlock()
	}

	limiter.Acquire()
	defer limiter.Release()

	update.Status = TransferStatusInProgress
	update.StartedAtMs = time.Now().UnixMilli()
	update.UpdatedAtMs = update.StartedAtMs
	s.emitTransfer(update, onUpdate)

	var args []string
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	switch update.Type {
	case TransferTypeDownload:
		if dir := filepath.Dir(update.LocalPath); dir != "" && dir != "." {
			if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
				update.Status = TransferStatusError
				update.Message = fmt.Sprintf("create local directory failed: %v", mkErr)
				update.FinishedAtMs = time.Now().UnixMilli()
				update.UpdatedAtMs = update.FinishedAtMs
				s.emitTransfer(update, onUpdate)
				return
			}
		}
		cloudURL := fmt.Sprintf("oss://%s/%s", update.Bucket, update.Key)
		args = []string{
			"cp",
			cloudURL,
			update.LocalPath,
			"--access-key-id", config.AccessKeyID,
			"--access-key-secret", config.AccessKeySecret,
			"--region", region,
			"-f",
		}
	case TransferTypeUpload:
		cloudURL := fmt.Sprintf("oss://%s/%s", update.Bucket, update.Key)
		args = []string{
			"cp",
			update.LocalPath,
			cloudURL,
			"--access-key-id", config.AccessKeyID,
			"--access-key-secret", config.AccessKeySecret,
			"--region", region,
			"-f",
		}
	default:
		update.Status = TransferStatusError
		update.Message = "unknown transfer type"
		update.FinishedAtMs = time.Now().UnixMilli()
		update.UpdatedAtMs = update.FinishedAtMs
		s.emitTransfer(update, onUpdate)
		return
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	err := s.runOssutilWithProgress(args, &update, onUpdate)
	update.FinishedAtMs = time.Now().UnixMilli()
	update.UpdatedAtMs = update.FinishedAtMs

	if err != nil {
		update.Status = TransferStatusError
		update.Message = err.Error()
		s.emitTransfer(update, onUpdate)
		return
	}

	update.Status = TransferStatusSuccess
	if update.TotalBytes > 0 {
		update.DoneBytes = update.TotalBytes
	}
	s.emitTransfer(update, onUpdate)
}

func (s *OSSService) runOssutilWithProgress(args []string, update *TransferUpdate, onUpdate func(TransferUpdate)) error {
	if update == nil {
		return errors.New("internal error: missing transfer update")
	}

	startCmd := func(binary string) (*exec.Cmd, io.ReadCloser, io.ReadCloser, error) {
		cmd := exec.Command(binary, args...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, nil, nil, err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return nil, nil, nil, err
		}
		return cmd, stdout, stderr, cmd.Start()
	}

	primary := strings.TrimSpace(s.ossutilPath)
	fallback := strings.TrimSpace(s.defaultOssutilPath)
	if primary == "" {
		primary = fallback
	}
	if primary == "" {
		primary = "ossutil"
	}

	cmd, stdout, stderr, err := startCmd(primary)
	if err != nil && ossutilStartFailed(err) && fallback != "" && fallback != primary {
		cmd, stdout, stderr, err = startCmd(fallback)
		if err == nil {
			s.ossutilPath = fallback
		}
	}
	if err != nil {
		return fmt.Errorf("failed to start ossutil: %w", err)
	}

	outputTail := newRingBuffer(16 * 1024)
	emitInterval := 250 * time.Millisecond
	staleSpeedAfter := 2 * time.Second
	var lastEmit time.Time

	var mu sync.Mutex
	doneBytes := update.DoneBytes
	cliSpeedBps := update.SpeedBytesPerSec
	derivedSpeedBps := 0.0
	lastDoneSampleBytes := doneBytes
	var lastDoneSampleAt time.Time
	var lastProgressAt time.Time

	emit := func(force bool) {
		now := time.Now()
		if !force && !lastEmit.IsZero() && now.Sub(lastEmit) < emitInterval {
			return
		}
		lastEmit = now

		mu.Lock()
		update.DoneBytes = doneBytes
		effectiveSpeedBps := derivedSpeedBps
		if effectiveSpeedBps <= 0 && cliSpeedBps > 0 {
			effectiveSpeedBps = cliSpeedBps
		}
		if !lastProgressAt.IsZero() && now.Sub(lastProgressAt) > staleSpeedAfter {
			effectiveSpeedBps = 0
		}
		update.SpeedBytesPerSec = effectiveSpeedBps
		if update.TotalBytes > 0 && effectiveSpeedBps > 0 && doneBytes >= 0 && doneBytes <= update.TotalBytes {
			update.EtaSeconds = int64(float64(update.TotalBytes-doneBytes) / effectiveSpeedBps)
		} else {
			update.EtaSeconds = 0
		}
		update.UpdatedAtMs = now.UnixMilli()
		copied := *update
		mu.Unlock()

		s.emitTransfer(copied, onUpdate)
	}

	segments := make(chan string, 128)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_ = splitOnCRLF(stdout, func(seg string) { segments <- seg })
	}()
	go func() {
		defer wg.Done()
		_ = splitOnCRLF(stderr, func(seg string) { segments <- seg })
	}()
	go func() {
		wg.Wait()
		close(segments)
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	ticker := time.NewTicker(emitInterval)
	defer ticker.Stop()

	segmentsOpen := true
	waitDone := false
	for segmentsOpen || !waitDone {
		select {
		case seg, ok := <-segments:
			if !ok {
				segmentsOpen = false
				continue
			}

			seg = stripANSI(seg)
			p := parseProgressSegment(seg)
			if p.hasDone || p.hasSpeed || p.hasPercent {
				now := time.Now()

				mu.Lock()
				if p.hasDone {
					doneBytes = p.doneBytes
				} else if p.hasPercent && update.TotalBytes > 0 {
					doneBytes = int64(float64(update.TotalBytes) * (p.percent / 100.0))
				}

				if p.hasDone || p.hasPercent {
					if !lastDoneSampleAt.IsZero() {
						delta := doneBytes - lastDoneSampleBytes
						elapsed := now.Sub(lastDoneSampleAt)
						if delta > 0 && elapsed > 0 {
							instant := float64(delta) / elapsed.Seconds()
							if derivedSpeedBps <= 0 {
								derivedSpeedBps = instant
							} else {
								const alpha = 0.35
								derivedSpeedBps = (1-alpha)*derivedSpeedBps + alpha*instant
							}
						} else if delta < 0 {
							derivedSpeedBps = 0
						}
					}
					lastDoneSampleAt = now
					lastDoneSampleBytes = doneBytes
					lastProgressAt = now
				}

				if p.hasSpeed {
					cliSpeedBps = p.speedBps
					if derivedSpeedBps <= 0 && p.speedBps > 0 {
						derivedSpeedBps = p.speedBps
					}
					lastProgressAt = now
				}
				mu.Unlock()

				emit(false)
				continue
			}

			// Non-progress output for debugging/errors.
			outputTail.AppendLine(strings.TrimSpace(seg))
		case <-ticker.C:
			// Heartbeat: keep transfer card updates alive even when ossutil output is sparse.
			emit(false)
		case err = <-waitCh:
			waitDone = true
			waitCh = nil
		}
	}

	if err != nil {
		tail := outputTail.String()
		if tail != "" {
			return fmt.Errorf("%w: %s", err, tail)
		}
		return err
	}

	emit(true)
	return nil
}
