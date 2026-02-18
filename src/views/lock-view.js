import { navigate } from '../router.js';
import { getWebAuthnInfo, unlock } from '../modules/keyguard-api.js';

export async function lockView() {
    // Check if WebAuthn is configured; if not, skip straight to dashboard
    let webauthnInfo;
    try {
        webauthnInfo = await getWebAuthnInfo();
    } catch (_) {
        navigate('#dashboard');
        return document.createElement('div');
    }

    if (!webauthnInfo.hasWebAuthn) {
        navigate('#dashboard');
        return document.createElement('div');
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Welcome Back</h1>
            </div>
            <div class="nq-card-body" style="text-align: center;">
                <p class="nq-text" style="margin-bottom: 20px;">Unlock your wallet to continue.</p>
                <button class="nq-button" id="btn-biometric">Unlock with Passkey</button>
                <p style="margin: 16px 0 0;">
                    <button class="nq-button-s" id="btn-password">Use Password</button>
                </p>
                <p class="nq-text error-text" id="lock-error" style="display: none; margin-top: 12px;"></p>
            </div>
        </div>
    `;

    const errorEl = el.querySelector('#lock-error');

    // Biometric unlock — calls WebAuthn get() directly from the wallet origin.
    // No PRF needed; user verification alone proves identity for login.
    el.querySelector('#btn-biometric').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-biometric');
        btn.disabled = true;
        btn.textContent = 'Authenticating...';
        errorEl.style.display = 'none';

        try {
            await navigator.credentials.get({
                publicKey: {
                    challenge: crypto.getRandomValues(new Uint8Array(32)),
                    allowCredentials: [{
                        type: 'public-key',
                        id: new Uint8Array(webauthnInfo.credentialId),
                    }],
                    userVerification: 'required',
                },
            });
            navigate('#dashboard');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Unlock with Passkey';
            if (e.name !== 'NotAllowedError') {
                errorEl.textContent = 'Authentication failed. Please try again.';
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
