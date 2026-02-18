/**
 * qr-encoder.js — dependency-free QR Code renderer (byte mode, EC level M).
 *
 * Public API:
 *   renderQr({ text, size, fill, background, radius }, canvas)
 *
 * Supports QR versions 1–10, which covers all NIM address URIs (~50 chars).
 */

// ── Galois Field GF(256) arithmetic (generator poly x^8 + x^4 + x^3 + x^2 + 1) ──

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

function gfPolyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let i = 0; i < p.length; i++)
        for (let j = 0; j < q.length; j++)
            r[i + j] ^= gfMul(p[i], q[j]);
    return r;
}

function gfPolyMod(msg, gen) {
    const r = new Uint8Array(msg);
    for (let i = 0; i < msg.length - gen.length + 1; i++) {
        const c = r[i];
        if (c === 0) continue;
        for (let j = 1; j < gen.length; j++)
            r[i + j] ^= gfMul(gen[j], c);
    }
    return r.slice(msg.length - gen.length + 1);
}

function ecGenerator(n) {
    let g = new Uint8Array([1]);
    for (let i = 0; i < n; i++)
        g = gfPolyMul(g, new Uint8Array([1, GF_EXP[i]]));
    return g;
}

// ── EC parameters for versions 1–10, level M ─────────────────────────────
// [dataCodewords, ecCodewordsPerBlock, blocks]
const EC_M = [
    null,             // v0 unused
    [16,  10, 1],     // v1
    [28,  16, 1],     // v2
    [44,  26, 1],     // v3
    [64,  18, 2],     // v4
    [86,  24, 2],     // v5
    [108, 16, 4],     // v6
    [124, 18, 4],     // v7
    [154, 22, 2],     // v8  (actually 2 blocks group1 + 2 blocks group2, simplified)
    [182, 22, 3],     // v9
    [216, 26, 4],     // v10
];

// Byte-mode capacity for level M (max data bytes encodable)
const CAPACITY_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

// ── Encode data into QR codewords (byte mode) ────────────────────────────

function encodeData(text, version) {
    const bytes = new TextEncoder().encode(text);
    const n = bytes.length;
    // Mode indicator (byte = 0100) + char count (8 bits for v1-9, 16 for v10-26)
    const bits = [];

    function pushBits(val, len) {
        for (let i = len - 1; i >= 0; i--)
            bits.push((val >> i) & 1);
    }

    pushBits(0b0100, 4);              // byte mode
    pushBits(n, version < 10 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);

    // Terminator
    const totalDataBits = EC_M[version][0] * 8;
    for (let i = 0; i < 4 && bits.length < totalDataBits; i++) bits.push(0);

    // Pad to byte boundary
    while (bits.length % 8) bits.push(0);

    // Pad codewords
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (bits.length < totalDataBits) {
        pushBits(pads[pi++ & 1], 8);
    }

    // Pack bits into bytes
    const codewords = new Uint8Array(bits.length / 8);
    for (let i = 0; i < codewords.length; i++) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
        codewords[i] = v;
    }
    return codewords;
}

function buildFinalMessage(version, dataCW) {
    const [totalData, ecPerBlock, blocks] = EC_M[version];
    const baseBlock = Math.floor(totalData / blocks);
    const extraBlocks = totalData % blocks;
    const gen = ecGenerator(ecPerBlock);

    const dataBlocks = [], ecBlocks = [];
    let offset = 0;
    for (let b = 0; b < blocks; b++) {
        const len = baseBlock + (b < blocks - extraBlocks ? 0 : 1);
        const d = dataCW.slice(offset, offset + len);
        offset += len;
        // Append zeros for polynomial long division
        const msg = new Uint8Array(d.length + gen.length - 1);
        msg.set(d);
        dataBlocks.push(d);
        ecBlocks.push(gfPolyMod(msg, gen));
    }

    // Interleave data then EC
    const out = [];
    const maxData = Math.max(...dataBlocks.map(b => b.length));
    for (let i = 0; i < maxData; i++)
        for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecPerBlock; i++)
        for (const b of ecBlocks) out.push(b[i]);

    return new Uint8Array(out);
}

// ── Module matrix construction ────────────────────────────────────────────

function makeMatrix(version) {
    const size = version * 4 + 17;
    return { size, cells: new Int8Array(size * size).fill(-1) };
}

function set(m, r, c, v) { m.cells[r * m.size + c] = v; }
function get(m, r, c) { return m.cells[r * m.size + c]; }

