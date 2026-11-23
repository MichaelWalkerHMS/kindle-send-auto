// Content extraction script - runs in the context of the page
(function() {
  'use strict';

  // Detect which site we're on
  const hostname = window.location.hostname;
  const isTwitter = hostname.includes('twitter.com') || hostname.includes('x.com');

  let result = { title: document.title, content: '', imageCount: 0 };

  if (isTwitter) {
    result = extractTwitter();
  } else {
    result = extractGeneric();
  }

  return result;

  // Twitter/X extraction
  function extractTwitter() {
    const content = [];
    let imageCount = 0;

    // Find all tweets on the page - try multiple selectors
    let tweets = document.querySelectorAll('[data-testid="tweet"]');

    if (tweets.length === 0) {
      // Try alternative selectors
      tweets = document.querySelectorAll('article[role="article"]');
    }

    if (tweets.length === 0) {
      // Fallback: try to find any article content
      return extractGeneric();
    }

    tweets.forEach((tweet, index) => {
      // Get author info - try multiple selectors
      let author = '';
      const authorEl = tweet.querySelector('[data-testid="User-Name"]');
      if (authorEl) {
        const displayName = authorEl.querySelector('span')?.textContent || '';
        const handle = authorEl.querySelector('a[href^="/"]')?.textContent || '';
        author = displayName + (handle ? ' ' + handle : '');
      }

      // Extract tweet content with images inline
      let tweetText = '';
      const tweetImages = [];

      // Walk through tweet and build content in order
      const contentParts = [];
      const seenImages = new Set();

      // Helper to process a node and extract content
      function processNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          if (text && !isMetadata(text)) {
            return escapeHtml(text);
          }
          return '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const el = node;
        const tagName = el.tagName.toLowerCase();

        // Skip certain elements entirely
        if (tagName === 'script' || tagName === 'style') return '';
        if (el.getAttribute('data-testid') === 'User-Name') return '';  // Skip author in content
        if (el.getAttribute('role') === 'button') return '';  // Skip buttons

        // Handle images
        if (tagName === 'img') {
          let src = el.src;
          // Media images
          if (src && src.includes('pbs.twimg.com/media')) {
            if (src.includes('name=')) {
              src = src.replace(/name=\w+/, 'name=large');
            } else if (!src.includes('?')) {
              src += '?format=jpg&name=large';
            }
            if (!seenImages.has(src)) {
              seenImages.add(src);
              tweetImages.push(src);
              imageCount++;
              return '<p><img src="' + escapeHtml(src) + '" style="max-width: 100%;"></p>';
            }
          }
          // Emoji images - use alt text
          else if (el.alt) {
            return el.alt;
          }
          return '';
        }

        // Recurse into children
        let childContent = '';
        for (const child of el.childNodes) {
          childContent += processNode(child);
        }

        // Wrap block elements
        if (tagName === 'p' || tagName === 'div') {
          if (childContent.trim()) {
            // Don't double-wrap if it's already wrapped or contains block elements
            if (childContent.includes('<p>') || childContent.includes('<img')) {
              return childContent;
            }
            return '<p>' + childContent + '</p>';
          }
        }

        return childContent;
      }

      // Helper to check if text is metadata
      function isMetadata(text) {
        if (text === 'Follow' || text === 'Following') return true;
        if (text.match(/^@\w+$/)) return true;
        if (text.match(/^\d+(\.\d+)?[KMB]?$/)) return true;
        if (text.match(/^(Reply|Repost|Like|Share|Bookmark|Views?)$/i)) return true;
        if (text.match(/^\d{1,2}:\d{2}\s*(AM|PM)?$/i)) return true;
        if (text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+/i)) return true;
        if (text === 'Show more' || text === 'Show less') return true;
        if (text === 'Translate post' || text === 'Translated from') return true;
        if (text === '·') return true;
        return false;
      }

      // Process the tweet
      tweetText = processNode(tweet);

      // Clean up empty paragraphs and excessive whitespace
      tweetText = tweetText.replace(/<p>\s*<\/p>/g, '');
      tweetText = tweetText.replace(/(<\/p>)\s*(<p>)/g, '$1\n$2');

      const images = tweetImages;

      // Get quoted tweet if present
      const quotedTweet = tweet.querySelector('[data-testid="quoteTweet"]');
      let quotedContent = '';
      if (quotedTweet) {
        const quotedText = quotedTweet.querySelector('[data-testid="tweetText"]');
        if (quotedText) {
          quotedContent = '<blockquote style="border-left: 3px solid #ccc; padding-left: 10px; margin: 10px 0;">' +
            quotedText.innerHTML + '</blockquote>';
        }
      }

      // Build tweet HTML
      if (tweetText || images.length > 0) {
        let tweetHtml = '';

        if (index > 0) {
          tweetHtml += '<hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">';
        }

        if (author) {
          tweetHtml += '<p style="color: #666; margin-bottom: 5px;"><strong>' + escapeHtml(author) + '</strong></p>';
        }

        if (tweetText) {
          tweetHtml += '<p>' + tweetText + '</p>';
        }

        if (quotedContent) {
          tweetHtml += quotedContent;
        }

        images.forEach(src => {
          tweetHtml += '<p><img src="' + escapeHtml(src) + '" style="max-width: 100%;"></p>';
        });

        content.push(tweetHtml);
      }
    });

    // Try to get a better title from the first tweet's author
    let title = document.title;
    const firstAuthor = document.querySelector('[data-testid="tweet"] [data-testid="User-Name"] span');
    if (firstAuthor) {
      title = firstAuthor.textContent + ' on X';
    }

    return {
      title: title,
      content: content.join('\n'),
      imageCount: imageCount
    };
  }

  // Generic extraction for other sites
  function extractGeneric() {
    let content = '';
    let imageCount = 0;

    // Try to find main content in order of preference
    const selectors = [
      'article',
      '[role="main"]',
      'main',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.content',
      '#content'
    ];

    let mainContent = null;
    for (const selector of selectors) {
      mainContent = document.querySelector(selector);
      if (mainContent) break;
    }

    // Fall back to body if no content container found
    if (!mainContent) {
      mainContent = document.body;
    }

    // Clone to avoid modifying the page
    const clone = mainContent.cloneNode(true);

    // Remove unwanted elements
    const removeSelectors = [
      'script', 'style', 'nav', 'header', 'footer', 'aside',
      '.comments', '#comments', '.sidebar', '.advertisement', '.ad',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'
    ];
    removeSelectors.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    // Process images - ensure they have absolute URLs
    clone.querySelectorAll('img').forEach(img => {
      let src = img.getAttribute('src');
      if (src) {
        // Convert relative URLs to absolute
        if (src.startsWith('//')) {
          src = 'https:' + src;
        } else if (src.startsWith('/')) {
          src = window.location.origin + src;
        } else if (!src.startsWith('http')) {
          src = new URL(src, window.location.href).href;
        }
        img.setAttribute('src', src);
        imageCount++;
      }

      // Remove srcset to avoid confusion
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
    });

    // Get the HTML content
    content = clone.innerHTML;

    // Clean up excessive whitespace
    content = content.replace(/\s+/g, ' ').trim();

    return {
      title: document.title,
      content: content,
      imageCount: imageCount
    };
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
