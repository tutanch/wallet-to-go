// Security hardening: freeze critical browser APIs before any third-party
// scripts load. This prevents prototype-pollution attacks where a malicious
// library overrides these to intercept passwords, keys, or storage.
//
// This script MUST load before any CDN scripts (qr-creator, etc).
// Each operation is wrapped in try-catch so a failure in one doesn't
// block the others or break WASM module initialization in Safari.

(function() {
    'use strict';

    // Anti-clickjacking: prevent the wallet from being embedded in an
    // attacker's iframe. frame-ancestors CSP cannot be set via <meta> tags,
    // and GitHub Pages does not support custom HTTP headers.
    try {
        if (window.self !== window.top) {
            window.top.location = window.self.location;
        }
    } catch (_) {
        // Cross-origin parent — hide the page entirely
        document.documentElement.style.display = 'none';
    }

    // Freeze crypto APIs
    try {
        if (window.crypto && window.crypto.subtle) {
            Object.freeze(window.crypto.subtle);
        }
    } catch (_) { /* non-critical */ }

    // Prevent overriding indexedDB with a proxy
    try {
        const _indexedDB = window.indexedDB;
        Object.defineProperty(window, 'indexedDB', {
            get: () => _indexedDB,
            set: () => {},
            configurable: false,
        });
    } catch (_) { /* non-critical */ }

    // Freeze crypto.getRandomValues so it can't be replaced with predictable output
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
