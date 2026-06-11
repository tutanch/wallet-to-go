import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { formatNim, formatToken, isStablecoinsEnabled } from '../config.js';
import { enableSwipeBack } from '../modules/gestures.js';

export async function historyView() {
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

    // Stablecoin tabs: only on mainnet with Polygon activated
    let polygonAddress = null;
    if (isStablecoinsEnabled()) {
        try {
            polygonAddress = (await getPolygonAddress())?.address || null;
        } catch (_) {}
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    const tabs = polygonAddress ? `
        <div class="asset-toggle" id="history-tabs">
            <button class="nq-button-s selected" data-asset="nim">NIM</button>
            <button class="nq-button-s" data-asset="usdc">USDC</button>
            <button class="nq-button-s" data-asset="usdt">USDT</button>
        </div>` : '';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Transaction History</h1>
                ${tabs}
            </div>
            <div class="nq-card-body">
                <div class="tx-list" id="tx-list"></div>
                <button class="nq-button-s" id="btn-load-older" style="display:none;">Load older</button>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    const txList = el.querySelector('#tx-list');
    const loadOlderBtn = el.querySelector('#btn-load-older');
    let activeAsset = 'nim';
    let gone = false;

    // ── NIM history (unchanged behavior) ──────────────────────────────────
    async function showNimHistory() {
        loadOlderBtn.style.display = 'none';
        txList.innerHTML = '<p class="nq-text no-txs">Loading…</p>';
        try {
            const txs = await network.getHistory(address, 50);
            if (gone || activeAsset !== 'nim') return;
            txList.innerHTML = '';
            if (txs.length === 0) {
                txList.innerHTML = '<p class="nq-text no-txs">No transactions found</p>';
            } else {
                txs.forEach((tx) => txList.appendChild(renderTxItem(tx, address)));
            }
        } catch (e) {
            if (gone || activeAsset !== 'nim') return;
            txList.innerHTML = '';
            const errorP = document.createElement('p');
            errorP.className = 'nq-text error-text';
            errorP.setAttribute('role', 'alert');
            errorP.textContent = 'Failed to load: ' + e.message;
            txList.appendChild(errorP);
        }
    }

    // ── Token history (cached render → background sync → load older) ─────
    async function showTokenHistory(token) {
        loadOlderBtn.style.display = 'none';
        loadOlderBtn.disabled = false;
        loadOlderBtn.textContent = 'Load older';
        txList.innerHTML = '<p class="nq-text no-txs">Loading…</p>';

        try {
            const history = await import('../modules/polygon/polygon-history.js');

            const render = async () => {
                const txs = await history.getCachedTxs(polygonAddress, token, { limit: 100 });
                if (gone || activeAsset !== token) return;
                await history.resolveTimestamps(txs).catch(() => {});
                txList.innerHTML = '';
                if (txs.length === 0) {
                    txList.innerHTML = '<p class="nq-text no-txs">No transactions in the scanned range</p>';
                } else {
                    txs.forEach((tx) => txList.appendChild(renderTokenTxItem(tx)));
                }
                loadOlderBtn.style.display = '';
            };

            await render(); // cached rows immediately
            await history.syncRecent(polygonAddress, token);
            if (gone || activeAsset !== token) return;
            await render();

            loadOlderBtn.onclick = async () => {
                loadOlderBtn.disabled = true;
                loadOlderBtn.setAttribute('aria-busy', 'true');
                loadOlderBtn.textContent = 'Scanning…';
                try {
                    const { reachedFloor } = await history.loadOlder(polygonAddress, token);
                    if (gone || activeAsset !== token) return;
                    await render();
                    loadOlderBtn.removeAttribute('aria-busy');
                    if (reachedFloor) {
                        loadOlderBtn.disabled = true;
                        loadOlderBtn.textContent = 'Beginning of history';
                    } else {
                        loadOlderBtn.disabled = false;
                        loadOlderBtn.textContent = 'Load older';
                    }
                } catch (e) {
                    if (gone || activeAsset !== token) return;
                    loadOlderBtn.disabled = false;
                    loadOlderBtn.removeAttribute('aria-busy');
                    loadOlderBtn.textContent = 'Load older (failed — retry)';
                }
            };
        } catch (e) {
            if (gone || activeAsset !== token) return;
            txList.innerHTML = '';
            const errorP = document.createElement('p');
            errorP.className = 'nq-text error-text';
            errorP.setAttribute('role', 'alert');
            errorP.textContent = 'Polygon network unavailable. Please try again.';
            txList.appendChild(errorP);
        }
    }

    function switchTab(asset) {
        if (asset === activeAsset) return;
        activeAsset = asset;
        el.querySelectorAll('#history-tabs [data-asset]').forEach((btn) => {
            btn.classList.toggle('selected', btn.dataset.asset === asset);
        });
        if (asset === 'nim') showNimHistory();
        else showTokenHistory(asset);
    }

    if (polygonAddress) {
        el.querySelector('#history-tabs').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-asset]');
            if (btn) switchTab(btn.dataset.asset);
        });
    }

    showNimHistory();

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => {
            gone = true;
            cleanupSwipe();
        },
    };
}

