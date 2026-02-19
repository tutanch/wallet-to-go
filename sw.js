// AUTO-GENERATED — do not edit manually.
// Run: node scripts/generate-sw.js
// Generated from git SHA: 1257d76
//
// Security guarantee: if any file on the server has a different hash than
// what is listed here, the SW install fails and the previous known-good SW
// continues serving users. Tampered files cannot reach returning visitors.

const CACHE_NAME = 'nimiq-wallet-v1257d76';

// SHA-256 hashes of every file. Computed at deploy time.
const FILE_HASHES = {
    "CLAUDE.md": "sha256-kkD3sMbBKJ9U/2+tLK5wnbHJxVmBNRmM+0f3F7g5Rt0=",
    "index.html": "sha256-er5PFRUNcq9BktqgaMfE2sWTSgfFEgQgdm7UTIxFCTk=",
    "lib/nimiq-core/launcher/browser/client-proxy.mjs": "sha256-Sb8Y+9RMqbO/izMVCPktL+SAh6J8fQA0Eg/H/A04OVE=",
    "lib/nimiq-core/launcher/browser/cryptoutils-worker-proxy.mjs": "sha256-lVzO7i4UTv4RT+wjriAuAQ2ubt0S74AtDSOfs2/fU38=",
    "lib/nimiq-core/launcher/browser/transfer-handlers.mjs": "sha256-8m9woU7g/6hSYVAN14b1GqYFHlI8mkYnq4ugZP+JNNw=",
    "lib/nimiq-core/lib/web/index.mjs": "sha256-8A5Mcs28ZT38xCbIAzfAVV8LlLiIO9eRsySqle39SYo=",
    "lib/nimiq-core/web/comlink.min.js": "sha256-Dsjbms7+Yy60YgWpzX3kNRuvuD+teSUIsPYUScz59Ow=",
    "lib/nimiq-core/web/comlink.min.mjs": "sha256-e4wVCcTn7ImUgRDJ9FlAnTgdHukrCg0wvxEqVoqPx6Y=",
    "lib/nimiq-core/web/crypto-wasm/index.js": "sha256-HjKSTBJ8g5w0W/LWctl2acQujr+ZahN+gf0fJI9pk6A=",
    "lib/nimiq-core/web/crypto-wasm/index_bg.wasm": "sha256-2RMy/2pmEQsdqknRAJIScvWRANMnOBM2y/E8hVKVBPc=",
    "lib/nimiq-core/web/crypto.js": "sha256-3ZgzxDQgD5M48B6sflRi36FGsjW8CrV+2Ea/B29sXNM=",
    "lib/nimiq-core/web/index.js": "sha256-ekjMP2aFdibDwXW6Zoi9HP1Uq9//6QOI+ikUlLnhomE=",
    "lib/nimiq-core/web/main-wasm/index.js": "sha256-Rr/tsw8H0K/7EjYFXaybgGjT3RnqK0YBOuclPAxoAiU=",
    "lib/nimiq-core/web/main-wasm/index_bg.wasm": "sha256-QFf09J3bkk5BiaZX6WhRCJHf0N1RQsLCd7pCyz8QEVw=",
    "lib/nimiq-core/web/worker-wasm/index.js": "sha256-GCJTwk7iD+nNIFX0lnFE5a9ueXa4I5Av50DnsRtMQ2w=",
    "lib/nimiq-core/web/worker-wasm/index_bg.wasm": "sha256-rlCrnJlwdAcuCVQil/uIPrWm7o2c6ATG77ijLMLzKAE=",
    "lib/nimiq-core/web/worker.js": "sha256-BDbSXdVBWbEGx9L1830XEP0CncpgoGeJiiCokhinTRw=",
    "public/favicon.svg": "sha256-pNfQluJuJZLYXltHVbRpTKfWU06D+nY7cMYom6JLwCw=",
    "src/config.js": "sha256-mnQT+4kh/bKuBIT1No+K/LhKeIxIiji87zy9VUR5z38=",
    "src/lib/qr-encoder.js": "sha256-W3/yGOV65+pBprZTS9j382f7OMVkXsqN6CogoBNZry8=",
    "src/main.js": "sha256-s07n8t/63OXsYPaCVL1th3t/yyHR4Bc8NrcZwIupaSo=",
    "src/modules/keyguard-api.js": "sha256-NPW8fBJZClYGyh7vHy1eJg7oSXIRuU77UcpI+aZN+pg=",
    "src/modules/network-client.js": "sha256-mS1h1Qci6W2bwnIzhGO5Dfdn/YVsG1dSqH4DbIzoUI0=",
    "src/modules/webauthn.js": "sha256-vYac4fCHML+gJrLwf3U2weGKQamkaZbxfk3UZfIaQcw=",
    "src/nimiq.js": "sha256-AK7iYfQuGDUfl5b1wdB4Pp3VNjgwSMl/fZxFWjabDyg=",
    "src/router.js": "sha256-V0p8N2tFF5+GX55/RFzs+cs1kjL62uO2EkMMjg3gI3o=",
    "src/security-init.js": "sha256-DW6md4i2Wczj8gelVD4JO6squ4/HUFW/8iEn5at/9kc=",
    "src/styles/app.css": "sha256-joZUA/Uy/kjYRKR21aY0yIZMoSDFbmOMsGWDYsqt08I=",
    "src/views/batch-send-view.js": "sha256-UP9sIF1S72+fR+EwFZNJb1qh+AOPK4iAbL8rU62kIqo=",
    "src/views/create-view.js": "sha256-D1RaBIoMNxhlJlGFN+LQepngZ3nyAOn/d1NojyA/Nj4=",
    "src/views/dashboard-view.js": "sha256-1Z9tbq3rxnRH5GwRsj+3GgTxGkERqXkyQ4svssYPR68=",
    "src/views/history-view.js": "sha256-eZN7532KwA2Fs3qwNV8yvQzzWxtdIpOZ2DRQsh5vF9A=",
    "src/views/import-view.js": "sha256-WoebbUMOUo5vN1hr9KuZErV1S5/mb3nNVxE1W71S7hQ=",
    "src/views/lock-view.js": "sha256-Y5fm53s9Bt6Uc6+M+Nju+SJOxKo/1Up9dGr79v7h3BQ=",
    "src/views/receive-view.js": "sha256-/EKIYFNW11Lp1gNyL5w+Hz/EPuCnH7RjIxKE6iiFtBQ=",
    "src/views/send-view.js": "sha256-okk0HuFmETiE6J56tZSaFRDRM5lulNlr+SSMWV1SEdQ=",
    "src/views/settings-view.js": "sha256-/zLFPNOodf/Xckr1ladrn/W9wWyPQmRaYjqq9sMvQ2Y=",
    "src/views/welcome-view.js": "sha256-FE1oq6NVCfidiy4Uz9nnHhGX+QZjecX4mApdyq8GiiE="
};

// Derive path prefix from SW's own URL.
// Handles GitHub Pages subdirectory deployments, e.g. '/wallet-to-go/'.
const BASE = self.location.pathname.replace(/sw\.js$/, '');

// ── Install: fetch all files, verify hashes, cache ───────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        for (const [relPath, expectedHash] of Object.entries(FILE_HASHES)) {
            const url = BASE + relPath;
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`Fetch failed: ${url} (${response.status})`);
            }
            // Read body into ArrayBuffer before hashing (body is a one-shot stream)
            const buf = await response.arrayBuffer();
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const b64 = btoa(String.fromCharCode(...new Uint8Array(hashBuf)));
            const actualHash = `sha256-${b64}`;
            if (actualHash !== expectedHash) {
                throw new Error(
                    `Hash mismatch for ${url}\nExpected: ${expectedHash}\nActual:   ${actualHash}`
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
            const actualHash = `sha256-${b64}`;
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
        const actualHash = `sha256-${b64}`;
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
