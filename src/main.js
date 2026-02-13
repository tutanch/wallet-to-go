import { loadNimiq } from './nimiq.js';
import { registerRoute, initRouter, navigate } from './router.js';
import { hasKey } from './modules/key-store.js';
import { welcomeView } from './views/welcome-view.js';
import { createView } from './views/create-view.js';
import { importView } from './views/import-view.js';
import { dashboardView } from './views/dashboard-view.js';
import { sendView } from './views/send-view.js';
import { receiveView } from './views/receive-view.js';
import { historyView } from './views/history-view.js';
import { settingsView } from './views/settings-view.js';

async function init() {
    try {
        await loadNimiq();

        registerRoute('#welcome', () => welcomeView());
        registerRoute('#create', () => createView());
        registerRoute('#import', () => importView());
        registerRoute('#dashboard', () => dashboardView());
        registerRoute('#send', () => sendView());
        registerRoute('#receive', () => receiveView());
        registerRoute('#history', () => historyView());
        registerRoute('#settings', () => settingsView());

        // If wallet exists, go to dashboard; otherwise show welcome
        const walletExists = await hasKey();
        const hash = window.location.hash;

        if (walletExists && (!hash || hash === '#welcome' || hash === '#create' || hash === '#import')) {
            navigate('#dashboard');
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
