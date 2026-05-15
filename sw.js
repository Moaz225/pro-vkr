/* Brodsky PWA service worker (Phase 1).
 * Goals:
 * - Precache core static assets for offline navigation
 * - Cache /api/products (menu metadata) for offline fallback
 */

const VERSION = 'v6';
const STATIC_CACHE = `brodsky-static-${VERSION}`;
const API_CACHE = `brodsky-api-${VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/staff-orders.html',
  '/manager.html',
  '/my-orders.html',
  '/cancellations.html',
  '/manifest.json',
  '/toast.js',
  '/pwa.js',
  '/order-ready.js',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(PRECACHE_URLS);
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k !== STATIC_CACHE && k !== API_CACHE && k.startsWith('brodsky-')) return caches.delete(k);
          return Promise.resolve();
        })
      );
      self.clients.claim();
    })()
  );
});

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw _;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin.
  if (url.origin !== self.location.origin) return;

  // Runtime cache for menu/products metadata.
  if (req.method === 'GET' && url.pathname === '/api/products') {
    event.respondWith(networkFirst(req));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/products/availability') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Never cache session-sensitive API responses (csrf token must match cookie).
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    const allowedCacheApis = ['/api/products', '/api/products/availability'];
    if (!allowedCacheApis.includes(url.pathname)) {
      event.respondWith(fetch(req));
      return;
    }
  }

  // Navigation: serve cached index as fallback when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch (_) {
          const cache = await caches.open(STATIC_CACHE);
          return (await cache.match('/index.html')) || new Response('Offline', { status: 200 });
        }
      })()
    );
    return;
  }

  // Static assets.
  if (req.method === 'GET') {
    event.respondWith(cacheFirst(req));
  }
});

