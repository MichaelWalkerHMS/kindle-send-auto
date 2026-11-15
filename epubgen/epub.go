package epubgen

import (
	"bytes"
	"encoding/base64"
	"errors"
	htmlutil "html"
	"image"
	"image/jpeg"
	_ "image/png" // Register PNG decoder
	_ "image/gif" // Register GIF decoder
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/bmaupin/go-epub"
	"github.com/go-shiori/go-readability"
	"github.com/gosimple/slug"
	"github.com/nikhil1raghav/kindle-send/config"
	"github.com/nikhil1raghav/kindle-send/util"
	"golang.org/x/image/draw"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// httpClient is used for fetching URLs. Can be set with SetHTTPClient to include cookies.
var httpClient *http.Client

// SetHTTPClient sets the HTTP client used for fetching URLs.
// Use this to provide a client with cookies loaded.
func SetHTTPClient(client *http.Client) {
	httpClient = client
}

func getHTTPClient() *http.Client {
	if httpClient != nil {
		return httpClient
	}
	return &http.Client{Timeout: 30 * time.Second}
}

type epubmaker struct {
	Epub      *epub.Epub
	downloads map[string]string
}

func NewEpubmaker(title string) *epubmaker {
	downloadMap := make(map[string]string)
	return &epubmaker{
		Epub:      epub.NewEpub(title),
		downloads: downloadMap,
	}
}

func fetchReadable(pageURL string) (readability.Article, error) {
	client := getHTTPClient()

	req, err := http.NewRequest("GET", pageURL, nil)
	if err != nil {
		return readability.Article{}, err
	}

	// Set a browser-like User-Agent
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return readability.Article{}, err
	}
	defer resp.Body.Close()

	parsedURL, err := url.Parse(pageURL)
	if err != nil {
		return readability.Article{}, err
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return readability.Article{}, err
	}

	article, err := readability.FromReader(bytes.NewReader(body), parsedURL)
	if err != nil {
		return article, err
	}

	// Readability discards footnote sections, so note text is recovered from the original page
	if rawDoc, err := goquery.NewDocumentFromReader(bytes.NewReader(body)); err == nil {
		addFootnotes(&article, rawDoc)
	}
	return article, nil
}

var footnoteMarker = regexp.MustCompile(`^[\[(]?([0-9]{1,3}|[*†‡§]+)[\])]?$`)

