import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, generateCashlinkKeys, signBatchTransaction, getCashlinkAddresses, signCashlinkClaims } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, formatNim, getNetworkConfig } from '../config.js';
import { encodeCashlink, decodeCashlink, CASHLINK_FUNDING_DATA } from '../modules/cashlink-encoder.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { getSavedRunsMeta, savePreEncryptedRun, loadCashlinkRun, deleteCashlinkRun } from '../modules/cashlink-storage.js';

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
    let currentMode = 'create';

    // ── Mode switching ──────────────────────────────────────────

    function showCreateMode() {
        currentMode = 'create';
        stopRequested = false;
        showCreateInput();
    }

    function showClaimMode() {
        currentMode = 'claim';
        stopRequested = false;
        showClaimInput();
    }

    // ── Tab bar helper ──────────────────────────────────────────

    function renderTabs(container) {
        const tabs = document.createElement('div');
        tabs.className = 'cashlink-tabs';

        const createTab = document.createElement('button');
        createTab.className = 'cashlink-tab' + (currentMode === 'create' ? ' active' : '');
        createTab.textContent = 'Create';
        createTab.addEventListener('click', () => { if (currentMode !== 'create') showCreateMode(); });

        const claimTab = document.createElement('button');
        claimTab.className = 'cashlink-tab' + (currentMode === 'claim' ? ' active' : '');
        claimTab.textContent = 'Claim';
        claimTab.addEventListener('click', () => { if (currentMode !== 'claim') showClaimMode(); });

        tabs.append(createTab, claimTab);
        container.appendChild(tabs);
    }

    // ── Create: Step 1 — Input form ─────────────────────────────

    function showCreateInput() {
        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'nq-card';

        // Header with tabs
        const header = document.createElement('div');
        header.className = 'nq-card-header';
        renderTabs(header);
        const subtitle = document.createElement('p');
        subtitle.className = 'nq-text';
        subtitle.textContent = 'Generate funded links redeemable via the Nimiq Hub.';
        header.appendChild(subtitle);

        // Body
        const body = document.createElement('div');
        body.className = 'nq-card-body';
        body.innerHTML = `
            <div class="form-group">
                <label class="nq-label" for="cl-count">Number of cashlinks (1\u2013100)</label>
                <input type="number" class="nq-input" id="cl-count" placeholder="1" value="1" min="1" max="100" step="1">
            </div>
            <div class="form-group">
                <label class="nq-label" for="cl-amount">Amount per cashlink (NIM)</label>
                <input type="number" class="nq-input" id="cl-amount" placeholder="1.00" step="0.00001" min="0">
            </div>
            <div class="form-group">
                <label class="nq-label" for="cl-message">Message (optional)</label>
                <input type="text" class="nq-input" id="cl-message" placeholder="" maxlength="255">
            </div>
            <div class="form-group">
                <label class="nq-label" for="cl-fee">Fee per funding TX (luna)</label>
                <input type="number" class="nq-input" id="cl-fee" placeholder="0" value="0" min="0" step="1">
            </div>
            <p class="nq-text error-text" id="cl-error" role="alert" style="display:none;"></p>
        `;

        // Saved runs section
        const savedSection = document.createElement('div');
        savedSection.className = 'saved-runs-section';
        const savedHeader = document.createElement('h2');
        savedHeader.className = 'nq-label';
        savedHeader.textContent = 'Saved Runs';
        savedSection.appendChild(savedHeader);
        const savedList = document.createElement('div');
        savedList.className = 'saved-runs-list';
        savedSection.appendChild(savedList);
        body.appendChild(savedSection);

        renderSavedRuns(savedSection, savedList);

        // Footer
        const footer = document.createElement('div');
        footer.className = 'nq-card-footer';
        const btnBack = document.createElement('button');
        btnBack.className = 'nq-button-s';
        btnBack.textContent = 'Back';
        btnBack.addEventListener('click', () => navigate('#dashboard'));
        const btnGenerate = document.createElement('button');
        btnGenerate.className = 'nq-button light-blue';
        btnGenerate.textContent = 'Generate';
        btnGenerate.addEventListener('click', async () => {
            const errorEl = body.querySelector('#cl-error');
            errorEl.style.display = 'none';

            const count = parseInt(body.querySelector('#cl-count').value);
            const amountRaw = body.querySelector('#cl-amount').value.trim();
            const amountLuna = nimToLuna(amountRaw);
            const feeValue = Math.max(0, parseInt(body.querySelector('#cl-fee').value) || 0);
            const message = body.querySelector('#cl-message').value.trim();

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

            btnGenerate.disabled = true;
            btnGenerate.setAttribute('aria-busy', 'true');
            btnGenerate.textContent = 'Generating keys...';

            try {
                const { keys } = await generateCashlinkKeys({ count });
                showCreatePreview(keys, amountLuna, feeValue, message);
            } catch (e) {
                console.error('Key generation failed:', e);
                errorEl.textContent = 'Key generation failed. Please try again.';
                errorEl.style.display = '';
                btnGenerate.textContent = 'Generate';
                btnGenerate.disabled = false;
                btnGenerate.removeAttribute('aria-busy');
            }
        });
        footer.append(btnBack, btnGenerate);

        card.append(header, body, footer);
        el.appendChild(card);
    }

    // ── Saved runs rendering ────────────────────────────────────

    function renderSavedRuns(section, list) {
        const runs = getSavedRunsMeta();
        list.innerHTML = '';

        if (runs.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = '';

        for (const run of runs) {
            const row = document.createElement('div');
            row.className = 'saved-run-row';

            const info = document.createElement('div');
            info.className = 'saved-run-info';

            const dateLine = document.createElement('div');
            dateLine.className = 'saved-run-date';
            dateLine.textContent = new Date(run.date).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });

            const details = document.createElement('div');
            details.className = 'saved-run-details';
            let detailText = `${run.count} cashlink${run.count !== 1 ? 's' : ''} \u00d7 ${run.amountNim} NIM`;
            if (run.message) detailText += ` \u2014 "${run.message}"`;
            details.textContent = detailText;

            info.append(dateLine, details);

            const actions = document.createElement('div');
            actions.className = 'saved-run-actions';

            const viewBtn = document.createElement('button');
            viewBtn.className = 'nq-button-s';
            viewBtn.textContent = 'View';
            viewBtn.addEventListener('click', async () => {
                viewBtn.disabled = true;
                viewBtn.setAttribute('aria-busy', 'true');
                viewBtn.textContent = 'Loading...';
                try {
                    const data = await loadCashlinkRun(run.id);
                    showSavedRunResults(data, run);
                } catch (e) {
                    if (e.message !== 'User cancelled') {
                        showToast('Could not load run.', 'error');
                    }
                    viewBtn.disabled = false;
                    viewBtn.removeAttribute('aria-busy');
                    viewBtn.textContent = 'View';
                }
            });

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'nq-button-s';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => {
                deleteCashlinkRun(run.id);
                renderSavedRuns(section, list);
                showToast('Run deleted', 'info');
            });

            actions.append(viewBtn, deleteBtn);
            row.append(info, actions);
            list.appendChild(row);
        }
    }

    // ── Create: Step 2 — Preview ────────────────────────────────

    function showCreatePreview(keys, amountLuna, feeValue, message) {
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
                    <p class="nq-text error-text" id="balance-warning" role="alert" style="display:none;"></p>
                    <div class="batch-table-container">
                        <table class="batch-table">
                            <thead><tr><th>#</th><th>Address</th><th>Amount</th><th>Status</th></tr></thead>
                            <tbody id="batch-tbody"></tbody>
                        </table>
                    </div>
                    <p class="nq-text error-text" id="cl-error" role="alert" style="display:none;"></p>
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
        btnFund.addEventListener('click', () => startCreateSigning(keys, amountLuna, feeValue, message));
    }

    // ── Create: Step 3 — Sign & Broadcast ───────────────────────

    async function startCreateSigning(keys, amountLuna, feeValue, message) {
        const btnFund = el.querySelector('#btn-fund');
        const errorEl = el.querySelector('#cl-error');
        errorEl.style.display = 'none';
        btnFund.disabled = true;
        btnFund.setAttribute('aria-busy', 'true');
        btnFund.textContent = 'Opening keyguard...';

        try {
            // Generate URLs immediately so they're never lost
            const cashlinks = keys.map(key => ({
                url: encodeCashlink({
                    privateKeyBytes: new Uint8Array(key.privateKeyBytes),
                    valueLuna: amountLuna,
                    message: message || undefined,
                }),
                address: key.address,
            }));
            const encryptPayload = JSON.stringify({
                urls: cashlinks.map(c => c.url),
                addresses: cashlinks.map(c => c.address),
            });

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

            // Sign TXs + encrypt cashlink data in one auth session
            const { serializedTransactions, encryptedData } = await signBatchTransaction({
                senderAddress: address,
                transactions,
                addressIndex: activeIdx,
                encryptData: encryptPayload,
            });

            // Auto-save encrypted run immediately (before broadcasting)
            savePreEncryptedRun({
                ciphertext: encryptedData.ciphertext,
                iv: encryptedData.iv,
                count: keys.length,
                amountNim: formatNim(amountLuna),
                message: message || '',
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
                    } else {
                        updateRowStatus(rows[j], 'failed', 'Failed');
                        failed++;
                    }
                }
            }

            showCreateResults(cashlinks, amountLuna, sent, failed);

        } catch (e) {
            btnFund.disabled = false;
            btnFund.removeAttribute('aria-busy');
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

    // ── Create: Step 4 — Results ────────────────────────────────

    function showCreateResults(cashlinks, amountLuna, sent, failed) {
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
        summaryParts.push('run auto-saved');
        el.querySelector('#result-summary').textContent = summaryParts.join(', ');

        renderCashlinkList(el.querySelector('#cashlink-list'), cashlinks.map(cl => cl.url));

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
            exportCsv(cashlinks.map(cl => cl.url), cashlinks.map(cl => cl.address), formatNim(amountLuna), `cashlinks-${Date.now()}.csv`);
        });

        el.querySelector('#btn-done').addEventListener('click', () => navigate('#dashboard'));
    }

    // ── Saved Run Results ───────────────────────────────────────

    function showSavedRunResults(data, runMeta) {
        el.innerHTML = `
            <div class="nq-card">
                <div class="nq-card-header">
                    <h1 class="nq-h1">Saved Cashlinks</h1>
                    <p class="nq-text" id="saved-run-summary"></p>
                </div>
                <div class="nq-card-body">
                    <div class="cashlink-actions">
                        <button class="nq-button-s" id="btn-copy-all">Copy All URLs</button>
                        <button class="nq-button-s" id="btn-export-csv">Export CSV</button>
                    </div>
                    <div class="cashlink-list" id="cashlink-list"></div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-back-to-form">Back</button>
                </div>
            </div>
        `;

        const summaryParts = [`${data.urls.length} cashlink${data.urls.length !== 1 ? 's' : ''}`];
        if (runMeta.amountNim) summaryParts.push(`${runMeta.amountNim} NIM each`);
        if (runMeta.message) summaryParts.push(`"${runMeta.message}"`);
        el.querySelector('#saved-run-summary').textContent = summaryParts.join(' \u2014 ');

        renderCashlinkList(el.querySelector('#cashlink-list'), data.urls);

        // Copy All
        el.querySelector('#btn-copy-all').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(data.urls.join('\n'));
                showToast('All URLs copied!', 'success');
            } catch (_) {}
        });

        // Export CSV
        el.querySelector('#btn-export-csv').addEventListener('click', () => {
            exportCsv(data.urls, data.addresses || [], runMeta.amountNim, `cashlinks-saved-${runMeta.id}.csv`);
        });

        el.querySelector('#btn-back-to-form').addEventListener('click', () => showCreateMode());
    }

    // ═══════════════════════════════════════════════════════════
    // ══ CLAIM MODE ════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════

    // ── Claim: Step 1 — Input ───────────────────────────────────

    function showClaimInput() {
        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'nq-card';

        // Header with tabs
        const header = document.createElement('div');
        header.className = 'nq-card-header';
        renderTabs(header);
        const subtitle = document.createElement('p');
        subtitle.className = 'nq-text';
        subtitle.textContent = 'Paste cashlink URLs to claim funds back to your wallet.';
        header.appendChild(subtitle);

        // Body
        const body = document.createElement('div');
        body.className = 'nq-card-body';
        body.innerHTML = `
            <div class="form-group">
                <label class="nq-label" for="claim-urls">Cashlink URLs (one per line)</label>
                <textarea class="nq-input" id="claim-urls" rows="6" placeholder="https://hub.nimiq.com/cashlink/#..."></textarea>
            </div>
            <div class="form-group file-upload-wrapper">
                <label class="file-upload-label" id="csv-upload-label">
                    Or upload CSV file
                    <input type="file" accept=".csv,.txt" id="csv-upload" style="display:none">
                </label>
            </div>
            <div class="form-group">
                <label class="nq-label" for="claim-fee">Fee per claim TX (luna)</label>
                <input type="number" class="nq-input" id="claim-fee" placeholder="0" value="0" min="0" step="1">
            </div>
            <p class="nq-text error-text" id="claim-error" role="alert" style="display:none;"></p>
        `;

        // CSV upload handler
        const csvInput = body.querySelector('#csv-upload');
        const csvLabel = body.querySelector('#csv-upload-label');
        csvInput.addEventListener('change', () => {
            const file = csvInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const text = reader.result;
                // Extract cashlink URLs from CSV — first column or any column containing cashlink URLs
                const urls = [];
                const lines = text.split(/\r?\n/);
                for (const line of lines) {
                    const match = line.match(/(https?:\/\/[^\s,]*cashlink[^\s,]*#[^\s,]+)/i);
                    if (match) urls.push(match[1]);
                }
                if (urls.length > 0) {
                    body.querySelector('#claim-urls').value = urls.join('\n');
                    csvLabel.textContent = `Loaded ${urls.length} URL${urls.length !== 1 ? 's' : ''}`;
                } else {
                    const errorEl = body.querySelector('#claim-error');
                    errorEl.textContent = 'No cashlink URLs found in file.';
                    errorEl.style.display = '';
                }
            };
            reader.readAsText(file);
        });

        // Footer
        const footer = document.createElement('div');
        footer.className = 'nq-card-footer';
        const btnBack = document.createElement('button');
        btnBack.className = 'nq-button-s';
        btnBack.textContent = 'Back';
        btnBack.addEventListener('click', () => navigate('#dashboard'));
        const btnParse = document.createElement('button');
        btnParse.className = 'nq-button light-blue';
        btnParse.textContent = 'Check Balances';
        btnParse.addEventListener('click', () => parseAndCheckCashlinks(body, btnParse));
        footer.append(btnBack, btnParse);

        card.append(header, body, footer);
        el.appendChild(card);
    }

    // ── Claim: Parse & check ────────────────────────────────────

    async function parseAndCheckCashlinks(body, btn) {
        const errorEl = body.querySelector('#claim-error');
        errorEl.style.display = 'none';

        const raw = body.querySelector('#claim-urls').value.trim();
        const feeValue = Math.max(0, parseInt(body.querySelector('#claim-fee').value) || 0);

        if (!raw) {
            errorEl.textContent = 'Please paste at least one cashlink URL.';
            errorEl.style.display = '';
            return;
        }

        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        const parsed = [];
        const errors = [];

        for (let i = 0; i < lines.length; i++) {
            try {
                const { privateKeyBytes, valueLuna, message } = decodeCashlink(lines[i]);
                parsed.push({ privateKeyBytes: Array.from(privateKeyBytes), valueLuna, message, line: i + 1 });
            } catch (e) {
                errors.push(`Line ${i + 1}: ${e.message}`);
            }
        }

        if (parsed.length === 0) {
            errorEl.textContent = errors.length > 0 ? errors.join('; ') : 'No valid cashlink URLs found.';
            errorEl.style.display = '';
            return;
        }

        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Checking...';

        try {
            // Derive addresses from private keys (via keyguard)
            const { addresses } = await getCashlinkAddresses({
                privateKeys: parsed.map(p => p.privateKeyBytes),
            });

            // Batch-fetch balances
            const balances = await network.getBalances(addresses);

            // Attach address + balance to each parsed item
            for (let i = 0; i < parsed.length; i++) {
                parsed[i].address = addresses[i];
                parsed[i].balance = balances[addresses[i]] || 0;
            }

            if (errors.length > 0) {
                showToast(`${errors.length} invalid URL${errors.length !== 1 ? 's' : ''} skipped`, 'info');
            }

            showClaimPreview(parsed, feeValue);
        } catch (e) {
            console.error('Cashlink check failed:', e);
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = 'Check Balances';

            if (e.message === 'User cancelled') return;

            if (e.message?.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else {
                errorEl.textContent = 'Failed to check balances. Please try again.';
            }
            errorEl.style.display = '';
        }
    }

    // ── Claim: Step 2 — Preview ─────────────────────────────────

    function showClaimPreview(parsed, feeValue) {
        const claimable = parsed.filter(p => p.balance > feeValue);
        const empty = parsed.filter(p => p.balance === 0);
        const dust = parsed.filter(p => p.balance > 0 && p.balance <= feeValue);
        const totalRecoverable = claimable.reduce((sum, p) => sum + (p.balance - feeValue), 0);

        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'nq-card';

        // Header
        const header = document.createElement('div');
        header.className = 'nq-card-header';
        const h1 = document.createElement('h1');
        h1.className = 'nq-h1';
        h1.textContent = 'Claim Preview';
        header.appendChild(h1);

        // Summary
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'batch-summary';
        summaryDiv.innerHTML = `
            <div class="batch-summary-item">
                <div class="num">${parsed.length}</div>
                <div class="lbl">Total</div>
            </div>
            <div class="batch-summary-item">
                <div class="num">${claimable.length}</div>
                <div class="lbl">Claimable</div>
            </div>
            <div class="batch-summary-item">
                <div class="num">${formatNim(totalRecoverable)}</div>
                <div class="lbl">Recoverable</div>
            </div>
        `;

        // Body
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'nq-card-body';
        bodyDiv.appendChild(summaryDiv);

        // Table
        const tableContainer = document.createElement('div');
        tableContainer.className = 'batch-table-container';
        const table = document.createElement('table');
        table.className = 'batch-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const hdr of ['#', 'Address', 'Balance', 'Status']) {
            const th = document.createElement('th');
            th.textContent = hdr;
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);

        const tbody = document.createElement('tbody');
        tbody.id = 'claim-tbody';

        for (let i = 0; i < parsed.length; i++) {
            const p = parsed[i];
            const tr = document.createElement('tr');

            const tdNum = document.createElement('td');
            tdNum.textContent = i + 1;
            const tdAddr = document.createElement('td');
            tdAddr.textContent = truncateAddress(p.address);
            tdAddr.title = p.address;
            const tdBal = document.createElement('td');
            tdBal.textContent = formatNim(p.balance) + ' NIM';
            const tdStatus = document.createElement('td');
            const badge = document.createElement('span');

            if (p.balance > feeValue) {
                badge.className = 'batch-badge batch-badge-sent';
                badge.textContent = 'Claimable';
            } else if (p.balance === 0) {
                badge.className = 'batch-badge batch-badge-pending';
                badge.textContent = 'Empty';
            } else {
                badge.className = 'batch-badge batch-badge-failed';
                badge.textContent = 'Dust';
            }

            tdStatus.appendChild(badge);
            tr.append(tdNum, tdAddr, tdBal, tdStatus);
            tbody.appendChild(tr);
        }

        table.append(thead, tbody);
        tableContainer.appendChild(table);
        bodyDiv.appendChild(tableContainer);

        if (empty.length > 0 || dust.length > 0) {
            const note = document.createElement('p');
            note.className = 'nq-text';
            note.style.marginTop = '8px';
            note.style.fontSize = '13px';
            const parts = [];
            if (empty.length > 0) parts.push(`${empty.length} empty`);
            if (dust.length > 0) parts.push(`${dust.length} dust (balance \u2264 fee)`);
            note.textContent = parts.join(', ') + ' \u2014 will be skipped.';
            bodyDiv.appendChild(note);
        }

        // Footer
        const footer = document.createElement('div');
        footer.className = 'nq-card-footer';
        const btnBack = document.createElement('button');
        btnBack.className = 'nq-button-s';
        btnBack.textContent = 'Back';
        btnBack.addEventListener('click', () => showClaimMode());
        const btnClaim = document.createElement('button');
        btnClaim.className = 'nq-button light-blue';
        btnClaim.textContent = 'Claim All';
        if (claimable.length === 0) {
            btnClaim.disabled = true;
        }
        btnClaim.addEventListener('click', () => startClaiming(claimable, feeValue, parsed.length));
        footer.append(btnBack, btnClaim);

        card.append(header, bodyDiv, footer);
        el.appendChild(card);
    }

    // ── Claim: Step 3 — Sign & broadcast ────────────────────────

    async function startClaiming(claimable, feeValue, totalCount) {
        const btnClaim = el.querySelector('.nq-button.light-blue');
        btnClaim.disabled = true;
        btnClaim.setAttribute('aria-busy', 'true');
        btnClaim.textContent = 'Preparing...';

        try {
            const validityStartHeight = await network.getHeadHeight();
            const networkId = await network.getNetworkId();

            const expectedConfig = getNetworkConfig();
            if (networkId !== expectedConfig.id) {
                throw new Error('Network ID mismatch');
            }

            // Build claims array
            const claims = claimable.map(p => ({
                privateKeyBytes: p.privateKeyBytes,
                recipientAddress: address,
                value: p.balance - feeValue,
                fee: feeValue,
                validityStartHeight,
                networkId,
            }));

            btnClaim.textContent = 'Signing...';

            const { serializedTransactions } = await signCashlinkClaims({ claims });

            // Replace footer with stop button
            const footer = el.querySelector('.nq-card-footer');
            footer.innerHTML = '';
            const btnStop = document.createElement('button');
            btnStop.className = 'nq-button red';
            btnStop.textContent = 'Stop';
            btnStop.addEventListener('click', () => { stopRequested = true; });
            footer.appendChild(btnStop);

            // Update table status — find claimable rows by matching
            // Claimable items are scattered in the table; remap to tbody rows
            const rows = el.querySelectorAll('#claim-tbody tr');
            const claimableIndices = [];
            // We need to identify which rows correspond to claimable items
            // Claimable items have the 'Claimable' badge
            rows.forEach((row, idx) => {
                const badge = row.querySelector('.batch-badge');
                if (badge && badge.textContent === 'Claimable') {
                    claimableIndices.push(idx);
                }
            });

            // Parallel broadcast (concurrency 4)
            const CONCURRENCY = 4;
            let sent = 0, failed = 0;
            let totalRecovered = 0;

            for (let i = 0; i < serializedTransactions.length; i += CONCURRENCY) {
                if (stopRequested) break;

                const chunk = [];
                for (let j = i; j < Math.min(i + CONCURRENCY, serializedTransactions.length); j++) {
                    const rowIdx = claimableIndices[j];
                    if (rowIdx !== undefined && rows[rowIdx]) {
                        updateRowStatus(rows[rowIdx], 'sending', 'Sending...');
                    }
                    chunk.push(j);
                }

                const results = await Promise.allSettled(
                    chunk.map(j => network.sendSerializedTransaction(serializedTransactions[j]))
                );

                for (let k = 0; k < results.length; k++) {
                    const j = chunk[k];
                    const rowIdx = claimableIndices[j];
                    if (results[k].status === 'fulfilled') {
                        if (rowIdx !== undefined && rows[rowIdx]) {
                            updateRowStatus(rows[rowIdx], 'sent', 'Claimed');
                        }
                        sent++;
                        totalRecovered += claimable[j].balance - feeValue;
                    } else {
                        if (rowIdx !== undefined && rows[rowIdx]) {
                            updateRowStatus(rows[rowIdx], 'failed', 'Failed');
                        }
                        failed++;
                    }
                }
            }

            showClaimResults(sent, failed, totalRecovered, totalCount);

        } catch (e) {
            btnClaim.disabled = false;
            btnClaim.removeAttribute('aria-busy');
            btnClaim.textContent = 'Claim All';

            if (e.message === 'User cancelled') return;

            console.error('Cashlink claiming failed:', e);
            const errorEl = document.createElement('p');
            errorEl.className = 'nq-text error-text';
            errorEl.setAttribute('role', 'alert');
            const msg = e.message || '';
            if (msg.includes('Network ID mismatch')) {
                errorEl.textContent = 'Network mismatch. Please check your network setting.';
            } else if (msg.includes('Consensus timeout')) {
                errorEl.textContent = 'Could not connect to network. Please try again.';
            } else if (msg.includes('timed out')) {
                errorEl.textContent = 'Keyguard timed out. Please try again.';
            } else {
                errorEl.textContent = 'Claiming failed. Please try again.';
            }
            const body = el.querySelector('.nq-card-body');
            if (body) body.appendChild(errorEl);
        }
    }

    // ── Claim: Step 4 — Results ─────────────────────────────────

    function showClaimResults(sent, failed, totalRecovered, totalCount) {
        el.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'nq-card';

        const header = document.createElement('div');
        header.className = 'nq-card-header';
        const h1 = document.createElement('h1');
        h1.className = 'nq-h1';
        h1.textContent = 'Cashlinks Claimed';
        header.appendChild(h1);

        const summary = document.createElement('p');
        summary.className = 'nq-text';
        const parts = [`${sent} claimed`];
        if (failed > 0) parts.push(`${failed} failed`);
        parts.push(`${formatNim(totalRecovered)} NIM recovered`);
        summary.textContent = parts.join(' \u2014 ');
        header.appendChild(summary);

        const body = document.createElement('div');
        body.className = 'nq-card-body';

        const detail = document.createElement('p');
        detail.className = 'nq-text';
        detail.textContent = `Out of ${totalCount} cashlink${totalCount !== 1 ? 's' : ''} checked, ${sent} ${sent === 1 ? 'was' : 'were'} successfully claimed back to your wallet.`;
        body.appendChild(detail);

        const footer = document.createElement('div');
        footer.className = 'nq-card-footer';
        const btnDone = document.createElement('button');
        btnDone.className = 'nq-button-s';
        btnDone.textContent = 'Back to Dashboard';
        btnDone.addEventListener('click', () => navigate('#dashboard'));
        const btnAgain = document.createElement('button');
        btnAgain.className = 'nq-button-s';
        btnAgain.textContent = 'Claim More';
        btnAgain.addEventListener('click', () => showClaimMode());
        footer.append(btnDone, btnAgain);

        card.append(header, body, footer);
        el.appendChild(card);
    }

    // ── Helpers ──────────────────────────────────────────────────

    function renderCashlinkList(container, urls) {
        urls.forEach((url, i) => {
            const row = document.createElement('div');
            row.className = 'cashlink-row';

            const label = document.createElement('span');
            label.className = 'cashlink-row-label';
            label.textContent = `#${i + 1}`;

            const urlEl = document.createElement('span');
            urlEl.className = 'cashlink-row-url';
            urlEl.textContent = url;

            row.append(label, urlEl);
            container.appendChild(row);
        });
    }

    function exportCsv(urls, addresses, amountNim, filename) {
        const csvHeader = 'URL,Address,Amount (NIM)\n';
        const csvRows = urls.map((url, i) =>
            `${url},${addresses[i] || ''},${amountNim}`
        ).join('\n');
        const blob = new Blob([csvHeader + csvRows], { type: 'text/csv' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(blobUrl);
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

    // ── Init ────────────────────────────────────────────────────

    showCreateMode();

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => { stopRequested = true; cleanupSwipe(); },
    };
}
