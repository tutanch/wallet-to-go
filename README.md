# Nimiq Wallet

A lightweight, fully client-side Nimiq blockchain wallet built with vanilla JavaScript. No build tools, no frameworks, no backend — just ES modules served directly from the browser, connecting to the Nimiq P2P network.

## Features

- **Create or import** wallets via BIP39 mnemonic (24 words)
- **Send and receive** NIM on Mainnet or Testnet
- **Real-time updates** — balance, block height, and transactions stream live via Nimiq's P2P network
- **Cross-origin keyguard** — all key operations run in an isolated iframe on a separate origin; private keys never touch the wallet's origin
- **Encrypted key storage** — private keys are encrypted with a user password and stored in the keyguard's IndexedDB (inaccessible to the wallet)
- **QR code** generation for receiving addresses
- **Transaction history** with pagination
- **Network switching** between Mainnet and Testnet
- **Service worker integrity pinning** — all assets are SHA-256 verified on install; tampered files are rejected
- **No hosted services** — does not use Nimiq Hub, Keyguard, or any API server; connects directly to the blockchain

## Architecture

The wallet uses origin separation between the wallet UI and the keyguard:

```
┌──────────────────────────────────────┐
│  Wallet (tutanch.github.io)          │  UI, routing, network, display
│  ─ views, router, network            │  Never sees private keys or passwords
│  ─ postMessage to keyguard iframe    │
├──────────────────────────────────────┤
│  Keyguard iframe ([ORG].github.io)   │  Separate origin = separate storage
│  ─ keyguard-app.js (UI controller)   │  Renders password prompts, mnemonic
│  ─ keyguard-worker.js (Web Worker)   │  grids, TX confirmations inside iframe
│  ─ IndexedDB (encrypted keys)        │  Keys never leave this origin
└──────────────────────────────────────┘
```

The wallet communicates with the keyguard exclusively via `postMessage` with strict origin validation on both sides. The keyguard handles all sensitive flows (wallet creation, import, signing, mnemonic export, deletion) entirely within its own origin — passwords and mnemonic words are never sent to the wallet.

### File structure

```
index.html                Entry point, CSP, keyguard iframe, script loading
sw.js                     Generated service worker (integrity-pinned caching)
.github/workflows/
  deploy.yml              GitHub Actions workflow (replaces placeholders, deploys)
scripts/
  deploy.sh               Cross-origin deploy script (wallet + keyguard)
  generate-sw.js          Generates sw.js with SHA-256 hashes of all assets
src/
  main.js                 App init, SW registration, keyguard readiness
  router.js               Hash-based SPA router with async views
  config.js               Network configs, derivation path, NIM/luna conversion
  nimiq.js                Lazy Nimiq WASM loader (main thread, for network client)
  security-init.js        Freezes critical browser APIs before third-party scripts
  modules/
    keyguard-api.js       postMessage bridge to the keyguard iframe
    network-client.js     Nimiq network client singleton (pico sync)
  views/
    welcome-view.js       Landing page
    create-view.js        Triggers keyguard create flow
    import-view.js        Triggers keyguard import flow
    dashboard-view.js     Balance, status, recent transactions
    send-view.js          Send NIM flow (keyguard signs)
    receive-view.js       Address display + QR code
    history-view.js       Full transaction history
    settings-view.js      Network switch, backup, wallet deletion
  styles/
    app.css               Application styles
lib/
  nimiq-core/             Nimiq Core WASM library
public/
  vendor/
    nimiq-style.min.css   Self-hosted Nimiq Style CSS
    qr-creator.min.js     Self-hosted QR Creator
  favicon.svg

keyguard/                 Keyguard app (deployed to separate origin)
  index.html              Keyguard shell with strict CSP
  src/
    keyguard-app.js       Message handler, worker bridge, all UI flows
    keyguard-worker.js    Web Worker: key operations (isolated JS heap)
    styles/
      keyguard.css        Standalone keyguard styles
  lib/
    nimiq-core/           Nimiq Core WASM library (copy)
  public/
    favicon.svg
```

## Requirements

- A modern browser with **WebAssembly** and **ES Module** support
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

