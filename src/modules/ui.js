// src/modules/ui.js — small layout-stability helpers shared across views.
// All DOM-API (never innerHTML), so they're safe for network-sourced text.
// See the matching CSS primitives (.skeleton-text / .value-settle / .reveal /
// .list-reserve) in src/styles/app.css.

/**
 * Put a width-stable shimmer chip inside `el`. Idempotent: a second call while
 * the chip is already present is a no-op, so re-renders don't restart the
 * shimmer. `widthCh` sizes the chip in `ch` units to roughly match the value
 * it stands in for.
 */
export function skeletonText(el, widthCh = 6) {
    const first = el.firstElementChild;
    if (first && first.classList.contains('skeleton-text')) return;
    el.textContent = '';
    const chip = document.createElement('span');
    chip.className = 'skeleton skeleton-text';
    chip.style.setProperty('--w', widthCh + 'ch');
    chip.setAttribute('aria-hidden', 'true');
    el.appendChild(chip);
}

/**
 * Write final text into `el`, replacing any skeleton chip. The first time a
 * real value lands (loading → loaded) it fades in once; later updates are
 * silent so values that refresh often (balances, block height) don't re-flash.
 */
export function settleText(el, text) {
    const firstSettle = !el.dataset.settled;
    el.textContent = text;
    if (firstSettle) {
        el.dataset.settled = '1';
        el.classList.add('value-settle');
    }
}

/**
 * Open or close a `.reveal` slot without reflowing the page. Toggles the class
 * BEFORE writing text on purpose: a live region must be visible (in the a11y
 * tree) at the moment its text mutates, or screen readers won't announce it.
 * Pass `text === undefined` to toggle visibility without touching the content.
 */
export function setReveal(slot, open, text) {
    slot.classList.toggle('open', !!open);
    if (text !== undefined && slot.firstElementChild) {
        slot.firstElementChild.textContent = text;
    }
}

/** Reserve list height for `rows` skeleton/expected rows (see .list-reserve). */
export function reserveList(listEl, rows) {
    listEl.classList.add('list-reserve');
    listEl.style.setProperty('--rows', String(rows));
}
