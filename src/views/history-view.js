import { navigate } from '../router.js';
import { getStoredAddress } from '../modules/key-store.js';
import * as network from '../modules/network-client.js';
import { formatNim } from '../config.js';

export async function historyView() {
    const address = await getStoredAddress();
    if (!address) {
        navigate('#welcome');
        return document.createElement('div');
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Transaction History</h1>
            </div>
            <div class="nq-card-body">
                <div class="tx-list" id="tx-list">
                    <p class="nq-text loading-text">Loading transactions...</p>
                </div>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    // Fetch transactions
    try {
        const txs = await network.getHistory(address, 50);
        const txList = el.querySelector('#tx-list');
        txList.innerHTML = '';

        if (txs.length === 0) {
            txList.innerHTML = '<p class="nq-text no-txs">No transactions found</p>';
        } else {
            txs.forEach(tx => {
                txList.appendChild(renderTxItem(tx, address));
            });
        }
    } catch (e) {
        const txList = el.querySelector('#tx-list');
        txList.innerHTML = `<p class="nq-text error-text">Failed to load: ${e.message}</p>`;
    }

    return el;
}

export function renderTxItem(tx, ownAddress) {
    const isSent = tx.sender === ownAddress;
    const counterparty = isSent ? tx.recipient : tx.sender;
    const shortAddr = counterparty
        ? counterparty.substring(0, 9) + '...' + counterparty.substring(counterparty.length - 4)
        : 'Unknown';

    const timestamp = tx.timestamp
        ? new Date(tx.timestamp * 1000).toLocaleString()
        : 'Pending';

    const state = tx.state === 'confirmed' ? '' : ` (${tx.state || 'pending'})`;

    const item = document.createElement('div');
    item.className = `tx-item ${isSent ? 'tx-sent' : 'tx-received'}`;
    item.innerHTML = `
        <div class="tx-direction">${isSent ? '&#x2191;' : '&#x2193;'}</div>
        <div class="tx-details">
            <span class="tx-address">${shortAddr}</span>
            <span class="tx-time">${timestamp}${state}</span>
        </div>
        <div class="tx-amount ${isSent ? 'amount-sent' : 'amount-received'}">
            ${isSent ? '-' : '+'}${formatNim(tx.value)} NIM
        </div>
    `;
    return item;
}
