#!/usr/bin/env node
/**
 * Optional local helper: writes exports to this repo’s Scraping Tests folder.
 * Chrome extensions cannot save outside the browser download directory; when this
 * relay is running, the extension POSTs JSON here instead.
 *
 * Run from anywhere: node /path/to/Text-to-Speech-Enhancer/scripts/whatsapp-export-relay.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'Scraping Tests');
const OUT_FILE = path.join(OUT_DIR, 'whatsapp-messages.json');
const PORT = 17395;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const body = Buffer.concat(chunks);
      fs.writeFileSync(OUT_FILE, body, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`WhatsApp export relay → ${OUT_FILE}`);
  console.log(`POST JSON to http://127.0.0.1:${PORT}/`);
});
