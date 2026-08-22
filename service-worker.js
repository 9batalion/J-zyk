const CACHE_NAME = 'glyph-os-static-v2.4.0';
const CORE_ASSETS = [
    './',
    './index.html',
    './offline.html',
    './manifest.webmanifest',
    './bulk-dictionary.css',
    './bulk-dictionary.js',
    './learning-engine.css',
    './learning-engine.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './vendor/jszip.min.js',
    './vendor/pdf.mjs',
    './vendor/pdf.worker.mjs',
    './vendor/JSZIP-LICENSE.md',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith('glyph-os-') && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', copy));
                    }
                    return response;
                })
                .catch(async () => (
                    await caches.match('./index.html') ||
                    await caches.match('./offline.html')
                ))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then(cached => {
            const networkUpdate = fetch(request)
                .then(response => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached || new Response('OFFLINE', {
                    status: 503,
                    statusText: 'Offline',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                }));
            return cached || networkUpdate;
        })
    );
});
