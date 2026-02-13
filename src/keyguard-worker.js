// Keyguard Worker — all private key operations run in this isolated context.
// Keys never leave this worker. The main thread communicates via postMessage.

import init, {
    Address,
    Hash,
    PublicKey,
    Signature,
    SignatureProof,
    TransactionBuilder,
} from '../lib/nimiq-core/web/main-wasm/index.js';

import {
    BufferUtils,
    Entropy,
    MnemonicUtils,
    Secret,
    SerialBuffer,
} from '../lib/nimiq-core/lib/web/index.mjs';

const DEFAULT_DERIVATION_PATH = "m/44'/242'/0'/0'";

// ── IndexedDB helpers ──────────────────────────────────────────────

const DB_NAME = 'nimiq-simple-wallet';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

let dbPromise = null;

function connectDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        };
    });
    return dbPromise;
}

function txPromise(request, transaction) {
    return Promise.all([
        new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }),
        new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error);
            transaction.onerror = () => reject(transaction.error);
        }),
    ]).then(([result]) => result);
}

async function getRecord() {
    const db = await connectDB();
    const tx = db.transaction([STORE_NAME], 'readonly');
    const request = tx.objectStore(STORE_NAME).openCursor();
    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            const cursor = request.result;
            resolve(cursor ? cursor.value : null);
        };
        request.onerror = () => reject(request.error);
    });
}

// ── Key derivation helpers ─────────────────────────────────────────

function deriveAddress(entropy) {
    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const publicKey = PublicKey.derive(childKey.privateKey);
    return publicKey.toAddress();
}

function deriveKeyPair(entropy) {
    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const privateKey = childKey.privateKey;
    const publicKey = PublicKey.derive(privateKey);
    return { privateKey, publicKey };
}

// ── WASM init ──────────────────────────────────────────────────────

let wasmReady = false;

async function ensureWasm() {
    if (wasmReady) return;
    await init();
    wasmReady = true;
}

// ── Temporary state for create flow ────────────────────────────────
// Between createWallet() and saveWallet(), entropy lives only here.
let pendingEntropy = null;

// ── Command handlers ───────────────────────────────────────────────

const handlers = {
    async hasKey() {
        const record = await getRecord();
        return record !== null;
    },

    async getStoredAddress() {
        await ensureWasm();
        const record = await getRecord();
        if (!record) return null;
        return Address.fromAny(record.defaultAddress).toUserFriendlyAddress();
    },

    async createWallet() {
        await ensureWasm();
        const entropy = Entropy.generate();
        const mnemonic = MnemonicUtils.entropyToMnemonic(entropy);
        const address = deriveAddress(entropy);
        pendingEntropy = entropy;
        return {
            mnemonic: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(' '),
            address: address.toUserFriendlyAddress(),
        };
    },

    async saveWallet({ password }) {
        await ensureWasm();
        if (!pendingEntropy) throw new Error('No pending wallet to save');

        const passwordBuf = new TextEncoder().encode(password);
        const address = deriveAddress(pendingEntropy);
        const id = BufferUtils.toBase64(Hash.computeBlake2b(pendingEntropy.serialize()));
        const encrypted = await Secret.exportEncrypted(pendingEntropy, passwordBuf);

        const record = {
            id,
            secret: new Uint8Array(encrypted),
            defaultAddress: address.serialize(),
        };

        const db = await connectDB();
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const request = tx.objectStore(STORE_NAME).put(record);
        await txPromise(request, tx);

        // Zero out pending entropy
        try {
            const bytes = pendingEntropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }
        pendingEntropy = null;

        return { id };
    },

    async importWallet({ words, password }) {
        await ensureWasm();
        const wordArray = typeof words === 'string' ? words.trim().split(/\s+/) : words;
        const entropy = MnemonicUtils.mnemonicToEntropy(wordArray);

        const passwordBuf = new TextEncoder().encode(password);
        const address = deriveAddress(entropy);
        const id = BufferUtils.toBase64(Hash.computeBlake2b(entropy.serialize()));
        const encrypted = await Secret.exportEncrypted(entropy, passwordBuf);

        const record = {
            id,
            secret: new Uint8Array(encrypted),
            defaultAddress: address.serialize(),
        };

        const db = await connectDB();
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const request = tx.objectStore(STORE_NAME).put(record);
        await txPromise(request, tx);

        const userAddress = address.toUserFriendlyAddress();

        // Zero entropy
        try {
            const bytes = entropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }

        return { address: userAddress };
    },

    async signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId, password }) {
        await ensureWasm();

        // Decrypt key
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        const passwordBuf = new TextEncoder().encode(password);
        let entropy;
        try {
            entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
        } catch (_) {
            throw new Error('Wrong password');
        }

        // Validate message
        const msgBytes = message ? new TextEncoder().encode(message) : new Uint8Array(0);
        if (msgBytes.length > 64) throw new Error('Message exceeds 64 bytes');

        // Build and sign transaction
        const sender = Address.fromString(senderAddress);
        const recipient = Address.fromString(recipientAddress);
        const { privateKey, publicKey } = deriveKeyPair(entropy);

        const tx = TransactionBuilder.newBasicWithData(
            sender,
            recipient,
            msgBytes,
            BigInt(value),
            BigInt(fee),
            validityStartHeight,
            networkId,
        );

        const signature = Signature.create(privateKey, publicKey, tx.serializeContent());
        tx.proof = SignatureProof.singleSig(publicKey, signature).serialize();

        // Serialize the complete signed transaction to bytes
        const serializedTx = tx.serialize();

        // Zero entropy
        try {
            const bytes = entropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }

        // Transfer the buffer (zero-copy) to main thread
        return { serializedTx };
    },

    async exportMnemonic({ password }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        const passwordBuf = new TextEncoder().encode(password);
        let entropy;
        try {
            entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
        } catch (_) {
            throw new Error('Wrong password');
        }

        const mnemonic = MnemonicUtils.entropyToMnemonic(entropy);
        const words = Array.isArray(mnemonic) ? mnemonic : mnemonic.split(' ');

        // Zero entropy
        try {
            const bytes = entropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }

        return { words };
    },

    async verifyPassword({ password }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) return false;

        const passwordBuf = new TextEncoder().encode(password);
        try {
            await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            return true;
        } catch (_) {
            return false;
        }
    },

    async deleteWallet() {
        if (dbPromise) {
            const db = await dbPromise;
            db.close();
            dbPromise = null;
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(DB_NAME);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    },
};

// ── Message handler ────────────────────────────────────────────────

self.onmessage = async (e) => {
    const { id, command, args } = e.data;
    try {
        const handler = handlers[command];
        if (!handler) throw new Error(`Unknown command: ${command}`);
        const result = await handler(args || {});

        // Transfer ArrayBuffers if present (zero-copy)
        const transfer = [];
        if (result && result.serializedTx) {
            transfer.push(result.serializedTx.buffer);
        }

        self.postMessage({ id, result }, transfer);
    } catch (err) {
        self.postMessage({ id, error: err.message || 'Unknown error' });
    }
};
