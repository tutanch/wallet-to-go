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

// ── Passkey backup database ───────────────────────────────────────
// Separate DB so it survives wallet deletion. Stores only the
// PRF-encrypted entropy + credential metadata — no password data.

const BACKUP_DB_NAME = 'nimiq-passkey-backup';
const BACKUP_STORE = 'backup';

function connectBackupDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(BACKUP_DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(BACKUP_STORE, { keyPath: 'id' });
        };
    });
}

async function savePasskeyBackup(webauthnData, defaultAddress) {
    const db = await connectBackupDB();
    const tx = db.transaction([BACKUP_STORE], 'readwrite');
    const request = tx.objectStore(BACKUP_STORE).put({
        id: 'backup',
        credentialId: webauthnData.credentialId,
        prfSalt: webauthnData.prfSalt,
        encryptedSecret: webauthnData.encryptedSecret,
        iv: webauthnData.iv,
        defaultAddress,
    });
    await txPromise(request, tx);
    db.close();
}

async function getPasskeyBackupRecord() {
    let db;
    try {
        db = await connectBackupDB();
    } catch (_) {
        return null;
    }
    const tx = db.transaction([BACKUP_STORE], 'readonly');
    const request = tx.objectStore(BACKUP_STORE).get('backup');
    const result = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
}

async function clearPasskeyBackup() {
    let db;
    try {
        db = await connectBackupDB();
    } catch (_) {
        return;
    }
    const tx = db.transaction([BACKUP_STORE], 'readwrite');
    tx.objectStore(BACKUP_STORE).clear();
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    db.close();
}

// ── WebAuthn AES-GCM helpers ──────────────────────────────────────

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

    async signTransaction({ senderAddress, recipientAddress, value, fee, message, validityStartHeight, networkId, password, prfKey }) {
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
            }
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
            }
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
        // Preserve PRF-encrypted backup before deleting (enables passkey restore)
        const record = await getRecord();
        if (record?.webauthn) {
            await savePasskeyBackup(record.webauthn, record.defaultAddress);
        }

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
        }

        // Encrypt entropy with PRF-derived key using AES-256-GCM
        const entropyBytes = entropy.serialize();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aesKey = await crypto.subtle.importKey(
            'raw', new Uint8Array(prfKey), { name: 'AES-GCM' }, false, ['encrypt'],
        );
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, aesKey, entropyBytes,
        );

        // Update record with WebAuthn data
        record.webauthn = {
            credentialId: new Uint8Array(credentialId),
            prfSalt: new Uint8Array(prfSalt),
            encryptedSecret: new Uint8Array(ciphertext),
            iv,
        };

        const db = await connectDB();
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const request = tx.objectStore(STORE_NAME).put(record);
        await txPromise(request, tx);

        // Zero entropy
        try {
            const bytes = entropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }

        return { success: true };
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

    async hasPasskeyBackup() {
        const backup = await getPasskeyBackupRecord();
        if (!backup) return { hasBackup: false };
        return {
            hasBackup: true,
            credentialId: backup.credentialId,
            prfSalt: backup.prfSalt,
        };
    },

    async restoreWithPasskey({ prfKey, password, credentialId, prfSalt, fromBackup }) {
        await ensureWasm();

        let entropy;
        let storedCredentialId;
        let storedPrfSalt;

        if (fromBackup) {
            // Same-device restore: decrypt entropy from backup
            const backup = await getPasskeyBackupRecord();
            if (!backup) throw new Error('No passkey backup found');

            const aesKey = await crypto.subtle.importKey(
                'raw', new Uint8Array(prfKey), { name: 'AES-GCM' }, false, ['decrypt'],
            );
            let entropyBytes;
            try {
                entropyBytes = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: backup.iv }, aesKey, backup.encryptedSecret,
                );
            } catch (_) {
                throw new Error('Passkey decryption failed');
            }
            entropy = new Entropy(new Uint8Array(entropyBytes));
            storedCredentialId = backup.credentialId;
            storedPrfSalt = backup.prfSalt;
        } else {
            // Cross-device restore: PRF key IS the entropy
            entropy = new Entropy(new Uint8Array(prfKey));
            storedCredentialId = new Uint8Array(credentialId);
            storedPrfSalt = new Uint8Array(prfSalt);
        }

        const address = deriveAddress(entropy);
        const passwordBuf = new TextEncoder().encode(password);
        const id = BufferUtils.toBase64(Hash.computeBlake2b(entropy.serialize()));
        const encrypted = await Secret.exportEncrypted(entropy, passwordBuf);

        // Encrypt entropy with PRF key for future WebAuthn use
        const newIv = crypto.getRandomValues(new Uint8Array(12));
        const encKey = await crypto.subtle.importKey(
            'raw', new Uint8Array(prfKey), { name: 'AES-GCM' }, false, ['encrypt'],
        );
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: newIv }, encKey, entropy.serialize(),
        );

        const record = {
            id,
            secret: new Uint8Array(encrypted),
            defaultAddress: address.serialize(),
            webauthn: {
                credentialId: storedCredentialId,
                prfSalt: storedPrfSalt,
                encryptedSecret: new Uint8Array(ciphertext),
                iv: newIv,
            },
        };

        const db = await connectDB();
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const request = tx.objectStore(STORE_NAME).put(record);
        await txPromise(request, tx);

        // Clear backup if it existed
        await clearPasskeyBackup();

        // Zero entropy
        try {
            const bytes = entropy.serialize();
            if (bytes instanceof Uint8Array) bytes.fill(0);
        } catch (_) { /* best effort */ }

        return { address: address.toUserFriendlyAddress() };
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
