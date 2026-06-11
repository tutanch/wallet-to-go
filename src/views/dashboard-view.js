import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress, activatePolygon } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { formatNim, formatToken, getSelectedNetwork, isStablecoinsEnabled } from '../config.js';
import { renderTxItem } from './history-view.js';
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
const polygonCache = { address: undefined, balances: null, ts: 0 };

/** Reset on logout/wallet switch so a new wallet doesn't see stale data. */
export function resetPolygonCache() {
    polygonCache.address = undefined;
    polygonCache.balances = null;
    polygonCache.ts = 0;
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
                <div class="action-buttons-secondary">
                    <button class="nq-button-s" id="btn-batch-send">Batch Send</button>
                    <button class="nq-button-s" id="btn-cashlinks">Cashlinks</button>
                </div>
                ${isStablecoinsEnabled() ? `
                <div class="stablecoins-section" id="stablecoins-section">
                    <div class="section-header">
                        <h2 class="nq-label">Stablecoins <span class="token-badge">Polygon</span></h2>
                    </div>
                    <div id="stablecoins-content"><p class="nq-text no-txs">Loading…</p></div>
                </div>` : ''}
                <div class="recent-txs">
                    <div class="section-header">
                        <h2 class="nq-label">Recent Transactions</h2>
                        <a class="nq-link" id="btn-all-txs" style="display:none;">View All</a>
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

        // Then fetch balances and re-render
        setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);

        try {
            const hasConsensus = await network.isConsensusEstablished();
            if (hasConsensus) {
                const client = await network.getClient();
                const addrs = allAddresses.map(a => a.address);
                const accounts = await client.getAccounts(addrs);
                const balances = {};
                for (let i = 0; i < addrs.length; i++) {
                    balances[addrs[i]] = accounts[i] ? Number(accounts[i].balance) : 0;
                }
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
    el.querySelector('#btn-batch-send').addEventListener('click', () => navigate('#batch-send'));
    el.querySelector('#btn-cashlinks').addEventListener('click', () => navigate('#cashlinks'));
    el.querySelector('#btn-settings').addEventListener('click', () => navigate('#settings'));
    $btnAllTxs.addEventListener('click', () => navigate('#history'));

    // ── Stablecoins (USDC/USDT on Polygon, wallet-level) ──────────
    const $stablecoins = el.querySelector('#stablecoins-content');
    let stablecoinsGone = false;

    function renderStablecoinBalances() {
        if (!$stablecoins || stablecoinsGone) return;
        $stablecoins.innerHTML = '';
        for (const token of ['usdc', 'usdt']) {
            const row = document.createElement('div');
            row.className = 'stablecoin-row';
            const symbol = document.createElement('span');
            symbol.className = 'stablecoin-symbol';
            symbol.textContent = token.toUpperCase();
            const amount = document.createElement('span');
            amount.className = 'stablecoin-amount';
            amount.textContent = polygonCache.balances
                ? formatToken(polygonCache.balances[token])
                : '…';
            row.appendChild(symbol);
            row.appendChild(amount);
            $stablecoins.appendChild(row);
        }
    }

    function renderStablecoinActivate() {
        if (!$stablecoins || stablecoinsGone) return;
        $stablecoins.innerHTML = '';
        const hint = document.createElement('p');
        hint.className = 'nq-text no-txs';
        hint.textContent = 'Send and receive USDC/USDT with fees paid in the token itself.';
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
        $stablecoins.appendChild(hint);
        $stablecoins.appendChild(btn);
    }

    function renderStablecoinError(message) {
        if (!$stablecoins || stablecoinsGone || polygonCache.balances) return;
        $stablecoins.innerHTML = '';
        const hint = document.createElement('p');
        hint.className = 'nq-text no-txs';
        hint.textContent = message;
        const retry = document.createElement('button');
        retry.className = 'nq-button-s';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => {
            $stablecoins.innerHTML = '<p class="nq-text no-txs">Loading…</p>';
            refreshPolygon(true);
        });
        $stablecoins.appendChild(hint);
        $stablecoins.appendChild(retry);
    }

    async function refreshPolygon(force = false) {
        if (!$stablecoins || stablecoinsGone) return;

        // Keyguard call first — its failures are NOT network problems
        // (e.g. an outdated keyguard origin right after a deploy).
        try {
            if (polygonCache.address === undefined) {
                polygonCache.address = (await getPolygonAddress())?.address || null;
            }
        } catch (e) {
            console.warn('Keyguard polygon query failed:', e);
            renderStablecoinError(e.message?.includes('Unknown command')
                ? 'Keyguard is updating — reload in a minute.'
                : 'Keyguard unavailable.');
            return;
        }
        if (stablecoinsGone) return;
        if (!polygonCache.address) {
            renderStablecoinActivate();
            return;
        }

        renderStablecoinBalances(); // cached values first
        try {
            if (force || Date.now() - polygonCache.ts > 30000) {
                const { getStablecoinBalances } = await import('../modules/polygon/polygon-client.js');
                polygonCache.balances = await getStablecoinBalances(polygonCache.address);
                polygonCache.ts = Date.now();
                renderStablecoinBalances();
            }
        } catch (e) {
            console.warn('Stablecoin balance refresh failed:', e);
            renderStablecoinError('Polygon network unavailable.');
        }
    }

    if ($stablecoins) refreshPolygon();

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

        $txList.innerHTML = '';
        if (cache.recentTxs.length > 0) {
            cache.recentTxs.slice(0, 5).forEach(tx => {
                $txList.appendChild(renderTxItem(tx, currentAddress));
            });
            $btnAllTxs.style.display = '';
        } else if (cache.consensus !== 'established') {
            const placeholder = document.createElement('p');
            placeholder.className = 'nq-text no-txs';
            placeholder.textContent = 'Waiting for consensus...';
            $txList.appendChild(placeholder);
            $btnAllTxs.style.display = 'none';
        } else {
            const placeholder = document.createElement('p');
            placeholder.className = 'nq-text no-txs';
            placeholder.textContent = 'No transactions yet';
            $txList.appendChild(placeholder);
            $btnAllTxs.style.display = 'none';
        }
    }

    // Pull-to-refresh
    const cardBody = el.querySelector('.nq-card-body');
    const cleanupPull = enablePullToRefresh(cardBody, async () => {
        try {
            if ($stablecoins) refreshPolygon(true); // non-blocking
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
            viewUpdate = null;
            stablecoinsGone = true;
            closePicker();
            cleanupPull();
        },
    };
}
