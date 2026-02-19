import { navigate } from '../router.js';
import { exportMnemonic, deleteWallet, getWebAuthnInfo, hasPassword, registerWebAuthn, removeWebAuthn } from '../modules/keyguard-api.js';
import { getSelectedNetwork, setSelectedNetwork, NETWORKS } from '../config.js';
import { disconnect } from '../modules/network-client.js';

export function settingsView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    const currentNetwork = getSelectedNetwork();

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Settings</h1>
            </div>
            <div class="nq-card-body">
                <div class="settings-section">
                    <h2 class="nq-label">Network</h2>
                    <div class="network-toggle">
                        <button class="nq-button-s ${currentNetwork === 'main' ? 'selected' : ''}" id="btn-mainnet">Mainnet</button>
                        <button class="nq-button-s ${currentNetwork === 'test' ? 'selected' : ''}" id="btn-testnet">Testnet</button>
                    </div>
                    ${currentNetwork === 'test' ? `
                        <p class="nq-text faucet-link">
                            <a class="nq-link" id="faucet-link" target="_blank" rel="noopener">Get test NIM from faucet</a>
                        </p>
                    ` : ''}
                </div>

                <div class="settings-section" id="security-section">
                    <h2 class="nq-label">Security</h2>
                    <p class="nq-text" style="margin-bottom: 12px;" id="webauthn-status">Checking biometric support...</p>
                    <button class="nq-button-s" id="btn-webauthn" style="display: none;"></button>
                    <p class="nq-text error-text" id="webauthn-error" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section">
                    <h2 class="nq-label">Backup</h2>
                    <p class="nq-text" style="margin-bottom: 12px;">The keyguard will ask for your password and display your recovery words securely.</p>
                    <button class="nq-button-s" id="btn-export">Show Recovery Words</button>
                    <p class="nq-text error-text" id="export-error" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section danger-section">
                    <h2 class="nq-label">Danger Zone</h2>
                    <button class="nq-button-s red" id="btn-logout">Log Out</button>
                    <p class="nq-text danger-text">This removes your wallet from this device. If you set up a passkey, you can log back in with it. Make sure you have your recovery words backed up!</p>
                    <p class="nq-text error-text" id="logout-error" style="display: none; margin-top: 8px;"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    const faucetLink = el.querySelector('#faucet-link');
    if (faucetLink) faucetLink.href = NETWORKS.test.faucetUrl;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    // Network toggle
    el.querySelector('#btn-mainnet').addEventListener('click', async () => {
        if (currentNetwork === 'main') return;
        setSelectedNetwork('main');
        await disconnect();
        navigate('#dashboard');
    });

    el.querySelector('#btn-testnet').addEventListener('click', async () => {
        if (currentNetwork === 'test') return;
        setSelectedNetwork('test');
        await disconnect();
        navigate('#dashboard');
    });

    // Export recovery words — keyguard handles password + display entirely
    el.querySelector('#btn-export').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-export');
        const errorEl = el.querySelector('#export-error');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await exportMnemonic();
            // Keyguard showed and hid the words — nothing else to do
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not show recovery words. Please try again.';
                errorEl.style.display = '';
            }
        } finally {
            btn.disabled = false;
            btn.textContent = 'Show Recovery Words';
        }
    });

    // Log out — keyguard handles LOGOUT text confirmation
    el.querySelector('#btn-logout').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-logout');
        const errorEl = el.querySelector('#logout-error');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await deleteWallet();
            // Keyguard confirmed and deleted the wallet
            await disconnect();
            navigate('#welcome');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not log out. Please try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.textContent = 'Log Out';
        }
    });

    // WebAuthn / biometric toggle
    const webauthnBtn = el.querySelector('#btn-webauthn');
    const webauthnStatus = el.querySelector('#webauthn-status');
    const webauthnError = el.querySelector('#webauthn-error');
    const securitySection = el.querySelector('#security-section');

    async function updateWebAuthnUI() {
        // Check if WebAuthn is available in this browser
        if (!window.PublicKeyCredential || !navigator.credentials) {
            securitySection.style.display = 'none';
            return;
        }

        try {
            const info = await getWebAuthnInfo();
            const hasPw = await hasPassword();

            if (info.hasWebAuthn) {
                webauthnStatus.textContent = 'Biometric unlock is enabled.';
                if (hasPw) {
                    webauthnBtn.textContent = 'Disable Biometric Unlock';
                    webauthnBtn.style.display = '';
                    webauthnBtn.disabled = false;
                } else {
                    // Passkey-only wallet: can't disable without a password fallback
                    webauthnBtn.style.display = 'none';
                }
            } else {
                webauthnStatus.textContent = 'Use your fingerprint, face, or device PIN instead of typing your password.';
                webauthnBtn.textContent = 'Enable Biometric Unlock';
                webauthnBtn.style.display = '';
                webauthnBtn.disabled = false;
            }
        } catch (e) {
            console.debug('WebAuthn info check failed:', e);
            securitySection.style.display = 'none';
        }
    }

    updateWebAuthnUI();

    webauthnBtn.addEventListener('click', async () => {
        webauthnBtn.disabled = true;
        webauthnError.style.display = 'none';
        const wasEnabled = webauthnBtn.textContent.startsWith('Disable');
        webauthnBtn.textContent = 'Opening keyguard...';

        try {
            if (wasEnabled) {
                await removeWebAuthn();
            } else {
                await registerWebAuthn();
            }
            await updateWebAuthnUI();
        } catch (e) {
            if (e.message !== 'User cancelled') {
                webauthnError.textContent = wasEnabled
                    ? 'Could not disable biometric unlock. Please try again.'
                    : 'Could not enable biometric unlock. Please try again.';
                webauthnError.style.display = '';
            }
        } finally {
            webauthnBtn.disabled = false;
            await updateWebAuthnUI();
        }
    });

    return el;
}
