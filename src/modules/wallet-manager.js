import { loadNimiq } from '../nimiq.js';
import { DEFAULT_DERIVATION_PATH } from '../config.js';

export async function createWallet() {
    const Nimiq = await loadNimiq();
    const entropy = Nimiq.Entropy.generate();
    return entropyToWalletInfo(entropy);
}

export async function importFromMnemonic(words) {
    const Nimiq = await loadNimiq();
    const wordArray = typeof words === 'string' ? words.trim().split(/\s+/) : words;
    const entropy = Nimiq.MnemonicUtils.mnemonicToEntropy(wordArray);
    return entropyToWalletInfo(entropy);
}

export async function getMnemonic(entropy) {
    const Nimiq = await loadNimiq();
    return Nimiq.MnemonicUtils.entropyToMnemonic(entropy);
}

async function entropyToWalletInfo(entropy) {
    const Nimiq = await loadNimiq();
    const mnemonic = Nimiq.MnemonicUtils.entropyToMnemonic(entropy);
    // Derive address without keeping privateKey in the returned object —
    // privateKey is only needed at signing time and is re-derived there.
    const masterKey = entropy.toExtendedPrivateKey();
    const childKey = masterKey.derivePath(DEFAULT_DERIVATION_PATH);
    const publicKey = Nimiq.PublicKey.derive(childKey.privateKey);
    const address = publicKey.toAddress().toUserFriendlyAddress();

    return {
        entropy,
        mnemonic,
        address,
    };
}
