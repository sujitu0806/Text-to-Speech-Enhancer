/**
 * WhatsApp Web — real-time message capture (content script)
 *
 * Purpose: Observe the DOM for new chat rows, extract plain text and metadata,
 * keep an in-memory log, notify the background script to persist + download JSON,
 * and allow manual export for research.
 *
 * Limitations: WhatsApp may change markup without notice. This script prefers
 * structural selectors (role, copyable-text) over obfuscated class names.
 * If capture breaks after an update, adjust findMessageRows(), extractTextFromRow(),
 * and extractTimestamp() below.
 */

(function () {
  'use strict';

  // --- Storage: in-memory log + dedupe of DOM nodes we already recorded ---
  const collectedMessages = [];
  const processedRowNodes = new WeakSet();

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

  /**
   * Concatenate visible text from message body spans (WhatsApp nests formatting spans).
   */
  function extractTextFromRow(row) {
    const spans = row.querySelectorAll('span.copyable-text, span.selectable-text');
    if (!spans.length) return '';

    const parts = [];
    const seen = new Set();
    spans.forEach((span) => {
      const text = span.innerText != null ? span.innerText.trim() : '';
      if (!text) return;
      // Avoid duplicating when nested spans repeat the same string
      if (seen.has(text)) return;
      seen.add(text);
      parts.push(text);
    });

    // In group chats, first block is sometimes the sender name — still include full row text once
    if (parts.length === 0) return '';
    // Join with space; single bubble usually yields one logical string after de-dup
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
   * Try to read WhatsApp's message id from an ancestor (helps debugging; optional).
   */
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

  function scanElementForMessages(root) {
    findMessageRows(root).forEach(recordRowIfNew);
  }

  function scanAddedNode(node) {
    rowsFromAddedNode(node).forEach(recordRowIfNew);
  }

  /**
   * Scan the open conversation for rows already present (before observer attached).
   */
  function initialScan() {
    const panel =
      document.getElementById('main') ||
      document.querySelector('[data-testid*="conversation-panel"]') ||
      document.body;
    scanElementForMessages(panel);
  }

  // --- MutationObserver: new nodes → find message rows ---
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        scanAddedNode(/** @type {Element} */ (node));
      });
    }
  });

  const observeTarget = document.getElementById('app') || document.body;
  observer.observe(observeTarget, { childList: true, subtree: true });

  requestAnimationFrame(() => {
    initialScan();
  });

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

  // --- Keyboard: Ctrl+Shift+E (Windows/Linux) or Cmd+Shift+E (macOS) ---
  window.addEventListener(
    'keydown',
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        exportMessagesToJsonFile();
      }
    },
    true
  );

  // --- Minimal floating button ---
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
