import { navigate } from '../router.js';

export function welcomeView() {
    const el = document.createElement('div');
    el.className = 'view-container';
    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1">Nimiq Wallet</h1>
                <p class="nq-text">A standalone wallet for the Nimiq blockchain</p>
            </div>
            <div class="nq-card-body welcome-body">
                <button class="nq-button light-blue" id="btn-create">Create New Wallet</button>
                <button class="nq-button-s" id="btn-import">Import Existing Wallet</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-create').addEventListener('click', () => navigate('#create'));
    el.querySelector('#btn-import').addEventListener('click', () => navigate('#import'));

    return el;
}
