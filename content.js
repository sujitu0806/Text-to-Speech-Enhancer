/**
 * WhatsApp Web — real-time message capture (content script)
 *
 * Purpose: Observe the DOM for new chat rows, extract plain text and metadata,
 * keep an in-memory log for the current chat session, notify the background to persist
 * (no auto-download), and download JSON only when you click Export.
 *
 * Limitations: WhatsApp may change markup without notice. This script prefers
 * structural selectors (role, copyable-text) over obfuscated class names.
 * If capture breaks after an update, adjust findMessageRows(), extractTextFromRow(),
 * and extractTimestamp() below.
 */

(function () {
  'use strict';

  // --- Storage: current chat session only + dedupe of DOM rows already handled ---
  const collectedMessages = [];
  let processedRowNodes = new WeakSet();

  /** While the open chat’s history is still mounting, mark rows as seen without recording. */
  let ignoreMutationsUntil = 0;
  const POST_CHAT_SWITCH_MUTE_MS = 450;

  let lastChatFingerprint;

  /** Wall-clock moment when this chat session started (used to drop older thread messages). */
  let sessionStartMs = 0;
  /** Allow WhatsApp display time vs detection delay (ms). */
  const SESSION_START_SLACK_MS = 8000;

  /** Verbose logs for development (timestamps, full payload). */
  const DEBUG = false;

  /** Log one line per captured message — easy to verify in DevTools Console. */
  const LOG_EACH_CAPTURE = true;

  function dbg(...args) {
    if (DEBUG) console.log('[WA Extractor]', ...args);
  }

  function notifyBackground(payload) {
    try {
      chrome.runtime.sendMessage({ type: 'WA_MESSAGE', payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (!err.message?.includes('Extension context invalidated')) {
            console.warn('[WA Extractor] background unreachable:', err.message);
          }
          return;
        }
        if (res && !res.ok) console.warn('[WA Extractor] background error:', res);
      });
    } catch (e) {
      if (!String(e).includes('Extension context invalidated')) {
        console.warn('[WA Extractor] notifyBackground failed:', e);
      }
    }
  }

  function notifySessionReset() {
    try {
      chrome.runtime.sendMessage({ type: 'WA_SESSION_RESET' }, () => {
        const err = chrome.runtime.lastError;
        if (err && !err.message?.includes('Extension ----context invalidated')) {
          console.warn('[WA Extractor] session reset failed:', err.message);
        }
      });
    } catch (e) {
      if (!String(e).includes('Extension context invalidated')) {
        console.warn('[WA Extractor] notifySessionReset failed:', e);
      }
    }
  }

  /**
   * Best-effort id for the open conversation (sidebar selection or header title).
   */
  function getChatFingerprint() {
    const sel = document.querySelector('#pane-side [aria-selected="true"][data-id]');
    if (sel) return sel.getAttribute('data-id') || '';
    const main = document.getElementById('main');
    if (!main) return '';
    const header = main.querySelector('[data-testid="conversation-info-header"]');
    const titleSpan = header?.querySelector('span[dir="auto"]');
    const t = titleSpan?.textContent?.trim();
    if (t) return `title:${t}`;
    return '';
  }

  function markAllExistingMessageRowsSeen() {
    const panel =
      document.getElementById('main') ||
      document.querySelector('[data-testid*="conversation-panel"]') ||
      document.body;
    findMessageRows(panel).forEach((row) => processedRowNodes.add(row));
  }

  function resetChatSession() {
    sessionStartMs = Date.now();
    collectedMessages.length = 0;
    processedRowNodes = new WeakSet();
    ignoreMutationsUntil = Date.now() + POST_CHAT_SWITCH_MUTE_MS;
    dbg('Chat session reset');
    notifySessionReset();
    // Catch history that paints across several frames (without recording it as new traffic).
    requestAnimationFrame(() => markAllExistingMessageRowsSeen());
    [300, 600, 1200].forEach((ms) => setTimeout(() => markAllExistingMessageRowsSeen(), ms));
  }

  function pollChatChange() {
    const fp = getChatFingerprint();
    if (fp === lastChatFingerprint) return;
    lastChatFingerprint = fp;
    resetChatSession();
  }

  function requestBackgroundExport() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'WA_EXPORT' }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (err.message?.includes('Extension context invalidated')) {
              resolve({ ok: false, invalidated: true, error: err.message });
              return;
            }
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(res || { ok: false });
        });
      } catch (e) {
        const error = String(e);
        if (error.includes('Extension context invalidated')) {
          resolve({ ok: false, invalidated: true, error });
          return;
        }
        resolve({ ok: false, error });
      }
    });
  }

  /** Spans that are not nested inside another copyable/selectable span (avoids double-walking). */
  function topLevelSelectableSpans(row) {
    const spans = Array.from(row.querySelectorAll('span.copyable-text, span.selectable-text'));
    return spans.filter((s) => !spans.some((o) => o !== s && o.contains(s)));
  }

  /**
   * Depth-first text in DOM order: preserves Unicode emoji in text nodes and inserts
   * `img` alt / title / aria-label (WhatsApp often renders emoji as inline images).
   */
  function collectTextFromNode(node, out) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (node);
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    if (el.getAttribute('aria-hidden') === 'true') return;

    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt') || '';
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      const piece = alt || title || aria;
      if (piece) out.push(piece);
      return;
    }

    const plain = el.getAttribute('data-plain-text');
    if (plain != null && plain !== '' && el.childNodes.length === 0) {
      out.push(plain);
      return;
    }

    for (let i = 0; i < el.childNodes.length; i++) {
      collectTextFromNode(el.childNodes[i], out);
    }
  }

  /**
   * Concatenate message text from body spans (DOM order; emoji as characters and/or img alt).
   */
  function extractTextFromRow(row) {
    const spans = topLevelSelectableSpans(row);
    if (!spans.length) return '';

    const parts = [];
    const seen = new Set();
    spans.forEach((span) => {
      const pieces = [];
      collectTextFromNode(span, pieces);
      const text = pieces.join('').replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (seen.has(text)) return;
      seen.add(text);
      parts.push(text);
    });

    if (parts.length === 0) return '';
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function extractSenderFromPrePlainText(row) {
    const pre = row.querySelector('[data-pre-plain-text]');
    const raw = pre?.getAttribute('data-pre-plain-text');
    if (!raw) return null;
    // Common shape: "[1:21 AM, 4/15/2026] Name: "
    const match = raw.match(/^\[[^\]]+\]\s*([^:]+):\s*$/);
    if (!match) return null;
    const name = match[1]?.trim();
    return name || null;
  }

  /**
   * Sender priority:
   * 1) Parse from data-pre-plain-text "[time] Name: " (most stable when available)
   * 2) Fallback to first short selectable/copyable span (group chat rows)
   */
  function extractSenderLabel(row, mainCombinedText) {
    const fromPre = extractSenderFromPrePlainText(row);
    if (fromPre) return fromPre;

    const spans = row.querySelectorAll('span.copyable-text, span.selectable-text');
    if (spans.length < 2) return null;

    const first = spans[0].innerText?.trim() || '';
    if (!first || first === mainCombinedText) return null;
    if (first.length > 120) return null;
    return first;
  }

  /**
   * Parse WhatsApp’s local time into epoch ms (best-effort). Returns null if unknown.
   * Used to ignore history/scroll-loaded bubbles that mount after you open the chat.
   */
  function parseFlexibleLocalTimeMs(s) {
    if (!s || typeof s !== 'string') return null;
    const trimmed = s.trim();
    const direct = Date.parse(trimmed);
    if (!Number.isNaN(direct)) return direct;

    // Time only (sometimes today): "1:21 AM"
    const timeOnly = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)$/i);
    if (timeOnly) {
      const d = new Date();
      const combined = Date.parse(`${d.toDateString()} ${timeOnly[1]}`);
      if (!Number.isNaN(combined)) return combined;
    }

    // Common bracket: "1:21 AM, 4/15/2026"
    const m = trimmed.match(
      /^(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/i
    );
    if (m) {
      const d = new Date(`${m[2]}/${m[3]}/${m[4]} ${m[1]}`);
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    // "4/15/2026, 1:21 AM"
    const m2 = trimmed.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)$/i
    );
    if (m2) {
      const d = new Date(`${m2[1]}/${m2[2]}/${m2[3]} ${m2[4]}`);
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    return null;
  }

  function parseMessageTimeMs(row) {
    const pre = row.querySelector('[data-pre-plain-text]');
    const raw = pre?.getAttribute('data-pre-plain-text');
    if (raw) {
      const bracket = raw.match(/^\[([^\]]+)\]/);
      if (bracket) {
        const inner = bracket[1].trim();
        const t = parseFlexibleLocalTimeMs(inner);
        if (t !== null) return t;
      }
    }

    const meta = row.querySelector('[data-testid*="msg-meta"], [data-testid*="Meta"]');
    const title = meta?.getAttribute('title');
    if (title?.trim()) {
      const t = parseFlexibleLocalTimeMs(title.trim());
      if (t !== null) return t;
    }

    const titled = row.querySelector('span[title]');
    const tAttr = titled?.getAttribute('title');
    if (tAttr?.trim()) {
      const t = parseFlexibleLocalTimeMs(tAttr.trim());
      if (t !== null) return t;
    }

    return null;
  }

  /** WhatsApp message id from row or ancestor (optional, for dedupe / debug). */
  function findMessageDataId(row) {
    let el = row;
    for (let i = 0; i < 8 && el; i++) {
      const id = el.getAttribute?.('data-id');
      if (id) return id;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Timestamp from meta region, title attribute, or data-pre-plain-text; else capture time.
   */
  function extractTimestamp(row) {
    const meta = row.querySelector('[data-testid*="msg-meta"], [data-testid*="Meta"]');
    if (meta) {
      const title = meta.getAttribute('title');
      if (title && title.trim()) return title.trim();
      const txt = meta.textContent?.trim();
      if (txt) return txt;
    }

    const titled = row.querySelector('span[title]');
    const tAttr = titled?.getAttribute('title');
    if (tAttr && /\d{1,2}[.:]\d{2}/.test(tAttr)) return tAttr.trim();

    const pre = row.querySelector('[data-pre-plain-text]');
    const raw = pre?.getAttribute('data-pre-plain-text');
    if (raw) {
      const bracket = raw.match(/^\[([^\]]+)\]/);
      if (bracket) return bracket[1].trim();
    }

    return new Date().toISOString();
  }

  /**
   * Infer incoming vs outgoing from horizontal position relative to the main pane center.
   */
  function inferDirection(row) {
    const main = document.getElementById('main');
    if (!main) return 'unknown';

    const textEl = row.querySelector('span.copyable-text, span.selectable-text');
    if (!textEl) return 'unknown';

    // Walk up a few levels to approximate the bubble container
    let bubble = textEl;
    for (let i = 0; i < 5 && bubble.parentElement; i++) {
      bubble = bubble.parentElement;
    }

    const bubbleRect = bubble.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const centerX = mainRect.left + mainRect.width / 2;
    const bubbleCenterX = bubbleRect.left + bubbleRect.width / 2;

    const margin = 24;
    if (bubbleCenterX > centerX + margin) return 'outgoing';
    if (bubbleCenterX < centerX - margin) return 'incoming';
    return bubbleCenterX >= centerX ? 'outgoing' : 'incoming';
  }

  /**
   * Collect candidate message rows inside a root (added subtree or full panel).
   */
  function findMessageRows(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return [];

    const el = /** @type {Element} */ (root);
    const rows = new Set();

    if (el.matches?.('div[role="row"]')) rows.add(el);
    el.querySelectorAll?.('div[role="row"]').forEach((r) => rows.add(r));

    return Array.from(rows);
  }

  /**
   * WhatsApp sometimes inserts inner nodes (e.g. text spans) without re-adding the row.
   * Resolve `div[role="row"]` from the added subtree or from an ancestor of the node.
   */
  function rowsFromAddedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return [];
    const direct = findMessageRows(/** @type {Element} */ (node));
    if (direct.length) return direct;
    const closest = /** @type {Element} */ (node).closest?.('div[role="row"]');
    return closest ? [closest] : [];
  }

  function recordRowIfNew(row) {
    if (processedRowNodes.has(row)) return;

    const text = extractTextFromRow(row);
    if (!text) return;

    if (!sessionStartMs) return;

    const messageTimeMs = parseMessageTimeMs(row);
    if (messageTimeMs === null) {
      processedRowNodes.add(row);
      dbg('Skip row: could not parse message time (strict session filter)');
      return;
    }
    if (messageTimeMs < sessionStartMs - SESSION_START_SLACK_MS) {
      processedRowNodes.add(row);
      dbg('Skip row: message time before session start', { messageTimeMs, sessionStartMs });
      return;
    }

    processedRowNodes.add(row);

    const senderLabel = extractSenderLabel(row, text);
    const payload = {
      text,
      timestamp: extractTimestamp(row),
      direction: inferDirection(row),
      senderLabel,
    };

    const dataId = findMessageDataId(row);
    if (dataId) payload.messageId = dataId;

    collectedMessages.push(payload);
    if (LOG_EACH_CAPTURE) {
      console.log('[WA Extractor] captured:', payload.text?.slice(0, 120), payload);
    }
    dbg('Captured:', payload);
    notifyBackground(payload);
  }

  function markRowsSeenOnlyFromNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    rowsFromAddedNode(/** @type {Element} */ (node)).forEach((row) => processedRowNodes.add(row));
    findMessageRows(/** @type {Element} */ (node)).forEach((row) => processedRowNodes.add(row));
  }

  function scanAddedNode(node) {
    rowsFromAddedNode(node).forEach(recordRowIfNew);
  }

  // --- MutationObserver: only *new* rows after chat is open (no initial history scan) ---
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (Date.now() < ignoreMutationsUntil) {
          markRowsSeenOnlyFromNode(/** @type {Element} */ (node));
          return;
        }
        scanAddedNode(/** @type {Element} */ (node));
      });
    }
  });

  const observeTarget = document.getElementById('app') || document.body;
  observer.observe(observeTarget, { childList: true, subtree: true });

  setInterval(pollChatChange, 400);
  requestAnimationFrame(() => pollChatChange());

  // --- Export: ask background to download (same file as live updates) or fall back to page download ---
  async function exportMessagesToJsonFile() {
    const bg = await requestBackgroundExport();
    if (bg && bg.ok) {
      dbg('Exported via background', bg.count, 'messages');
      return;
    }
    const json = JSON.stringify(collectedMessages, null, 2);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    a.download = `whatsapp-messages-${stamp}.json`;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    if (!bg?.invalidated) {
      console.warn('[WA Extractor] background export failed; saved page copy:', bg?.error || 'unknown');
    }
    dbg('Exported (fallback)', collectedMessages.length, 'messages');
  }

  // Expose for DevTools debugging
  window.__WA_EXPORT_MESSAGES__ = exportMessagesToJsonFile;
  window.__WA_COLLECTED_MESSAGES__ = collectedMessages;

  // --- Minimal floating button (only way to trigger download) ---
  function injectExportButton() {
    if (document.getElementById('wa-extractor-export-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'wa-extractor-export-btn';
    btn.type = 'button';
    btn.textContent = 'Export JSON';
    btn.setAttribute('aria-label', 'Export captured WhatsApp messages as JSON');
    btn.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'right:16px',
      'z-index:2147483646',
      'padding:8px 12px',
      'font:14px sans-serif',
      'cursor:pointer',
      'background:#128c7e',
      'color:#fff',
      'border:none',
      'border-radius:6px',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)',
    ].join(';');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMessagesToJsonFile();
    });

    document.documentElement.appendChild(btn);
  }

  injectExportButton();
})();
