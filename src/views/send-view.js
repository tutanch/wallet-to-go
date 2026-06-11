import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, signTransaction, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, getNetworkConfig, isStablecoinsEnabled, tokenToUnits, formatToken, POLYGON } from '../config.js';
import { loadNimiq } from '../nimiq.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';

export async function sendView() {
    const defaultAddress = await getStoredAddress();
    if (!defaultAddress) {
        navigate('#welcome');
        return document.createElement('div');
    }

    // Use the active derived address
    const activeIdx = getActiveAddressIndex();
    let address = defaultAddress;
    try {
        const result = await getDerivedAddresses();
        if (result?.addresses?.[activeIdx]) {
            address = result.addresses[activeIdx].address;
        }
    } catch (_) {}

    // Stablecoins: only on mainnet and only once Polygon is activated
    let polygonAddress = null;
    if (isStablecoinsEnabled()) {
        try {
            polygonAddress = (await getPolygonAddress())?.address || null;
        } catch (_) {}
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    const assetPills = polygonAddress ? `
        <div class="asset-toggle" id="asset-toggle">
            <button class="nq-button-s selected" data-asset="nim">NIM</button>
            <button class="nq-button-s" data-asset="usdc">USDC</button>
            <button class="nq-button-s" data-asset="usdt">USDT</button>
        </div>` : '';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1" id="send-title">Send NIM</h1>
                ${assetPills}
            </div>
            <div id="asset-panel" style="display: contents;"></div>
        </div>
    `;

    const panel = el.querySelector('#asset-panel');
    let activeAsset = 'nim';
    let panelCleanup = null;

    function switchAsset(asset) {
        if (asset === activeAsset && panel.childElementCount) return;
        activeAsset = asset;
        if (panelCleanup) { panelCleanup(); panelCleanup = null; }
        el.querySelectorAll('#asset-toggle [data-asset]').forEach((btn) => {
            btn.classList.toggle('selected', btn.dataset.asset === asset);
        });
        el.querySelector('#send-title').textContent = asset === 'nim'
            ? 'Send NIM'
            : `Send ${asset.toUpperCase()}`;
        if (asset === 'nim') {
            renderNimPanel();
        } else {
            renderTokenPanel(asset);
        }
    }

    if (polygonAddress) {
        el.querySelector('#asset-toggle').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-asset]');
            if (btn) switchAsset(btn.dataset.asset);
        });
    }

    // ── NIM panel (unchanged behavior) ────────────────────────────────────

    function renderNimPanel() {
        panel.innerHTML = `
            <div class="nq-card-body">
                <div class="form-group">
                    <label class="nq-label" for="recipient">Recipient Address</label>
                    <input type="text" class="nq-input" id="recipient" placeholder="NQ...">
                </div>
                <div class="form-group">
                    <label class="nq-label" for="amount">Amount (NIM)</label>
                    <input type="number" class="nq-input" id="amount" placeholder="0.00" step="0.00001" min="0">
                </div>
                <div class="form-group">
                    <label class="nq-label" for="message">Message (optional, max 64 bytes)</label>
                    <input type="text" class="nq-input" id="message" placeholder="Optional message">
                </div>
                <div class="form-group">
                    <label class="nq-label" for="fee">Fee (luna)</label>
                    <input type="number" class="nq-input" id="fee" placeholder="0" value="0" min="0" step="1">
                </div>
                <p class="nq-text error-text" id="warning" role="alert" style="display: none;"></p>
                <p class="nq-text error-text" id="error" role="alert" style="display: none;"></p>
                <div class="success-message" id="success" role="status" style="display: none;">
                    <p class="nq-text success-text">Transaction sent successfully!</p>
                    <p class="nq-text tx-hash" id="tx-hash"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-send">Send</button>
            </div>
        `;

        let sending = false; // Prevent double-send
        let selfSendConfirmed = false; // Track if user confirmed self-send

        panel.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));
        panel.querySelector('#recipient').addEventListener('input', () => { selfSendConfirmed = false; });

        panel.querySelector('#btn-send').addEventListener('click', async () => {
            if (sending) return;

            const errorEl = panel.querySelector('#error');
            const warningEl = panel.querySelector('#warning');
            const successEl = panel.querySelector('#success');
            errorEl.style.display = 'none';
            warningEl.style.display = 'none';
            successEl.style.display = 'none';

            // Validate inputs
            const recipientValue = panel.querySelector('#recipient').value.trim();
            const amountRaw = panel.querySelector('#amount').value.trim();
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
                if (!selfSendConfirmed) {
                    warningEl.textContent = 'You are sending to your own address. Click Send again to confirm.';
                    warningEl.style.display = '';
                    selfSendConfirmed = true;
                    return;
                }
            }

            if (isNaN(valueLuna) || valueLuna <= 0) {
                errorEl.textContent = 'Please enter a valid amount.';
                errorEl.style.display = '';
                return;
            }

            const msgBytes = new TextEncoder().encode(panel.querySelector('#message').value);
            if (msgBytes.length > 64) {
                errorEl.textContent = 'Message exceeds 64 bytes.';
                errorEl.style.display = '';
                return;
            }

            const btn = panel.querySelector('#btn-send');
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = 'Opening keyguard...';
            sending = true;

            try {
                const feeValue = Math.max(0, parseInt(panel.querySelector('#fee').value) || 0);
                const messageValue = panel.querySelector('#message').value;
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
                    addressIndex: activeIdx,
                });

                btn.textContent = 'Sending...';

                const result = await network.sendSerializedTransaction(serializedTx);

                successEl.style.display = '';
                panel.querySelector('#tx-hash').textContent = `TX: ${result.transactionHash.substring(0, 16)}...`;
                btn.removeAttribute('aria-busy');
                btn.textContent = 'Done';
                showToast('Transaction sent!', 'success');

                setTimeout(() => navigate('#dashboard'), 3000);
            } catch (e) {
                sending = false;
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
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
    }

    // ── USDC/USDT panel ───────────────────────────────────────────────────

    function renderTokenPanel(token) {
        const symbol = POLYGON[token].symbol;
        panel.innerHTML = `
            <div class="nq-card-body">
                <div class="form-group">
                    <label class="nq-label" for="recipient">Recipient Address (Polygon)</label>
                    <input type="text" class="nq-input" id="recipient" placeholder="0x..." autocomplete="off" spellcheck="false">
                </div>
                <div class="form-group">
                    <label class="nq-label" for="amount">Amount (${symbol})</label>
                    <div class="amount-with-max">
                        <input type="number" class="nq-input" id="amount" placeholder="0.00" step="0.000001" min="0">
                        <button class="nq-button-s" id="btn-max" type="button">Max</button>
                    </div>
                    <p class="nq-text nq-text-s" id="token-balance" aria-live="polite">Balance: …</p>
                </div>
                <div class="form-group">
                    <span class="nq-label">Network Fee (paid in ${symbol})</span>
                    <p class="nq-text" id="fee-display" aria-live="polite">Estimating…</p>
                </div>
                <p class="nq-text error-text" id="warning" role="alert" style="display: none;"></p>
                <p class="nq-text error-text" id="error" role="alert" style="display: none;"></p>
                <div class="success-message" id="success" role="status" style="display: none;">
                    <p class="nq-text success-text">Transaction sent successfully!</p>
                    <p class="nq-text tx-hash" id="tx-hash"></p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-send">Send</button>
            </div>
        `;

        let sending = false;
        let cancelled = false;
        let feeEstimate = null; // { feeUnits, relay }
        let balanceUnits = null;
        panelCleanup = () => { cancelled = true; };

        panel.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

        // Fee estimate + balance (lazy imports keep the NIM-only path light)
        (async () => {
            const feeEl = panel.querySelector('#fee-display');
            const balanceEl = panel.querySelector('#token-balance');
            try {
                const [{ estimateFee }, { getStablecoinBalances }] = await Promise.all([
                    import('../modules/polygon/polygon-send.js'),
                    import('../modules/polygon/polygon-client.js'),
                ]);
                const [estimate, balances] = await Promise.all([
                    estimateFee(token),
                    getStablecoinBalances(polygonAddress),
                ]);
                if (cancelled) return;
                feeEstimate = estimate;
                balanceUnits = balances[token];
                feeEl.textContent = `~${formatToken(estimate.feeUnits)} ${symbol}`;
                balanceEl.textContent = `Balance: ${formatToken(balanceUnits)} ${symbol}`;
            } catch (e) {
                if (cancelled) return;
                console.warn('Fee estimate failed:', e);
                feeEl.textContent = 'Computed when you send';
                balanceEl.textContent = '';
            }
        })();

        panel.querySelector('#btn-max').addEventListener('click', () => {
            if (balanceUnits == null) return;
            const fee = feeEstimate ? feeEstimate.feeUnits : 0;
            const maxUnits = Math.max(0, balanceUnits - fee);
            panel.querySelector('#amount').value = (maxUnits / 1e6).toFixed(6).replace(/\.?0+$/, '');
        });

        panel.querySelector('#btn-send').addEventListener('click', async () => {
            if (sending) return;

            const errorEl = panel.querySelector('#error');
            const successEl = panel.querySelector('#success');
            errorEl.style.display = 'none';
            successEl.style.display = 'none';

            const recipientRaw = panel.querySelector('#recipient').value.trim();
            const amountRaw = panel.querySelector('#amount').value.trim();
            const amountUnits = tokenToUnits(amountRaw);

            if (!recipientRaw) {
                errorEl.textContent = 'Please enter a recipient address.';
                errorEl.style.display = '';
                return;
            }

            // Checksum-validate the 0x address (rejects bad mixed-case)
            let recipient;
            try {
                const { getEthers } = await import('../modules/polygon/polygon-client.js');
                const ethers = await getEthers();
                recipient = ethers.utils.getAddress(recipientRaw);
            } catch (_) {
                errorEl.textContent = 'Invalid Polygon address.';
                errorEl.style.display = '';
                return;
            }

            if (isNaN(amountUnits) || amountUnits <= 0) {
                errorEl.textContent = 'Please enter a valid amount.';
                errorEl.style.display = '';
                return;
            }

            const btn = panel.querySelector('#btn-send');
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            sending = true;

            try {
                const { sendStablecoin } = await import('../modules/polygon/polygon-send.js');
                const result = await sendStablecoin({
                    token,
                    from: polygonAddress,
                    recipient,
                    amountUnits,
                    relay: feeEstimate?.relay,
                    onStatus: (label) => { btn.textContent = label; },
                });

                successEl.style.display = '';
                panel.querySelector('#tx-hash').textContent = `TX: ${result.txHash.substring(0, 18)}...`;
                btn.removeAttribute('aria-busy');
                btn.textContent = 'Done';
                showToast('Transaction sent!', 'success');

                // Record in the local history cache (non-fatal)
                try {
                    const { addPendingTx } = await import('../modules/polygon/polygon-history.js');
                    await addPendingTx({
                        address: polygonAddress,
                        token,
                        txHash: result.txHash,
                        logIndex: -1,
                        blockNumber: result.receipt.blockNumber,
                        timestamp: Date.now(),
                        sender: polygonAddress,
                        recipient,
                        value: result.amountUnits,
                        fee: result.feeUnits,
                        incoming: false,
                        failed: false,
                    });
                } catch (_) {}

                setTimeout(() => navigate('#dashboard'), 3000);
            } catch (e) {
                sending = false;
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.textContent = 'Send';

                if (e.message === 'User cancelled') return;

                console.error('Token transaction failed:', e);
                const msg = e.message || '';
                if (msg.includes('Insufficient balance')) {
                    errorEl.textContent = `Insufficient ${symbol} balance to cover amount and fee.`;
                } else if (msg.includes('No GSN relay') || msg.includes('No registered GSN relay') || msg.includes('Relay')) {
                    errorEl.textContent = 'The gas-abstraction relay is unreachable. Please try again later.';
                } else {
                    errorEl.textContent = 'Transaction failed. Please try again.';
                }
                errorEl.style.display = '';
            }
        });
    }

    switchAsset('nim');

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => {
            if (panelCleanup) panelCleanup();
            cleanupSwipe();
        },
    };
}
