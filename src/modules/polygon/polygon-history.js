/**
 * USDC/USDT transaction history with a persistent IndexedDB cache.
 *
 * Public keyless RPCs cap eth_getLogs at ~10k blocks, so history is scanned
 * in windows: a recent window on open (syncRecent) and older windows on
 * demand (loadOlder), down to a floor (the wallet's Polygon activation block
 * for wallets created here, else the token's deployment-era block).
 *
 * Outgoing transfers emit TWO Transfer logs from the user: the payment and
 * the GSN fee (a transfer to the token's registered Uniswap pool). The fee
 * log is folded into the payment row; a fee log without a sibling payment
 * means the transfer itself failed but the fee was still charged.
 */

import { getEthers, getBlockNumber, getProvider, safeGetLogs } from './polygon-client.js';
import { getFeePoolAddress } from './gsn-fee.js';

// Normalize to the checksummed form — IndexedDB keys and topic filters must
// use one consistent casing.
async function normalizeAddress(address) {
    const ethers = await getEthers();
    return ethers.utils.getAddress(address);
}

const DB_NAME = 'nimiq-polygon-history';
const DB_VERSION = 1;

const INITIAL_SCAN_BLOCKS = 45000; // ~1 day (fast first open)
const LOAD_OLDER_BLOCKS = 200000; // ~4.6 days per "Load older"
// Hard floors: the tokens' Nimiq-era deployment blocks (from the original
// wallet's earliestHistoryScanHeight) — nothing relevant exists before.
const HARD_FLOOR = { usdc: 45319261, usdt: 63189500 };

// ── IndexedDB plumbing ─────────────────────────────────────────────────────

let dbPromise = null;

function connectDB() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => { dbPromise = null; reject(request.error); };
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = () => {
                const db = request.result;
                const txs = db.createObjectStore('txs', { keyPath: 'id' });
                txs.createIndex('byAddrTokenBlock', ['address', 'token', 'blockNumber']);
                db.createObjectStore('meta', { keyPath: 'key' });
                db.createObjectStore('blocks', { keyPath: 'blockNumber' });
            };
        });
    }
    return dbPromise;
}

function reqPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getMeta(address, token) {
    const db = await connectDB();
    const store = db.transaction(['meta'], 'readonly').objectStore('meta');
    return (await reqPromise(store.get(`${address}:${token}`))) || null;
}

async function putMeta(meta) {
    const db = await connectDB();
    const store = db.transaction(['meta'], 'readwrite').objectStore('meta');
    await reqPromise(store.put(meta));
}

