import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex, getCachedNimTxs } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { formatNim, formatToken, isStablecoinsEnabled, ASSETS, getExplorerTxUrl } from '../config.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { reserveList } from '../modules/ui.js';

// Scan-window sizes mirrored from polygon-history.js (for honest scan info)
const INITIAL_SCAN_DAYS = 1;
const LOAD_OLDER_DAYS = 4.6;
// One automatic extra window when the recent range is empty; deeper history is
// manual via "Load older". Auto-deepening many windows (each a ~200k-block,
// multi-chunk getLogs scan) is what previously flooded the public RPCs.
const AUTO_DEEPEN_PAGES = 1;

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
                <h1 class="nq-h1">Activity</h1>
                ${tabs}
            </div>
            <div class="nq-card-body">
                <div class="tx-list" id="tx-list"></div>
                <p class="nq-text-s" id="scan-info" aria-live="polite" style="display:none; text-align:center; margin: 12px 0;"></p>
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
    const scanInfo = el.querySelector('#scan-info');
    let activeAsset = 'nim';
    let gone = false;

    // Reserve list height so skeleton → rows → empty-state don't change height.
    reserveList(txList, 4);

    // ── NIM history ────────────────────────────────────────────────────────
    async function showNimHistory() {
        loadOlderBtn.style.display = 'none';
        scanInfo.style.display = 'none';
        txList.innerHTML = '';

        // Instant: reuse what the dashboard already loaded for this address, so
        // the list isn't blank while the (slow) full history proof is fetched.
        const cached = getCachedNimTxs(address);
        let renderedSig = null;
        if (cached.length) {
            cached.forEach((tx) => txList.appendChild(renderTxItem(tx, address)));
            renderedSig = nimHistorySig(cached);
        } else {
            txList.appendChild(renderSkeletonRows(4));
        }

        try {
            const txs = await network.getHistory(address, 50);
            if (gone || activeAsset !== 'nim') return;
            // If the full proof matches the cached rows already on screen, leave
            // them in place so a row the user expanded mid-fetch stays open.
            if (cached.length && nimHistorySig(txs) === renderedSig) return;
            txList.innerHTML = '';
            if (txs.length === 0) {
                txList.innerHTML = '<p class="nq-text no-txs">No transactions yet</p>';
            } else {
                txs.forEach((tx) => txList.appendChild(renderTxItem(tx, address)));
            }
        } catch (e) {
            if (gone || activeAsset !== 'nim') return;
            // Keep the cached rows if we have them — the overview data is still
            // valid; only replace with an error when there's nothing to show.
            if (cached.length) return;
            txList.innerHTML = '';
            const errorP = document.createElement('p');
            errorP.className = 'nq-text error-text';
            errorP.setAttribute('role', 'alert');
            errorP.textContent = 'Failed to load: ' + e.message;
            txList.appendChild(errorP);
        }
    }

    // ── Token history (shared engine, also used by the asset view) ────────
    function showTokenHistory(token) {
        return mountTokenHistory({
            list: txList,
            loadOlderBtn,
            scanInfo,
            polygonAddress,
            token,
            isActive: () => !gone && activeAsset === token,
        });
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

/**
 * Token-history engine: cached render → recent sync → auto-deepen when empty.
 * Shared by the Activity view and the per-asset view. The caller provides the
 * DOM targets and an `isActive()` guard against stale renders after
 * navigation or tab switches.
 */
export async function mountTokenHistory({ list, loadOlderBtn, scanInfo, polygonAddress, token, isActive }) {
    // Reserve the footer controls up front (visible but inert) so they don't
    // pop in after the first render — only their text/disabled state changes.
    reserveList(list, 4);
    loadOlderBtn.style.display = '';
    loadOlderBtn.disabled = true;
    loadOlderBtn.setAttribute('aria-busy', 'true');
    loadOlderBtn.textContent = 'Loading…';
    loadOlderBtn.classList.add('btn-stable-wide');
    scanInfo.style.display = '';
    scanInfo.textContent = '';
    list.innerHTML = '';
    list.appendChild(renderSkeletonRows(4));

    let daysScanned = INITIAL_SCAN_DAYS;

    try {
        const history = await import('../modules/polygon/polygon-history.js');

        const render = async () => {
            const txs = await history.getCachedTxs(polygonAddress, token, { limit: 100 });
            if (!isActive()) return 0;
            await history.resolveTimestamps(txs).catch(() => {});
            list.innerHTML = '';
            if (txs.length === 0) {
                list.innerHTML = '<p class="nq-text no-txs">No transfers in the scanned range</p>';
            } else {
                txs.forEach((tx) => list.appendChild(renderTokenTxItem(tx)));
            }
            return txs.length;
        };

        const updateScanInfo = (count, reachedFloor) => {
            if (!isActive()) return;
            if (reachedFloor) {
                scanInfo.textContent = count === 0
                    ? 'Scanned the full history of this wallet — no transfers found.'
                    : 'Scanned the full history of this wallet.';
            } else {
                scanInfo.textContent = `Scanned roughly the last ${Math.round(daysScanned)} days of Polygon history.`;
            }
        };

        await render(); // cached rows immediately
        await history.syncRecent(polygonAddress, token);
        if (!isActive()) return;
        let count = await render();

        // Auto-deepen: an empty list with more history below the scan window
        // reads as "no history available" — keep scanning instead of
        // dead-ending on the user. The button stays busy (set above) until here.
        let reachedFloor = false;
        if (count === 0) {
            for (let page = 0; page < AUTO_DEEPEN_PAGES && count === 0 && !reachedFloor; page++) {
                loadOlderBtn.textContent = 'Scanning older history…';
                try {
                    const res = await history.loadOlder(polygonAddress, token);
                    reachedFloor = res.reachedFloor;
                    daysScanned += LOAD_OLDER_DAYS;
                } catch (_) {
                    break; // RPC hiccup — leave manual "Load older" available
                }
                if (!isActive()) return;
                count = await render();
            }
        }
        // Settle the button into its interactive resting state (both branches).
        loadOlderBtn.disabled = reachedFloor;
        loadOlderBtn.removeAttribute('aria-busy');
        loadOlderBtn.textContent = reachedFloor ? 'Beginning of history' : 'Load older';
        updateScanInfo(count, reachedFloor);

        loadOlderBtn.onclick = async () => {
            loadOlderBtn.disabled = true;
            loadOlderBtn.setAttribute('aria-busy', 'true');
            loadOlderBtn.textContent = 'Scanning…';
            try {
                const res = await history.loadOlder(polygonAddress, token);
                daysScanned += LOAD_OLDER_DAYS;
                if (!isActive()) return;
                const n = await render();
                updateScanInfo(n, res.reachedFloor);
                loadOlderBtn.removeAttribute('aria-busy');
                if (res.reachedFloor) {
                    loadOlderBtn.disabled = true;
                    loadOlderBtn.textContent = 'Beginning of history';
                } else {
                    loadOlderBtn.disabled = false;
                    loadOlderBtn.textContent = 'Load older';
                }
            } catch (e) {
                if (!isActive()) return;
                loadOlderBtn.disabled = false;
                loadOlderBtn.removeAttribute('aria-busy');
                loadOlderBtn.textContent = 'Load older (failed — retry)';
            }
        };
    } catch (e) {
        if (!isActive()) return;
        list.innerHTML = '';
        const errorP = document.createElement('p');
        errorP.className = 'nq-text error-text';
        errorP.setAttribute('role', 'alert');
        errorP.textContent = 'Polygon network unavailable. Please try again.';
        list.appendChild(errorP);
    }
}

// ── Shared renderers (DOM API only — never innerHTML for network data) ─────

/** Skeleton placeholder rows shown while a list loads. */
export function renderSkeletonRows(count = 3) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const row = document.createElement('div');
        row.className = 'skeleton-row';
        row.setAttribute('aria-hidden', 'true');
        const circle = document.createElement('div');
        circle.className = 'skeleton skeleton-circle';
        const line = document.createElement('div');
        line.className = 'skeleton skeleton-line';
        const short = document.createElement('div');
        short.className = 'skeleton skeleton-line skeleton-line-short';
        row.append(circle, line, short);
        frag.appendChild(row);
    }
    return frag;
}

