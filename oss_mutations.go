package main

import (
	"bytes"
	"fmt"
	"strings"

	oss "github.com/aliyun/aliyun-oss-go-sdk/oss"
)

func normalizeObjectKey(key string) string {
	key = strings.TrimSpace(key)
	key = strings.TrimLeft(key, "/")
	return key
}

// CreateFolder creates a folder placeholder object (key ending with "/") so it appears in listings.
func (s *OSSService) CreateFolder(config OSSConfig, bucketName string, prefix string, folderName string) error {
	bucketName = strings.TrimSpace(bucketName)
	if bucketName == "" {
		return fmt.Errorf("bucket name is required")
	}

	folderName = strings.TrimSpace(folderName)
	folderName = strings.Trim(folderName, "/")
	if folderName == "" {
		return fmt.Errorf("folder name is required")
	}

	prefix = normalizeObjectPrefix(prefix)
	key := normalizeObjectKey(prefix + folderName + "/")

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return err
	}

	bucket, err := client.Bucket(bucketName)
	if err != nil {
		return fmt.Errorf("failed to open bucket: %w", err)
	}

	if err := bucket.PutObject(key, bytes.NewReader(nil)); err != nil {
		return fmt.Errorf("failed to create folder: %w", err)
	}

	return nil
}

// CreateFile creates an empty object (key not ending with "/") under the given prefix.
func (s *OSSService) CreateFile(config OSSConfig, bucketName string, prefix string, fileName string) error {
	bucketName = strings.TrimSpace(bucketName)
	if bucketName == "" {
		return fmt.Errorf("bucket name is required")
	}

	fileName = strings.TrimSpace(fileName)
	fileName = strings.Trim(fileName, "/")
	if fileName == "" {
		return fmt.Errorf("file name is required")
	}

	prefix = normalizeObjectPrefix(prefix)
	key := normalizeObjectKey(prefix + fileName)
	if key == "" {
		return fmt.Errorf("file key is empty")
	}
	if strings.HasSuffix(key, "/") {
		return fmt.Errorf("file name cannot end with '/'")
	}

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return err
	}

	bucket, err := client.Bucket(bucketName)
	if err != nil {
		return fmt.Errorf("failed to open bucket: %w", err)
	}

	exists, err := bucket.IsObjectExist(key)
	if err != nil {
		return fmt.Errorf("failed to check file exists: %w", err)
	}
	if exists {
		return fmt.Errorf("file already exists")
	}

	if err := bucket.PutObject(key, bytes.NewReader(nil)); err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}

	return nil
}

func (s *OSSService) MoveObject(config OSSConfig, srcBucketName string, srcKey string, destBucketName string, destKey string) error {
	srcBucketName = strings.TrimSpace(srcBucketName)
	destBucketName = strings.TrimSpace(destBucketName)
	if srcBucketName == "" || destBucketName == "" {
		return fmt.Errorf("source and destination bucket are required")
	}

	srcKey = normalizeObjectKey(srcKey)
	destKey = normalizeObjectKey(destKey)
	if srcKey == "" || destKey == "" {
		return fmt.Errorf("source and destination key are required")
	}

	if srcBucketName == destBucketName && srcKey == destKey {
		return nil
	}

	isFolder := strings.HasSuffix(srcKey, "/")
	if isFolder && !strings.HasSuffix(destKey, "/") {
		destKey += "/"
	}

	// Prevent moving a folder into itself (same bucket).
	if isFolder && srcBucketName == destBucketName && strings.HasPrefix(destKey, srcKey) {
		return fmt.Errorf("destination is inside the source folder")
	}

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return err
	}

	srcBucket, err := client.Bucket(srcBucketName)
	if err != nil {
		return fmt.Errorf("failed to open source bucket: %w", err)
	}

	destBucket, err := client.Bucket(destBucketName)
	if err != nil {
		return fmt.Errorf("failed to open destination bucket: %w", err)
	}

	if !isFolder {
		if srcBucketName == destBucketName {
			if _, err := destBucket.CopyObject(srcKey, destKey); err != nil {
				return fmt.Errorf("copy failed: %w", err)
			}
		} else {
			if _, err := destBucket.CopyObjectFrom(srcBucketName, srcKey, destKey); err != nil {
				return fmt.Errorf("copy failed: %w", err)
			}
		}

		if err := srcBucket.DeleteObject(srcKey); err != nil {
			return fmt.Errorf("delete source failed: %w", err)
		}
		return nil
	}

	// Folder move: list recursively and move each object.
	marker := ""
	for {
		lor, err := srcBucket.ListObjects(
			oss.Prefix(srcKey),
			oss.Marker(marker),
			oss.MaxKeys(1000),
		)
		if err != nil {
			return fmt.Errorf("failed to list folder objects: %w", err)
		}

		for _, object := range lor.Objects {
			key := normalizeObjectKey(object.Key)
			if !strings.HasPrefix(key, srcKey) {
				continue
			}
			rel := strings.TrimPrefix(key, srcKey)
			targetKey := destKey + rel

			if srcBucketName == destBucketName {
				if key == targetKey {
					continue
				}
				if _, err := destBucket.CopyObject(key, targetKey); err != nil {
					return fmt.Errorf("copy failed: %w", err)
				}
			} else {
				if _, err := destBucket.CopyObjectFrom(srcBucketName, key, targetKey); err != nil {
					return fmt.Errorf("copy failed: %w", err)
				}
			}

			if err := srcBucket.DeleteObject(key); err != nil {
				return fmt.Errorf("delete source failed: %w", err)
			}
		}

		if !lor.IsTruncated {
			break
		}
		marker = lor.NextMarker
	}

	return nil
}
