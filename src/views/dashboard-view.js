import { navigate } from '../router.js';
import { getStoredAddress } from '../modules/key-store.js';
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

    function render() {
        const networkLabel = getSelectedNetwork() === 'main' ? 'Mainnet' : 'Testnet';
        const consensusClass = consensus === 'established' ? 'consensus-ok' : 'consensus-syncing';
        const consensusText = consensus === 'established' ? 'Connected' :
                              consensus === 'syncing' ? 'Syncing...' : 'Connecting...';

        el.innerHTML = `
            <div class="nq-card dashboard-card">
                <div class="nq-card-header">
                    <div class="status-bar">
                        <span class="consensus-indicator ${consensusClass}">${consensusText}</span>
                        <span class="network-label">${networkLabel}</span>
                        ${headHeight ? `<span class="block-height">Block #${headHeight.toLocaleString()}</span>` : ''}
                    </div>
                    <div class="balance-display">
                        <span class="balance-amount nq-h1">${balance !== null ? formatNim(balance) : '...'}</span>
                        <span class="balance-currency">NIM</span>
                    </div>
                    <div class="address-display" id="address-copy" title="Click to copy">
                        <span class="address-text">${address}</span>
                    </div>
                </div>
                <div class="nq-card-body">
                    <div class="action-buttons">
                        <button class="nq-button light-blue" id="btn-send">Send</button>
                        <button class="nq-button green" id="btn-receive">Receive</button>
                    </div>
                    <div class="recent-txs">
                        <div class="section-header">
                            <h2 class="nq-label">Recent Transactions</h2>
                            ${recentTxs.length > 0 ? '<a class="nq-link" id="btn-all-txs">View All</a>' : ''}
                        </div>
                        <div class="tx-list" id="tx-list">
                            ${recentTxs.length === 0
                                ? `<p class="nq-text no-txs">${consensus === 'established' ? 'No transactions yet' : 'Waiting for consensus...'}</p>`
                                : ''}
                        </div>
                    </div>
                </div>
                <div class="nq-card-footer">
                    <button class="nq-button-s" id="btn-settings">Settings</button>
                </div>
            </div>
        `;

        const txList = el.querySelector('#tx-list');
        recentTxs.slice(0, 5).forEach(tx => {
            txList.appendChild(renderTxItem(tx, address));
        });

        el.querySelector('#address-copy').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(address);
                const addressEl = el.querySelector('.address-text');
                const original = addressEl.textContent;
                addressEl.textContent = 'Copied!';
                setTimeout(() => { addressEl.textContent = original; }, 1500);
            } catch {
                // Clipboard API may fail without HTTPS or permissions
            }
        });

        el.querySelector('#btn-send').addEventListener('click', () => navigate('#send'));
        el.querySelector('#btn-receive').addEventListener('click', () => navigate('#receive'));
        el.querySelector('#btn-settings').addEventListener('click', () => navigate('#settings'));

        const btnAllTxs = el.querySelector('#btn-all-txs');
        if (btnAllTxs) btnAllTxs.addEventListener('click', () => navigate('#history'));
    }

    render();

    // Start network connection
    await network.connect();

    // Fetch balance + history + initial head height on consensus established
    async function fetchFullData() {
        try {
            balance = await network.getBalance(address);
            recentTxs = await network.getHistory(address, 10);
            headHeight = await network.getHeadHeight();
        } catch (e) {
            console.error('Failed to fetch data:', e);
        }
    }

    const removeConsensus = network.onConsensusChanged(async (state) => {
        consensus = state;
        if (state === 'established') {
            await fetchFullData();
        }
        render();
    });

    // If consensus is already established (e.g. navigating back from another view),
    // the listener above won't fire — so check current state immediately.
    if (await network.isConsensusEstablished()) {
        consensus = 'established';
        await fetchFullData();
        render();
    }

    // Head changes update block height directly from the event —
    // no network call needed. Balance is NOT refetched here, as it
    // only changes on transactions (matching the Nimiq Wallet pattern).
    const removeHead = network.onHeadChanged(async (hash) => {
        try {
            const block = await network.getBlock(hash);
            if (block) {
                headHeight = block.height;
                render();
            }
        } catch (e) {
            console.error('Failed to get block:', e);
        }
    });

    // Transaction listener handles new txs in real-time without polling.
    // Store the removal function once resolved to handle cleanup race condition.
    let removeTxListener = null;
    let cleaned = false;
    network.addTransactionListener((tx) => {
        recentTxs = [tx, ...recentTxs].slice(0, 10);
        render();
    }, [address]).then(remove => {
        if (cleaned) {
            // View was already cleaned up before listener resolved — remove immediately
            if (typeof remove === 'function') remove();
        } else {
            removeTxListener = remove;
        }
    });

    return {
        element: el,
        cleanup: () => {
            cleaned = true;
            removeConsensus();
            removeHead();
            if (typeof removeTxListener === 'function') removeTxListener();
        },
    };
}
