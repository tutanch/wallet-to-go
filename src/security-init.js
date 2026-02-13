// Security hardening: freeze critical browser APIs before any third-party
// scripts load. This prevents prototype-pollution attacks where a malicious
// library overrides these to intercept passwords, keys, or storage.
//
// This script MUST load before any CDN scripts (qr-creator, etc).

(function() {
    'use strict';

    // Freeze TextEncoder so passwords can't be intercepted during encoding
    Object.freeze(TextEncoder.prototype);

    // Freeze crypto APIs
    if (window.crypto && window.crypto.subtle) {
        Object.freeze(window.crypto.subtle);
    }

    // Prevent overriding indexedDB with a proxy
    const _indexedDB = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', {
        get: () => _indexedDB,
        set: () => {},
        configurable: false,
    });

    // Freeze Uint8Array.prototype.fill so key-zeroing can't be neutered
    const origFill = Uint8Array.prototype.fill;
    Object.defineProperty(Uint8Array.prototype, 'fill', {
        value: origFill,
        writable: false,
        configurable: false,
    });
})();
