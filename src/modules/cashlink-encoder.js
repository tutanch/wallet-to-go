// Hub-compatible cashlink encoder/decoder.
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

// LINK marker — claiming TX extra data recognized by the Hub.
// Encodes "LINK" as [0x00, 'L'+63, 'I'+63, 'N'+63, 'K'+63].
export const CASHLINK_CLAIMING_DATA = [0, 139, 136, 141, 138];

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

/**
 * Decode a Hub cashlink URL back into its components.
 *
 * @param {string} url  Full cashlink URL
 * @returns {{ privateKeyBytes: Uint8Array, valueLuna: number, message: string }}
 */
export function decodeCashlink(url) {
    const hashIdx = url.lastIndexOf('#');
    if (hashIdx === -1) throw new Error('Invalid cashlink URL');
    let encoded = url.substring(hashIdx + 1);

    // Remove ~ chars (iPhone/WhatsApp compat inserted during encoding)
    encoded = encoded.replace(/~/g, '');

    const bytes = fromBase64Url(encoded);
    if (bytes.length < 40) throw new Error('Cashlink data too short');

    const privateKeyBytes = bytes.slice(0, 32);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const valueLuna = Number(view.getBigUint64(32));

    let message = '';
    if (bytes.length > 40) {
        const msgLen = bytes[40];
        if (bytes.length >= 41 + msgLen) {
            message = new TextDecoder().decode(bytes.slice(41, 41 + msgLen));
        }
    }

    return { privateKeyBytes, valueLuna, message };
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

/** Standard base64url decode (RFC 4648 §5). */
export function fromBase64Url(str) {
    const padded = str + '==='.slice((str.length + 3) % 4);
    const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(standard);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
