import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import * as network from '../modules/network-client.js';
import { formatNim, formatToken, isStablecoinsEnabled, ASSETS } from '../config.js';
import { renderTxItem, renderSkeletonRows, mountTokenHistory } from './history-view.js';
import { assetLogo } from '../lib/asset-logos.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { skeletonText, settleText, reserveList } from '../modules/ui.js';

/**
 * Per-asset view: balance, address, Send/Receive preselected for the asset,
 * and the asset's full activity. This is the dedicated home each asset row
 * on the dashboard opens.
 */
export async function assetView(asset) {
    const meta = ASSETS[asset];
    const defaultAddress = await getStoredAddress();
    if (!defaultAddress || !meta) {
        navigate('#welcome');
        return document.createElement('div');
    }

    // Active NIM address (derived address picker)
    const activeIdx = getActiveAddressIndex();
    let nimAddress = defaultAddress;
    try {
        const result = await getDerivedAddresses();
        if (result?.addresses?.[activeIdx]) {
            nimAddress = result.addresses[activeIdx].address;
        }
    } catch (_) {}

    // Token views need an activated Polygon address
    let polygonAddress = null;
    if (asset !== 'nim') {
        if (!isStablecoinsEnabled()) {
            navigate('#dashboard');
            return document.createElement('div');
        }
        try {
            polygonAddress = (await getPolygonAddress())?.address || null;
        } catch (_) {}
        if (!polygonAddress) {
            navigate('#dashboard');
            return document.createElement('div');
        }
    }

    const displayAddress = asset === 'nim' ? nimAddress : polygonAddress;

    // NIM-only tools (batch send, cashlinks) — list rows in the asset's home
    const nimTools = asset !== 'nim' ? '' : `
                <div class="section-header">
                    <h2 class="nq-label">Tools</h2>
                </div>
                <div class="asset-list">
                    <button type="button" class="asset-row" id="btn-batch-send">
                        <span class="tx-direction" style="background:${meta.color}" aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11l5-5 5 5M7 17l5-5 5 5"/></svg>
                        </span>
                        <span class="asset-info">
                            <span class="asset-name">Batch Send</span>
                            <span class="asset-sub">Send to many recipients at once</span>
                        </span>
                        <span class="asset-chevron" aria-hidden="true">&rsaquo;</span>
                    </button>
                    <button type="button" class="asset-row" id="btn-cashlinks">
                        <span class="tx-direction" style="background:${meta.color}" aria-hidden="true">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </span>
                        <span class="asset-info">
                            <span class="asset-name">Cashlinks</span>
                            <span class="asset-sub">Shareable links pre-loaded with NIM</span>
                        </span>
                        <span class="asset-chevron" aria-hidden="true">&rsaquo;</span>
                    </button>
                </div>`;

    const el = document.createElement('div');
    el.className = 'view-container';
    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <div class="asset-hero">
                    <span class="asset-badge" id="a-badge" aria-hidden="true">${assetLogo(asset)}</span>
                    <h1 class="nq-h1" style="margin: 10px 0 0;">${meta.name}</h1>
                    <p class="nq-text-s">${meta.network}</p>
                </div>
                <div class="balance-display">
                    <span class="balance-amount" id="a-balance" aria-live="polite"></span>
                    <span class="balance-currency">${meta.symbol}</span>
                </div>
                <div class="address-display" id="address-copy" title="Click to copy" role="button" tabindex="0" aria-label="Copy address">
                    <span class="address-text" id="a-address"></span>
                </div>
            </div>
            <div class="nq-card-body">
                <div class="action-buttons">
                    <button class="nq-button light-blue" id="btn-send">Send</button>
                    <button class="nq-button green" id="btn-receive">Receive</button>
                </div>${nimTools}
                <div class="section-header">
                    <h2 class="nq-label">Activity</h2>
                </div>
                <div class="tx-list" id="a-tx-list"></div>
                <p class="nq-text-s" id="scan-info" aria-live="polite" style="display:none; text-align:center; margin: 12px 0;"></p>
                <button class="nq-button-s" id="btn-load-older" style="display:none;">Load older</button>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    el.querySelector('#a-address').textContent = displayAddress;

    let gone = false;

    // ── Balance ────────────────────────────────────────────────────────────
    const $balance = el.querySelector('#a-balance');
    skeletonText($balance, 7);
    (async () => {
        try {
            if (asset === 'nim') {
                const balance = await network.getBalance(nimAddress);
                if (!gone) settleText($balance, formatNim(balance));
            } else {
                const { getStablecoinBalances } = await import('../modules/polygon/polygon-client.js');
                const balances = await getStablecoinBalances(polygonAddress);
                if (!gone) settleText($balance, formatToken(balances[asset]));
            }
        } catch (_) {
            if (!gone) settleText($balance, '—');
        }
    })();

    // ── Copy address ───────────────────────────────────────────────────────
    async function copyAddress() {
        try {
            await navigator.clipboard.writeText(displayAddress);
            const display = el.querySelector('#address-copy');
            display.classList.add('copied');
            showToast('Address copied!', 'success');
            setTimeout(() => display.classList.remove('copied'), 600);
        } catch (_) {}
    }
    el.querySelector('#address-copy').addEventListener('click', copyAddress);
    el.querySelector('#address-copy').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            copyAddress();
        }
    });

    // ── Send / Receive preselect this asset ───────────────────────────────
    el.querySelector('#btn-send').addEventListener('click', () => {
        sessionStorage.setItem('preselect-asset', asset);
        navigate('#send');
    });
    el.querySelector('#btn-receive').addEventListener('click', () => {
        sessionStorage.setItem('preselect-receive', asset === 'nim' ? 'nim' : 'polygon');
        navigate('#receive');
    });

    if (asset === 'nim') {
        el.querySelector('#btn-batch-send').addEventListener('click', () => navigate('#batch-send'));
        el.querySelector('#btn-cashlinks').addEventListener('click', () => navigate('#cashlinks'));
    }

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    // ── Activity ───────────────────────────────────────────────────────────
    const txList = el.querySelector('#a-tx-list');
    const loadOlderBtn = el.querySelector('#btn-load-older');
    const scanInfo = el.querySelector('#scan-info');

    // Reserve list height so skeleton → rows → empty-state don't change height.
    reserveList(txList, 4);

    if (asset === 'nim') {
        (async () => {
            txList.appendChild(renderSkeletonRows(4));
            try {
                const txs = await network.getHistory(nimAddress, 50);
                if (gone) return;
                txList.innerHTML = '';
                if (txs.length === 0) {
                    txList.innerHTML = '<p class="nq-text no-txs">No transactions yet</p>';
                } else {
                    txs.forEach((tx) => txList.appendChild(renderTxItem(tx, nimAddress)));
                }
            } catch (e) {
                if (gone) return;
                txList.innerHTML = '';
                const errorP = document.createElement('p');
                errorP.className = 'nq-text error-text';
                errorP.setAttribute('role', 'alert');
                errorP.textContent = 'Failed to load: ' + e.message;
                txList.appendChild(errorP);
            }
        })();
    } else {
        mountTokenHistory({
            list: txList,
            loadOlderBtn,
            scanInfo,
            polygonAddress,
            token: asset,
            isActive: () => !gone,
        });
    }

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return {
        element: el,
        cleanup: () => {
            gone = true;
            cleanupSwipe();
        },
    };
}
