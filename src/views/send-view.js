import { navigate } from '../router.js';
import { getStoredAddress, getKey } from '../modules/key-store.js';
import * as network from '../modules/network-client.js';
import { buildAndSign } from '../modules/transaction-builder.js';
import { nimToLuna, formatNim, LUNAS_PER_NIM } from '../config.js';
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
                    <input type="text" class="nq-input" id="message" placeholder="Optional message" maxlength="64">
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

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-send').addEventListener('click', async () => {
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
        const recipientValue = el.querySelector('#recipient').value.trim();
        const amountValue = parseFloat(el.querySelector('#amount').value);
        const feeValue = parseInt(el.querySelector('#fee').value) || 0;
        const messageValue = el.querySelector('#message').value;
        const password = el.querySelector('#password').value;

        if (!password) {
            errorEl.textContent = 'Please enter your password.';
            errorEl.style.display = '';
            return;
        }

        const btn = el.querySelector('#btn-send');
        btn.disabled = true;
        btn.textContent = 'Signing...';

        try {
            const entropy = await getKey(password);
            if (!entropy) {
                throw new Error('Wrong password or no wallet found.');
            }

            btn.textContent = 'Sending...';

            const valueLuna = nimToLuna(amountValue);
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            const tx = await buildAndSign({
                senderAddress: address,
                recipientAddress: recipientValue,
                value: valueLuna,
                fee: feeValue,
                entropy,
                message: messageValue,
                validityStartHeight,
                networkId,
            });

            const result = await network.sendTransaction(tx);

            successEl.style.display = '';
            el.querySelector('#tx-hash').textContent = `TX: ${result.transactionHash.substring(0, 16)}...`;
            btn.textContent = 'Done';

            setTimeout(() => navigate('#dashboard'), 3000);
        } catch (e) {
            errorEl.textContent = e.message || 'Transaction failed.';
            errorEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Send Transaction';
        }
    });

    return el;
}