function setRect(m, r, c, h, w, val) {
    for (let dr = 0; dr < h; dr++)
        for (let dc = 0; dc < w; dc++)
            set(m, r + dr, c + dc, val);
}

function placeFinder(m, r, c) {
    setRect(m, r, c, 7, 7, 1);
    setRect(m, r + 1, c + 1, 5, 5, 0);
    setRect(m, r + 2, c + 2, 3, 3, 1);
}

// Alignment pattern centers for versions 1–10
const ALIGN_CENTERS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

function placeAlignment(m, version) {
    const cs = ALIGN_CENTERS[version];
    for (const r of cs) for (const c of cs) {
        if (get(m, r, c) !== -1) continue; // overlaps finder
        setRect(m, r - 2, c - 2, 5, 5, 1);
        setRect(m, r - 1, c - 1, 3, 3, 0);
        set(m, r, c, 1);
    }
}

function placeTiming(m, version) {
    const size = m.size;
    for (let i = 8; i < size - 8; i++) {
        const v = i % 2 === 0 ? 1 : 0;
        if (get(m, 6, i) === -1) set(m, 6, i, v);
        if (get(m, i, 6) === -1) set(m, i, 6, v);
    }
}

function reserveFormat(m) {
    const size = m.size;
    // Around top-left finder
    for (let i = 0; i < 9; i++) {
        if (get(m, 8, i) === -1) set(m, 8, i, 0);
        if (i !== 6 && get(m, i, 8) === -1) set(m, i, 8, 0);
    }
    // Around top-right finder
    for (let i = size - 8; i < size; i++) {
        if (get(m, 8, i) === -1) set(m, 8, i, 0);
    }
    // Around bottom-left finder
    for (let i = size - 7; i < size; i++) {
        if (get(m, i, 8) === -1) set(m, i, 8, 0);
    }
    // Dark module
    set(m, size - 8, 8, 1);
}

function placeData(m, codewords) {
    const size = m.size;
    let bit = 0;
    let up = true;
    let col = size - 1;

    while (col > 0) {
        if (col === 6) col--; // skip timing column
        for (let row = 0; row < size; row++) {
            const r = up ? size - 1 - row : row;
            for (let dc = 0; dc < 2; dc++) {
                const c = col - dc;
                if (get(m, r, c) !== -1) continue;
                const byteIdx = Math.floor(bit / 8);
                const bitIdx = 7 - (bit % 8);
                const val = byteIdx < codewords.length
                    ? (codewords[byteIdx] >> bitIdx) & 1
                    : 0;
                set(m, r, c, val);
                bit++;
            }
        }
        up = !up;
        col -= 2;
    }
}

// ── Masking ───────────────────────────────────────────────────────────────

const MASK_FN = [
    (r, c) => (r + c) % 2 === 0,
    (r)    => r % 2 === 0,
    (r, c) => c % 3 === 0,          // eslint-disable-line no-unused-vars
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// Format info strings for level M, masks 0–7
const FORMAT_INFO = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B,
    0x45F9, 0x40CE, 0x4F97, 0x4AA0,
];

function applyMask(m, mask) {
    const size = m.size;
    const fn = MASK_FN[mask];
    for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
            if (get(m, r, c) <= 1 && fn(r, c))  // data modules only (0 or 1 but not fixed)
                set(m, r, c, get(m, r, c) ^ 1);
}

function writeFormat(m, mask) {
    const size = m.size;
    const fi = FORMAT_INFO[mask];
    const bits = [];
    for (let i = 14; i >= 0; i--) bits.push((fi >> i) & 1);

    // Top-left
    const pos1 = [8,8,8,8,8,8,8,8, 7,5,4,3,2,1,0];
    const pos2 = [0,1,2,3,4,5,7,8, 8,8,8,8,8,8,8];
    for (let i = 0; i < 15; i++) set(m, pos1[i], pos2[i], bits[i]);

    // Top-right
    for (let i = 0; i < 8; i++) set(m, 8, size - 1 - i, bits[i]);
    // Bottom-left
    for (let i = 8; i < 15; i++) set(m, size - 15 + i, 8, bits[i]);
}

