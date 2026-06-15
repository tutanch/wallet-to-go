// In-keyguard WebAuthn ceremony.
//
// Runs navigator.credentials.create()/.get() INSIDE the keyguard origin so the
// PRF output — which is the wallet's master secret (it derives the entropy via
// HKDF, or is the AES key wrapping it) — never transits the wallet origin.
//
// This is the alternative to the wallet-origin delegation in
// `src/modules/webauthn.js`. The logic here is a faithful port of that module;
// the only difference is that it calls navigator.credentials directly instead of
// over postMessage. It is gated behind CEREMONY_IN_KEYGUARD in keyguard-app.js,
// and is also exercised by the #webauthnspike self-test regardless of that flag.
//
// REQUIREMENT: the embedding wallet must grant this frame the capability via the
// iframe Permissions-Policy attribute:
//   allow="publickey-credentials-get <kg-origin>; publickey-credentials-create <kg-origin>"
// (added in src/modules/keyguard-api.js#createKeyguardFrame). Without it, the
// browser rejects navigator.credentials in this cross-origin iframe.

const WEBAUTHN_RP_NAME = 'Nimiq Wallet';

// RP ID for the credentials. null → defaults to THIS (keyguard) origin's domain.
//
// On *.github.io this MUST stay null: github.io is on the Public Suffix List, so
// the only valid rp.id for the keyguard origin is its own full host (which is the
// default). The wallet and keyguard origins therefore cannot share credentials.
//
// If both origins are ever moved under a shared registrable parent domain
// (e.g. wallet.example.com + keyguard.example.com), set this to that parent
// (e.g. 'example.com') to make passkeys portable across the two origins. This is
// the single line that governs RP-ID portability.
const RP_ID = null;

function rpEntity() {
    return RP_ID ? { name: WEBAUTHN_RP_NAME, id: RP_ID } : { name: WEBAUTHN_RP_NAME };
}

export function isWebAuthnAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials);
}

export async function isPrfSupported() {
    if (!isWebAuthnAvailable()) return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!available) return false;
    }
    return true;
}

export async function createCredential({ userId, userName, prfSalt, excludeCredentialIds }) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const salt = new Uint8Array(prfSalt);

    const excludeCredentials = (excludeCredentialIds || []).map(id => ({
        type: 'public-key',
        id: new Uint8Array(id),
    }));

    const credential = await navigator.credentials.create({
        publicKey: {
            rp: rpEntity(),
            user: {
                id: new Uint8Array(userId),
                name: userName,
                displayName: 'Nimiq Wallet',
            },
            challenge,
            pubKeyCredParams: [
                { alg: -7, type: 'public-key' },   // ES256
                { alg: -257, type: 'public-key' },  // RS256
            ],
            authenticatorSelection: {
                userVerification: 'required',
                residentKey: 'required',
            },
            excludeCredentials,
            extensions: {
                prf: { eval: { first: salt } },
            },
        },
    });

    const extResults = credential.getClientExtensionResults();
    if (!extResults.prf?.enabled) {
        throw new Error('PRF_NOT_SUPPORTED');
    }

    const credentialId = Array.from(new Uint8Array(credential.rawId));

    // ALWAYS re-derive the PRF via get() — create()'s PRF output can differ from
    // get()'s on some platforms (especially synced passkeys), which would make
    // the wallet address unreproducible on restore. The extra biometric prompt
    // is the price of correctness. (Mirrors src/modules/webauthn.js.)
    const prfKey = await getPrfKey({ credentialId, prfSalt });
    return { credentialId, prfKey };
}

export async function getPrfKey({ credentialId, prfSalt }) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge,
            allowCredentials: [{
                type: 'public-key',
                id: new Uint8Array(credentialId),
            }],
            userVerification: 'required',
            extensions: {
                prf: { eval: { first: new Uint8Array(prfSalt) } },
            },
        },
    });

    const extResults = assertion.getClientExtensionResults();
    const prfResult = extResults.prf?.results?.first;
    if (!prfResult) throw new Error('PRF output not available');
    return Array.from(new Uint8Array(prfResult));
}

export async function getDiscoverablePrfKey(prfSalt) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge,
            userVerification: 'required',
            extensions: {
                prf: { eval: { first: new Uint8Array(prfSalt) } },
            },
        },
    });

    const extResults = assertion.getClientExtensionResults();
    const prfResult = extResults.prf?.results?.first;
    if (!prfResult) throw new Error('PRF output not available');
    return {
        prfKey: Array.from(new Uint8Array(prfResult)),
        credentialId: Array.from(new Uint8Array(assertion.rawId)),
    };
}

