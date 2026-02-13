import { navigate } from '../router.js';
import { createWallet } from '../modules/wallet-manager.js';
import { saveKey } from '../modules/key-store.js';

function renderMnemonicWords(container, words) {
    words.forEach((word, i) => {
        const div = document.createElement('div');
        div.className = 'mnemonic-word';
        const numSpan = document.createElement('span');
        numSpan.className = 'word-number';
        numSpan.textContent = i + 1;
        const textSpan = document.createElement('span');
        textSpan.className = 'word-text';
        textSpan.textContent = word;
        div.appendChild(numSpan);
        div.appendChild(textSpan);
        container.appendChild(div);
    });
}

export async function createView() {
    const wallet = await createWallet();
    const el = document.createElement('div');
    el.className = 'view-container';

    function renderStep1() {
        const words = Array.isArray(wallet.mnemonic) ? wallet.mnemonic : wallet.mnemonic.split(' ');
        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Your Recovery Words</h1>
                    <p class="nq-text">Write these 24 words down and store them safely. They are the only way to recover your wallet.</p>
                </div>
                <div class="nq-card-body">
                    <div class="mnemonic-grid" id="mnemonic-grid"></div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-back">Back</button>
                    <button class="nq-button light-blue" id="btn-next">I've saved my words</button>
                </div>
            </div>
        `;

        renderMnemonicWords(el.querySelector('#mnemonic-grid'), words);

        el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));
        el.querySelector('#btn-next').addEventListener('click', () => {
            // Clear mnemonic from DOM before moving to password step
            el.innerHTML = '';
            renderStep2();
        });
    }

    function renderStep2() {
        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Set a Password</h1>
                    <p class="nq-text">This password encrypts your wallet on this device.</p>
                </div>
                <form id="password-form" style="display: contents;">
                <input type="text" name="username" autocomplete="username" hidden>
                <div class="nq-card-body">
                    <div class="form-group">
                        <input type="password" class="nq-input" id="password" placeholder="Password" autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <input type="password" class="nq-input" id="password-confirm" placeholder="Confirm password" autocomplete="new-password">
                    </div>
                    <p class="nq-text error-text" id="error" style="display: none;"></p>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" type="button" id="btn-back">Back</button>
                    <button class="nq-button light-blue" type="submit" id="btn-save">Create Wallet</button>
                </div>
                </form>
            </div>
        `;

        el.querySelector('#btn-back').addEventListener('click', () => {
            renderStep1();
        });

        el.querySelector('#password-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const pwInput = el.querySelector('#password');
            const confirmInput = el.querySelector('#password-confirm');
            const errorEl = el.querySelector('#error');

            if (pwInput.value.length < 8) {
                errorEl.textContent = 'Password must be at least 8 characters.';
                errorEl.style.display = '';
                return;
            }
            if (pwInput.value !== confirmInput.value) {
                errorEl.textContent = 'Passwords do not match.';
                errorEl.style.display = '';
                return;
            }

            const btn = el.querySelector('#btn-save');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            try {
                await saveKey(wallet.entropy, pwInput.value);
                // Clear password fields immediately after use
                pwInput.value = '';
                confirmInput.value = '';
                // Zero out sensitive data from closure
                if (wallet.entropy && wallet.entropy.serialize) {
                    const bytes = wallet.entropy.serialize();
                    if (bytes instanceof Uint8Array) bytes.fill(0);
                }
                wallet.entropy = null;
                wallet.mnemonic = null;
                navigate('#dashboard');
            } catch (e) {
                // Clear password fields on error too
                pwInput.value = '';
                confirmInput.value = '';
                console.error('Failed to save wallet:', e);
                errorEl.textContent = 'Failed to save wallet. Please try again.';
                errorEl.style.display = '';
                btn.disabled = false;
                btn.textContent = 'Create Wallet';
            }
        });
    }

    renderStep1();
    return el;
}
