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

export function getCurrentRoute() {
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

    // Create the new view BEFORE clearing the old one.
    // This keeps the current view visible while an async view (e.g. dashboard)
    // loads its data, preventing a blank flash during the transition.
    const result = await factory();
    if (thisNavId !== navigationId) return;

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
