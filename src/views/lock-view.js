import { navigate } from '../router.js';
import { unlock, getWebAuthnInfo, restoreWithPasskey } from '../modules/keyguard-api.js';

export function lockView() {
    const el = document.createElement('div');
    el.className = 'view-container';
    let active = true;

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Welcome Back</h1>
            </div>
            <div class="nq-card-body" style="text-align: center;">
                <p class="nq-text" style="margin-bottom: 20px;">Unlock your wallet to continue.</p>
                <button class="nq-button" id="btn-passkey" style="display: none;">Login with Passkey</button>
                <button class="nq-button" id="btn-password" style="display: none;">Unlock with Password</button>
                <p class="nq-text error-text" id="lock-error" role="alert" style="display: none; margin-top: 12px;"></p>
                <p style="margin-top: 24px;">
                    <a href="#welcome" class="nq-link" id="link-different" style="font-size: 13px;">Use a different wallet</a>
                </p>
            </div>
        </div>
    `;

    const errorEl = el.querySelector('#lock-error');
    const passkeyBtn = el.querySelector('#btn-passkey');
    const passwordBtn = el.querySelector('#btn-password');

    // Show only the auth method that matches this wallet's type. Passkey wallets
    // (created via "Create New Wallet") unlock with the passkey; imported wallets
    // unlock with their password. The two are mutually exclusive — a wallet never
    // has both — so we never offer the passkey-restore path to a password wallet
    // (that path re-derives a wallet FROM the passkey and would not match an
    // imported seed).
    getWebAuthnInfo().then(info => {
        if (!active) return;
        if (info?.hasWebAuthn) {
            passkeyBtn.style.display = '';
        } else {
            passwordBtn.style.display = '';
        }
    }).catch(() => {
        // On failure, fall back to password unlock — never auto-offer the passkey
        // restore path, which is the safe default.
        if (active) passwordBtn.style.display = '';
    });

    // Passkey login — only shown for passkey wallets. Routes through the
    // keyguard's restoreWithPasskey flow.
    passkeyBtn.addEventListener('click', async () => {
        passkeyBtn.disabled = true;
        passkeyBtn.setAttribute('aria-busy', 'true');
        passkeyBtn.textContent = 'Authenticating...';
        errorEl.style.display = 'none';

        try {
            await restoreWithPasskey();
            if (active) navigate('#dashboard');
        } catch (e) {
            if (!active) return;
            passkeyBtn.disabled = false;
            passkeyBtn.removeAttribute('aria-busy');
            passkeyBtn.textContent = 'Login with Passkey';
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Passkey authentication failed. Please try again.';
                errorEl.style.display = '';
            }
        }
    });

    // Password unlock via keyguard (password stays in keyguard origin)
    passwordBtn.addEventListener('click', async () => {
        passwordBtn.disabled = true;
        passwordBtn.setAttribute('aria-busy', 'true');
        passwordBtn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await unlock();
            if (active) navigate('#dashboard');
        } catch (e) {
            if (!active) return;
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not verify password. Please try again.';
                errorEl.style.display = '';
            }
            passwordBtn.disabled = false;
            passwordBtn.removeAttribute('aria-busy');
            passwordBtn.textContent = 'Unlock with Password';
        }
    });

    return {
        element: el,
        cleanup: () => { active = false; },
    };
}
