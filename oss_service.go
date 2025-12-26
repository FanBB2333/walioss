package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// OSSService handles OSS operations via ossutil
type OSSService struct {
	ossutilPath string
	configDir   string
}

// NewOSSService creates a new OSSService instance
func NewOSSService() *OSSService {
	homeDir, _ := os.UserHomeDir()
	return &OSSService{
		ossutilPath: "ossutil", // Default to PATH lookup
		configDir:   filepath.Join(homeDir, ".walioss"),
	}
}

// SetOssutilPath sets custom ossutil binary path
func (s *OSSService) SetOssutilPath(path string) {
	s.ossutilPath = path
}

// GetOssutilPath returns current ossutil path
func (s *OSSService) GetOssutilPath() string {
	return s.ossutilPath
}

// TestConnection tests the OSS connection with given config
func (s *OSSService) TestConnection(config OSSConfig) ConnectionResult {
	// Build ossutil command with credentials
	args := []string{
		"ls",
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()

	if err != nil {
		return ConnectionResult{
			Success: false,
			Message: fmt.Sprintf("Connection failed: %s\n%s", err.Error(), string(output)),
		}
	}

	return ConnectionResult{
		Success: true,
		Message: "Connection successful",
	}
}

// SaveProfile saves an OSS profile to config directory
func (s *OSSService) SaveProfile(profile OSSProfile) error {
	// Ensure config directory exists
	if err := os.MkdirAll(s.configDir, 0700); err != nil {
		return err
	}

	profiles, _ := s.LoadProfiles()

	// Update or add profile
	found := false
	for i, p := range profiles {
		if p.Name == profile.Name {
			profiles[i] = profile
			found = true
			break
		}
	}
	if !found {
		profiles = append(profiles, profile)
	}

	// If this profile is default, unset others
	if profile.IsDefault {
		for i := range profiles {
			if profiles[i].Name != profile.Name {
				profiles[i].IsDefault = false
			}
		}
	}

	return s.saveProfiles(profiles)
}

// LoadProfiles loads all saved profiles
func (s *OSSService) LoadProfiles() ([]OSSProfile, error) {
	configPath := filepath.Join(s.configDir, "profiles.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []OSSProfile{}, nil
		}
		return nil, err
	}

	var profiles []OSSProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, err
	}

	return profiles, nil
}

// GetProfile loads a specific profile by name
func (s *OSSService) GetProfile(name string) (*OSSProfile, error) {
	profiles, err := s.LoadProfiles()
	if err != nil {
		return nil, err
	}

	for _, p := range profiles {
		if p.Name == name {
			return &p, nil
		}
	}

	return nil, fmt.Errorf("profile not found: %s", name)
}

// DeleteProfile deletes a profile by name
func (s *OSSService) DeleteProfile(name string) error {
	profiles, err := s.LoadProfiles()
	if err != nil {
		return err
	}

	newProfiles := make([]OSSProfile, 0)
	for _, p := range profiles {
		if p.Name != name {
			newProfiles = append(newProfiles, p)
		}
	}

	return s.saveProfiles(newProfiles)
}

// GetDefaultProfile returns the default profile if set
func (s *OSSService) GetDefaultProfile() (*OSSProfile, error) {
	profiles, err := s.LoadProfiles()
	if err != nil {
		return nil, err
	}

	for _, p := range profiles {
		if p.IsDefault {
			return &p, nil
		}
	}

	return nil, nil
}

// ListBuckets lists all buckets for the given config
func (s *OSSService) ListBuckets(config OSSConfig) ([]BucketInfo, error) {
	args := []string{
		"ls",
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to list buckets: %s", string(output))
	}

	return s.parseBucketList(string(output)), nil
}

// parseBucketList parses ossutil ls output to bucket list
func (s *OSSService) parseBucketList(output string) []BucketInfo {
	var buckets []BucketInfo
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "oss://") {
			// Parse bucket line: oss://bucket-name
			parts := strings.Fields(line)
			if len(parts) >= 1 {
				name := strings.TrimPrefix(parts[0], "oss://")
				bucket := BucketInfo{
					Name: name,
				}
				buckets = append(buckets, bucket)
			}
		}
	}

	return buckets
}

