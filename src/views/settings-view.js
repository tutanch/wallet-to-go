import { navigate } from '../router.js';
import { exportMnemonic, verifyPassword, deleteWallet } from '../modules/keyguard-api.js';
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
                    <div id="logout-section" style="display: none;">
                        <div class="form-group">
                            <input type="password" class="nq-input" id="logout-password" placeholder="Enter password to confirm" autocomplete="current-password">
                        </div>
                        <button class="nq-button-s red" id="btn-confirm-logout">Confirm Delete</button>
                        <button class="nq-button-s" id="btn-cancel-logout">Cancel</button>
                        <p class="nq-text error-text" id="logout-error" style="display: none;"></p>
                    </div>
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
        const pwInput = el.querySelector('#export-password');
        const errorEl = el.querySelector('#export-error');
        errorEl.style.display = 'none';

        if (!pwInput.value) {
            errorEl.textContent = 'Please enter your password.';
            errorEl.style.display = '';
            return;
        }

        try {
            const { words } = await exportMnemonic(pwInput.value);
            // Clear password immediately after use
            pwInput.value = '';

            const display = el.querySelector('#mnemonic-display');
            display.innerHTML = '';
            words.forEach((word, i) => {
                const div = document.createElement('div');
                div.className = 'mnemonic-word';
                const numSpan = document.createElement('span');
                numSpan.className = 'word-number';
                numSpan.textContent = i + 1;
                const textSpan = document.createElement('span');
                textSpan.className = 'word-text';
                textSpan.textContent = word;
                div.appendChild(numSpan);
                div.appendChild(textSpan);
                display.appendChild(div);
            });
            display.style.display = '';
            el.querySelector('#btn-reveal').style.display = 'none';
            pwInput.style.display = 'none';

            // Auto-hide mnemonic after 60 seconds
            setTimeout(() => {
                display.innerHTML = '';
                display.style.display = 'none';
                el.querySelector('#btn-reveal').style.display = '';
                pwInput.style.display = '';
            }, 60000);
        } catch (e) {
            pwInput.value = '';
            errorEl.textContent = 'Wrong password.';
            errorEl.style.display = '';
        }
    });

    // Logout — requires password confirmation
    el.querySelector('#btn-logout').addEventListener('click', () => {
        el.querySelector('#logout-section').style.display = '';
        el.querySelector('#btn-logout').style.display = 'none';
        el.querySelector('#logout-password').focus();
    });

    el.querySelector('#btn-cancel-logout').addEventListener('click', () => {
        el.querySelector('#logout-section').style.display = 'none';
        el.querySelector('#btn-logout').style.display = '';
        el.querySelector('#logout-password').value = '';
        el.querySelector('#logout-error').style.display = 'none';
    });

    el.querySelector('#btn-confirm-logout').addEventListener('click', async () => {
        const pwInput = el.querySelector('#logout-password');
        const errorEl = el.querySelector('#logout-error');
        errorEl.style.display = 'none';

        if (!pwInput.value) {
            errorEl.textContent = 'Please enter your password.';
            errorEl.style.display = '';
            return;
        }

        try {
            const valid = await verifyPassword(pwInput.value);
            pwInput.value = '';

            if (!valid) {
                errorEl.textContent = 'Wrong password.';
                errorEl.style.display = '';
                return;
            }

            await disconnect();
            await deleteWallet();
            navigate('#welcome');
        } catch (e) {
            pwInput.value = '';
            errorEl.textContent = 'Wrong password.';
            errorEl.style.display = '';
        }
    });

    return el;
}
