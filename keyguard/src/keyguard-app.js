// Keyguard App — runs inside the cross-origin keyguard iframe.
// Owns all sensitive flows: key creation, import, signing, export, deletion.
// Passwords never leave this origin. Keys never leave this file's worker.
//
// Replace [WALLET_ORIGIN] with the actual wallet origin before deploying,
// e.g. https://tutanch.github.io
// Replace [WALLET_APP_URL] with the full wallet app URL prefix, e.g.
// https://tutanch.github.io/nimiq-wallet/

const WALLET_ORIGIN = '[WALLET_ORIGIN]';
const WALLET_APP_URL = '[WALLET_APP_URL]';

const ORIGINS_CONFIGURED = !WALLET_ORIGIN.includes('[') && !WALLET_APP_URL.includes('[');

function normalizeUrlPrefix(url) {
    return url.endsWith('/') ? url : `${url}/`;
}

function isAllowedWalletReferrer() {
    if (!ORIGINS_CONFIGURED) return true; // local/dev mode with placeholders
    if (window.parent === window) return true; // direct open for debugging
    // Some browsers/policies strip referrers for cross-origin iframes.
    // In that case we can still rely on strict postMessage origin/source checks.
    if (!document.referrer) return true;
    try {
        const ref = new URL(document.referrer);
        if (ref.origin !== WALLET_ORIGIN) return false;
        // With strict-origin-when-cross-origin, only origin is sent (`/` path).
        // Accept that case to avoid false negatives in production.
        if (!ref.pathname || ref.pathname === '/') return true;
        const expected = new URL(normalizeUrlPrefix(WALLET_APP_URL));
        const expectedPrefix = normalizeUrlPrefix(`${expected.origin}${expected.pathname}`);
        const refUrl = new URL(normalizeUrlPrefix(`${ref.origin}${ref.pathname}`));
        const actualPrefix = `${refUrl.origin}${refUrl.pathname}`;
        return actualPrefix.startsWith(expectedPrefix);
    } catch (_) {
        return false;
    }
}

const EMBED_ALLOWED = isAllowedWalletReferrer();
if (!EMBED_ALLOWED) {
    // Fail closed if the iframe was embedded from an unexpected wallet context.
    document.documentElement.style.display = 'none';
}

function isTrustedWalletEvent(event) {
    if (!EMBED_ALLOWED) return false;
    if (event.origin !== WALLET_ORIGIN) return false;
    if (window.parent !== window && event.source !== window.parent) return false;
    return true;
}

// ── Worker bridge ─────────────────────────────────────────────────────────

let worker = null;
let workerReqId = 0;
const workerPending = new Map();

function getWorker() {
    if (!worker) {
        worker = new Worker(
            new URL('./keyguard-worker.js', import.meta.url),
            { type: 'module' },
        );
        worker.onmessage = (e) => {
            const { id, result, error } = e.data;
            const p = workerPending.get(id);
            if (!p) return;
            workerPending.delete(id);
            error ? p.reject(new Error(error)) : p.resolve(result);
        };
    }
    return worker;
}

function callWorker(command, args) {
    return new Promise((resolve, reject) => {
        const id = ++workerReqId;
        workerPending.set(id, { resolve, reject });
        const transfer = [];
        if (args?.serializedTx instanceof Uint8Array) transfer.push(args.serializedTx.buffer);
        getWorker().postMessage({ id, command, args: args || {} }, transfer);
    });
}

// ── Session tracking ──────────────────────────────────────────────────────
// Only one session is active at a time. The wallet disables its UI during
// keyguard sessions, so concurrent requests cannot occur via normal flow.

let currentSession = null;

function sendToWallet(message, transfer = []) {
    if (!currentSession || !currentSession.source) return;
    try {
        currentSession.source.postMessage(message, currentSession.origin, transfer);
    } catch (_) {}
}

function showUI() {
    sendToWallet({ type: 'show' });
    document.getElementById('keyguard-ui').style.display = '';
}

function hideUI() {
    document.getElementById('keyguard-ui').style.display = 'none';
    sendToWallet({ type: 'hide' });
}

function resolveSession(result, transfer = []) {
    if (!currentSession) return;
    const { source, origin, sessionId } = currentSession;
    currentSession = null;
    document.getElementById('keyguard-ui').style.display = 'none';
    source.postMessage({ type: 'hide' }, origin);   // hide the iframe in the wallet
    source.postMessage({ type: 'result', sessionId, result }, origin, transfer);
}

function rejectSession(errorMsg) {
    if (!currentSession) return;
    const { source, origin, sessionId } = currentSession;
    currentSession = null;
    document.getElementById('keyguard-ui').style.display = 'none';
    source.postMessage({ type: 'hide' }, origin);   // hide the iframe in the wallet
    source.postMessage({ type: 'error', sessionId, error: errorMsg }, origin);
}

// ── HTML helpers ──────────────────────────────────────────────────────────

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showError(el, msg) {
    el.textContent = msg;
    el.style.display = '';
}

function setButtonState(btn, text, disabled) {
    btn.textContent = text;
    btn.disabled = disabled;
}

function formatLuna(lunaValue) {
    const nim = Number(lunaValue) / 100000;
    return nim.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 }) + ' NIM';
}

function formatAddress(addr) {
    const s = String(addr);
    if (s.length <= 22) return s;
    return s.substring(0, 9) + '...' + s.substring(s.length - 9);
}

// ── HTML templates ────────────────────────────────────────────────────────

