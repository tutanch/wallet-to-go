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

/**
 * Pick `count` unique random indices from [0, total).
 * Uses crypto.getRandomValues for consistency with keyguard security posture.
 * Returns a sorted array of indices.
 */
function pickRandomIndices(total, count) {
    const indices = new Set();
    while (indices.size < count) {
        const buf = new Uint8Array(1);
        crypto.getRandomValues(buf);
        indices.add(buf[0] % total);
    }
    return Array.from(indices).sort((a, b) => a - b);
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

function renderMnemonicGridEnhanced(words, { title, subtitle, countdownSeconds }) {
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
                </div>
                <div class="keyguard-body">
                    <div class="warning-banner">
                        <span class="warning-icon">&#9888;</span>
                        <span>Write these words on paper NOW. You will be asked to verify them next.</span>
                    </div>
                    <div class="mnemonic-grid">${wordItems}</div>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                    <button id="btn-confirm" type="button" class="btn-primary" disabled>
                        Wait <span id="countdown">${countdownSeconds}</span>s
                    </button>
                </div>
            </div>
        </div>`;
}

function renderVerificationChallenge(challenges) {
    const fields = challenges.map((c, i) => `
        <div class="verify-field" data-index="${i}">
            <label class="verify-label" for="verify-${i}">Word #${c.position}</label>
            <input type="text" class="nq-input verify-input" id="verify-${i}"
                placeholder="Type word #${c.position}" autocomplete="off"
                autocapitalize="none" spellcheck="false" data-position="${c.position}">
            <p class="error-text verify-error" id="verify-error-${i}" style="display:none;"></p>
        </div>`).join('');

    const dots = challenges.map((_, i) =>
        `<span class="verify-dot" id="dot-${i}"></span>`
    ).join('');

    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Verify Your Backup</h1>
                    <p>Enter the requested words to confirm you wrote them down.</p>
                    <div class="verify-progress">${dots}</div>
                </div>
                <div class="keyguard-body">
                    <div class="verify-fields">${fields}</div>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-back" type="button" class="btn-secondary">Show words again</button>
                    <button id="btn-verify" type="button" class="btn-primary" disabled>Verify</button>
                </div>
            </div>
        </div>`;
}

function renderAcknowledgment() {
    const sentence = 'I understand my recovery words are my only backup';
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Important: Read Carefully</h1>
                </div>
                <div class="keyguard-body">
                    <div class="warning-banner warning-banner-danger">
                        <span class="warning-icon">&#9888;</span>
                        <span>If this website becomes unavailable, your passkey will <strong>NOT</strong> be able to recover your funds. Your 24 recovery words are the <strong>ONLY</strong> way to restore access to your wallet.</span>
                    </div>
                    <div class="form-group" style="margin-top: 16px;">
                        <label class="verify-label" for="ack-input">Type the following sentence to continue:</label>
                        <p style="font-style:italic;color:var(--text-hint);font-size:13px;margin:6px 0 10px;">
                            "${escHtml(sentence)}"
                        </p>
                        <textarea class="nq-input ack-sentence-input" id="ack-input" rows="2"
                            placeholder="${escHtml(sentence)}" autocomplete="off"
                            autocapitalize="none" spellcheck="false"></textarea>
                        <div class="ack-match-display" id="ack-match"></div>
                    </div>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-back" type="button" class="btn-secondary">Back</button>
                    <button id="btn-confirm" type="button" class="btn-primary" disabled>Confirm</button>
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

function renderDeleteConfirm() {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Log Out</h1>
                    <p>This removes your wallet from this device. If you set up a passkey, you can log back in with it. Make sure you have your recovery words backed up!</p>
                </div>
                <form id="delete-form" style="display: contents;">
                    <div class="keyguard-body">
                        <div class="form-group">
                            <input type="text" class="nq-input" id="confirm-text"
                                placeholder='Type "LOGOUT" to confirm' autocomplete="off">
                        </div>
                        <p class="error-text" id="error" style="display:none;"></p>
                    </div>
                    <div class="keyguard-footer">
                        <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                        <button id="btn-submit" type="submit" class="btn-primary danger">Log Out</button>
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

function nextPasskeyName() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
    return `Nimiq Wallet (${stamp})`;
}

// Get existing credential IDs to prevent the platform from silently
// overwriting credentials during a new create() ceremony.
async function getExcludeCredentialIds() {
    try {
        const info = await callWorker('getWebAuthnInfo');
        if (info.hasWebAuthn && info.credentialId) {
            return [Array.from(new Uint8Array(info.credentialId))];
        }
    } catch (_) {}
    return [];
}

async function createWebAuthnCredential(userId, userName, prfSalt) {
    const excludeCredentialIds = await getExcludeCredentialIds();
    return await requestWebAuthnFromWallet('create', {
        userId: Array.from(userId),
        userName,
        prfSalt: Array.from(prfSalt),
        excludeCredentialIds,
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

// ── Balance lookup delegation ─────────────────────────────────────────────
// The keyguard has no network access (connect-src 'none'), so it asks the
// wallet to look up balances via the same postMessage channel.

let balanceReqId = 0;

function requestBalancesFromWallet(addresses) {
    return new Promise((resolve, reject) => {
        if (!currentSession || !currentSession.source) {
            resolve({}); // no session → return empty
            return;
        }
        const expectedSource = currentSession.source;
        const requestId = `bal-${++balanceReqId}`;
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve({}); // timeout → return empty (non-fatal)
        }, 15000);

        function onMessage(event) {
            if (!isTrustedWalletEvent(event)) return;
            if (event.source !== expectedSource) return;
            if (event.data?.type !== 'balance-response') return;
            if (event.data?.requestId !== requestId) return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(event.data.balances || {});
        }
        window.addEventListener('message', onMessage);
        sendToWallet({ type: 'balance-request', requestId, addresses });
    });
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
                            <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/>
                            <path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>
                            <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/>
                            <path d="M2 12a10 10 0 0 1 18-6"/>
                            <path d="M2 16h.01"/>
                            <path d="M21.8 16c.2-2 .131-5.354 0-6"/>
                            <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>
                            <path d="M8.65 22c.21-.66.45-1.32.57-2"/>
                            <path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>
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

// ── UI flows ──────────────────────────────────────────────────────────────

const ui = document.getElementById('keyguard-ui');

function setUI(html) {
    ui.innerHTML = html;
}

// Track the next account index for multi-account passkey wallets.
function getNextAccountIndex() {
    return parseInt(localStorage.getItem('nimiq-account-idx') || '0', 10);
}
function bumpAccountIndex() {
    const next = getNextAccountIndex() + 1;
    localStorage.setItem('nimiq-account-idx', String(next));
    return next;
}

// ── Mnemonic backup verification flow (3 screens) ────────────────────────

function showEnhancedMnemonicScreen(words, walletData, prfKey, credentialId) {
    const COUNTDOWN_SECONDS = 10;

    setUI(renderMnemonicGridEnhanced(words, {
        title: 'Your Recovery Words',
        subtitle: 'Write these 24 words down on paper and store them safely.',
        countdownSeconds: COUNTDOWN_SECONDS,
    }));

    const btnConfirm = ui.querySelector('#btn-confirm');
    const countdownEl = ui.querySelector('#countdown');
    let remaining = COUNTDOWN_SECONDS;

    const interval = setInterval(() => {
        remaining--;
        if (countdownEl) countdownEl.textContent = remaining;
        if (remaining <= 0) {
            clearInterval(interval);
            btnConfirm.disabled = false;
            btnConfirm.textContent = "I've written them down";
        }
    }, 1000);

    ui.querySelector('#btn-cancel').onclick = () => {
        clearInterval(interval);
        prfKey.fill(0);
        words.fill('');
        rejectSession('User cancelled');
    };

    btnConfirm.onclick = () => {
        clearInterval(interval);
        showVerificationScreen(words, walletData, prfKey, credentialId);
    };
}

function showVerificationScreen(words, walletData, prfKey, credentialId) {
    const CHALLENGE_COUNT = 3;
    const indices = pickRandomIndices(words.length, CHALLENGE_COUNT);
    const challenges = indices.map(idx => ({
        position: idx + 1,
        answer: words[idx],
    }));

    setUI(renderVerificationChallenge(challenges));

    const inputs = challenges.map((_, i) => ui.querySelector(`#verify-${i}`));
    const errors = challenges.map((_, i) => ui.querySelector(`#verify-error-${i}`));
    const dots = challenges.map((_, i) => ui.querySelector(`#dot-${i}`));
    const btnVerify = ui.querySelector('#btn-verify');

    const correct = new Array(CHALLENGE_COUNT).fill(false);

    function updateVerifyButton() {
        const allCorrect = correct.every(Boolean);
        btnVerify.disabled = !allCorrect;
        if (allCorrect) {
            btnVerify.classList.add('btn-verify-ready');
        } else {
            btnVerify.classList.remove('btn-verify-ready');
        }
    }

    inputs.forEach((input, i) => {
        input.addEventListener('input', () => {
            const val = input.value.trim().toLowerCase();
            const expected = challenges[i].answer.toLowerCase();

            if (val === '') {
                errors[i].style.display = 'none';
                input.classList.remove('verify-correct', 'verify-wrong');
                dots[i].classList.remove('dot-correct');
                correct[i] = false;
            } else if (val === expected) {
                errors[i].style.display = 'none';
                input.classList.remove('verify-wrong');
                input.classList.add('verify-correct');
                dots[i].classList.add('dot-correct');
                correct[i] = true;
            } else if (val.length >= expected.length) {
                showError(errors[i], 'Incorrect. Check your written words.');
                input.classList.remove('verify-correct');
                input.classList.add('verify-wrong');
                dots[i].classList.remove('dot-correct');
                correct[i] = false;
            } else {
                errors[i].style.display = 'none';
                input.classList.remove('verify-correct', 'verify-wrong');
                dots[i].classList.remove('dot-correct');
                correct[i] = false;
            }

            updateVerifyButton();
        });
    });

    inputs[0].focus();

    ui.querySelector('#btn-back').onclick = () => {
        showEnhancedMnemonicScreen(words, walletData, prfKey, credentialId);
    };

    btnVerify.onclick = () => {
        showAcknowledgmentScreen(words, walletData, prfKey, credentialId);
    };
}

function showAcknowledgmentScreen(words, walletData, prfKey, credentialId) {
    const REQUIRED_SENTENCE = 'I understand my recovery words are my only backup';

    setUI(renderAcknowledgment());

    const input = ui.querySelector('#ack-input');
    const matchDisplay = ui.querySelector('#ack-match');
    const btnConfirm = ui.querySelector('#btn-confirm');

    input.addEventListener('input', () => {
        const val = input.value;
        const target = REQUIRED_SENTENCE;

        // Build character-by-character match display
        let correctLen = 0;
        for (let i = 0; i < val.length && i < target.length; i++) {
            if (val[i].toLowerCase() === target[i].toLowerCase()) {
                correctLen++;
            } else {
                break;
            }
        }

        const correctPart = target.substring(0, correctLen);
        const wrongPart = val.substring(correctLen);
        const remainingPart = target.substring(Math.max(correctLen, val.length));

        matchDisplay.innerHTML = '';
        if (correctPart) {
            const span = document.createElement('span');
            span.className = 'ack-match-correct';
            span.textContent = correctPart;
            matchDisplay.appendChild(span);
        }
        if (wrongPart) {
            const span = document.createElement('span');
            span.className = 'ack-match-wrong';
            span.textContent = wrongPart;
            matchDisplay.appendChild(span);
        }
        if (remainingPart) {
            const span = document.createElement('span');
            span.className = 'ack-match-remaining';
            span.textContent = remainingPart;
            matchDisplay.appendChild(span);
        }

        const isMatch = val.trim().toLowerCase() === target.toLowerCase();
        btnConfirm.disabled = !isMatch;
        if (isMatch) {
            btnConfirm.classList.add('btn-verify-ready');
        } else {
            btnConfirm.classList.remove('btn-verify-ready');
        }
    });

    input.focus();

    ui.querySelector('#btn-back').onclick = () => {
        showVerificationScreen(words, walletData, prfKey, credentialId);
    };

    btnConfirm.onclick = async () => {
        setButtonState(btnConfirm, 'Saving...', true);
        try {
            await callWorker('saveWallet', {
                prfKey: Array.from(prfKey),
                credentialId: Array.from(credentialId),
                prfSalt: Array.from(RESTORE_PRF_SALT),
            });
            prfKey.fill(0);
            words.fill('');
            bumpAccountIndex();
            resolveSession({ address: walletData.address });
        } catch (err) {
            setButtonState(btnConfirm, 'Confirm', false);
            showError(ui.querySelector('#error'), 'Failed to save wallet. Please try again.');
        }
    };
}

async function flowCreateWallet() {
    showUI();

    // Passkey is mandatory — wallet entropy is derived deterministically from
    // HKDF(PRF_output, account_index). Each index produces a unique
    // wallet, and scanning indices on another device restores them all.
    setUI(renderWebAuthnPrompt());

    // No skip/fallback — cancel is the only alternative
    ui.querySelector('#btn-skip').textContent = 'Cancel';
    ui.querySelector('#btn-skip').onclick = () => rejectSession('User cancelled');

    ui.querySelector('#btn-enable').onclick = async () => {
        const btn = ui.querySelector('#btn-enable');
        const errorEl = ui.querySelector('#error');
        setButtonState(btn, 'Registering...', true);

        try {
            const accountIndex = getNextAccountIndex();
            // user.id MUST be random — it controls credential deduplication
            // on the platform. If deterministic, a new browser session would
            // overwrite the old passkey (same RP + same user.id = replace).
            // The account index for wallet derivation is passed separately
            // to createWalletFromPrf.
            const userId = crypto.getRandomValues(new Uint8Array(32));
            const { credentialId, prfKey } = await createWebAuthnCredential(
                userId, nextPasskeyName(), RESTORE_PRF_SALT,
            );

            // Derive wallet deterministically from PRF output + account index
            const walletData = await callWorker('createWalletFromPrf', {
                prfKey: Array.from(prfKey),
                accountIndex,
            });

            // Show mnemonic with verification challenge before saving
            showEnhancedMnemonicScreen(walletData.mnemonic, walletData, prfKey, credentialId);
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

        // Passkey is mandatory for import
        setUI(renderWebAuthnPrompt());

        // No skip/fallback — cancel is the only alternative
        ui.querySelector('#btn-skip').textContent = 'Cancel';
        ui.querySelector('#btn-skip').onclick = () => {
            wordsCopy.fill('');
            rejectSession('User cancelled');
        };

        ui.querySelector('#btn-enable').onclick = async () => {
            const btn = ui.querySelector('#btn-enable');
            const errorEl2 = ui.querySelector('#error');
            setButtonState(btn, 'Registering...', true);

            try {
                const prfSalt = generatePrfSalt();
                const userId = crypto.getRandomValues(new Uint8Array(32));
                const { credentialId, prfKey } = await createWebAuthnCredential(
                    userId, nextPasskeyName(), prfSalt,
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

    setUI(renderDeleteConfirm());

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#delete-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const confirmText = ui.querySelector('#confirm-text').value;
        const errorEl = ui.querySelector('#error');

        if (confirmText !== 'LOGOUT') { showError(errorEl, 'Please type LOGOUT to confirm.'); return; }

        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Logging out...', true);
        try {
            await callWorker('deleteWallet');
            resolveSession({ success: true });
        } catch (err) {
            setButtonState(btn, 'Log Out', false);
            showError(errorEl, 'Failed to log out.');
        }
    });
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
                const prfSalt = generatePrfSalt();
                const userId = crypto.getRandomValues(new Uint8Array(32));
                const { credentialId, prfKey } = await createWebAuthnCredential(
                    userId, nextPasskeyName(), prfSalt,
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

function renderAccountPicker(addresses, balances = {}) {
    const rows = addresses.map(({ index, address }) => {
        const bal = balances[address];
        const balText = bal !== undefined ? formatLuna(bal) : '';
        return `
        <button type="button" class="account-row" data-index="${index}">
            <span class="account-index">#${index + 1}</span>
            <span class="account-details">
                <span class="account-address">${escHtml(address)}</span>
                ${balText ? `<span class="account-balance">${escHtml(balText)}</span>` : ''}
            </span>
        </button>`;
    }).join('');
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Select Wallet</h1>
                    <p>Choose which wallet to activate.</p>
                </div>
                <div class="keyguard-body" style="max-height:340px;overflow-y:auto;">
                    <div class="account-list">${rows}</div>
                </div>
                <div class="keyguard-footer">
                    <button id="btn-cancel" type="button" class="btn-secondary">Cancel</button>
                    <p class="error-text" id="error" style="display:none;"></p>
                </div>
            </div>
        </div>`;
}

// Shared helper: scan accounts, fetch balances, show picker, restore selected.
// Used by both restoreWithPasskey and switchAccount flows.
async function showAccountPickerFlow({ prfKey, credentialId, allowOverwrite, errorEl }) {
    let addresses;
    try {
        const scan = await callWorker('scanAccountAddresses', {
            prfKey: Array.from(prfKey),
            maxIndex: 9,
        });
        addresses = scan.addresses;
    } catch (err) {
        if (prfKey.fill) prfKey.fill(0);
        if (errorEl) showError(errorEl, 'Failed to scan accounts.');
        else rejectSession('Failed to scan accounts.');
        return;
    }

    // Ask the wallet for balances (non-blocking — shows picker immediately,
    // balances fill in when ready).
    const addrList = addresses.map(a => a.address);

    // Show picker immediately (without balances)
    setUI(renderAccountPicker(addresses));
    attachPickerHandlers({ addresses, prfKey, credentialId, allowOverwrite });

    // Then fetch balances and re-render with them
    const balances = await requestBalancesFromWallet(addrList);
    if (Object.keys(balances).length > 0) {
        setUI(renderAccountPicker(addresses, balances));
        attachPickerHandlers({ addresses, prfKey, credentialId, allowOverwrite });
    }
}

function attachPickerHandlers({ addresses, prfKey, credentialId, allowOverwrite }) {
    ui.querySelector('#btn-cancel').onclick = () => {
        if (prfKey.fill) prfKey.fill(0);
        rejectSession('User cancelled');
    };
    ui.querySelectorAll('.account-row').forEach(row => {
        row.onclick = async () => {
            const idx = parseInt(row.dataset.index, 10);
            ui.querySelectorAll('.account-row').forEach(r => { r.disabled = true; });
            row.style.opacity = '0.6';
            try {
                const result = await callWorker('restoreWithPasskey', {
                    prfKey: Array.from(prfKey),
                    credentialId: Array.from(new Uint8Array(credentialId)),
                    prfSalt: Array.from(RESTORE_PRF_SALT),
                    accountIndex: idx,
                    allowOverwrite: !!allowOverwrite,
                });
                if (prfKey.fill) prfKey.fill(0);
                resolveSession({ address: result.address });
            } catch (err) {
                if (prfKey.fill) prfKey.fill(0);
                const pickerError = ui.querySelector('#error');
                if (pickerError) {
                    showError(pickerError, 'Failed: ' + err.message);
                    ui.querySelectorAll('.account-row').forEach(r => {
                        r.disabled = false;
                        r.style.opacity = '';
                    });
                }
            }
        };
    });
}

async function flowRestoreWithPasskey(args) {
    showUI();

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

        try {
            const params = { prfSalt: Array.from(RESTORE_PRF_SALT) };
            const result = await requestWebAuthnFromWallet('getForRestore', params);
            prfKey = result.prfKey;
            credentialId = result.credentialId;
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

        // Scan account indices and show the picker with balances
        setButtonState(btn, 'Scanning accounts...', true);
        await showAccountPickerFlow({ prfKey, credentialId, allowOverwrite: !!args.allowOverwrite, errorEl });
    };
}

async function flowSwitchAccount() {
    showUI();

    // Same flow as restore, but triggered from within the app (settings).
    // Always allows overwrite since the user is intentionally switching.
    setUI(`
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Switch Account</h1>
                    <p>Authenticate with your passkey, then pick an account.</p>
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

        try {
            const params = { prfSalt: Array.from(RESTORE_PRF_SALT) };
            const result = await requestWebAuthnFromWallet('getForRestore', params);
            prfKey = result.prfKey;
            credentialId = result.credentialId;
        } catch (err) {
            setButtonState(btn, 'Authenticate', false);
            if (err.name === 'NotAllowedError') {
                showError(errorEl, 'Authentication cancelled.');
            } else {
                showError(errorEl, 'Passkey authentication failed.');
            }
            return;
        }

        setButtonState(btn, 'Scanning accounts...', true);
        await showAccountPickerFlow({ prfKey, credentialId, allowOverwrite: true, errorEl });
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

// ── Cashlink data encrypt/decrypt ─────────────────────────────────────────
// Generic auth flow for encrypting or decrypting cashlink run data.
// Shows passkey/password choice, then calls the specified worker command.

async function flowCashlinkCrypto(args, workerCommand, title) {
    showUI();

    const info = await callWorker('getWebAuthnInfo');
    const passwordSet = await callWorker('hasPassword');

    if (info.hasWebAuthn && passwordSet) {
        setUI(renderUnlockChoice(title, title));
        ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

        ui.querySelector('#btn-biometric').onclick = async () => {
            const btn = ui.querySelector('#btn-biometric');
            const errorEl = ui.querySelector('#error');
            setButtonState(btn, 'Processing...', true);
            try {
                const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                const result = await callWorker(workerCommand, {
                    ...args, prfKey: Array.from(prfKey),
                });
                prfKey.fill(0);
                resolveSession(result);
            } catch (err) {
                setButtonState(btn, 'Use Biometric / Passkey', false);
                showError(errorEl, err.name === 'NotAllowedError'
                    ? 'Authentication cancelled. Try again or use password.'
                    : 'Failed. Try again or use password.');
            }
        };

        ui.querySelector('#btn-password').onclick = () => {
            setUI('');
            showPasswordFormForCashlinkCrypto(args, workerCommand, title);
        };
    } else if (info.hasWebAuthn) {
        setUI(renderUnlockChoice(title, title));
        const pwBtn = ui.querySelector('#btn-password');
        if (pwBtn) pwBtn.style.display = 'none';
        ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');

        ui.querySelector('#btn-biometric').onclick = async () => {
            const btn = ui.querySelector('#btn-biometric');
            const errorEl = ui.querySelector('#error');
            setButtonState(btn, 'Processing...', true);
            try {
                const prfKey = await getWebAuthnPrfKey(info.credentialId, info.prfSalt);
                const result = await callWorker(workerCommand, {
                    ...args, prfKey: Array.from(prfKey),
                });
                prfKey.fill(0);
                resolveSession(result);
            } catch (err) {
                setButtonState(btn, 'Use Biometric / Passkey', false);
                showError(errorEl, err.name === 'NotAllowedError'
                    ? 'Authentication cancelled. Try again.'
                    : 'Failed. Try again.');
            }
        };
    } else {
        showPasswordFormForCashlinkCrypto(args, workerCommand, title);
    }
}

function showPasswordFormForCashlinkCrypto(args, workerCommand, title) {
    setUI(renderPasswordForm({ title: 'Enter Password', subtitle: title, isNew: false }));
    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = ui.querySelector('#password').value;
        const errorEl = ui.querySelector('#error');
        if (!pw) { showError(errorEl, 'Please enter your password.'); return; }
        const btn = ui.querySelector('#btn-submit');
        setButtonState(btn, 'Processing...', true);
        try {
            const result = await callWorker(workerCommand, { ...args, password: pw });
            ui.querySelector('#password').value = '';
            resolveSession(result);
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(btn, 'Continue', false);
            showError(errorEl, err.message?.includes('Wrong password')
                ? 'Wrong password.' : 'Failed. Please try again.');
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

    // Theme sync: wallet forwards its theme setting so keyguard matches
    if (event.data?.type === 'set-theme') {
        const theme = event.data.theme;
        if (theme === 'light' || theme === 'dark') {
            document.documentElement.setAttribute('data-theme', theme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        return;
    }

    // WebAuthn responses are handled by the requestWebAuthnFromWallet listener — ignore here.
    if (event.data?.type === 'webauthn-response') return;

    // Balance responses are handled by the requestBalancesFromWallet listener — ignore here.
    if (event.data?.type === 'balance-response') return;

    const { sessionId, command, args } = event.data;
    if (typeof command !== 'string') return;
    if (!Number.isInteger(sessionId)) return;

    // Transparent passthroughs: no UI, immediate response via worker
    const PASSTHROUGH_COMMANDS = ['hasKey', 'getStoredAddress', 'getWebAuthnInfo', 'hasPassword', 'getDerivedAddresses', 'generateCashlinkKeys', 'getCashlinkAddresses', 'signCashlinkClaims'];
    if (PASSTHROUGH_COMMANDS.includes(command)) {
        try {
            const result = await callWorker(command, args);
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
        case 'switchAccount':    flowSwitchAccount(); break;
        case 'encryptCashlinkData': flowCashlinkCrypto(args || {}, 'encryptCashlinkData', 'Save Cashlinks'); break;
        case 'decryptCashlinkData': flowCashlinkCrypto(args || {}, 'decryptCashlinkData', 'View Saved Cashlinks'); break;
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
