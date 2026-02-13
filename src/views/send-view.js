import { navigate } from '../router.js';
import { getStoredAddress, signTransaction } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, getNetworkConfig } from '../config.js';
import { loadNimiq } from '../nimiq.js';

export async function sendView() {
    const address = await getStoredAddress();
    if (!address) {
        navigate('#welcome');
        return document.createElement('div');
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Send NIM</h1>
            </div>
            <div class="nq-card-body">
                <div class="form-group">
                    <label class="nq-label">Recipient Address</label>
                    <input type="text" class="nq-input" id="recipient" placeholder="NQ...">
                </div>
                <div class="form-group">
                    <label class="nq-label">Amount (NIM)</label>
                    <input type="number" class="nq-input" id="amount" placeholder="0.00" step="0.00001" min="0">
                </div>
                <div class="form-group">
                    <label class="nq-label">Message (optional, max 64 bytes)</label>
                    <input type="text" class="nq-input" id="message" placeholder="Optional message">
                </div>
                <div class="form-group">
                    <label class="nq-label">Fee (luna)</label>
                    <input type="number" class="nq-input" id="fee" placeholder="0" value="0" min="0" step="1">
                </div>
                <div class="form-group password-section" id="password-section" style="display: none;">
                    <label class="nq-label">Enter Password to Sign</label>
                    <input type="password" class="nq-input" id="password" placeholder="Password" autocomplete="current-password">
                </div>
                <p class="nq-text error-text" id="error" style="display: none;"></p>
                <div class="success-message" id="success" style="display: none;">
                    <p class="nq-text success-text">Transaction sent successfully!</p>
                    <p class="nq-text tx-hash" id="tx-hash"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-send">Continue</button>
            </div>
        </div>
    `;

    let confirmed = false;
    let sending = false; // Double-send protection

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-send').addEventListener('click', async () => {
        if (sending) return; // Prevent double-click

        const errorEl = el.querySelector('#error');
        const successEl = el.querySelector('#success');
        errorEl.style.display = 'none';
        successEl.style.display = 'none';

        if (!confirmed) {
            // Step 1: Validate inputs and show password field
            const recipientValue = el.querySelector('#recipient').value.trim();
            const amountValue = parseFloat(el.querySelector('#amount').value);

            if (!recipientValue) {
                errorEl.textContent = 'Please enter a recipient address.';
                errorEl.style.display = '';
                return;
            }

            try {
                const Nimiq = await loadNimiq();
                Nimiq.Address.fromString(recipientValue);
            } catch {
                errorEl.textContent = 'Invalid Nimiq address.';
                errorEl.style.display = '';
                return;
            }

            if (recipientValue.replace(/\s/g, '') === address.replace(/\s/g, '')) {
                errorEl.textContent = 'Warning: You are sending to your own address.';
                errorEl.style.display = '';
                // Allow proceeding — just warn, don't block
            }

            if (!amountValue || amountValue <= 0) {
                errorEl.textContent = 'Please enter a valid amount.';
                errorEl.style.display = '';
                return;
            }

            const msgBytes = new TextEncoder().encode(el.querySelector('#message').value);
            if (msgBytes.length > 64) {
                errorEl.textContent = 'Message exceeds 64 bytes.';
                errorEl.style.display = '';
                return;
            }

            confirmed = true;
            el.querySelector('#password-section').style.display = '';
            el.querySelector('#btn-send').textContent = 'Send Transaction';
            el.querySelector('#password').focus();
            return;
        }

        // Step 2: Sign and send
        const pwInput = el.querySelector('#password');

        if (!pwInput.value) {
            errorEl.textContent = 'Please enter your password.';
            errorEl.style.display = '';
            return;
        }

        const btn = el.querySelector('#btn-send');
        btn.disabled = true;
        btn.textContent = 'Signing...';
        sending = true;

        try {
            const recipientValue = el.querySelector('#recipient').value.trim();
            const amountValue = el.querySelector('#amount').value;
            const feeValue = parseInt(el.querySelector('#fee').value) || 0;
            const messageValue = el.querySelector('#message').value;

            const valueLuna = nimToLuna(amountValue);
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            // Validate networkId matches expected config
            const expectedConfig = getNetworkConfig();
            if (networkId !== expectedConfig.id) {
                throw new Error('Network ID mismatch');
            }

            btn.textContent = 'Signing...';

            // Sign in the keyguard worker — key never reaches main thread
            const { serializedTx } = await signTransaction({
                senderAddress: address,
                recipientAddress: recipientValue,
                value: valueLuna,
                fee: feeValue,
                message: messageValue,
                validityStartHeight,
                networkId,
                password: pwInput.value,
            });

            // Clear password immediately after sending to worker
            pwInput.value = '';

            btn.textContent = 'Sending...';

            // Send the serialized transaction via the network
            const result = await network.sendSerializedTransaction(serializedTx);

            successEl.style.display = '';
            el.querySelector('#tx-hash').textContent = `TX: ${result.transactionHash.substring(0, 16)}...`;
            btn.textContent = 'Done';

            setTimeout(() => navigate('#dashboard'), 3000);
        } catch (e) {
            pwInput.value = '';
            console.error('Transaction failed:', e);
            const msg = e.message || '';
            if (msg.includes('Wrong password') || msg.includes('No wallet')) {
                errorEl.textContent = 'Wrong password or no wallet found.';
            } else if (msg.includes('Network ID mismatch')) {
                errorEl.textContent = 'Network mismatch. Please check your network setting.';
            } else if (msg.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else {
                errorEl.textContent = 'Transaction failed. Please try again.';
            }
            errorEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Send Transaction';
            sending = false;
        }
    });

    return el;
}