function renderMnemonicGrid(words, { title, subtitle, confirmText, showCountdown = false }) {
    const wordItems = words.map((word, i) => `
        <div class="mnemonic-word">
            <span class="word-number">${i + 1}</span>
            <span class="word-text">${escHtml(word)}</span>
        </div>`).join('');
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>${escHtml(title)}</h1>
                    <p>${escHtml(subtitle)}</p>
                    ${showCountdown ? '<p class="countdown-text">Words hidden in <span id="countdown">60</span>s</p>' : ''}
                </div>
                <div class="keyguard-body">
                    <div class="mnemonic-grid">${wordItems}</div>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                    <button id="btn-confirm" type="button" class="btn-primary">${escHtml(confirmText)}</button>
                </div>
            </div>
        </div>`;
}

function renderPasswordForm({ title, subtitle, isNew }) {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>${escHtml(title)}</h1>
                    <p>${escHtml(subtitle)}</p>
                </div>
                <form id="pw-form" style="display: contents;">
                    ${isNew ? '<input type="text" autocomplete="username" style="display:none;">' : ''}
                    <div class="keyguard-body">
                        <div class="form-group">
                            <input type="password" class="nq-input" id="password" placeholder="Password"
                                autocomplete="${isNew ? 'new-password' : 'current-password'}">
                        </div>
                        ${isNew ? `
                        <div class="form-group">
                            <input type="password" class="nq-input" id="password-confirm"
                                placeholder="Confirm password" autocomplete="new-password">
                        </div>` : ''}
                        <p class="error-text" id="error" style="display:none;"></p>
                    </div>
                    <div class="keyguard-footer">
                        <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                        <button id="btn-submit" type="submit" class="btn-primary">
                            ${isNew ? 'Confirm' : 'Continue'}
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
}

function renderWordEntry() {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Import Wallet</h1>
                    <p>Enter your 24 recovery words separated by spaces.</p>
                </div>
                <form id="words-form" style="display: contents;">
                    <div class="keyguard-body">
                        <div class="form-group">
                            <textarea class="nq-input mnemonic-input" id="mnemonic" rows="5"
                                placeholder="word1 word2 word3 ... word24"></textarea>
                        </div>
                        <p class="error-text" id="error" style="display:none;"></p>
                    </div>
                    <div class="keyguard-footer">
                        <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                        <button type="submit" class="btn-primary">Continue</button>
                    </div>
                </form>
            </div>
        </div>`;
}

function renderTxConfirm({ amount, recipient, message, fee }) {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Confirm Transaction</h1>
                    <p class="tx-amount-large">${escHtml(amount)}</p>
                </div>
                <div class="keyguard-body">
                    <div class="tx-confirm-row">
                        <span class="tx-label">To</span>
                        <span class="tx-value">${escHtml(recipient)}</span>
                    </div>
                    ${message ? `
                    <div class="tx-confirm-row">
                        <span class="tx-label">Message</span>
                        <span class="tx-value">${escHtml(message)}</span>
                    </div>` : ''}
                    <div class="tx-confirm-row">
                        <span class="tx-label">Fee</span>
                        <span class="tx-value">${escHtml(String(fee))} luna</span>
                    </div>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                    <button id="btn-confirm" type="button" class="btn-primary">Confirm &amp; Sign</button>
                </div>
            </div>
        </div>`;
}

function renderBatchTxConfirm({ recipientCount, totalAmount, feeEach, totalFees, totalCost }) {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Confirm Batch Transaction</h1>
                    <p class="tx-amount-large">${escHtml(totalCost)}</p>
                </div>
                <div class="keyguard-body">
                    <div class="tx-confirm-row">
                        <span class="tx-label">Recipients</span>
                        <span class="tx-value">${escHtml(String(recipientCount))} addresses</span>
                    </div>
                    <div class="tx-confirm-row">
                        <span class="tx-label">Total Amount</span>
                        <span class="tx-value">${escHtml(totalAmount)}</span>
                    </div>
                    <div class="tx-confirm-row">
                        <span class="tx-label">Fee Each</span>
                        <span class="tx-value">${escHtml(feeEach)}</span>
                    </div>
                    <div class="tx-confirm-row">
                        <span class="tx-label">Total Fees</span>
                        <span class="tx-value">${escHtml(totalFees)}</span>
                    </div>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                    <button id="btn-confirm" type="button" class="btn-primary">Confirm &amp; Sign All</button>
                </div>
            </div>
        </div>`;
}

function renderDeleteConfirm({ showPassword = true } = {}) {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Delete Wallet</h1>
                    <p>This removes your wallet from this device. If you set up a passkey, an encrypted backup is kept so you can log back in with it. Make sure you have your recovery words backed up!</p>
                </div>
                <form id="delete-form" style="display: contents;">
                    <div class="keyguard-body">
                        ${showPassword ? `
                        <div class="form-group">
                            <input type="password" class="nq-input" id="password"
                                placeholder="Enter your password" autocomplete="current-password">
                        </div>` : ''}
                        <div class="form-group">
                            <input type="text" class="nq-input" id="confirm-text"
                                placeholder='Type "DELETE" to confirm' autocomplete="off">
                        </div>
                        <p class="error-text" id="error" style="display:none;"></p>
                    </div>
                    <div class="keyguard-footer">
                        <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                        <button id="btn-submit" type="submit" class="btn-primary danger">Delete Wallet</button>
                    </div>
                </form>
            </div>
        </div>`;
}

// ── WebAuthn delegation ───────────────────────────────────────────────────
// The sandboxed iframe cannot call navigator.credentials directly.
// Instead, we send requests to the wallet origin and await its response.

let webauthnReqId = 0;

function requestWebAuthnFromWallet(action, params = {}) {
    return new Promise((resolve, reject) => {
        if (!currentSession || !currentSession.source) {
            reject(new Error('No active wallet session'));
            return;
        }
        const expectedSource = currentSession.source;
        const requestId = `${Date.now()}-${++webauthnReqId}-${Math.random().toString(36).slice(2)}`;

        // Timeout prevents the flow from hanging if the wallet never responds.
        // 120s allows for slow cross-device passkey ceremonies (Bluetooth/QR).
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            reject(new Error('WebAuthn delegation timed out'));
        }, 120000);

        function onMessage(event) {
            if (!isTrustedWalletEvent(event)) return;
            if (event.source !== expectedSource) return;
            if (event.data?.type !== 'webauthn-response') return;
            if (event.data?.requestId !== requestId) return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            if (event.data.error) {
                const err = new Error(event.data.error);
                if (event.data.errorName) err.name = event.data.errorName;
                reject(err);
            } else {
                resolve(event.data.result);
            }
        }
        window.addEventListener('message', onMessage);
        sendToWallet({ type: 'webauthn-request', requestId, action, ...params });
    });
}

async function isPrfSupported() {
    try {
        return await requestWebAuthnFromWallet('isPrfSupported');
    } catch (e) {
        console.debug('PRF support check failed:', e);
        return false;
    }
}

function generatePrfSalt() {
    return crypto.getRandomValues(new Uint8Array(32));
}

async function createWebAuthnCredential(userId, userName, prfSalt) {
    return await requestWebAuthnFromWallet('create', {
        userId: Array.from(userId),
        userName,
        prfSalt: Array.from(prfSalt),
    });
    // Returns { credentialId: number[], prfKey: number[] }
}

async function getWebAuthnPrfKey(credentialId, prfSalt) {
    return await requestWebAuthnFromWallet('get', {
        credentialId: Array.from(new Uint8Array(credentialId)),
        prfSalt: Array.from(new Uint8Array(prfSalt)),
    });
    // Returns number[] (PRF key bytes)
}

// ── WebAuthn UI templates ─────────────────────────────────────────────────

function renderWebAuthnPrompt() {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Enable Biometric Unlock</h1>
                    <p>Use your fingerprint, face, or device PIN for quick access instead of typing your password.</p>
                </div>
                <div class="keyguard-body">
                    <div class="webauthn-icon">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 11c0-1.1.9-2 2-2s2 .9 2 2c0 1.5-1.2 2.7-2 3.5"/>
                            <path d="M12 11c0-2.2 1.8-4 4-4s4 1.8 4 4c0 2.5-2 5-4 6.5"/>
                            <path d="M12 11c0-3.3 2.7-6 6-6s6 2.7 6 6c0 4-3 7.5-6 9.5"/>
                            <path d="M2 11c0-5.5 4.5-10 10-10s10 4.5 10 10"/>
                            <path d="M2 11c0 4.5 3.5 8.5 7 10.5"/>
                            <path d="M7 11c0-2.8 2.2-5 5-5"/>
                            <path d="M7 11c0 3 1.5 5.5 4 7.5"/>
                        </svg>
                    </div>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-skip" type="button" class="btn-secondary">Skip</button>
                    <button id="btn-enable" type="button" class="btn-primary">Enable</button>
                </div>
            </div>
        </div>`;
}

