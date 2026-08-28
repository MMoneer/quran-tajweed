const CACHE_VERSION = 'quran-pwa-v1';

// GUARDRAIL: every app asset that must work offline MUST be listed here, and
// CACHE_VERSION must be bumped whenever any of these files changes. Any new
// asset added to index.html must also be added here, or it will never be
// cached and will break offline. Same-origin static assets are cache-first
// with no runtime self-healing, so this list is the single source of truth.
const PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'data/juz-data.js',
  'js/dataStore.js',
  'js/dataImporter.js',
  'js/api.js',
  'js/settings.js',
  'js/search.js',
  'js/surahIndex.js',
  'js/pageRenderer.js',
  'js/clipboard.js',
  'js/surahView.js',
  'js/tajweedRules.js',
  'js/audioPlayer.js',
  'js/firstRunWizard.js',
  'js/app.js',
  'fonts/UthmanicHafs_V22.ttf',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
];

const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (event) => {
  // Per-file precache: one bad path must NOT sink the whole install. Each
  // failure is logged so the broken URL is visible instead of silently
  // deactivating the SW.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => console.error('Precache failed for', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API + audio: pass through unchanged (not cached or modified).
  if (url.hostname === 'api.quran.com' || url.hostname === 'everyayah.com') {
    return;
  }

  // Navigation: network-first, fallback to cached shell. Only cache successful
  // responses so a flaky 404/500 cannot overwrite the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            event.waitUntil(
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
            );
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Cross-origin CDN: cache-first, but only cache successful responses.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            event.waitUntil(
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
            );
          }
          return res;
        });
      })
    );
    return;
  }
});
