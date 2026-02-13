// Keyguard API — postMessage bridge to the keyguard worker.
// This is the ONLY module that communicates with the worker.
// No private keys ever cross this boundary.

let worker = null;
let requestId = 0;
const pending = new Map();

function getWorker() {
    if (!worker) {
        worker = new Worker(
            new URL('../keyguard-worker.js', import.meta.url),
            { type: 'module' },
        );
        worker.onmessage = (e) => {
            const { id, result, error } = e.data;
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (error) {
                p.reject(new Error(error));
            } else {
                p.resolve(result);
            }
        };
    }
    return worker;
}

function call(command, args) {
    return new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });

        // Transfer ArrayBuffers if present (zero-copy into worker)
        const transfer = [];
        if (args && args.serializedTx instanceof Uint8Array) {
            transfer.push(args.serializedTx.buffer);
        }

        getWorker().postMessage({ id, command, args }, transfer);
    });
}

// ── Public API ─────────────────────────────────────────────────────
// These mirror the old key-store / wallet-manager / transaction-builder
// surface, but none of them expose entropy or private keys.

/** Check if a wallet exists in storage */
export function hasKey() {
    return call('hasKey');
}

/** Get the stored wallet address (user-friendly string) or null */
export function getStoredAddress() {
    return call('getStoredAddress');
}

/** Create a new wallet. Returns { mnemonic: string[], address: string } */
export function createWallet() {
    return call('createWallet');
}

/** Save the pending wallet (from createWallet) with a password */
export function saveWallet(password) {
    return call('saveWallet', { password });
}

/** Import a wallet from mnemonic words and encrypt with password */
export function importWallet(words, password) {
    return call('importWallet', { words, password });
}

/**
 * Sign a transaction. Returns { serializedTx: Uint8Array }.
 * The password decrypts the key inside the worker — the key never leaves.
 */
export function signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId, password }) {
    return call('signTransaction', {
        senderAddress,
        recipientAddress,
        value,
        fee,
        message,
        validityStartHeight,
        networkId,
        password,
    });
}

/** Export mnemonic words (requires password). Returns { words: string[] } */
export function exportMnemonic(password) {
    return call('exportMnemonic', { password });
}

/** Verify a password against the stored key. Returns boolean. */
export function verifyPassword(password) {
    return call('verifyPassword', { password });
}

/** Delete the wallet from storage */
export function deleteWallet() {
    return call('deleteWallet');
}