function renderUnlockChoice(title, subtitle) {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>${escHtml(title)}</h1>
                    ${subtitle ? `<p>${escHtml(subtitle)}</p>` : ''}
                </div>
                <div class="keyguard-body unlock-choice-body">
                    <button id="btn-biometric" type="button" class="btn-primary unlock-choice-btn">
                        Use Biometric / Passkey
                    </button>
                    <button id="btn-password" type="button" class="btn-secondary unlock-choice-btn">
                        Use Password
                    </button>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                </div>
            </div>
        </div>`;
}

// ── WebAuthn registration flow ────────────────────────────────────────────

async function offerWebAuthnRegistration(password, addressString) {
    return new Promise((resolve) => {
        setUI(renderWebAuthnPrompt());

        ui.querySelector('#btn-skip').onclick = () => resolve();

        ui.querySelector('#btn-enable').onclick = async () => {
            const btn = ui.querySelector('#btn-enable');
            const errorEl = ui.querySelector('#error');
            setButtonState(btn, 'Registering...', true);

            try {
                const prfSalt = generatePrfSalt();
                const userId = new TextEncoder().encode(addressString.substring(0, 32));
                const { credentialId, prfKey } = await createWebAuthnCredential(
                    userId, addressString, prfSalt,
                );

                await callWorker('saveWebAuthnSecret', {
                    password,
                    prfKey: Array.from(prfKey),
                    credentialId: Array.from(credentialId),
                    prfSalt: Array.from(prfSalt),
                });

                prfKey.fill(0);
                resolve();
            } catch (err) {
                if (err.message === 'PRF_NOT_SUPPORTED') {
                    showError(errorEl, 'Your device does not support this feature.');
                } else if (err.name === 'NotAllowedError') {
                    showError(errorEl, 'Registration was cancelled or timed out.');
                } else {
                    showError(errorEl, 'Could not set up biometric unlock.');
                }
                setButtonState(btn, 'Try Again', false);
            }
        };
    });
}

// ── UI flows ──────────────────────────────────────────────────────────────

const ui = document.getElementById('keyguard-ui');

function setUI(html) {
    ui.innerHTML = html;
}

async function flowCreateWallet() {
    showUI();

    // Generate entropy + mnemonic in the worker
    let walletData;
    try {
        walletData = await callWorker('createWallet');
    } catch (e) {
        return rejectSession(e.message);
    }

    // Step 1: Show 24 mnemonic words
    setUI(renderMnemonicGrid(walletData.mnemonic, {
        title: 'Your Recovery Words',
        subtitle: 'Write these 24 words down and store them safely. They are the only way to recover your wallet.',
        confirmText: "I've saved my words",
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#btn-confirm').onclick = async () => {
        // Clear mnemonic from DOM
        setUI('');

        const prfSupported = await isPrfSupported();

        if (prfSupported) {
            // Step 2a: Offer passkey first (password is optional)
            setUI(renderWebAuthnPrompt());

            ui.querySelector('#btn-skip').onclick = () => {
                // User skipped passkey → fall through to password
                setUI('');
                showCreatePasswordForm(walletData);
            };

            ui.querySelector('#btn-enable').onclick = async () => {
                const btn = ui.querySelector('#btn-enable');
                const errorEl = ui.querySelector('#error');
                setButtonState(btn, 'Registering...', true);

                try {
                    const prfSalt = generatePrfSalt();
                    const userId = new TextEncoder().encode(walletData.address.substring(0, 32));
                    const { credentialId, prfKey } = await createWebAuthnCredential(
                        userId, walletData.address, prfSalt,
                    );

                    // Save wallet with passkey only (no password)
                    await callWorker('saveWallet', {
                        prfKey: Array.from(prfKey),
                        credentialId: Array.from(credentialId),
                        prfSalt: Array.from(prfSalt),
                    });

                    prfKey.fill(0);
                    resolveSession({ address: walletData.address });
                } catch (err) {
                    if (err.message === 'PRF_NOT_SUPPORTED') {
                        showError(errorEl, 'Your device does not support this feature.');
                    } else if (err.name === 'NotAllowedError') {
                        showError(errorEl, 'Registration was cancelled or timed out.');
                    } else {
                        showError(errorEl, 'Could not set up biometric unlock.');
                    }
                    setButtonState(btn, 'Try Again', false);
                }
            };
        } else {
            // Step 2b: No PRF support → password required
            showCreatePasswordForm(walletData);
        }
    };
}

function showCreatePasswordForm(walletData) {
    setUI(renderPasswordForm({
        title: 'Set a Password',
        subtitle: 'This password encrypts your wallet on this device.',
        isNew: true,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const confirm = ui.querySelector('#password-confirm').value;
        const errorEl = ui.querySelector('#error');

        if (pw.length < 8) { showError(errorEl, 'Password must be at least 8 characters.'); return; }
        if (pw !== confirm) { showError(errorEl, 'Passwords do not match.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Saving...', true);
        try {
            await callWorker('saveWallet', { password: pw });
            ui.querySelector('#password').value = '';
            ui.querySelector('#password-confirm').value = '';

            // Offer WebAuthn registration if supported
            if (await isPrfSupported()) {
                await offerWebAuthnRegistration(pw, walletData.address);
            }

            resolveSession({ address: walletData.address });
        } catch (err) {
            ui.querySelector('#password').value = '';
            ui.querySelector('#password-confirm').value = '';
            setButtonState(btn, 'Confirm', false);
            showError(ui.querySelector('#error'), 'Failed to save wallet. Please try again.');
        }
    });
}

async function flowImportWallet() {
    showUI();

    // Step 1: Word entry
    setUI(renderWordEntry());

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#words-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const words = ui.querySelector('#mnemonic').value.trim().split(/\s+/);
        const errorEl = ui.querySelector('#error');
        if (words.length !== 24) { showError(errorEl, 'Please enter exactly 24 words.'); return; }

        // Keep a copy of words for later steps
        const wordsCopy = words.slice();
        setUI('');

        const prfSupported = await isPrfSupported();

        if (prfSupported) {
            // Step 2a: Offer passkey first (password is optional)
            setUI(renderWebAuthnPrompt());

            ui.querySelector('#btn-skip').onclick = () => {
                // User skipped passkey → fall through to password
                setUI('');
                showImportPasswordForm(wordsCopy);
            };

            ui.querySelector('#btn-enable').onclick = async () => {
                const btn = ui.querySelector('#btn-enable');
                const errorEl2 = ui.querySelector('#error');
                setButtonState(btn, 'Registering...', true);

                try {
                    const prfSalt = generatePrfSalt();
                    // Use a temporary address placeholder for credential creation
                    const userId = new TextEncoder().encode('nimiq-import-user');
                    const { credentialId, prfKey } = await createWebAuthnCredential(
                        userId, 'Nimiq Wallet', prfSalt,
                    );

                    // Import wallet with passkey only (no password)
                    const result = await callWorker('importWallet', {
                        words: wordsCopy,
                        prfKey: Array.from(prfKey),
                        credentialId: Array.from(credentialId),
                        prfSalt: Array.from(prfSalt),
                    });

                    prfKey.fill(0);
                    wordsCopy.fill('');
                    resolveSession({ address: result.address });
                } catch (err) {
                    if (err.message === 'PRF_NOT_SUPPORTED') {
                        showError(errorEl2, 'Your device does not support this feature.');
                    } else if (err.name === 'NotAllowedError') {
                        showError(errorEl2, 'Registration was cancelled or timed out.');
                    } else {
                        showError(errorEl2, 'Could not set up biometric unlock.');
                    }
                    setButtonState(btn, 'Try Again', false);
                }
            };
        } else {
            // Step 2b: No PRF support → password required
            showImportPasswordForm(wordsCopy);
        }
    });
}

function showImportPasswordForm(wordsCopy) {
    setUI(renderPasswordForm({
        title: 'Set a Password',
        subtitle: 'This password encrypts your imported wallet.',
        isNew: true,
    }));

    ui.querySelector('#btn-cancel').onclick = () => {
        wordsCopy.fill('');
        rejectSession('User cancelled');
    };
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const confirm = ui.querySelector('#password-confirm').value;
        const errorEl = ui.querySelector('#error');

        if (pw.length < 8) { showError(errorEl, 'Password must be at least 8 characters.'); return; }
        if (pw !== confirm) { showError(errorEl, 'Passwords do not match.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Importing...', true);
        try {
            const result = await callWorker('importWallet', { words: wordsCopy, password: pw });
            ui.querySelector('#password').value = '';
            ui.querySelector('#password-confirm').value = '';
            wordsCopy.fill('');

            // Offer WebAuthn registration if supported
            if (await isPrfSupported()) {
                await offerWebAuthnRegistration(pw, result.address);
            }

            resolveSession({ address: result.address });
        } catch (err) {
            ui.querySelector('#password').value = '';
            ui.querySelector('#password-confirm').value = '';
            wordsCopy.fill('');
            setButtonState(btn, 'Confirm', false);
            showError(ui.querySelector('#error'), 'Invalid recovery words or wrong password.');
        }
    });
}

function showPasswordFormForSign(args, formattedAmount, truncatedRecipient) {
    setUI(renderPasswordForm({
        title: 'Enter Password to Sign',
        subtitle: `Sending ${formattedAmount} to ${truncatedRecipient}`,
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Signing...', true);
        try {
            const { serializedTx } = await callWorker('signTransaction', { ...args, password: pw });
            ui.querySelector('#password').value = '';
            resolveSession({ serializedTx }, [serializedTx.buffer]);
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            const msg = err.message?.includes('Wrong password')
                ? 'Wrong password.'
                : 'Signing failed. Please try again.';
            showError(ui.querySelector('#error'), msg);
        }
    });
}

async function flowSignTransaction(args) {
    showUI();

    const formattedAmount = formatLuna(args.value);
    const truncatedRecipient = formatAddress(args.recipientAddress);

    // Step 1: TX confirmation screen
    setUI(renderTxConfirm({
        amount: formattedAmount,
        recipient: truncatedRecipient,
        message: args.message || '',
        fee: args.fee,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#btn-confirm').onclick = async () => {
        setUI('');

        // Check which auth methods are configured
        const info = await callWorker('getWebAuthnInfo');
        const passwordSet = await callWorker('hasPassword');

        if (info.hasWebAuthn && passwordSet) {
            // Both methods available: offer choice
            setUI(renderUnlockChoice(
                'Authenticate to Sign',
                `Sending ${formattedAmount} to ${truncatedRecipient}`,
            ));

            ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

            ui.querySelector('#btn-biometric').onclick = async () => {
                const btn = ui.querySelector('#btn-biometric');
                const errorEl = ui.querySelector('#error');
                setButtonState(btn, 'Authenticating...', true);

                try {
                    const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                    const { serializedTx } = await callWorker('signTransaction', {
                        ...args, prfKey: Array.from(prfKey),
                    });
                    prfKey.fill(0);
                    resolveSession({ serializedTx }, [serializedTx.buffer]);
                } catch (err) {
                    setButtonState(btn, 'Use Biometric / Passkey', false);
                    if (err.name === 'NotAllowedError') {
                        showError(errorEl, 'Authentication cancelled. Try again or use password.');
                    } else {
                        showError(errorEl, 'Biometric failed. Try again or use password.');
                    }
                }
            };

            ui.querySelector('#btn-password').onclick = () => {
                setUI('');
                showPasswordFormForSign(args, formattedAmount, truncatedRecipient);
            };
        } else if (info.hasWebAuthn) {
            // Passkey only: go straight to biometric
            showBiometricForSign(args, info, formattedAmount, truncatedRecipient);
        } else {
            // Password only: go straight to password
            showPasswordFormForSign(args, formattedAmount, truncatedRecipient);
        }
    };
}

function showBiometricForSign(args, info, formattedAmount, truncatedRecipient) {
    setUI(renderUnlockChoice(
        'Authenticate to Sign',
        `Sending ${formattedAmount} to ${truncatedRecipient}`,
    ));

    // Hide the password button for passkey-only wallets
    const pwBtn = ui.querySelector('#btn-password');
    if (pwBtn) pwBtn.style.display = 'none';

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

    ui.querySelector('#btn-biometric').onclick = async () => {
        const btn = ui.querySelector('#btn-biometric');
        const errorEl = ui.querySelector('#error');
        setButtonState(btn, 'Authenticating...', true);

        try {
            const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
            const { serializedTx } = await callWorker('signTransaction', {
                ...args, prfKey: Array.from(prfKey),
            });
            prfKey.fill(0);
            resolveSession({ serializedTx }, [serializedTx.buffer]);
        } catch (err) {
            setButtonState(btn, 'Use Biometric / Passkey', false);
            if (err.name === 'NotAllowedError') {
                showError(errorEl, 'Authentication cancelled. Try again.');
            } else {
                showError(errorEl, 'Biometric failed. Try again.');
            }
        }
    };
}

// ── Batch transaction signing flow ───────────────────────────────────────

async function flowSignBatchTransaction(args) {
    showUI();

    if (!Array.isArray(args.transactions) || args.transactions.length === 0) {
        rejectSession('No transactions provided');
        return;
    }

    const count = args.transactions.length;
    const firstTx = args.transactions[0];
    const feeEach = formatLuna(firstTx.fee);
    let sumAmount = 0;
    for (const tx of args.transactions) sumAmount += Number(tx.value);
    const totalFee = Number(firstTx.fee) * count;
    const totalCost = formatLuna(sumAmount + totalFee);
    const totalAmount = formatLuna(sumAmount);
    const totalFees = formatLuna(totalFee);

    setUI(renderBatchTxConfirm({
        recipientCount: count,
        totalAmount,
        feeEach,
        totalFees,
        totalCost,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#btn-confirm').onclick = async () => {
        setUI('');

        const info = await callWorker('getWebAuthnInfo');
        const passwordSet = await callWorker('hasPassword');

        const subtitle = `Batch: ${count} transactions, ${totalAmount} total`;

        if (info.hasWebAuthn && passwordSet) {
            setUI(renderUnlockChoice('Authenticate to Sign', subtitle));

            ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

            ui.querySelector('#btn-biometric').onclick = async () => {
                const btn = ui.querySelector('#btn-biometric');
                const errorEl = ui.querySelector('#error');
                setButtonState(btn, 'Signing...', true);

                try {
                    const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                    const { serializedTransactions } = await callWorker('signBatchTransaction', {
                        ...args, prfKey: Array.from(prfKey),
                    });
                    prfKey.fill(0);
                    const transfer = serializedTransactions.map(tx => tx.buffer);
                    resolveSession({ serializedTransactions }, transfer);
                } catch (err) {
                    setButtonState(btn, 'Use Biometric / Passkey', false);
                    if (err.name === 'NotAllowedError') {
                        showError(errorEl, 'Authentication cancelled. Try again or use password.');
                    } else {
                        showError(errorEl, 'Signing failed. Try again or use password.');
                    }
                }
            };

            ui.querySelector('#btn-password').onclick = () => {
                setUI('');
                showPasswordFormForBatchSign(args, subtitle);
            };
        } else if (info.hasWebAuthn) {
            showBiometricForBatchSign(args, info, subtitle);
        } else {
            showPasswordFormForBatchSign(args, subtitle);
        }
    };
}

function showPasswordFormForBatchSign(args, subtitle) {
    setUI(renderPasswordForm({
        title: 'Enter Password to Sign',
        subtitle,
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Signing...', true);
        try {
            const { serializedTransactions } = await callWorker('signBatchTransaction', {
                ...args, password: pw,
            });
            ui.querySelector('#password').value = '';
            const transfer = serializedTransactions.map(tx => tx.buffer);
            resolveSession({ serializedTransactions }, transfer);
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            const msg = err.message?.includes('Wrong password')
                ? 'Wrong password.'
                : 'Signing failed. Please try again.';
            showError(ui.querySelector('#error'), msg);
        }
    });
}

function showBiometricForBatchSign(args, info, subtitle) {
    setUI(renderUnlockChoice('Authenticate to Sign', subtitle));

    const pwBtn = ui.querySelector('#btn-password');
    if (pwBtn) pwBtn.style.display = 'none';

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

    ui.querySelector('#btn-biometric').onclick = async () => {
        const btn = ui.querySelector('#btn-biometric');
        const errorEl = ui.querySelector('#error');
        setButtonState(btn, 'Signing...', true);

        try {
            const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
            const { serializedTransactions } = await callWorker('signBatchTransaction', {
                ...args, prfKey: Array.from(prfKey),
            });
            prfKey.fill(0);
            const transfer = serializedTransactions.map(tx => tx.buffer);
            resolveSession({ serializedTransactions }, transfer);
        } catch (err) {
            setButtonState(btn, 'Use Biometric / Passkey', false);
            if (err.name === 'NotAllowedError') {
                showError(errorEl, 'Authentication cancelled. Try again.');
            } else {
                showError(errorEl, 'Signing failed. Try again.');
            }
        }
    };
}

function showExportedWords(words) {
    setUI(renderMnemonicGrid(words, {
        title: 'Your Recovery Words',
        subtitle: 'Never share these words with anyone.',
        confirmText: 'Done',
        showCountdown: true,
    }));

    // Auto-hide after 60 seconds
    let remaining = 60;
    const countdownEl = ui.querySelector('#countdown');
    const interval = setInterval(() => {
        remaining--;
        if (countdownEl) countdownEl.textContent = remaining;
        if (remaining <= 0) {
            clearInterval(interval);
            ui.querySelectorAll('.word-text').forEach(el => { el.textContent = ''; });
            words.fill('');
            setUI('');
            resolveSession({ success: true });
        }
    }, 1000);

    ui.querySelector('#btn-cancel').onclick = () => {
        clearInterval(interval);
        ui.querySelectorAll('.word-text').forEach(el => { el.textContent = ''; });
        words.fill('');
        rejectSession('User cancelled');
    };
    ui.querySelector('#btn-confirm').onclick = () => {
        clearInterval(interval);
        ui.querySelectorAll('.word-text').forEach(el => { el.textContent = ''; });
        words.fill('');
        setUI('');
        resolveSession({ success: true });
    };
}

function showPasswordFormForExport() {
    setUI(renderPasswordForm({
        title: 'Show Recovery Words',
        subtitle: 'Enter your password to reveal your recovery words.',
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Decrypting...', true);
        try {
            const { words } = await callWorker('exportMnemonic', { password: pw });
            ui.querySelector('#password').value = '';
            setUI('');
            showExportedWords(words);
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            showError(ui.querySelector('#error'), 'Wrong password.');
        }
    });
}

async function flowExportMnemonic() {
    showUI();

    // Check which auth methods are configured
    const info = await callWorker('getWebAuthnInfo');
    const passwordSet = await callWorker('hasPassword');

    if (info.hasWebAuthn && passwordSet) {
        // Both methods available: offer choice
        setUI(renderUnlockChoice(
            'Show Recovery Words',
            'Authenticate to reveal your recovery words.',
        ));

        ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

        ui.querySelector('#btn-biometric').onclick = async () => {
            const btn = ui.querySelector('#btn-biometric');
            const errorEl = ui.querySelector('#error');
            setButtonState(btn, 'Authenticating...', true);

            try {
                const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                const { words } = await callWorker('exportMnemonic', {
                    prfKey: Array.from(prfKey),
                });
                prfKey.fill(0);
                setUI('');
                showExportedWords(words);
            } catch (err) {
                setButtonState(btn, 'Use Biometric / Passkey', false);
                if (err.name === 'NotAllowedError') {
                    showError(errorEl, 'Authentication cancelled. Try again or use password.');
                } else {
                    showError(errorEl, 'Biometric failed. Try again or use password.');
                }
            }
        };

        ui.querySelector('#btn-password').onclick = () => {
            setUI('');
            showPasswordFormForExport();
        };
    } else if (info.hasWebAuthn) {
        // Passkey only: go straight to biometric
        showBiometricForExport(info);
    } else {
        // Password only: go straight to password
        showPasswordFormForExport();
    }
}

function showBiometricForExport(info) {
    setUI(renderUnlockChoice(
        'Show Recovery Words',
        'Authenticate to reveal your recovery words.',
    ));

    // Hide the password button for passkey-only wallets
    const pwBtn = ui.querySelector('#btn-password');
    if (pwBtn) pwBtn.style.display = 'none';

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

    ui.querySelector('#btn-biometric').onclick = async () => {
        const btn = ui.querySelector('#btn-biometric');
        const errorEl = ui.querySelector('#error');
        setButtonState(btn, 'Authenticating...', true);

        try {
            const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
            const { words } = await callWorker('exportMnemonic', {
                prfKey: Array.from(prfKey),
            });
            prfKey.fill(0);
            setUI('');
            showExportedWords(words);
        } catch (err) {
            setButtonState(btn, 'Use Biometric / Passkey', false);
            if (err.name === 'NotAllowedError') {
                showError(errorEl, 'Authentication cancelled. Try again.');
            } else {
                showError(errorEl, 'Biometric failed. Try again.');
            }
        }
    };
}

async function flowDeleteWallet() {
    showUI();

    const passwordSet = await callWorker('hasPassword');
    const info = await callWorker('getWebAuthnInfo');

    if (passwordSet) {
        // Has password: use password + DELETE confirmation
        setUI(renderDeleteConfirm({ showPassword: true }));

        ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
        ui.querySelector('#delete-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const pw = ui.querySelector('#password').value;
            const confirmText = ui.querySelector('#confirm-text').value;
            const errorEl = ui.querySelector('#error');

            if (confirmText !== 'DELETE') { showError(errorEl, 'Please type DELETE to confirm.'); return; }
            if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

            const btn = ui.querySelector('#btn-submit');
            setButtonState(btn, 'Deleting...', true);
            try {
                const valid = await callWorker('verifyPassword', { password: pw });
                ui.querySelector('#password').value = '';
                if (!valid) {
                    setButtonState(btn, 'Delete Wallet', false);
                    showError(errorEl, 'Wrong password.');
                    return;
                }
                await callWorker('deleteWallet');
                resolveSession({ success: true });
            } catch (err) {
                ui.querySelector('#password').value = '';
                setButtonState(btn, 'Delete Wallet', false);
                showError(errorEl, 'Failed to delete wallet.');
            }
        });
    } else if (info.hasWebAuthn) {
        // Passkey only: passkey verification + DELETE confirmation
        setUI(renderDeleteConfirm({ showPassword: false }));

        ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
        ui.querySelector('#delete-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const confirmText = ui.querySelector('#confirm-text').value;
            const errorEl = ui.querySelector('#error');

            if (confirmText !== 'DELETE') { showError(errorEl, 'Please type DELETE to confirm.'); return; }

            const btn = ui.querySelector('#btn-submit');
            setButtonState(btn, 'Authenticating...', true);

            try {
                // Verify identity via passkey
                const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                // Attempt decryption to verify the passkey is valid
                await callWorker('exportMnemonic', { prfKey: Array.from(prfKey) });
                prfKey.fill(0);

                setButtonState(btn, 'Deleting...', true);
                await callWorker('deleteWallet');
                resolveSession({ success: true });
            } catch (err) {
                setButtonState(btn, 'Delete Wallet', false);
                if (err.name === 'NotAllowedError') {
                    showError(errorEl, 'Authentication cancelled.');
                } else {
                    showError(errorEl, 'Failed to delete wallet.');
                }
            }
        });
    } else {
        rejectSession('No authentication method available');
    }
}

// ── Settings: WebAuthn management flows ───────────────────────────────────

async function flowRegisterWebAuthn() {
    showUI();

    // Step 1: Password entry (needed to decrypt entropy for re-encryption with PRF key)
    setUI(renderPasswordForm({
        title: 'Enable Biometric Unlock',
        subtitle: 'Enter your password to set up biometric authentication.',
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        let pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Verifying...', true);

        // Verify password first
        try {
            const valid = await callWorker('verifyPassword', { password: pw });
            if (!valid) {
                ui.querySelector('#password').value = '';
                pw = undefined;
                setButtonState(btn, 'Continue', false);
                showError(errorEl, 'Wrong password.');
                return;
            }
        } catch (e) {
            console.debug('Password verification error:', e);
            ui.querySelector('#password').value = '';
            pw = undefined;
            setButtonState(btn, 'Continue', false);
            showError(errorEl, 'Verification failed.');
            return;
        }

        ui.querySelector('#password').value = '';

        // Step 2: WebAuthn registration
        setUI(renderWebAuthnPrompt());

        ui.querySelector('#btn-skip').onclick = () => rejectSession('User cancelled');

        ui.querySelector('#btn-enable').onclick = async () => {
            const btn2 = ui.querySelector('#btn-enable');
            const errorEl2 = ui.querySelector('#error');
            setButtonState(btn2, 'Registering...', true);

            try {
                const address = await callWorker('getStoredAddress');
                const prfSalt = generatePrfSalt();
                const userId = new TextEncoder().encode((address || '').substring(0, 32));
                const { credentialId, prfKey } = await createWebAuthnCredential(
                    userId, address || 'Nimiq Wallet', prfSalt,
                );

                await callWorker('saveWebAuthnSecret', {
                    password: pw,
                    prfKey: Array.from(prfKey),
                    credentialId: Array.from(credentialId),
                    prfSalt: Array.from(prfSalt),
                });

                // Allow GC of password string sooner (JS strings are immutable
                // so we can't zero them, but we can drop the reference)
                pw = undefined;
                prfKey.fill(0);
                resolveSession({ success: true });
            } catch (err) {
                if (err.message === 'PRF_NOT_SUPPORTED') {
                    showError(errorEl2, 'Your device does not support this feature.');
                } else if (err.name === 'NotAllowedError') {
                    showError(errorEl2, 'Registration was cancelled or timed out.');
                } else {
                    showError(errorEl2, 'Could not set up biometric unlock.');
                }
                setButtonState(btn2, 'Try Again', false);
            }
        };
    });
}

// Fixed PRF salt for cross-device deterministic wallet derivation.
// Same passkey + this salt → same PRF output → same wallet on any device.
const RESTORE_PRF_SALT = new Uint8Array([
    110,105,109,105,113,45,119,97,108,108,101,116,45,112,114,102,
    45,118,49,0,0,0,0,0,0,0,0,0,0,0,0,0,
]); // "nimiq-wallet-prf-v1" padded to 32 bytes

async function flowRestoreWithPasskey(args) {
    showUI();

    // Check for same-device backup first
    let backup;
    try {
        backup = await callWorker('hasPasskeyBackup');
    } catch (_) {
        backup = { hasBackup: false };
    }

    setUI(`
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Login with Passkey</h1>
                    <p>Authenticate with your passkey to access your wallet.</p>
                </div>
                <div class="keyguard-body" style="text-align:center;">
                    <button id="btn-auth" type="button" class="btn-primary">Authenticate</button>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                </div>
            </div>
        </div>
    `);

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#btn-auth').onclick = async () => {
        const btn = ui.querySelector('#btn-auth');
        const errorEl = ui.querySelector('#error');
        setButtonState(btn, 'Authenticating...', true);

        let prfKey;
        let credentialId;
        let prfSalt;
        let fromBackup = false;

        try {
            // Always use discoverable flow so the browser shows the passkey picker.
            // If a backup exists, pass its salt as a second PRF eval so we get
            // both outputs in a single ceremony (no second WebAuthn prompt).
            const params = { prfSalt: Array.from(RESTORE_PRF_SALT) };
            if (backup.hasBackup) {
                params.secondPrfSalt = Array.from(new Uint8Array(backup.prfSalt));
            }
            const result = await requestWebAuthnFromWallet('getForRestore', params);

            // Check if the user selected the backed-up credential
            const selectedId = JSON.stringify(result.credentialId);
            const backupId = backup.hasBackup
                ? JSON.stringify(Array.from(new Uint8Array(backup.credentialId)))
                : null;

            if (backup.hasBackup && selectedId === backupId && result.prfKeySecond) {
                // Selected credential matches backup — decrypt original wallet
                prfKey = result.prfKeySecond;
                credentialId = result.credentialId;
                prfSalt = backup.prfSalt;
                fromBackup = true;
            } else {
                // Different credential or no backup — derive wallet from PRF
                prfKey = result.prfKey;
                credentialId = result.credentialId;
                prfSalt = RESTORE_PRF_SALT;
            }
        } catch (err) {
            setButtonState(btn, 'Authenticate', false);
            if (err.name === 'NotAllowedError') {
                showError(errorEl, 'Authentication cancelled or no passkey found.');
            } else if (err.message === 'PRF output not available') {
                showError(errorEl, 'Your device does not support passkey login.');
            } else {
                showError(errorEl, 'Passkey authentication failed.');
            }
            return;
        }

        // Restore wallet with passkey only (no password needed)
        setButtonState(btn, 'Restoring...', true);
        try {
            const result = await callWorker('restoreWithPasskey', {
                prfKey: Array.from(prfKey),
                credentialId: Array.from(new Uint8Array(credentialId)),
                prfSalt: Array.from(new Uint8Array(prfSalt)),
                fromBackup,
                allowOverwrite: !!args.allowOverwrite,
            });
            if (prfKey.fill) prfKey.fill(0);
            resolveSession({ address: result.address });
        } catch (err) {
            if (prfKey.fill) prfKey.fill(0);
            setButtonState(btn, 'Authenticate', false);
            showError(errorEl, 'Restoration failed: ' + err.message);
        }
    };
}

async function flowUnlock() {
    showUI();

    // Passkey-only wallets don't have a password to verify.
    // They unlock via the lock screen's passkey button (no keyguard needed).
    const passwordSet = await callWorker('hasPassword');
    if (!passwordSet) {
        return rejectSession('No password set. Use your passkey to unlock.');
    }

    setUI(renderPasswordForm({
        title: 'Unlock Wallet',
        subtitle: 'Enter your password to continue.',
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Verifying...', true);
        try {
            const valid = await callWorker('verifyPassword', { password: pw });
            ui.querySelector('#password').value = '';
            if (!valid) {
                setButtonState(btn, 'Continue', false);
                showError(errorEl, 'Wrong password.');
                return;
            }
            resolveSession({ success: true });
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            showError(errorEl, 'Verification failed.');
        }
    });
}

async function flowRemoveWebAuthn() {
    showUI();

    // Block removal if no password is set (would leave no auth method)
    const passwordSet = await callWorker('hasPassword');
    if (!passwordSet) {
        return rejectSession('Cannot disable biometric unlock without a password set.');
    }

    // Password entry to confirm removal
    setUI(renderPasswordForm({
        title: 'Disable Biometric Unlock',
        subtitle: 'Enter your password to remove biometric authentication.',
        isNew: false,
    }));

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Removing...', true);
        try {
            const valid = await callWorker('verifyPassword', { password: pw });
            ui.querySelector('#password').value = '';
            if (!valid) {
                setButtonState(btn, 'Continue', false);
                showError(errorEl, 'Wrong password.');
                return;
            }
            await callWorker('removeWebAuthn');
            resolveSession({ success: true });
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            showError(errorEl, 'Failed to remove biometric unlock.');
        }
    });
}

// ── Main message handler ──────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
    // Strict origin validation — reject anything not from the wallet
    if (!isTrustedWalletEvent(event)) return;

    // Ping/pong: wallet sends this to recover if it missed the initial 'ready'
    if (event.data?.type === 'ping') {
        try { event.source.postMessage({ type: 'ready' }, WALLET_ORIGIN); } catch (_) {}
        return;
    }

    // WebAuthn responses are handled by the requestWebAuthnFromWallet listener — ignore here.
    if (event.data?.type === 'webauthn-response') return;

    const { sessionId, command, args } = event.data;
    if (typeof command !== 'string') return;
    if (!Number.isInteger(sessionId)) return;

    // Transparent passthroughs: no UI, immediate response via worker
    const PASSTHROUGH_COMMANDS = ['hasKey', 'getStoredAddress', 'getWebAuthnInfo', 'hasPassword'];
    if (PASSTHROUGH_COMMANDS.includes(command)) {
        try {
            const result = await callWorker(command);
            event.source.postMessage({ type: 'result', sessionId, result }, WALLET_ORIGIN);
        } catch (e) {
            event.source.postMessage({ type: 'error', sessionId, error: e.message }, WALLET_ORIGIN);
        }
        return;
    }

    // UI flows — establish session context
    if (currentSession) {
        rejectSession('Interrupted by new session');
    }
    currentSession = {
        source: event.source,
        origin: WALLET_ORIGIN,
        sessionId,
    };

    switch (command) {
        case 'createWallet':     flowCreateWallet(); break;
        case 'importWallet':     flowImportWallet(); break;
        case 'signTransaction':  flowSignTransaction(args || {}); break;
        case 'signBatchTransaction': flowSignBatchTransaction(args || {}); break;
        case 'exportMnemonic':   flowExportMnemonic(); break;
        case 'deleteWallet':     flowDeleteWallet(); break;
        case 'unlock':           flowUnlock(); break;
        case 'restoreWithPasskey': flowRestoreWithPasskey(args || {}); break;
        case 'registerWebAuthn': flowRegisterWebAuthn(); break;
        case 'removeWebAuthn':   flowRemoveWebAuthn(); break;
        default:
            rejectSession(`Unknown command: ${command}`);
    }
});

// ── Signal readiness ──────────────────────────────────────────────────────
// Sent after the module has loaded so the wallet knows the keyguard is ready.
try {
    if (EMBED_ALLOWED) {
        window.parent.postMessage({ type: 'ready' }, WALLET_ORIGIN);
    }
} catch (_) {
    // Not embedded — expected when accessing keyguard directly
}
