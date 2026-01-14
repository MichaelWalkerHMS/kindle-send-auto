document.addEventListener('DOMContentLoaded', async () => {
  const urlDiv = document.getElementById('url');
  const addBtn = document.getElementById('add-btn');
  const extractBtn = document.getElementById('extract-btn');
  const titleInput = document.getElementById('title-input');
  const status = document.getElementById('status');

  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url;

  urlDiv.textContent = url;

  // Pre-fill title from page title
  titleInput.value = tab.title || '';

  function showStatus(type, message) {
    status.className = type;
    status.textContent = message;
  }

  // Add URL to pending (existing functionality)
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';

    try {
      const response = await fetch('http://localhost:8080/pending', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: url })
      });

      const result = await response.json();

      if (result.success) {
        showStatus('success', 'Added to pending!');
        addBtn.textContent = 'Added!';
      } else {
        showStatus('error', result.error || 'Failed to add');
        addBtn.textContent = 'Add URL to Pending';
        addBtn.disabled = false;
      }
    } catch (err) {
      if (err.message.includes('Failed to fetch')) {
        showStatus('error', 'Server not running. Start kindle-send-auto ui first.');
      } else {
        showStatus('error', 'Error: ' + err.message);
      }
      addBtn.textContent = 'Add URL to Pending';
      addBtn.disabled = false;
    }
  });

  // Extract page content
  extractBtn.addEventListener('click', async () => {
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting...';

    try {
      // Inject content script to extract page content
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      if (!results || results.length === 0 || !results[0].result) {
        throw new Error('Failed to extract content from page');
      }

      const extracted = results[0].result;

      if (!extracted.content || extracted.content.trim().length === 0) {
        throw new Error('No content found on page');
      }

      // Use custom title if provided, otherwise use extracted title
      const title = titleInput.value.trim() || extracted.title || 'Untitled';

      // Send to manual article endpoint
      const response = await fetch('http://localhost:8080/manual', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: title,
          content: extracted.content,
          source: url
        })
      });

      const result = await response.json();

      if (result.success) {
        showStatus('success', `Extracted! (${extracted.imageCount || 0} images)`);
        extractBtn.textContent = 'Extracted!';
      } else {
        showStatus('error', result.error || 'Failed to save');
        extractBtn.textContent = 'Extract Page Content';
        extractBtn.disabled = false;
      }
    } catch (err) {
      if (err.message.includes('Failed to fetch')) {
        showStatus('error', 'Server not running. Start kindle-send-auto ui first.');
      } else {
        showStatus('error', err.message);
      }
      extractBtn.textContent = 'Extract Page Content';
      extractBtn.disabled = false;
    }
  });
});
