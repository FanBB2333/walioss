package main

import (
	"fmt"
	"sort"
	"strings"
	"time"

	oss "github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type ObjectListPageResult struct {
	Items       []ObjectInfo `json:"items"`
	NextMarker  string       `json:"nextMarker"`
	IsTruncated bool         `json:"isTruncated"`
}

func sdkEndpointForConfig(config OSSConfig) (string, error) {
	endpointHost := normalizeEndpoint(config.Endpoint)
	if endpointHost == "" {
		endpointHost = suggestServiceEndpoint(normalizeRegion(config.Region))
	}
	if endpointHost == "" {
		return "", fmt.Errorf("missing endpoint: please set Endpoint or Region")
	}

	endpoint := endpointHost
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		endpoint = "https://" + endpoint
	}
	return endpoint, nil
}

func sdkClientFromConfig(config OSSConfig) (*oss.Client, error) {
	endpoint, err := sdkEndpointForConfig(config)
	if err != nil {
		return nil, err
	}

	region := normalizeRegion(config.Region)
	options := []oss.ClientOption{}
	if region != "" {
		options = append(options, oss.Region(region))
	}

	return oss.New(endpoint, config.AccessKeyID, config.AccessKeySecret, options...)
}

func sdkSmokeTestListBuckets(config OSSConfig) error {
	client, err := sdkClientFromConfig(config)
	if err != nil {
		return err
	}
	_, err = client.ListBuckets(oss.MaxKeys(1))
	return err
}

func formatObjectLastModified(ts time.Time) string {
	if ts.IsZero() {
		return ""
	}
	return ts.Local().Format("2006-01-02 15:04:05")
}

func normalizeObjectPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	prefix = strings.TrimLeft(prefix, "/")
	if prefix == "" {
		return ""
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

func buildOssPath(bucketName string, key string) string {
	bucketName = strings.Trim(bucketName, "/")
	key = strings.TrimLeft(key, "/")
	if bucketName == "" {
		return "oss://"
	}
	if key == "" {
		return fmt.Sprintf("oss://%s/", bucketName)
	}
	return fmt.Sprintf("oss://%s/%s", bucketName, key)
}

func (s *OSSService) ListObjectsPage(config OSSConfig, bucketName string, prefix string, marker string, maxKeys int) (ObjectListPageResult, error) {
	bucketName = strings.TrimSpace(bucketName)
	if bucketName == "" {
		return ObjectListPageResult{}, fmt.Errorf("bucket name is required")
	}

	prefix = normalizeObjectPrefix(prefix)
	marker = strings.TrimSpace(marker)

	if maxKeys <= 0 {
		maxKeys = 200
	}
	if maxKeys > 1000 {
		maxKeys = 1000
	}

	client, err := sdkClientFromConfig(config)
	if err != nil {
		return ObjectListPageResult{}, err
	}

	bucket, err := client.Bucket(bucketName)
	if err != nil {
		return ObjectListPageResult{}, fmt.Errorf("failed to open bucket: %w", err)
	}

	lor, err := bucket.ListObjects(
		oss.Prefix(prefix),
		oss.Delimiter("/"),
		oss.Marker(marker),
		oss.MaxKeys(maxKeys),
	)
	if err != nil {
		return ObjectListPageResult{}, fmt.Errorf("failed to list objects: %w", err)
	}

	folders := make([]ObjectInfo, 0, len(lor.CommonPrefixes))
	for _, commonPrefix := range lor.CommonPrefixes {
		if prefix != "" && !strings.HasPrefix(commonPrefix, prefix) {
			continue
		}
		relative := strings.TrimPrefix(commonPrefix, prefix)
		relative = strings.TrimSuffix(relative, "/")
		if relative == "" || strings.Contains(relative, "/") {
			continue
		}

		folders = append(folders, ObjectInfo{
			Name: relative,
			Path: buildOssPath(bucketName, prefix+relative+"/"),
			Type: "Folder",
		})
	}

	files := make([]ObjectInfo, 0, len(lor.Objects))
	for _, object := range lor.Objects {
		key := strings.TrimLeft(object.Key, "/")
		if key == "" {
			continue
		}
		if prefix != "" && key == prefix {
			continue
		}
		if prefix != "" && !strings.HasPrefix(key, prefix) {
			continue
		}

		relative := strings.TrimPrefix(key, prefix)
		if relative == "" || strings.Contains(relative, "/") {
			continue
		}

		files = append(files, ObjectInfo{
			Name:         relative,
			Path:         buildOssPath(bucketName, key),
			Size:         object.Size,
			Type:         "File",
			LastModified: formatObjectLastModified(object.LastModified),
			StorageClass: object.StorageClass,
		})
	}

	sort.Slice(folders, func(i, j int) bool { return folders[i].Name < folders[j].Name })
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

	items := make([]ObjectInfo, 0, len(folders)+len(files))
	items = append(items, folders...)
	items = append(items, files...)

	return ObjectListPageResult{
		Items:       items,
		NextMarker:  lor.NextMarker,
		IsTruncated: lor.IsTruncated,
	}, nil
}
