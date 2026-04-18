/**
 * Service worker: persist messages for the current chat session in chrome.storage.local.
 * JSON is written to disk only when the user triggers WA_EXPORT (Export button).
 */

const STORAGE_KEY = 'waCollectedMessages';
/**
 * Fallback when the local relay is not running: path under Chrome’s download directory only.
 */
const DOWNLOAD_RELATIVE_PATH = 'Text-to-Speech-Enhancer/Scraping Tests/whatsapp-messages.json';

/** If `node scripts/whatsapp-export-relay.mjs` is running, exports go to the repo’s Scraping Tests folder. */
const LOCAL_EXPORT_RELAY_URL = 'http://127.0.0.1:17395/';

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

async function tryWriteViaLocalRelay(json) {
  try {
    const res = await fetch(LOCAL_EXPORT_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: json,
    });
    return res.ok;
  } catch {
    return false;
  }
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
    log('Saved', messages.length, 'message(s) under download dir →', DOWNLOAD_RELATIVE_PATH);
  } catch (e) {
    console.error('[WA Extractor background] download failed:', e);
  }
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
      const json = JSON.stringify(messages, null, 2);
      if (await tryWriteViaLocalRelay(json)) {
        log('Saved', messages.length, 'message(s) via local relay → repo Scraping Tests/whatsapp-messages.json');
      } else {
        await downloadJsonFile(messages);
      }
      sendResponse({ ok: true, count: messages.length });
    })().catch((e) => {
      console.error('[WA Extractor background] WA_EXPORT error:', e);
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (msg?.type === 'WA_CLEAR_STORAGE' || msg?.type === 'WA_SESSION_RESET') {
    (async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      sendResponse({ ok: true });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  return false;
});