// addFootnotes turns in-page footnote references into EPUB3 noteref/footnote pairs, which
// Kindle shows as popup notes. The two-way links are what older Kindle firmware keys on.
func addFootnotes(article *readability.Article, rawDoc *goquery.Document) {
	if article.Node == nil {
		return
	}
	content := goquery.NewDocumentFromNode(article.Node)
	seen := make(map[string]bool)
	var notes strings.Builder

	content.Find(`a[href^="#"]`).Each(func(i int, ref *goquery.Selection) {
		marker := strings.TrimSpace(ref.Text())
		if !footnoteMarker.MatchString(marker) {
			return
		}
		href, _ := ref.Attr("href")
		targetID := strings.TrimPrefix(href, "#")
		// Attribute selectors avoid CSS-escaping ids like "fn:1"; quotes would break them
		if targetID == "" || strings.ContainsAny(targetID, `"\`) {
			return
		}
		idSelector := `[id="` + targetID + `"]`

		if content.Find(idSelector).Length() > 0 {
			ref.SetAttr("epub:type", "noteref")
			return
		}
		if seen[targetID] {
			ref.SetAttr("epub:type", "noteref")
			return
		}

		target := rawDoc.Find(idSelector).First()
		if target.Length() == 0 {
			return
		}
		// Substack puts the id on the note's number link; the note text is its parent
		if goquery.NodeName(target) == "a" {
			target = target.Parent()
		}
		note := target.Clone()
		note.Find(`a[href^="#"]`).Remove()
		if strings.TrimSpace(note.Text()) == "" {
			return
		}

		refID, ok := ref.Attr("id")
		if !ok || refID == "" {
			refID = "noteref-" + targetID
			ref.SetAttr("id", refID)
		}
		ref.SetAttr("epub:type", "noteref")
		ref.RemoveAttr("target")
		if goquery.NodeName(ref.Parent()) != "sup" {
			ref.WrapNode(&html.Node{Type: html.ElementNode, Data: "sup", DataAtom: atom.Sup})
		}

		backlink := `<a href="#` + htmlutil.EscapeString(refID) + `">` + htmlutil.EscapeString(marker) + `</a> `
		if p := note.Find("p").First(); p.Length() > 0 {
			p.PrependHtml(backlink)
		} else {
			note.PrependHtml(backlink)
		}
		noteHTML, err := note.Html()
		if err != nil {
			return
		}

		seen[targetID] = true
		notes.WriteString(`<aside epub:type="footnote" id="` + htmlutil.EscapeString(targetID) + `">` + noteHTML + `</aside>`)
	})

	if notes.Len() == 0 {
		return
	}
	// Readability's nodes lack DataAtom, which makes goquery's AppendHtml panic when it uses
	// them as a parse context, so the notes are parsed separately and moved in as nodes.
	notesDoc, err := goquery.NewDocumentFromReader(strings.NewReader(`<hr/>` + notes.String()))
	if err != nil {
		return
	}
	content.Selection.AppendSelection(notesDoc.Find("body").Contents())
	if rendered, err := content.Html(); err == nil {
		article.Content = rendered
	}
}

// Download the highest-resolution srcset candidate rather than the (often small) src
func promoteLargestSrcset(i int, img *goquery.Selection) {
	srcset, ok := img.Attr("srcset")
	if !ok {
		return
	}
	bestURL, bestWidth := "", 0
	// Substack-style URLs contain commas, so candidates are split on ", " rather than ","
	for _, candidate := range strings.Split(srcset, ", ") {
		fields := strings.Fields(strings.TrimSpace(candidate))
		if len(fields) != 2 || !strings.HasSuffix(fields[1], "w") {
			continue
		}
		width, err := strconv.Atoi(strings.TrimSuffix(fields[1], "w"))
		if err == nil && width > bestWidth {
			bestURL, bestWidth = fields[0], width
		}
	}
	if bestURL != "" {
		img.SetAttr("src", bestURL)
	}
}

// Kindle only opens its image zoom view for images that aren't links, and it can't load
// <source> entries that still point at remote (often WebP) files.
func unwrapImages(doc *goquery.Document) {
	doc.Find("picture").Each(func(i int, p *goquery.Selection) {
		p.Find("source").Remove()
		p.ReplaceWithSelection(p.Contents())
	})
	doc.Find("a").Each(func(i int, a *goquery.Selection) {
		if a.Find("img").Length() > 0 {
			a.ReplaceWithSelection(a.Contents())
		}
	})
	// Fixed pixel sizes from the web layout stop the reader scaling images to the screen
	doc.Find("img").RemoveAttr("width").RemoveAttr("height").RemoveAttr("sizes").RemoveAttr("style")
}

// Point remote image link to downloaded image
func (e *epubmaker) changeRefs(i int, img *goquery.Selection) {
	img.RemoveAttr("loading")
	img.RemoveAttr("srcset")
	img.RemoveAttr("decoding")
	img.RemoveAttr("fetchpriority")
	imgSrc, exists := img.Attr("src")
	if exists {
		if _, ok := e.downloads[imgSrc]; ok {
			util.Green.Printf("Setting img src from %s to %s \n", imgSrc, e.downloads[imgSrc])
			img.SetAttr("src", e.downloads[imgSrc])
		}
	}
}

// Image compression settings. Bounds leave zoom headroom above current Kindle screens
// (Paperwhite 1236x1648, Scribe 1860x2480).
const (
	maxImageWidth  = 1800
	maxImageHeight = 2400
	jpegQuality    = 90
)

// downloadAndCompressImage downloads an image, resizes if needed, and compresses as JPEG
func downloadAndCompressImage(imgURL string) (string, error) {
	client := getHTTPClient()

	req, err := http.NewRequest("GET", imgURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.New("failed to download image: " + resp.Status)
	}

	// Read the image data
	imgData, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	// Decode the image
	img, _, err := image.Decode(bytes.NewReader(imgData))
	if err != nil {
		return "", err
	}

	bounds := img.Bounds()
	origWidth := bounds.Dx()
	origHeight := bounds.Dy()

	// Calculate new dimensions if resizing needed
	newWidth := origWidth
	newHeight := origHeight

	if origWidth > maxImageWidth || origHeight > maxImageHeight {
		// Scale down proportionally
		widthRatio := float64(maxImageWidth) / float64(origWidth)
		heightRatio := float64(maxImageHeight) / float64(origHeight)
		ratio := widthRatio
		if heightRatio < widthRatio {
			ratio = heightRatio
		}
		newWidth = int(float64(origWidth) * ratio)
		newHeight = int(float64(origHeight) * ratio)
	}

	// Resize if needed
	var finalImg image.Image
	if newWidth != origWidth || newHeight != origHeight {
		resized := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
		draw.CatmullRom.Scale(resized, resized.Bounds(), img, bounds, draw.Over, nil)
		finalImg = resized
		util.Cyan.Printf("Resized image from %dx%d to %dx%d\n", origWidth, origHeight, newWidth, newHeight)
	} else {
		finalImg = img
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, finalImg, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", err
	}

	// go-epub reads image sources lazily at Write time, so a temp file would have to outlive
	// this call; a data URL keeps the bytes with the epub instead.
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// Download images and add to epub zip
func (e *epubmaker) downloadImages(i int, img *goquery.Selection) {
	util.CyanBold.Println("Downloading Images")
	imgSrc, exists := img.Attr("src")

	if exists {

		//don't download same thing twice
		if _, ok := e.downloads[imgSrc]; ok {
			return
		}

		//pass unique and safe image names here, then it will not crash on windows
		//use murmur hash to generate file name
		imageFileName := util.GetHash(imgSrc) + ".jpg"

		dataURL, err := downloadAndCompressImage(imgSrc)
		if err != nil {
			util.Red.Printf("Couldn't download/compress image %s : %s\n", imgSrc, err)
			return
		}

		// base64 inflates by 4/3
		sizeKB := int64(len(dataURL)) * 3 / 4 / 1024

		imgRef, err := e.Epub.AddImage(dataURL, imageFileName)
		if err != nil {
			util.Red.Printf("Couldn't add image %s : %s\n", imgSrc, err)
			return
		}

		util.Green.Printf("Added image %s (compressed to %dKB)\n", filepath.Base(imgSrc), sizeKB)
		e.downloads[imgSrc] = imgRef
	}
}

// Fetches images in article and then embeds them into epub
func (e *epubmaker) embedImages(wg *sync.WaitGroup, article *readability.Article) {
	util.Cyan.Println("Embedding images in ", article.Title)
	defer wg.Done()
	//TODO: Compress images before embedding to improve size
	doc := goquery.NewDocumentFromNode(article.Node)

	doc.Find("img").Each(promoteLargestSrcset)

	//download all images
	doc.Find("img").Each(e.downloadImages)

	//Change all refs, doing it in two phases to download repeated images only once
	doc.Find("img").Each(e.changeRefs)

	unwrapImages(doc)

	content, err := doc.Html()

	if err != nil {
		util.Red.Printf("Error converting modified %s to HTML, it will be transferred without images : %s \n", article.Title, err)
	} else {
		article.Content = content
	}
}

// TODO: Look for better formatting, this is bare bones
func prepare(article *readability.Article) string {
	return "<h1>" + htmlutil.EscapeString(article.Title) + "</h1>" + article.Content
}

// Add articles to epub
func (e *epubmaker) addContent(articles *[]readability.Article) error {
	added := 0
	for _, article := range *articles {
		_, err := e.Epub.AddSection(prepare(&article), article.Title, "", "")
		if err != nil {
			util.Red.Printf("Couldn't add %s to epub : %s", article.Title, err)
		} else {
			added++
		}
	}
	util.Green.Printf("Added %d articles\n", added)
	if added == 0 {
		return errors.New("No article was added, epub creation failed")
	}
	return nil
}

// ManualArticle represents an article with pre-provided content (not fetched from URL)
type ManualArticle struct {
	Title   string
	Content string
	Source  string
}

// Generates a single epub from a slice of urls, saves to specified directory, returns file path
func MakeToDir(pageUrls []string, title string, outputDir string) (string, error) {
	return makeEpubWithManual(pageUrls, nil, title, outputDir)
}

// MakeToDirWithManual generates an epub from URLs and manual articles
func MakeToDirWithManual(pageUrls []string, manualArticles []ManualArticle, title string, outputDir string) (string, error) {
	return makeEpubWithManual(pageUrls, manualArticles, title, outputDir)
}

// Generates a single epub from a slice of urls, returns file path
func Make(pageUrls []string, title string) (string, error) {
	return makeEpubWithManual(pageUrls, nil, title, "")
}

// formatManualContent converts content to HTML
// If content looks like HTML (contains tags), use it as-is
// Otherwise, treat as plain text and convert to paragraphs
func formatManualContent(content string) string {
	// Check if content appears to be HTML (contains common HTML tags)
	if strings.Contains(content, "<p>") || strings.Contains(content, "<img") ||
		strings.Contains(content, "<div") || strings.Contains(content, "<br") {
		// Already HTML, return as-is
		return content
	}

	// Plain text - escape and convert to paragraphs
	escaped := htmlutil.EscapeString(content)
	// Split by double newlines (paragraph breaks)
	paragraphs := strings.Split(escaped, "\n\n")
	var result []string
	for _, p := range paragraphs {
		p = strings.TrimSpace(p)
		if p != "" {
			// Replace single newlines with <br> within paragraphs
			p = strings.ReplaceAll(p, "\n", "<br>")
			result = append(result, "<p>"+p+"</p>")
		}
	}
	return strings.Join(result, "\n")
}

// Internal function that handles epub generation with optional manual articles
func makeEpubWithManual(pageUrls []string, manualArticles []ManualArticle, title string, outputDir string) (string, error) {
	//TODO: Parallelize fetching pages

	//Get readable article from urls
	readableArticles := make([]readability.Article, 0)
	for _, pageUrl := range pageUrls {
		article, err := fetchReadable(pageUrl)
		if err != nil {
			util.Red.Printf("Couldn't convert %s because %s", pageUrl, err)
			util.Magenta.Println("SKIPPING ", pageUrl)
			continue
		}
		util.Green.Printf("Fetched %s --> %s\n", pageUrl, article.Title)
		readableArticles = append(readableArticles, article)
	}

	// Add manual articles (convert to readability.Article format)
	for _, manual := range manualArticles {
		// Format content (preserves HTML if present, otherwise converts plain text)
		content := formatManualContent(manual.Content)

		// Parse HTML to create a Node for image embedding
		doc, err := goquery.NewDocumentFromReader(strings.NewReader("<body>" + content + "</body>"))
		var node *html.Node
		if err == nil {
			node = doc.Find("body").Get(0)
		}

		article := readability.Article{
			Title:   manual.Title,
			Content: content,
			Node:    node,
		}
		util.Green.Printf("Added manual article: %s\n", manual.Title)
		readableArticles = append(readableArticles, article)
	}

	if len(readableArticles) == 0 {
		return "", errors.New("No readable url or manual article given, exiting without creating epub")
	}

	if len(title) == 0 {
		title = readableArticles[0].Title
		util.Magenta.Printf("No title supplied, inheriting title of first readable article : %s \n", title)
	}

	book := NewEpubmaker(title)

	//get images and embed them (only for articles with parsed HTML nodes)
	var wg sync.WaitGroup

	for i := 0; i < len(readableArticles); i++ {
		// Skip image embedding for manual articles (no parsed Node)
		if readableArticles[i].Node == nil {
			continue
		}
		wg.Add(1)
		go book.embedImages(&wg, &readableArticles[i])
	}

	wg.Wait()

	err := book.addContent(&readableArticles)
	if err != nil {
		return "", err
	}
	var storeDir string
	if len(outputDir) > 0 {
		storeDir = outputDir
	} else if config.GetInstance() != nil && len(config.GetInstance().StorePath) > 0 {
		storeDir = config.GetInstance().StorePath
	} else {
		storeDir, err = os.Getwd()
		if err != nil {
			util.Red.Println("Error getting current directory, trying fallback")
			storeDir = "./"
		}
	}

	titleSlug := slug.Make(title)
	var filename string
	if len(titleSlug) == 0 {
		filename = "kindle-send-doc-" + util.GetHash(readableArticles[0].Content) + ".epub"
	} else {
		filename = titleSlug + ".epub"
	}
	filepath := path.Join(storeDir, filename)
	err = book.Epub.Write(filepath)
	if err != nil {
		return "", err
	}
	return filepath, nil
}
