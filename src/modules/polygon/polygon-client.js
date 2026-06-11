/**
 * Polygon JSON-RPC client singleton (read-only provider + contract instances).
 *
 * Uses the keyless public endpoints from POLYGON.rpcUrls with a simple
 * fallback: when a request fails with a network-level error, the active
 * endpoint is flipped and the call retried once. eth_getLogs queries are
 * chunked to the public endpoints' block-range cap (see safeGetLogs).
 *
 * ethers is loaded lazily — this module must only be imported dynamically
 * from stablecoin code paths.
 */

import { POLYGON } from '../../config.js';
import {
    USDC_TOKEN_ABI,
    USDT_TOKEN_ABI,
    USDC_TRANSFER_ABI,
    USDT_TRANSFER_ABI,
    RELAY_HUB_ABI,
    UNISWAP_QUOTER_ABI,
} from './polygon-abis.js';

let ethersPromise = null;
let rpcIndex = 0;
let provider = null;
let contracts = null;

export function getEthers() {
    if (!ethersPromise) {
        ethersPromise = import('../../../lib/ethers/ethers-loader.js').then((mod) => mod.ethers);
    }
    return ethersPromise;
}

// ── Global request throttle ────────────────────────────────────────────────
// Public keyless RPCs rate-limit hard (HTTP 429). Serialize every Polygon RPC
// request through a shared minimum-interval gate so retries can never turn into
// a request storm. ethers routes ALL calls through provider.send, so wrapping
// it (below) is the single chokepoint covering getLogs, eth_call, getBlock, etc.
const RPC_MIN_INTERVAL_MS = 150;
let rpcGateChain = Promise.resolve();
let lastRpcAt = 0;
function rpcGate() {
    const next = rpcGateChain.then(async () => {
        const wait = RPC_MIN_INTERVAL_MS - (Date.now() - lastRpcAt);
        if (wait > 0) await sleep(wait);
        lastRpcAt = Date.now();
    });
    rpcGateChain = next.catch(() => {}); // never let the chain reject-forever
    return next;
}

async function buildProvider() {
    const ethers = await getEthers();
    // StaticJsonRpcProvider skips repeated eth_chainId detection roundtrips
    const p = new ethers.providers.StaticJsonRpcProvider(
        POLYGON.rpcUrls[rpcIndex],
        { name: 'matic', chainId: POLYGON.chainId },
    );
    // Throttle every request through the shared gate (see above).
    const send = p.send.bind(p);
    p.send = async (method, params) => { await rpcGate(); return send(method, params); };
    return p;
}

export async function getProvider() {
    if (!provider) {
        provider = await buildProvider();
        contracts = null;
    }
    return provider;
}

// Flip to the next RPC endpoint (round-robin) and rebuild provider/contracts
async function switchRpc() {
    rpcIndex = (rpcIndex + 1) % POLYGON.rpcUrls.length;
    console.warn(`Polygon RPC switched to ${POLYGON.rpcUrls[rpcIndex]}`);
    provider = await buildProvider();
    contracts = null;
}

