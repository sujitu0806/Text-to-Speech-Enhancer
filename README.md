# Text-to-Speech-Enhancer

This project is a Google Chrome extension for WhatsApp Web. It captures messages from an open chat, uses Gemini to expand slang/acronyms and detect tone, and uses ElevenLabs to read the message aloud with a more natural voice.

## Open-Source Code / Changes Made

This project is built as a custom Chrome extension in JavaScript. No external open-source library was imported into the codebase, all code was written independently or using Cursor; the main work here was implementing the WhatsApp Web message capture, Gemini enrichment flow, ElevenLabs speech flow, live readout behavior, and the on-screen insight panel.

## Key Files

- `manifest.json`  
  The Chrome extension manifest. It tells Chrome to run the extension on WhatsApp Web and connects the background and content scripts.

- `content.js`  
  Runs inside WhatsApp Web. It monitors any new messages, displays the user insight box, and queries the background script to process and read messages aloud.

- `background.js`  
  Handles the main logic behind the scenes. It stores the system prompts, talks to Gemini and ElevenLabs, stores message data, and returns audio for playback.

- `config.example.js`  
  A template showing what keys you need to add locally. Copy this file to `config.js` and fill in your own values.

- `config.js`  
  Your private local config file for API keys and voice ID. This file is ignored by git and should not be uploaded publicly.

- `.gitignore`  
  Prevents private or unnecessary files from being committed, especially `config.js`.

- `Scraping Tests/whatsapp-messages.json`  
  Example output file containing exported/enriched WhatsApp messages. Mostly used for testing purposes.

## API Keys

- Gemini API key: create one at [Google AI Studio](https://aistudio.google.com/app/apikey)
- ElevenLabs API key: create one at [ElevenLabs API Keys](https://elevenlabs.io/app/settings/api-keys)
- ElevenLabs voice ID: choose a voice in your ElevenLabs account and copy its voice ID

After that:

1. Copy `config.example.js` to `config.js`
2. Paste your Gemini API key
3. Paste your ElevenLabs API key
4. Paste your ElevenLabs voice ID

## How To Run

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode**
3. Choose **Load unpacked**
4. Select this project folder
5. Open [WhatsApp Web](https://web.whatsapp.com/)
6. Open a chat to start using the extension

## Notes

- This extension is made for **WhatsApp Web**, not the desktop app.
- Reload the extension in `chrome://extensions` after code changes.
- Keep `config.js` private. It is intentionally excluded through `.gitignore`.