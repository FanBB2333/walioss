package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

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

type TransferUpdate struct {
	ID              string         `json:"id"`
	Type            TransferType   `json:"type"`
	Status          TransferStatus `json:"status"`
	Name            string         `json:"name"`
	Bucket          string         `json:"bucket"`
	Key             string         `json:"key"`
	LocalPath       string         `json:"localPath,omitempty"`
	TotalBytes      int64          `json:"totalBytes,omitempty"`
	DoneBytes       int64          `json:"doneBytes,omitempty"`
	SpeedBytesPerSec float64       `json:"speedBytesPerSec,omitempty"`
	EtaSeconds      int64          `json:"etaSeconds,omitempty"`
	Message         string         `json:"message,omitempty"`
	StartedAtMs     int64          `json:"startedAtMs,omitempty"`
	UpdatedAtMs     int64          `json:"updatedAtMs,omitempty"`
	FinishedAtMs    int64          `json:"finishedAtMs,omitempty"`
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

func (s *OSSService) EnqueueUpload(config OSSConfig, bucket string, prefix string, localPath string) (string, error) {
	localPath = strings.TrimSpace(localPath)
	if localPath == "" {
		return "", errors.New("local path is empty")
	}
	if strings.TrimSpace(bucket) == "" {
		return "", errors.New("bucket is empty")
	}

	stat, err := os.Stat(localPath)
	if err != nil {
		return "", fmt.Errorf("stat local file failed: %w", err)
	}
	if stat.IsDir() {
		return "", errors.New("upload currently supports files only")
	}

	fileName := filepath.Base(localPath)
	key := strings.TrimPrefix(prefix, "/")
	if key != "" && !strings.HasSuffix(key, "/") {
		key += "/"
	}
	key += fileName

	id := fmt.Sprintf("tr-%d-%d", time.Now().UnixMilli(), atomic.AddUint64(&s.transferSeq, 1))
	update := TransferUpdate{
		ID:         id,
		Type:       TransferTypeUpload,
		Status:     TransferStatusQueued,
		Name:       fileName,
		Bucket:     bucket,
		Key:        key,
		LocalPath:  localPath,
		TotalBytes: stat.Size(),
		UpdatedAtMs: time.Now().UnixMilli(),
	}
	s.emitTransferUpdate(update)

	go s.runTransfer(config, update)
	return id, nil
}

func (s *OSSService) EnqueueDownload(config OSSConfig, bucket string, object string, localPath string, totalBytes int64) (string, error) {
	localPath = strings.TrimSpace(localPath)
	object = strings.TrimPrefix(strings.TrimSpace(object), "/")
	if localPath == "" {
		return "", errors.New("local path is empty")
	}
	if strings.TrimSpace(bucket) == "" {
		return "", errors.New("bucket is empty")
	}
	if object == "" {
		return "", errors.New("object key is empty")
	}

	name := path.Base(object)
	if name == "." || name == "/" || name == "" {
		name = object
	}

	id := fmt.Sprintf("tr-%d-%d", time.Now().UnixMilli(), atomic.AddUint64(&s.transferSeq, 1))
	update := TransferUpdate{
		ID:         id,
		Type:       TransferTypeDownload,
		Status:     TransferStatusQueued,
		Name:       name,
		Bucket:     bucket,
		Key:        object,
		LocalPath:  localPath,
		TotalBytes: totalBytes,
		UpdatedAtMs: time.Now().UnixMilli(),
	}
	s.emitTransferUpdate(update)

	go s.runTransfer(config, update)
	return id, nil
}

var (
	reOKSize    = regexp.MustCompile(`(?i)\bOK\s*size:\s*([0-9][0-9,]*)(?:\b|$)`)
	reProgress  = regexp.MustCompile(`(?i)\bProgress:\s*([0-9]+(?:\.[0-9]+)?)\s*%`)
	reSpeedUnit = regexp.MustCompile(`(?i)\bSpeed:\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?)(?:i)?b/s`)
	reANSIEsc   = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
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

	if m := reSpeedUnit.FindStringSubmatch(clean); len(m) == 3 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			out.speedBps = speedToBps(v, m[2])
			out.hasSpeed = true
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

func (s *OSSService) runTransfer(config OSSConfig, update TransferUpdate) {
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
	s.emitTransferUpdate(update)

	var args []string
	region := normalizeRegion(config.Region)
	endpoint := normalizeEndpoint(config.Endpoint)

	switch update.Type {
	case TransferTypeDownload:
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
		s.emitTransferUpdate(update)
		return
	}

	if endpoint != "" {
		args = append(args, "--endpoint", endpoint)
	}

	err := s.runOssutilWithProgress(args, &update)
	update.FinishedAtMs = time.Now().UnixMilli()
	update.UpdatedAtMs = update.FinishedAtMs

	if err != nil {
		update.Status = TransferStatusError
		update.Message = err.Error()
		s.emitTransferUpdate(update)
		return
	}

	update.Status = TransferStatusSuccess
	if update.TotalBytes > 0 {
		update.DoneBytes = update.TotalBytes
	}
	s.emitTransferUpdate(update)
}

func (s *OSSService) runOssutilWithProgress(args []string, update *TransferUpdate) error {
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
	var lastEmit time.Time

	var mu sync.Mutex
	doneBytes := update.DoneBytes
	speedBps := update.SpeedBytesPerSec

	emit := func(force bool) {
		now := time.Now()
		if !force && !lastEmit.IsZero() && now.Sub(lastEmit) < emitInterval {
			return
		}
		lastEmit = now

		mu.Lock()
		update.DoneBytes = doneBytes
		update.SpeedBytesPerSec = speedBps
		if update.TotalBytes > 0 && speedBps > 0 && doneBytes >= 0 && doneBytes <= update.TotalBytes {
			update.EtaSeconds = int64(float64(update.TotalBytes-doneBytes) / speedBps)
		} else {
			update.EtaSeconds = 0
		}
		update.UpdatedAtMs = now.UnixMilli()
		copied := *update
		mu.Unlock()

		s.emitTransferUpdate(copied)
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

	for seg := range segments {
		seg = stripANSI(seg)
		p := parseProgressSegment(seg)

		mu.Lock()
		if p.hasDone {
			doneBytes = p.doneBytes
		} else if p.hasPercent && update.TotalBytes > 0 {
			doneBytes = int64(float64(update.TotalBytes) * (p.percent / 100.0))
		}
		if p.hasSpeed {
			speedBps = p.speedBps
		}
		mu.Unlock()

		if p.hasDone || p.hasSpeed || p.hasPercent {
			emit(false)
			continue
		}

		// Non-progress output for debugging/errors.
		outputTail.AppendLine(strings.TrimSpace(seg))
	}

	err = <-waitCh
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

