import { hasKey } from './modules/keyguard-api.js';

const routes = {};
let currentCleanup = null;
let navigationId = 0;
let previousHash = null;

const PUBLIC_ROUTES = new Set(['#welcome', '#create', '#import']);

// Route depth for directional transitions
const ROUTE_DEPTH = {
    '#welcome': 0, '#lock': 0,
    '#create': 1, '#import': 1, '#dashboard': 1,
    '#asset-nim': 2, '#asset-usdc': 2, '#asset-usdt': 2,
    '#send': 2, '#receive': 2, '#history': 2, '#settings': 2, '#batch-send': 2, '#cashlinks': 2,
};

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

    // Determine transition direction
    const newDepth = ROUTE_DEPTH[hash] ?? 1;
    const oldDepth = ROUTE_DEPTH[previousHash] ?? 1;
    const direction = previousHash === null ? 'forward' : (newDepth >= oldDepth ? 'forward' : 'back');

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

    let viewEl = null;
    if (result instanceof HTMLElement) {
        viewEl = result;
        $app.appendChild(result);
    } else if (result && result.element) {
        viewEl = result.element;
        $app.appendChild(result.element);
        if (result.cleanup) {
            currentCleanup = result.cleanup;
        }
    }

    // Apply directional transition
    if (viewEl) {
        viewEl.setAttribute('data-transition', direction);
    }

    previousHash = hash;
}

export function initRouter() {
    window.addEventListener('hashchange', handleHashChange);
    handleHashChange();
}
