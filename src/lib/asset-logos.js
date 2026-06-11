// Inline brand coin icons for the wallet's assets (NIM / USDC / USDT).
//
// Self-contained SVG: no external requests and no web-font dependency (every
// glyph is a vector shape or plain ASCII), so the icons render under the strict
// CSP and work fully offline from the service-worker cache. The markup is
// static and developer-authored — safe to inject via innerHTML.
//
// The disc colour is read from ASSETS[asset].color so the badge, the activity
// direction dots, and the amount labels all stay on one source of truth.

import { ASSETS } from '../config.js';

const GLYPH = {
    // Nimiq's flat-top brand hexagon, white on the Nimiq-gold disc.
    nim: '<polygon points="25.5,16 20.75,7.77 11.25,7.77 6.5,16 11.25,24.23 20.75,24.23" fill="#fff"/>',

    // USDC: a white dollar sign — matches Circle's current flat coin mark.
    usdc: '<text x="16" y="16" text-anchor="middle" dominant-baseline="central" '
        + 'font-family="-apple-system, system-ui, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif" '
        + 'font-size="19" font-weight="700" fill="#fff">$</text>',

    // USDT: the Tether ₮ built from rects (top bar + stem + cross stroke) so it
    // never depends on a font shipping the U+20AE glyph.
    usdt: '<rect x="7" y="8.6" width="18" height="3" rx="1.2" fill="#fff"/>'
        + '<rect x="13.9" y="8.6" width="4.2" height="15.4" rx="1" fill="#fff"/>'
        + '<rect x="10.4" y="13.2" width="11.2" height="2.8" rx="1.2" fill="#fff"/>',
};

/** Inline SVG markup for an asset's coin icon ('' if the asset is unknown). */
export function assetLogo(asset) {
    const meta = ASSETS[asset];
    const glyph = GLYPH[asset];
    if (!meta || !glyph) return '';
    return '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true" focusable="false">'
        + `<circle cx="16" cy="16" r="16" fill="${meta.color}"/>${glyph}</svg>`;
}
