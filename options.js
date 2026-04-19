const KEY_STORAGE = 'geminiApiKey';

const input  = document.getElementById('apiKey');
const btn    = document.getElementById('save');
const status = document.getElementById('status');

function showStatus(msg, isError) {
  status.textContent = msg;
  status.className = isError ? 'err' : 'ok';
  setTimeout(() => { status.textContent = ''; status.className = ''; }, 3000);
}

// Load existing key on open (show masked placeholder if set)
chrome.storage.local.get(KEY_STORAGE, (data) => {
  if (data[KEY_STORAGE]) {
    input.placeholder = 'Key saved — paste a new one to replace it';
  }
});

btn.addEventListener('click', () => {
  const key = input.value.trim();
  if (!key) {
    showStatus('Paste your API key first.', true);
    return;
  }
  chrome.storage.local.set({ [KEY_STORAGE]: key }, () => {
    input.value = '';
    input.placeholder = 'Key saved — paste a new one to replace it';
    showStatus('API key saved.', false);
  });
});
