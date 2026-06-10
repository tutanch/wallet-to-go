/**
 * Live fee-pipeline dry run (no funds involved): relay discovery, on-chain
 * Uniswap quoter pricing, and the full fee calculation for USDC + USDT
 * against Polygon mainnet.
 *
 * Layout inside the container:
 *   /app/src/config.js, /app/src/modules/polygon/*   (wallet modules)
 *   /app/lib/ethers/*                                 (vendored ethers)
 *   /app/src/modules/keyguard-api.js                  (stub — see below)
 *   /app/work/fee-dryrun.js                           (this file; cwd)
 *
 * Stub /app/src/modules/keyguard-api.js with:
 *   export function signPolygonTransaction() { throw new Error('harness'); }
 *   export function getPolygonAddress() { return { address: null }; }
 *   export function activatePolygon() { throw new Error('harness'); }
 *
 * Run:
 *   docker create --name fee-dryrun -w /app/work node:24 bash -c \
 *     "npm init -y && npm pkg set type=module && node fee-dryrun.js"
 *   docker cp <staged-tree>/. fee-dryrun:/app && docker start -a fee-dryrun
 */

// Node-only shim: ethers' browser build passes referrer:'client' (valid in
// browsers) which node's undici rejects.
const origFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
    const { referrer, ...rest } = init;
    return origFetch(url, rest);
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { calculateFee, getFeePoolAddress } = await import('/app/src/modules/polygon/gsn-fee.js');

for (const token of ['usdc', 'usdt']) {
    const t0 = Date.now();
    const { fee, chainTokenFee, gasPrice, gasLimit, relay } = await calculateFee(token);
    console.log(`--- ${token.toUpperCase()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log('  relay:', relay.url, 'pct:', relay.pctRelayFee.toString(), 'base:', relay.baseRelayFee.toString());
    console.log('  gasLimit:', gasLimit.toString(), ' gasPrice (gwei):', gasPrice.div(1e9).toString());
    console.log('  chainTokenFee (POL):', (Number(chainTokenFee.toString()) / 1e18).toFixed(6));
    console.log('  fee:', (fee.toNumber() / 1e6).toFixed(6), token.toUpperCase());
    console.log('  feePool:', await getFeePoolAddress(token));
    if (fee.toNumber() <= 0 || fee.toNumber() > 5000000) {
        throw new Error('fee out of plausible range (0, 5.0]');
    }
}
console.log('FEE DRY RUN PASSED');
