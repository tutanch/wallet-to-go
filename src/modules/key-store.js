import { loadNimiq } from '../nimiq.js';
import { DEFAULT_DERIVATION_PATH } from '../config.js';

const DB_NAME = 'nimiq-simple-wallet';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

let dbPromise = null;

function connect() {
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

export async function saveKey(entropy, password) {
    const Nimiq = await loadNimiq();
    const passwordBuf = new TextEncoder().encode(password);

    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const publicKey = Nimiq.PublicKey.derive(childKey.privateKey);
    const address = publicKey.toAddress();

    const id = Nimiq.BufferUtils.toBase64(Nimiq.Hash.computeBlake2b(entropy.serialize()));
    const encrypted = await Nimiq.Secret.exportEncrypted(entropy, passwordBuf);

    const record = {
        id,
        secret: new Uint8Array(encrypted),
        defaultAddress: address.serialize(),
    };

    const db = await connect();
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const request = tx.objectStore(STORE_NAME).put(record);
    await txPromise(request, tx);
    return id;
}

export async function getKey(password) {
    const record = await getRecord();
    if (!record) return null;

    const Nimiq = await loadNimiq();
    const passwordBuf = new TextEncoder().encode(password);

    const secret = await Nimiq.Secret.fromEncrypted(
        new Nimiq.SerialBuffer(record.secret),
        passwordBuf,
    );
    return secret;
}

export async function getRecord() {
    const db = await connect();
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

export async function hasKey() {
    const record = await getRecord();
    return record !== null;
}

export async function getStoredAddress() {
    const Nimiq = await loadNimiq();
    const record = await getRecord();
    if (!record) return null;
    return Nimiq.Address.fromAny(record.defaultAddress).toUserFriendlyAddress();
}

export async function removeAll() {
    if (dbPromise) {
        const db = await dbPromise;
        db.close();
        dbPromise = null;
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
