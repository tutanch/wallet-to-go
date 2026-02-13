# Nimiq Wallet

A lightweight, client-side Nimiq blockchain wallet built with vanilla JavaScript. No build tools, no frameworks — just ES modules served directly from the browser.

## Features

- **Create or import** wallets via BIP39 mnemonic (24 words)
- **Send and receive** NIM on Mainnet or Testnet
- **Real-time updates** — balance, block height, and transactions stream live via Nimiq's P2P network
- **Encrypted key storage** — private keys are encrypted with a user password and stored in IndexedDB
- **QR code** generation for receiving addresses
- **Transaction history** with pagination
- **Network switching** between Mainnet and Testnet

## Architecture

```
index.html              Entry point, CSP, script loading
src/
  main.js               App initialization and route registration
  router.js             Hash-based SPA router with async views
  config.js             Network configs, derivation path, NIM/luna conversion
  nimiq.js              Lazy Nimiq WASM loader
  security-init.js      Freezes critical browser APIs before third-party scripts
  modules/
    key-store.js        IndexedDB encrypted key storage
    wallet-manager.js   Wallet creation/import (BIP44 m/44'/242'/0'/0')
    network-client.js   Nimiq network client singleton (pico sync)
    transaction-builder.js  Transaction construction and signing
  views/
    welcome-view.js     Landing page
    create-view.js      New wallet creation flow
    import-view.js      Mnemonic import flow
    dashboard-view.js   Balance, status, recent transactions
    send-view.js        Send NIM flow
    receive-view.js     Address display + QR code
    history-view.js     Full transaction history
    settings-view.js    Network switch, backup, wallet deletion
  styles/
    app.css             Application styles
lib/
  nimiq-core/           Nimiq Core WASM library
public/
  favicon.svg
```

## Requirements

- A modern browser with **WebAssembly** support
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

- **Content Security Policy** restricts script sources, connections, and object embeds
- **SRI hashes** on all CDN-loaded scripts
- **API freezing** (`security-init.js`) protects `TextEncoder`, `crypto.subtle`, `indexedDB`, and `Uint8Array.prototype.fill` from prototype pollution before third-party scripts load
- **No private key exposure** — keys never leave `key-store.js` except during signing; wallet info objects do not contain private keys
- **DOM-safe rendering** — mnemonic words and user-facing text use `textContent` / DOM APIs instead of `innerHTML` to prevent XSS

## Tech Stack

- [Nimiq Core](https://github.com/nicmiq/core-rs-albatross) (Albatross PoS, pico sync mode)
- [Nimiq Style](https://github.com/nimiq/nimiq-style) CSS framework
- [QR Creator](https://github.com/nicmiq/qr-creator) for QR code generation
- Vanilla JavaScript (ES modules, no bundler)

## License

MIT
