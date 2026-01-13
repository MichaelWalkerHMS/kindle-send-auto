document.addEventListener('DOMContentLoaded', async () => {
  const urlDiv = document.getElementById('url');
  const addBtn = document.getElementById('add-btn');
  const status = document.getElementById('status');

  // Get current tab URL
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab.url;

  urlDiv.textContent = url;

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
        status.className = 'success';
        status.textContent = 'Added to pending!';
        addBtn.textContent = 'Added!';
      } else {
        status.className = 'error';
        status.textContent = result.error || 'Failed to add';
        addBtn.textContent = 'Add to Pending';
        addBtn.disabled = false;
      }
    } catch (err) {
      status.className = 'error';
      if (err.message.includes('Failed to fetch')) {
        status.textContent = 'Server not running. Start kindle-send-auto ui first.';
      } else {
        status.textContent = 'Error: ' + err.message;
      }
      addBtn.textContent = 'Add to Pending';
      addBtn.disabled = false;
    }
  });
});
