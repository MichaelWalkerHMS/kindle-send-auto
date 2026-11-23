(async () => {
  'use strict';

  const { api } = KindleQueue;
  const TWITTER_HOST = /(^|\.)(twitter|x)\.com$/;

  const pageTitle = document.getElementById('page-title');
  const saveBtn = document.getElementById('save-btn');
  const linkBtn = document.getElementById('link-btn');
  const queueBtn = document.getElementById('queue-btn');
  const count = document.getElementById('count');
  const status = document.getElementById('status');

  function showStatus(kind, message) {
    status.className = 'status ' + kind;
    status.textContent = message;
  }

  function showCount(n) {
    count.textContent = n === 1 ? '1 item queued' : n + ' items queued';
  }

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const isWebPage = /^https?:/.test(tab.url || '');
  pageTitle.textContent = tab.title || tab.url;
  showCount((await KindleQueue.load()).length);

  if (!isWebPage) {
    saveBtn.disabled = true;
    linkBtn.disabled = true;
    // Safari hides the tab's URL until the extension is allowed on that site
    showStatus(
      'error',
      tab.url
        ? 'Open a web article to save it.'
        : 'Kindle Send can\'t see this page yet. Allow it on this website (in Safari, Settings → Extensions → Kindle Send), then reopen this popup.'
    );
  }

  async function extractFromPage() {
    const target = { tabId: tab.id };
    if (TWITTER_HOST.test(new URL(tab.url).hostname)) {
      const [injection] = await api.scripting.executeScript({ target, files: ['twitter.js'] });
      const tweet = injection && injection.result;
      if (!tweet || !tweet.content) throw new Error('No posts found on this page');
      return { title: tweet.title, html: tweet.content, url: tab.url, byline: '', siteName: 'X' };
    }

    await api.scripting.executeScript({ target, files: ['lib/Readability.js', 'article.js'] });
    // Errors are returned rather than thrown: Chrome drops exceptions from injected functions
    const [injection] = await api.scripting.executeScript({
      target,
      func: () => {
        try {
          return KindleArticle.extract(document, location.href);
        } catch (e) {
          return { error: e.message };
        }
      },
    });
    const article = injection && injection.result;
    if (!article) throw new Error('Could not read this page');
    if (article.error) throw new Error(article.error);
    return article;
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const article = await extractFromPage();
      showCount(await KindleQueue.add({ kind: 'article', ...article }));
      showStatus('ok', 'Saved "' + article.title + '"');
      saveBtn.textContent = 'Saved';
    } catch (e) {
      showStatus('error', e.message + '. Try "Queue link only" instead.');
      saveBtn.textContent = 'Save article';
      saveBtn.disabled = false;
    }
  });

  linkBtn.addEventListener('click', async () => {
    linkBtn.disabled = true;
    showCount(await KindleQueue.add({ kind: 'url', url: tab.url, title: tab.title || tab.url }));
    showStatus('ok', 'Link queued');
  });

  queueBtn.addEventListener('click', async () => {
    await api.tabs.create({ url: api.runtime.getURL('queue.html') });
    window.close();
  });
})();
