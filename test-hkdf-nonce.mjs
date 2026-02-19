// Test: verify that the HKDF derivation produces DIFFERENT entropy
// when given different nonces (userId), even with the SAME PRF output.
//
// This reproduces the logic in keyguard-worker.js deriveEntropyFromPrf()

const HKDF_SALT = new TextEncoder().encode('nimiq-wallet-hkdf-v1');
const HKDF_INFO = new TextEncoder().encode('cross-device-entropy');

async function deriveEntropyFromPrf(prfKeyBytes, nonce) {
    const ikm = await crypto.subtle.importKey(
        'raw', new Uint8Array(prfKeyBytes), 'HKDF', false, ['deriveBits'],
    );
    let info = HKDF_INFO;
    if (nonce && nonce.length > 0) {
        const combined = new Uint8Array(HKDF_INFO.length + nonce.length);
        combined.set(HKDF_INFO);
        combined.set(new Uint8Array(nonce), HKDF_INFO.length);
        info = combined;
    }
    const derived = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
        ikm,
        256,
    );
    return new Uint8Array(derived);
}

function toHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Simulate: same PRF key (as if macOS reuses the same passkey credential)
const fakePrfKey = crypto.getRandomValues(new Uint8Array(32));

console.log('=== HKDF Nonce Derivation Test ===\n');
console.log('PRF key (simulated):', toHex(fakePrfKey));

// Test 1: No nonce (old-style wallet) — should always give the same result
const entropy1a = await deriveEntropyFromPrf(fakePrfKey, null);
const entropy1b = await deriveEntropyFromPrf(fakePrfKey, null);
console.log('\n--- Test 1: No nonce (backward compat) ---');
console.log('Entropy A:', toHex(entropy1a));
console.log('Entropy B:', toHex(entropy1b));
console.log('Same?', toHex(entropy1a) === toHex(entropy1b) ? 'YES ✓' : 'NO ✗ (BUG)');

// Test 2: Same nonce — should give the same result
const nonce1 = crypto.getRandomValues(new Uint8Array(32));
const entropy2a = await deriveEntropyFromPrf(fakePrfKey, nonce1);
const entropy2b = await deriveEntropyFromPrf(fakePrfKey, nonce1);
console.log('\n--- Test 2: Same nonce ---');
console.log('Nonce:', toHex(nonce1));
console.log('Entropy A:', toHex(entropy2a));
console.log('Entropy B:', toHex(entropy2b));
console.log('Same?', toHex(entropy2a) === toHex(entropy2b) ? 'YES ✓' : 'NO ✗ (BUG)');

// Test 3: Different nonces — MUST give different results
const nonce2 = crypto.getRandomValues(new Uint8Array(32));
const nonce3 = crypto.getRandomValues(new Uint8Array(32));
const entropy3a = await deriveEntropyFromPrf(fakePrfKey, nonce2);
const entropy3b = await deriveEntropyFromPrf(fakePrfKey, nonce3);
console.log('\n--- Test 3: Different nonces (the critical test) ---');
console.log('Nonce A:', toHex(nonce2));
console.log('Nonce B:', toHex(nonce3));
console.log('Entropy A:', toHex(entropy3a));
console.log('Entropy B:', toHex(entropy3b));
console.log('Different?', toHex(entropy3a) !== toHex(entropy3b) ? 'YES ✓' : 'NO ✗ (BUG!)');

// Test 4: Nonce vs no-nonce — should be different
const entropy4a = await deriveEntropyFromPrf(fakePrfKey, null);
const entropy4b = await deriveEntropyFromPrf(fakePrfKey, nonce1);
console.log('\n--- Test 4: Nonce vs no-nonce ---');
console.log('Entropy (no nonce):', toHex(entropy4a));
console.log('Entropy (with nonce):', toHex(entropy4b));
console.log('Different?', toHex(entropy4a) !== toHex(entropy4b) ? 'YES ✓' : 'NO ✗ (BUG!)');

// Test 5: Simulate the REAL scenario — what happens when macOS reuses the
// credential but we pass a NEW userId each time?
console.log('\n--- Test 5: Simulating macOS credential reuse ---');
console.log('(Same PRF key = macOS gave us the same credential)');
const userId1 = crypto.getRandomValues(new Uint8Array(32));
const userId2 = crypto.getRandomValues(new Uint8Array(32));
const userId3 = crypto.getRandomValues(new Uint8Array(32));
const wallet1 = await deriveEntropyFromPrf(fakePrfKey, userId1);
const wallet2 = await deriveEntropyFromPrf(fakePrfKey, userId2);
const wallet3 = await deriveEntropyFromPrf(fakePrfKey, userId3);
console.log('Wallet 1:', toHex(wallet1));
console.log('Wallet 2:', toHex(wallet2));
console.log('Wallet 3:', toHex(wallet3));
const allDifferent = toHex(wallet1) !== toHex(wallet2) &&
                     toHex(wallet2) !== toHex(wallet3) &&
                     toHex(wallet1) !== toHex(wallet3);
console.log('All different?', allDifferent ? 'YES ✓' : 'NO ✗ (BUG!)');

// Test 6: But what happens on RESTORE? The userHandle returned by get()
// should match the userId used during create(). If macOS OVERWRITES the
// credential, the userHandle will be from the LAST create(), not the first.
console.log('\n--- Test 6: Cross-device restore scenario ---');
console.log('If macOS overwrites the credential, get() returns the LAST userId');
console.log('Wallet created with userId1:', toHex(wallet1));
console.log('But if we restore and get userId3 back (last created):');
const restored = await deriveEntropyFromPrf(fakePrfKey, userId3);
console.log('Restored wallet:', toHex(restored));
console.log('Matches wallet 3?', toHex(restored) === toHex(wallet3) ? 'YES ✓' : 'NO ✗');
console.log('Matches wallet 1?', toHex(restored) === toHex(wallet1) ? 'YES (problem!)' : 'NO (correct — wallet 1 is lost if overwritten)');

console.log('\n=== CONCLUSION ===');
console.log('The HKDF nonce derivation is correct — different nonces produce different wallets.');
console.log('');
console.log('THE REAL QUESTION is:');
console.log('When macOS/iCloud Keychain "reuses" a passkey for the same RP:');
console.log('  1. Does it OVERWRITE the old credential (replacing userHandle)?');
console.log('     → Then wallet 1 is lost, only wallet 3 can be restored');
console.log('  2. Does it create a NEW credential alongside the old one?');
console.log('     → Both can be restored via the passkey picker');
console.log('  3. Does navigator.credentials.create() silently RETURN the old credential?');
console.log('     → The random userId we generate is IGNORED, old userHandle is kept');
console.log('     → THIS would explain "always the same wallet"!');
console.log('');
console.log('Scenario 3 is the most likely culprit. We need to verify in the browser.');
