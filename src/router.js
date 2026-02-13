import { hasKey } from './modules/key-store.js';

const routes = {};
let currentCleanup = null;

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

    if (currentCleanup) {
        currentCleanup();
        currentCleanup = null;
    }

    $app.innerHTML = '';

    const factory = routes[hash];
    if (factory) {
        const result = await factory();
        if (result instanceof HTMLElement) {
            $app.appendChild(result);
        } else if (result && result.element) {
            $app.appendChild(result.element);
            if (result.cleanup) {
                currentCleanup = result.cleanup;
            }
        }
    } else {
        navigate('#welcome');
    }
}

export function initRouter() {
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
}
