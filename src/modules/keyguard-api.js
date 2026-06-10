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

function isTrustedKeyguardMessage(event) {
    if (event.origin !== KEYGUARD_ORIGIN) return false;
    const frame = document.getElementById('keyguard-frame');
    return !!frame?.contentWindow && event.source === frame.contentWindow;
}

// ── Keyguard ready promise ─────────────────────────────────────────────────
// Resolves when the keyguard iframe sends { type: 'ready' }.
// main.js awaits this (in parallel with loadNimiq()) before making any calls.

export const keyguardReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        reject(new Error('Keyguard iframe did not load within 15 seconds'));
    }, 15000);

    window.addEventListener('message', function onReady(event) {
        if (!isTrustedKeyguardMessage(event)) return;
        if (event.data?.type === 'ready') {
            clearTimeout(timeout);
            window.removeEventListener('message', onReady);
            resolve();
        }
    });

    // Ping the keyguard so it re-sends 'ready' if it already loaded before
    // this listener was registered (race condition: cached iframe loads fast).
    function ping() {
        const frame = document.getElementById('keyguard-frame');
        if (!frame) return;
        // Only ping if the frame has already loaded cross-origin content.
        // While the frame is still about:blank (same-origin), contentDocument
        // is accessible; Chrome would throw a SecurityError on the postMessage
        // and log it even when caught. Skip here — the load listener handles it.
        let sameOrigin;
        try { sameOrigin = frame.contentDocument !== null; } catch (_) { sameOrigin = false; }
        if (sameOrigin) return;
        try { frame.contentWindow.postMessage({ type: 'ping' }, KEYGUARD_ORIGIN); } catch (_) {}
    }
    ping(); // cover the already-loaded case (cross-origin content present)
    const frame = document.getElementById('keyguard-frame');
    if (frame) frame.addEventListener('load', ping); // cover the still-loading case
});

// ── Theme sync ──────────────────────────────────────────────────────────
// Forwards the wallet's theme setting to the keyguard iframe so it matches.

export function syncThemeToKeyguard() {
    try {
        const frame = getFrame();
        const theme = localStorage.getItem('nimiq-theme') || 'auto';
        frame.contentWindow.postMessage({ type: 'set-theme', theme }, KEYGUARD_ORIGIN);
    } catch (_) {}
}

// Send theme once keyguard is ready
keyguardReady.then(() => syncThemeToKeyguard()).catch(() => {});

// ── Address cache ────────────────────────────────────────────────────────
// Avoids repeated cross-origin postMessage round-trips for hasKey/getStoredAddress.
// Invalidated on deleteWallet, set on create/import/restore.

let cachedAddress = null;

// ── Session tracking ───────────────────────────────────────────────────────

let sessionId = 0;
const pending = new Map(); // sessionId → { resolve, reject }

// ── Message listener (installed at module load time) ───────────────────────

