import { navigate } from '../router.js';
import { createWallet } from '../modules/keyguard-api.js';

export async function createView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Create Wallet</h1>
                <p class="nq-text">The keyguard will guide you through creating your wallet and backing up your recovery words.</p>
            </div>
            <div class="nq-card-body">
                <p class="nq-text error-text" id="error" style="display:none;"></p>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-create">Create New Wallet</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#welcome'));

    el.querySelector('#btn-create').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-create');
        const errorEl = el.querySelector('#error');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            // Keyguard handles: mnemonic display, backup confirmation, password entry
            await createWallet();
            navigate('#dashboard');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Failed to create wallet. Please try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.textContent = 'Create New Wallet';
        }
    });

    return el;
}
