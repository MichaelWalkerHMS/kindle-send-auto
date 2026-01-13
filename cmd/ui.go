package cmd

import (
	"os"
	"path/filepath"

	"github.com/nikhil1raghav/kindle-send/cookies"
	"github.com/nikhil1raghav/kindle-send/epubgen"
	"github.com/nikhil1raghav/kindle-send/ui"
	"github.com/nikhil1raghav/kindle-send/util"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(uiCmd)
	uiCmd.Flags().IntP("port", "p", 8080, "Port to run the web server on")
	uiCmd.Flags().StringP("cookies", "k", "", "Path to cookies.txt file (Netscape format)")
}

var uiCmd = &cobra.Command{
	Use:   "ui",
	Short: "Start the web UI for converting URLs to EPUB",
	Long: `Starts a local web server with a simple interface for pasting URLs and converting them to EPUB files.

To access paywalled content, export your browser cookies to a cookies.txt file
(Netscape format) using a browser extension, then pass it with --cookies.`,
	Run: func(cmd *cobra.Command, args []string) {
		port, _ := cmd.Flags().GetInt("port")
		cookiesFile, _ := cmd.Flags().GetString("cookies")

		// Get the current working directory
		cwd, err := os.Getwd()
		if err != nil {
			util.Red.Println("Error getting current directory:", err)
			return
		}

		// Default cookies file if not provided
		if cookiesFile == "" {
			cookiesFile = filepath.Join(cwd, "cookies.json")
		}

		// Load cookies if file exists
		if _, err := os.Stat(cookiesFile); err == nil {
			client, err := cookies.LoadCookies(cookiesFile)
			if err != nil {
				util.Red.Println("Error loading cookies:", err)
				return
			}
			epubgen.SetHTTPClient(client)
			util.Green.Println("Loaded cookies from", cookiesFile)
		}

		exportDir := filepath.Join(cwd, "exports")

		if err := ui.StartServer(port, exportDir, cookiesFile); err != nil {
			util.Red.Println("Server error:", err)
		}
	},
}
