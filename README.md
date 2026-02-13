# Nimiq Wallet

A lightweight, fully client-side Nimiq blockchain wallet built with vanilla JavaScript. No build tools, no frameworks, no backend — just ES modules served directly from the browser, connecting to the Nimiq P2P network.

## Features

- **Create or import** wallets via BIP39 mnemonic (24 words)
- **Send and receive** NIM on Mainnet or Testnet
- **Real-time updates** — balance, block height, and transactions stream live via Nimiq's P2P network
- **Encrypted key storage** — private keys are encrypted with a user password and stored in IndexedDB
- **Isolated keyguard** — all key operations run in a dedicated Web Worker; private keys never touch the main thread
- **QR code** generation for receiving addresses
- **Transaction history** with pagination
- **Network switching** between Mainnet and Testnet
- **No hosted services** — does not use Nimiq Hub, Keyguard, or any API server; connects directly to the blockchain

## Architecture

The wallet follows a keyguard/hub/wallet separation pattern, running entirely client-side:

```
┌─────────────────────────────────┐
│  Wallet (main thread)           │  UI, routing, network, display
│  ─ views, router, network       │  Never sees private keys
├─────────────────────────────────┤
│  Hub (postMessage bridge)       │  keyguard-api.js
│  ─ request/response to worker   │  Clean async API boundary
├─────────────────────────────────┤
│  Keyguard (Web Worker)          │  keyguard-worker.js
│  ─ key storage, signing,        │  Keys never leave this context
│    mnemonic export, encryption  │
└─────────────────────────────────┘
```

### File structure

```
index.html                Entry point, CSP, script loading
src/
  main.js                 App initialization and route registration
  router.js               Hash-based SPA router with async views
  config.js               Network configs, derivation path, NIM/luna conversion
  nimiq.js                Lazy Nimiq WASM loader (main thread, for network client)
  security-init.js        Freezes critical browser APIs before third-party scripts
  keyguard-worker.js      Web Worker: all key operations (isolated JS heap)
  modules/
    keyguard-api.js       postMessage bridge to the keyguard worker
    network-client.js     Nimiq network client singleton (pico sync)
  views/
    welcome-view.js       Landing page
    create-view.js        New wallet creation flow
    import-view.js        Mnemonic import flow
    dashboard-view.js     Balance, status, recent transactions
    send-view.js          Send NIM flow
    receive-view.js       Address display + QR code
    history-view.js       Full transaction history
    settings-view.js      Network switch, backup, wallet deletion
  styles/
    app.css               Application styles
lib/
  nimiq-core/             Nimiq Core WASM library
public/
  favicon.svg
```

## Requirements

- A modern browser with **WebAssembly** and **Module Worker** support
- Served over **HTTPS** (or localhost) — required for crypto APIs and P2P connections

## Running locally

Serve the project root with any static HTTP server:

```bash
# Python
python3 -m http.server 8080

# Node.js (npx)
npx serve .
```

Then open `http://localhost:8080`.

## Security

### Key isolation

Private keys are generated, stored, decrypted, and used for signing exclusively inside a **Web Worker** (`keyguard-worker.js`). The worker has its own JS heap, so even if an XSS vulnerability exists in the main thread, an attacker cannot access key material through JavaScript. The main thread communicates with the worker via `postMessage` and only ever receives:

- Wallet addresses (strings)
- Mnemonic words (on explicit user request with password)
- Serialized signed transactions (byte arrays)

### Additional hardening

- **Content Security Policy** restricts script sources, connections, and object embeds
- **SRI hashes** on all CDN-loaded scripts (pinned versions with integrity verification)
- **API freezing** (`security-init.js`) protects `crypto.subtle`, `indexedDB`, and `Uint8Array.prototype.fill` from prototype pollution before third-party scripts load
- **DOM-safe rendering** — mnemonic words and user-facing text use `textContent` / DOM APIs instead of `innerHTML` to prevent XSS
- **Password-confirmed deletion** — wallet deletion requires password verification
- **Auto-hiding mnemonics** — recovery words auto-clear from the DOM after 60 seconds

### What this wallet does NOT use

- No Nimiq Hub (`hub.nimiq.com`)
- No Nimiq Keyguard (`keyguard.nimiq.com`)
- No backend API or server
- No third-party analytics or tracking

All network traffic is either CDN asset loading (with SRI) or direct P2P WebSocket connections to the Nimiq blockchain.

## Tech Stack

- [Nimiq Core](https://github.com/nimiq/core-rs-albatross) (Albatross PoS, pico sync mode)
- [Nimiq Style](https://github.com/nimiq/nimiq-style) CSS framework
- [QR Creator](https://github.com/nicmiq/qr-creator) for QR code generation
- Vanilla JavaScript (ES modules, no bundler)

## License

MIT
