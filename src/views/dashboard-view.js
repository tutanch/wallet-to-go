import { navigate } from '../router.js';
import { getStoredAddress } from '../modules/keyguard-api.js';
import * as network from '../modules/network-client.js';
import { formatNim, getSelectedNetwork } from '../config.js';
import { renderTxItem } from './history-view.js';

export async function dashboardView() {
    const address = await getStoredAddress();
    if (!address) {
        navigate('#welcome');
        return document.createElement('div');
    }

    let balance = null;
    let consensus = 'connecting';
    let recentTxs = [];
    let headHeight = 0;

    const el = document.createElement('div');
    el.className = 'view-container';

    // ── Build skeleton once ────────────────────────────────────────
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

    // ── Cache DOM references ───────────────────────────────────────
    const $consensus = el.querySelector('#d-consensus');
    const $balance = el.querySelector('#d-balance');
    const $blockHeight = el.querySelector('#d-block-height');
    const $address = el.querySelector('#d-address');
    const $txList = el.querySelector('#d-tx-list');
    const $btnAllTxs = el.querySelector('#btn-all-txs');

    // Set static address via textContent (XSS-safe)
    $address.textContent = address;

    // ── Attach event listeners once ────────────────────────────────
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

    // ── Targeted update function ───────────────────────────────────
    function update() {
        // Consensus indicator
        const consensusClass = consensus === 'established' ? 'consensus-ok' : 'consensus-syncing';
        const consensusText = consensus === 'established' ? 'Connected' :
                              consensus === 'syncing' ? 'Syncing...' : 'Connecting...';
        $consensus.className = `consensus-indicator ${consensusClass}`;
        $consensus.textContent = consensusText;

        // Balance
        $balance.textContent = balance !== null ? formatNim(balance) : '...';

        // Block height
        if (headHeight) {
            $blockHeight.textContent = `Block #${headHeight.toLocaleString()}`;
            $blockHeight.style.display = '';
        } else {
            $blockHeight.style.display = 'none';
        }

        // Transaction list — rebuild only the tx list, not the entire card
        $txList.innerHTML = '';
        if (recentTxs.length > 0) {
            recentTxs.slice(0, 5).forEach(tx => {
                $txList.appendChild(renderTxItem(tx, address));
            });
            $btnAllTxs.style.display = '';
        } else {
            const placeholder = document.createElement('p');
            placeholder.className = 'nq-text no-txs';
            placeholder.textContent = consensus === 'established'
                ? 'No transactions yet'
                : 'Waiting for consensus...';
            $txList.appendChild(placeholder);
            $btnAllTxs.style.display = 'none';
        }
    }

    update();

    // ── Network callbacks (non-blocking) ────────────────────────────
    // Network init runs after the view is returned so navigation feels instant.
    // The skeleton (balance "...", "Connecting...") is already visible.
    let removeConsensus = null;
    let removeHead = null;
    let removeTxListener = null;
    let cleaned = false;

    async function fetchFullData() {
        try {
            balance = await network.getBalance(address);
            recentTxs = await network.getHistory(address, 10);
            headHeight = await network.getHeadHeight();
        } catch (e) {
            console.error('Failed to fetch data:', e);
        }
    }

    async function initNetwork() {
        await network.connect();
        if (cleaned) return;

        removeConsensus = network.onConsensusChanged(async (state) => {
            consensus = state;
            if (state === 'established') {
                await fetchFullData();
            }
            update();
        });

        // If consensus is already established (e.g. navigating back from another view),
        // the listener above won't fire — so check current state immediately.
        if (await network.isConsensusEstablished()) {
            consensus = 'established';
            await fetchFullData();
            update();
        }

        if (cleaned) return;

        removeHead = network.onHeadChanged(async (hash) => {
            try {
                const block = await network.getBlock(hash);
                if (block) {
                    headHeight = block.height;
                    update();
                }
            } catch (e) {
                console.error('Failed to get block:', e);
            }
        });

        network.addTransactionListener(async (tx) => {
            recentTxs = [tx, ...recentTxs].slice(0, 10);
            try { balance = await network.getBalance(address); } catch (_) {}
            update();
        }, [address]).then(remove => {
            if (cleaned) {
                if (typeof remove === 'function') remove();
            } else {
                removeTxListener = remove;
            }
        });
    }

    // Fire and forget — view is returned immediately below
    initNetwork();

    return {
        element: el,
        cleanup: () => {
            cleaned = true;
            if (removeConsensus) removeConsensus();
            if (removeHead) removeHead();
            if (typeof removeTxListener === 'function') removeTxListener();
        },
    };
}
