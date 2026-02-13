import { loadNimiq } from '../nimiq.js';
import { DEFAULT_DERIVATION_PATH, getNetworkConfig } from '../config.js';

export async function buildAndSign({
    senderAddress,
    recipientAddress,
    value,
    fee = 0,
    entropy,
    message = '',
    validityStartHeight,
    networkId,
}) {
    // Validate inputs before touching keys
    if (!senderAddress || typeof senderAddress !== 'string') {
        throw new Error('Invalid sender address');
    }
    if (!recipientAddress || typeof recipientAddress !== 'string') {
        throw new Error('Invalid recipient address');
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('Value must be a positive number');
    }
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) {
        throw new Error('Fee must be a non-negative number');
    }
    if (typeof validityStartHeight !== 'number' || validityStartHeight <= 0) {
        throw new Error('Invalid validity start height');
    }
    if (!entropy) {
        throw new Error('Missing signing key');
    }

    // Validate networkId matches expected config to prevent cross-network signing
    const expectedConfig = getNetworkConfig();
    if (networkId !== expectedConfig.id) {
        throw new Error(`Network ID mismatch: got ${networkId}, expected ${expectedConfig.id}`);
    }

    const msgBytes = message ? new TextEncoder().encode(message) : new Uint8Array(0);
    if (msgBytes.length > 64) {
        throw new Error('Message exceeds 64 bytes');
    }

    const Nimiq = await loadNimiq();

    // Validate addresses parse correctly
    const sender = Nimiq.Address.fromString(senderAddress);
    const recipient = Nimiq.Address.fromString(recipientAddress);

    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const privateKey = childKey.privateKey;
    const publicKey = Nimiq.PublicKey.derive(privateKey);

    const tx = Nimiq.TransactionBuilder.newBasicWithData(
        sender,
        recipient,
        msgBytes,
        BigInt(value),
        BigInt(fee),
        validityStartHeight,
        networkId,
    );

    const signature = Nimiq.Signature.create(
        privateKey,
        publicKey,
        tx.serializeContent(),
    );

    tx.proof = Nimiq.SignatureProof.singleSig(publicKey, signature).serialize();

    return tx;
}
