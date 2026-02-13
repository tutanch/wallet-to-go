import { navigate } from '../router.js';
import { getKey, removeAll } from '../modules/key-store.js';
import { getMnemonic } from '../modules/wallet-manager.js';
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
                    <button class="nq-button-s" id="btn-export">Show Recovery Words</button>
                    <div id="export-section" style="display: none;">
                        <div class="form-group">
                            <input type="password" class="nq-input" id="export-password" placeholder="Enter password" autocomplete="current-password">
                        </div>
                        <button class="nq-button-s" id="btn-reveal">Reveal</button>
                        <div class="mnemonic-grid" id="mnemonic-display" style="display: none;"></div>
                        <p class="nq-text error-text" id="export-error" style="display: none;"></p>
                    </div>
                </div>

                <div class="settings-section danger-section">
                    <h2 class="nq-label">Danger Zone</h2>
                    <button class="nq-button-s red" id="btn-logout">Logout & Delete Wallet</button>
                    <p class="nq-text danger-text">This will remove your wallet from this device. Make sure you have your recovery words backed up!</p>
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

    // Export recovery words
    el.querySelector('#btn-export').addEventListener('click', () => {
        el.querySelector('#export-section').style.display = '';
        el.querySelector('#export-password').focus();
    });

    el.querySelector('#btn-reveal').addEventListener('click', async () => {
        const password = el.querySelector('#export-password').value;
        const errorEl = el.querySelector('#export-error');
        errorEl.style.display = 'none';

        if (!password) {
            errorEl.textContent = 'Please enter your password.';
            errorEl.style.display = '';
            return;
        }

        try {
            const entropy = await getKey(password);
            if (!entropy) throw new Error('Wrong password');

            const mnemonic = await getMnemonic(entropy);
            const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.split(' ');
            const display = el.querySelector('#mnemonic-display');
            display.innerHTML = words.map((word, i) => `
                <div class="mnemonic-word">
                    <span class="word-number">${i + 1}</span>
                    <span class="word-text">${word}</span>
                </div>
            `).join('');
            display.style.display = '';
            el.querySelector('#btn-reveal').style.display = 'none';
            el.querySelector('#export-password').style.display = 'none';
        } catch (e) {
            errorEl.textContent = 'Wrong password.';
            errorEl.style.display = '';
        }
    });

    // Logout
    el.querySelector('#btn-logout').addEventListener('click', async () => {
        const confirmed = window.confirm(
            'Are you sure you want to delete your wallet from this device? This cannot be undone. Make sure you have your recovery words!'
        );
        if (!confirmed) return;

        await disconnect();
        await removeAll();
        navigate('#welcome');
    });

    return el;
}