// Stable signature of a NIM tx list — lets showNimHistory skip a rebuild when
// the fetched proof matches the cached rows already rendered.
function nimHistorySig(txs) {
    return txs.map(t => `${t.transactionHash || ''}:${t.state || ''}:${t.blockHeight || ''}`).join('|');
}

function shortAddress(addr, head, tail) {
    if (!addr) return 'Unknown';
    return addr.substring(0, head) + '…' + addr.substring(addr.length - tail);
}

function makeDetailRow(label, value, mono = true) {
    const row = document.createElement('div');
    row.className = 'tx-detail-row';
    const l = document.createElement('span');
    l.className = 'tx-detail-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'tx-detail-value';
    if (!mono) v.style.fontFamily = 'inherit';
    v.textContent = value;
    row.append(l, v);
    return row;
}

/**
 * Wire a tx row to an expandable detail strip (built lazily on first open).
 * `buildDetail` returns an HTMLElement with the full record.
 */
function makeExpandableEntry(row, buildDetail) {
    const entry = document.createElement('div');
    entry.className = 'tx-entry';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', 'false');
    let detail = null;

    function toggle() {
        if (!detail) {
            detail = buildDetail();
            entry.appendChild(detail);
        } else {
            detail.style.display = detail.style.display === 'none' ? '' : 'none';
        }
        const open = detail.style.display !== 'none';
        row.setAttribute('aria-expanded', String(open));
    }

    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    });

    entry.appendChild(row);
    return entry;
}

