/**
 * QR vector suite — round-trips src/lib/qr-encoder.js output through a real
 * decoder (jsqr). Verifies the exact payload shapes the receive view encodes,
 * every segment mode, all 8 masks, all 4 ECC levels, and a version ladder up
 * to the v40 capacity limit. Runs in a one-shot Docker node container
 * (host npm forbidden). Run after ANY change to src/lib/qr-encoder.js.
 *
 * The suite expects the repo at /app inside the container:
 *   /app/src/lib/qr-encoder.js
 *   /app/verify/qr-vectors.js   (this file)
 *
 * Run (docker cp avoids host file-sharing requirements):
 *   docker create --name qr-verify -w /app node:24 bash -lc \
 *     "npm init -y >/dev/null && npm pkg set type=module && \
 *      npm install --no-audit --no-fund jsqr@1.4.0 >/dev/null && \
 *      node verify/qr-vectors.js"
 *   docker cp <repo>/. qr-verify:/app && docker start -a qr-verify
 *   docker rm qr-verify
 *
 * Decoding uses inversionAttempts:'dontInvert' so the suite also asserts
 * correct polarity (dark modules on light background) — plain scanners that
 * never try inverted codes must succeed.
 */

import { QrCode, QrSegment, Ecc } from '../src/lib/qr-encoder.js';

const jsQRmod = await import('jsqr');
const jsQR = jsQRmod.default ?? jsQRmod;

// Mirrors renderQr() geometry: quiet zone of 4 light modules, square cells.
function rasterize(qr, scale = 4, border = 4) {
    const total = (qr.size + border * 2) * scale;
    const rgba = new Uint8ClampedArray(total * total * 4);
    rgba.fill(255);  // light background, opaque
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (!qr.getModule(x, y)) continue;
            for (let dy = 0; dy < scale; dy++) {
                const rowStart = (((y + border) * scale + dy) * total + (x + border) * scale) * 4;
                for (let dx = 0; dx < scale; dx++) {
                    rgba[rowStart + dx * 4] = 0;
                    rgba[rowStart + dx * 4 + 1] = 0;
                    rgba[rowStart + dx * 4 + 2] = 0;
                }
            }
        }
    }
    return { rgba, width: total, height: total };
}

function decode(qr) {
    const { rgba, width, height } = rasterize(qr);
    return jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
}

