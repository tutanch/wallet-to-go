import { loadNimiq } from './nimiq.js';
import { registerRoute, initRouter, navigate } from './router.js';
import { hasKey, keyguardReady } from './modules/keyguard-api.js';
import './modules/webauthn.js'; // Register WebAuthn delegation listener for keyguard iframe
import { welcomeView } from './views/welcome-view.js';
import { createView } from './views/create-view.js';
import { importView } from './views/import-view.js';
import { dashboardView } from './views/dashboard-view.js';
import { sendView } from './views/send-view.js';
import { receiveView } from './views/receive-view.js';
import { historyView } from './views/history-view.js';
import { settingsView } from './views/settings-view.js';
import { lockView } from './views/lock-view.js';
import { batchSendView } from './views/batch-send-view.js';

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

        const modal = document.createElement('div');
        modal.className = 'disclaimer-modal';

        const icon = document.createElement('div');
        icon.className = 'disclaimer-icon';
        icon.textContent = '\u26A0';

        const title = document.createElement('h2');
        title.className = 'nq-h1';
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
    });
}

async function init() {
    try {
        // Show disclaimer before anything else
        await showDisclaimer();

        // Load Nimiq WASM and wait for keyguard iframe in parallel
        await Promise.all([loadNimiq(), keyguardReady]);

        registerRoute('#welcome', () => welcomeView());
        registerRoute('#create', () => createView());
        registerRoute('#import', () => importView());
        registerRoute('#dashboard', () => dashboardView());
        registerRoute('#send', () => sendView());
        registerRoute('#receive', () => receiveView());
        registerRoute('#history', () => historyView());
        registerRoute('#settings', () => settingsView());
        registerRoute('#lock', () => lockView());
        registerRoute('#batch-send', () => batchSendView());

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
