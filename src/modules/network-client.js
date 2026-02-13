import { loadNimiq } from '../nimiq.js';
import { getNetworkConfig, getSelectedNetwork } from '../config.js';

let clientPromise = null;
let currentNetwork = null;
let consensusListeners = [];
let headListeners = [];

export async function connect() {
    const network = getSelectedNetwork();
    if (clientPromise && currentNetwork === network) return clientPromise;

    if (clientPromise && currentNetwork !== network) {
        const oldClient = await clientPromise;
        await oldClient.disconnectNetwork();
        clientPromise = null;
    }

    currentNetwork = network;
    const config = getNetworkConfig();
    const Nimiq = await loadNimiq();

    clientPromise = (async () => {
        const clientConfig = new Nimiq.ClientConfiguration();
        clientConfig.network(config.name);
        clientConfig.seedNodes(config.seeds);
        clientConfig.syncMode('pico');
        clientConfig.logLevel('info');
        const client = await Nimiq.Client.create(clientConfig.build());

        client.addConsensusChangedListener((consensus) => {
            consensusListeners.forEach(cb => cb(consensus));
        });

        client.addHeadChangedListener((hash) => {
            headListeners.forEach(cb => cb(hash));
        });

        return client;
    })();

    return clientPromise;
}

export async function getClient() {
    if (!clientPromise) await connect();
    return clientPromise;
}

export async function waitForConsensus() {
    const client = await getClient();
    await client.waitForConsensusEstablished();
}

export async function isConsensusEstablished() {
    const client = await getClient();
    return client.isConsensusEstablished();
}

export async function getBalance(address) {
    const client = await getClient();
    await client.waitForConsensusEstablished();
    const accounts = await client.getAccounts([address]);
    return accounts[0] ? accounts[0].balance : 0;
}

export async function getHistory(address, limit = 50) {
    const client = await getClient();
    await client.waitForConsensusEstablished();
    const network = getSelectedNetwork();
    const minPeers = network === 'main' ? undefined : 1;
    return client.getTransactionsByAddress(
        address,
        undefined,
        undefined,
        undefined,
        limit,
        minPeers,
    );
}

export async function sendTransaction(tx) {
    const client = await getClient();
    await client.waitForConsensusEstablished();
    return client.sendTransaction(tx);
}

export async function getHeadHeight() {
    const client = await getClient();
    return client.getHeadHeight();
}

export async function getNetworkId() {
    const client = await getClient();
    return client.getNetworkId();
}

export function onConsensusChanged(callback) {
    consensusListeners.push(callback);
    return () => {
        consensusListeners = consensusListeners.filter(cb => cb !== callback);
    };
}

export function onHeadChanged(callback) {
    headListeners.push(callback);
    return () => {
        headListeners = headListeners.filter(cb => cb !== callback);
    };
}

export async function addTransactionListener(callback, addresses) {
    const client = await getClient();
    client.addTransactionListener(callback, addresses);
}

export async function disconnect() {
    if (clientPromise) {
        const client = await clientPromise;
        await client.disconnectNetwork();
        clientPromise = null;
        currentNetwork = null;
        consensusListeners = [];
        headListeners = [];
    }
}
