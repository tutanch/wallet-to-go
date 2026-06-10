/**
 * Contract ABI fragments for USDC/USDT on Polygon with OpenGSN v2 gas
 * abstraction. Trimmed from the original Nimiq Wallet's ContractABIs.ts —
 * only the fragments this wallet actually calls/decodes.
 */

// Native USDC (Circle) — supports EIP-2612 permit (nonces via `nonces`)
export const USDC_TOKEN_ABI = [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function nonces(address owner) view returns (uint256)',
];

// Bridged USDT (PoS) — no permit; uses Polygon MetaTransaction approvals
// (nonces via `getNonce`). `approve` fragment is needed to encode the
// functionSignature inside the MetaTransaction.
export const USDT_TOKEN_ABI = [
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
    'function getNonce(address user) view returns (uint256 nonce)',
];

// Nimiq's USDC transfer contract (paymaster + forwarder in one)
export const USDC_TRANSFER_ABI = [
    'function getGasAndDataLimits() view returns (tuple(uint256 acceptanceBudget, uint256 preRelayedCallGasLimit, uint256 postRelayedCallGasLimit, uint256 calldataSizeLimit) limits)',
    'function getNonce(address from) view returns (uint256)',
    'function getRequiredRelayGas(bytes4 methodId) view returns (uint256 gas)',
    'function registeredTokenPool(address) view returns (address)',
    'function transferWithPermit(address token, uint256 amount, address target, uint256 fee, uint256 value, bytes32 sigR, bytes32 sigS, uint8 sigV)',
];

// Nimiq's bridged-token transfer contract (used for USDT)
export const USDT_TRANSFER_ABI = [
    'function getGasAndDataLimits() view returns (tuple(uint256 acceptanceBudget, uint256 preRelayedCallGasLimit, uint256 postRelayedCallGasLimit, uint256 calldataSizeLimit) limits)',
    'function getNonce(address from) view returns (uint256)',
    'function getRequiredRelayGas(bytes4 methodId) view returns (uint256 gas)',
    'function registeredTokenPool(address) view returns (address)',
    'function transferWithApproval(address token, uint256 amount, address target, uint256 fee, uint256 approval, bytes32 sigR, bytes32 sigS, uint8 sigV)',
];

export const RELAY_HUB_ABI = [
    'event RelayServerRegistered(address indexed relayManager, uint256 baseRelayFee, uint256 pctRelayFee, string relayUrl)',
    'event TransactionRelayed(address indexed relayManager, address indexed relayWorker, address indexed from, address to, address paymaster, bytes4 selector, uint8 status, uint256 charge)',
    'function calldataGasCost(uint256 length) view returns (uint256)',
];

export const UNISWAP_POOL_ABI = [
    'function fee() view returns (uint24)',
];

export const UNISWAP_QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)',
];
