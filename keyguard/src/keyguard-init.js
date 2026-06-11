// Keyguard security hardening — freezes critical browser APIs before any other
// keyguard script runs, so a tampered or injected script cannot swap crypto,
// storage, or the key-zeroing primitive to intercept secrets.
//
// MUST load before keyguard-app.js (and therefore before the worker spawns).
//
// Unlike the wallet's security-init.js this does NOT frame-bust: the keyguard
// is INTENTIONALLY embedded in the wallet's iframe. Anti-framing is handled
// separately by the referrer/origin checks in keyguard-app.js (EMBED_ALLOWED).
(function () {
    'use strict';

    // Freeze crypto.subtle (HKDF / AES key derivation run through it)
    try {
        if (window.crypto && window.crypto.subtle) {
            Object.freeze(window.crypto.subtle);
        }
    } catch (_) { /* non-critical */ }

    // Pin indexedDB so it can't be replaced with a proxy that reads stored entropy
    try {
        const _indexedDB = window.indexedDB;
        Object.defineProperty(window, 'indexedDB', {
            get: () => _indexedDB,
            set: () => {},
            configurable: false,
        });
    } catch (_) { /* non-critical */ }

    // Freeze getRandomValues so it can't be swapped for predictable output
    try {
        const origGetRandomValues = crypto.getRandomValues.bind(crypto);
        Object.defineProperty(crypto, 'getRandomValues', {
            value: origGetRandomValues,
            writable: false,
            configurable: false,
        });
    } catch (_) { /* non-critical */ }

    // Freeze Uint8Array.prototype.fill so key-zeroing can't be neutered
    try {
        const origFill = Uint8Array.prototype.fill;
        Object.defineProperty(Uint8Array.prototype, 'fill', {
            value: origFill,
            writable: false,
            configurable: false,
        });
    } catch (_) { /* non-critical */ }
})();