function makeDetailActions(asset, txHash) {
    const actions = document.createElement('div');
    actions.className = 'tx-detail-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'nq-button-s';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy hash';
    copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(txHash);
            showToast('Hash copied!', 'success');
        } catch (_) {}
    });

    const link = document.createElement('a');
    link.className = 'nq-button-s';
    link.href = getExplorerTxUrl(asset, txHash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View on explorer ↗';
    link.addEventListener('click', (e) => e.stopPropagation());

    actions.append(copyBtn, link);
    return actions;
}

/** NIM transaction row with expandable details and explorer link. */
export function renderTxItem(tx, ownAddress) {
    const isSent = tx.sender === ownAddress;
    const counterparty = isSent ? tx.recipient : tx.sender;
    const timestamp = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'Pending';
    const stateStr = tx.state === 'confirmed' ? '' : ` (${tx.state || 'pending'})`;

    const item = document.createElement('div');
    item.className = `tx-item ${isSent ? 'tx-sent' : 'tx-received'}`;

    const dirDiv = document.createElement('div');
    dirDiv.className = 'tx-direction';
    dirDiv.setAttribute('aria-hidden', 'true');
    dirDiv.style.background = ASSETS.nim.color;
    dirDiv.textContent = isSent ? '↑' : '↓';

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'tx-details';

    const addrSpan = document.createElement('span');
    addrSpan.className = 'tx-address';
    addrSpan.textContent = (isSent ? 'To ' : 'From ') + shortAddress(counterparty, 9, 4);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tx-time';
    timeSpan.textContent = timestamp + stateStr;

    detailsDiv.append(addrSpan, timeSpan);

    const amountDiv = document.createElement('div');
    amountDiv.className = `tx-amount ${isSent ? 'amount-sent' : 'amount-received'}`;
    amountDiv.textContent = `${isSent ? '−' : '+'}${formatNim(tx.value)}`;
    const symbolSpan = document.createElement('span');
    symbolSpan.className = 'tx-amount-symbol';
    symbolSpan.textContent = 'NIM';
    amountDiv.appendChild(symbolSpan);

    item.append(dirDiv, detailsDiv, amountDiv);

    return makeExpandableEntry(item, () => {
        const detail = document.createElement('div');
        detail.className = 'tx-detail';
        detail.appendChild(makeDetailRow(isSent ? 'To' : 'From', counterparty || 'Unknown'));
        detail.appendChild(makeDetailRow('Amount', `${formatNim(tx.value)} NIM`, false));
        if (tx.fee) detail.appendChild(makeDetailRow('Fee', `${formatNim(tx.fee)} NIM`, false));
        if (tx.transactionHash) detail.appendChild(makeDetailRow('Hash', tx.transactionHash));
        detail.appendChild(makeDetailRow('Status', (tx.state || 'pending') + (tx.blockHeight ? ` · block ${tx.blockHeight.toLocaleString()}` : ''), false));
        if (tx.transactionHash) detail.appendChild(makeDetailActions('nim', tx.transactionHash));
        return detail;
    });
}

