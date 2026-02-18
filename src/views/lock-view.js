import { navigate } from '../router.js';
import { unlock, hasPassword, restoreWithPasskey } from '../modules/keyguard-api.js';

export function lockView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Welcome Back</h1>
            </div>
            <div class="nq-card-body" style="text-align: center;">
                <p class="nq-text" style="margin-bottom: 20px;">Unlock your wallet to continue.</p>
                <button class="nq-button" id="btn-passkey">Login with Passkey</button>
                <p style="margin: 16px 0 0;">
                    <button class="nq-button-s" id="btn-password" style="display: none;">Use Password</button>
                </p>
                <p class="nq-text error-text" id="lock-error" style="display: none; margin-top: 12px;"></p>
                <p style="margin-top: 24px;">
                    <a href="#welcome" class="nq-link" id="link-different" style="font-size: 13px; opacity: 0.6;">Use a different wallet</a>
                </p>
            </div>
        </div>
    `;

    // Show password button only if a password is set
    hasPassword().then(hasPw => {
        if (hasPw) {
            el.querySelector('#btn-password').style.display = '';
        }
    }).catch(() => {});

    const errorEl = el.querySelector('#lock-error');

    // Passkey login — routes through keyguard's restoreWithPasskey flow which
    // verifies the passkey's PRF output can derive a valid wallet.
    el.querySelector('#btn-passkey').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-passkey');
        btn.disabled = true;
        btn.textContent = 'Authenticating...';
        errorEl.style.display = 'none';

        try {
            await restoreWithPasskey();
            navigate('#dashboard');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Login with Passkey';
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Passkey authentication failed. Please try again.';
                errorEl.style.display = '';
            }
        }
    });

    // Password unlock via keyguard (password stays in keyguard origin)
    el.querySelector('#btn-password').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-password');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await unlock();
            navigate('#dashboard');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not verify password. Please try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.textContent = 'Use Password';
        }
    });

    return el;
}
