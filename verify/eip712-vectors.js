/**
 * EIP-712 vector suite — verifies keyguard-polygon.js against the canonical
 * @opengsn/common@2.2.5 TypedRequestData and against on-chain domain
 * separators. Runs in a one-shot Docker node container (host npm forbidden).
 *
 * The suite expects this layout inside the container:
 *   /app/keyguard/src/keyguard-polygon.js   (+ /app/keyguard/lib/ethers/*)
 *   /app/work/eip712-vectors.js             (this file; cwd)
 *
 * Run (docker cp avoids host file-sharing requirements):
 *   docker create --name kg-verify -w /app/work node:24 bash -c \
 *     "npm init -y && npm pkg set type=module && \
 *      npm install ethers@5.7.2 @opengsn/common@2.2.5 && node eip712-vectors.js"
 *   docker cp <staged-tree>/. kg-verify:/app && docker start -a kg-verify
 *
 * Never touches private funds: signs with a throwaway test mnemonic.
 */

import { createRequire } from 'module';
import assert from 'assert';

const require = createRequire(import.meta.url);
const { ethers } = await import('/app/keyguard/lib/ethers/ethers-loader.js');
const polygon = await import('/app/keyguard/src/keyguard-polygon.js');

const { TypedRequestData } = require('@opengsn/common/dist/EIP712/TypedRequestData');

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const USDC_TRANSFER = '0x3157d422cd1be13AC4a7cb00957ed717e648DFf2';
const USDT_TRANSFER = '0x98E69a6927747339d5E543586FC0262112eBe4BD';

// Throwaway deterministic test wallet (24 words from fixed entropy)
const TEST_MNEMONIC = ethers.utils.entropyToMnemonic(
    '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);
const testWallet = ethers.Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/0");
console.log('test wallet:', testWallet.address);

let passed = 0;
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }

// ── Fixture builders (simulate the WALLET side) ────────────────────────────

const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const RECIPIENT = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

function buildFixture(token) {
    const cfg = token === 'usdc'
        ? { token: USDC, transfer: USDC_TRANSFER, method: 'transferWithPermit', abi: 'function transferWithPermit(address token, uint256 amount, address target, uint256 fee, uint256 value, bytes32 sigR, bytes32 sigS, uint8 sigV)' }
        : { token: USDT, transfer: USDT_TRANSFER, method: 'transferWithApproval', abi: 'function transferWithApproval(address token, uint256 amount, address target, uint256 fee, uint256 approval, bytes32 sigR, bytes32 sigS, uint8 sigV)' };
    const iface = new ethers.utils.Interface([cfg.abi]);
    const amount = ethers.BigNumber.from(100000); // 0.10
    const fee = ethers.BigNumber.from(20846); // 0.020846
    const data = iface.encodeFunctionData(cfg.method, [
        cfg.token, amount, RECIPIENT, fee, amount.add(fee), ZERO32, ZERO32, 0,
    ]);
    return {
        cfg,
        iface,
        amount,
        fee,
        relayRequest: {
            request: {
                from: testWallet.address,
                to: cfg.transfer,
                data,
                value: '0',
                nonce: '4',
                gas: '500000',
                validUntil: '88300000',
            },
            relayData: {
                gasPrice: '308000000000',
                pctRelayFee: '70',
                baseRelayFee: '0',
                relayWorker: '0x750dd91b9948792c0850c83b059e9abaefa243c0',
                paymaster: cfg.transfer,
                paymasterData: '0x',
                clientId: '123456',
                forwarder: cfg.transfer,
            },
        },
    };
}

// ── 1. decodeForDisplay matches fixture ────────────────────────────────────

{
    const { relayRequest } = buildFixture('usdc');
    const decoded = polygon.decodeForDisplay({ token: 'usdc', relayRequest });
    assert.strictEqual(decoded.tokenSymbol, 'USDC');
    assert.strictEqual(decoded.amountUnits, '100000');
    assert.strictEqual(decoded.feeUnits, '20846');
    assert.strictEqual(decoded.totalUnits, '120846');
    assert.strictEqual(decoded.amount, '0.1');
    assert.strictEqual(decoded.fee, '0.020846');
    assert.strictEqual(decoded.recipient, RECIPIENT);
    assert.strictEqual(decoded.from, testWallet.address);
    ok('decodeForDisplay (USDC) parses the calldata correctly');
}