/** USDC/USDT transfer row with expandable details and explorer link. */
export function renderTokenTxItem(tx) {
    const assetMeta = ASSETS[tx.token] || ASSETS.usdc;
    const symbol = assetMeta.symbol;
    const counterparty = tx.incoming ? tx.sender : tx.recipient;

    const item = document.createElement('div');
    item.className = `tx-item ${tx.incoming ? 'tx-received' : 'tx-sent'}${tx.failed ? ' tx-failed' : ''}`;

    const dirDiv = document.createElement('div');
    dirDiv.className = 'tx-direction';
    dirDiv.setAttribute('aria-hidden', 'true');
    if (!tx.failed) dirDiv.style.background = assetMeta.color;
    dirDiv.textContent = tx.failed ? '✕' : tx.incoming ? '↓' : '↑';

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'tx-details';

    const addrSpan = document.createElement('span');
    addrSpan.className = 'tx-address';
    addrSpan.textContent = tx.failed
        ? 'Failed transfer'
        : (tx.incoming ? 'From ' : 'To ') + shortAddress(counterparty, 8, 6);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'tx-time';
    const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'Pending';
    const feeStr = tx.fee != null && !tx.incoming && !tx.failed
        ? ` · fee ${formatToken(tx.fee)}`
        : '';
    timeSpan.textContent = timeStr + feeStr;

    detailsDiv.append(addrSpan, timeSpan);

    const amountDiv = document.createElement('div');
    amountDiv.className = `tx-amount ${tx.incoming ? 'amount-received' : 'amount-sent'}`;
    amountDiv.textContent = tx.failed
        ? `−${formatToken(tx.fee || 0)}`
        : `${tx.incoming ? '+' : '−'}${formatToken(tx.value)}`;
    const symbolSpan = document.createElement('span');
    symbolSpan.className = 'tx-amount-symbol';
    symbolSpan.textContent = symbol;
    amountDiv.appendChild(symbolSpan);

    item.append(dirDiv, detailsDiv, amountDiv);

    return makeExpandableEntry(item, () => {
        const detail = document.createElement('div');
        detail.className = 'tx-detail';
        detail.appendChild(makeDetailRow(tx.incoming ? 'From' : 'To', counterparty || 'Unknown'));
        detail.appendChild(makeDetailRow('Amount', `${formatToken(tx.value)} ${symbol}`, false));
        if (tx.fee != null && !tx.incoming) {
            detail.appendChild(makeDetailRow('Fee', `${formatToken(tx.fee)} ${symbol} (paid in token via relay)`, false));
        }
        if (tx.txHash) detail.appendChild(makeDetailRow('Hash', tx.txHash));
        const status = tx.failed ? 'failed' : (tx.blockNumber > 0 ? `confirmed · block ${tx.blockNumber.toLocaleString()}` : 'pending');
        detail.appendChild(makeDetailRow('Status', status, false));
        if (tx.txHash) detail.appendChild(makeDetailActions(tx.token, tx.txHash));
        return detail;
    });
}
