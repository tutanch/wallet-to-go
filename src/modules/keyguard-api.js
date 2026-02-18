// Keyguard API — cross-origin iframe postMessage bridge.
// The keyguard iframe lives at KEYGUARD_ORIGIN and owns all key operations.
// Passwords never cross this module. Keys never leave the keyguard origin.
//
// Replace [KEYGUARD_ORIGIN] with the actual keyguard origin before deploying,
// e.g. https://nimiq-wallet-keyguard.github.io

const KEYGUARD_ORIGIN = '[KEYGUARD_ORIGIN]';

// ── Iframe reference ───────────────────────────────────────────────────────

function getFrame() {
    const frame = document.getElementById('keyguard-frame');
    if (!frame) throw new Error('Keyguard iframe not found in DOM');
    return frame;
}

// ── Keyguard ready promise ─────────────────────────────────────────────────
// Resolves when the keyguard iframe sends { type: 'ready' }.
// main.js awaits this (in parallel with loadNimiq()) before making any calls.

export const keyguardReady = new Promise((resolve) => {
    window.addEventListener('message', function onReady(event) {
        if (event.origin !== KEYGUARD_ORIGIN) return;
        if (event.data?.type === 'ready') {
            window.removeEventListener('message', onReady);
            resolve();
        }
    });
});

// ── Session tracking ───────────────────────────────────────────────────────

let sessionId = 0;
const pending = new Map(); // sessionId → { resolve, reject }

// ── Message listener (installed at module load time) ───────────────────────

window.addEventListener('message', (event) => {
    if (event.origin !== KEYGUARD_ORIGIN) return;

    const { type, sessionId: sid, result, error } = event.data;

    if (type === 'show') {
        const frame = document.getElementById('keyguard-frame');
        if (frame) frame.style.display = '';
        return;
    }

    if (type === 'hide') {
        const frame = document.getElementById('keyguard-frame');
        if (frame) frame.style.display = 'none';
        return;
    }

    if (type === 'result' || type === 'error') {
        const p = pending.get(sid);
        if (!p) return;
        pending.delete(sid);
        if (type === 'error') {
            p.reject(new Error(error));
        } else {
            p.resolve(result);
        }
    }
});

// ── Core send function ─────────────────────────────────────────────────────

function call(command, args) {
    return new Promise((resolve, reject) => {
        const id = ++sessionId;
        pending.set(id, { resolve, reject });
        getFrame().contentWindow.postMessage(
            { sessionId: id, command, args: args || {} },
            KEYGUARD_ORIGIN,
        );
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Check if a wallet exists. Transparent passthrough — no UI shown. */
export function hasKey() {
    return call('hasKey');
}

/** Get stored wallet address. Transparent passthrough — no UI shown. */
export function getStoredAddress() {
    return call('getStoredAddress');
}

/**
 * Create new wallet. Keyguard shows mnemonic display + password entry.
 * Returns { address }.
 */
export function createWallet() {
    return call('createWallet');
}

/**
 * Import wallet. Keyguard shows word entry + password entry.
 * No args — user enters words and password inside the keyguard.
 * Returns { address }.
 */
export function importWallet() {
    return call('importWallet');
}

/**
 * Sign transaction. Keyguard shows TX confirmation + password entry.
 * No password param — keyguard prompts the user.
 * Returns { serializedTx: Uint8Array }.
 */
export function signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId }) {
    return call('signTransaction', {
        senderAddress,
        recipientAddress,
        value,
        fee,
        message,
        validityStartHeight,
        networkId,
    });
}

/**
 * Export mnemonic. Keyguard shows password entry then displays words.
 * Words are NEVER sent to the wallet — keyguard displays them internally.
 * Returns { success: true }.
 */
export function exportMnemonic() {
    return call('exportMnemonic');
}

/**
 * Delete wallet. Keyguard shows password + "DELETE" confirmation.
 * Returns { success: true }.
 */
export function deleteWallet() {
    return call('deleteWallet');
}
