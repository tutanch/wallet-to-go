/**
 * Keyguard Polygon module — all USDC/USDT (Polygon) signing logic.
 *
 * Loaded lazily by the keyguard worker ONLY. The keyguard stays offline
 * (CSP connect-src 'none'): every piece of chain data (nonces, gas, fees,
 * relay info) arrives via request args from the wallet and is validated
 * here against hardcoded constants before anything is signed.
 *
 * SECURITY MODEL (mirrors the original Nimiq Keyguard):
 *  - The wallet sends a relayRequest whose calldata has DUMMY signature
 *    fields. This module decodes that calldata, validates every field
 *    against the hardcoded contract allowlist, and RE-ENCODES the calldata
 *    itself from the parsed values plus its own signatures. Wallet-provided
 *    bytes are never signed as-is.
 *  - The derivation path and chain id are constants — never request params.
 *  - The confirmation UI must only display values returned by
 *    decodeForDisplay() (i.e. what will actually be signed).
 */

import { ethers } from '../lib/ethers/ethers-loader.js';

// ── Hardcoded Polygon mainnet constants (NEVER accepted from the wallet) ──

export const POLYGON_CHAIN_ID = 137;
export const POLYGON_PATH = "m/44'/60'/0'/0/0";

const TOKENS = {
    usdc: {
        symbol: 'USDC',
        token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // native USDC (Circle)
        transfer: '0x3157d422cd1be13AC4a7cb00957ed717e648DFf2', // Nimiq USDC transfer contract
        method: 'transferWithPermit',
    },
    usdt: {
        symbol: 'USDT',
        token: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // bridged USDT (PoS)
        transfer: '0x98E69a6927747339d5E543586FC0262112eBe4BD', // Nimiq bridged transfer contract
        method: 'transferWithApproval',
    },
};

// Fee-gouging cap inside the trust boundary (same bounds as relay selection)
const MAX_PCT_RELAY_FEE = 70;

const USDC_TRANSFER_ABI = [
    'function transferWithPermit(address token, uint256 amount, address target, uint256 fee, uint256 value, bytes32 sigR, bytes32 sigS, uint8 sigV)',
];
const USDT_TRANSFER_ABI = [
    'function transferWithApproval(address token, uint256 amount, address target, uint256 fee, uint256 approval, bytes32 sigR, bytes32 sigS, uint8 sigV)',
];
const USDT_TOKEN_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
];

const ifaces = {
    usdc: new ethers.utils.Interface(USDC_TRANSFER_ABI),
    usdt: new ethers.utils.Interface(USDT_TRANSFER_ABI),
    usdtToken: new ethers.utils.Interface(USDT_TOKEN_ABI),
};

// ── EIP-712 type definitions (verified against the original bundles) ──────

// OpenGSN v2 RelayRequest (from @opengsn/common@2.2.5 TypedRequestData)
const GSN_DOMAIN = (verifyingContract) => ({
    name: 'GSN Relayed Transaction',
    version: '2',
    chainId: POLYGON_CHAIN_ID,
    verifyingContract,
});
const GSN_TYPES = {
    RelayRequest: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'gas', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'validUntil', type: 'uint256' },
        { name: 'relayData', type: 'RelayData' },
    ],
    RelayData: [
        { name: 'gasPrice', type: 'uint256' },
        { name: 'pctRelayFee', type: 'uint256' },
        { name: 'baseRelayFee', type: 'uint256' },
        { name: 'relayWorker', type: 'address' },
        { name: 'paymaster', type: 'address' },
        { name: 'forwarder', type: 'address' },
        { name: 'paymasterData', type: 'bytes' },
        { name: 'clientId', type: 'uint256' },
    ],
};

// ── Helpers ────────────────────────────────────────────────────────────────

function deriveWallet(mnemonicString) {
    return ethers.Wallet.fromMnemonic(mnemonicString, POLYGON_PATH);
}

export function derivePolygonAddress(mnemonicString) {
    return deriveWallet(mnemonicString).address;
}

function signatureToParts(signature) {
    return {
        sigR: signature.slice(0, 66), // 0x + 32 bytes
        sigS: `0x${signature.slice(66, 130)}`, // 32 bytes
        sigV: parseInt(signature.slice(130, 132), 16), // last byte
    };
}

function isDecimalString(value) {
    return typeof value === 'string' && /^\d+$/.test(value);
}

function assertSameAddress(a, b, what) {
    if (ethers.utils.getAddress(a) !== ethers.utils.getAddress(b)) {
        throw new Error(`Invalid Polygon request: ${what}`);
    }
}