// ── 2. Validation rejects tampering ────────────────────────────────────────

{
    const cases = [
        ['wrong transfer contract', (f) => { f.relayRequest.request.to = RECIPIENT; }],
        ['paymaster mismatch', (f) => { f.relayRequest.relayData.paymaster = RECIPIENT; }],
        ['forwarder mismatch', (f) => { f.relayRequest.relayData.forwarder = RECIPIENT; }],
        ['nonzero request.value', (f) => { f.relayRequest.request.value = '1'; }],
        ['nonempty paymasterData', (f) => { f.relayRequest.relayData.paymasterData = '0xdead'; }],
        ['pctRelayFee too high', (f) => { f.relayRequest.relayData.pctRelayFee = '71'; }],
        ['nonzero baseRelayFee', (f) => { f.relayRequest.relayData.baseRelayFee = '1'; }],
        ['token/contract mismatch', (f) => {
            // calldata claims to move USDT through the USDC transfer contract
            f.relayRequest.request.data = f.iface.encodeFunctionData(f.cfg.method, [
                USDT, f.amount, RECIPIENT, f.fee, f.amount.add(f.fee), ZERO32, ZERO32, 0,
            ]);
        }],
        ['approval exceeds amount+fee', (f) => {
            f.relayRequest.request.data = f.iface.encodeFunctionData(f.cfg.method, [
                f.cfg.token, f.amount, RECIPIENT, f.fee, ethers.constants.MaxUint256, ZERO32, ZERO32, 0,
            ]);
        }],
        ['zero amount', (f) => {
            f.relayRequest.request.data = f.iface.encodeFunctionData(f.cfg.method, [
                f.cfg.token, 0, RECIPIENT, f.fee, f.fee, ZERO32, ZERO32, 0,
            ]);
        }],
        ['hex gas field', (f) => { f.relayRequest.request.gas = '0x7a120'; }],
    ];
    for (const [name, tamper] of cases) {
        const fixture = buildFixture('usdc');
        tamper(fixture);
        assert.throws(
            () => polygon.validateAndParse({ token: 'usdc', relayRequest: fixture.relayRequest }),
            /Invalid Polygon request/,
            `expected rejection: ${name}`,
        );
    }
    ok(`validateAndParse rejects all ${cases.length} tampered requests`);
}

// ── 3. GSN signature parity with @opengsn/common ───────────────────────────

async function gsnParity(token) {
    const fixture = buildFixture(token);
    const result = await polygon.signPolygonTransaction(TEST_MNEMONIC, {
        token,
        relayRequest: fixture.relayRequest,
        ...(token === 'usdc' ? { permit: { tokenNonce: 7 } } : { approval: { tokenNonce: 3 } }),
    });

    // 3a. Re-encoded data differs from the dummy-sig data ONLY in sig slots.
    // Layout: selector(4) + 5 static words (token, amount, target, fee, value)
    // = 4 + 160 bytes = 2 + 328 hex chars prefix.
    const prefixLen = 2 + (4 + 5 * 32) * 2;
    assert.strictEqual(
        result.relayRequest.request.data.slice(0, prefixLen),
        fixture.relayRequest.request.data.slice(0, prefixLen),
        'data prefix (validated args) must be unchanged',
    );
    assert.notStrictEqual(result.relayRequest.request.data, fixture.relayRequest.request.data);
    assert.strictEqual(result.relayRequest.request.data.length, fixture.relayRequest.request.data.length);
    ok(`re-encoded calldata byte-diff is sig slots only (${token.toUpperCase()})`);

    // 3b. Canonical signature via @opengsn/common over the SAME final request
    const transferContract = fixture.cfg.transfer;
    const typedData = new TypedRequestData(137, transferContract, {
        request: result.relayRequest.request,
        relayData: result.relayRequest.relayData,
    });
    const { EIP712Domain, ...cleanedTypes } = typedData.types;
    const canonical = await testWallet._signTypedData(typedData.domain, cleanedTypes, typedData.message);
    assert.strictEqual(result.signature, canonical, 'GSN signature must match @opengsn/common TypedRequestData');
    ok(`GSN EIP-712 signature parity with @opengsn/common (${token.toUpperCase()})`);

    // 3c. Signature recovers our address over our hand-defined types
    const GSN_TYPES = {
        RelayRequest: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' }, { name: 'gas', type: 'uint256' },
            { name: 'nonce', type: 'uint256' }, { name: 'data', type: 'bytes' },
            { name: 'validUntil', type: 'uint256' }, { name: 'relayData', type: 'RelayData' },
        ],
        RelayData: [
            { name: 'gasPrice', type: 'uint256' }, { name: 'pctRelayFee', type: 'uint256' },
            { name: 'baseRelayFee', type: 'uint256' }, { name: 'relayWorker', type: 'address' },
            { name: 'paymaster', type: 'address' }, { name: 'forwarder', type: 'address' },
            { name: 'paymasterData', type: 'bytes' }, { name: 'clientId', type: 'uint256' },
        ],
    };
    const recovered = ethers.utils.verifyTypedData(
        { name: 'GSN Relayed Transaction', version: '2', chainId: 137, verifyingContract: transferContract },
        GSN_TYPES,
        { ...result.relayRequest.request, relayData: result.relayRequest.relayData },
        result.signature,
    );
    assert.strictEqual(recovered, testWallet.address);
    ok(`GSN signature recovers the signer (${token.toUpperCase()})`);

    return result;
}

