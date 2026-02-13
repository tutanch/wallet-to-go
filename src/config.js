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

export const DEFAULT_DERIVATION_PATH = "m/44'/242'/0'/0'";
export const LUNAS_PER_NIM = 100000;

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
    const str = String(nim);
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