// Format token base units (6 decimals) for display, pure string math
export function formatUnits6(unitsString) {
    const padded = unitsString.padStart(7, '0');
    const whole = padded.slice(0, -6);
    const frac = padded.slice(-6).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate a wallet-provided relay request against the hardcoded constants
 * and decode its calldata. Throws on ANY violation.
 *
 * @returns {{ cfg, parsed: { amount, target, fee, approvalValue } }} BigNumbers
 */
export function validateAndParse({ token, relayRequest }) {
    const cfg = TOKENS[token];
    if (!cfg) throw new Error(`Invalid Polygon request: unknown token "${token}"`);

    if (!relayRequest || typeof relayRequest !== 'object') {
        throw new Error('Invalid Polygon request: missing relayRequest');
    }
    const { request, relayData } = relayRequest;
    if (!request || !relayData) throw new Error('Invalid Polygon request: malformed relayRequest');

    // Address fields
    if (!ethers.utils.isAddress(request.from)) throw new Error('Invalid Polygon request: bad sender');
    if (!ethers.utils.isAddress(request.to)) throw new Error('Invalid Polygon request: bad target contract');
    if (!ethers.utils.isAddress(relayData.relayWorker)) throw new Error('Invalid Polygon request: bad relayWorker');

    // The target contract MUST be the transfer contract for this token
    assertSameAddress(request.to, cfg.transfer, 'not an allowed transfer contract');
    // Paymaster and forwarder are the transfer contract itself
    assertSameAddress(relayData.paymaster, cfg.transfer, 'paymaster mismatch');
    assertSameAddress(relayData.forwarder, cfg.transfer, 'forwarder mismatch');

    // Plain numeric string fields
    for (const [name, value] of [
        ['request.value', request.value],
        ['request.gas', request.gas],
        ['request.nonce', request.nonce],
        ['request.validUntil', request.validUntil],
        ['relayData.gasPrice', relayData.gasPrice],
        ['relayData.pctRelayFee', relayData.pctRelayFee],
        ['relayData.baseRelayFee', relayData.baseRelayFee],
        ['relayData.clientId', relayData.clientId],
    ]) {
        if (!isDecimalString(value)) throw new Error(`Invalid Polygon request: ${name} must be a decimal string`);
    }

    if (request.value !== '0') throw new Error('Invalid Polygon request: value must be 0');
    if (relayData.paymasterData !== '0x') throw new Error('Invalid Polygon request: paymasterData must be empty');

    // Relay fee bounds — a malicious wallet/relay must not gouge via relayData
    if (ethers.BigNumber.from(relayData.pctRelayFee).gt(MAX_PCT_RELAY_FEE)) {
        throw new Error('Invalid Polygon request: pctRelayFee too high');
    }
    if (relayData.baseRelayFee !== '0') {
        throw new Error('Invalid Polygon request: baseRelayFee must be 0');
    }

    // Calldata: well-formed hex, decodable as exactly the expected method
    if (typeof request.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(request.data) || request.data.length > 20000) {
        throw new Error('Invalid Polygon request: malformed calldata');
    }
    let parsedTx;
    try {
        parsedTx = ifaces[token].parseTransaction({ data: request.data });
    } catch (_) {
        throw new Error('Invalid Polygon request: calldata does not decode');
    }
    if (parsedTx.name !== cfg.method) {
        throw new Error(`Invalid Polygon request: method must be ${cfg.method}`);
    }

    const [tokenArg, amount, target, fee, approvalValue] = parsedTx.args;

    // The token being transferred must match the transfer contract used
    assertSameAddress(tokenArg, cfg.token, 'token contract mismatch');

    if (!ethers.utils.isAddress(target)) throw new Error('Invalid Polygon request: bad recipient');
    if (amount.lte(0)) throw new Error('Invalid Polygon request: amount must be positive');
    if (fee.lt(0)) throw new Error('Invalid Polygon request: negative fee');

    // The permit/approval must cover EXACTLY amount + fee — nothing more
    if (!approvalValue.eq(amount.add(fee))) {
        throw new Error('Invalid Polygon request: approval must equal amount + fee');
    }

    return {
        cfg,
        parsed: { amount, target, fee, approvalValue },
    };
}

/**
 * Decode and validate a request for display in the confirmation UI.
 * Returns plain JSON-safe strings.
 */
export function decodeForDisplay({ token, relayRequest }) {
    const { cfg, parsed } = validateAndParse({ token, relayRequest });
    return {
        tokenSymbol: cfg.symbol,
        method: cfg.method,
        amountUnits: parsed.amount.toString(),
        feeUnits: parsed.fee.toString(),
        totalUnits: parsed.amount.add(parsed.fee).toString(),
        amount: formatUnits6(parsed.amount.toString()),
        fee: formatUnits6(parsed.fee.toString()),
        total: formatUnits6(parsed.amount.add(parsed.fee).toString()),
        recipient: ethers.utils.getAddress(parsed.target),
        from: ethers.utils.getAddress(relayRequest.request.from),
    };
}

// ── EIP-712 signatures ─────────────────────────────────────────────────────

// Native USDC: EIP-2612 permit
async function signUsdcPermit(wallet, approvalAmount, tokenNonce) {
    const domain = {
        name: 'USD Coin',
        version: '2',
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: TOKENS.usdc.token,
    };
    const types = {
        Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
        ],
    };
    const message = {
        owner: wallet.address,
        spender: TOKENS.usdc.transfer,
        value: approvalAmount,
        nonce: tokenNonce,
        deadline: ethers.constants.MaxUint256,
    };
    return signatureToParts(await wallet._signTypedData(domain, types, message));
}

