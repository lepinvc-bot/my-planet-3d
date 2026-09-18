// Service Worker для офлайн-кеша тайлов карты и рельефа

const CACHE_VERSION = 'v1';
const CACHE_TILES = `tiles-${CACHE_VERSION}`;
const CACHE_APP = `app-${CACHE_VERSION}`;

const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'
];

// Установка: precache app shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_APP).then((cache) => {
            return cache.addAll(APP_SHELL).catch(err => {
                console.warn('Precache partial fail:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

// Активация: удаляем старые версии кеша
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_TILES && k !== CACHE_APP)
                    .map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

// Стратегия:
// - тайлы карты (opentopomap.org) → cache-first + сохранение в CACHE_TILES
// - тайлы DEM (s3.amazonaws.com/elevation-tiles-prod) → cache-first + сохранение
// - app shell (unpkg, index.html) → cache-first, fallback на сеть
// - всё остальное → сеть как обычно

function isTileRequest(url) {
    return url.hostname === 'tile.opentopomap.org'
        || url.hostname === 's3.amazonaws.com';
}

function isAppShell(url) {
    return url.hostname === 'unpkg.com'
        || url.pathname.endsWith('index.html')
        || url.pathname.endsWith('/')
        || url.pathname.endsWith('manifest.json');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Тайлы карты и рельефа — cache-first с сохранением
    if (isTileRequest(url)) {
        event.respondWith(
            caches.open(CACHE_TILES).then(async (cache) => {
                const cached = await cache.match(req);
                if (cached) return cached;

                try {
                    const res = await fetch(req);
                    // кешируем только успешные ответы
                    if (res.ok && res.status === 200) {
                        // clone, потому что тело можно прочитать один раз
                        cache.put(req, res.clone());
                    }
                    return res;
                } catch (e) {
                    // офлайн и нет в кеше — отдаём прозрачный пиксель, чтобы не ломать карту
                    return new Response('', { status: 404 });
                }
            })
        );
        return;
    }

    // App shell — cache-first
    if (isAppShell(url)) {
        event.respondWith(
            caches.open(CACHE_APP).then(async (cache) => {
                const cached = await cache.match(req);
                if (cached) return cached;
                try {
                    const res = await fetch(req);
                    if (res.ok) cache.put(req, res.clone());
                    return res;
                } catch (e) {
                    return new Response('Offline', { status: 503 });
                }
            })
        );
        return;
    }

    // Остальное — сеть
});

// Сообщение от страницы: принудительно кешировать URL (используется кнопкой «Скачать»)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CACHE_URLS') {
        const urls = event.data.urls || [];
        event.waitUntil(
            caches.open(CACHE_TILES).then(async (cache) => {
                for (const url of urls) {
                    try {
                        const res = await fetch(url);
                        if (res.ok) await cache.put(url, res);
                    } catch (e) { /* ignore */ }
                }
            })
        );
    }
});