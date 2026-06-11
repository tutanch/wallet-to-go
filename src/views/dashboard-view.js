import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress, activatePolygon } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { formatNim, formatToken, getSelectedNetwork, isStablecoinsEnabled, ASSETS, NETWORKS } from '../config.js';
import { renderTxItem, renderTokenTxItem } from './history-view.js';
import { assetLogo } from '../lib/asset-logos.js';
import { showToast } from '../modules/toast.js';
import { enablePullToRefresh } from '../modules/gestures.js';

// ── Active address index (persists across navigations) ───────────
export function getActiveAddressIndex() {
    return parseInt(localStorage.getItem('nimiq-addr-idx') || '0', 10);
}

function setActiveAddressIndex(idx) {
    localStorage.setItem('nimiq-addr-idx', String(idx));
}

// ── Module-level cache (survives navigation) ────────────────────
const cache = { balance: null, consensus: 'connecting', recentTxs: [], headHeight: 0, address: null, network: null };

// Polygon/stablecoin cache — wallet-level (independent of the NIM address
// picker). address: undefined = not queried yet, null = not activated.
// tokenTxs feeds the unified activity stream on the dashboard.
const polygonCache = { address: undefined, balances: null, ts: 0, tokenTxs: null, txTs: 0 };

/** Reset on logout/wallet switch so a new wallet doesn't see stale data. */
export function resetPolygonCache() {
    polygonCache.address = undefined;
    polygonCache.balances = null;
    polygonCache.ts = 0;
    polygonCache.tokenTxs = null;
    polygonCache.txTs = 0;
}
let bgGeneration = 0;
let bgTeardown = null;
let viewUpdate = null;   // current view's render callback

function startBackground(address) {
    const net = getSelectedNetwork();
    const gen = ++bgGeneration;

    // Tear down old listeners (no-op if already cleaned by disconnect)
    if (bgTeardown) { bgTeardown(); bgTeardown = null; }

    // Reset cache when address or network changed
    if (cache.address !== address || cache.network !== net) {
        Object.assign(cache, { balance: null, consensus: 'connecting', recentTxs: [], headHeight: 0, address, network: net });
    }

    (async () => {
        await network.connect();
        if (gen !== bgGeneration) return;

        async function fetchFullData() {
            try {
                cache.balance = await network.getBalance(address);
                cache.recentTxs = await network.getHistory(address, 10);
                cache.headHeight = await network.getHeadHeight();
            } catch (e) {
                console.error('Failed to fetch data:', e);
            }
        }

        const removeConsensus = network.onConsensusChanged(async (state) => {
            cache.consensus = state;
            if (state === 'established') await fetchFullData();
            if (viewUpdate) viewUpdate();
        });

        // If consensus is already established, fetch immediately
        if (await network.isConsensusEstablished()) {
            cache.consensus = 'established';
            await fetchFullData();
            if (viewUpdate) viewUpdate();
        }

        if (gen !== bgGeneration) { removeConsensus(); return; }

        const removeHead = network.onHeadChanged(async (hash) => {
            try {
                const block = await network.getBlock(hash);
                if (block) {
                    cache.headHeight = block.height;
                    if (viewUpdate) viewUpdate();
                }
            } catch (e) {
                console.error('Failed to get block:', e);
            }
        });

        let removeTx = null;
        network.addTransactionListener(async (tx) => {
            cache.recentTxs = [tx, ...cache.recentTxs].slice(0, 10);
            try { cache.balance = await network.getBalance(address); } catch (_) {}
            if (viewUpdate) viewUpdate();
        }, [address]).then(remove => {
            if (gen !== bgGeneration) {
                if (typeof remove === 'function') remove();
            } else {
                removeTx = remove;
            }
        });

        bgTeardown = () => {
            removeConsensus();
            removeHead();
            if (typeof removeTx === 'function') removeTx();
            bgTeardown = null;
        };
    })();
}

