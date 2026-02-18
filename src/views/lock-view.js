import { navigate } from '../router.js';
import { unlock } from '../modules/keyguard-api.js';

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
                    <button class="nq-button-s" id="btn-password">Use Password</button>
                </p>
                <p class="nq-text error-text" id="lock-error" style="display: none; margin-top: 12px;"></p>
            </div>
        </div>
    `;

    const errorEl = el.querySelector('#lock-error');

    // Passkey login — uses discoverable credentials so the browser finds any
    // matching passkey in the keychain, regardless of what the keyguard knows.
    el.querySelector('#btn-passkey').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-passkey');
        btn.disabled = true;
        btn.textContent = 'Authenticating...';
        errorEl.style.display = 'none';

        try {
            await navigator.credentials.get({
                publicKey: {
                    challenge: crypto.getRandomValues(new Uint8Array(32)),
                    userVerification: 'required',
                },
            });
            navigate('#dashboard');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Login with Passkey';
            if (e.name === 'NotAllowedError') {
                errorEl.textContent = 'No passkey found or cancelled. You can set one up in Settings after logging in with your password.';
            } else {
                errorEl.textContent = 'Authentication failed: ' + (e.message || e.name);
            }
            errorEl.style.display = '';
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
