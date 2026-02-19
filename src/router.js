import { hasKey } from './modules/keyguard-api.js';

const routes = {};
let currentCleanup = null;
let navigationId = 0;

const PUBLIC_ROUTES = new Set(['#welcome', '#create', '#import']);

export function registerRoute(hash, viewFactory) {
    routes[hash] = viewFactory;
}

export function navigate(hash) {
    window.location.hash = hash;
}

function getCurrentRoute() {
    return window.location.hash || '#welcome';
}

async function handleHashChange() {
    const thisNavId = ++navigationId;
    const hash = getCurrentRoute();
    const $app = document.getElementById('app');

    // Route guard: redirect to #welcome if no wallet exists on protected routes
    if (!PUBLIC_ROUTES.has(hash)) {
        const walletExists = await hasKey();
        if (!walletExists) {
            navigate('#welcome');
            return;
        }
    }

    // If another navigation started while we were checking, abort this one
    if (thisNavId !== navigationId) return;

    const factory = routes[hash];
    if (!factory) {
        navigate('#welcome');
        return;
    }

    // Build the new view while the old one is still visible
    const result = await factory();
    if (thisNavId !== navigationId) return;

    // Fade out old view
    const oldView = $app.firstElementChild;
    if (oldView) {
        oldView.classList.add('view-exit');
        await new Promise(r => setTimeout(r, 120));
        if (thisNavId !== navigationId) return;
    }

    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }

    $app.innerHTML = '';

    if (result instanceof HTMLElement) {
        $app.appendChild(result);
    } else if (result && result.element) {
        $app.appendChild(result.element);
        if (result.cleanup) {
            currentCleanup = result.cleanup;
        }
    }
}

export function initRouter() {
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
}
