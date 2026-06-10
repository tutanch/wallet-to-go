export const NETWORKS = {
    main: {
        name: 'mainalbatross',
        id: 24,
        seeds: [
            '/dns4/aurora.seed.nimiq.com/tcp/443/wss',
            '/dns4/catalyst.seed.nimiq.network/tcp/443/wss',
            '/dns4/cipher.seed.nimiq-network.com/tcp/443/wss',
            '/dns4/eclipse.seed.nimiq.cloud/tcp/443/wss',
            '/dns4/lumina.seed.nimiq.systems/tcp/443/wss',
            '/dns4/nebula.seed.nimiq.com/tcp/443/wss',
            '/dns4/nexus.seed.nimiq.network/tcp/443/wss',
            '/dns4/polaris.seed.nimiq-network.com/tcp/443/wss',
            '/dns4/photon.seed.nimiq.cloud/tcp/443/wss',
            '/dns4/pulsar.seed.nimiq.systems/tcp/443/wss',
            '/dns4/quasar.seed.nimiq.com/tcp/443/wss',
            '/dns4/solstice.seed.nimiq.network/tcp/443/wss',
            '/dns4/vortex.seed.nimiq.cloud/tcp/443/wss',
            '/dns4/zenith.seed.nimiq.systems/tcp/443/wss',
        ],
    },
    test: {
        name: 'testalbatross',
        id: 5,
        seeds: [
            '/dns4/seed1.pos.nimiq-testnet.com/tcp/8443/wss',
            '/dns4/seed2.pos.nimiq-testnet.com/tcp/8443/wss',
            '/dns4/seed3.pos.nimiq-testnet.com/tcp/8443/wss',
            '/dns4/seed4.pos.nimiq-testnet.com/tcp/8443/wss',
        ],
        faucetUrl: 'https://faucet.pos.nimiq-testnet.com',
    },
};

const VALID_NETWORKS = Object.keys(NETWORKS);

const LUNAS_PER_NIM = 100000;

export function getSelectedNetwork() {
    const stored = localStorage.getItem('nimiq-network');
    if (stored && VALID_NETWORKS.includes(stored)) return stored;
    return 'main';
}

export function setSelectedNetwork(network) {
    if (!VALID_NETWORKS.includes(network)) {
        throw new Error(`Invalid network: ${network}`);
    }
    localStorage.setItem('nimiq-network', network);
}

export function getNetworkConfig() {
    return NETWORKS[getSelectedNetwork()];
}

export function lunaToNim(luna) {
    return luna / LUNAS_PER_NIM;
}

// Parse NIM string to luna using integer math to avoid floating-point errors
export function nimToLuna(nim) {
    if (nim == null || nim === '') return NaN;
    const str = String(nim).trim();
    if (!/^-?(\d+\.?\d*|\d*\.\d+)$/.test(str)) return NaN;
    const isNegative = str.startsWith('-');
    const abs = isNegative ? str.slice(1) : str;
    const parts = abs.split('.');
    const whole = parseInt(parts[0] || '0', 10) * LUNAS_PER_NIM;
    let result = whole;
    if (parts[1]) {
        // Pad or truncate fractional part to 5 digits (luna precision)
        const frac = parts[1].padEnd(5, '0').substring(0, 5);
        result += parseInt(frac, 10);
    }
    return isNegative ? -result : result;
}

export function formatNim(luna) {
    const nim = lunaToNim(luna);
    return nim.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

// ─── Polygon / stablecoins (USDC + USDT with OpenGSN gas abstraction) ──────
//
// Mainnet only: Nimiq never deployed the transfer/relay contracts on Amoy
// testnet, so all stablecoin features are hidden while the Nimiq testnet is
// selected (see isStablecoinsEnabled).
//
// No data APIs: balances/history/fees come from public JSON-RPC endpoints
// (keyless, CORS-enabled) and the POL→token rate from the on-chain Uniswap v3
// quoter. The relay is part of the OpenGSN network run by Nimiq/Fastspot.
//
// NOTE: rpcUrls and relay origins MUST stay in sync with the connect-src
// allowlist in index.html's Content-Security-Policy.

export const POLYGON = {
    chainId: 137,
    rpcUrls: [
        'https://polygon-bor-rpc.publicnode.com', // general primary; logs can time out under load
        'https://gateway.tenderly.co/public/polygon', // reliable historical eth_getLogs
        'https://polygon.api.onfinality.io/public', // reliable historical eth_getLogs
        'https://polygon.drpc.org', // calls/balances; logs only near head on free tier
    ],
    // Public endpoints cap eth_getLogs at 10k blocks; some count the range
    // inclusively, so stay clearly below the limit.
    rpcMaxBlockRange: 9000,
    relayHubContract: '0x6C28AfC105e65782D9Ea6F2cA68df84C9e7d750d',
    // Known-good relays, pinged directly (registration events are only used
    // to source their fees — relays re-register infrequently).
    fallbackRelayUrls: ['https://gsn.main.fastspot.io'],
    // Relays whose origin is not in this list are never contacted (mirrors
    // the CSP connect-src allowlist, which would block them anyway).
    allowedRelayOrigins: ['https://gsn.main.fastspot.io'],
    uniswapQuoterContract: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    wpolContract: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    usdc: {
        symbol: 'USDC',
        tokenContract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        transferContract: '0x3157d422cd1be13AC4a7cb00957ed717e648DFf2',
    },
    usdt: {
        symbol: 'USDT',
        tokenContract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        transferContract: '0x98E69a6927747339d5E543586FC0262112eBe4BD',
    },
    blocksPerMinute: 30, // Polygon has 2-second blocks
};

const UNITS_PER_TOKEN = 1000000; // USDC/USDT have 6 decimals

export function isStablecoinsEnabled() {
    return getSelectedNetwork() === 'main';
}

export function unitsToToken(units) {
    return units / UNITS_PER_TOKEN;
}

// Parse token string to base units using integer math (same pattern as nimToLuna)
export function tokenToUnits(token) {
    if (token == null || token === '') return NaN;
    const str = String(token).trim();
    if (!/^-?(\d+\.?\d*|\d*\.\d+)$/.test(str)) return NaN;
    const isNegative = str.startsWith('-');
    const abs = isNegative ? str.slice(1) : str;
    const parts = abs.split('.');
    const whole = parseInt(parts[0] || '0', 10) * UNITS_PER_TOKEN;
    let result = whole;
    if (parts[1]) {
        // Pad or truncate fractional part to 6 digits (token precision)
        const frac = parts[1].padEnd(6, '0').substring(0, 6);
        result += parseInt(frac, 10);
    }
    return isNegative ? -result : result;
}

export function formatToken(units, maxDecimals = 6) {
    const token = unitsToToken(units);
    return token.toLocaleString(undefined, {
        minimumFractionDigits: 2, // common for USD amounts
        maximumFractionDigits: maxDecimals,
    });
}
