/**
 * USDC/USDT send orchestration — port of the original wallet's
 * createTransactionRequest + sendTransaction (ethers.ts).
 *
 * Flow: fetch nonces → calculate fee (on-chain) → build relayRequest with
 * DUMMY signature fields → keyguard validates/displays/signs and re-encodes
 * the calldata → POST to the GSN relay → backup-broadcast the relay's signed
 * tx → wait for the receipt.
 */

import { POLYGON } from '../../config.js';
import { signPolygonTransaction } from '../keyguard-api.js';
import {
    getEthers,
    getProvider,
    getContracts,
    getBlockNumber,
    getStablecoinBalances,
} from './polygon-client.js';
import { calculateFee, getTokenInfo } from './gsn-fee.js';
import { relayTransaction } from './gsn-relay.js';

const VALID_UNTIL_BLOCKS = 2 * 60 * POLYGON.blocksPerMinute; // 2 hours

const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Fee estimate for the send form. Returns the relay too so the actual send
 * can reuse it (it gets re-pinged then).
 */
export async function estimateFee(token) {
    const { fee, relay } = await calculateFee(token);
    return { feeUnits: fee.toNumber(), relay };
}

/**
 * Build the relayRequest (with dummy signature fields) and everything the
 * keyguard needs. Amount is clamped so amount + fee fits the balance.
 */
export async function createTransferRequest({ token, from, recipient, amountUnits, relay }) {
    const { config, transferName, method } = getTokenInfo(token);
    const contracts = await getContracts();
    const tokenContract = token === 'usdc' ? contracts.usdcToken : contracts.usdtToken;
    const transferContract = contracts[transferName];

    const [tokenNonce, forwarderNonce, { fee, gasPrice, gasLimit, relay: freshRelay }, balances] = await Promise.all([
        // USDC (EIP-2612): nonces() — USDT (meta-tx): getNonce()
        token === 'usdc' ? tokenContract.nonces(from) : tokenContract.getNonce(from),
        transferContract.getNonce(from),
        calculateFee(token, relay),
        getStablecoinBalances(from),
    ]);

    // Ensure we send only what is possible with the final fee
    const balance = balances[token];
    const amount = Math.min(amountUnits, balance - fee.toNumber());
    if (amount <= 0) throw new Error('Insufficient balance to cover amount and fee');

    // Calldata with DUMMY signature fields — the keyguard re-encodes it with
    // real signatures after validating and displaying the parsed values.
    const data = transferContract.interface.encodeFunctionData(method, [
        config.tokenContract,
        amount,
        recipient,
        fee,
        fee.add(amount), // permit/approval value: exactly amount + fee
        ZERO32,
        ZERO32,
        0,
    ]);

    const relayRequest = {
        request: {
            from,
            to: config.transferContract,
            data,
            value: '0',
            nonce: forwarderNonce.toString(),
            gas: gasLimit.toString(),
            validUntil: ((await getBlockNumber()) + VALID_UNTIL_BLOCKS).toString(10),
        },
        relayData: {
            gasPrice: gasPrice.toString(),
            pctRelayFee: freshRelay.pctRelayFee.toString(),
            baseRelayFee: freshRelay.baseRelayFee.toString(),
            relayWorker: freshRelay.relayWorkerAddress,
            paymaster: config.transferContract,
            paymasterData: '0x',
            clientId: String(Math.floor(Math.random() * 1e6)),
            forwarder: config.transferContract,
        },
    };

    return {
        relayRequest,
        relayUrl: freshRelay.url,
        tokenNonce: tokenNonce.toNumber(),
        amountUnits: amount,
        feeUnits: fee.toNumber(),
    };
}

/**
 * Full send flow. onStatus(label) reports progress to the UI.
 * @returns {Promise<{txHash: string, receipt: object, amountUnits: number, feeUnits: number}>}
 */
export async function sendStablecoin({ token, from, recipient, amountUnits, relay, onStatus = () => {} }) {
    const ethers = await getEthers();

    onStatus('Preparing transaction...');
    const request = await createTransferRequest({ token, from, recipient, amountUnits, relay });

    onStatus('Waiting for confirmation...');
    // The keyguard validates, displays, re-encodes the calldata and signs.
    // ALWAYS use the returned relayRequest — it contains the signed calldata.
    const { relayRequest: signedRequest, signature } = await signPolygonTransaction({
        token,
        relayRequest: request.relayRequest,
        ...(token === 'usdc'
            ? { permit: { tokenNonce: request.tokenNonce } }
            : { approval: { tokenNonce: request.tokenNonce } }),
    });

    onStatus('Relaying...');
    const signedTx = await relayTransaction(request.relayUrl, signedRequest, signature);

    onStatus('Confirming...');
    const provider = await getProvider();
    const txHash = ethers.utils.parseTransaction(signedTx).hash;

    // Backup broadcast — "already known"/"nonce too low" errors are expected
    // when the relay broadcasts first.
    let txResponse = await provider.sendTransaction(signedTx).catch(() => null);

    // Poll until the network knows the transaction (relay broadcast path)
    const POLL_TIMEOUT = Date.now() + 60000;
    while (!txResponse) {
        if (Date.now() > POLL_TIMEOUT) throw new Error('Relay transaction did not appear on the network');
        // eslint-disable-next-line no-await-in-loop
        txResponse = await provider.getTransaction(txHash);
        // eslint-disable-next-line no-await-in-loop
        if (!txResponse) await new Promise((resolve) => { setTimeout(resolve, 1000); });
    }

    const receipt = await txResponse.wait(1);

    return {
        txHash,
        receipt,
        amountUnits: request.amountUnits,
        feeUnits: request.feeUnits,
    };
}
