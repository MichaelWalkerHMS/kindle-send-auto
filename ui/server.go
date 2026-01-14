package ui

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/nikhil1raghav/kindle-send/cookies"
	"github.com/nikhil1raghav/kindle-send/epubgen"
	"github.com/nikhil1raghav/kindle-send/util"
)

//go:embed static/index.html
var staticFiles embed.FS

var cookiesFilePath string
var exportDirPath string
var pendingFilePath string
var exportedFilePath string
var manualFilePath string

type convertRequest struct {
	URLs  []string `json:"urls"`
	Title string   `json:"title"`
}

type convertResponse struct {
	Success  bool   `json:"success"`
	Filename string `json:"filename,omitempty"`
	Error    string `json:"error,omitempty"`
}

type cookieResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type pendingEntry struct {
	URL     string `json:"url"`
	AddedAt string `json:"added_at"`
}

type pendingRequest struct {
	URL string `json:"url"`
}

type manualArticle struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Source  string `json:"source,omitempty"`
	AddedAt string `json:"added_at"`
}

type manualRequest struct {
	Title   string `json:"title"`
	Content string `json:"content"`
	Source  string `json:"source,omitempty"`
}

type manualResponse struct {
	Success bool            `json:"success"`
	Count   int             `json:"count"`
	Articles []manualArticle `json:"articles,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type pendingResponse struct {
	Success bool           `json:"success"`
	URLs    []pendingEntry `json:"urls,omitempty"`
	Error   string         `json:"error,omitempty"`
}

func StartServer(port int, exportDir string, cookiesFile string) error {
	cookiesFilePath = cookiesFile
	exportDirPath = exportDir

	// Set pending, exported, and manual file paths
	cwd, _ := os.Getwd()
	pendingFilePath = filepath.Join(cwd, "pending.json")
	exportedFilePath = filepath.Join(exportDir, "exported.json")
	manualFilePath = filepath.Join(cwd, "manual-articles.json")

	// Ensure export directory exists
	if err := os.MkdirAll(exportDir, 0755); err != nil {
		return fmt.Errorf("failed to create export directory: %w", err)
	}

	// Serve static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return fmt.Errorf("failed to load static files: %w", err)
	}

	http.Handle("/", http.FileServer(http.FS(staticFS)))
	http.HandleFunc("/convert", handleConvert(exportDir))
	http.HandleFunc("/cookies", handleCookies)
	http.HandleFunc("/open-folder", handleOpenFolder)
	http.HandleFunc("/pending", handlePending)
	http.HandleFunc("/manual", handleManual)

	addr := fmt.Sprintf(":%d", port)
	util.CyanBold.Printf("Starting server at http://localhost%s\n", addr)
	return http.ListenAndServe(addr, nil)
}

func handleConvert(exportDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.Method != http.MethodPost {
			json.NewEncoder(w).Encode(convertResponse{
				Success: false,
				Error:   "Method not allowed",
			})
			return
		}

		var req convertRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(convertResponse{
				Success: false,
				Error:   "Invalid request body",
			})
			return
		}

		// Get manual articles
		manualArticles := loadManualArticles()
		var epubManualArticles []epubgen.ManualArticle
		for _, m := range manualArticles {
			epubManualArticles = append(epubManualArticles, epubgen.ManualArticle{
				Title:   m.Title,
				Content: m.Content,
				Source:  m.Source,
			})
		}

		if len(req.URLs) == 0 && len(epubManualArticles) == 0 {
			json.NewEncoder(w).Encode(convertResponse{
				Success: false,
				Error:   "No URLs or manual articles provided",
			})
			return
		}

		// Generate EPUB with URLs and manual articles
		epubPath, err := epubgen.MakeToDirWithManual(req.URLs, epubManualArticles, req.Title, exportDir)
		if err != nil {
			json.NewEncoder(w).Encode(convertResponse{
				Success: false,
				Error:   err.Error(),
			})
			return
		}

		// Clear manual articles after successful conversion
		if len(manualArticles) > 0 {
			saveManualArticles([]manualArticle{})
		}

		filename := filepath.Base(epubPath)
		json.NewEncoder(w).Encode(convertResponse{
			Success:  true,
			Filename: filename,
		})
	}
}

func handleCookies(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		// Read and return cookies from file
		if cookiesFilePath == "" {
			json.NewEncoder(w).Encode(map[string]interface{}{})
			return
		}

		data, err := os.ReadFile(cookiesFilePath)
		if err != nil {
			// File doesn't exist yet, return empty
			json.NewEncoder(w).Encode(map[string]interface{}{})
			return
		}

		// Parse and re-encode to ensure valid JSON
		var cookieData map[string]map[string]string
		if err := json.Unmarshal(data, &cookieData); err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{})
			return
		}

		json.NewEncoder(w).Encode(cookieData)

	case http.MethodPost:
		// Save cookies to file and reload HTTP client
		var cookieData map[string]map[string]string
		if err := json.NewDecoder(r.Body).Decode(&cookieData); err != nil {
			json.NewEncoder(w).Encode(cookieResponse{
				Success: false,
				Error:   "Invalid request body",
			})
			return
		}

		// Determine file path
		filePath := cookiesFilePath
		if filePath == "" {
			// Default to cookies.json in current directory
			cwd, _ := os.Getwd()
			filePath = filepath.Join(cwd, "cookies.json")
			cookiesFilePath = filePath
		}

		// Write to file
		data, err := json.MarshalIndent(cookieData, "", "  ")
		if err != nil {
			json.NewEncoder(w).Encode(cookieResponse{
				Success: false,
				Error:   "Failed to encode cookies",
			})
			return
		}

		if err := os.WriteFile(filePath, data, 0644); err != nil {
			json.NewEncoder(w).Encode(cookieResponse{
				Success: false,
				Error:   "Failed to write cookies file: " + err.Error(),
			})
			return
		}

		// Reload HTTP client with new cookies
		client, err := cookies.LoadCookies(filePath)
		if err != nil {
			json.NewEncoder(w).Encode(cookieResponse{
				Success: false,
				Error:   "Cookies saved but failed to reload: " + err.Error(),
			})
			return
		}
		epubgen.SetHTTPClient(client)

		json.NewEncoder(w).Encode(cookieResponse{
			Success: true,
		})

	default:
		json.NewEncoder(w).Encode(cookieResponse{
			Success: false,
			Error:   "Method not allowed",
		})
	}
}

func handleOpenFolder(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		json.NewEncoder(w).Encode(cookieResponse{
			Success: false,
			Error:   "Method not allowed",
		})
		return
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("xdg-open", exportDirPath)
	case "darwin":
		cmd = exec.Command("open", exportDirPath)
	case "windows":
		cmd = exec.Command("explorer", exportDirPath)
	default:
		json.NewEncoder(w).Encode(cookieResponse{
			Success: false,
			Error:   "Unsupported operating system",
		})
		return
	}

	if err := cmd.Start(); err != nil {
		json.NewEncoder(w).Encode(cookieResponse{
			Success: false,
			Error:   "Failed to open folder: " + err.Error(),
		})
		return
	}

	json.NewEncoder(w).Encode(cookieResponse{
		Success: true,
	})
}

func handlePending(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	// Allow CORS for the Chrome extension
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	switch r.Method {
	case http.MethodGet:
		// Return pending URLs
		entries := loadPendingEntries()
		json.NewEncoder(w).Encode(pendingResponse{
			Success: true,
			URLs:    entries,
		})

	case http.MethodPost:
		// Add URL to pending
		var req pendingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(pendingResponse{
				Success: false,
				Error:   "Invalid request body",
			})
			return
		}

		if req.URL == "" {
			json.NewEncoder(w).Encode(pendingResponse{
				Success: false,
				Error:   "URL is required",
			})
			return
		}

		entries := loadPendingEntries()

		// Check for duplicate
		for _, e := range entries {
			if e.URL == req.URL {
				json.NewEncoder(w).Encode(pendingResponse{
					Success: true, // Already exists, consider it success
					URLs:    entries,
				})
				return
			}
		}

		entries = append(entries, pendingEntry{
			URL:     req.URL,
			AddedAt: time.Now().Format(time.RFC3339),
		})

		if err := savePendingEntries(entries); err != nil {
			json.NewEncoder(w).Encode(pendingResponse{
				Success: false,
				Error:   "Failed to save: " + err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(pendingResponse{
			Success: true,
			URLs:    entries,
		})

	case http.MethodDelete:
		// Move pending to exported and clear
		entries := loadPendingEntries()

		if len(entries) > 0 {
			// Load existing exported entries
			exportedEntries := loadExportedEntries()

			// Prepend current pending to exported (newest first)
			exportedEntries = append(entries, exportedEntries...)

			// Save exported
			if err := saveExportedEntries(exportedEntries); err != nil {
				json.NewEncoder(w).Encode(pendingResponse{
					Success: false,
					Error:   "Failed to archive: " + err.Error(),
				})
				return
			}
		}

		// Clear pending
		if err := savePendingEntries([]pendingEntry{}); err != nil {
			json.NewEncoder(w).Encode(pendingResponse{
				Success: false,
				Error:   "Failed to clear pending: " + err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(pendingResponse{
			Success: true,
			URLs:    []pendingEntry{},
		})

	default:
		json.NewEncoder(w).Encode(pendingResponse{
			Success: false,
			Error:   "Method not allowed",
		})
	}
}

func loadPendingEntries() []pendingEntry {
	data, err := os.ReadFile(pendingFilePath)
	if err != nil {
		return []pendingEntry{}
	}
	var entries []pendingEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return []pendingEntry{}
	}
	return entries
}

func savePendingEntries(entries []pendingEntry) error {
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(pendingFilePath, data, 0644)
}

func loadExportedEntries() []pendingEntry {
	data, err := os.ReadFile(exportedFilePath)
	if err != nil {
		return []pendingEntry{}
	}
	var entries []pendingEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return []pendingEntry{}
	}
	return entries
}

func saveExportedEntries(entries []pendingEntry) error {
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(exportedFilePath, data, 0644)
}

func handleManual(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		// Return manual articles
		articles := loadManualArticles()
		json.NewEncoder(w).Encode(manualResponse{
			Success:  true,
			Count:    len(articles),
			Articles: articles,
		})

	case http.MethodPost:
		// Add manual article
		var req manualRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(manualResponse{
				Success: false,
				Error:   "Invalid request body",
			})
			return
		}

		if req.Title == "" || req.Content == "" {
			json.NewEncoder(w).Encode(manualResponse{
				Success: false,
				Error:   "Title and content are required",
			})
			return
		}

		articles := loadManualArticles()
		articles = append(articles, manualArticle{
			Title:   req.Title,
			Content: req.Content,
			Source:  req.Source,
			AddedAt: time.Now().Format(time.RFC3339),
		})

		if err := saveManualArticles(articles); err != nil {
			json.NewEncoder(w).Encode(manualResponse{
				Success: false,
				Error:   "Failed to save: " + err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(manualResponse{
			Success:  true,
			Count:    len(articles),
			Articles: articles,
		})

	case http.MethodDelete:
		// Clear manual articles
		if err := saveManualArticles([]manualArticle{}); err != nil {
			json.NewEncoder(w).Encode(manualResponse{
				Success: false,
				Error:   "Failed to clear: " + err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(manualResponse{
			Success:  true,
			Count:    0,
			Articles: []manualArticle{},
		})

	default:
		json.NewEncoder(w).Encode(manualResponse{
			Success: false,
			Error:   "Method not allowed",
		})
	}
}

func loadManualArticles() []manualArticle {
	data, err := os.ReadFile(manualFilePath)
	if err != nil {
		return []manualArticle{}
	}
	var articles []manualArticle
	if err := json.Unmarshal(data, &articles); err != nil {
		return []manualArticle{}
	}
	return articles
}

func saveManualArticles(articles []manualArticle) error {
	data, err := json.MarshalIndent(articles, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manualFilePath, data, 0644)
}

// GetManualArticles returns the current manual articles (for use by epubgen)
func GetManualArticles() []manualArticle {
	return loadManualArticles()
}

// ClearManualArticles clears all manual articles
func ClearManualArticles() error {
	return saveManualArticles([]manualArticle{})
}
