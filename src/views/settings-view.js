import { navigate } from '../router.js';
import { exportMnemonic, deleteWallet, getWebAuthnInfo, hasPassword, registerWebAuthn, removeWebAuthn, switchAccount, syncThemeToKeyguard, getPolygonAddress, activatePolygon } from '../modules/keyguard-api.js';
import { keyguardFingerprint } from '../modules/keyguard-verify.js';
import { getSelectedNetwork, setSelectedNetwork, NETWORKS, isStablecoinsEnabled } from '../config.js';
import { disconnect } from '../modules/network-client.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { resetPolygonCache } from './dashboard-view.js';

export function settingsView() {
    const el = document.createElement('div');
    el.className = 'view-container';

    const currentNetwork = getSelectedNetwork();
    const currentTheme = localStorage.getItem('nimiq-theme') || 'auto';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Settings</h1>
            </div>
            <div class="nq-card-body">
                <div class="settings-section">
                    <h2 class="nq-label">Appearance</h2>
                    <div class="network-toggle" role="group" aria-label="Theme">
                        <button class="nq-button-s ${currentTheme === 'auto' ? 'selected' : ''}" aria-pressed="${currentTheme === 'auto'}" id="btn-theme-auto">Auto</button>
                        <button class="nq-button-s ${currentTheme === 'light' ? 'selected' : ''}" aria-pressed="${currentTheme === 'light'}" id="btn-theme-light">Light</button>
                        <button class="nq-button-s ${currentTheme === 'dark' ? 'selected' : ''}" aria-pressed="${currentTheme === 'dark'}" id="btn-theme-dark">Dark</button>
                    </div>
                </div>

                <div class="settings-section">
                    <h2 class="nq-label">Network</h2>
                    <div class="network-toggle" role="group" aria-label="Network">
                        <button class="nq-button-s ${currentNetwork === 'main' ? 'selected' : ''}" aria-pressed="${currentNetwork === 'main'}" id="btn-mainnet">Mainnet</button>
                        <button class="nq-button-s ${currentNetwork === 'test' ? 'selected' : ''}" aria-pressed="${currentNetwork === 'test'}" id="btn-testnet">Testnet</button>
                    </div>
                    ${currentNetwork === 'test' ? `
                        <p class="nq-text faucet-link">
                            <a class="nq-link" id="faucet-link" target="_blank" rel="noopener">Get test NIM from faucet</a>
                        </p>
                        <p class="nq-text nq-text-s">Stablecoins (USDC/USDT) are only available on mainnet.</p>
                    ` : ''}
                </div>

                ${isStablecoinsEnabled() ? `
                <div class="settings-section" id="polygon-section">
                    <h2 class="nq-label">Stablecoins (Polygon)</h2>
                    <p class="nq-text" style="margin-bottom: 12px;" id="polygon-status" aria-live="polite">Checking…</p>
                    <button class="nq-button-s" id="btn-polygon-activate" style="display: none;">Activate Polygon</button>
                    <p class="nq-text error-text" id="polygon-error" role="alert" style="display: none; margin-top: 8px;"></p>
                </div>` : ''}

                <div class="settings-section" id="security-section">
                    <h2 class="nq-label">Security</h2>
                    <p class="nq-text" style="margin-bottom: 12px;" id="webauthn-status" aria-live="polite">Checking biometric support...</p>
                    <button class="nq-button-s" id="btn-webauthn" style="display: none;"></button>
                    <p class="nq-text error-text" id="webauthn-error" role="alert" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section" id="switch-section" style="display: none;">
                    <h2 class="nq-label">Accounts</h2>
                    <p class="nq-text" style="margin-bottom: 12px;">Switch between different wallets linked to your passkey.</p>
                    <button class="nq-button-s" id="btn-switch">Switch Account</button>
                    <p class="nq-text error-text" id="switch-error" role="alert" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section" id="keyguard-fingerprint-section">
                    <h2 class="nq-label">Keyguard fingerprint</h2>
                    <p class="nq-text nq-text-s" style="margin-bottom: 8px;">Your wallet verifies the keyguard's code before every use and refuses to open it if it doesn't match. This is its fingerprint — compare it once against the value the developers publish (see VERIFICATION.md).</p>
                    <code class="nq-text-s" id="keyguard-fingerprint" style="word-break: break-all; display: block; user-select: all;"></code>
                </div>

                <div class="settings-section">
                    <h2 class="nq-label">Backup</h2>
                    <p class="nq-text" style="margin-bottom: 12px;">The keyguard will ask for your password and display your recovery words securely.</p>
                    <button class="nq-button-s" id="btn-export">Show Recovery Words</button>
                    <p class="nq-text error-text" id="export-error" role="alert" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section danger-section">
                    <h2 class="nq-label">Danger Zone</h2>
                    <button class="nq-button-s red" id="btn-logout">Log Out</button>
                    <p class="nq-text danger-text">This removes your wallet from this device. If you set up a passkey, you can log back in with it. Make sure you have your recovery words backed up!</p>
                    <p class="nq-text error-text" id="logout-error" role="alert" style="display: none; margin-top: 8px;"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    const faucetLink = el.querySelector('#faucet-link');
    if (faucetLink) faucetLink.href = NETWORKS.test.faucetUrl;

    const fpEl = el.querySelector('#keyguard-fingerprint');
    if (fpEl) fpEl.textContent = keyguardFingerprint() || 'Not yet deployed (dev mode — no integrity gate).';

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    // Theme toggle
    function applyTheme(theme) {
        localStorage.setItem('nimiq-theme', theme);
        if (theme === 'auto') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        el.querySelectorAll('#btn-theme-auto, #btn-theme-light, #btn-theme-dark').forEach(b => {
            b.classList.remove('selected');
            b.setAttribute('aria-pressed', 'false');
        });
        const activeBtn = el.querySelector(`#btn-theme-${theme}`);
        activeBtn.classList.add('selected');
        activeBtn.setAttribute('aria-pressed', 'true');
        syncThemeToKeyguard();
    }

    el.querySelector('#btn-theme-auto').addEventListener('click', () => applyTheme('auto'));
    el.querySelector('#btn-theme-light').addEventListener('click', () => applyTheme('light'));
    el.querySelector('#btn-theme-dark').addEventListener('click', () => applyTheme('dark'));

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
        btn.setAttribute('aria-busy', 'true');
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
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Show Recovery Words';
        }
    });

    // Log out — keyguard handles LOGOUT text confirmation
    el.querySelector('#btn-logout').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-logout');
        const errorEl = el.querySelector('#logout-error');
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await deleteWallet();
            // Keyguard confirmed and deleted the wallet
            resetPolygonCache();
            localStorage.removeItem('wallet-created-here');
            await disconnect();
            navigate('#welcome');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not log out. Please try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Log Out';
        }
    });

    // Stablecoins (Polygon) activation status
    const polygonSection = el.querySelector('#polygon-section');
    if (polygonSection) {
        const statusEl = polygonSection.querySelector('#polygon-status');
        const activateBtn = polygonSection.querySelector('#btn-polygon-activate');
        const errorEl = polygonSection.querySelector('#polygon-error');

        (async () => {
            try {
                const { address } = await getPolygonAddress();
                if (address) {
                    statusEl.textContent = `Active — ${address.substring(0, 10)}…${address.substring(address.length - 8)}`;
                } else {
                    statusEl.textContent = 'Activate to send and receive USDC/USDT with fees paid in the token itself.';
                    activateBtn.style.display = '';
                }
            } catch (_) {
                statusEl.textContent = 'Status unavailable.';
            }
        })();

        activateBtn.addEventListener('click', async () => {
            activateBtn.disabled = true;
            activateBtn.setAttribute('aria-busy', 'true');
            activateBtn.textContent = 'Opening keyguard...';
            errorEl.style.display = 'none';
            try {
                const { address } = await activatePolygon();
                resetPolygonCache();
                statusEl.textContent = `Active — ${address.substring(0, 10)}…${address.substring(address.length - 8)}`;
                activateBtn.style.display = 'none';
                activateBtn.removeAttribute('aria-busy');
            } catch (e) {
                activateBtn.disabled = false;
                activateBtn.removeAttribute('aria-busy');
                activateBtn.textContent = 'Activate Polygon';
                if (e.message !== 'User cancelled') {
                    errorEl.textContent = 'Activation failed. Please try again.';
                    errorEl.style.display = '';
                }
            }
        });
    }

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

    updateWebAuthnUI().then(async () => {
        // Show "Switch Account" section if the wallet has a passkey
        try {
            const info = await getWebAuthnInfo();
            if (info.hasWebAuthn) {
                el.querySelector('#switch-section').style.display = '';
            }
        } catch (_) {}
    });

    // Switch Account
    el.querySelector('#btn-switch').addEventListener('click', async () => {
        const btn = el.querySelector('#btn-switch');
        const errorEl = el.querySelector('#switch-error');
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Opening keyguard...';
        errorEl.style.display = 'none';

        try {
            await switchAccount();
            // Account switched — reload dashboard
            navigate('#dashboard');
        } catch (e) {
            if (e.message !== 'User cancelled') {
                errorEl.textContent = 'Could not switch account. Please try again.';
                errorEl.style.display = '';
            }
        } finally {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Switch Account';
        }
    });

    webauthnBtn.addEventListener('click', async () => {
        webauthnBtn.disabled = true;
        webauthnBtn.setAttribute('aria-busy', 'true');
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
            webauthnBtn.removeAttribute('aria-busy');
            await updateWebAuthnUI();
        }
    });

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return { element: el, cleanup: cleanupSwipe };
}
