/**
 * OpenGSN v2 relay client: discovery, ping, and relayed-transaction POST.
 *
 * Discovery strategy (adapted from the original wallet's OpenGSN.ts for
 * keyless public RPCs): ping the known relay URLs from config first, then
 * source their fees from RelayServerRegistered events on the RelayHub.
 * Relays re-register in bursts (sometimes with hours-long gaps), so the
 * event scan goes deeper than the original's 1-hour window and falls back
 * to a targeted per-relayManager scan.
 *
 * Only relays whose origin is in POLYGON.allowedRelayOrigins are contacted —
 * this mirrors the CSP connect-src allowlist in index.html, which would
 * block other origins anyway.
 */

import { POLYGON } from '../../config.js';
import {
    getEthers,
    getProvider,
    getBlockNumber,
    safeGetLogs,
    withRpcFallback,
} from './polygon-client.js';

// From the original wallet (OpenGSN.ts): acceptable fee bounds
const MAX_PCT_RELAY_FEE = 70;
const MAX_BASE_RELAY_FEE = 0;

// Registration scan windows (Polygon: 2s blocks)
const RELAY_SCAN_SHALLOW = 45000; // ~25 hours
const RELAY_SCAN_DEEP = 302400; // ~7 days
const RELAY_CACHE_KEY = 'polygon-relay-cache';
const RELAY_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function isAllowedRelayUrl(url) {
    try {
        return POLYGON.allowedRelayOrigins.includes(new URL(url).origin);
    } catch (_) {
        return false;
    }
}

/**
 * Ping a relay's /getaddr endpoint.
 * @returns {Promise<object|null>} the relay info JSON, or null on failure
 */
export async function getRelayAddr(url, paymaster, abortSignal) {
    if (!isAllowedRelayUrl(url)) return null;
    const paymasterSuffix = paymaster ? `?paymaster=${paymaster}` : '';
    try {
        const response = await fetch(`${url}/getaddr${paymasterSuffix}`, { signal: abortSignal });
        if (!response.ok) return null;
        return await response.json();
    } catch (_) {
        return null;
    }
}

function readRelayCache() {
    try {
        const raw = localStorage.getItem(RELAY_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts > RELAY_CACHE_TTL) return null;
        if (!isAllowedRelayUrl(cached.url)) return null;
        return cached;
    } catch (_) {
        return null;
    }
}

function writeRelayCache(relay) {
    try {
        localStorage.setItem(RELAY_CACHE_KEY, JSON.stringify({
            url: relay.url,
            baseRelayFee: relay.baseRelayFee.toString(),
            pctRelayFee: relay.pctRelayFee.toString(),
            ts: Date.now(),
        }));
    } catch (_) { /* storage unavailable (e.g. test harness) */ }
}

/**
 * Find the newest RelayServerRegistered event per relay URL.
 * @returns {Promise<Map<string, {baseRelayFee, pctRelayFee, relayManagerAddress}>>}
 */
async function getRegistrationFees(fromBlock, toBlock, relayManagerAddress) {
    const events = await safeGetLogs(
        'relayHub',
        (relayHub) => relayHub.filters.RelayServerRegistered(relayManagerAddress || null),
        fromBlock,
        toBlock,
    );
    const byUrl = new Map();
    for (const event of events) {
        if (!event.args || event.args.length !== 4) continue;
        const [manager, baseRelayFee, pctRelayFee, url] = event.args;
        try {
            new URL(url); // eslint-disable-line no-new
        } catch (_) {
            continue; // invalid relay URL
        }
        const existing = byUrl.get(url);
        if (!existing || event.blockNumber > existing.blockNumber) {
            byUrl.set(url, {
                baseRelayFee,
                pctRelayFee,
                relayManagerAddress: manager,
                blockNumber: event.blockNumber,
            });
        }
    }
    return byUrl;
}

/**
 * Find a ready relay with acceptable fees.
 *
 * @param {object} requiredMaxAcceptanceBudget BigNumber — the paymaster's
 *        acceptance budget incl. calldata gas cost; the relay must accept it.
 * @returns {Promise<{url, relayWorkerAddress, relayManagerAddress, baseRelayFee, pctRelayFee, minGasPrice}>}
 */
