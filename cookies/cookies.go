package cookies

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

// LoadNetscapeCookies reads a Netscape/Mozilla format cookies.txt file
// and returns an http.Client with those cookies loaded
func LoadNetscapeCookies(filepath string) (*http.Client, error) {
	jar, err := cookiejar.New(&cookiejar.Options{
		PublicSuffixList: publicsuffix.List,
	})
	if err != nil {
		return nil, err
	}

	file, err := os.Open(filepath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	// Group cookies by domain
	cookiesByDomain := make(map[string][]*http.Cookie)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()

		// Skip comments and empty lines
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}

		// Netscape format: domain, flag, path, secure, expiration, name, value
		fields := strings.Split(line, "\t")
		if len(fields) < 7 {
			continue
		}

		domain := fields[0]
		path := fields[2]
		secure := strings.ToUpper(fields[3]) == "TRUE"
		expiration, _ := strconv.ParseInt(fields[4], 10, 64)
		name := fields[5]
		value := fields[6]

		cookie := &http.Cookie{
			Name:     name,
			Value:    value,
			Path:     path,
			Domain:   domain,
			Secure:   secure,
			HttpOnly: true,
		}

		if expiration > 0 {
			cookie.Expires = time.Unix(expiration, 0)
		}

		// Determine the URL scheme
		scheme := "http"
		if secure {
			scheme = "https"
		}

		// Normalize domain for URL
		urlDomain := domain
		if strings.HasPrefix(urlDomain, ".") {
			urlDomain = urlDomain[1:]
		}

		urlKey := scheme + "://" + urlDomain
		cookiesByDomain[urlKey] = append(cookiesByDomain[urlKey], cookie)
	}

	// Set cookies for each domain
	for urlStr, cookies := range cookiesByDomain {
		u, err := url.Parse(urlStr)
		if err != nil {
			continue
		}
		jar.SetCookies(u, cookies)
	}

	client := &http.Client{
		Jar:     jar,
		Timeout: 30 * time.Second,
	}

	return client, nil
}

// CreateDefaultClient returns an http.Client without cookies
func CreateDefaultClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
	}
}

// LoadJSONCookies reads a simple JSON format cookies file
// Format: {"domain.com": {"cookie_name": "cookie_value"}}
func LoadJSONCookies(filepath string) (*http.Client, error) {
	jar, err := cookiejar.New(&cookiejar.Options{
		PublicSuffixList: publicsuffix.List,
	})
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(filepath)
	if err != nil {
		return nil, err
	}

	var cookieData map[string]map[string]string
	if err := json.Unmarshal(data, &cookieData); err != nil {
		return nil, err
	}

	for domain, cookies := range cookieData {
		var httpCookies []*http.Cookie
		for name, value := range cookies {
			httpCookies = append(httpCookies, &http.Cookie{
				Name:     name,
				Value:    value,
				Path:     "/",
				Domain:   "." + domain,
				Secure:   true,
				HttpOnly: true,
			})
		}

		u, err := url.Parse("https://" + domain)
		if err != nil {
			continue
		}
		jar.SetCookies(u, httpCookies)
	}

	client := &http.Client{
		Jar:     jar,
		Timeout: 30 * time.Second,
	}

	return client, nil
}

// LoadCookies auto-detects the format (JSON or Netscape) and loads cookies
func LoadCookies(filepath string) (*http.Client, error) {
	data, err := os.ReadFile(filepath)
	if err != nil {
		return nil, err
	}

	// Check if it's JSON by looking for opening brace
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "{") {
		return LoadJSONCookies(filepath)
	}

	return LoadNetscapeCookies(filepath)
}