// Build tx items with DOM API (not innerHTML) to prevent XSS from network data
export function renderTxItem(tx, ownAddress) {
    const isSent = tx.sender === ownAddress;
    const counterparty = isSent ? tx.recipient : tx.sender;
    const shortAddr = counterparty
        ? counterparty.substring(0, 9) + '...' + counterparty.substring(counterparty.length - 4)
        : 'Unknown';

    const timestamp = tx.timestamp
        ? new Date(tx.timestamp).toLocaleString()
        : 'Pending';

    const stateStr = tx.state === 'confirmed' ? '' : ` (${tx.state || 'pending'})`;

    const item = document.createElement('div');
    item.className = `tx-item ${isSent ? 'tx-sent' : 'tx-received'}`;

    const dirDiv = document.createElement('div');
    dirDiv.className = 'tx-direction';
    dirDiv.setAttribute('aria-hidden', 'true');
    dirDiv.textContent = isSent ? '↑' : '↓';

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'tx-details';

    const addrSpan = document.createElement('span');
    addrSpan.className = 'tx-address';
    addrSpan.textContent = shortAddr;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tx-time';
    timeSpan.textContent = timestamp + stateStr;

    detailsDiv.appendChild(addrSpan);
    detailsDiv.appendChild(timeSpan);

    const amountDiv = document.createElement('div');
    amountDiv.className = `tx-amount ${isSent ? 'amount-sent' : 'amount-received'}`;
    amountDiv.textContent = `${isSent ? '-' : '+'}${formatNim(tx.value)} NIM`;

    item.appendChild(dirDiv);
    item.appendChild(detailsDiv);
    item.appendChild(amountDiv);

    return item;
}

// USDC/USDT history row (DOM API only — record values come from chain logs)
export function renderTokenTxItem(tx) {
    const symbol = tx.token.toUpperCase();
    const counterparty = tx.incoming ? tx.sender : tx.recipient;
    const shortAddr = counterparty
        ? counterparty.substring(0, 8) + '...' + counterparty.substring(counterparty.length - 6)
        : 'Unknown';

    const item = document.createElement('div');
    item.className = `tx-item ${tx.incoming ? 'tx-received' : 'tx-sent'}${tx.failed ? ' tx-failed' : ''}`;

    const dirDiv = document.createElement('div');
    dirDiv.className = 'tx-direction';
    dirDiv.setAttribute('aria-hidden', 'true');
    dirDiv.textContent = tx.failed ? '✕' : tx.incoming ? '↓' : '↑';

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'tx-details';

    const addrSpan = document.createElement('span');
    addrSpan.className = 'tx-address';
    addrSpan.textContent = tx.failed ? 'Failed transfer' : shortAddr;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tx-time';
    const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'Pending';
    const feeStr = tx.fee != null && !tx.incoming && !tx.failed
        ? ` · fee ${formatToken(tx.fee)}`
        : '';
    timeSpan.textContent = timeStr + feeStr;

    detailsDiv.appendChild(addrSpan);
    detailsDiv.appendChild(timeSpan);

    const amountDiv = document.createElement('div');
    amountDiv.className = `tx-amount ${tx.incoming ? 'amount-received' : 'amount-sent'}`;
    amountDiv.textContent = tx.failed
        ? `-${formatToken(tx.fee || 0)} ${symbol}`
        : `${tx.incoming ? '+' : '-'}${formatToken(tx.value)} ${symbol}`;

    item.appendChild(dirDiv);
    item.appendChild(detailsDiv);
    item.appendChild(amountDiv);

    return item;
}
