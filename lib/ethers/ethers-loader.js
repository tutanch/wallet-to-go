/**
 * Loader for the vendored ethers.js v5.7.2 ESM build.
 *
 * Source: npm ethers@5.7.2, dist/ethers.esm.min.js (official single-file ESM build)
 * SHA-256: 08d4e51b6e59b4547abfc03e673477396dc927783622d8783cde949ca09a62b1
 *
 * Import lazily (`await import(...)`) — the bundle is ~550 KB and is only
 * needed for Polygon/stablecoin features, never on the NIM-only path.
 */
export { ethers } from './ethers.esm.min.js';
