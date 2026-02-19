// Keyguard Worker — all private key operations run in this isolated context.
// Keys never leave this worker. The main thread communicates via postMessage.

import init, {
    Address,
    Hash,
    PrivateKey,
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

// Base derivation path — address index is appended by getDerivationPath().
// Full path: m/44'/242'/0'/{addressIndex}'
const DERIVATION_BASE = "m/44'/242'/0'";

// ── IndexedDB helpers ──────────────────────────────────────────────

const DB_NAME = 'nimiq-simple-wallet';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const ACTIVE_RECORD_ID = 'wallet';

let dbPromise = null;

function connectDB() {
    if (dbPromise) {
        // Verify the cached connection is still usable. If the database was
        // closed (e.g. by deleteWallet) or the browser evicted it, the cached
        // promise resolves to a dead IDBDatabase that throws on transaction().
        return dbPromise.then(db => {
            try {
                db.transaction([STORE_NAME], 'readonly');
                return db;
            } catch (_) {
                dbPromise = null;
                return connectDB();
            }
        });
    }
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => { dbPromise = null; reject(request.error); };
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

async function getRecordById(id) {
    const db = await connectDB();
    const tx = db.transaction([STORE_NAME], 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

async function getFirstRecord() {
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

async function getRecord() {
    // Prefer fixed active key; fall back to first-record lookup for legacy data.
    const active = await getRecordById(ACTIVE_RECORD_ID);
    if (active) return active;
    return getFirstRecord();
}

async function putActiveRecord(record) {
    const db = await connectDB();
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    record.id = ACTIVE_RECORD_ID;
    const request = store.put(record);
    await txPromise(request, tx);
}

// ── Key material cleanup helpers ──────────────────────────────────

/** Free a WASM-bound object (PrivateKey, PublicKey, Signature, etc.) */
function freeWasm(obj) {
    try { if (obj?.free) obj.free(); } catch (_) {}
}

/** Free an ExtendedPrivateKey's internal WASM key and zero its chain code */
function freeExtendedKey(extKey) {
    if (!extKey) return;
    try { if (extKey._key?.free) extKey._key.free(); } catch (_) {}
    try { if (extKey._chainCode) extKey._chainCode.fill(0); } catch (_) {}
}

/** Zero serialized entropy bytes (best-effort; serialize() may return a copy) */
function zeroEntropy(entropy) {
    if (!entropy) return;
    try {
        const bytes = entropy.serialize();
        if (bytes instanceof Uint8Array) bytes.fill(0);
    } catch (_) {}
}

// ── Key derivation helpers ─────────────────────────────────────────

const NUM_DERIVED_ADDRESSES = 10;

function getDerivationPath(addressIndex = 0) {
    return `${DERIVATION_BASE}/${addressIndex}'`;
}

function deriveAddress(entropy, addressIndex = 0) {
    let masterKey, childKey, publicKey;
    try {
        masterKey = entropy.toExtendedPrivateKey();
        childKey = masterKey.derivePath(getDerivationPath(addressIndex));
        publicKey = PublicKey.derive(childKey.privateKey);
        return publicKey.toAddress();
    } finally {
        freeExtendedKey(childKey);
        freeExtendedKey(masterKey);
        freeWasm(publicKey);
    }
}

function deriveMultipleAddresses(entropy, count = NUM_DERIVED_ADDRESSES) {
    const addresses = [];
    for (let i = 0; i < count; i++) {
        const addr = deriveAddress(entropy, i);
        addresses.push({ index: i, address: addr.toUserFriendlyAddress() });
    }
    return addresses;
}

// ── HKDF helper ─────────────────────────────────────────────────────
// Derives deterministic 32-byte entropy from a PRF output for cross-device
// passkey restore. Using HKDF avoids treating raw PRF output directly as
// wallet entropy, which would tightly couple wallet security to the
// authenticator's PRF implementation quality.
//
// A per-wallet nonce (derived from a deterministic account index) is
// appended to the HKDF info. This ensures each account produces unique
// entropy even if the platform reuses the same passkey credential (same
// PRF output). The nonce is deterministic: same index → same nonce →
// same wallet on any device.

const HKDF_SALT = new TextEncoder().encode('nimiq-wallet-hkdf-v1');
const HKDF_INFO = new TextEncoder().encode('cross-device-entropy');

// Build a structured 32-byte nonce from a sequential account index.
// Format: "NIM\x01" (4 bytes magic) + uint32 BE index + 24 bytes zero padding.
function buildIndexNonce(index) {
    const nonce = new Uint8Array(32);
    nonce[0] = 0x4E; // 'N'
    nonce[1] = 0x49; // 'I'
    nonce[2] = 0x4D; // 'M'
    nonce[3] = 0x01; // version 1
    const view = new DataView(nonce.buffer);
    view.setUint32(4, index, false); // big-endian
    return nonce;
}

async function deriveEntropyFromPrf(prfKeyBytes, nonce) {
    const ikm = await crypto.subtle.importKey(
        'raw', new Uint8Array(prfKeyBytes), 'HKDF', false, ['deriveBits'],
    );
    const combined = new Uint8Array(HKDF_INFO.length + nonce.length);
    combined.set(HKDF_INFO);
    combined.set(new Uint8Array(nonce), HKDF_INFO.length);
    const derived = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: combined },
        ikm,
        256,
    );
    return new Uint8Array(derived);
}

// ── Cashlink data encryption key ──────────────────────────────────
// Derives a purpose-specific AES-256 key from wallet entropy for encrypting
// saved cashlink runs. Uses the same HKDF salt but a different info parameter
// to ensure cryptographic independence from other entropy-derived keys.

const CASHLINK_ENC_INFO = new TextEncoder().encode('cashlink-data-encryption');

async function deriveCashlinkEncKey(entropy) {
    const entropyBytes = entropy.serialize();
    try {
        const ikm = await crypto.subtle.importKey(
            'raw', entropyBytes, 'HKDF', false, ['deriveBits'],
        );
        const derived = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: CASHLINK_ENC_INFO },
            ikm,
            256,
        );
        return new Uint8Array(derived);
    } finally {
        entropyBytes.fill(0);
    }
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


// ── WebAuthn AES-GCM helpers ──────────────────────────────────────

async function encryptWithPrfKey(entropyBytes, prfKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await crypto.subtle.importKey(
        'raw', new Uint8Array(prfKey), { name: 'AES-GCM' }, false, ['encrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, aesKey, entropyBytes,
    );
    return { encryptedSecret: new Uint8Array(ciphertext), iv };
}

async function decryptWithPrfKey(record, prfKey) {
    if (!record.webauthn) throw new Error('No WebAuthn credential found');
    const { encryptedSecret, iv } = record.webauthn;
    const aesKey = await crypto.subtle.importKey(
        'raw', new Uint8Array(prfKey), { name: 'AES-GCM' }, false, ['decrypt'],
    );
    let entropyBytes;
    try {
        entropyBytes = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, aesKey, encryptedSecret,
        );
    } catch (_) {
        throw new Error('WebAuthn decryption failed');
    }
    return new Entropy(new Uint8Array(entropyBytes));
}

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

    async getDerivedAddresses() {
        const record = await getRecord();
        if (!record) return { addresses: [] };
        return { addresses: record.derivedAddresses || [] };
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

    async createWalletFromPrf({ prfKey, accountIndex }) {
        await ensureWasm();
        const nonce = buildIndexNonce(accountIndex);
        const derivedBytes = await deriveEntropyFromPrf(prfKey, nonce);
        // Entropy stores the buffer by reference — copy it so we can zero
        // derivedBytes without destroying the entropy we need for mnemonic/address.
        const entropy = new Entropy(new Uint8Array(derivedBytes));
        derivedBytes.fill(0);
        const mnemonic = MnemonicUtils.entropyToMnemonic(entropy);
        const address = deriveAddress(entropy);
        pendingEntropy = entropy;
        return {
            mnemonic: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(' '),
            address: address.toUserFriendlyAddress(),
        };
    },

    async saveWallet({ password, prfKey, credentialId, prfSalt }) {
        await ensureWasm();
        if (!pendingEntropy) throw new Error('No pending wallet to save');
        if (!password && !prfKey) throw new Error('At least one auth method required');

        const address = deriveAddress(pendingEntropy);
        const derivedAddresses = deriveMultipleAddresses(pendingEntropy);
        const walletId = BufferUtils.toBase64(Hash.computeBlake2b(pendingEntropy.serialize()));

        const record = {
            walletId,
            defaultAddress: address.serialize(),
            derivedAddresses,
        };

        // Password encryption (optional)
        if (password) {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                record.secret = new Uint8Array(await Secret.exportEncrypted(pendingEntropy, passwordBuf));
            } finally {
                passwordBuf.fill(0);
            }
        }

        // Passkey encryption (optional)
        if (prfKey) {
            const { encryptedSecret, iv } = await encryptWithPrfKey(pendingEntropy.serialize(), prfKey);
            record.webauthn = {
                credentialId: new Uint8Array(credentialId),
                prfSalt: new Uint8Array(prfSalt),
                encryptedSecret,
                iv,
            };
        }

        await putActiveRecord(record);

        zeroEntropy(pendingEntropy);
        pendingEntropy = null;

        return { id: walletId };
    },

    async importWallet({ words, password, prfKey, credentialId, prfSalt }) {
        await ensureWasm();
        if (!password && !prfKey) throw new Error('At least one auth method required');

        const wordArray = typeof words === 'string' ? words.trim().split(/\s+/) : words;
        const entropy = MnemonicUtils.mnemonicToEntropy(wordArray);

        try {
            const address = deriveAddress(entropy);
            const derivedAddresses = deriveMultipleAddresses(entropy);
            const walletId = BufferUtils.toBase64(Hash.computeBlake2b(entropy.serialize()));

            const record = {
                walletId,
                defaultAddress: address.serialize(),
                derivedAddresses,
            };

            // Password encryption (optional)
            if (password) {
                const passwordBuf = new TextEncoder().encode(password);
                try {
                    record.secret = new Uint8Array(await Secret.exportEncrypted(entropy, passwordBuf));
                } finally {
                    passwordBuf.fill(0);
                }
            }

            // Passkey encryption (optional)
            if (prfKey) {
                const { encryptedSecret, iv } = await encryptWithPrfKey(entropy.serialize(), prfKey);
                record.webauthn = {
                    credentialId: new Uint8Array(credentialId),
                    prfSalt: new Uint8Array(prfSalt),
                    encryptedSecret,
                    iv,
                };
            }

            await putActiveRecord(record);

            return { address: address.toUserFriendlyAddress() };
        } finally {
            zeroEntropy(entropy);
        }
    },

    async signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId, password, prfKey, addressIndex = 0 }) {
        await ensureWasm();

        // Decrypt key
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        let entropy;
        if (prfKey) {
            entropy = await decryptWithPrfKey(record, prfKey);
        } else {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            } catch (_) {
                throw new Error('Wrong password');
            } finally {
                passwordBuf.fill(0);
            }
        }

        // Validate message
        const msgBytes = message ? new TextEncoder().encode(message) : new Uint8Array(0);
        if (msgBytes.length > 64) throw new Error('Message exceeds 64 bytes');

        // Build and sign transaction
        let masterKey, childKey, privateKey, publicKey, signature;
        try {
            const sender = Address.fromString(senderAddress);
            const recipient = Address.fromString(recipientAddress);
            masterKey = entropy.toExtendedPrivateKey();
            childKey = masterKey.derivePath(getDerivationPath(addressIndex));
            privateKey = childKey.privateKey; // same ref as childKey._key
            publicKey = PublicKey.derive(privateKey);

            const tx = TransactionBuilder.newBasicWithData(
                sender, recipient, msgBytes,
                BigInt(value), BigInt(fee),
                validityStartHeight, networkId,
            );

            signature = Signature.create(privateKey, publicKey, tx.serializeContent());
            tx.proof = SignatureProof.singleSig(publicKey, signature).serialize();
            const serializedTx = tx.serialize();
            return { serializedTx };
        } finally {
            freeWasm(signature);
            freeWasm(publicKey);
            // privateKey === childKey._key (same WASM ref), so free via privateKey
            // and only zero the chain code on childKey to avoid double-free
            freeWasm(privateKey);
            try { if (childKey?._chainCode) childKey._chainCode.fill(0); } catch (_) {}
            freeExtendedKey(masterKey);
            zeroEntropy(entropy);
        }
    },

    async signBatchTransaction({ senderAddress, transactions, password, prfKey, addressIndex = 0 }) {
        await ensureWasm();

        const record = await getRecord();
        if (!record) throw new Error('No wallet found');
        if (!Array.isArray(transactions) || transactions.length === 0) {
            throw new Error('No transactions provided');
        }

        let entropy;
        if (prfKey) {
            entropy = await decryptWithPrfKey(record, prfKey);
        } else {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            } catch (_) {
                throw new Error('Wrong password');
            } finally {
                passwordBuf.fill(0);
            }
        }

        let masterKey, childKey, privateKey, publicKey;
        const signatures = []; // track for cleanup
        try {
            const sender = Address.fromString(senderAddress);
            masterKey = entropy.toExtendedPrivateKey();
            childKey = masterKey.derivePath(getDerivationPath(addressIndex));
            privateKey = childKey.privateKey;
            publicKey = PublicKey.derive(privateKey);

            const serializedTransactions = [];
            for (const txParams of transactions) {
                const msgBytes = txParams.extraData
                    ? new Uint8Array(txParams.extraData)
                    : txParams.message
                        ? new TextEncoder().encode(txParams.message)
                        : new Uint8Array(0);
                if (msgBytes.length > 64) throw new Error('Data exceeds 64 bytes');

                const recipient = Address.fromString(txParams.recipientAddress);
                const tx = TransactionBuilder.newBasicWithData(
                    sender, recipient, msgBytes,
                    BigInt(txParams.value), BigInt(txParams.fee),
                    txParams.validityStartHeight, txParams.networkId,
                );

                const sig = Signature.create(privateKey, publicKey, tx.serializeContent());
                signatures.push(sig);
                tx.proof = SignatureProof.singleSig(publicKey, sig).serialize();
                serializedTransactions.push(tx.serialize());
            }

            return { serializedTransactions };
        } finally {
            for (const sig of signatures) freeWasm(sig);
            freeWasm(publicKey);
            freeWasm(privateKey);
            try { if (childKey?._chainCode) childKey._chainCode.fill(0); } catch (_) {}
            freeExtendedKey(masterKey);
            zeroEntropy(entropy);
        }
    },

    async exportMnemonic({ password, prfKey }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        let entropy;
        if (prfKey) {
            entropy = await decryptWithPrfKey(record, prfKey);
        } else {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            } catch (_) {
                throw new Error('Wrong password');
            } finally {
                passwordBuf.fill(0);
            }
        }

        try {
            const mnemonic = MnemonicUtils.entropyToMnemonic(entropy);
            return { words: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(' ') };
        } finally {
            zeroEntropy(entropy);
        }
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
        } finally {
            passwordBuf.fill(0);
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

    // ── WebAuthn handlers ─────────────────────────────────────────

    async saveWebAuthnSecret({ password, prfKey, credentialId, prfSalt }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        // Decrypt entropy using password
        const passwordBuf = new TextEncoder().encode(password);
        let entropy;
        try {
            entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
        } catch (_) {
            throw new Error('Wrong password');
        } finally {
            passwordBuf.fill(0);
        }

        try {
            // Encrypt entropy with PRF-derived key using AES-256-GCM
            const { encryptedSecret, iv } = await encryptWithPrfKey(entropy.serialize(), prfKey);

            // Update record with WebAuthn data
            record.webauthn = {
                credentialId: new Uint8Array(credentialId),
                prfSalt: new Uint8Array(prfSalt),
                encryptedSecret,
                iv,
            };

            const db = await connectDB();
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const request = tx.objectStore(STORE_NAME).put(record);
            await txPromise(request, tx);

            return { success: true };
        } finally {
            zeroEntropy(entropy);
        }
    },

    async getWebAuthnInfo() {
        const record = await getRecord();
        if (!record || !record.webauthn) return { hasWebAuthn: false };
        return {
            hasWebAuthn: true,
            credentialId: record.webauthn.credentialId,
            prfSalt: record.webauthn.prfSalt,
        };
    },

    async hasPassword() {
        const record = await getRecord();
        return !!(record && record.secret);
    },

    // Scan account indices 0..maxIndex and derive the address for each.
    // Used during passkey restore to find which accounts exist.
    async scanAccountAddresses({ prfKey, maxIndex = 20 }) {
        await ensureWasm();
        const addresses = [];
        for (let i = 0; i <= maxIndex; i++) {
            const nonce = buildIndexNonce(i);
            const derived = await deriveEntropyFromPrf(prfKey, nonce);
            const entropy = new Entropy(new Uint8Array(derived));
            derived.fill(0);
            const addr = deriveAddress(entropy);
            addresses.push({ index: i, address: addr.toUserFriendlyAddress() });
            zeroEntropy(entropy);
        }
        return { addresses };
    },

    async restoreWithPasskey({ prfKey, credentialId, prfSalt, accountIndex, allowOverwrite }) {
        await ensureWasm();

        const nonce = buildIndexNonce(accountIndex);
        const derivedBytes = await deriveEntropyFromPrf(prfKey, nonce);
        const entropy = new Entropy(new Uint8Array(derivedBytes));
        derivedBytes.fill(0);

        try {
            const address = deriveAddress(entropy);

            // Safety check: if a wallet already exists with a DIFFERENT address,
            // refuse to overwrite it (unless the caller explicitly allows it,
            // e.g. when restoring from the welcome screen after "Use a different wallet").
            const existing = await getRecord();
            if (existing && !allowOverwrite) {
                const existingAddr = Address.fromAny(existing.defaultAddress).toUserFriendlyAddress();
                const newAddr = address.toUserFriendlyAddress();
                if (existingAddr !== newAddr) {
                    throw new Error('This passkey is associated with a different wallet. Use "Use a different wallet" to switch.');
                }
            }

            const derivedAddresses = deriveMultipleAddresses(entropy);
            const walletId = BufferUtils.toBase64(Hash.computeBlake2b(entropy.serialize()));

            const record = {
                walletId,
                defaultAddress: address.serialize(),
                derivedAddresses,
            };

            // Encrypt entropy with PRF key for future WebAuthn unlock
            const { encryptedSecret, iv } = await encryptWithPrfKey(entropy.serialize(), prfKey);

            record.webauthn = {
                credentialId: new Uint8Array(credentialId),
                prfSalt: new Uint8Array(prfSalt),
                encryptedSecret,
                iv,
            };

            await putActiveRecord(record);

            return { address: address.toUserFriendlyAddress() };
        } finally {
            zeroEntropy(entropy);
        }
    },

    async removeWebAuthn() {
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');
        delete record.webauthn;
        const db = await connectDB();
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const request = tx.objectStore(STORE_NAME).put(record);
        await txPromise(request, tx);
        return { success: true };
    },

    async generateCashlinkKeys({ count }) {
        await ensureWasm();
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            throw new Error('Count must be between 1 and 100');
        }

        const keys = [];
        for (let i = 0; i < count; i++) {
            const pk = PrivateKey.generate();
            let publicKey;
            try {
                publicKey = PublicKey.derive(pk);
                const address = publicKey.toAddress();
                keys.push({
                    address: address.toUserFriendlyAddress(),
                    privateKeyBytes: Array.from(pk.serialize()),
                });
            } finally {
                freeWasm(pk);
                freeWasm(publicKey);
            }
        }
        return { keys };
    },

    async getCashlinkAddresses({ privateKeys }) {
        await ensureWasm();
        const addresses = [];
        for (const pkBytes of privateKeys) {
            const pk = new PrivateKey(new Uint8Array(pkBytes));
            let publicKey;
            try {
                publicKey = PublicKey.derive(pk);
                addresses.push(publicKey.toAddress().toUserFriendlyAddress());
            } finally {
                freeWasm(pk);
                freeWasm(publicKey);
            }
        }
        return { addresses };
    },

    async signCashlinkClaims({ claims }) {
        await ensureWasm();
        if (!Array.isArray(claims) || claims.length === 0) {
            throw new Error('No claims provided');
        }

        const serializedTransactions = [];
        const linkData = new Uint8Array([0, 139, 136, 141, 138]);

        for (const claim of claims) {
            const pk = new PrivateKey(new Uint8Array(claim.privateKeyBytes));
            let publicKey, signature;
            try {
                publicKey = PublicKey.derive(pk);
                const sender = publicKey.toAddress();
                const recipient = Address.fromString(claim.recipientAddress);

                const tx = TransactionBuilder.newBasicWithData(
                    sender, recipient, linkData,
                    BigInt(claim.value), BigInt(claim.fee),
                    claim.validityStartHeight, claim.networkId,
                );

                signature = Signature.create(pk, publicKey, tx.serializeContent());
                tx.proof = SignatureProof.singleSig(publicKey, signature).serialize();
                serializedTransactions.push(tx.serialize());
            } finally {
                freeWasm(signature);
                freeWasm(publicKey);
                freeWasm(pk);
            }
        }

        return { serializedTransactions };
    },

    async encryptCashlinkData({ data, password, prfKey }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        let entropy;
        if (prfKey) {
            entropy = await decryptWithPrfKey(record, prfKey);
        } else {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            } catch (_) { throw new Error('Wrong password'); }
            finally { passwordBuf.fill(0); }
        }

        try {
            const encKey = await deriveCashlinkEncKey(entropy);
            try {
                const plaintext = new TextEncoder().encode(data);
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const aesKey = await crypto.subtle.importKey(
                    'raw', encKey, { name: 'AES-GCM' }, false, ['encrypt'],
                );
                const ciphertext = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv }, aesKey, plaintext,
                );
                return {
                    ciphertext: Array.from(new Uint8Array(ciphertext)),
                    iv: Array.from(iv),
                };
            } finally { encKey.fill(0); }
        } finally { zeroEntropy(entropy); }
    },

    async decryptCashlinkData({ ciphertext, iv, password, prfKey }) {
        await ensureWasm();
        const record = await getRecord();
        if (!record) throw new Error('No wallet found');

        let entropy;
        if (prfKey) {
            entropy = await decryptWithPrfKey(record, prfKey);
        } else {
            const passwordBuf = new TextEncoder().encode(password);
            try {
                entropy = await Secret.fromEncrypted(new SerialBuffer(record.secret), passwordBuf);
            } catch (_) { throw new Error('Wrong password'); }
            finally { passwordBuf.fill(0); }
        }

        try {
            const encKey = await deriveCashlinkEncKey(entropy);
            try {
                const aesKey = await crypto.subtle.importKey(
                    'raw', encKey, { name: 'AES-GCM' }, false, ['decrypt'],
                );
                const plaintext = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: new Uint8Array(iv) },
                    aesKey, new Uint8Array(ciphertext),
                );
                return { data: new TextDecoder().decode(plaintext) };
            } finally { encKey.fill(0); }
        } finally { zeroEntropy(entropy); }
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
        if (result && result.serializedTransactions) {
            for (const tx of result.serializedTransactions) transfer.push(tx.buffer);
        }

        self.postMessage({ id, result }, transfer);
    } catch (err) {
        self.postMessage({ id, error: err.message || 'Unknown error' });
    }
};