// Bridged USDT: Polygon MetaTransaction-style approval
async function signUsdtApproval(wallet, approvalAmount, tokenNonce) {
    const functionSignature = ifaces.usdtToken.encodeFunctionData('approve', [
        TOKENS.usdt.transfer,
        approvalAmount,
    ]);
    const domain = {
        name: 'USDT0',
        version: '1',
        verifyingContract: TOKENS.usdt.token,
        salt: ethers.utils.hexZeroPad(ethers.utils.hexlify(POLYGON_CHAIN_ID), 32),
    };
    const types = {
        MetaTransaction: [
            { name: 'nonce', type: 'uint256' },
            { name: 'from', type: 'address' },
            { name: 'functionSignature', type: 'bytes' },
        ],
    };
    const message = {
        nonce: tokenNonce,
        from: wallet.address,
        functionSignature,
    };
    return signatureToParts(await wallet._signTypedData(domain, types, message));
}

// ── Main signing entry point ───────────────────────────────────────────────

/**
 * Validate, sign the token approval (permit/meta-tx), re-encode the calldata
 * with the real signature, and sign the OpenGSN relay request.
 *
 * @param {string} mnemonicString BIP39 words, space-joined (from entropy)
 * @param {{token, relayRequest, permit?, approval?}} args wallet request
 * @returns {Promise<{relayRequest, signature}>} the final (re-encoded)
 *          relayRequest and the GSN EIP-712 signature over exactly it
 */
export async function signPolygonTransaction(mnemonicString, { token, relayRequest, permit, approval }) {
    const { cfg, parsed } = validateAndParse({ token, relayRequest });

    const nonceContainer = token === 'usdc' ? permit : approval;
    const tokenNonce = nonceContainer ? nonceContainer.tokenNonce : undefined;
    if (!Number.isInteger(tokenNonce) || tokenNonce < 0) {
        throw new Error('Invalid Polygon request: missing token nonce');
    }

    const wallet = deriveWallet(mnemonicString);

    // The sender must be OUR address — also binds the permit owner
    assertSameAddress(relayRequest.request.from, wallet.address, 'sender is not this wallet');

    // 1. Sign the approval for exactly amount + fee
    const { sigR, sigS, sigV } = token === 'usdc'
        ? await signUsdcPermit(wallet, parsed.approvalValue, tokenNonce)
        : await signUsdtApproval(wallet, parsed.approvalValue, tokenNonce);

    // 2. Re-encode the calldata from the PARSED (validated, displayed) values
    const data = ifaces[token].encodeFunctionData(cfg.method, [
        cfg.token,
        parsed.amount,
        parsed.target,
        parsed.fee,
        parsed.approvalValue,
        sigR,
        sigS,
        sigV,
    ]);

    // 3. Sign the OpenGSN relay request over the re-encoded calldata
    const message = {
        from: relayRequest.request.from,
        to: relayRequest.request.to,
        value: relayRequest.request.value,
        gas: relayRequest.request.gas,
        nonce: relayRequest.request.nonce,
        data,
        validUntil: relayRequest.request.validUntil,
        relayData: {
            gasPrice: relayRequest.relayData.gasPrice,
            pctRelayFee: relayRequest.relayData.pctRelayFee,
            baseRelayFee: relayRequest.relayData.baseRelayFee,
            relayWorker: relayRequest.relayData.relayWorker,
            paymaster: relayRequest.relayData.paymaster,
            forwarder: relayRequest.relayData.forwarder,
            paymasterData: relayRequest.relayData.paymasterData,
            clientId: relayRequest.relayData.clientId,
        },
    };

    const signature = await wallet._signTypedData(GSN_DOMAIN(cfg.transfer), GSN_TYPES, message);

    const { relayData, ...requestFields } = message;
    return {
        relayRequest: {
            request: requestFields,
            relayData,
        },
        signature,
    };
}
