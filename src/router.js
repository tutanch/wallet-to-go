const routes = {};
let currentCleanup = null;

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
