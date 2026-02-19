import { navigate } from '../router.js';
import { getStoredAddress, signBatchTransaction } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, formatNim, getNetworkConfig } from '../config.js';
import { loadNimiq } from '../nimiq.js';

export async function batchSendView() {
    const address = await getStoredAddress();
    if (!address) {
        navigate('#welcome');
        return document.createElement('div');
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    let stopRequested = false;

    // ── Step 1: Input form ──────────────────────────────────────────
    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Batch Send NIM</h1>
                <p class="nq-text-s">Send NIM to multiple recipients at once.</p>
            </div>
            <div class="nq-card-body">
                <div class="form-group">
                    <label class="nq-label">Recipient Addresses</label>
                    <textarea class="nq-input" id="recipients" rows="6"
                        placeholder="One address per line&#10;NQ52 2CNA U8HC N61T HA9G 1X44 79Q0 VBCE LK14&#10;NQ07 ...</textarea>
                    <div class="file-upload-wrapper">
                        <label class="file-upload-label" for="file-upload">Upload CSV / TXT</label>
                        <input type="file" id="file-upload" accept=".csv,.txt" style="display:none;">
                    </div>
                </div>
                <div class="form-group">
                    <label class="nq-label">Amount per recipient (NIM)</label>
                    <input type="number" class="nq-input" id="amount" placeholder="0.00" step="0.00001" min="0">
                </div>
                <div class="form-group">
                    <label class="nq-label">Fee per transaction (luna)</label>
                    <input type="number" class="nq-input" id="fee" placeholder="0" value="0" min="0" step="1">
                </div>
                <div class="form-group">
                    <label class="nq-label">Message (optional, max 64 bytes, applied to all)</label>
                    <input type="text" class="nq-input" id="message" placeholder="Optional message">
                </div>
                <p class="nq-text error-text" id="error" style="display:none;"></p>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-validate">Validate & Preview</button>
            </div>
        </div>
    `;

    // File upload handler
    el.querySelector('#file-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            el.querySelector('#recipients').value = reader.result;
        };
        reader.readAsText(file);
    });

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-validate').addEventListener('click', async () => {
        const errorEl = el.querySelector('#error');
        errorEl.style.display = 'none';

        // Parse addresses
        const rawText = el.querySelector('#recipients').value;
        const lines = rawText.split('\n');
        const parsed = [];
        const errors = [];

        const Nimiq = await loadNimiq();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#') || line.toLowerCase().startsWith('address')) continue;
            try {
                Nimiq.Address.fromString(line);
                parsed.push(line);
            } catch {
                errors.push(`Line ${i + 1}: invalid address`);
            }
        }

        if (errors.length > 0) {
            errorEl.textContent = errors.slice(0, 5).join('; ') +
                (errors.length > 5 ? ` ... and ${errors.length - 5} more` : '');
            errorEl.style.display = '';
            return;
        }

        if (parsed.length === 0) {
            errorEl.textContent = 'No valid recipient addresses found.';
            errorEl.style.display = '';
            return;
        }

        // Validate amount
        const amountRaw = el.querySelector('#amount').value.trim();
        const valueLuna = nimToLuna(amountRaw);
        if (isNaN(valueLuna) || valueLuna <= 0) {
            errorEl.textContent = 'Please enter a valid amount.';
            errorEl.style.display = '';
            return;
        }

        // Validate message
        const messageValue = el.querySelector('#message').value;
        const msgBytes = new TextEncoder().encode(messageValue);
        if (msgBytes.length > 64) {
            errorEl.textContent = 'Message exceeds 64 bytes.';
            errorEl.style.display = '';
            return;
        }

        const feeValue = Math.max(0, parseInt(el.querySelector('#fee').value) || 0);

        showPreview(parsed, valueLuna, feeValue, messageValue, amountRaw);
    });

    // ── Step 2: Preview ─────────────────────────────────────────────
    function showPreview(recipients, valueLuna, feeValue, messageValue, amountDisplay) {
        const totalCostLuna = (valueLuna + feeValue) * recipients.length;

        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Batch Send Preview</h1>
                </div>
                <div class="nq-card-body">
                    <div class="batch-summary">
                        <div class="batch-summary-item">
                            <div class="num" id="s-count"></div>
                            <div class="lbl">Recipients</div>
                        </div>
                        <div class="batch-summary-item">
                            <div class="num" id="s-each"></div>
                            <div class="lbl">NIM Each</div>
                        </div>
                        <div class="batch-summary-item">
                            <div class="num" id="s-total"></div>
                            <div class="lbl">Total Cost</div>
                        </div>
                        <div class="batch-summary-item">
                            <div class="num" id="s-balance">...</div>
                            <div class="lbl">Balance</div>
                        </div>
                    </div>
                    <p class="nq-text error-text" id="balance-warning" style="display:none;"></p>
                    <div class="batch-table-container">
                        <table class="batch-table">
                            <thead><tr><th>#</th><th>Recipient</th><th>Status</th></tr></thead>
                            <tbody id="batch-tbody"></tbody>
                        </table>
                    </div>
                    <p class="nq-text error-text" id="error" style="display:none;"></p>
                    <div id="batch-result" style="display:none;">
                        <p class="nq-text success-text" id="result-text"></p>
                    </div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-edit">Edit</button>
                    <button class="nq-button light-blue" id="btn-sign">Sign & Send</button>
                </div>
            </div>
        `;

        // Populate summary via textContent (XSS-safe)
        el.querySelector('#s-count').textContent = recipients.length;
        el.querySelector('#s-each').textContent = amountDisplay;
        el.querySelector('#s-total').textContent = formatNim(totalCostLuna);

        // Build table rows via DOM (XSS-safe)
        const tbody = el.querySelector('#batch-tbody');
        recipients.forEach((addr, i) => {
            const tr = document.createElement('tr');
            const tdNum = document.createElement('td');
            tdNum.textContent = i + 1;
            const tdAddr = document.createElement('td');
            tdAddr.textContent = truncateAddress(addr);
            tdAddr.title = addr;
            const tdStatus = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'batch-badge batch-badge-pending';
            badge.textContent = 'Pending';
            tdStatus.appendChild(badge);
            tr.appendChild(tdNum);
            tr.appendChild(tdAddr);
            tr.appendChild(tdStatus);
            tbody.appendChild(tr);
        });

        // Fetch balance
        const btnSign = el.querySelector('#btn-sign');
        network.getBalance(address).then(balance => {
            el.querySelector('#s-balance').textContent = formatNim(balance);
            if (balance < totalCostLuna) {
                const warn = el.querySelector('#balance-warning');
                warn.textContent = 'Insufficient balance for this batch.';
                warn.style.display = '';
                btnSign.disabled = true;
            }
        }).catch(() => {
            el.querySelector('#s-balance').textContent = '?';
        });

        el.querySelector('#btn-edit').addEventListener('click', () => navigate('#batch-send'));

        btnSign.addEventListener('click', () => {
            startSigning(recipients, valueLuna, feeValue, messageValue);
        });
    }

    // ── Step 3 & 4: Sign and broadcast ──────────────────────────────
    async function startSigning(recipients, valueLuna, feeValue, messageValue) {
        const btnSign = el.querySelector('#btn-sign');
        const errorEl = el.querySelector('#error');
        errorEl.style.display = 'none';

        btnSign.disabled = true;
        btnSign.textContent = 'Opening keyguard...';

        try {
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            const expectedConfig = getNetworkConfig();
            if (networkId !== expectedConfig.id) {
                throw new Error('Network ID mismatch');
            }

            const transactions = recipients.map(recipientAddress => ({
                recipientAddress,
                value: valueLuna,
                fee: feeValue,
                message: messageValue,
                validityStartHeight,
                networkId,
            }));

            const { serializedTransactions } = await signBatchTransaction({
                senderAddress: address,
                transactions,
            });

            // Replace footer with stop button
            const footer = el.querySelector('.nq-card-footer');
            footer.innerHTML = '';
            const btnStop = document.createElement('button');
            btnStop.className = 'nq-button red';
            btnStop.textContent = 'Stop';
            btnStop.addEventListener('click', () => { stopRequested = true; });
            footer.appendChild(btnStop);

            // Parallel broadcast in small batches for speed
            const CONCURRENCY = 4;
            let sent = 0, failed = 0, skipped = 0;
            const rows = el.querySelectorAll('#batch-tbody tr');

            for (let i = 0; i < serializedTransactions.length; i += CONCURRENCY) {
                if (stopRequested) {
                    skipped = serializedTransactions.length - i;
                    break;
                }

                const chunk = [];
                for (let j = i; j < Math.min(i + CONCURRENCY, serializedTransactions.length); j++) {
                    updateRowStatus(rows[j], 'sending', 'Sending...');
                    chunk.push(j);
                }

                const results = await Promise.allSettled(
                    chunk.map(j => network.sendSerializedTransaction(serializedTransactions[j]))
                );

                for (let k = 0; k < results.length; k++) {
                    const j = chunk[k];
                    if (results[k].status === 'fulfilled') {
                        updateRowStatus(rows[j], 'sent', 'Sent');
                        sent++;
                    } else {
                        updateRowStatus(rows[j], 'failed', 'Failed');
                        failed++;
                    }
                }
            }

            // Show result
            footer.innerHTML = '';
            const btnDone = document.createElement('button');
            btnDone.className = 'nq-button-s';
            btnDone.textContent = 'Back to Dashboard';
            btnDone.addEventListener('click', () => navigate('#dashboard'));
            footer.appendChild(btnDone);

            const resultEl = el.querySelector('#batch-result');
            resultEl.style.display = '';
            const resultText = el.querySelector('#result-text');
            const parts = [`${sent} sent`];
            if (failed > 0) parts.push(`${failed} failed`);
            if (skipped > 0) parts.push(`${skipped} skipped`);
            resultText.textContent = parts.join(', ');

        } catch (e) {
            btnSign.disabled = false;
            btnSign.textContent = 'Sign & Send';

            if (e.message === 'User cancelled') return;

            console.error('Batch send failed:', e);
            const msg = e.message || '';
            if (msg.includes('Network ID mismatch')) {
                errorEl.textContent = 'Network mismatch. Please check your network setting.';
            } else if (msg.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else if (msg.includes('timed out')) {
                errorEl.textContent = 'Keyguard timed out. Please try again.';
            } else {
                errorEl.textContent = 'Batch signing failed. Please try again.';
            }
            errorEl.style.display = '';
        }
    }

    function updateRowStatus(row, status, text) {
        const badge = row.querySelector('.batch-badge');
        badge.className = `batch-badge batch-badge-${status}`;
        badge.textContent = text;
    }

    function truncateAddress(addr) {
        const s = String(addr);
        if (s.length <= 22) return s;
        return s.substring(0, 9) + '...' + s.substring(s.length - 9);
    }

    return {
        element: el,
        cleanup: () => { stopRequested = true; },
    };
}
