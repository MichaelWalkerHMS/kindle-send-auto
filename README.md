# kindle-send-auto

A Firefox extension that turns web articles into Kindle-ready EPUBs: full-resolution images you can zoom, popup footnotes, and no server to run.

> **Fork of [nikhil1raghav/kindle-send](https://github.com/nikhil1raghav/kindle-send).** The original Go CLI is still in this repo (see [Go CLI](#go-cli-legacy)), but the extension no longer needs it.

---

## Features

| Feature | Description |
|---------|-------------|
| **Save article** | Captures the page as you see it, including paywalled posts you're logged in to and JavaScript-heavy sites |
| **Queue links** | Queue a link, or paste several, and they're downloaded when you build |
| **X/Twitter threads** | Saves the visible posts with their images |
| **Pasted articles** | Paste text or HTML for content that can't be captured |
| **Zoomable images** | Downloads the largest version of each image (up to 1800×2400) and removes the links around them, so tapping an image on the Kindle zooms instead of opening a URL |
| **Popup footnotes** | Converts footnotes (Substack, Wikipedia and similar) into Kindle popup notes |
| **Local-only** | Articles and EPUBs stay in your browser and Downloads folder |

Article extraction uses Mozilla's [Readability](https://github.com/mozilla/readability), the engine behind Firefox Reader View.

---

## Using it

1. On an article, click the **Kindle Send** toolbar button and choose **Save article**, or **Queue link only** to download it at build time.
2. Click **Open queue**, optionally set a book title, and click **Build EPUB**. The first build asks for permission to access websites, which it needs to download pages and images.
3. The `.epub` lands in your Downloads folder. Upload it at [amazon.com/sendtokindle](https://www.amazon.com/sendtokindle).

Several queued articles become one book, with a table of contents.

---

## Installing in Firefox

### Quick test (removed when Firefox restarts)

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and pick `extension/manifest.json`

### Permanent install (free private signing by Mozilla)

Release Firefox only installs add-ons signed by Mozilla. Self-distributed ("unlisted") add-ons are signed for free, aren't listed publicly, and pass automated checks within minutes.

1. **Make a zip with `manifest.json` at the top level** (not inside a folder). From the `extension` folder:
   ```sh
   tar -a -c -f ../kindle-send.zip *
   ```
   Don't use PowerShell 5.1's `Compress-Archive`: it writes paths like `lib\Readability.js` with backslashes, which Firefox doesn't recognize as folders.
2. **Sign in** at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/), creating a free Mozilla account if needed, and accept the developer agreement the first time.
3. Click **Submit a New Add-on** and choose **On your own** (self-distribution).
4. **Upload** `kindle-send.zip` and wait for validation. If asked whether the add-on uses minified or generated code, answer **No**; every file is plain source.
5. When signing finishes, **download the `.xpi`** from the version page.
6. **Install it**: remove any temporary copy in `about:debugging`, then drag the `.xpi` onto a Firefox window (or **File → Open File…**) and click **Add**.

**Updating:** raise `"version"` in `extension/manifest.json` (it must increase every time), re-zip, then use **Upload New Version** on the add-on's page in the Developer Hub. Keep the `gecko.id` unchanged, or Firefox treats it as a different add-on.

**Command-line alternative:** generate API keys at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) (keep them private), then run:
```sh
npx web-ext sign --source-dir extension --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>
```

### Chrome, Edge and Brave

The same folder loads as-is: go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `extension/`. Chrome warns about the Firefox-only `browser_specific_settings` key; that's harmless.

---

## Installing in Safari (Mac)

Safari runs the same `extension/` folder. There are two ways to install it.

### Quick test, no Xcode (removed after 24 hours or when Safari quits)

1. In Safari, open **Settings → Advanced** and turn on **Show features for web developers** (called **Show Develop menu in menu bar** before Safari 17).
2. Open **Settings → Developer**, click **Add Temporary Extension…**, and select the `extension` folder (or `kindle-send.zip`).

### App build with Xcode (stays installed)

Safari extensions are distributed inside a small Mac app. `scripts/build-safari.sh` generates the Xcode project for it with Apple's packager.

1. Install **Xcode** from the Mac App Store and open it once to finish setup.
2. In Terminal, from the repo folder, run:
   ```sh
   sh scripts/build-safari.sh
   ```
   This creates a **Kindle Send** Xcode project under `safari/` and opens it in Xcode. The project points at `extension/` instead of copying it, so later changes only need a rebuild.
3. In Xcode, pick the **Kindle Send** app scheme (next to the Run button) and click **Run** (⌘R). The Kindle Send app opens, and the extension is installed.
4. In Safari, open **Settings → Extensions** and tick **Kindle Send**.
5. Open **Settings → Websites**, select **Kindle Send**, and set **Other Websites** to **Allow**. Kindle Send needs this to save pages and download images.

**Signing:** without a paid [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year), the build is unsigned, and Safari hides unsigned extensions until you tick **Settings → Developer → Allow unsigned extensions**. That setting resets every time Safari quits, so you re-tick it after each launch. With a membership, pick your team under **Signing & Capabilities** in Xcode and the extension stays enabled.

**Updating:** pull the latest code and press **Run** in Xcode again. Re-run the script only when the project itself needs regenerating; it overwrites `safari/`, including your signing choice. Use a different bundle identifier with `BUNDLE_ID=com.example.KindleSend sh scripts/build-safari.sh`.

**Safari differences:** Safari has no downloads API, so after **Build EPUB** the queue page shows a **Save** link; click it to save the file.

---

## Extension files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (Firefox add-on ID, permissions) |
| `popup.html`, `popup.js` | Toolbar popup: save the current page or queue its link |
| `queue.html`, `queue.js` | Queue page: manage items, add links, paste articles, build the EPUB |
| `article.js` | Article extraction, footnote conversion, largest-image selection |
| `epub.js` | Image download and compression, XHTML cleanup, EPUB packaging |
| `queue-store.js` | Queue storage (`storage.local`) |
| `twitter.js` | X/Twitter thread extractor |
| `icons/` | Toolbar and add-on icons |
| `lib/Readability.js` | Mozilla Readability 0.6.0 (Apache-2.0, see `lib/Readability-LICENSE.md`) |

---

## Go CLI (legacy)

The original CLI and the earlier local web UI are still here. Building them needs Go, and on Windows with Smart App Control enabled, `go.exe` and unsigned binaries may be blocked from running.

```sh
go build -o kindle-send-auto .
kindle-send-auto download <url1> <url2> <links.txt>
kindle-send-auto send <url|file.epub|links.txt>
kindle-send-auto ui [--port 8080] [--cookies path/to/cookies.json]
```

`send` emails the EPUB to your Kindle and asks for email settings on first run.

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

This project is licensed under **AGPL-3.0**, the same license as the original project. `extension/lib/Readability.js` is Apache-2.0.

See [LICENSE.md](LICENSE.md) for details.
