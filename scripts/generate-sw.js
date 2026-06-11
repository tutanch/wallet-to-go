#!/usr/bin/env node
// scripts/generate-sw.js
// Generates the WALLET origin's sw.js (SHA-256 integrity manifest).
// Run before every wallet deploy: node scripts/generate-sw.js
//
// The keyguard origin has its own generator (generate-keyguard-sw.js); both
// share the hashing/template logic in scripts/sw-core.js.

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { generateServiceWorker } = require('./sw-core.js');

const ROOT = join(__dirname, '..');

// Files and directories to exclude from the wallet hash manifest
const EXCLUDE = new Set([
    'node_modules',
    '.git',
    '.github',      // CI config — not served by GitHub Pages
    'scripts',
    'sw.js',        // Generated file — cannot self-verify
    'keyguard',     // Separate repo — not served by this origin
    'batch-sender', // Standalone tool — not part of the wallet app
    '.vscode',
    '.keyguard-org',
    '.DS_Store',
    '.gitignore',
    '.nojekyll',
    'README.md',
    '.claude',
    'verify',       // Docker-only test suite — never served
]);

// ── Design-token sync guard (WALLET-ONLY) ─────────────────────────────────
// The wallet and keyguard deploy to separate origins, each carrying a copy of
// the design-token block. Warn-only: a drifted block is cosmetic. This check
// lives in the wallet generator because only here are BOTH css files present.
function extractTokenBlock(cssPath) {
    try {
        const css = readFileSync(cssPath, 'utf8');
        const match = css.match(/\/\* == DESIGN TOKENS[\s\S]*?\/\* == END DESIGN TOKENS == \*\//);
        if (!match) return null;
        // Compare declarations only — comments may legitimately differ per origin
        return match[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    } catch {
        return null;
    }
}
{
    const walletTokens = extractTokenBlock(join(ROOT, 'src/styles/app.css'));
    const keyguardTokens = extractTokenBlock(join(ROOT, 'keyguard/src/styles/keyguard.css'));
    if (!walletTokens || !keyguardTokens) {
        console.warn('⚠ Design-token sentinel block missing in app.css or keyguard.css');
    } else if (walletTokens !== keyguardTokens) {
        console.warn('⚠ Design-token blocks differ between src/styles/app.css and keyguard/src/styles/keyguard.css — keep them in sync');
    }
}

const { count, version } = generateServiceWorker({
    rootDir: ROOT,
    excludes: EXCLUDE,
    outFile: join(ROOT, 'sw.js'),
    cacheNamePrefix: 'nimiq-wallet-v',
    cacheOnly: false,
});
console.log(`✓ Generated sw.js with ${count} files (version: ${version})`);
