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
                <p class="nq-text error-text" id="error" style="display: none;"></p>
                <div class="success-message" id="success" style="display: none;">
                    <p class="nq-text success-text">Transaction sent successfully!</p>
                    <p class="nq-text tx-hash" id="tx-hash"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-send">Send</button>
            </div>
        </div>
    `;

    let sending = false; // Prevent double-send

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-send').addEventListener('click', async () => {
        if (sending) return;

        const errorEl = el.querySelector('#error');
        const successEl = el.querySelector('#success');
        errorEl.style.display = 'none';
        successEl.style.display = 'none';

        // Validate inputs
        const recipientValue = el.querySelector('#recipient').value.trim();
        const amountRaw = el.querySelector('#amount').value.trim();
        const valueLuna = nimToLuna(amountRaw);

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

        if (isNaN(valueLuna) || valueLuna <= 0) {
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

        const btn = el.querySelector('#btn-send');
        btn.disabled = true;
        btn.textContent = 'Opening keyguard...';
        sending = true;

        try {
            const feeValue = parseInt(el.querySelector('#fee').value) || 0;
            const messageValue = el.querySelector('#message').value;
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            const expectedConfig = getNetworkConfig();
            if (networkId !== expectedConfig.id) {
                throw new Error('Network ID mismatch');
            }

            // Keyguard shows TX confirmation + password entry; signs if approved
            const { serializedTx } = await signTransaction({
                senderAddress: address,
                recipientAddress: recipientValue,
                value: valueLuna,
                fee: feeValue,
                message: messageValue,
                validityStartHeight,
                networkId,
            });

            btn.textContent = 'Sending...';

            const result = await network.sendSerializedTransaction(serializedTx);

            successEl.style.display = '';
            el.querySelector('#tx-hash').textContent = `TX: ${result.transactionHash.substring(0, 16)}...`;
            btn.textContent = 'Done';

            setTimeout(() => navigate('#dashboard'), 3000);
        } catch (e) {
            sending = false;
            btn.disabled = false;
            btn.textContent = 'Send';

            // User cancelled in keyguard — silently re-enable, no error shown
            if (e.message === 'User cancelled') return;

            console.error('Transaction failed:', e);
            const msg = e.message || '';
            if (msg.includes('Network ID mismatch')) {
                errorEl.textContent = 'Network mismatch. Please check your network setting.';
            } else if (msg.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else {
                errorEl.textContent = 'Transaction failed. Please try again.';
            }
            errorEl.style.display = '';
        }
    });

    return el;
}
