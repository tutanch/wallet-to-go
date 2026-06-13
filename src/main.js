import { loadNimiq } from './nimiq.js';
import { registerRoute, initRouter, navigate } from './router.js';
import { hasKey, keyguardReady, createKeyguardFrame } from './modules/keyguard-api.js';
import { verifyKeyguard, repinKeyguard } from './modules/keyguard-verify.js';
import './modules/webauthn.js'; // Register WebAuthn delegation listener for keyguard iframe
// welcome + lock are the only first-paint screens, so they're imported eagerly.
// Every other view is loaded lazily at navigation time (see the registerRoute
// calls below) so its module subgraph (e.g. network-client) stays off the
// startup path.
import { welcomeView } from './views/welcome-view.js';
import { lockView } from './views/lock-view.js';

// Register service worker for integrity-pinned caching.
// Non-blocking — does not delay app startup.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function showDisclaimer() {
    return new Promise(resolve => {
        if (localStorage.getItem('disclaimer-accepted')) return resolve();

        const overlay = document.createElement('div');
        overlay.className = 'disclaimer-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'disclaimer-title');

        const modal = document.createElement('div');
        modal.className = 'disclaimer-modal';

        const icon = document.createElement('div');
        icon.className = 'disclaimer-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '\u26A0';

        const title = document.createElement('h2');
        title.className = 'nq-h1';
        title.id = 'disclaimer-title';
        title.textContent = 'Experimental Software';

        const body = document.createElement('div');
        body.className = 'disclaimer-body';

        const p1 = document.createElement('p');
        p1.textContent = 'This wallet is experimental software intended for testing purposes only. Do not use it to store or manage funds you cannot afford to lose.';

        const p2 = document.createElement('p');
        p2.textContent = 'This application is open source and served from GitHub Pages. It runs entirely on your device — no server stores your keys or data. You are solely responsible for any use of this software.';

        const p3 = document.createElement('p');
        p3.textContent = 'The authors provide no warranty and accept no liability for any loss or damage arising from the use of this wallet.';

        body.append(p1, p2, p3);

        const btn = document.createElement('button');
        btn.className = 'nq-button light-blue';
        btn.textContent = 'I Understand & Accept';
        btn.addEventListener('click', () => {
            localStorage.setItem('disclaimer-accepted', Date.now().toString());
            overlay.classList.add('disclaimer-fade-out');
            overlay.addEventListener('animationend', () => {
                overlay.remove();
                resolve();
            });
        });

        modal.append(icon, title, body, btn);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        btn.focus();
    });
}

