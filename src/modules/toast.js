// Lightweight toast notifications. DOM API only (no innerHTML) — XSS-safe.

const TOAST_DURATION = 3000;
let container = null;

function getContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
}

/** @param {'info'|'success'|'error'} type */
export function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    if (type === 'error') toast.setAttribute('role', 'alert');
    toast.textContent = message;

    const c = getContainer();
    c.appendChild(toast);

    // Trigger enter animation on next frame
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    const timer = setTimeout(() => dismiss(toast), TOAST_DURATION);
    toast.addEventListener('click', () => {
        clearTimeout(timer);
        dismiss(toast);
    });
}

function dismiss(toast) {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
}
