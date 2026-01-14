# kindle-send-auto

A web UI and browser extension for converting web articles to EPUB for e-readers.

> **Fork of [nikhil1raghav/kindle-send](https://github.com/nikhil1raghav/kindle-send)** — This project extends the original CLI tool with a web interface, cookie-based authentication for paywalled content, and a Chrome extension for queuing URLs while browsing.

---

## What's New in This Fork

| Feature | Description |
|---------|-------------|
| **Web UI** | Browser-based interface at `localhost:8080` for converting URLs to EPUB |
| **Cookie Authentication** | Access paywalled content (Substack, etc.) using your browser session |
| **Pending Queue** | Save URLs while browsing, convert them later in batch |
| **Chrome Extension** | Add URLs to queue, or extract content from JS-heavy sites like Twitter/X |
| **Manual Article Entry** | Paste content directly for sites that can't be fetched |
| **Image Compression** | Auto-resize and compress images for smaller EPUB files |
| **Local-only** | All data stays on your machine — no cloud, no external servers |

---

## Quick Start

### 1. Install

```sh
# Clone and build
git clone https://github.com/MichaelWalkerHMS/kindle-send-auto.git
cd kindle-send-auto
go build -o kindle-send-auto .
```

### 2. Run the Web UI

```sh
./kindle-send-auto ui
```

Open http://localhost:8080 in your browser.

### 3. Install the Chrome Extension (Optional)

1. Go to `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

---

## Features

### Web UI

Paste URLs (one per line), optionally set a filename, and click **Download** to generate an EPUB.

After conversion:
- **Open Folder** — Opens the exports directory in your file manager
- **Send to Kindle** — Opens Amazon's Send to Kindle web page

### Cookie Authentication

For paywalled content, add your session cookies in the **Cookie Management** section of the UI:

1. Open DevTools on the site while logged in (F12 → Application → Cookies)
2. Find the session cookie (e.g., `substack.sid` for Substack, `connect.sid` for custom domains)
3. Add the domain and cookie in the UI and click **Save Cookies**

Cookies are stored locally in `cookies.json` (git-ignored).

### Chrome Extension

The extension provides two ways to save content:

**Add URL to Pending** (for most sites):
1. Click the extension icon on any page
2. Click **Add URL to Pending**
3. Later, open the web UI and click **Load Pending**

**Extract Page Content** (for JS-heavy sites like Twitter/X):
1. Navigate to the content you want (e.g., a Twitter thread)
2. Click the extension icon
3. Optionally edit the title
4. Click **Extract Page Content**

The extractor walks the page DOM to capture text and images in their original positions. For Twitter, it automatically filters out metadata (likes, retweets, timestamps, etc.).

### Manual Article Entry

For content that can't be extracted automatically:

1. Open the web UI
2. Scroll to **Manual Article Entry**
3. Paste the title, content (plain text or HTML), and optionally the source URL
4. Click **Add Article**
5. The pending counter shows how many manual articles are queued
6. Click **Convert** to generate the EPUB

### Pending Queue

**When ready to convert:**
1. Open the web UI
2. Click **Load Pending** to fill the URL list (if using URL queue)
3. Convert to EPUB
4. Click **Clear Pending** to archive URLs to `exports/exported.json`

---

## CLI Commands

The original CLI functionality is preserved:

### Start Web UI
```sh
kindle-send-auto ui [--port 8080] [--cookies path/to/cookies.json]
```

### Download Only (No UI)
```sh
kindle-send-auto download <url>
kindle-send-auto download <url1> <url2> <links.txt>
```

### Send to Kindle (Original Functionality)
```sh
kindle-send-auto send <url>
kindle-send-auto send <file.epub>
kindle-send-auto send <links.txt>
```

For send functionality, you'll need to configure email settings on first run.

---

## File Structure

| File | Purpose |
|------|---------|
| `cookies.json` | Your session cookies (git-ignored) |
| `pending.json` | URLs waiting to be converted (git-ignored) |
| `manual-articles.json` | Manually entered/extracted articles (git-ignored) |
| `exports/` | Generated EPUB files |
| `exports/exported.json` | Archive of converted URLs (git-ignored) |

---

## Development

### Rebuild and Restart

If you have the Claude Code CLI, use the `/dev` command. Otherwise:

```sh
killall kindle-send-auto 2>/dev/null || true
go build -o kindle-send-auto .
./kindle-send-auto ui
```

---

## Original Project

This is a fork of [kindle-send](https://github.com/nikhil1raghav/kindle-send) by [@nikhil1raghav](https://github.com/nikhil1raghav).

The original project provides:
- CLI-based URL to EPUB conversion
- Email delivery to Kindle/e-readers
- Support for multiple URLs combined into single volumes

See the [original README](https://github.com/nikhil1raghav/kindle-send#readme) for full CLI documentation.

---

## License

This project is licensed under **AGPL-3.0**, the same license as the original project.

See [LICENSE.md](LICENSE.md) for details.
