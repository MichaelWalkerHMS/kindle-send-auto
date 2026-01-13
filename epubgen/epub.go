package epubgen

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/bmaupin/go-epub"
	"github.com/go-shiori/go-readability"
	"github.com/gosimple/slug"
	"github.com/nikhil1raghav/kindle-send/config"
	"github.com/nikhil1raghav/kindle-send/util"
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

	return readability.FromReader(resp.Body, parsedURL)
}

// Point remote image link to downloaded image
func (e *epubmaker) changeRefs(i int, img *goquery.Selection) {
	img.RemoveAttr("loading")
	img.RemoveAttr("srcset")
	imgSrc, exists := img.Attr("src")
	if exists {
		if _, ok := e.downloads[imgSrc]; ok {
			util.Green.Printf("Setting img src from %s to %s \n", imgSrc, e.downloads[imgSrc])
			img.SetAttr("src", e.downloads[imgSrc])
		}
	}
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
		imageFileName := util.GetHash(imgSrc)

		imgRef, err := e.Epub.AddImage(imgSrc, imageFileName)
		if err != nil {
			util.Red.Printf("Couldn't add image %s : %s\n", imgSrc, err)
			return
		} else {
			util.Green.Printf("Downloaded image %s\n", imgSrc)
			e.downloads[imgSrc] = imgRef
		}
	}
}

// Fetches images in article and then embeds them into epub
func (e *epubmaker) embedImages(wg *sync.WaitGroup, article *readability.Article) {
	util.Cyan.Println("Embedding images in ", article.Title)
	defer wg.Done()
	//TODO: Compress images before embedding to improve size
	doc := goquery.NewDocumentFromNode(article.Node)

	//download all images
	doc.Find("img").Each(e.downloadImages)

	//Change all refs, doing it in two phases to download repeated images only once
	doc.Find("img").Each(e.changeRefs)

	content, err := doc.Html()

	if err != nil {
		util.Red.Printf("Error converting modified %s to HTML, it will be transferred without images : %s \n", article.Title, err)
	} else {
		article.Content = content
	}
}

// TODO: Look for better formatting, this is bare bones
func prepare(article *readability.Article) string {
	return "<h1>" + article.Title + "</h1>" + article.Content
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

// Generates a single epub from a slice of urls, saves to specified directory, returns file path
func MakeToDir(pageUrls []string, title string, outputDir string) (string, error) {
	return makeEpub(pageUrls, title, outputDir)
}

// Generates a single epub from a slice of urls, returns file path
func Make(pageUrls []string, title string) (string, error) {
	return makeEpub(pageUrls, title, "")
}

// Internal function that handles epub generation
func makeEpub(pageUrls []string, title string, outputDir string) (string, error) {
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

	if len(readableArticles) == 0 {
		return "", errors.New("No readable url given, exiting without creating epub")
	}

	if len(title) == 0 {
		title = readableArticles[0].Title
		util.Magenta.Printf("No title supplied, inheriting title of first readable article : %s \n", title)
	}

	book := NewEpubmaker(title)

	//get images and embed them
	var wg sync.WaitGroup

	for i := 0; i < len(readableArticles); i++ {
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
