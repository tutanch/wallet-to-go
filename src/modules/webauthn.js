// WebAuthn delegation module — handles credential ceremonies on behalf of the
// sandboxed keyguard iframe, which cannot call navigator.credentials directly.
//
// The keyguard sends { type: 'webauthn-request', action, ... } via postMessage
// and this module responds with { type: 'webauthn-response', result | error }.

const KEYGUARD_ORIGIN = '[KEYGUARD_ORIGIN]';
const WEBAUTHN_RP = { name: 'Nimiq Wallet' };

// ── WebAuthn helpers ──────────────────────────────────────────────────────

function isWebAuthnAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials);
}

async function isPrfSupported() {
    if (!isWebAuthnAvailable()) return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
        const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        if (!available) return false;
    }
    return true;
}

async function createCredential({ userId, userName, prfSalt }) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const salt = new Uint8Array(prfSalt);

    const credential = await navigator.credentials.create({
        publicKey: {
            rp: WEBAUTHN_RP,
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
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'preferred',
            },
            extensions: {
                prf: { eval: { first: salt } },
            },
        },
    });

    const extResults = credential.getClientExtensionResults();
    if (!extResults.prf?.enabled) {
        throw new Error('PRF_NOT_SUPPORTED');
    }

    let prfOutput = extResults.prf?.results?.first;
    if (!prfOutput) {
        // Some authenticators only return PRF output on get(), not create()
        prfOutput = await getPrfKey({
            credentialId: Array.from(new Uint8Array(credential.rawId)),
            prfSalt,
        });
        // getPrfKey returns an Array, convert to ArrayBuffer for consistency
        prfOutput = new Uint8Array(prfOutput).buffer;
    }

    return {
        credentialId: Array.from(new Uint8Array(credential.rawId)),
        prfKey: Array.from(new Uint8Array(prfOutput)),
    };
}

async function getPrfKey({ credentialId, prfSalt }) {
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

// ── Delegation listener ───────────────────────────────────────────────────

function getFrame() {
    return document.getElementById('keyguard-frame');
}

function respondToKeyguard(result, error) {
    const frame = getFrame();
    if (!frame) return;
    if (error) {
        frame.contentWindow.postMessage(
            { type: 'webauthn-response', error: error.message || String(error), errorName: error.name },
            KEYGUARD_ORIGIN,
        );
    } else {
        frame.contentWindow.postMessage(
            { type: 'webauthn-response', result },
            KEYGUARD_ORIGIN,
        );
    }
}

window.addEventListener('message', async (event) => {
    if (event.origin !== KEYGUARD_ORIGIN) return;
    if (event.data?.type !== 'webauthn-request') return;

    const { action } = event.data;

    try {
        let result;
        switch (action) {
            case 'isPrfSupported':
                result = await isPrfSupported();
                break;
            case 'create':
                result = await createCredential(event.data);
                break;
            case 'get':
                result = await getPrfKey(event.data);
                break;
            default:
                throw new Error(`Unknown WebAuthn action: ${action}`);
        }
        respondToKeyguard(result, null);
    } catch (err) {
        respondToKeyguard(null, err);
    }
});
