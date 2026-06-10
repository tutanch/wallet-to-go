import { navigate } from '../router.js';
import { getStoredAddress, getDerivedAddresses, getPolygonAddress } from '../modules/keyguard-api.js';
import { getActiveAddressIndex } from './dashboard-view.js';
import { renderQr } from '../lib/qr-encoder.js';
import { showToast } from '../modules/toast.js';
import { enableSwipeBack } from '../modules/gestures.js';
import { isStablecoinsEnabled } from '../config.js';

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

    // Stablecoin receive: only on mainnet with Polygon activated
    let polygonAddress = null;
    if (isStablecoinsEnabled()) {
        try {
            polygonAddress = (await getPolygonAddress())?.address || null;
        } catch (_) {}
    }

    const el = document.createElement('div');
    el.className = 'view-container';

    const assetPills = polygonAddress ? `
        <div class="asset-toggle" id="receive-toggle">
            <button class="nq-button-s selected" data-asset="nim">NIM</button>
            <button class="nq-button-s" data-asset="polygon">USDC / USDT</button>
        </div>` : '';

    el.innerHTML = `
        <div class="nq-card">
            <div class="nq-card-header">
                <h1 class="nq-h1" id="receive-title">Receive NIM</h1>
                <p class="nq-text" id="receive-subtitle">Share your address to receive NIM</p>
                ${assetPills}
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

    let activeAsset = 'nim';
    const displayedAddress = () => (activeAsset === 'nim' ? address : polygonAddress);

    function drawQr() {
        const container = el.querySelector('#qr-container');
        if (!container) return;
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        const styles = getComputedStyle(document.documentElement);
        const qrFill = styles.getPropertyValue('--color-qr-fill').trim() || '#1F2348';
        const qrBg = styles.getPropertyValue('--color-qr-bg').trim() || '#ffffff';
        renderQr({
            text: activeAsset === 'nim'
                ? `nimiq:${address.replace(/ /g, '')}`
                : polygonAddress, // raw 0x address — broadly scannable
            radius: 0.4,
            fill: qrFill,
            background: qrBg,
            size: 200,
        }, canvas);
        canvas.id = 'qr-canvas';
        container.appendChild(canvas);
    }

    function renderAsset() {
        el.querySelector('#address-text').textContent = displayedAddress();
        if (activeAsset === 'nim') {
            el.querySelector('#receive-title').textContent = 'Receive NIM';
            el.querySelector('#receive-subtitle').textContent = 'Share your address to receive NIM';
        } else {
            el.querySelector('#receive-title').textContent = 'Receive USDC / USDT';
            el.querySelector('#receive-subtitle').textContent = 'Only send USDC or USDT on Polygon to this address.';
        }
        drawQr();
    }

    if (polygonAddress) {
        el.querySelector('#receive-toggle').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-asset]');
            if (!btn || btn.dataset.asset === activeAsset) return;
            activeAsset = btn.dataset.asset;
            el.querySelectorAll('#receive-toggle [data-asset]').forEach((b) => {
                b.classList.toggle('selected', b.dataset.asset === activeAsset);
            });
            renderAsset();
        });
    }

    el.querySelector('#btn-back').addEventListener('click', () => navigate('#dashboard'));

    async function copyAddress() {
        try {
            await navigator.clipboard.writeText(displayedAddress());
            const display = el.querySelector('#address-copy');
            display.classList.add('copied');
            showToast('Address copied!', 'success');
            setTimeout(() => display.classList.remove('copied'), 600);
        } catch {
            // Clipboard API may fail without HTTPS or permissions
        }
    }

    el.querySelector('#btn-copy').addEventListener('click', copyAddress);
    el.querySelector('#address-copy').addEventListener('click', copyAddress);

    el.querySelector('#address-text').textContent = address;

    // Generate QR code using native encoder
    setTimeout(drawQr, 0);

    const cleanupSwipe = enableSwipeBack(el, () => navigate('#dashboard'));
    return { element: el, cleanup: cleanupSwipe };
}
