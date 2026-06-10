import { navigate } from '../router.js';
import { importWallet } from '../modules/keyguard-api.js';

export function importView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Import Wallet</h1>
                <p class="nq-text">The keyguard will securely collect your recovery words and set a new password.</p>
            </div>
            <div class="nq-card-body">
                <p class="nq-text error-text" id="error" style="display:none;"></p>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-import">Import Wallet</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));

    el.querySelector('#btn-import').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-import');
        const errorEl = el.querySelector('#error');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            // Keyguard handles: word entry, validation, password entry
            await importWallet();
            // Imported wallets may have prior Polygon history — allow deep scans
            localStorage.removeItem('wallet-created-here');
            navigate('#dashboard');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Import failed. Please check your recovery words and try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.textContent = 'Import Wallet';
        }
    });

    return el;
}
