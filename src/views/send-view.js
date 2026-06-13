import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, signTransaction, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { nimToLuna, formatNim, getNetworkConfig, isStablecoinsEnabled, tokenToUnits, formatToken, POLYGON } from '../config.js';
import { loadNimiq } from '../nimiq.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { skeletonText, settleText, setReveal } from '../modules/ui.js';

// Status helpers shared by both panels. Each slot is a .reveal, so showing or
// clearing a message animates its height instead of reflowing the form. The
// "msg" slot is one mutually-exclusive area for validation/error/success.
function showMsg(slot, kind, text, detail) {
    const inner = slot.firstElementChild;
    inner.className = 'status-msg status-' + kind;
    inner.textContent = '';
    const p = document.createElement('p');
    p.textContent = text;
    inner.appendChild(p);
    if (detail) {
        const d = document.createElement('p');
        d.className = 'tx-hash';
        d.textContent = detail;
        inner.appendChild(d);
    }
    setReveal(slot, true);
}

function clearMsg(slot) {
    setReveal(slot, false);
}

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
                    <div class="amount-with-max">
                        <input type="number" class="nq-input" id="amount" placeholder="0.00" step="0.00001" min="0">
                        <button class="nq-button-s" id="btn-max" type="button">Max</button>
                    </div>
                    <p class="field-hint"><span>Balance: <span id="nim-balance" aria-live="polite"></span></span></p>
                </div>
                <div class="form-group">
                    <label class="nq-label" for="message">Message (optional, max 64 bytes)</label>
                    <input type="text" class="nq-input" id="message" placeholder="Optional message">
                </div>
                <details class="advanced">
                    <summary>Advanced</summary>
                    <div class="advanced-body">
                        <div class="form-group">
                            <label class="nq-label" for="fee">Fee (luna)</label>
                            <input type="number" class="nq-input" id="fee" placeholder="0" value="0" min="0" step="1">
                        </div>
                    </div>
                </details>
                <div class="reveal" id="net-slot"><p class="status-net" id="net-status" role="status" aria-live="polite"></p></div>
                <div class="reveal" id="msg-slot"><div class="status-msg" id="msg-inner" role="status" aria-live="polite"></div></div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
                <button class="nq-button light-blue" id="btn-send">Send</button>
            </div>
        `;

        let sending = false; // Prevent double-send
        let selfSendConfirmed = false; // Track if user confirmed self-send
        let nimGone = false;
        let balanceLuna = null;

        const netSlot = panel.querySelector('#net-slot');
        const msgSlot = panel.querySelector('#msg-slot');

        panel.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));
        panel.querySelector('#recipient').addEventListener('input', () => { selfSendConfirmed = false; });

        // Balance + Max (parity with the token panel)
        const balanceEl = panel.querySelector('#nim-balance');
        skeletonText(balanceEl, 7);
        (async () => {
            try {
                const balance = await network.getBalance(address);
                if (nimGone) return;
                balanceLuna = balance;
                settleText(balanceEl, `${formatNim(balance)} NIM`);
            } catch (_) {
                if (!nimGone) settleText(balanceEl, 'unavailable');
            }
        })();

        panel.querySelector('#btn-max').addEventListener('click', () => {
            if (balanceLuna == null) return;
            const feeValue = Math.max(0, parseInt(panel.querySelector('#fee').value) || 0);
            const maxLuna = Math.max(0, balanceLuna - feeValue);
            panel.querySelector('#amount').value = (maxLuna / 100000).toFixed(5).replace(/\.?0+$/, '');
        });

        // Surface network state where the action happens — sending waits on
        // consensus, so say so instead of failing with a timeout later.
        let netTimer = null;
        let lastNetOk = null;
        async function checkNet() {
            try {
                const ok = await network.isConsensusEstablished();
                if (nimGone || ok === lastNetOk) return; // only act on a state change
                lastNetOk = ok;
                if (ok) {
                    setReveal(netSlot, false);
                    if (netTimer) { clearInterval(netTimer); netTimer = null; }
                } else {
                    setReveal(netSlot, true, 'Connecting to the network — sending waits for sync.');
                }
            } catch (_) {}
        }
        checkNet();
        netTimer = setInterval(checkNet, 2000);
        panelCleanup = () => {
            nimGone = true;
            if (netTimer) { clearInterval(netTimer); netTimer = null; }
        };

        panel.querySelector('#btn-send').addEventListener('click', async () => {
            if (sending) return;

            clearMsg(msgSlot);

            // Validate inputs
            const recipientValue = panel.querySelector('#recipient').value.trim();
            const amountRaw = panel.querySelector('#amount').value.trim();
            const valueLuna = nimToLuna(amountRaw);

            if (!recipientValue) {
                showMsg(msgSlot, 'error', 'Please enter a recipient address.');
                return;
            }

            try {
                const Nimiq = await loadNimiq();
                Nimiq.Address.fromString(recipientValue);
            } catch {
                showMsg(msgSlot, 'error', 'Invalid Nimiq address.');
                return;
            }

            if (recipientValue.replace(/\s/g, '') === address.replace(/\s/g, '')) {
                if (!selfSendConfirmed) {
                    showMsg(msgSlot, 'warning', 'You are sending to your own address. Click Send again to confirm.');
                    selfSendConfirmed = true;
                    return;
                }
            }

            if (isNaN(valueLuna) || valueLuna <= 0) {
                showMsg(msgSlot, 'error', 'Please enter a valid amount.');
                return;
            }

            const msgBytes = new TextEncoder().encode(panel.querySelector('#message').value);
            if (msgBytes.length > 64) {
                showMsg(msgSlot, 'error', 'Message exceeds 64 bytes.');
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

                showMsg(msgSlot, 'success', 'Transaction sent successfully!', `TX: ${result.transactionHash.substring(0, 16)}...`);
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
                let errText;
                if (msg.includes('Network ID mismatch')) {
                    errText = 'Network mismatch. Please check your network setting.';
                } else if (msg.includes('Consensus timeout')) {
                    errText = 'Could not connect to network. Please try again.';
                } else {
                    errText = 'Transaction failed. Please try again.';
                }
                showMsg(msgSlot, 'error', errText);
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
                    <p class="nq-text nq-text-s">Balance: <span id="token-balance" aria-live="polite"></span></p>
                </div>
                <div class="form-group">
                    <span class="nq-label">Network Fee (paid in ${symbol})</span>
                    <p class="nq-text"><span id="fee-display" aria-live="polite"></span></p>
                </div>
                <div class="reveal" id="msg-slot"><div class="status-msg" id="msg-inner" role="status" aria-live="polite"></div></div>
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

        const msgSlot = panel.querySelector('#msg-slot');

        panel.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

        // Fee estimate + balance (lazy imports keep the NIM-only path light)
        (async () => {
            const feeEl = panel.querySelector('#fee-display');
            const balanceEl = panel.querySelector('#token-balance');
            skeletonText(feeEl, 9);
            skeletonText(balanceEl, 9);
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
                settleText(feeEl, `~${formatToken(estimate.feeUnits)} ${symbol}`);
                settleText(balanceEl, `${formatToken(balanceUnits)} ${symbol}`);
            } catch (e) {
                if (cancelled) return;
                console.warn('Fee estimate failed:', e);
                settleText(feeEl, 'Computed when you send');
                settleText(balanceEl, 'unavailable');
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

            clearMsg(msgSlot);

            const recipientRaw = panel.querySelector('#recipient').value.trim();
            const amountRaw = panel.querySelector('#amount').value.trim();
            const amountUnits = tokenToUnits(amountRaw);

            if (!recipientRaw) {
                showMsg(msgSlot, 'error', 'Please enter a recipient address.');
                return;
            }

            // Checksum-validate the 0x address (rejects bad mixed-case)
            let recipient;
            try {
                const { getEthers } = await import('../modules/polygon/polygon-client.js');
                const ethers = await getEthers();
                recipient = ethers.utils.getAddress(recipientRaw);
            } catch (_) {
                showMsg(msgSlot, 'error', 'Invalid Polygon address.');
                return;
            }

            if (isNaN(amountUnits) || amountUnits <= 0) {
                showMsg(msgSlot, 'error', 'Please enter a valid amount.');
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

                showMsg(msgSlot, 'success', 'Transaction sent successfully!', `TX: ${result.txHash.substring(0, 18)}...`);
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
                let errText;
                if (msg.includes('Insufficient balance')) {
                    errText = `Insufficient ${symbol} balance to cover amount and fee.`;
                } else if (msg.includes('No GSN relay') || msg.includes('No registered GSN relay') || msg.includes('Relay')) {
                    errText = 'The gas-abstraction relay is unreachable. Please try again later.';
                } else {
                    errText = 'Transaction failed. Please try again.';
                }
                showMsg(msgSlot, 'error', errText);
            }
        });
    }

    // Asset views preselect their asset (sessionStorage handshake)
    let initialAsset = 'nim';
    const preselect = sessionStorage.getItem('preselect-asset');
    sessionStorage.removeItem('preselect-asset');
    if (preselect && preselect !== 'nim' && polygonAddress && POLYGON[preselect]) {
        initialAsset = preselect;
    }
    switchAsset(initialAsset);

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => {
            if (panelCleanup) panelCleanup();
            cleanupSwipe();
        },
    };
}
