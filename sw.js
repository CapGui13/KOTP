/* KOTP : page principale toujours recherchée en ligne en priorité.
   Le cache sert uniquement au démarrage hors connexion. */
const CACHE_VERSION = 'kotp-shell-v2';
const APP_ROOT = self.registration.scope;
const HOME_URL = new URL('./', APP_ROOT).href;
const ASSETS = ['./', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];
const ASSET_PATHS = new Set(ASSETS.map(path => new URL(path, APP_ROOT).pathname));
const ROOT_PATH = new URL(APP_ROOT).pathname;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('kotp-shell-') && name !== CACHE_VERSION).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(ROOT_PATH)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        // Chaque ouverture vérifie les PP les plus récents ; aucun HTML figé en cache prioritaire.
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) await cache.put(HOME_URL, response.clone());
        return response;
      } catch {
        return (await cache.match(HOME_URL)) || Response.error();
      }
    })());
    return;
  }

  if (ASSET_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const saved = await cache.match(request, { ignoreSearch: true });
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
