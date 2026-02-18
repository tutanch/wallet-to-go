import { navigate } from '../router.js';
import { exportMnemonic, deleteWallet } from '../modules/keyguard-api.js';
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
                            <a class="nq-link" href="${NETWORKS.test.faucetUrl}" target="_blank" rel="noopener">Get test NIM from faucet</a>
                        </p>
                    ` : ''}
                </div>

                <div class="settings-section">
                    <h2 class="nq-label">Backup</h2>
                    <p class="nq-text" style="margin-bottom: 12px;">The keyguard will ask for your password and display your recovery words securely.</p>
                    <button class="nq-button-s" id="btn-export">Show Recovery Words</button>
                    <p class="nq-text error-text" id="export-error" style="display: none; margin-top: 8px;"></p>
                </div>

                <div class="settings-section danger-section">
                    <h2 class="nq-label">Danger Zone</h2>
                    <button class="nq-button-s red" id="btn-logout">Logout &amp; Delete Wallet</button>
                    <p class="nq-text danger-text">This will remove your wallet from this device. Make sure you have your recovery words backed up!</p>
                    <p class="nq-text error-text" id="logout-error" style="display: none; margin-top: 8px;"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

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

    // Delete wallet — keyguard handles password + DELETE confirmation
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
                errorEl.textContent = 'Could not delete wallet. Please try again.';
                errorEl.style.display = '';
            }
            btn.disabled = false;
            btn.textContent = 'Logout & Delete Wallet';
        }
    });

    return el;
}
