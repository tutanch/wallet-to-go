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

export const DEFAULT_DERIVATION_PATH = "m/44'/242'/0'/0'";
export const LUNAS_PER_NIM = 1e5;

export function getSelectedNetwork() {
    return localStorage.getItem('nimiq-network') || 'main';
}

export function setSelectedNetwork(network) {
    localStorage.setItem('nimiq-network', network);
}

export function getNetworkConfig() {
    return NETWORKS[getSelectedNetwork()];
}

export function lunaToNim(luna) {
    return luna / LUNAS_PER_NIM;
}

export function nimToLuna(nim) {
    return Math.round(nim * LUNAS_PER_NIM);
}

export function formatNim(luna) {
    const nim = lunaToNim(luna);
    return nim.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}
