package main

import (
	"errors"
	"fmt"
	"strings"

	oss "github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type UploadNameCollision struct {
	Name         string `json:"name"`
	FileExists   bool   `json:"fileExists"`
	FolderExists bool   `json:"folderExists"`
}

func (s *OSSService) CheckUploadNameCollisions(config OSSConfig, bucket string, prefix string, names []string) ([]UploadNameCollision, error) {
	bucket = normalizeTransferBucket(bucket)
	if bucket == "" {
		return nil, errors.New("bucket is empty")
	}

	prefix = normalizeTransferPrefix(prefix)

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return nil, err
	}
	bkt, err := client.Bucket(bucket)
	if err != nil {
		return nil, fmt.Errorf("failed to open bucket: %w", err)
	}

	seen := map[string]struct{}{}
	out := make([]UploadNameCollision, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		name = strings.Trim(name, "/")
		name = strings.Trim(name, "\\")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.Contains(name, "/") || strings.Contains(name, "\\") {
			return nil, fmt.Errorf("invalid name: %s", name)
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}

		fileKey := prefix + name
		fileExists, err := bkt.IsObjectExist(fileKey)
		if err != nil {
			return nil, fmt.Errorf("check object existence failed: %w", err)
		}

		folderPrefix := prefix + name + "/"
		lor, err := bkt.ListObjects(oss.Prefix(folderPrefix), oss.MaxKeys(1))
		if err != nil {
			return nil, fmt.Errorf("check folder existence failed: %w", err)
		}
		folderExists := len(lor.Objects) > 0

		out = append(out, UploadNameCollision{
			Name:         name,
			FileExists:   fileExists,
			FolderExists: folderExists,
		})
	}

	return out, nil
}