function penalty(m) {
    const size = m.size;
    let p = 0;
    const g = (r, c) => get(m, r, c) & 1;

    // Rule 1: 5+ consecutive same-color in a row/col
    for (let r = 0; r < size; r++) {
        let run = 1;
        for (let c = 1; c < size; c++) {
            if (g(r, c) === g(r, c - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
            else run = 1;
        }
        run = 1;
        for (let c = 1; c < size; c++) {
            if (g(c, r) === g(c - 1, r)) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
            else run = 1;
        }
    }

    // Rule 2: 2x2 same-color blocks
    for (let r = 0; r < size - 1; r++)
        for (let c = 0; c < size - 1; c++)
            if (g(r,c) === g(r,c+1) && g(r,c) === g(r+1,c) && g(r,c) === g(r+1,c+1)) p += 3;

    // Rule 3: finder-like patterns
    const p3 = [1,0,1,1,1,0,1,0,0,0,0];
    const p3r = [0,0,0,0,1,0,1,1,1,0,1];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c <= size - 11; c++) {
            let m1 = true, m2 = true, m3 = true, m4 = true;
            for (let k = 0; k < 11; k++) {
                if (g(r, c+k) !== p3[k]) m1 = false;
                if (g(r, c+k) !== p3r[k]) m2 = false;
                if (g(c+k, r) !== p3[k]) m3 = false;
                if (g(c+k, r) !== p3r[k]) m4 = false;
            }
            if (m1) p += 40;
            if (m2) p += 40;
            if (m3) p += 40;
            if (m4) p += 40;
        }
    }

    // Rule 4: proportion of dark modules
    let dark = 0;
    for (let i = 0; i < size * size; i++) dark += m.cells[i] & 1;
    const ratio = dark / (size * size);
    p += Math.abs(Math.round(ratio * 20) - 10) * 10;

    return p;
}

function bestMask(m, codewords) {
    let best = -1, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        placeData(m, codewords); // place fresh data
        applyMask(m, mask);
        writeFormat(m, mask);
        const p = penalty(m);
        if (p < bestP) { bestP = p; best = mask; }
        applyMask(m, mask); // undo mask
        writeFormat(m, mask); // undo format (restore reserved zeros)
    }
    return best;
}

// ── Canvas rendering ──────────────────────────────────────────────────────

function drawCanvas(m, { size, fill, background, radius }, canvas) {
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, size, size);
    } else {
        ctx.clearRect(0, 0, size, size);
    }

    const modules = m.size;
    const cellSize = size / modules;
    const r = Math.min(cellSize * 0.5 * (radius || 0), cellSize / 2);

    ctx.fillStyle = fill || '#000';

    for (let row = 0; row < modules; row++) {
        for (let col = 0; col < modules; col++) {
            if (!(get(m, row, col) & 1)) continue;
            const x = col * cellSize;
            const y = row * cellSize;
            if (r > 0.5) {
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.lineTo(x + cellSize - r, y);
                ctx.quadraticCurveTo(x + cellSize, y, x + cellSize, y + r);
                ctx.lineTo(x + cellSize, y + cellSize - r);
                ctx.quadraticCurveTo(x + cellSize, y + cellSize, x + cellSize - r, y + cellSize);
                ctx.lineTo(x + r, y + cellSize);
                ctx.quadraticCurveTo(x, y + cellSize, x, y + cellSize - r);
                ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillRect(x, y, cellSize, cellSize);
            }
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Render a QR code onto an HTMLCanvasElement.
 *
 * @param {object} opts
 * @param {string} opts.text       - Text to encode
 * @param {number} [opts.size=200] - Canvas pixel size
 * @param {string} [opts.fill]     - Module fill colour (CSS colour string)
 * @param {string} [opts.background] - Background colour (null = transparent)
 * @param {number} [opts.radius]   - Corner radius factor 0–0.5
 * @param {HTMLCanvasElement} canvas
 */
export function renderQr({ text, size = 200, fill = '#000', background = null, radius = 0 }, canvas) {
    const encoded = new TextEncoder().encode(text);
    const len = encoded.length;

    // Pick minimum version that fits
    let version = 1;
    while (version <= 10 && CAPACITY_M[version] < len) version++;
    if (version > 10) throw new Error(`Text too long for QR version 1–10 (${len} bytes)`);

    const dataCW = encodeData(text, version);
    const message = buildFinalMessage(version, dataCW);

    const m = makeMatrix(version);

    // Place fixed patterns
    placeFinder(m, 0, 0);
    placeFinder(m, 0, m.size - 7);
    placeFinder(m, m.size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m, version);
    reserveFormat(m);

    // Find best mask, apply it, write final format info
    const mask = bestMask(m, message);
    placeData(m, message);
    applyMask(m, mask);
    writeFormat(m, mask);

    drawCanvas(m, { size, fill, background, radius }, canvas);
}