let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}\n    ${e.message}`);
    }
}

function expectRoundTrip(qr, expectedBytes, label) {
    const dec = decode(qr);
    if (!dec) throw new Error(`${label}: decoder returned null (v${qr.version}, mask ${qr.mask})`);
    const got = dec.binaryData;
    if (got.length !== expectedBytes.length)
        throw new Error(`${label}: byte length ${got.length} != ${expectedBytes.length}`);
    for (let i = 0; i < got.length; i++) {
        if (got[i] !== expectedBytes[i])
            throw new Error(`${label}: byte mismatch at ${i}: ${got[i]} != ${expectedBytes[i]}`);
    }
}

function expectTextRoundTrip(text, ecl, label) {
    const qr = QrCode.encodeText(text, ecl);
    expectRoundTrip(qr, Array.from(new TextEncoder().encode(text)), label);
    return qr;
}

// Deterministic printable-ASCII payloads (LCG, no randomness between runs)
let lcg = 42;
function nextByte() {
    lcg = (lcg * 1103515245 + 12345) & 0x7fffffff;
    return 0x20 + (lcg % 95);  // printable ASCII 0x20..0x7E
}
function payload(len) {
    // 'x~' prefix forces byte mode regardless of what the LCG produces
    let s = 'x~';
    while (s.length < len) s += String.fromCharCode(nextByte());
    return s.slice(0, len);
}

console.log('— Wallet payloads (shapes the receive view encodes) —');

const NIM_ADDRESS = 'NQ48 LS6P G3RQ VCAL SDFE 5S5K FFQ8 AGRT 7DM4';
const NIM_URI = `nimiq:${NIM_ADDRESS.replace(/ /g, '')}`;
const POLYGON_ADDRESS = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';

check('nimiq: URI (byte mode, ECC M boosted)', () => {
    const qr = expectTextRoundTrip(NIM_URI, Ecc.MEDIUM, 'nimiq URI');
    const dec = decode(qr);
    if (dec.data !== NIM_URI) throw new Error(`text mismatch: ${dec.data}`);
});

check('bare NQ address (alphanumeric mode)', () => {
    const bare = NIM_ADDRESS.replace(/ /g, '');
    const segs = QrSegment.makeSegments(bare);
    if (segs[0].mode.modeBits !== 0x2) throw new Error('expected alphanumeric mode');
    expectTextRoundTrip(bare, Ecc.MEDIUM, 'NQ address');
});

check('polygon 0x address (byte mode)', () => {
    expectTextRoundTrip(POLYGON_ADDRESS, Ecc.MEDIUM, 'polygon address');
});

console.log('— Segment modes —');

check('numeric mode', () => {
    const text = '31415926535897932384626433832795';
    const segs = QrSegment.makeSegments(text);
    if (segs[0].mode.modeBits !== 0x1) throw new Error('expected numeric mode');
    const qr = expectTextRoundTrip(text, Ecc.MEDIUM, 'numeric');
    const dec = decode(qr);
    if (dec.data !== text) throw new Error(`text mismatch: ${dec.data}`);
});

check('alphanumeric mode incl. full charset', () => {
    const text = 'HELLO WORLD $%*+-./: 0123456789 ABCXYZ';
    const segs = QrSegment.makeSegments(text);
    if (segs[0].mode.modeBits !== 0x2) throw new Error('expected alphanumeric mode');
    expectTextRoundTrip(text, Ecc.MEDIUM, 'alphanumeric');
});

check('UTF-8 multibyte (byte mode)', () => {
    expectTextRoundTrip('Größe: 50 NIM für 🦊 — ümlaut', Ecc.MEDIUM, 'utf-8');
});

check('raw binary 0x00..0xFF (encodeBinary)', () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i);
    const qr = QrCode.encodeBinary(bytes, Ecc.QUARTILE);
    expectRoundTrip(qr, bytes, 'binary');
});

console.log('— All 8 masks (forced) —');

for (let m = 0; m < 8; m++) {
    check(`mask ${m}`, () => {
        const segs = QrSegment.makeSegments(NIM_URI);
        const qr = QrCode.encodeSegments(segs, Ecc.MEDIUM, 1, 40, m, false);
        if (qr.mask !== m) throw new Error(`mask is ${qr.mask}`);
        expectRoundTrip(qr, Array.from(new TextEncoder().encode(NIM_URI)), `mask ${m}`);
    });
}

console.log('— ECC levels pinned (boostEcl off) —');

const ECLS = [['L', Ecc.LOW], ['M', Ecc.MEDIUM], ['Q', Ecc.QUARTILE], ['H', Ecc.HIGH]];
for (const [name, ecl] of ECLS) {
    for (const len of [20, 120, 500]) {
        check(`ECC ${name}, ${len} bytes`, () => {
            const text = payload(len);
            const segs = QrSegment.makeSegments(text);
            const qr = QrCode.encodeSegments(segs, ecl, 1, 40, -1, false);
            if (qr.errorCorrectionLevel.ordinal !== ecl.ordinal)
                throw new Error(`ECC ordinal ${qr.errorCorrectionLevel.ordinal} != ${ecl.ordinal}`);
            expectRoundTrip(qr, Array.from(new TextEncoder().encode(text)), `ECC ${name}/${len}`);
        });
    }
}

console.log('— Version ladder (byte mode, ECC L, up to v40 capacity) —');

const versionsSeen = new Set();
const lengths = [];
for (let len = 3; len <= 2953; len = Math.max(len + 1, Math.ceil(len * 1.2)))
    lengths.push(len);
lengths.push(2953);  // exact v40-L byte capacity

for (const len of lengths) {
    check(`${len} bytes`, () => {
        const text = payload(len);
        const segs = QrSegment.makeSegments(text);
        const qr = QrCode.encodeSegments(segs, Ecc.LOW, 1, 40, -1, false);
        versionsSeen.add(qr.version);
        expectRoundTrip(qr, Array.from(new TextEncoder().encode(text)), `ladder ${len}`);
    });
}

check('ladder hit v40 at exactly 2953 bytes', () => {
    const segs = QrSegment.makeSegments(payload(2953));
    const qr = QrCode.encodeSegments(segs, Ecc.LOW, 1, 40, -1, false);
    if (qr.version !== 40) throw new Error(`version ${qr.version} != 40`);
});

check('ladder covered a wide version range', () => {
    if (versionsSeen.size < 20 || !versionsSeen.has(1) || !versionsSeen.has(40))
        throw new Error(`covered: ${[...versionsSeen].sort((a, b) => a - b).join(',')}`);
});

check('oversized payload throws "Data too long"', () => {
    let threw = false;
    try {
        QrCode.encodeText(payload(2954), Ecc.LOW);
    } catch (e) {
        threw = /Data too long/.test(e.message);
    }
    if (!threw) throw new Error('did not throw');
});

console.log(`\nVersions exercised: ${[...versionsSeen].sort((a, b) => a - b).join(', ')}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('ALL QR VECTORS OK');
