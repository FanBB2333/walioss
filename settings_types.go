package main

// AppSettings holds application-wide settings
type AppSettings struct {
	OssutilPath     string `json:"ossutilPath"`
	DefaultRegion   string `json:"defaultRegion"`
	DefaultEndpoint string `json:"defaultEndpoint"`
	Theme           string `json:"theme"` // "light" or "dark"
}