// ── View ────────────────────────────────────────────────────────
export async function dashboardView() {
    const defaultAddress = await getStoredAddress();
    if (!defaultAddress) {
        navigate('#welcome');
        return document.createElement('div');
    }

    // Fetch all derived addresses (non-blocking — falls back to just the default)
    let allAddresses = [{ index: 0, address: defaultAddress }];
    try {
        const result = await getDerivedAddresses();
        if (result?.addresses?.length > 0) allAddresses = result.addresses;
    } catch (_) {}

    let activeIdx = getActiveAddressIndex();
    if (activeIdx >= allAddresses.length) activeIdx = 0;
    let currentAddress = allAddresses[activeIdx]?.address || defaultAddress;

    // Start background listeners for the current address
    startBackground(currentAddress);

    const el = document.createElement('div');
    el.className = 'view-container';

    const networkLabel = getSelectedNetwork() === 'main' ? 'Mainnet' : 'Testnet';
    const hasMultiple = allAddresses.length > 1;

    el.innerHTML = `
        <div class="nq-card dashboard-card">
            <div class="nq-card-header">
                <div class="status-bar">
                    <span class="consensus-indicator" id="d-consensus" role="status"></span>
                    <span class="network-label">${networkLabel}</span>
                    <span class="block-height" id="d-block-height" style="display:none;"></span>
                </div>
                <div class="balance-display">
                    <span class="nq-label">Balance</span>
                    <span class="balance-amount nq-h1" id="d-balance">...</span>
                    <span class="balance-currency">NIM</span>
                </div>
                <div class="address-row">
                    <div class="address-display" id="address-copy" title="Click to copy" role="button" tabindex="0" aria-label="Copy address">
                        <span class="address-text" id="d-address"></span>
                    </div>
                    ${hasMultiple ? '<button class="addr-picker-btn" id="btn-addr-picker" title="Switch address" aria-label="Switch address" aria-expanded="false">&#9662;</button>' : ''}
                </div>
                <div class="addr-picker-dropdown" id="addr-picker" style="display:none;"></div>
            </div>
            <div class="nq-card-body">
                <div class="action-buttons">
                    <button class="nq-button light-blue" id="btn-send">Send</button>
                    <button class="nq-button green" id="btn-receive">Receive</button>
                </div>
                <div class="stablecoins-section">
                    <div class="section-header">
                        <h2 class="nq-label">Assets</h2>
                    </div>
                    <div class="asset-list" id="asset-list"></div>
                    <div id="polygon-prompt"></div>
                </div>
                <div class="recent-txs">
                    <div class="section-header">
                        <h2 class="nq-label">Activity</h2>
                        <a class="nq-link" id="btn-all-txs" style="display:none;">View all</a>
                    </div>
                    <div class="tx-list" id="d-tx-list"></div>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-settings">Settings</button>
            </div>
        </div>
    `;

    const $consensus = el.querySelector('#d-consensus');
    const $balance = el.querySelector('#d-balance');
    const $blockHeight = el.querySelector('#d-block-height');
    const $address = el.querySelector('#d-address');
    const $txList = el.querySelector('#d-tx-list');
    const $btnAllTxs = el.querySelector('#btn-all-txs');
    const $picker = el.querySelector('#addr-picker');
    const $pickerBtn = el.querySelector('#btn-addr-picker');

    function renderAddress() {
        $address.textContent = currentAddress;
    }
    renderAddress();

    // ── Address picker ────────────────────────────────────────
    let pickerOpen = false;

    function closePicker() {
        if (!pickerOpen) return;
        pickerOpen = false;
        $picker.style.display = 'none';
        if ($pickerBtn) {
            $pickerBtn.classList.remove('open');
            $pickerBtn.setAttribute('aria-expanded', 'false');
        }
        document.removeEventListener('click', onOutsideClick, true);
    }

    function onOutsideClick(e) {
        if ($picker.contains(e.target) || ($pickerBtn && $pickerBtn.contains(e.target))) return;
        closePicker();
    }

    function selectAddress(newIdx) {
        closePicker();
        if (newIdx === activeIdx) return;
        activeIdx = newIdx;
        currentAddress = allAddresses[activeIdx].address;
        setActiveAddressIndex(activeIdx);
        renderAddress();
        startBackground(currentAddress);
        update();
    }

    function buildPickerRows(balances) {
        $picker.innerHTML = '';
        for (const entry of allAddresses) {
            const row = document.createElement('button');
            row.className = 'addr-picker-row' + (entry.index === activeIdx ? ' active' : '');
            row.type = 'button';

            const idxSpan = document.createElement('span');
            idxSpan.className = 'addr-picker-idx';
            idxSpan.textContent = `#${entry.index + 1}`;

            const details = document.createElement('span');
            details.className = 'addr-picker-details';

            const addrSpan = document.createElement('span');
            addrSpan.className = 'addr-picker-addr';
            const a = entry.address;
            addrSpan.textContent = a.substring(0, 9) + '...' + a.substring(a.length - 4);

            details.appendChild(addrSpan);

            if (balances && balances[entry.address] !== undefined) {
                const balSpan = document.createElement('span');
                balSpan.className = 'addr-picker-bal';
                balSpan.textContent = formatNim(balances[entry.address]) + ' NIM';
                details.appendChild(balSpan);
            }

            row.appendChild(idxSpan);
            row.appendChild(details);

            row.addEventListener('click', () => selectAddress(entry.index));
            $picker.appendChild(row);
        }
    }

    async function openPicker() {
        if (pickerOpen) { closePicker(); return; }
        pickerOpen = true;
        $picker.style.display = '';
        if ($pickerBtn) {
            $pickerBtn.classList.add('open');
            $pickerBtn.setAttribute('aria-expanded', 'true');
        }

        // Show immediately without balances
        buildPickerRows(null);

        // Registered synchronously so "listener registered ⟺ pickerOpen"
        // holds strictly. Safe: the opening click's capture phase over the
        // document has already passed, and onOutsideClick ignores the button.
        document.addEventListener('click', onOutsideClick, true);

        // Then fetch balances and re-render
        try {
            const hasConsensus = await network.isConsensusEstablished();
            if (hasConsensus) {
                const balances = await network.getBalances(allAddresses.map(a => a.address));
                if (pickerOpen) buildPickerRows(balances);
            }
        } catch (_) {}
    }

    if ($pickerBtn) {
        $pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openPicker();
        });
    }

    el.querySelector('#address-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(currentAddress);
            const display = el.querySelector('#address-copy');
            display.classList.add('copied');
            showToast('Address copied!', 'success');
            setTimeout(() => display.classList.remove('copied'), 600);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });
    el.querySelector('#address-copy').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            el.querySelector('#address-copy').click();
        }
    });

    el.querySelector('#btn-send').addEventListener('click', () => navigate('#send'));
    el.querySelector('#btn-receive').addEventListener('click', () => navigate('#receive'));
    el.querySelector('#btn-settings').addEventListener('click', () => navigate('#settings'));
    $btnAllTxs.addEventListener('click', () => navigate('#history'));

    // ── Assets (NIM + USDC/USDT), wallet-level ────────────────────
    const $assetList = el.querySelector('#asset-list');
    const $polygonPrompt = el.querySelector('#polygon-prompt');
    let assetsGone = false;

    function buildAssetRow(asset, balanceText, subText, onClick) {
        const meta = ASSETS[asset];
        const row = document.createElement('button');
        row.className = 'asset-row';
        row.type = 'button';

        const badge = document.createElement('span');
        badge.className = 'asset-badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.innerHTML = assetLogo(asset);

        const info = document.createElement('span');
        info.className = 'asset-info';
        const name = document.createElement('span');
        name.className = 'asset-name';
        name.textContent = meta.name;
        const sub = document.createElement('span');
        sub.className = 'asset-sub';
        sub.textContent = subText;
        info.append(name, sub);

        const amounts = document.createElement('span');
        amounts.className = 'asset-amounts';
        const bal = document.createElement('span');
        bal.className = 'asset-balance';
        bal.textContent = balanceText;
        const sym = document.createElement('span');
        sym.className = 'asset-symbol';
        sym.textContent = meta.symbol;
        amounts.append(bal, sym);

        const chevron = document.createElement('span');
        chevron.className = 'asset-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '›';

        row.append(badge, info, amounts, chevron);
        row.addEventListener('click', onClick);
        return row;
    }

    function renderAssetRows() {
        if (assetsGone) return;
        $assetList.innerHTML = '';

        const nimShort = currentAddress.substring(0, 9) + '…';
        $assetList.appendChild(buildAssetRow(
            'nim',
            cache.balance !== null ? formatNim(cache.balance) : '…',
            nimShort,
            () => navigate('#asset-nim'),
        ));

        if (!isStablecoinsEnabled() || !polygonCache.address) return;
        for (const token of ['usdc', 'usdt']) {
            $assetList.appendChild(buildAssetRow(
                token,
                polygonCache.balances ? formatToken(polygonCache.balances[token]) : '…',
                'Polygon',
                () => navigate('#asset-' + token),
            ));
        }
    }

    function renderPolygonPrompt(kind, message) {
        if (assetsGone) return;
        $polygonPrompt.innerHTML = '';
        if (kind === 'none') return;

        const wrap = document.createElement('div');
        wrap.className = 'empty-state';
        const hint = document.createElement('p');
        hint.className = 'nq-text-s';
        hint.style.marginBottom = '10px';

        if (kind === 'activate') {
            hint.textContent = 'Add USDC and USDT on Polygon — fees are paid in the token itself.';
            const btn = document.createElement('button');
            btn.className = 'nq-button-s';
            btn.textContent = 'Activate Polygon';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.textContent = 'Waiting for keyguard…';
                try {
                    const { address } = await activatePolygon();
                    polygonCache.address = address;
                    showToast('Polygon activated!', 'success');
                    // Created-here wallets: remember the activation block so
                    // history never scans before the wallet existed.
                    if (localStorage.getItem('wallet-created-here') === '1') {
                        try {
                            const [{ setScanFloor }, { getBlockNumber }] = await Promise.all([
                                import('../modules/polygon/polygon-history.js'),
                                import('../modules/polygon/polygon-client.js'),
                            ]);
                            await setScanFloor(address, await getBlockNumber());
                        } catch (_) {}
                    }
                    renderPolygonPrompt('none');
                    refreshPolygon(true);
                } catch (e) {
                    btn.disabled = false;
                    btn.removeAttribute('aria-busy');
                    btn.textContent = 'Activate Polygon';
                    if (e.message !== 'User cancelled') {
                        showToast('Activation failed', 'error');
                    }
                }
            });
            wrap.append(hint, btn);
        } else {
            hint.setAttribute('role', 'alert');
            hint.textContent = message;
            const retry = document.createElement('button');
            retry.className = 'nq-button-s';
            retry.textContent = 'Retry';
            retry.addEventListener('click', () => {
                renderPolygonPrompt('none');
                refreshPolygon(true);
            });
            wrap.append(hint, retry);
        }
        $polygonPrompt.appendChild(wrap);
    }

    // Token activity for the unified feed: cached rows immediately, then a
    // background sync of both tokens refreshes the cache.
    async function loadTokenActivity(force = false) {
        if (assetsGone || !polygonCache.address) return;
        try {
            const history = await import('../modules/polygon/polygon-history.js');
            const load = async () => {
                const [usdc, usdt] = await Promise.all([
                    history.getCachedTxs(polygonCache.address, 'usdc', { limit: 8 }),
                    history.getCachedTxs(polygonCache.address, 'usdt', { limit: 8 }),
                ]);
                const merged = [...usdc, ...usdt];
                await history.resolveTimestamps(merged).catch(() => {});
                polygonCache.tokenTxs = merged;
                if (viewUpdate) viewUpdate();
            };
            await load();
            if (force || Date.now() - polygonCache.txTs > 60000) {
                polygonCache.txTs = Date.now();
                Promise.allSettled([
                    history.syncRecent(polygonCache.address, 'usdc'),
                    history.syncRecent(polygonCache.address, 'usdt'),
                ]).then(load).catch(() => {});
            }
        } catch (e) {
            console.warn('Token activity load failed:', e);
        }
    }

    async function refreshPolygon(force = false) {
        if (!isStablecoinsEnabled() || assetsGone) return;

        // Keyguard call first — its failures are NOT network problems
        // (e.g. an outdated keyguard origin right after a deploy).
        try {
            if (polygonCache.address === undefined) {
                polygonCache.address = (await getPolygonAddress())?.address || null;
            }
        } catch (e) {
            console.warn('Keyguard polygon query failed:', e);
            renderPolygonPrompt('error', e.message?.includes('Unknown command')
                ? 'Keyguard is updating — reload in a minute.'
                : 'Keyguard unavailable.');
            return;
        }
        if (assetsGone) return;
        if (!polygonCache.address) {
            renderAssetRows();
            renderPolygonPrompt('activate');
            return;
        }

        renderPolygonPrompt('none');
        renderAssetRows(); // cached values first
        loadTokenActivity(force); // non-blocking
        try {
            if (force || Date.now() - polygonCache.ts > 30000) {
                const { getStablecoinBalances } = await import('../modules/polygon/polygon-client.js');
                polygonCache.balances = await getStablecoinBalances(polygonCache.address);
                polygonCache.ts = Date.now();
                renderAssetRows();
            }
        } catch (e) {
            console.warn('Stablecoin balance refresh failed:', e);
            if (!polygonCache.balances) {
                renderPolygonPrompt('error', 'Polygon network unavailable.');
            }
        }
    }

    if (isStablecoinsEnabled()) refreshPolygon();

    // ── Render from cache ───────────────────────────────────────
    function update() {
        const consensusClass = cache.consensus === 'established' ? 'consensus-ok' : 'consensus-syncing';
        const consensusText = cache.consensus === 'established' ? 'Connected' :
                              cache.consensus === 'syncing' ? 'Syncing...' : 'Connecting...';
        $consensus.className = `consensus-indicator ${consensusClass}`;
        $consensus.textContent = consensusText;

        $balance.textContent = cache.balance !== null ? formatNim(cache.balance) : '...';

        if (cache.headHeight) {
            $blockHeight.textContent = `Block #${cache.headHeight.toLocaleString()}`;
            $blockHeight.style.display = '';
        } else {
            $blockHeight.style.display = 'none';
        }

        renderAssetRows();

        // Unified activity: merge NIM and token transfers by time
        const FUTURE = Number.MAX_SAFE_INTEGER; // pending (no timestamp) sorts first
        const entries = [
            ...cache.recentTxs.map(tx => ({ token: null, ts: tx.timestamp || FUTURE, tx })),
            ...(polygonCache.tokenTxs || []).map(tx => ({ token: tx.token, ts: tx.timestamp || FUTURE, tx })),
        ].sort((a, b) => b.ts - a.ts).slice(0, 6);

        $txList.innerHTML = '';
        if (entries.length > 0) {
            entries.forEach(({ token, tx }) => {
                $txList.appendChild(token ? renderTokenTxItem(tx) : renderTxItem(tx, currentAddress));
            });
            $btnAllTxs.style.display = '';
        } else if (cache.consensus !== 'established') {
            const placeholder = document.createElement('p');
            placeholder.className = 'nq-text no-txs';
            placeholder.textContent = 'Connecting to the network…';
            $txList.appendChild(placeholder);
            $btnAllTxs.style.display = 'none';
        } else {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const hint = document.createElement('p');
            hint.className = 'nq-text';
            hint.textContent = 'No activity yet. Receive your first NIM to get started.';
            const cta = document.createElement('button');
            cta.className = 'nq-button-s';
            cta.textContent = 'Show my address';
            cta.addEventListener('click', () => navigate('#receive'));
            empty.append(hint, cta);
            if (getSelectedNetwork() === 'test') {
                const faucet = document.createElement('p');
                faucet.className = 'nq-text-s';
                faucet.style.marginTop = '10px';
                const link = document.createElement('a');
                link.className = 'nq-link';
                link.href = NETWORKS.test.faucetUrl;
                link.target = '_blank';
                link.rel = 'noopener';
                link.textContent = 'Get free test NIM from the faucet ↗';
                faucet.appendChild(link);
                empty.appendChild(faucet);
            }
            $txList.appendChild(empty);
            $btnAllTxs.style.display = 'none';
        }
    }

    // Pull-to-refresh
    const cardBody = el.querySelector('.nq-card-body');
    const cleanupPull = enablePullToRefresh(cardBody, async () => {
        try {
            refreshPolygon(true); // non-blocking (no-op when stablecoins disabled)
            cache.balance = await network.getBalance(currentAddress);
            cache.recentTxs = await network.getHistory(currentAddress, 10);
            cache.headHeight = await network.getHeadHeight();
            update();
        } catch (e) {
            console.error('Refresh failed:', e);
        }
    });

    // Render immediately from cache, subscribe to background updates
    viewUpdate = update;
    update();

    return {
        element: el,
        cleanup: () => {
            // Ownership check: a superseded instance's cleanup must not null
            // out the viewUpdate a newer dashboard has already installed.
            if (viewUpdate === update) viewUpdate = null;
            assetsGone = true;
            closePicker();
            cleanupPull();
        },
    };
}
