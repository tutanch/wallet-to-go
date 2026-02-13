import { loadNimiq } from '../nimiq.js';
import { DEFAULT_DERIVATION_PATH } from '../config.js';

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
    const Nimiq = await loadNimiq();

    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const privateKey = childKey.privateKey;
    const publicKey = Nimiq.PublicKey.derive(privateKey);

    const sender = Nimiq.Address.fromString(senderAddress);
    const recipient = Nimiq.Address.fromString(recipientAddress);

    const data = message
        ? new TextEncoder().encode(message)
        : new Uint8Array(0);

    const tx = Nimiq.TransactionBuilder.newBasicWithData(
        sender,
        recipient,
        data,
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
