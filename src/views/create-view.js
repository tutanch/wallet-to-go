import { navigate } from '../router.js';
import { createWallet } from '../modules/wallet-manager.js';
import { saveKey } from '../modules/key-store.js';

export async function createView() {
    const wallet = await createWallet();
    let step = 1;

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
                    <div class="mnemonic-grid">
                        ${words.map((word, i) => `
                            <div class="mnemonic-word">
                                <span class="word-number">${i + 1}</span>
                                <span class="word-text">${word}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-back">Back</button>
                    <button class="nq-button light-blue" id="btn-next">I've saved my words</button>
                </div>
            </div>
        `;

        el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));
        el.querySelector('#btn-next').addEventListener('click', () => {
            step = 2;
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
            step = 1;
            renderStep1();
        });

        el.querySelector('#password-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = el.querySelector('#password').value;
            const confirm = el.querySelector('#password-confirm').value;
            const errorEl = el.querySelector('#error');

            if (password.length < 8) {
                errorEl.textContent = 'Password must be at least 8 characters.';
                errorEl.style.display = '';
                return;
            }
            if (password !== confirm) {
                errorEl.textContent = 'Passwords do not match.';
                errorEl.style.display = '';
                return;
            }

            const btn = el.querySelector('#btn-save');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            try {
                await saveKey(wallet.entropy, password);
                navigate('#dashboard');
            } catch (e) {
                errorEl.textContent = 'Failed to save wallet: ' + e.message;
                errorEl.style.display = '';
                btn.disabled = false;
                btn.textContent = 'Create Wallet';
            }
        });
    }

    renderStep1();
    return el;
}