**Note:** For full origin separation locally, you'll need to serve the `keyguard/` directory on a different port (e.g. `8081`) and update the `[KEYGUARD_ORIGIN]` placeholders accordingly.

## Deploying

### One-time setup

1. Create a free [GitHub Organization](https://github.com/account/organizations/new) for the keyguard (e.g. `my-keyguard`)
2. Run the deploy script:

```bash
./scripts/deploy.sh <org-name>
```

This creates a `<org-name>.github.io` repo in the org, pushes the keyguard code with the correct `[WALLET_ORIGIN]`, and writes a GitHub Actions workflow for the wallet with the correct `[KEYGUARD_ORIGIN]`.

3. Commit and push the wallet:

```bash
git add -A && git commit -m "Add deploy workflow" && git push
```

4. Set the wallet repo's GitHub Pages source to **GitHub Actions** (Settings > Pages > Source)

That's it. Every push to `main` auto-deploys the wallet. The workflow replaces origin placeholders and regenerates `sw.js` at build time — no manual steps.

### Updating the keyguard

The keyguard source lives in `keyguard/` in this repo. After making changes, re-run the deploy script to push them to the org repo:

```bash
./scripts/deploy.sh
```

(It remembers the org name from the first run.)

### Service worker integrity hashes

The GitHub Actions workflow runs `node scripts/generate-sw.js` automatically on every deploy. The generated `sw.js` contains SHA-256 hashes of every wallet asset. On install, the service worker verifies each cached file against these hashes — if any file has been tampered with on the server, the SW install fails and the previous known-good version stays active.

## Security

### Origin separation

The keyguard runs on a **separate GitHub Pages origin** (`[ORG].github.io`) from the wallet (`tutanch.github.io`). This means:

- The wallet **cannot** access the keyguard's IndexedDB, DOM, or JavaScript context
- Even if an XSS vulnerability exists in the wallet, an attacker cannot extract private keys — they live in a different origin's storage
- Passwords are entered inside the keyguard iframe and never cross the origin boundary

The wallet only ever receives from the keyguard:
- Wallet addresses (strings)
- Serialized signed transactions (byte arrays)
- Success/error confirmations

Mnemonic words are displayed inside the keyguard iframe and **never** sent to the wallet.

### Service worker integrity pinning

On first visit, the service worker pre-caches every asset and verifies each file's SHA-256 hash. On subsequent visits:

- Assets are served from cache (cache-first strategy)
- If GitHub Pages is compromised and serves tampered files, the SW update fails the hash check — the install is aborted and the old known-good SW stays active
- The only window of vulnerability is the very first visit before any SW is installed

### Additional hardening

- **Content Security Policy** — `script-src` limited to `'self'` and `'wasm-unsafe-eval'` (no `'unsafe-eval'`); `frame-src` restricted to the keyguard origin; no CDN sources
- **Self-hosted dependencies** — `nimiq-style.min.css` and `qr-creator.min.js` are vendored locally (SHA-384 verified before committing); no runtime CDN requests
- **API freezing** (`security-init.js`) protects `crypto.subtle`, `indexedDB`, and `Uint8Array.prototype.fill` from prototype pollution before any other scripts load
- **DOM-safe rendering** — user-facing text uses `textContent` / DOM APIs; the keyguard uses `escHtml()` for all template interpolation
- **Sandboxed iframe** — `sandbox="allow-scripts allow-same-origin allow-forms"` on the keyguard iframe; `allow-same-origin` is safe because the origins are already different

### What this wallet does NOT use

- No Nimiq Hub (`hub.nimiq.com`)
- No Nimiq Keyguard (`keyguard.nimiq.com`)
- No backend API or server
- No CDN dependencies at runtime
- No third-party analytics or tracking

All network traffic is direct P2P WebSocket connections to the Nimiq blockchain.

## Tech Stack

- [Nimiq Core](https://github.com/nimiq/core-rs-albatross) (Albatross PoS, pico sync mode)
- [Nimiq Style](https://github.com/nimiq/nimiq-style) CSS framework (self-hosted)
- [QR Creator](https://github.com/nimiq/qr-creator) for QR code generation (self-hosted)
- Vanilla JavaScript (ES modules, no bundler)

## License

MIT
