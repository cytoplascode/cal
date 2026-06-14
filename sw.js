const CACHE = 'cytocal-v8';

const SHELL = [
  './index.html',
  './styles.css',
  './theme-init.js',
  './app.js',
  './db.js',
  './calendar-api.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  // Cache shell files individually and ignore failures. cache.addAll() is
  // atomic — a single missing/404 file would reject the whole install and
  // leave the old worker (and stale code) in place. Per-file tolerance avoids
  // that failure mode.
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(
        SHELL.map((url) => cache.add(url))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle GET requests.
  if (e.request.method !== 'GET') return;

  // Pass Google API and GIS auth requests straight to the network.
  const url = new URL(e.request.url);
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com')
  ) {
    return;
  }

  // Cache-first for the app shell; fall through to network and cache the
  // response for future offline use. For navigation requests not found in
  // cache (e.g. '/' on GitHub Pages which may redirect), serve index.html.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      if (e.request.mode === 'navigate') {
        return caches.match('./index.html').then((r) => r || fetch('./index.html'));
      }
      return fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(e.request, clone));
        return resp;
      });
    })
  );
});
