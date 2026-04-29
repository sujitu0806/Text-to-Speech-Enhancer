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
  let liveAudioEl = null;
  let liveReadoutQueue = [];
  let isLiveReadoutRunning = false;
  let recentQueuedLiveKeys = new Map();
  let queuedOrSpokenLiveKeys = new Set();
  let insightPanelEls = null;
  let insightPanelVisible = true;

  /** While the open chat’s history is still mounting, mark rows as seen without recording. */
  let ignoreMutationsUntil = 0;
  const POST_CHAT_SWITCH_MUTE_MS = 450;

  let lastChatFingerprint;
  let lastStableChatFingerprint = null;

  /** Wall-clock moment when this chat session started (used to drop older thread messages). */
  let sessionStartMs = 0;
  /** Allow WhatsApp display time vs detection delay (ms). */
  // WhatsApp visible times are often minute-precision; use wider grace to avoid
  // dropping freshly-sent messages at minute boundaries right after session start.
  const SESSION_START_SLACK_MS = 90000;

  /** Verbose logs for development (timestamps, full payload). */
  const DEBUG = false;

  /** Log one line per captured message — easy to verify in DevTools Console. */
  const LOG_EACH_CAPTURE = false;

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

  function liveMessageKey(payload) {
    if (payload?.messageId) return `id:${payload.messageId}`;
    return `h:${payload?.timestamp || ''}|${payload?.direction || ''}|${payload?.text || ''}`;
  }

  function formatConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'N/A';
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    return `${clamped}%`;
  }

  function updateInsightPanel(message) {
    if (!insightPanelEls) return;
    insightPanelEls.originalValue.textContent = (message?.text || '').trim() || '(empty)';
    insightPanelEls.convertedValue.textContent = (message?.expanded_text || message?.text || '').trim() || '(empty)';
    insightPanelEls.toneValue.textContent = String(message?.tone || 'unknown');
    insightPanelEls.reasoningValue.textContent = (message?.tone_reasoning || '').trim() || '-';
    insightPanelEls.confidenceValue.textContent = formatConfidence(message?.confidence);
  }

  function resetInsightPanelMessage() {
    if (!insightPanelEls) return;
    insightPanelEls.originalValue.textContent = '-';
    insightPanelEls.convertedValue.textContent = '-';
    insightPanelEls.toneValue.textContent = '-';
    insightPanelEls.reasoningValue.textContent = '-';
    insightPanelEls.confidenceValue.textContent = '-';
  }

  function setInsightPanelVisible(visible) {
    insightPanelVisible = !!visible;
    if (!insightPanelEls) return;
    const hasActiveChat = Boolean(getChatFingerprint());
    insightPanelEls.container.style.display = insightPanelVisible && hasActiveChat ? 'block' : 'none';
    insightPanelEls.showBtn.style.display = !insightPanelVisible && hasActiveChat ? 'block' : 'none';
  }

  function positionInsightPanel() {
    if (!insightPanelEls) return;
    const main = document.getElementById('main');
    if (!main) return;
    const mainRect = main.getBoundingClientRect();
    const header =
      main.querySelector('[data-testid="conversation-info-header"]') || main.querySelector('header');
    if (!header) return;
    const rect = header.getBoundingClientRect();
    const top = Math.round(rect.bottom + 8);
    const left = Math.round(mainRect.left + 6);
    insightPanelEls.container.style.top = `${top}px`;
    insightPanelEls.container.style.left = `${left}px`;
    insightPanelEls.showBtn.style.top = `${top}px`;
    insightPanelEls.showBtn.style.left = `${left}px`;
  }

  function requestLiveIncomingAudio(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'WA_LIVE_INCOMING', payload }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(res || { ok: false, error: 'No response from live incoming pipeline' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
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
    liveReadoutQueue = [];
    isLiveReadoutRunning = false;
    queuedOrSpokenLiveKeys = new Set();
    if (liveAudioEl) {
      try {
        liveAudioEl.pause();
        liveAudioEl.src = '';
      } catch {}
      liveAudioEl = null;
    }
    resetInsightPanelMessage();
    dbg('Chat session reset');
    notifySessionReset();
    // Catch history that paints across several frames (without recording it as new traffic).
    requestAnimationFrame(() => markAllExistingMessageRowsSeen());
    [300, 600, 1200].forEach((ms) => setTimeout(() => markAllExistingMessageRowsSeen(), ms));
  }

  function pollChatChange() {
    const fp = getChatFingerprint();
    if (!fp) return;
    if (fp === lastStableChatFingerprint) return;
    lastStableChatFingerprint = fp;
    lastChatFingerprint = fp;
    resetChatSession();
    positionInsightPanel();
    setInsightPanelVisible(insightPanelVisible);
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

  function requestTtsAudio(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'WA_TTS_GENERATE', payload: message }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(res || { ok: false, error: 'No response from background TTS' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function playAudioBase64(audioBase64, mimeType) {
    return new Promise((resolve, reject) => {
      try {
        const src = `data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`;
        const audio = new Audio(src);
        audio.addEventListener('ended', () => {
          resolve();
        });
        audio.addEventListener('error', () => {
          reject(new Error('Audio playback failed'));
        });
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch((e) => reject(e));
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  function playLiveAudioBase64(audioBase64, mimeType) {
    return new Promise((resolve, reject) => {
      try {
        if (liveAudioEl) {
          try {
            liveAudioEl.pause();
            liveAudioEl.src = '';
          } catch {}
          liveAudioEl = null;
        }
        const src = `data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`;
        const audio = new Audio(src);
        liveAudioEl = audio;
        audio.addEventListener('ended', () => {
          if (liveAudioEl === audio) liveAudioEl = null;
          resolve();
        });
        audio.addEventListener('error', () => {
          if (liveAudioEl === audio) liveAudioEl = null;
          reject(new Error('Live audio playback failed'));
        });
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch((e) => reject(e));
      } catch (e) {
        reject(e);
      }
    });
  }

  async function processLiveReadoutQueue() {
    if (isLiveReadoutRunning) return;
    isLiveReadoutRunning = true;
    while (liveReadoutQueue.length > 0) {
      const payload = liveReadoutQueue.shift();
      const live = await requestLiveIncomingAudio(payload);
      if (!live?.ok || !live.audioBase64) {
        queuedOrSpokenLiveKeys.delete(liveMessageKey(payload));
        console.warn('[WA Extractor] live incoming readout skipped:', live?.error || 'unknown');
        continue;
      }
      updateInsightPanel({
        ...payload,
        expanded_text: live.spokenText || payload?.expanded_text || payload?.text || '',
        confidence: live.confidence,
        tone: live.tone || payload?.tone || 'unknown',
        tone_reasoning: live.tone_reasoning || payload?.tone_reasoning || '',
      });
      try {
        await playLiveAudioBase64(live.audioBase64, live.mimeType);
      } catch (e) {
        console.warn('[WA Extractor] live audio playback error:', e);
      }
    }
    isLiveReadoutRunning = false;
  }

  function triggerIncomingReadout(payload) {
    const key = liveMessageKey(payload);
    if (queuedOrSpokenLiveKeys.has(key)) {
      return;
    }
    const now = Date.now();
    const lastQueuedAt = recentQueuedLiveKeys.get(key) || 0;
    // Ignore near-immediate duplicate DOM re-renders of the same message row.
    if (now - lastQueuedAt < 1500) {
      return;
    }
    recentQueuedLiveKeys.set(key, now);
    queuedOrSpokenLiveKeys.add(key);
    liveReadoutQueue.push(payload);
    processLiveReadoutQueue().catch((e) => {
      console.warn('[WA Extractor] live readout queue error:', e);
      isLiveReadoutRunning = false;
    });
  }

  async function playAllMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const message of messages) {
      try {
        const tts = await requestTtsAudio(message);
        if (!tts?.ok || !tts.audioBase64) {
          console.warn('[WA Extractor] TTS skipped for message:', tts?.error || 'unknown');
          continue;
        }
        updateInsightPanel({
          ...message,
          expanded_text: tts.spokenText || message?.expanded_text || message?.text || '',
          confidence: tts?.confidence ?? message?.confidence,
          tone_reasoning: tts?.tone_reasoning || message?.tone_reasoning || '',
        });
        await playAudioBase64(tts.audioBase64, tts.mimeType);
      } catch (e) {
        console.warn('[WA Extractor] TTS playback error:', e);
      }
    }
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

  function normalizeTimestampLabel(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text
      .replace(/msg-(?:time|dblcheck)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
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
      if (title && title.trim()) return normalizeTimestampLabel(title);
      const txt = normalizeTimestampLabel(meta.textContent);
      if (txt) return txt;
    }

    const titled = row.querySelector('span[title]');
    const tAttr = titled?.getAttribute('title');
    if (tAttr && /\d{1,2}[.:]\d{2}/.test(tAttr)) return normalizeTimestampLabel(tAttr);

    const pre = row.querySelector('[data-pre-plain-text]');
    const raw = pre?.getAttribute('data-pre-plain-text');
    if (raw) {
      const bracket = raw.match(/^\[([^\]]+)\]/);
      if (bracket) return normalizeTimestampLabel(bracket[1]);
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
    triggerIncomingReadout(payload);
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
      await playAllMessages(Array.isArray(bg.messages) ? bg.messages : collectedMessages);
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
    await playAllMessages(collectedMessages);
  }

  // Expose for DevTools debugging
  window.__WA_EXPORT_MESSAGES__ = exportMessagesToJsonFile;
  window.__WA_COLLECTED_MESSAGES__ = collectedMessages;

  function injectInsightPanel() {
    if (document.getElementById('wa-extractor-insight-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'wa-extractor-insight-panel';
    panel.style.cssText = [
      'position:fixed',
      'top:120px',
      'left:360px',
      'z-index:2147483646',
      'width:280px',
      'padding:10px',
      'font:12px/1.35 sans-serif',
      'background:rgba(15,23,42,0.82)',
      'color:#e5e7eb',
      'border:1px solid rgba(148,163,184,0.25)',
      'border-radius:8px',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)',
      'backdrop-filter:blur(2px)',
      'display:block',
      'pointer-events:auto',
    ].join(';');

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;margin:0 0 8px 0;';

    const btn = document.createElement('button');
    btn.id = 'wa-extractor-export-btn';
    btn.type = 'button';
    btn.textContent = 'Export JSON';
    btn.setAttribute('aria-label', 'Export captured WhatsApp messages as JSON');
    btn.style.cssText = [
      'display:block',
      'flex:1 1 auto',
      'padding:6px 8px',
      'font:12px sans-serif',
      'cursor:pointer',
      'background:#128c7e',
      'color:#fff',
      'border:none',
      'border-radius:6px',
    ].join(';');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportMessagesToJsonFile();
    });

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.textContent = 'Hide';
    hideBtn.setAttribute('aria-label', 'Hide insight panel');
    hideBtn.style.cssText = [
      'display:block',
      'padding:6px 8px',
      'font:12px sans-serif',
      'cursor:pointer',
      'background:rgba(100,116,139,0.35)',
      'color:#e5e7eb',
      'border:1px solid rgba(148,163,184,0.35)',
      'border-radius:6px',
    ].join(';');
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setInsightPanelVisible(false);
    });

    const showBtn = document.createElement('button');
    showBtn.id = 'wa-extractor-insight-show-btn';
    showBtn.type = 'button';
    showBtn.textContent = 'Show Insight';
    showBtn.setAttribute('aria-label', 'Show insight panel');
    showBtn.style.cssText = [
      'position:fixed',
      'top:120px',
      'left:360px',
      'z-index:2147483646',
      'padding:6px 10px',
      'font:12px sans-serif',
      'cursor:pointer',
      'background:rgba(15,23,42,0.82)',
      'color:#e5e7eb',
      'border:1px solid rgba(148,163,184,0.35)',
      'border-radius:6px',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)',
      'display:none',
    ].join(';');
    showBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setInsightPanelVisible(true);
    });

    const originalLabel = document.createElement('div');
    originalLabel.textContent = 'Original';
    originalLabel.style.cssText = 'opacity:.75;margin:0 0 2px 0;';
    const originalValue = document.createElement('div');
    originalValue.textContent = '-';
    originalValue.style.cssText = 'margin:0 0 8px 0;white-space:pre-wrap;word-break:break-word;';

    const convertedLabel = document.createElement('div');
    convertedLabel.textContent = 'Converted';
    convertedLabel.style.cssText = 'opacity:.75;margin:0 0 2px 0;';
    const convertedValue = document.createElement('div');
    convertedValue.textContent = '-';
    convertedValue.style.cssText = 'margin:0 0 8px 0;white-space:pre-wrap;word-break:break-word;';

    const confidenceLabel = document.createElement('div');
    confidenceLabel.textContent = 'Confidence';
    confidenceLabel.style.cssText = 'opacity:.75;margin:0 0 2px 0;';
    const confidenceValue = document.createElement('div');
    confidenceValue.textContent = '-';
    confidenceValue.style.cssText = 'font-weight:600;';

    const toneLabel = document.createElement('div');
    toneLabel.textContent = 'Tone';
    toneLabel.style.cssText = 'opacity:.75;margin:0 0 2px 0;';
    const toneValue = document.createElement('div');
    toneValue.textContent = '-';
    toneValue.style.cssText = 'margin:0 0 8px 0;font-weight:600;';

    const reasoningLabel = document.createElement('div');
    reasoningLabel.textContent = 'Tone Reason';
    reasoningLabel.style.cssText = 'opacity:.75;margin:0 0 2px 0;';
    const reasoningValue = document.createElement('div');
    reasoningValue.textContent = '-';
    reasoningValue.style.cssText = 'margin:0 0 8px 0;white-space:pre-wrap;word-break:break-word;';

    controls.appendChild(btn);
    controls.appendChild(hideBtn);
    panel.appendChild(controls);
    panel.appendChild(originalLabel);
    panel.appendChild(originalValue);
    panel.appendChild(convertedLabel);
    panel.appendChild(convertedValue);
    panel.appendChild(toneLabel);
    panel.appendChild(toneValue);
    panel.appendChild(reasoningLabel);
    panel.appendChild(reasoningValue);
    panel.appendChild(confidenceLabel);
    panel.appendChild(confidenceValue);
    document.documentElement.appendChild(panel);
    document.documentElement.appendChild(showBtn);

    insightPanelEls = {
      container: panel,
      originalValue,
      convertedValue,
      toneValue,
      reasoningValue,
      confidenceValue,
      showBtn,
    };
    setInsightPanelVisible(true);
    positionInsightPanel();
    window.addEventListener('resize', positionInsightPanel);
  }

  injectInsightPanel();
})();