// ListObjects lists objects in a bucket with optional prefix
func (s *OSSService) ListObjects(config OSSConfig, bucketName string, prefix string) ([]ObjectInfo, error) {
	bucketUrl := fmt.Sprintf("oss://%s/%s", bucketName, prefix)

	args := []string{
		"ls",
		bucketUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	// Use directory mode to simulate folder structure
	args = append(args, "-d")

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()

	if err != nil {
		return nil, fmt.Errorf("failed to list objects: %s", string(output))
	}

	return s.parseObjectList(string(output), bucketName, prefix), nil
}

// parseObjectList parses ossutil ls output
func (s *OSSService) parseObjectList(output string, bucketName string, prefix string) []ObjectInfo {
	var objects []ObjectInfo
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "Object Number") || strings.HasPrefix(line, "Total Size") {
			continue
		}

		// Handle directory lines (usually end with /)
		// Output format differs for directories and files
		if strings.HasPrefix(line, "oss://") {
			// It's a directory/common prefix usually if using -d
			path := line
			name := strings.TrimPrefix(path, fmt.Sprintf("oss://%s/", bucketName))
			name = strings.TrimSuffix(name, "/")
			// Get the last part of the path
			parts := strings.Split(name, "/")
			displayName := parts[len(parts)-1]
			if displayName == "" {
				continue // Skip the prefix itself if it matches
			}

			objects = append(objects, ObjectInfo{
				Name: displayName,
				Path: path,
				Type: "Folder",
			})
			continue
		}

		// Handle file lines
		// Format: LastModifiedTime Size(B) StorageClass ETAG ObjectName
		fields := strings.Fields(line)
		if len(fields) >= 5 {
			// Check if it looks like a file line
			// fields[0] + fields[1] might be date time
			// Let's rely on the fact that ObjectName starts with oss:// which is the last field
			objectPath := fields[len(fields)-1]
			if strings.HasPrefix(objectPath, "oss://") {
				// Parse standard output
				// 2023-01-01 12:00:00 1234 Standard ETAG oss://...

				// Extract size (index 2 usually, connecting date/time)
				// Date: 0, Time: 1, Size: 2, StorageClass: 3, Etag: 4, Name: 5
				// Wait, fields might vary. Let's look for the oss:// part.

				sizeStr := fields[2]
				var size int64
				fmt.Sscanf(sizeStr, "%d", &size)

				lastModified := fields[0] + " " + fields[1]
				storageClass := fields[3]

				name := strings.TrimPrefix(objectPath, fmt.Sprintf("oss://%s/", bucketName))

				// If prefix is "dir/", name might be "dir/file.txt".
				// We want just "file.txt" if we are simulating folders.
				// But ossutil ls -d only shows immediate children?
				// ossutil ls -d oss://bucket/dir/ show objects under dir/ and subdirs as prefixes.
				// Objects will return full key.

				displayName := strings.TrimPrefix(name, prefix)
				if displayName == "" {
					continue // Skip the folder object itself
				}

				objects = append(objects, ObjectInfo{
					Name:         displayName,
					Path:         objectPath,
					Size:         size,
					Type:         "File",
					LastModified: lastModified,
					StorageClass: storageClass,
				})
			}
		}
	}

	return objects
}

// DownloadFile downloads a file from OSS
func (s *OSSService) DownloadFile(config OSSConfig, bucket string, object string, localPath string) error {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)

	args := []string{
		"cp",
		cloudUrl,
		localPath,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
		"-f", // Force overwrite
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()

	if err != nil {
		return fmt.Errorf("download failed: %s", string(output))
	}

	return nil
}

// UploadFile uploads a file to OSS
func (s *OSSService) UploadFile(config OSSConfig, bucket string, prefix string, localPath string) error {
	fileName := filepath.Base(localPath)
	cloudUrl := fmt.Sprintf("oss://%s/%s%s", bucket, prefix, fileName)

	args := []string{
		"cp",
		localPath,
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
		"-f", // Force overwrite
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()

	if err != nil {
		return fmt.Errorf("upload failed: %s", string(output))
	}

	return nil
}

// DeleteObject deletes an object from OSS
func (s *OSSService) DeleteObject(config OSSConfig, bucket string, object string) error {
	cloudUrl := fmt.Sprintf("oss://%s/%s", bucket, object)

	args := []string{
		"rm",
		cloudUrl,
		"--access-key-id", config.AccessKeyID,
		"--access-key-secret", config.AccessKeySecret,
		"--region", config.Region,
		"-f", // Force delete without confirmation prompt (since we handle it in UI)
	}

	// recursive delete if it looks like a directory (though in OSS directories are fake, ossutil -r helps for common prefixes)
	if strings.HasSuffix(object, "/") {
		args = append(args, "-r")
	}

	if config.Endpoint != "" {
		args = append(args, "--endpoint", config.Endpoint)
	}

	cmd := exec.Command(s.ossutilPath, args...)
	output, err := cmd.CombinedOutput()

	if err != nil {
		return fmt.Errorf("delete failed: %s", string(output))
	}

	return nil
}

// CheckOssutilInstalled checks if ossutil is installed and accessible
func (s *OSSService) CheckOssutilInstalled() ConnectionResult {
	cmd := exec.Command(s.ossutilPath, "version")
	output, err := cmd.CombinedOutput()

	if err != nil {
		return ConnectionResult{
			Success: false,
			Message: fmt.Sprintf("ossutil not found or not accessible: %s", err.Error()),
		}
	}

	return ConnectionResult{
		Success: true,
		Message: strings.TrimSpace(string(output)),
	}
}

// saveProfiles saves profiles to config file
func (s *OSSService) saveProfiles(profiles []OSSProfile) error {
	configPath := filepath.Join(s.configDir, "profiles.json")
	data, err := json.MarshalIndent(profiles, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0600)
}

// GetSettings loads application settings
func (s *OSSService) GetSettings() (AppSettings, error) {
	settingsPath := filepath.Join(s.configDir, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Return defaults
			return AppSettings{
				OssutilPath: "ossutil",
				Theme:       "dark",
			}, nil
		}
		return AppSettings{}, err
	}

	var settings AppSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return AppSettings{}, err
	}

	// Apply ossutil path if set
	if settings.OssutilPath != "" {
		s.ossutilPath = settings.OssutilPath
	}

	return settings, nil
}

// SaveSettings persists application settings
func (s *OSSService) SaveSettings(settings AppSettings) error {
	if err := os.MkdirAll(s.configDir, 0700); err != nil {
		return err
	}

	// Apply ossutil path immediately
	if settings.OssutilPath != "" {
		s.ossutilPath = settings.OssutilPath
	}

	settingsPath := filepath.Join(s.configDir, "settings.json")
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(settingsPath, data, 0600)
}