// Fail-closed screen shown when the keyguard integrity gate refuses to open the
// keyguard. All dynamic text is set via textContent (no interpolation).
function renderIntegrityAlarm(err) {
    const app = document.getElementById('app');
    const kind = err?.kind;
    const title = (kind === 'tamper' || kind === 'pin-change') ? 'Security Warning' : 'Keyguard Unavailable';
    const msg = kind === 'pin-change'
        ? 'The keyguard’s code fingerprint has changed since you last used this wallet. This is expected after a legitimate update, but it can also mean the keyguard was tampered with. Do NOT enter your password or recovery words until you have compared the new fingerprint (Settings → Keyguard fingerprint) against the value published by the developers.'
        : kind === 'tamper'
            ? 'The keyguard’s code does not match what this wallet expects. To protect your keys, the wallet refused to open it. Do not proceed.'
            : 'The wallet could not reach or verify the keyguard, so it will not open it. Check your connection and try again.';

    app.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1" id="kg-alarm-title"></h1>
            </div>
            <div class="nq-card-body">
                <p class="nq-text error-text" id="kg-alarm-msg"></p>
                <button class="nq-button" id="kg-alarm-retry" type="button">Retry</button>
                <button class="nq-button" id="kg-alarm-accept" type="button" style="display:none; margin-top:12px; opacity:.8;">I verified the new fingerprint — accept</button>
            </div>
        </div>
    `;
    app.querySelector('#kg-alarm-title').textContent = title;
    app.querySelector('#kg-alarm-msg').textContent = msg;
    app.querySelector('#kg-alarm-retry').addEventListener('click', () => window.location.reload());
    if (kind === 'pin-change') {
        const accept = app.querySelector('#kg-alarm-accept');
        accept.style.display = '';
        accept.addEventListener('click', () => { repinKeyguard(); window.location.reload(); });
    }
}

async function init() {
    try {
        // Apply stored theme preference before first render
        const storedTheme = localStorage.getItem('nimiq-theme');
        if (storedTheme === 'light' || storedTheme === 'dark') {
            document.documentElement.setAttribute('data-theme', storedTheme);
        }

        // Show disclaimer before anything else
        await showDisclaimer();

        // Warm up the Nimiq WASM (~8.7 MB) in the background. It's only needed
        // for network operations (dashboard balance, send, history) — never for
        // the first paint — and every consumer awaits loadNimiq() at its own
        // point of use, so a load failure surfaces there (not as a fatal init
        // error). Keeping it off the critical path is the main startup win.
        loadNimiq().catch(() => {});

        // SECURITY GATE: cross-verify the keyguard's served code against the
        // baked, hash-pinned manifest BEFORE attaching its iframe. Fails closed
        // — a tampered, fingerprint-changed, or unreachable keyguard is never
        // opened. No-op in local/dev mode (before the first deploy).
        await verifyKeyguard();
        createKeyguardFrame();

        // First paint waits only on the keyguard (needed for hasKey() routing),
        // not on WASM.
        await keyguardReady;

        // welcome + lock render synchronously (eager imports above). Every other
        // view is fetched on first navigation so its module subgraph stays off
        // the startup path; the router awaits the factory promise (router.js).
        registerRoute('#welcome', () => welcomeView());
        registerRoute('#lock', () => lockView());
        registerRoute('#create', () => import('./views/create-view.js').then(m => m.createView()));
        registerRoute('#import', () => import('./views/import-view.js').then(m => m.importView()));
        registerRoute('#dashboard', () => import('./views/dashboard-view.js').then(m => m.dashboardView()));
        registerRoute('#send', () => import('./views/send-view.js').then(m => m.sendView()));
        registerRoute('#receive', () => import('./views/receive-view.js').then(m => m.receiveView()));
        registerRoute('#history', () => import('./views/history-view.js').then(m => m.historyView()));
        registerRoute('#settings', () => import('./views/settings-view.js').then(m => m.settingsView()));
        registerRoute('#batch-send', () => import('./views/batch-send-view.js').then(m => m.batchSendView()));
        registerRoute('#cashlinks', () => import('./views/cashlinks-view.js').then(m => m.cashlinksView()));
        // asset-view is one module serving three routes — dynamic import dedupes/caches it.
        registerRoute('#asset-nim', () => import('./views/asset-view.js').then(m => m.assetView('nim')));
        registerRoute('#asset-usdc', () => import('./views/asset-view.js').then(m => m.assetView('usdc')));
        registerRoute('#asset-usdt', () => import('./views/asset-view.js').then(m => m.assetView('usdt')));

        // If wallet exists, go to dashboard (or lock screen); otherwise show welcome
        const walletExists = await hasKey();
        const hash = window.location.hash;

        if (walletExists && !hash) {
            navigate('#lock');
        } else if (!walletExists && hash !== '#create' && hash !== '#import') {
            navigate('#welcome');
        }

        initRouter();
    } catch (e) {
        if (e?.name === 'KeyguardIntegrityError') {
            renderIntegrityAlarm(e);
            return;
        }
        console.error('Failed to initialize Nimiq:', e);
        const app = document.getElementById('app');
        app.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Initialization Error</h1>
                </div>
                <div class="nq-card-body">
                    <p class="nq-text error-text" id="init-error"></p>
                    <p class="nq-text">This app requires a modern browser with WebAssembly support.</p>
                </div>
            </div>
        `;
        app.querySelector('#init-error').textContent = e.message;
    }
}

init();
