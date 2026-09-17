// Offline support. The app shell is cached up front; card pictures are cached
// as they are seen. A shop with no wifi can still deal a game, though the two
// devices will not sync until there is a connection again.
const SHELL = 'ktm-shell-v10';
const CARDS = 'ktm-cards-v2';
const SHELL_FILES = ['./', './index.html', './decks.js', './config.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== CARDS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Sync must never be served from a cache.
  if (url.hostname.endsWith('firebasedatabase.app')) return;

  // Card pictures never change once published, so cache them for good.
  // An image from another domain comes back "opaque" with status 0, so res.ok
  // is false even on success. Store it anyway or nothing is ever cached and
  // offline has no art.
  if (url.hostname === 'cards.scryfall.io') {
    e.respondWith(
      caches.open(CARDS).then(c =>
        c.match(e.request).then(hit => {
          if (hit) return hit;
          return fetch(e.request).then(res => {
            try { c.put(e.request, res.clone()); } catch (err) { /* over quota */ }
            return res;
          });
        })
      )
    );
    return;
  }

  // Card data: fresh when online, cached when not.
  if (url.hostname === 'api.scryfall.com') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CARDS).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // The app itself: network first, cache as the backup. Cache first would mean
  // a published update never reaches a device that has already been here once,
  // because the shell is only re-fetched when this file's version changes.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(hit => hit || Response.error()))
    );
  }
});
