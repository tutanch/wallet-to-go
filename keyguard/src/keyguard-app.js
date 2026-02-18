// Keyguard App — runs inside the cross-origin keyguard iframe.
// Owns all sensitive flows: key creation, import, signing, export, deletion.
// Passwords never leave this origin. Keys never leave this file's worker.
//
// Replace [WALLET_ORIGIN] with the actual wallet origin before deploying,
// e.g. https://tutanch.github.io

const WALLET_ORIGIN = '[WALLET_ORIGIN]';

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
    if (!currentSession) return;
    currentSession.source.postMessage(message, currentSession.origin, transfer);
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
    const { source, origin, sessionId } = currentSession;
    currentSession = null;
    document.getElementById('keyguard-ui').style.display = 'none';
    source.postMessage({ type: 'result', sessionId, result }, origin, transfer);
}

function rejectSession(errorMsg) {
    const { source, origin, sessionId } = currentSession;
    currentSession = null;
    document.getElementById('keyguard-ui').style.display = 'none';
    source.postMessage({ type: 'error', sessionId, error: errorMsg }, origin);
}

// ── HTML helpers ──────────────────────────────────────────────────────────

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
                                autocomplete="${isNew ? 'new-password' : 'current-password'}" autofocus>
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
                                placeholder="word1 word2 word3 ... word24" autofocus></textarea>
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

function renderDeleteConfirm() {
    return `
        <div class="keyguard-container">
            <div class="keyguard-card">
                <div class="keyguard-header">
                    <h1>Delete Wallet</h1>
                    <p>This permanently removes your wallet from this device. Make sure you have your recovery words backed up!</p>
                </div>
                <form id="delete-form" style="display: contents;">
                    <div class="keyguard-body">
                        <div class="form-group">
                            <input type="password" class="nq-input" id="password"
                                placeholder="Enter your password" autocomplete="current-password" autofocus>
                        </div>
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
    ui.querySelector('#btn-confirm').onclick = () => {
        // Clear mnemonic from DOM before password step
        setUI('');

        // Step 2: Set password
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
                resolveSession({ address: walletData.address });
            } catch (err) {
                ui.querySelector('#password').value = '';
                ui.querySelector('#password-confirm').value = '';
                setButtonState(btn, 'Confirm', false);
                showError(ui.querySelector('#error'), 'Failed to save wallet. Please try again.');
            }
        });
    };
}

async function flowImportWallet() {
    showUI();

    // Step 1: Word entry
    setUI(renderWordEntry());

    ui.querySelector('#btn-cancel').onclick = () => rejectSession('User cancelled');
    ui.querySelector('#words-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const words = ui.querySelector('#mnemonic').value.trim().split(/\s+/);
        const errorEl = ui.querySelector('#error');
        if (words.length !== 24) { showError(errorEl, 'Please enter exactly 24 words.'); return; }

        // Keep a copy of words for the password step
        const wordsCopy = words.slice();
        setUI('');

        // Step 2: Set password
        setUI(renderPasswordForm({
            title: 'Set a Password',
            subtitle: 'This password encrypts your imported wallet.',
            isNew: true,
        }));

        ui.querySelector('#btn-cancel').onclick = () => {
            wordsCopy.fill('');
            rejectSession('User cancelled');
        };
        ui.querySelector('#pw-form').addEventListener('submit', async (e2) => {
            e2.preventDefault();
            const pw = ui.querySelector('#password').value;
            const confirm = ui.querySelector('#password-confirm').value;
            const errorEl2 = ui.querySelector('#error');

            if (pw.length < 8) { showError(errorEl2, 'Password must be at least 8 characters.'); return; }
            if (pw !== confirm) { showError(errorEl2, 'Passwords do not match.'); return; }

            const btn = ui.querySelector('#btn-submit');
            setButtonState(btn, 'Importing...', true);
            try {
                const result = await callWorker('importWallet', { words: wordsCopy, password: pw });
                ui.querySelector('#password').value = '';
                ui.querySelector('#password-confirm').value = '';
                wordsCopy.fill('');
                resolveSession({ address: result.address });
            } catch (err) {
                ui.querySelector('#password').value = '';
                ui.querySelector('#password-confirm').value = '';
                wordsCopy.fill('');
                setButtonState(btn, 'Confirm', false);
                showError(ui.querySelector('#error'), 'Invalid recovery words or wrong password.');
            }
        });
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
    ui.querySelector('#btn-confirm').onclick = () => {
        setUI('');

        // Step 2: Password entry
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
                // Transfer the buffer zero-copy back to the wallet
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
    };
}

async function flowExportMnemonic() {
    showUI();

    // Step 1: Password entry
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

            // Step 2: Show mnemonic — words stay in keyguard, NEVER sent to wallet
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
        } catch (err) {
            ui.querySelector('#password').value = '';
            setButtonState(ui.querySelector('#btn-submit'), 'Continue', false);
            showError(ui.querySelector('#error'), 'Wrong password.');
        }
    });
}

async function flowDeleteWallet() {
    showUI();

    setUI(renderDeleteConfirm());

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
}

// ── Main message handler ──────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
    // Strict origin validation — reject anything not from the wallet
    if (event.origin !== WALLET_ORIGIN) return;

    const { sessionId, command, args } = event.data;

    // Transparent passthroughs: no UI, immediate response
    if (command === 'hasKey') {
        try {
            const result = await callWorker('hasKey');
            event.source.postMessage({ type: 'result', sessionId, result }, WALLET_ORIGIN);
        } catch (e) {
            event.source.postMessage({ type: 'error', sessionId, error: e.message }, WALLET_ORIGIN);
        }
        return;
    }

    if (command === 'getStoredAddress') {
        try {
            const result = await callWorker('getStoredAddress');
            event.source.postMessage({ type: 'result', sessionId, result }, WALLET_ORIGIN);
        } catch (e) {
            event.source.postMessage({ type: 'error', sessionId, error: e.message }, WALLET_ORIGIN);
        }
        return;
    }

    // UI flows — establish session context
    currentSession = {
        source: event.source,
        origin: WALLET_ORIGIN,
        sessionId,
    };

    switch (command) {
        case 'createWallet':    flowCreateWallet(); break;
        case 'importWallet':    flowImportWallet(); break;
        case 'signTransaction': flowSignTransaction(args || {}); break;
        case 'exportMnemonic':  flowExportMnemonic(); break;
        case 'deleteWallet':    flowDeleteWallet(); break;
        default:
            rejectSession(`Unknown command: ${command}`);
    }
});

// ── Signal readiness ──────────────────────────────────────────────────────
// Sent after the module has loaded so the wallet knows the keyguard is ready.
try {
    window.parent.postMessage({ type: 'ready' }, WALLET_ORIGIN);
} catch (_) {
    // Not embedded — expected when accessing keyguard directly
}
