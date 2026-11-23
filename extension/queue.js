(async () => {
  'use strict';

  const { api } = KindleQueue;

  const list = document.getElementById('items');
  const bookTitle = document.getElementById('book-title');
  const buildBtn = document.getElementById('build-btn');
  const removeAfter = document.getElementById('remove-after');
  const status = document.getElementById('status');
  const logEl = document.getElementById('log');

  function showStatus(kind, message) {
    status.className = 'status ' + kind;
    status.textContent = message;
  }

  function log(message) {
    logEl.textContent += message + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  const KIND_LABELS = { article: 'saved', url: 'link', manual: 'pasted' };

  function render(items) {
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'The queue is empty. Use the toolbar button on an article to save it.';
      list.append(li);
    }
    for (const item of items) {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'item-text';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.title || item.url;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = KIND_LABELS[item.kind] || item.kind;
      title.append(badge);
      text.append(title);
      if (item.url) {
        const url = document.createElement('div');
        url.className = 'item-url';
        url.textContent = item.url;
        text.append(url);
      }
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.title = 'Remove from queue';
      remove.setAttribute('aria-label', 'Remove ' + (item.title || item.url));
      remove.textContent = '✕';
      remove.addEventListener('click', () => KindleQueue.remove([item.id]));
      li.append(text, remove);
      list.append(li);
    }
    buildBtn.disabled = !items.length;
  }

  render(await KindleQueue.load());
  KindleQueue.onChange(render);

  async function fetchArticle(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
    const html = await response.text();
    const pageURL = response.url || url;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // A parsed document's base is this extension page; point it at the article so
    // Readability resolves relative links and images correctly.
    let base = doc.querySelector('base[href]');
    if (base) {
      base.setAttribute('href', new URL(base.getAttribute('href'), pageURL).href);
    } else {
      base = doc.createElement('base');
      base.setAttribute('href', pageURL);
      doc.head.prepend(base);
    }
    return KindleArticle.extract(doc, pageURL);
  }

  function slugify(text) {
    return (
      text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'kindle-articles'
    );
  }

  // Returns true if the file was saved, false if the user still has to click a link
  async function download(blob, filename, sizeText) {
    const objectURL = URL.createObjectURL(blob);
    if (api.downloads) {
      try {
        await api.downloads.download({ url: objectURL, filename, saveAs: false, conflictAction: 'uniquify' });
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
      }
      showStatus('ok', 'Saved ' + filename + ' (' + sizeText + ') to your Downloads folder.');
      return;
    }
    // Safari has no downloads API. A link the user clicks counts as their own action,
    // which Safari permits; a scripted click after the async build may be blocked.
    showStatus('ok', 'Your EPUB is ready (' + sizeText + '): ');
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = filename;
    link.textContent = 'Save ' + filename;
    status.append(link);
    window.addEventListener('pagehide', () => URL.revokeObjectURL(objectURL), { once: true });
  }

  buildBtn.addEventListener('click', async () => {
    // Must come first: Firefox only shows permission prompts during the click itself, and
    // treats manifest host permissions as optional until the user grants them.
    let granted = false;
    try {
      granted = await api.permissions.request({ origins: ['<all_urls>'] });
    } catch (e) {
      granted = await api.permissions.contains({ origins: ['<all_urls>'] });
    }
    if (!granted) {
      showStatus(
        'error',
        'Kindle Send needs access to websites to download articles and images. Click Build EPUB again and choose Allow. ' +
          'In Safari, set Kindle Send to "Allow" for other websites in Safari Settings → Extensions.'
      );
      return;
    }

    buildBtn.disabled = true;
    status.className = 'status';
    logEl.textContent = '';
    try {
      const items = await KindleQueue.load();
      const articles = [];
      const built = [];
      for (const item of items) {
        if (item.kind === 'url') {
          log('Downloading ' + item.url);
          try {
            articles.push(await fetchArticle(item.url));
            built.push(item.id);
          } catch (e) {
            log('  Skipped: ' + e.message);
          }
        } else {
          articles.push(item);
          built.push(item.id);
        }
      }
      if (!articles.length) throw new Error('Nothing could be downloaded');

      const date = new Date().toISOString().slice(0, 10);
      const title =
        bookTitle.value.trim() || (articles.length === 1 ? articles[0].title : 'Kindle articles ' + date);
      const blob = await KindleEpub.build(title, articles, { log });
      const filename = slugify(title) + '.epub';
      await download(blob, filename, (blob.size / 1024 / 1024).toFixed(1) + ' MB');
      if (removeAfter.checked) await KindleQueue.remove(built);
      bookTitle.value = '';
    } catch (e) {
      showStatus('error', e.message);
    } finally {
      buildBtn.disabled = !(await KindleQueue.load()).length;
    }
  });

  document.getElementById('add-links-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('links');
    const urls = textarea.value
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//.test(s));
    for (const url of urls) await KindleQueue.add({ kind: 'url', url, title: url });
    textarea.value = '';
  });

  // Plain text becomes paragraphs; anything that already looks like HTML is kept as-is
  function formatManualContent(content) {
    if (/<(p|div|img|br)[\s>/]/i.test(content)) return content;
    return content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const el = document.createElement('p');
        el.textContent = p;
        return el.outerHTML.replace(/\n/g, '<br>');
      })
      .join('\n');
  }

  document.getElementById('add-manual-btn').addEventListener('click', async () => {
    const title = document.getElementById('manual-title');
    const source = document.getElementById('manual-source');
    const content = document.getElementById('manual-content');
    if (!title.value.trim() || !content.value.trim()) {
      showStatus('error', 'A pasted article needs a title and content.');
      return;
    }
    await KindleQueue.add({
      kind: 'manual',
      title: title.value.trim(),
      url: source.value.trim(),
      byline: '',
      siteName: '',
      html: formatManualContent(content.value),
    });
    title.value = source.value = content.value = '';
    showStatus('ok', 'Article added to the queue.');
  });
})();
