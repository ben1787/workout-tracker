const VERSION = 'wt-v51';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './progress.js',
  './corrections.js',
  './exercise-catalog.js',
  './tracking.js',
  './cloud.js',
  './ai-context.js',
  './ai-time.js',
  './ai-api.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const response = fetch(e.request).then(async (res) => {
      if (res && res.ok) {
        const copy = res.clone();
        await caches.open(VERSION).then((cache) => cache.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request));
  e.respondWith(response);
  e.waitUntil(response.then(() => {}));
});
