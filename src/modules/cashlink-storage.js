// Cashlink run storage — encrypted localStorage CRUD.
// All encryption/decryption is delegated to the keyguard (UI commands that
// prompt for passkey/password). The wallet only stores opaque ciphertext.

import { encryptCashlinkData, decryptCashlinkData } from './keyguard-api.js';

const RUNS_META_KEY = 'cashlink-runs';
const RUN_DATA_PREFIX = 'cashlink-run-';

// ── Base64 helpers ────────────────────────────────────────────────────

function arrayToBase64(arr) {
    let binary = '';
    for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
    return btoa(binary);
}

function base64ToArray(base64) {
    const binary = atob(base64);
    const arr = [];
    for (let i = 0; i < binary.length; i++) arr.push(binary.charCodeAt(i));
    return arr;
}

// ── Public API ────────────────────────────────────────────────────────

/** List all saved run metadata (no auth needed). Returns newest-first. */
export function getSavedRunsMeta() {
    try {
        const raw = localStorage.getItem(RUNS_META_KEY);
        if (!raw) return [];
        return JSON.parse(raw).sort((a, b) => b.date - a.date);
    } catch (_) { return []; }
}

/**
 * Save a cashlink run. Shows keyguard auth prompt (passkey/password).
 * @param {{ urls: string[], addresses: string[], amountNim: string, message: string }} opts
 * @returns {Promise<string>} The generated run ID
 */
export async function saveCashlinkRun({ urls, addresses, amountNim, message }) {
    const payload = JSON.stringify({ urls, addresses });
    const { ciphertext, iv } = await encryptCashlinkData({ data: payload });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = {
        id,
        date: Date.now(),
        count: urls.length,
        amountNim,
        message: message || '',
    };

    const runs = getSavedRunsMeta();
    runs.push(meta);
    localStorage.setItem(RUNS_META_KEY, JSON.stringify(runs));
    localStorage.setItem(RUN_DATA_PREFIX + id, JSON.stringify({
        ciphertext: arrayToBase64(ciphertext),
        iv: arrayToBase64(iv),
    }));

    return id;
}

/**
 * Save a cashlink run with already-encrypted data (no auth needed).
 * Used when encryption was piggybacked on the signing step.
 * @param {{ ciphertext: number[], iv: number[], count: number, amountNim: string, message: string }} opts
 * @returns {string} The generated run ID
 */
export function savePreEncryptedRun({ ciphertext, iv, count, amountNim, message }) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const meta = {
        id,
        date: Date.now(),
        count,
        amountNim,
        message: message || '',
    };

    const runs = getSavedRunsMeta();
    runs.push(meta);
    localStorage.setItem(RUNS_META_KEY, JSON.stringify(runs));
    localStorage.setItem(RUN_DATA_PREFIX + id, JSON.stringify({
        ciphertext: arrayToBase64(ciphertext),
        iv: arrayToBase64(iv),
    }));

    return id;
}

/**
 * Load a saved run's URLs and addresses. Shows keyguard auth prompt.
 * @param {string} id  Run ID
 * @returns {Promise<{ urls: string[], addresses: string[] }>}
 */
export async function loadCashlinkRun(id) {
    const raw = localStorage.getItem(RUN_DATA_PREFIX + id);
    if (!raw) throw new Error('Run not found');
    const stored = JSON.parse(raw);

    const { data } = await decryptCashlinkData({
        ciphertext: base64ToArray(stored.ciphertext),
        iv: base64ToArray(stored.iv),
    });

    return JSON.parse(data);
}

/** Delete a saved run (no auth needed — data is encrypted). */
export function deleteCashlinkRun(id) {
    localStorage.removeItem(RUN_DATA_PREFIX + id);
    const runs = getSavedRunsMeta();
    localStorage.setItem(RUNS_META_KEY, JSON.stringify(runs.filter(r => r.id !== id)));
}
