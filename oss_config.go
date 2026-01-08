package main

// OSSConfig represents the OSS connection configuration
type OSSConfig struct {
	AccessKeyID     string `json:"accessKeyId"`
	AccessKeySecret string `json:"accessKeySecret"`
	Region          string `json:"region"`
	Endpoint        string `json:"endpoint"`
	DefaultPath     string `json:"defaultPath"`
}

// OSSProfile represents a saved OSS profile
type OSSProfile struct {
	Name      string    `json:"name"`
	Config    OSSConfig `json:"config"`
	IsDefault bool      `json:"isDefault"`
}

// ConnectionResult represents the result of a connection test
type ConnectionResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// BucketInfo represents OSS bucket information
type BucketInfo struct {
	Name         string `json:"name"`
	Region       string `json:"region"`
	CreationDate string `json:"creationDate"`
}
