/**
 * Loader for the vendored ethers.js v5.7.2 ESM build (keyguard origin copy).
 *
 * Source: npm ethers@5.7.2, dist/ethers.esm.min.js (official single-file ESM build)
 * SHA-256: 08d4e51b6e59b4547abfc03e673477396dc927783622d8783cde949ca09a62b1
 *
 * Import lazily (`await import(...)`) from the keyguard worker only — the
 * bundle is ~550 KB and is only needed for Polygon signing, never for NIM.
 */
export { ethers } from './ethers.esm.min.js';
