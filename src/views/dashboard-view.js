import { navigate } from '../router.js';
import { getStoredAddress } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { formatNim, getSelectedNetwork } from '../config.js';
import { renderTxItem } from './history-view.js';

// ── Module-level cache (survives navigation) ────────────────────
const cache = { balance: null, consensus: 'connecting', recentTxs: [], headHeight: 0, address: null, network: null };
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
    const address = await getStoredAddress();
    if (!address) {
        navigate('#welcome');
        return document.createElement('div');
    }

    // Start or re-attach background listeners (no-op if already running for same address+network)
    startBackground(address);

    const el = document.createElement('div');
    el.className = 'view-container';

    const networkLabel = getSelectedNetwork() === 'main' ? 'Mainnet' : 'Testnet';

    el.innerHTML = `
        <div class="nq-card dashboard-card">
            <div class="nq-card-header">
                <div class="status-bar">
                    <span class="consensus-indicator" id="d-consensus"></span>
                    <span class="network-label">${networkLabel}</span>
                    <span class="block-height" id="d-block-height" style="display:none;"></span>
                </div>
                <div class="balance-display">
                    <span class="balance-amount nq-h1" id="d-balance">...</span>
                    <span class="balance-currency">NIM</span>
                </div>
                <div class="address-display" id="address-copy" title="Click to copy">
                    <span class="address-text" id="d-address"></span>
                </div>
            </div>
            <div class="nq-card-body">
                <div class="action-buttons">
                    <button class="nq-button light-blue" id="btn-send">Send</button>
                    <button class="nq-button green" id="btn-receive">Receive</button>
                </div>
                <div class="action-buttons-secondary">
                    <button class="nq-button-s" id="btn-batch-send">Batch Send</button>
                </div>
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

    $address.textContent = address;

    el.querySelector('#address-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(address);
            const original = $address.textContent;
            $address.textContent = 'Copied!';
            setTimeout(() => { $address.textContent = original; }, 1500);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });

    el.querySelector('#btn-send').addEventListener('click', () => navigate('#send'));
    el.querySelector('#btn-receive').addEventListener('click', () => navigate('#receive'));
    el.querySelector('#btn-batch-send').addEventListener('click', () => navigate('#batch-send'));
    el.querySelector('#btn-settings').addEventListener('click', () => navigate('#settings'));
    $btnAllTxs.addEventListener('click', () => navigate('#history'));

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
                $txList.appendChild(renderTxItem(tx, address));
            });
            $btnAllTxs.style.display = '';
        } else {
            const placeholder = document.createElement('p');
            placeholder.className = 'nq-text no-txs';
            placeholder.textContent = cache.consensus === 'established'
                ? 'No transactions yet'
                : 'Waiting for consensus...';
            $txList.appendChild(placeholder);
            $btnAllTxs.style.display = 'none';
        }
    }

    // Render immediately from cache, subscribe to background updates
    viewUpdate = update;
    update();

    return {
        element: el,
        cleanup: () => { viewUpdate = null; },
    };
}
