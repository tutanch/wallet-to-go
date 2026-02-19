// Hub-compatible cashlink encoder.
// Binary format: [32 bytes private key][8 bytes value BE uint64][optional: 1 byte msg len + N bytes msg]
// URL: https://hub.nimiq.com/cashlink/#<base64url>

import { getSelectedNetwork } from '../config.js';

const HUB_URLS = {
    main: 'https://hub.nimiq.com/cashlink/#',
    test: 'https://hub.nimiq-testnet.com/cashlink/#',
};

// CASH marker — funding TX extra data recognized by the Hub.
// Encodes "CASH" as [0x00, 'C'+63, 'A'+63, 'S'+63, 'H'+63].
export const CASHLINK_FUNDING_DATA = [0, 130, 128, 146, 135];

/**
 * Encode a cashlink into a Hub-compatible URL.
 *
 * @param {Object} opts
 * @param {Uint8Array} opts.privateKeyBytes  32-byte Ed25519 private key
 * @param {number}     opts.valueLuna        Amount in luna (integer)
 * @param {string}     [opts.message]        Optional UTF-8 message (max 255 bytes)
 * @returns {string}   Full cashlink URL
 */
export function encodeCashlink({ privateKeyBytes, valueLuna, message }) {
    const msgBytes = message ? new TextEncoder().encode(message) : new Uint8Array(0);
    if (msgBytes.length > 255) throw new Error('Message exceeds 255 bytes');

    const hasOptional = msgBytes.length > 0;
    const size = 32 + 8 + (hasOptional ? 1 + msgBytes.length : 0);
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);

    // [0..31] Private key
    buf.set(privateKeyBytes, 0);

    // [32..39] Value in luna — big-endian uint64
    view.setBigUint64(32, BigInt(valueLuna));

    // [40..] Optional message
    if (hasOptional) {
        buf[40] = msgBytes.length;
        buf.set(msgBytes, 41);
    }

    const base = HUB_URLS[getSelectedNetwork()] || HUB_URLS.main;
    let encoded = toBase64Url(buf);

    // Insert ~ every 256 alphanumeric chars for iPhone/WhatsApp compat
    encoded = encoded.replace(/[A-Za-z0-9_-]{257,}/g,
        (match) => match.replace(/.{256}/g, '$&~'));

    return base + encoded;
}

/** Standard base64url encode (RFC 4648 §5, no padding). */
export function toBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
