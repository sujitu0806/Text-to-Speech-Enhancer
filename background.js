/**
 * Service worker: persist captured messages and write the latest full JSON to disk
 * via chrome.downloads (fixed path, overwrite). Browsers do not allow true
 * append-to-file from extensions; overwriting one file per update is the standard approach.
 */

const STORAGE_KEY = 'waCollectedMessages';
const DOWNLOAD_RELATIVE_PATH = 'WhatsAppExtractor/whatsapp-messages.json';
const DEBOUNCE_MS = 300;

let downloadTimer = null;

function log(...args) {
  console.log('[WA Extractor background]', ...args);
}

async function readMessages() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function writeMessages(messages) {
  await chrome.storage.local.set({ [STORAGE_KEY]: messages });
}

/** Stable key so page reloads do not re-append the same visible messages. */
function messageKey(p) {
  if (p && p.messageId) return `id:${p.messageId}`;
  const t = p?.text ?? '';
  const ts = p?.timestamp ?? '';
  const d = p?.direction ?? '';
  return `h:${ts}|${d}|${t}`;
}

async function downloadJsonFile(messages) {
  const json = JSON.stringify(messages, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  try {
    await chrome.downloads.download({
      url,
      filename: DOWNLOAD_RELATIVE_PATH,
      conflictAction: 'overwrite',
      saveAs: false,
    });
    log('Saved', messages.length, 'message(s) to', DOWNLOAD_RELATIVE_PATH);
  } catch (e) {
    console.error('[WA Extractor background] download failed:', e);
  }
}

function scheduleDownloadFromStorage() {
  clearTimeout(downloadTimer);
  downloadTimer = setTimeout(async () => {
    downloadTimer = null;
    const messages = await readMessages();
    await downloadJsonFile(messages);
  }, DEBOUNCE_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'WA_MESSAGE' && msg.payload) {
    (async () => {
      const messages = await readMessages();
      const key = messageKey(msg.payload);
      const seen = new Set(messages.map(messageKey));
      if (seen.has(key)) {
        sendResponse({ ok: true, count: messages.length, duplicate: true });
        return;
      }
      messages.push(msg.payload);
      await writeMessages(messages);
      scheduleDownloadFromStorage();
      sendResponse({ ok: true, count: messages.length });
    })().catch((e) => {
      console.error('[WA Extractor background] WA_MESSAGE error:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg?.type === 'WA_EXPORT') {
    (async () => {
      const messages = await readMessages();
      await downloadJsonFile(messages);
      sendResponse({ ok: true, count: messages.length });
    })().catch((e) => {
      console.error('[WA Extractor background] WA_EXPORT error:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg?.type === 'WA_CLEAR_STORAGE') {
    (async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});