window.addEventListener('message', (event) => {
    if (!isTrustedKeyguardMessage(event)) return;

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

    // Balance request from keyguard — it has no network access, so we fetch balances here.
    if (type === 'balance-request') {
        const { requestId: balReqId, addresses } = event.data;
        handleBalanceRequest(balReqId, addresses, event.source);
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

async function handleBalanceRequest(requestId, addresses, source) {
    const balances = {};
    try {
        // Dynamic import to avoid circular dependency — network-client isn't
        // always connected when keyguard-api loads.
        const { getClient, isConsensusEstablished } = await import('./network-client.js');
        const hasConsensus = await isConsensusEstablished();
        if (hasConsensus && addresses?.length) {
            const client = await getClient();
            const accounts = await client.getAccounts(addresses);
            for (let i = 0; i < addresses.length; i++) {
                balances[addresses[i]] = accounts[i] ? Number(accounts[i].balance) : 0;
            }
        }
    } catch (_) {
        // Network not ready — return empty balances (non-fatal)
    }
    try {
        source.postMessage({ type: 'balance-response', requestId, balances }, KEYGUARD_ORIGIN);
    } catch (_) {}
}

// ── Core send function ─────────────────────────────────────────────────────

// Commands that show keyguard UI — iframe must be visible for user interaction.
const UI_COMMANDS = new Set([
    'createWallet', 'importWallet', 'signTransaction', 'signBatchTransaction',
    'exportMnemonic', 'deleteWallet', 'unlock', 'restoreWithPasskey',
    'registerWebAuthn', 'removeWebAuthn', 'switchAccount',
    'encryptCashlinkData', 'decryptCashlinkData',
    'activatePolygon', 'signPolygonTransaction',
]);

function call(command, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const id = ++sessionId;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Keyguard command '${command}' timed out`));
        }, timeoutMs);
        pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        const frame = getFrame();
        if (!frame.contentWindow) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error('Keyguard iframe blocked — disable Brave Shield or add this site to its exceptions'));
            return;
        }
        // Show the iframe immediately for UI commands instead of waiting
        // for the keyguard's round-trip 'show' message (which can be unreliable).
        if (UI_COMMANDS.has(command)) {
            frame.style.display = '';
        }
        frame.contentWindow.postMessage(
            { sessionId: id, command, args: args || {} },
            KEYGUARD_ORIGIN,
        );
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Check if a wallet exists. Returns cached result after first positive check. */
export function hasKey() {
    if (cachedAddress !== null) return Promise.resolve(true);
    return call('hasKey', null, 15000);
}

/** Get stored wallet address. Returns cached result after first fetch. */
export async function getStoredAddress() {
    if (cachedAddress !== null) return cachedAddress;
    const address = await call('getStoredAddress', null, 15000);
    if (address) cachedAddress = address;
    return address;
}

/**
 * Create new wallet. Keyguard shows mnemonic display + password entry.
 * Returns { address }.
 */
export async function createWallet() {
    const result = await call('createWallet');
    if (result?.address) cachedAddress = result.address;
    return result;
}

/**
 * Import wallet. Keyguard shows word entry + password entry.
 * No args — user enters words and password inside the keyguard.
 * Returns { address }.
 */
export async function importWallet() {
    const result = await call('importWallet');
    if (result?.address) cachedAddress = result.address;
    return result;
}

/**
 * Get all derived addresses for the current wallet. No UI shown.
 * Returns { addresses: [{ index, address }] }.
 */
export function getDerivedAddresses() {
    return call('getDerivedAddresses', null, 15000);
}

/**
 * Sign transaction. Keyguard shows TX confirmation + password entry.
 * No password param — keyguard prompts the user.
 * Returns { serializedTx: Uint8Array }.
 */
export function signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId, addressIndex }) {
    return call('signTransaction', {
        senderAddress,
        recipientAddress,
        value,
        fee,
        message,
        validityStartHeight,
        networkId,
        addressIndex,
    });
}

/**
 * Sign batch transactions. Keyguard shows batch confirmation + password/biometric entry.
 * Signs all transactions with one authentication.
 * If encryptData is provided, also encrypts it in the same auth session.
 * Returns { serializedTransactions: Uint8Array[], encryptedData?: { ciphertext, iv } }.
 */
export function signBatchTransaction({ senderAddress, transactions, addressIndex, encryptData }) {
    return call('signBatchTransaction', { senderAddress, transactions, addressIndex, encryptData }, 300000);
}

// ── Polygon / stablecoins (USDC + USDT) ────────────────────────────────────

/**
 * Get the wallet-level Polygon address (m/44'/60'/0'/0/0). No UI shown.
 * Returns { address: string | null } — null means Polygon support has not
 * been activated for this wallet yet (see activatePolygon).
 */
export function getPolygonAddress() {
    return call('getPolygonAddress', null, 15000);
}

/**
 * One-time Polygon activation for existing wallets: the keyguard asks for
 * authentication, derives the Polygon address from the wallet entropy and
 * stores it. Returns { address }.
 */
export function activatePolygon() {
    return call('activatePolygon');
}

/**
 * Sign a USDC/USDT transfer relayRequest (OpenGSN). The keyguard decodes
 * and validates the request, displays amount/recipient/fee, asks for
 * authentication, RE-ENCODES the calldata with its own signatures and signs
 * the GSN typed data. ALWAYS submit the returned relayRequest (not the one
 * passed in) — the keyguard's re-encoded calldata is the signed one.
 *
 * @param {{token: 'usdc'|'usdt', relayRequest: object,
 *          permit?: {tokenNonce: number}, approval?: {tokenNonce: number}}} args
 * @returns {Promise<{relayRequest: object, signature: string}>}
 */
export function signPolygonTransaction(args) {
    return call('signPolygonTransaction', args, 300000);
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
export async function deleteWallet() {
    const result = await call('deleteWallet');
    cachedAddress = null;
    return result;
}

/**
 * Unlock wallet. Keyguard shows password entry for verification.
 * Returns { success: true }.
 */
export function unlock() {
    return call('unlock');
}

/**
 * Restore wallet from passkey. Keyguard handles authentication + password setup.
 * Works cross-device via iCloud-synced passkeys.
 * Returns { address }.
 */
export async function restoreWithPasskey(opts) {
    const result = await call('restoreWithPasskey', opts || null);
    if (result?.address) cachedAddress = result.address;
    return result;
}

/** Check if WebAuthn is configured. Transparent passthrough — no UI shown. */
export function getWebAuthnInfo() {
    return call('getWebAuthnInfo', null, 15000);
}

/** Check if a password is set. Transparent passthrough — no UI shown. */
export function hasPassword() {
    return call('hasPassword', null, 15000);
}

/**
 * Register WebAuthn credential. Keyguard shows password entry + biometric registration.
 * Returns { success: true }.
 */
export function registerWebAuthn() {
    return call('registerWebAuthn');
}

/**
 * Remove WebAuthn credential. Keyguard shows password confirmation.
 * Returns { success: true }.
 */
export function removeWebAuthn() {
    return call('removeWebAuthn');
}

/**
 * Switch active account. Keyguard shows passkey auth + account picker with balances.
 * Returns { address }.
 */
export async function switchAccount() {
    const result = await call('switchAccount');
    if (result?.address) cachedAddress = result.address;
    return result;
}

/**
 * Generate cashlink keypairs. Non-UI command — keyguard iframe stays hidden.
 * Returns { keys: [{ address: string, privateKeyBytes: number[] }] }.
 */
export function generateCashlinkKeys({ count }) {
    return call('generateCashlinkKeys', { count }, 30000);
}

/**
 * Encrypt cashlink data. Keyguard shows auth prompt (passkey/password).
 * Returns { ciphertext: number[], iv: number[] }.
 */
export function encryptCashlinkData({ data }) {
    return call('encryptCashlinkData', { data });
}

/**
 * Decrypt cashlink data. Keyguard shows auth prompt (passkey/password).
 * Returns { data: string }.
 */
export function decryptCashlinkData({ ciphertext, iv }) {
    return call('decryptCashlinkData', { ciphertext, iv });
}

/**
 * Derive addresses from cashlink private keys. No UI shown.
 * Returns { addresses: string[] }.
 */
export function getCashlinkAddresses({ privateKeys }) {
    return call('getCashlinkAddresses', { privateKeys }, 30000);
}

/**
 * Sign cashlink claim transactions using the cashlink private keys. No UI shown.
 * Returns { serializedTransactions: Uint8Array[] }.
 */
export function signCashlinkClaims({ claims }) {
    return call('signCashlinkClaims', { claims }, 60000);
}