async function putTxs(records) {
    if (!records.length) return;
    const db = await connectDB();
    const tx = db.transaction(['txs'], 'readwrite');
    const store = tx.objectStore('txs');
    for (const record of records) {
        store.put(record);
        // Drop a matching locally-added pending row (logIndex -1) — the
        // chain-scanned record replaces it.
        if (record.logIndex >= 0) {
            store.delete(`${record.token}:${record.txHash}:-1`);
        }
    }
    await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

// ── Public cache accessors ─────────────────────────────────────────────────

/**
 * Cached transactions, newest first.
 * @returns {Promise<Array>} tx records
 */
export async function getCachedTxs(address, token, { limit = 50, beforeBlock = Infinity } = {}) {
    address = await normalizeAddress(address);
    const db = await connectDB();
    const index = db.transaction(['txs'], 'readonly').objectStore('txs').index('byAddrTokenBlock');
    const range = IDBKeyRange.bound([address, token, 0], [address, token, beforeBlock], false, true);
    return new Promise((resolve, reject) => {
        const results = [];
        const request = index.openCursor(range, 'prev');
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || results.length >= limit) { resolve(results); return; }
            results.push(cursor.value);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}

export async function addPendingTx(record) {
    record.address = await normalizeAddress(record.address);
    record.id = `${record.token}:${record.txHash}:${record.logIndex}`;
    await putTxs([record]);
}

/** Remember the activation block as the natural scan floor (created-here wallets). */
export async function setScanFloor(address, block) {
    address = await normalizeAddress(address);
    for (const token of ['usdc', 'usdt']) {
        const meta = (await getMeta(address, token)) || { key: `${address}:${token}` };
        if (meta.scanFloorBlock) continue; // never move an existing floor
        meta.scanFloorBlock = block;
        await putMeta(meta);
    }
}

// ── Scanning ───────────────────────────────────────────────────────────────

function logToRecord(address, token, log, headBlock, nowMs) {
    const from = log.args.from;
    const to = log.args.to;
    return {
        id: `${token}:${log.transactionHash}:${log.logIndex}`,
        address,
        token,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        // Estimated from block distance (2s blocks); exactified lazily
        timestamp: nowMs - (headBlock - log.blockNumber) * 2000,
        timestampIsEstimate: true,
        sender: from,
        recipient: to,
        value: log.args.value.toNumber(),
        fee: null,
        incoming: to.toLowerCase() === address.toLowerCase()
            && from.toLowerCase() !== address.toLowerCase(),
        failed: false,
    };
}

/**
 * Scan [fromBlock, toBlock] for Transfer logs involving address, fold GSN
 * fee logs into their payment rows, and persist.
 * @returns {Promise<number>} number of stored rows
 */
async function scanRange(address, token, fromBlock, toBlock, headBlock) {
    const contractName = token === 'usdc' ? 'usdcToken' : 'usdtToken';
    // No fallback here: without the pool address, fee logs would be
    // mislabeled as payments — better to fail the scan and retry later.
    const feePool = (await getFeePoolAddress(token)).toLowerCase();

    const [incoming, outgoing] = await Promise.all([
        safeGetLogs(contractName, (c) => c.filters.Transfer(null, address), fromBlock, toBlock),
        safeGetLogs(contractName, (c) => c.filters.Transfer(address), fromBlock, toBlock),
    ]);

    const nowMs = Date.now();
    const byTxHash = new Map();
    const groupFor = (hash) => {
        let group = byTxHash.get(hash);
        if (!group) { group = { payment: null, fee: null, received: null }; byTxHash.set(hash, group); }
        return group;
    };

    for (const log of outgoing) {
        if (log.args.value.isZero()) continue; // spam
        const group = groupFor(log.transactionHash);
        if (log.args.to.toLowerCase() === feePool) {
            group.fee = log; // GSN fee payment
        } else if (!group.payment || log.logIndex < group.payment.logIndex) {
            group.payment = log;
        }
    }

    for (const log of incoming) {
        if (log.args.value.isZero()) continue; // address-poisoning spam
        if (log.args.from.toLowerCase() === address.toLowerCase()) continue; // self-send: outgoing covers it
        const group = groupFor(log.transactionHash);
        if (!group.received || log.logIndex < group.received.logIndex) {
            group.received = log;
        }
    }

    const records = [];
    for (const [, group] of byTxHash) {
        const feeUnits = group.fee ? group.fee.args.value.toNumber() : null;
        if (group.payment) {
            // Outgoing transfer (fee folded in)
            const record = logToRecord(address, token, group.payment, headBlock, nowMs);
            record.fee = feeUnits;
            records.push(record);
            // An unrelated incoming log in the same tx still counts
            if (group.received) {
                records.push(logToRecord(address, token, group.received, headBlock, nowMs));
            }
        } else if (group.received) {
            // Receive; a fee log in the same tx (e.g. HTLC redeem) is the
            // gas we paid for receiving — fold it in.
            const record = logToRecord(address, token, group.received, headBlock, nowMs);
            record.fee = feeUnits;
            records.push(record);
        } else if (group.fee) {
            // Fee charged with neither payment nor receive: failed relay call
            const record = logToRecord(address, token, group.fee, headBlock, nowMs);
            record.fee = record.value;
            record.value = 0;
            record.failed = true;
            records.push(record);
        }
    }

    await putTxs(records);
    return records.length;
}

/**
 * Scan from the newest scanned block (or a recent window on first run) to
 * the chain head. Returns { added }.
 */
export async function syncRecent(address, token) {
    address = await normalizeAddress(address);
    const head = await getBlockNumber();
    const meta = (await getMeta(address, token)) || { key: `${address}:${token}` };

    const floor = Math.max(meta.scanFloorBlock || 0, HARD_FLOOR[token]);
    const fromBlock = meta.newestScannedBlock
        ? meta.newestScannedBlock + 1
        : Math.max(head - INITIAL_SCAN_BLOCKS, floor);
    if (fromBlock > head) return { added: 0 };

    const added = await scanRange(address, token, fromBlock, head, head);

    meta.newestScannedBlock = head;
    meta.oldestScannedBlock = Math.min(meta.oldestScannedBlock ?? fromBlock, fromBlock);
    await putMeta(meta);

    return { added };
}

/**
 * Scan one window further into the past. Returns { added, reachedFloor }.
 */
export async function loadOlder(address, token) {
    address = await normalizeAddress(address);
    const head = await getBlockNumber();
    const meta = await getMeta(address, token);
    if (!meta || meta.oldestScannedBlock == null) {
        // Nothing synced yet — do that first
        await syncRecent(address, token);
        return loadOlder(address, token);
    }

    const floor = Math.max(meta.scanFloorBlock || 0, HARD_FLOOR[token]);
    if (meta.oldestScannedBlock <= floor) return { added: 0, reachedFloor: true };

    const toBlock = meta.oldestScannedBlock - 1;
    const fromBlock = Math.max(toBlock - LOAD_OLDER_BLOCKS, floor);

    const added = await scanRange(address, token, fromBlock, toBlock, head);

    meta.oldestScannedBlock = fromBlock;
    await putMeta(meta);

    return { added, reachedFloor: fromBlock <= floor };
}

// ── Lazy exact timestamps ──────────────────────────────────────────────────

/**
 * Replace estimated timestamps with exact block timestamps for the given
 * records (mutates + persists). Block timestamps are cached.
 */
export async function resolveTimestamps(records) {
    const pending = records.filter((record) => record.timestampIsEstimate);
    if (!pending.length) return;

    const db = await connectDB();
    const blockNumbers = [...new Set(pending.map((record) => record.blockNumber))];

    // Cached blocks first
    const cached = new Map();
    {
        const store = db.transaction(['blocks'], 'readonly').objectStore('blocks');
        for (const blockNumber of blockNumbers) {
            const entry = await reqPromise(store.get(blockNumber));
            if (entry) cached.set(blockNumber, entry.timestamp);
        }
    }

    // Fetch the rest (bounded to avoid hammering the RPC)
    const missing = blockNumbers.filter((blockNumber) => !cached.has(blockNumber)).slice(0, 25);
    if (missing.length) {
        const provider = await getProvider();
        const fetched = await Promise.all(missing.map(async (blockNumber) => {
            try {
                const block = await provider.getBlock(blockNumber);
                return { blockNumber, timestamp: block.timestamp * 1000 };
            } catch (_) {
                return null;
            }
        }));
        const store = db.transaction(['blocks'], 'readwrite').objectStore('blocks');
        for (const entry of fetched) {
            if (!entry) continue;
            cached.set(entry.blockNumber, entry.timestamp);
            store.put(entry);
        }
    }

    const updated = [];
    for (const record of pending) {
        const exact = cached.get(record.blockNumber);
        if (exact == null) continue;
        record.timestamp = exact;
        record.timestampIsEstimate = false;
        updated.push(record);
    }
    await putTxs(updated);
}
