import { navigate } from '../router.js';
import { importWallet } from '../modules/keyguard-api.js';

export function importView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Import Wallet</h1>
                <p class="nq-text">Enter your 24 recovery words to restore your wallet.</p>
            </div>
            <form id="import-form" style="display: contents;">
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
                <button class="nq-button-s" type="button" id="btn-back">Back</button>
                <button class="nq-button light-blue" type="submit" id="btn-import">Import Wallet</button>
            </div>
            </form>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));

    el.querySelector('#import-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const mnemonicInput = el.querySelector('#mnemonic');
        const pwInput = el.querySelector('#password');
        const confirmInput = el.querySelector('#password-confirm');
        const errorEl = el.querySelector('#error');

        const words = mnemonicInput.value.trim().split(/\s+/);
        if (words.length !== 24) {
            errorEl.textContent = 'Please enter exactly 24 words.';
            errorEl.style.display = '';
            return;
        }

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

        const btn = el.querySelector('#btn-import');
        btn.disabled = true;
        btn.textContent = 'Importing...';

        try {
            await importWallet(words, pwInput.value);
            // Clear sensitive inputs immediately after use
            mnemonicInput.value = '';
            pwInput.value = '';
            confirmInput.value = '';
            navigate('#dashboard');
        } catch (e) {
            // Clear password fields on error (keep mnemonic for retry)
            pwInput.value = '';
            confirmInput.value = '';
            console.error('Import failed:', e);
            errorEl.textContent = 'Invalid recovery words. Please check and try again.';
            errorEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Import Wallet';
        }
    });

    return el;
}
