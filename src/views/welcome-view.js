import { navigate } from '../router.js';
import { restoreWithPasskey } from '../modules/keyguard-api.js';

export function welcomeView() {
    const el = document.createElement('div');
    el.className = 'view-container';
    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Nimiq Wallet</h1>
                <p class="nq-text">A standalone wallet for the Nimiq blockchain</p>
            </div>
            <div class="nq-card-body welcome-body">
                <button class="nq-button light-blue" id="btn-create">Create New Wallet</button>
                <button class="nq-button-s" id="btn-import">Import Existing Wallet</button>
                <button class="nq-button-s" id="btn-passkey" style="margin-top: 12px;">Login with Passkey</button>
                <p class="nq-text error-text" id="passkey-error" style="display: none; margin-top: 8px;"></p>
            </div>
        </div>
    `;

    el.querySelector('#btn-create').addEventListener('click', () => navigate('#create'));
    el.querySelector('#btn-import').addEventListener('click', () => navigate('#import'));

    el.querySelector('#btn-passkey').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-passkey');
        const errorEl = el.querySelector('#passkey-error');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await restoreWithPasskey({ allowOverwrite: true });
            navigate('#dashboard');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Login with Passkey';
            if (e.message !== 'User cancelled') {
                errorEl.textContent = e.message || 'Passkey login failed.';
                errorEl.style.display = '';
            }
        }
    });

    return el;
}
