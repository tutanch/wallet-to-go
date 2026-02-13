import { navigate } from '../router.js';
import { getStoredAddress } from '../modules/keyguard-api.js';

export async function receiveView() {
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
                <h1 class="nq-h1">Receive NIM</h1>
                <p class="nq-text">Share your address to receive NIM</p>
            </div>
            <div class="nq-card-body receive-body">
                <div id="qr-container"></div>
                <div class="address-display-large" id="address-copy" title="Click to copy">
                    <span class="address-text-large">${address}</span>
                </div>
                <button class="nq-button-s" id="btn-copy">Copy Address</button>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(address);
            const btn = el.querySelector('#btn-copy');
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy Address'; }, 1500);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });

    el.querySelector('#address-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(address);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });

    // Generate real QR code using qr-creator
    setTimeout(() => {
        const container = el.querySelector('#qr-container');
        if (container && typeof QrCreator !== 'undefined') {
            const canvas = document.createElement('canvas');
            QrCreator.render({
                text: `nimiq:${address.replace(/ /g, '')}`,
                radius: 0.4,
                ecLevel: 'M',
                fill: '#1F2348',
                background: '#ffffff',
                size: 200,
            }, canvas);
            canvas.id = 'qr-canvas';
            container.appendChild(canvas);
        }
    }, 0);

    return el;
}
