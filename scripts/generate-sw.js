#!/usr/bin/env node
// scripts/generate-sw.js
// Generates sw.js with SHA-256 hashes of all repo files baked in.
// Run before every deploy: node scripts/generate-sw.js
//
// The generated sw.js verifies file hashes on install. If any file on
// the server differs from what was deployed, SW install fails and the
// old (known-good) SW keeps serving users.

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative } = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = join(__dirname, '..');

// Files and directories to exclude from the hash manifest
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
]);

function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (EXCLUDE.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walk(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

function sha256File(filePath) {
    const buf = readFileSync(filePath);
    const hash = createHash('sha256').update(buf).digest('base64');
    return `sha256-${hash}`;
}

// Derive version from git SHA, fall back to timestamp
let version;
try {
    version = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch {
    version = Date.now().toString(36);
}

const files = walk(ROOT).sort();
const hashEntries = files.map(f => [
    relative(ROOT, f).replace(/\\/g, '/'),
    sha256File(f),
]);
const hashMap = Object.fromEntries(hashEntries);

const sw = `// AUTO-GENERATED — do not edit manually.
// Run: node scripts/generate-sw.js
// Generated from git SHA: ${version}
//
// Security guarantee: if any file on the server has a different hash than
// what is listed here, the SW install fails and the previous known-good SW
// continues serving users. Tampered files cannot reach returning visitors.

const CACHE_NAME = 'nimiq-wallet-v${version}';

// SHA-256 hashes of every file. Computed at deploy time.
const FILE_HASHES = ${JSON.stringify(hashMap, null, 4)};

// Derive path prefix from SW's own URL.
// Handles GitHub Pages subdirectory deployments, e.g. '/wallet-to-go/'.
const BASE = self.location.pathname.replace(/sw\\.js$/, '');

// ── Install: fetch all files, verify hashes, cache ───────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        for (const [relPath, expectedHash] of Object.entries(FILE_HASHES)) {
            const url = BASE + relPath;
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(\`Fetch failed: \${url} (\${response.status})\`);
            }
            // Read body into ArrayBuffer before hashing (body is a one-shot stream)
            const buf = await response.arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
            const actualHash = \`sha256-\${b64}\`;
            if (actualHash !== expectedHash) {
                throw new Error(
                    \`Hash mismatch for \${url}\\nExpected: \${expectedHash}\\nActual:   \${actualHash}\`
                );
            }
            await cache.put(url, new Response(buf, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            }));
        }
        await self.skipWaiting();
    })());
});

// ── Activate: remove stale caches, claim all clients ─────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        );
        await self.clients.claim();
    })());
});

// ── Fetch: cache-first with hash re-verification ─────────────────────────
// Skip re-verification for large binary files (.wasm) that were already
// verified at install time — hashing multi-MB files on every fetch adds
// noticeable latency.
const SKIP_REVERIFY = new Set(
    Object.keys(FILE_HASHES).filter(p => p.endsWith('.wasm')),
);

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    // Map URL pathname to a relative path in FILE_HASHES
    const relPath = url.pathname.startsWith(BASE)
        ? url.pathname.slice(BASE.length)
        : null;
    if (!relPath || !(relPath in FILE_HASHES)) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) {
            // Large binaries were verified at install time — trust the cache
            if (SKIP_REVERIFY.has(relPath)) return cached;

            // Re-verify to detect cache poisoning
            const buf = await cached.clone().arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
            const actualHash = \`sha256-\${b64}\`;
            if (actualHash === FILE_HASHES[relPath]) {
                return cached;
            }
            // Hash mismatch — evict and fail closed (do not serve tampered content)
            await cache.delete(event.request);
            return new Response('Integrity check failed', {
                status: 500, statusText: 'Integrity Error',
            });
        }
        // Cache miss (e.g. storage eviction) — fetch and verify before serving
        const response = await fetch(event.request);
        if (!response.ok) return response;
        const buf = await response.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
        const actualHash = \`sha256-\${b64}\`;
        if (actualHash !== FILE_HASHES[relPath]) {
            return new Response('Integrity check failed', {
                status: 500, statusText: 'Integrity Error',
            });
        }
        // Verified — re-cache and serve
        const verified = new Response(buf, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
        await cache.put(event.request, verified.clone());
        return verified;
    })());
});
`;

writeFileSync(join(ROOT, 'sw.js'), sw, 'utf8');
console.log(`✓ Generated sw.js with ${hashEntries.length} files (version: ${version})`);