const usdcResult = await gsnParity('usdc');
await gsnParity('usdt');

// ── 4. Permit signature embedded in calldata recovers signer ───────────────

{
    const iface = new ethers.utils.Interface([
        'function transferWithPermit(address token, uint256 amount, address target, uint256 fee, uint256 value, bytes32 sigR, bytes32 sigS, uint8 sigV)',
    ]);
    const args = iface.parseTransaction({ data: usdcResult.relayRequest.request.data }).args;
    const [, amount, , fee, value, sigR, sigS, sigV] = args;
    const recovered = ethers.utils.verifyTypedData(
        { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC },
        {
            Permit: [
                { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
                { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ],
        },
        {
            owner: testWallet.address,
            spender: USDC_TRANSFER,
            value,
            nonce: 7,
            deadline: ethers.constants.MaxUint256,
        },
        ethers.utils.joinSignature({ r: sigR, s: sigS, v: sigV }),
    );
    assert.strictEqual(recovered, testWallet.address);
    assert.ok(value.eq(amount.add(fee)));
    ok('embedded USDC permit signature recovers the signer for amount+fee');
}

// ── 5. On-chain domain separators ──────────────────────────────────────────

async function ethCall(to, data) {
    const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const { result, error } = await response.json();
    if (error) throw new Error(`eth_call failed: ${error.message}`);
    return result;
}

{
    // USDC: DOMAIN_SEPARATOR() selector 0x3644e515
    const onChain = await ethCall(USDC, '0x3644e515');
    const ours = ethers.utils._TypedDataEncoder.hashDomain({
        name: 'USD Coin', version: '2', chainId: 137, verifyingContract: USDC,
    });
    assert.strictEqual(onChain, ours, 'USDC domain separator mismatch');
    ok('USDC permit domain matches on-chain DOMAIN_SEPARATOR()');
}

{
    // USDT: getDomainSeperator() selector (contract's spelling)
    const selector = ethers.utils.id('getDomainSeperator()').slice(0, 10);
    const onChain = await ethCall(USDT, selector);
    const ours = ethers.utils._TypedDataEncoder.hashDomain({
        name: 'USDT0',
        version: '1',
        verifyingContract: USDT,
        salt: ethers.utils.hexZeroPad(ethers.utils.hexlify(137), 32),
    });
    assert.strictEqual(onChain, ours, 'USDT domain separator mismatch');
    ok('USDT meta-tx domain matches on-chain getDomainSeperator()');
}

// ── 6. Derivation vector (stable reference for in-app cross-check) ─────────

{
    const address = polygon.derivePolygonAddress(TEST_MNEMONIC);
    assert.strictEqual(address, testWallet.address);
    console.log(`  ✓ derivation vector: ${TEST_MNEMONIC.split(' ').slice(0, 3).join(' ')}… → ${address}`);
    passed += 1;
}

console.log(`\nALL ${passed} EIP-712 VECTOR CHECKS PASSED`);
