import { navigate } from '../router.js';
import { importFromMnemonic } from '../modules/wallet-manager.js';
import { saveKey } from '../modules/key-store.js';

export function importView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Import Wallet</h1>
                <p class="nq-text">Enter your 24 recovery words to restore your wallet.</p>
            </div>
            <div class="nq-card-body">
                <div class="form-group">
                    <textarea class="nq-input mnemonic-input" id="mnemonic" rows="4"
                        placeholder="Enter your 24 recovery words separated by spaces"></textarea>
                </div>
                <div class="form-group">
                    <input type="password" class="nq-input" id="password" placeholder="Set a password" autocomplete="new-password">
                </div>
                <div class="form-group">
                    <input type="password" class="nq-input" id="password-confirm" placeholder="Confirm password" autocomplete="new-password">
                </div>
                <p class="nq-text error-text" id="error" style="display: none;"></p>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-import">Import Wallet</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));

    el.querySelector('#btn-import').addEventListener('click', async () => {
        const mnemonicValue = el.querySelector('#mnemonic').value.trim();
        const password = el.querySelector('#password').value;
        const confirm = el.querySelector('#password-confirm').value;
        const errorEl = el.querySelector('#error');

        const words = mnemonicValue.split(/\s+/);
        if (words.length !== 24) {
            errorEl.textContent = 'Please enter exactly 24 words.';
            errorEl.style.display = '';
            return;
        }

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

        const btn = el.querySelector('#btn-import');
        btn.disabled = true;
        btn.textContent = 'Importing...';

        try {
            const wallet = await importFromMnemonic(words);
            await saveKey(wallet.entropy, password);
            navigate('#dashboard');
        } catch (e) {
            errorEl.textContent = 'Invalid recovery words: ' + e.message;
            errorEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Import Wallet';
        }
    });

    return el;
}
