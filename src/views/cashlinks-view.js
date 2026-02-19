import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, generateCashlinkKeys, signBatchTransaction } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, formatNim, getNetworkConfig } from '../config.js';
import { encodeCashlink, CASHLINK_FUNDING_DATA } from '../modules/cashlink-encoder.js';
import { renderQr } from '../lib/qr-encoder.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';

export async function cashlinksView() {
    const defaultAddress = await getStoredAddress();
    if (!defaultAddress) {
        navigate('#welcome');
        return document.createElement('div');
    }

    const activeIdx = getActiveAddressIndex();
    let address = defaultAddress;
    try {
        const result = await getDerivedAddresses();
        if (result?.addresses?.[activeIdx]) {
            address = result.addresses[activeIdx].address;
        }
    } catch (_) {}

    const el = document.createElement('div');
    el.className = 'view-container';

    let stopRequested = false;

    // ── Step 1: Input form ──────────────────────────────────────────

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Create Cashlinks</h1>
                <p class="nq-text">Generate funded links redeemable via the Nimiq Hub.</p>
            </div>
            <div class="nq-card-body">
                <div class="form-group">
                    <label class="nq-label">Number of cashlinks (1–100)</label>
                    <input type="number" class="nq-input" id="cl-count" placeholder="1" value="1" min="1" max="100" step="1">
                </div>
                <div class="form-group">
                    <label class="nq-label">Amount per cashlink (NIM)</label>
                    <input type="number" class="nq-input" id="cl-amount" placeholder="1.00" step="0.00001" min="0">
                </div>
                <div class="form-group">
                    <label class="nq-label">Message (optional)</label>
                    <input type="text" class="nq-input" id="cl-message" placeholder="" maxlength="255">
                </div>
                <div class="form-group">
                    <label class="nq-label">Fee per funding TX (luna)</label>
                    <input type="number" class="nq-input" id="cl-fee" placeholder="0" value="0" min="0" step="1">
                </div>
                <p class="nq-text error-text" id="cl-error" style="display:none;"></p>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-generate">Generate</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-generate').addEventListener('click', async () => {
        const errorEl = el.querySelector('#cl-error');
        errorEl.style.display = 'none';

        const count = parseInt(el.querySelector('#cl-count').value);
        const amountRaw = el.querySelector('#cl-amount').value.trim();
        const amountLuna = nimToLuna(amountRaw);
        const feeValue = Math.max(0, parseInt(el.querySelector('#cl-fee').value) || 0);
        const message = el.querySelector('#cl-message').value.trim();

        if (!Number.isInteger(count) || count < 1 || count > 100) {
            errorEl.textContent = 'Count must be between 1 and 100.';
            errorEl.style.display = '';
            return;
        }
        if (isNaN(amountLuna) || amountLuna <= 0) {
            errorEl.textContent = 'Please enter a valid amount.';
            errorEl.style.display = '';
            return;
        }

        const msgBytes = message ? new TextEncoder().encode(message) : new Uint8Array(0);
        if (msgBytes.length > 255) {
            errorEl.textContent = 'Message is too long (max 255 bytes).';
            errorEl.style.display = '';
            return;
        }

        const btn = el.querySelector('#btn-generate');
        btn.disabled = true;
        btn.textContent = 'Generating keys...';

        try {
            const { keys } = await generateCashlinkKeys({ count });
            showPreview(keys, amountLuna, feeValue, message);
        } catch (e) {
            console.error('Key generation failed:', e);
            errorEl.textContent = 'Key generation failed. Please try again.';
            errorEl.style.display = '';
            btn.textContent = 'Generate';
            btn.disabled = false;
        }
    });

    // ── Step 2: Preview ─────────────────────────────────────────────

    function showPreview(keys, amountLuna, feeValue, message) {
        const totalCost = (amountLuna + feeValue) * keys.length;

        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Cashlink Preview</h1>
                </div>
                <div class="nq-card-body">
                    <div class="batch-summary">
                        <div class="batch-summary-item">
                            <div class="num" id="s-count"></div>
                            <div class="lbl">Cashlinks</div>
                        </div>
                        <div class="batch-summary-item">
                            <div class="num" id="s-each"></div>
                            <div class="lbl">Each</div>
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
                            <thead><tr><th>#</th><th>Address</th><th>Amount</th><th>Status</th></tr></thead>
                            <tbody id="batch-tbody"></tbody>
                        </table>
                    </div>
                    <p class="nq-text error-text" id="cl-error" style="display:none;"></p>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-edit">Edit</button>
                    <button class="nq-button light-blue" id="btn-fund">Fund Cashlinks</button>
                </div>
            </div>
        `;

        el.querySelector('#s-count').textContent = keys.length;
        el.querySelector('#s-each').textContent = formatNim(amountLuna) + ' NIM';
        el.querySelector('#s-total').textContent = formatNim(totalCost) + ' NIM';

        const btnFund = el.querySelector('#btn-fund');

        // Build table rows (DOM API, XSS-safe)
        const tbody = el.querySelector('#batch-tbody');
        for (let i = 0; i < keys.length; i++) {
            const tr = document.createElement('tr');
            const tdNum = document.createElement('td');
            tdNum.textContent = i + 1;
            const tdAddr = document.createElement('td');
            tdAddr.textContent = truncateAddress(keys[i].address);
            tdAddr.title = keys[i].address;
            const tdAmt = document.createElement('td');
            tdAmt.textContent = formatNim(amountLuna);
            const tdStatus = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'batch-badge batch-badge-pending';
            badge.textContent = 'Pending';
            tdStatus.appendChild(badge);
            tr.append(tdNum, tdAddr, tdAmt, tdStatus);
            tbody.appendChild(tr);
        }

        // Fetch balance
        network.getBalance(address).then(balance => {
            el.querySelector('#s-balance').textContent = formatNim(balance) + ' NIM';
            if (balance < totalCost) {
                const warning = el.querySelector('#balance-warning');
                warning.textContent = 'Insufficient balance to fund all cashlinks.';
                warning.style.display = '';
                btnFund.disabled = true;
            }
        }).catch(() => {
            el.querySelector('#s-balance').textContent = '?';
        });

        el.querySelector('#btn-edit').addEventListener('click', () => navigate('#cashlinks'));
        btnFund.addEventListener('click', () => startSigning(keys, amountLuna, feeValue, message));
    }

    // ── Step 3: Sign & Broadcast ────────────────────────────────────

    async function startSigning(keys, amountLuna, feeValue, message) {
        const btnFund = el.querySelector('#btn-fund');
        const errorEl = el.querySelector('#cl-error');
        errorEl.style.display = 'none';
        btnFund.disabled = true;
        btnFund.textContent = 'Opening keyguard...';

        try {
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            const expectedConfig = getNetworkConfig();
            if (networkId !== expectedConfig.id) {
                throw new Error('Network ID mismatch');
            }

            // Build funding transactions with CASH extra data marker
            const transactions = keys.map(key => ({
                recipientAddress: key.address,
                value: amountLuna,
                fee: feeValue,
                extraData: CASHLINK_FUNDING_DATA,
                validityStartHeight,
                networkId,
            }));

            const { serializedTransactions } = await signBatchTransaction({
                senderAddress: address,
                transactions,
                addressIndex: activeIdx,
            });

            // Replace footer with stop button
            const footer = el.querySelector('.nq-card-footer');
            footer.innerHTML = '';
            const btnStop = document.createElement('button');
            btnStop.className = 'nq-button red';
            btnStop.textContent = 'Stop';
            btnStop.addEventListener('click', () => { stopRequested = true; });
            footer.appendChild(btnStop);

            // Parallel broadcast (concurrency 4)
            const CONCURRENCY = 4;
            let sent = 0, failed = 0;
            const rows = el.querySelectorAll('#batch-tbody tr');
            const fundedKeys = [];

            for (let i = 0; i < serializedTransactions.length; i += CONCURRENCY) {
                if (stopRequested) break;

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
                        updateRowStatus(rows[j], 'sent', 'Funded');
                        sent++;
                        fundedKeys.push(keys[j]);
                    } else {
                        updateRowStatus(rows[j], 'failed', 'Failed');
                        failed++;
                    }
                }
            }

            showResults(fundedKeys, amountLuna, message, sent, failed);

        } catch (e) {
            btnFund.disabled = false;
            btnFund.textContent = 'Fund Cashlinks';

            if (e.message === 'User cancelled') return;

            console.error('Cashlink funding failed:', e);
            const msg = e.message || '';
            if (msg.includes('Network ID mismatch')) {
                errorEl.textContent = 'Network mismatch. Please check your network setting.';
            } else if (msg.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else if (msg.includes('timed out')) {
                errorEl.textContent = 'Keyguard timed out. Please try again.';
            } else {
                errorEl.textContent = 'Funding failed. Please try again.';
            }
            errorEl.style.display = '';
        }
    }

    // ── Step 4: Results ─────────────────────────────────────────────

    function showResults(fundedKeys, amountLuna, message, sent, failed) {
        // Build cashlink URLs
        const cashlinks = fundedKeys.map(key => ({
            url: encodeCashlink({
                privateKeyBytes: new Uint8Array(key.privateKeyBytes),
                valueLuna: amountLuna,
                message: message || undefined,
            }),
            address: key.address,
        }));

        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Cashlinks Created</h1>
                    <p class="nq-text" id="result-summary"></p>
                </div>
                <div class="nq-card-body">
                    <div class="cashlink-actions">
                        <button class="nq-button-s" id="btn-copy-all">Copy All URLs</button>
                        <button class="nq-button-s" id="btn-export-csv">Export CSV</button>
                    </div>
                    <div class="cashlink-list" id="cashlink-list"></div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-done">Back to Dashboard</button>
                </div>
            </div>
        `;

        const summaryParts = [`${sent} funded`];
        if (failed > 0) summaryParts.push(`${failed} failed`);
        el.querySelector('#result-summary').textContent = summaryParts.join(', ');

        // Render each cashlink
        const listEl = el.querySelector('#cashlink-list');
        cashlinks.forEach((cl, i) => {
            const item = document.createElement('div');
            item.className = 'cashlink-item';

            const header = document.createElement('div');
            header.className = 'cashlink-item-header';

            const label = document.createElement('span');
            label.className = 'nq-label';
            label.textContent = `#${i + 1}  \u2014  ${formatNim(amountLuna)} NIM`;

            const copyBtn = document.createElement('button');
            copyBtn.className = 'nq-button-s cashlink-copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(cl.url);
                    showToast('Cashlink URL copied!', 'success');
                } catch (_) {}
            });

            header.append(label, copyBtn);

            const urlEl = document.createElement('div');
            urlEl.className = 'cashlink-url';
            urlEl.textContent = cl.url;

            const qrContainer = document.createElement('div');
            qrContainer.className = 'cashlink-qr';

            item.append(header, urlEl, qrContainer);
            listEl.appendChild(item);

            // Render QR after DOM insertion
            setTimeout(() => {
                const canvas = document.createElement('canvas');
                const styles = getComputedStyle(document.documentElement);
                const fill = styles.getPropertyValue('--color-qr-fill').trim() || '#1F2348';
                const bg = styles.getPropertyValue('--color-qr-bg').trim() || '#ffffff';
                renderQr({ text: cl.url, size: 160, fill, background: bg, radius: 0.4 }, canvas);
                qrContainer.appendChild(canvas);
            }, 0);
        });

        // Copy All
        el.querySelector('#btn-copy-all').addEventListener('click', async () => {
            const allUrls = cashlinks.map(cl => cl.url).join('\n');
            try {
                await navigator.clipboard.writeText(allUrls);
                showToast('All URLs copied!', 'success');
            } catch (_) {}
        });

        // Export CSV
        el.querySelector('#btn-export-csv').addEventListener('click', () => {
            const header = 'URL,Address,Amount (NIM)\n';
            const rows = cashlinks.map(cl =>
                `${cl.url},${cl.address},${formatNim(amountLuna)}`
            ).join('\n');
            const blob = new Blob([header + rows], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `cashlinks-${Date.now()}.csv`;
            a.click();
            URL.revokeObjectURL(url);
        });

        el.querySelector('#btn-done').addEventListener('click', () => navigate('#dashboard'));
    }

    // ── Helpers ──────────────────────────────────────────────────────

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

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => { stopRequested = true; cleanupSwipe(); },
    };
}
