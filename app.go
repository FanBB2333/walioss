package main

import (
	"context"
	"fmt"
	"os/exec"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx        context.Context
	OSSService *OSSService
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		OSSService: NewOSSService(),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

// SelectFile opens a file selection dialog
func (a *App) SelectFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select File to Upload",
	})
}

// SelectSaveFile opens a save file dialog
func (a *App) SelectSaveFile(filename string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:                "Save File As",
		DefaultFilename:      filename,
		CanCreateDirectories: true,
	})
}

// OpenInFinder opens the containing folder in Finder (macOS)
func (a *App) OpenInFinder(filePath string) error {
	return exec.Command("open", "-R", filePath).Start()
}