// ── Spike self-test ─────────────────────────────────────────────────────────
// SPIKE — remove after eval. Runs a full create()+get() PRF ceremony in THIS
// (keyguard) origin and returns a structured result so we can measure whether
// in-iframe WebAuthn works on a given browser (the decisive case is iOS Safari).
// Each call registers a REAL throwaway discoverable credential that cannot be
// deleted via JS — clean it up manually afterward (see the plan). The flag does
// not gate this; it always runs locally.

function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

export async function selfTest(prfSalt) {
    const result = {
        createOk: false,
        getOk: false,
        prfEnabledOnCreate: false,
        prfPresentOnCreate: false,
        prfPresentOnGet: false,
        prfMatch: false,
        largeBlobSupported: false,
        largeBlobWritten: false,
        largeBlobReadOk: false,
        errorName: null,
        errorMessage: null,
        isUVPAA: null,
        credIdB64: null,
        userAgent: navigator.userAgent,
        origin: location.origin,
    };

    try {
        if (typeof PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
            result.isUVPAA = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        }
    } catch (_) { /* leave null */ }

    const salt = new Uint8Array(prfSalt);
    let createPrf = null;
    let credentialId = null;

    // ── create() ──
    try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const userId = crypto.getRandomValues(new Uint8Array(16));
        const credential = await navigator.credentials.create({
            publicKey: {
                rp: rpEntity(),
                user: { id: userId, name: 'spike-selftest', displayName: 'Nimiq Wallet' },
                challenge,
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },
                    { alg: -257, type: 'public-key' },
                ],
                authenticatorSelection: { userVerification: 'required', residentKey: 'required' },
                extensions: { prf: { eval: { first: salt } }, largeBlob: { support: 'preferred' } },
            },
        });
        result.createOk = true;
        const ext = credential.getClientExtensionResults();
        result.prfEnabledOnCreate = !!ext.prf?.enabled;
        result.largeBlobSupported = !!ext.largeBlob?.supported;
        createPrf = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : null;
        result.prfPresentOnCreate = !!createPrf;
        credentialId = new Uint8Array(credential.rawId);
        result.credIdB64 = toB64(credentialId);
    } catch (err) {
        result.errorName = err?.name || null;
        result.errorMessage = err?.message || String(err);
        return result; // no credential → can't run get()
    }

    // ── get() #1 — PRF output + (if supported) largeBlob write ──
    const testBlob = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    try {
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const exts = { prf: { eval: { first: salt } } };
        if (result.largeBlobSupported) exts.largeBlob = { write: testBlob };
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ type: 'public-key', id: credentialId }],
                userVerification: 'required',
                extensions: exts,
            },
        });
        result.getOk = true;
        const ext = assertion.getClientExtensionResults();
        const getPrf = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : null;
        result.prfPresentOnGet = !!getPrf;
        if (createPrf && getPrf && createPrf.length === getPrf.length) {
            let same = createPrf.length > 0;
            for (let i = 0; i < createPrf.length; i++) {
                if (createPrf[i] !== getPrf[i]) { same = false; break; }
            }
            result.prfMatch = same;
        }
        if (result.largeBlobSupported) result.largeBlobWritten = !!ext.largeBlob?.written;
    } catch (err) {
        if (!result.errorName) {
            result.errorName = err?.name || null;
            result.errorMessage = err?.message || String(err);
        }
    }

    // ── get() #2 — read the largeBlob back (only if the write reported success) ──
    if (result.largeBlobWritten) {
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    allowCredentials: [{ type: 'public-key', id: credentialId }],
                    userVerification: 'required',
                    extensions: { largeBlob: { read: true } },
                },
            });
            const ext = assertion.getClientExtensionResults();
            const blob = ext.largeBlob?.blob ? new Uint8Array(ext.largeBlob.blob) : null;
            result.largeBlobReadOk = !!blob
                && blob.length === testBlob.length
                && blob.every((b, i) => b === testBlob[i]);
        } catch (err) {
            if (!result.errorName) {
                result.errorName = err?.name || null;
                result.errorMessage = err?.message || String(err);
            }
        }
    }

    return result;
}