export async function findRelay(requiredMaxAcceptanceBudget) {
    const ethers = await getEthers();

    // 1. Ping all configured relays in parallel (cached one first in order)
    const cached = readRelayCache();
    const urls = [...new Set([
        ...(cached ? [cached.url] : []),
        ...POLYGON.fallbackRelayUrls,
    ])].filter(isAllowedRelayUrl);

    const pings = await Promise.all(urls.map(async (url) => ({
        url,
        addr: await getRelayAddr(url),
    })));

    const ready = pings.filter(({ addr }) => {
        if (!addr || !addr.ready) return false;
        if (!String(addr.version).startsWith('2.')) return false;
        if (addr.networkId !== String(POLYGON.chainId)) return false;
        if (ethers.BigNumber.from(addr.maxAcceptanceBudget).lt(requiredMaxAcceptanceBudget)) return false;
        return true;
    });

    if (!ready.length) throw new Error('No GSN relay available');

    // 2. Source fees from registration events (shallow scan, then targeted deep scan)
    const head = await getBlockNumber();
    let fees = await getRegistrationFees(head - RELAY_SCAN_SHALLOW, head);

    const candidates = [];
    for (const { url, addr } of ready) {
        let fee = fees.get(url);
        if (!fee) {
            // Targeted deep scan: filter by this relay's manager (indexed topic)
            const deepFees = await getRegistrationFees( // eslint-disable-line no-await-in-loop
                head - RELAY_SCAN_DEEP,
                head - RELAY_SCAN_SHALLOW,
                addr.relayManagerAddress,
            );
            fee = deepFees.get(url);
        }
        if (!fee) {
            console.warn(`GSN relay ${url}: no registration event found, skipping`);
            continue;
        }
        candidates.push({
            url,
            relayWorkerAddress: addr.relayWorkerAddress,
            relayManagerAddress: addr.relayManagerAddress,
            baseRelayFee: fee.baseRelayFee,
            pctRelayFee: fee.pctRelayFee,
            minGasPrice: ethers.BigNumber.from(addr.minGasPrice),
        });
    }

    if (!candidates.length) throw new Error('No registered GSN relay found');

    // 3. Prefer relays within the fee bounds, otherwise cheapest
    const acceptable = candidates.filter((relay) => relay.pctRelayFee.lte(MAX_PCT_RELAY_FEE)
        && relay.baseRelayFee.lte(MAX_BASE_RELAY_FEE));
    const pool = acceptable.length ? acceptable : candidates;
    pool.sort((a, b) => {
        if (!a.baseRelayFee.eq(b.baseRelayFee)) return a.baseRelayFee.lt(b.baseRelayFee) ? -1 : 1;
        if (!a.pctRelayFee.eq(b.pctRelayFee)) return a.pctRelayFee.lt(b.pctRelayFee) ? -1 : 1;
        return 0;
    });

    const best = pool[0];
    writeRelayCache(best);
    return best;
}

/**
 * Re-ping a relay and refresh its volatile fields (minGasPrice, worker).
 * Throws if the relay is no longer usable.
 */
export async function refreshRelay(relay, requiredMaxAcceptanceBudget) {
    const ethers = await getEthers();
    const addr = await getRelayAddr(relay.url);
    if (!addr || !addr.ready) throw new Error('GSN relay is not ready');
    if (addr.networkId !== String(POLYGON.chainId)) throw new Error('GSN relay on wrong network');
    if (ethers.BigNumber.from(addr.maxAcceptanceBudget).lt(requiredMaxAcceptanceBudget)) {
        throw new Error('GSN relay acceptance budget too low');
    }
    return {
        ...relay,
        relayWorkerAddress: addr.relayWorkerAddress,
        relayManagerAddress: addr.relayManagerAddress,
        minGasPrice: ethers.BigNumber.from(addr.minGasPrice),
    };
}

/**
 * POST the signed relay request to the relay and return the signed
 * transaction it produced (hex string), after sanity checks.
 */
export async function relayTransaction(url, relayRequest, signature) {
    if (!isAllowedRelayUrl(url)) throw new Error('Relay URL not in allowlist');
    const ethers = await getEthers();

    const relayWorkerNonce = await withRpcFallback(
        (provider) => provider.getTransactionCount(relayRequest.relayData.relayWorker),
    );

    const response = await fetch(`${url}/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            relayRequest,
            metadata: {
                approvalData: '0x',
                relayHubAddress: POLYGON.relayHubContract,
                relayMaxNonce: relayWorkerNonce + 3,
                signature,
            },
        }),
    });
    if (!response.ok) throw new Error(`Relay responded with HTTP ${response.status}`);

    const { signedTx, error } = await response.json();
    if (error) throw new Error(`Relay error: ${error}`);
    if (!signedTx) throw new Error('Relay response is missing signedTx');

    // The relay must have produced a transaction to the RelayHub
    const parsed = ethers.utils.parseTransaction(signedTx);
    if (!parsed.to || ethers.utils.getAddress(parsed.to) !== POLYGON.relayHubContract) {
        throw new Error('Relay returned a transaction to an unexpected contract');
    }

    return signedTx;
}
