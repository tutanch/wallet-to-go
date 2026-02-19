import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import { renderQr } from '../lib/qr-encoder.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';

export async function receiveView() {
    const defaultAddress = await getStoredAddress();
    if (!defaultAddress) {
        navigate('#welcome');
        return document.createElement('div');
    }

    // Use the active derived address
    const activeIdx = getActiveAddressIndex();
    let address = defaultAddress;
    try {
        const result = await getDerivedAddresses();
        if (result?.addresses?.[activeIdx]) {
            address = result.addresses[activeIdx].address;
        }
    } catch (_) {}

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
                    <span class="address-text-large" id="address-text"></span>
                </div>
                <button class="nq-button-s" id="btn-copy">Copy Address</button>
            </div>
            <div class="nq-card-footer">
                <button class="nq-button-s" id="btn-back">Back</button>
            </div>
        </div>
    `;

    el.querySelector('#address-text').textContent = address;

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    el.querySelector('#btn-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(address);
            const display = el.querySelector('#address-copy');
            display.classList.add('copied');
            showToast('Address copied!', 'success');
            setTimeout(() => display.classList.remove('copied'), 600);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });

    el.querySelector('#address-copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(address);
            const display = el.querySelector('#address-copy');
            display.classList.add('copied');
            showToast('Address copied!', 'success');
            setTimeout(() => display.classList.remove('copied'), 600);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    });

    // Generate QR code using native encoder
    setTimeout(() => {
        const container = el.querySelector('#qr-container');
        if (container) {
            const canvas = document.createElement('canvas');
            const styles = getComputedStyle(document.documentElement);
            const qrFill = styles.getPropertyValue('--color-qr-fill').trim() || '#1F2348';
            const qrBg = styles.getPropertyValue('--color-qr-bg').trim() || '#ffffff';
            renderQr({
                text: `nimiq:${address.replace(/ /g, '')}`,
                radius: 0.4,
                fill: qrFill,
                background: qrBg,
                size: 200,
            }, canvas);
            canvas.id = 'qr-canvas';
            container.appendChild(canvas);
        }
    }, 0);

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return { element: el, cleanup: cleanupSwipe };
}
