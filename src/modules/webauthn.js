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

async function createCredential({ userId, userName, prfSalt, excludeCredentialIds }) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const salt = new Uint8Array(prfSalt);

    const excludeCredentials = (excludeCredentialIds || []).map(id => ({
        type: 'public-key',
        id: new Uint8Array(id),
    }));

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

    // ALWAYS use get() for the PRF output used in wallet derivation.
    // create()'s PRF output can differ from get()'s on some platforms
    // (especially with synced passkeys), which would make the wallet
    // address unreproducible during restore. The extra biometric prompt
    // is the price of correctness.
    const prfOutput = await getPrfKey({ credentialId, prfSalt });
    return { credentialId, prfKey: prfOutput };
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

async function getDiscoverablePrfKey(prfSalt) {
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

// ── Delegation listener ───────────────────────────────────────────────────

function getFrame() {
    return document.getElementById('keyguard-frame');
}

function isTrustedKeyguardMessage(event) {
    if (event.origin !== KEYGUARD_ORIGIN) return false;
    const frame = getFrame();
    return !!frame?.contentWindow && event.source === frame.contentWindow;
}

function respondToKeyguard(result, error, requestId) {
    const frame = getFrame();
    if (!frame || !frame.contentWindow) return;
    try {
        if (error) {
            frame.contentWindow.postMessage(
                {
                    type: 'webauthn-response',
                    requestId,
                    error: error.message || String(error),
                    errorName: error.name,
                },
                KEYGUARD_ORIGIN,
            );
        } else {
            frame.contentWindow.postMessage(
                { type: 'webauthn-response', requestId, result },
                KEYGUARD_ORIGIN,
            );
        }
    } catch (_) {}
}

window.addEventListener('message', async (event) => {
    if (!isTrustedKeyguardMessage(event)) return;
    if (event.data?.type !== 'webauthn-request') return;

    const { action, requestId } = event.data;

    try {
        let result;
        switch (action) {
            case 'isPrfSupported':
                // No user gesture needed for feature detection
                result = await isPrfSupported();
                break;
            case 'create': {
                result = await createCredential(event.data);
                break;
            }
            case 'get': {
                result = await getPrfKey(event.data);
                break;
            }
            case 'getForRestore': {
                // Discoverable credential with PRF — for passkey login.
                // No allowCredentials so the browser shows the passkey picker.
                result = await getDiscoverablePrfKey(event.data.prfSalt);
                break;
            }
            default:
                throw new Error(`Unknown WebAuthn action: ${action}`);
        }
        respondToKeyguard(result, null, requestId);
    } catch (err) {
        respondToKeyguard(null, err, requestId);
    }
});