function isNetworkError(error, depth = 0) {
    if (!error || depth > 4) return false;
    const code = error.code;
    if (code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT') return true;
    if (error instanceof TypeError) return true; // fetch() network failure
    // ethers v5 mislabels a transport failure on a read (no/garbled RPC
    // response) as CALL_EXCEPTION with data="0x" and the real cause nested in
    // error.error. A read like balanceOf cannot genuinely revert, so a
    // data-less CALL_EXCEPTION wrapping a network error is a flaky endpoint to
    // rotate past, NOT a real revert. (A genuine revert carries revert data.)
    if (code === 'CALL_EXCEPTION' && (error.data === '0x' || error.data == null)) {
        return isNetworkError(error.error, depth + 1);
    }
    return false;
}

/**
 * Run fn(provider), rotating through ALL configured endpoints on
 * network-level errors. Contract reverts etc. are NOT retried.
 */
export async function withRpcFallback(fn) {
    let lastError;
    for (let attempt = 0; attempt < POLYGON.rpcUrls.length; attempt++) {
        try {
            return await fn(await getProvider()); // eslint-disable-line no-await-in-loop
        } catch (error) {
            if (!isNetworkError(error)) throw error;
            lastError = error;
            await switchRpc(); // eslint-disable-line no-await-in-loop
        }
    }
    throw lastError;
}

export async function getContracts() {
    if (contracts) return contracts;
    const [ethers, prov] = [await getEthers(), await getProvider()];
    contracts = {
        usdcToken: new ethers.Contract(POLYGON.usdc.tokenContract, USDC_TOKEN_ABI, prov),
        usdtToken: new ethers.Contract(POLYGON.usdt.tokenContract, USDT_TOKEN_ABI, prov),
        usdcTransfer: new ethers.Contract(POLYGON.usdc.transferContract, USDC_TRANSFER_ABI, prov),
        usdtTransfer: new ethers.Contract(POLYGON.usdt.transferContract, USDT_TRANSFER_ABI, prov),
        relayHub: new ethers.Contract(POLYGON.relayHubContract, RELAY_HUB_ABI, prov),
        quoter: new ethers.Contract(POLYGON.uniswapQuoterContract, UNISWAP_QUOTER_ABI, prov),
    };
    return contracts;
}

let blockNumberCache = { value: 0, ts: 0 };

export async function getBlockNumber() {
    if (Date.now() - blockNumberCache.ts < 5000) return blockNumberCache.value;
    const value = await withRpcFallback((prov) => prov.getBlockNumber());
    blockNumberCache = { value, ts: Date.now() };
    return value;
}

/**
 * Fetch both stablecoin balances in token base units (6 decimals).
 * Values fit safely in a JS Number (up to ~9e9 tokens).
 */
export async function getStablecoinBalances(address) {
    // Contracts resolved per attempt — instances captured before the retry
    // loop would stay bound to the failed provider after an RPC switch.
    const [usdc, usdt] = await withRpcFallback(async () => {
        const { usdcToken, usdtToken } = await getContracts();
        return Promise.all([
            usdcToken.balanceOf(address),
            usdtToken.balanceOf(address),
        ]);
    });
    return { usdc: usdc.toNumber(), usdt: usdt.toNumber() };
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isRateLimited(error) {
    const status = error?.status ?? error?.error?.status ?? error?.error?.error?.status;
    if (status === 429) return true;
    const msg = `${error?.message || ''} ${error?.error?.message || ''} ${error?.body || ''}`;
    return /\b429\b|too many requests|rate.?limit/i.test(msg);
}

// Only a genuine result-set/range-cap error should shrink the window. A 429
// must NOT (shrinking makes more requests and amplifies the rate-limit).
function isRangeTooLarge(error) {
    const msg = `${error?.message || ''} ${error?.error?.message || ''}`;
    return /more than .*results|block range|range is too|query returned more than|response size|limit exceeded|exceed(s|ed)? maximum/i.test(msg);
}

/**
 * queryFilter over an arbitrary block range, chunked to the public RPC cap.
 * Per chunk, every endpoint is tried (public RPCs rate-limit getLogs
 * intermittently); only when all endpoints fail is the window halved
 * (range-cap errors). Floor: 2000 blocks. Port of the original
 * safeQueryFilter with the skipped-tail-after-halving bug fixed.
 *
 * Takes the contract NAME (key of getContracts()) so each retry binds to the
 * currently active provider — passed instances would go stale on RPC switch.
 */
export async function safeGetLogs(contractName, makeFilter, fromBlock, toBlock) {
    const NO_LOG_LIMIT_BLOCK_RANGE = 2000;
    const allEvents = [];
    let currentRange = Math.min(POLYGON.rpcMaxBlockRange, Math.max(toBlock - fromBlock, 1));
    let currentStart = fromBlock;
    let backoffs = 0;

    while (currentStart <= toBlock) {
        const currentEnd = Math.min(currentStart + currentRange, toBlock);
        let endpointTries = 0;

        // eslint-disable-next-line no-await-in-loop
        while (true) { // eslint-disable-line no-constant-condition
            const contract = (await getContracts())[contractName]; // eslint-disable-line no-await-in-loop
            try {
                // eslint-disable-next-line no-await-in-loop
                const chunk = await contract.queryFilter(makeFilter(contract), currentStart, currentEnd);
                allEvents.push(...chunk);
                currentStart = currentEnd + 1;
                break;
            } catch (error) {
                // Client-side errors (bad filter args etc.) — no retry helps
                if (error?.code === 'INVALID_ARGUMENT') throw error;
                endpointTries += 1;
                // Try the next endpoint first (the global throttle spaces these).
                if (endpointTries < POLYGON.rpcUrls.length) {
                    await switchRpc(); // eslint-disable-line no-await-in-loop
                    continue;
                }
                endpointTries = 0;
                // Genuine "range too large" — shrink the window and retry.
                if (isRangeTooLarge(error) && currentRange > NO_LOG_LIMIT_BLOCK_RANGE) {
                    currentRange = Math.floor(currentRange / 2);
                    console.warn(`safeGetLogs: halving range to ${currentRange} blocks`, error?.message || error);
                    await sleep(300); // eslint-disable-line no-await-in-loop
                    break; // recompute currentEnd with the smaller range
                }
                // Rate-limited / transient across all endpoints: back off and
                // retry the SAME window (exponential, capped). Shrinking here
                // would make MORE requests and amplify the 429s. History is
                // non-critical, so give up after a few rounds rather than hammer.
                if (backoffs < 5 && (isRateLimited(error) || error?.code === 'SERVER_ERROR' || error?.code === 'TIMEOUT')) {
                    const delay = Math.min(1000 * 2 ** backoffs, 15000);
                    backoffs += 1;
                    console.warn(`safeGetLogs: backing off ${delay}ms (rate-limited / transient)`);
                    await sleep(delay); // eslint-disable-line no-await-in-loop
                    break; // retry the same window after the backoff
                }
                console.error('safeGetLogs: giving up.', currentStart, currentEnd, error?.message || error);
                throw error;
            }
        }
    }

    return allEvents;
}
