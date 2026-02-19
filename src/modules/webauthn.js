// WebAuthn delegation module — handles credential ceremonies on behalf of the
// sandboxed keyguard iframe, which cannot call navigator.credentials directly.
//
// The keyguard sends { type: 'webauthn-request', action, ... } via postMessage
// and this module responds with { type: 'webauthn-response', result | error }.
//
// WebAuthn APIs require transient user activation (a click) in the calling
// window. Since the keyguard's click doesn't transfer via postMessage, we show
// a brief overlay prompt so the user clicks within the wallet origin context.

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

async function getDiscoverablePrfKey(prfSalt, secondPrfSalt) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const prfEval = { first: new Uint8Array(prfSalt) };
    if (secondPrfSalt) prfEval.second = new Uint8Array(secondPrfSalt);

    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge,
            userVerification: 'required',
            extensions: {
                prf: { eval: prfEval },
            },
        },
    });

    const extResults = assertion.getClientExtensionResults();
    const prfResult = extResults.prf?.results?.first;
    if (!prfResult) throw new Error('PRF output not available');
    const result = {
        prfKey: Array.from(new Uint8Array(prfResult)),
        credentialId: Array.from(new Uint8Array(assertion.rawId)),
    };
    const prfSecond = extResults.prf?.results?.second;
    if (prfSecond) result.prfKeySecond = Array.from(new Uint8Array(prfSecond));
    return result;
}

// ── User gesture prompt ───────────────────────────────────────────────────
// WebAuthn requires transient user activation. The keyguard iframe's click
// doesn't count in the wallet's browsing context, so we show a brief overlay
// that the user clicks to provide the gesture.

function showGesturePrompt(isCreate) {
    return new Promise((resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.id = 'webauthn-gesture-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(31,35,72,0.85);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:fadeIn .15s ease-out;';

        const card = document.createElement('div');
        card.style.cssText = 'background:white;border-radius:12px;padding:28px 24px;max-width:360px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3);';

        const title = document.createElement('h2');
        title.style.cssText = 'font-size:18px;font-weight:700;color:#1F2348;margin-bottom:8px;';
        title.textContent = isCreate ? 'Register Passkey' : 'Authenticate';

        const desc = document.createElement('p');
        desc.style.cssText = 'font-size:14px;color:rgba(31,35,72,0.6);margin-bottom:20px;line-height:1.4;';
        desc.textContent = isCreate
            ? 'Click the button below, then follow your browser\'s prompt to register your biometric or passkey.'
            : 'Click the button below, then use your fingerprint, face, or device PIN to authenticate.';

        const btn = document.createElement('button');
        btn.style.cssText = 'padding:12px 32px;background:#0582CA;color:white;border:none;border-radius:500px;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 12px rgba(5,130,202,0.3);min-height:44px;';
        btn.textContent = 'Continue';

        const cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:8px 16px;background:rgba(31,35,72,0.05);color:#1F2348;border:1px solid rgba(31,35,72,0.15);border-radius:500px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;min-height:36px;';
        cancelBtn.textContent = 'Cancel';

        card.appendChild(title);
        card.appendChild(desc);
        card.appendChild(btn);
        card.appendChild(document.createElement('br'));
        card.appendChild(cancelBtn);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        function cleanup() {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }

        btn.addEventListener('click', () => {
            cleanup();
            resolve();
        });

        cancelBtn.addEventListener('click', () => {
            cleanup();
            const err = new Error('User cancelled');
            err.name = 'NotAllowedError';
            reject(err);
        });
    });
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
                // Hide keyguard iframe so gesture prompt is visible
                // (iframes can composite above DOM overlays despite z-index)
                const frame = getFrame();
                if (frame) frame.style.display = 'none';
                try {
                    await showGesturePrompt(true);
                    result = await createCredential(event.data);
                } finally {
                    if (frame) frame.style.display = '';
                }
                break;
            }
            case 'get': {
                const frame = getFrame();
                if (frame) frame.style.display = 'none';
                try {
                    await showGesturePrompt(false);
                    result = await getPrfKey(event.data);
                } finally {
                    if (frame) frame.style.display = '';
                }
                break;
            }
            case 'getForRestore': {
                // Discoverable credential with PRF — for passkey login.
                // No allowCredentials so the browser shows the passkey picker.
                // Optional secondPrfSalt for backup decryption (dual-salt ceremony).
                const frame = getFrame();
                if (frame) frame.style.display = 'none';
                try {
                    await showGesturePrompt(false);
                    result = await getDiscoverablePrfKey(event.data.prfSalt, event.data.secondPrfSalt);
                } finally {
                    if (frame) frame.style.display = '';
                }
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
