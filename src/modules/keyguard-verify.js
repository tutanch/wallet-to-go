// Wallet-side keyguard integrity gate.
//
// The keyguard holds the keys but, as a third-party iframe, cannot reliably
// verify its OWN integrity on Safari (ITP blocks third-party service workers).
// So the WALLET — first-party, works on every browser — verifies the keyguard
// before opening it: it cross-fetches the keyguard's served files, hashes them
// against a manifest baked into (and hash-pinned with) the wallet, and FAILS
// CLOSED on any mismatch. Trust-on-first-use pinning makes a later change loud,
// SSH-host-key style.
//
// This is tamper-EVIDENT + fail-closed + pinned on ALL browsers — NOT
// tamper-proof: a static host can't force the iframe to execute the exact bytes
// the wallet hashed (a brief, detectable TOCTOU window remains), and a
// simultaneous compromise of BOTH origins defeats any in-browser check.

import { KEYGUARD_ORIGIN } from './keyguard-api.js';
import { KEYGUARD_MANIFEST } from '../keyguard-manifest.js';

const PIN_KEY = 'keyguard-fingerprint';

export class KeyguardIntegrityError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = 'KeyguardIntegrityError';
        this.kind = kind; // 'tamper' | 'pin-change' | 'unreachable'
    }
}

async function sha256Base64(buf) {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(hash)));
}

// True only before the first cross-origin deploy (origin placeholder intact or
// no manifest baked yet). In that local/dev state there is nothing deployed to
// verify, so the gate is skipped.
function isUnconfigured() {
    return KEYGUARD_ORIGIN.includes('[') || !KEYGUARD_MANIFEST.digest;
}

/**
 * Verify the live keyguard against the baked manifest and the TOFU pin.
 * Resolves with the fingerprint digest on success (or null in dev mode).
 * Throws KeyguardIntegrityError (fail-closed) on any tamper / unreachable /
 * fingerprint change — the caller must then NOT open the keyguard.
 */
export async function verifyKeyguard() {
    if (isUnconfigured()) return null;

    const { files, digest } = KEYGUARD_MANIFEST;
    const paths = Object.keys(files);
    if (!paths.length) throw new KeyguardIntegrityError('empty keyguard manifest', 'tamper');

    // Default cache (not no-store) on purpose: the verifier's fetch warms the
    // same HTTP-cache entry the iframe then loads from, so the bytes verified
    // are the bytes executed (tighter TOCTOU) and the multi-MB WASM isn't
    // fetched twice.
    await Promise.all(paths.map(async (path) => {
        const url = `${KEYGUARD_ORIGIN}/${path}`;
        let res;
        try {
            res = await fetch(url, { credentials: 'omit', redirect: 'error' });
        } catch (_) {
            throw new KeyguardIntegrityError(`keyguard unreachable: ${path}`, 'unreachable');
        }
        if (!res.ok) throw new KeyguardIntegrityError(`keyguard fetch failed: ${path} (${res.status})`, 'unreachable');
        const actual = await sha256Base64(await res.arrayBuffer());
        if (actual !== files[path]) {
            throw new KeyguardIntegrityError(`keyguard file altered: ${path}`, 'tamper');
        }
    }));

    // Trust-on-first-use pin (wallet first-party storage — reliable on Safari).
    let pinned = null;
    try { pinned = localStorage.getItem(PIN_KEY); } catch (_) { /* storage blocked */ }
    if (pinned && pinned !== digest) {
        throw new KeyguardIntegrityError('keyguard fingerprint changed since first use', 'pin-change');
    }
    if (!pinned) {
        try { localStorage.setItem(PIN_KEY, digest); } catch (_) { /* non-fatal */ }
    }
    return digest;
}

/** The expected keyguard fingerprint (manifest digest) for display in Settings. */
export function keyguardFingerprint() {
    return KEYGUARD_MANIFEST.digest;
}

// Accept the current keyguard fingerprint as the new pinned value. Used after a
// legitimate keyguard update (which changes the fingerprint and trips the TOFU
// alarm) once the user has verified the new fingerprint out-of-band. Only the
// file-hash check having already passed gets the user to this point, so the
// re-pinned value matches the live, baked-and-verified keyguard.
export function repinKeyguard() {
    try { localStorage.setItem(PIN_KEY, KEYGUARD_MANIFEST.digest); } catch (_) { /* non-fatal */ }
}
