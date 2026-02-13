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
            await navigator.clipboard.writeText(address);
            const addressEl = el.querySelector('.address-text');
            const original = addressEl.textContent;
            addressEl.textContent = 'Copied!';
            setTimeout(() => { addressEl.textContent = original; }, 1500);
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

    const removeConsensus = network.onConsensusChanged(async (state) => {
        consensus = state;
        if (state === 'established') {
            try {
                balance = await network.getBalance(address);
                recentTxs = await network.getHistory(address, 10);
                headHeight = await network.getHeadHeight();
            } catch (e) {
                console.error('Failed to fetch data:', e);
            }
        }
        render();
    });

    const removeHead = network.onHeadChanged(async () => {
        try {
            headHeight = await network.getHeadHeight();
            if (await network.isConsensusEstablished()) {
                balance = await network.getBalance(address);
                recentTxs = await network.getHistory(address, 10);
                consensus = 'established';
            }
        } catch (e) {
            console.error('Failed to update:', e);
        }
        render();
    });

    network.addTransactionListener((tx) => {
        recentTxs = [tx, ...recentTxs].slice(0, 10);
        render();
    }, [address]);

    return {
        element: el,
        cleanup: () => {
            removeConsensus();
            removeHead();
        },
    };
}
