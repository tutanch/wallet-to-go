/**
 * GSN relay fee calculation — a port of the original wallet's calculateFee
 * (ethers.ts) + getUsdPrice (lib/usdc/Uniswap.ts).
 *
 * Entirely on-chain: the POL→USDC/USDT rate comes from the Uniswap v3
 * quoter (the same pool the transfer contract itself uses to charge the
 * fee), never from a price API. All math in ethers BigNumber.
 */

import { POLYGON } from '../../config.js';
import {
    getEthers,
    getProvider,
    getContracts,
} from './polygon-client.js';
import { UNISWAP_POOL_ABI } from './polygon-abis.js';
import { findRelay, refreshRelay } from './gsn-relay.js';

// Byte size of the wrapper relay transaction's calldata (incl. 4-byte
// relayCall selector) — from the original wallet's dataSize table.
const DATA_SIZE = {
    transferWithPermit: 1220,
    transferWithApproval: 1220,
};

// Mainnet buffer percentages (the testnet variants don't apply — stablecoins
// are mainnet-only in this wallet)
const GAS_PRICE_BUFFER_PCT = 110; // +10%
const UNISWAP_BUFFER_PCT = 110; // +10%

const TOKENS = {
    usdc: { config: POLYGON.usdc, transferName: 'usdcTransfer', method: 'transferWithPermit' },
    usdt: { config: POLYGON.usdt, transferName: 'usdtTransfer', method: 'transferWithApproval' },
};

export function getTokenInfo(token) {
    const info = TOKENS[token];
    if (!info) throw new Error(`Unknown token: ${token}`);
    return info;
}

// Memoized per token: the Uniswap pool address + fee tier are static
const poolCache = new Map();

async function getPool(token) {
    if (poolCache.has(token)) return poolCache.get(token);
    const ethers = await getEthers();
    const { config, transferName } = getTokenInfo(token);
    const contracts = await getContracts();
    const poolAddress = await contracts[transferName].registeredTokenPool(config.tokenContract);
    const poolContract = new ethers.Contract(poolAddress, UNISWAP_POOL_ABI, await getProvider());
    const poolFee = await poolContract.fee();
    const pool = { address: poolAddress, fee: poolFee };
    poolCache.set(token, pool);
    return pool;
}

/**
 * On-chain POL price of the token: POL-wei received for 1 token base unit
 * (BigNumber), via the Uniswap v3 quoter.
 */
export async function getUsdPrice(token) {
    const { config } = getTokenInfo(token);
    const { quoter } = await getContracts();
    const pool = await getPool(token);

    // POL amount that would be received for swapping 1 whole USDC/USDT
    const polFor1Token = await quoter.callStatic.quoteExactInputSingle(
        config.tokenContract, // in
        POLYGON.wpolContract, // out
        pool.fee,
        1000000, // 1 USDC/T (6 decimals)
        0,
    );

    // Per smallest unit (dividing the input instead would round to 0)
    return polFor1Token.div(1000000);
}

/**
 * The Uniswap pool address the transfer contract charges fees through —
 * used by history syncing to recognize fee transfer logs.
 */
export async function getFeePoolAddress(token) {
    return (await getPool(token)).address;
}

/**
 * Calculate the relay fee in token base units.
 *
 * @param {'usdc'|'usdt'} token
 * @param {object} [forceRelay] reuse a previously found relay (it is
 *        re-pinged so its minGasPrice is fresh)
 * @returns {Promise<{fee, chainTokenFee, gasPrice, gasLimit, relay, usdPrice}>}
 */
export async function calculateFee(token, forceRelay) {
    const { transferName, method } = getTokenInfo(token);
    const contracts = await getContracts();
    const transferContract = contracts[transferName];
    const provider = await getProvider();

    const [
        networkGasPrice,
        gasLimit,
        [acceptanceBudget],
        dataGasCost,
        usdPrice,
    ] = await Promise.all([
        provider.getGasPrice(),
        transferContract.getRequiredRelayGas(transferContract.interface.getSighash(method)),
        transferContract.getGasAndDataLimits(),
        contracts.relayHub.calldataGasCost(DATA_SIZE[method]),
        getUsdPrice(token),
    ]);

    const requiredMaxAcceptanceBudget = acceptanceBudget.add(dataGasCost);

    const relay = forceRelay
        ? await refreshRelay(forceRelay, requiredMaxAcceptanceBudget)
        : await findRelay(requiredMaxAcceptanceBudget);

    // gasPrice = max(network, relay minimum) + buffer
    let gasPrice = networkGasPrice.gte(relay.minGasPrice) ? networkGasPrice : relay.minGasPrice;
    gasPrice = gasPrice.mul(GAS_PRICE_BUFFER_PCT).div(100);

    // (gasPrice * gasLimit) * (1 + pctRelayFee/100) + baseRelayFee — in POL wei
    const chainTokenFee = gasPrice.mul(gasLimit).mul(relay.pctRelayFee.add(100)).div(100)
        .add(relay.baseRelayFee);

    // Convert POL wei → token base units via the on-chain rate, + buffer
    const fee = chainTokenFee.div(usdPrice).mul(UNISWAP_BUFFER_PCT).div(100);

    return {
        fee,
        chainTokenFee,
        gasPrice,
        gasLimit,
        relay,
        usdPrice,
    };
}
