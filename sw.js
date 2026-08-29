const CACHE_VERSION = 'quran-pwa-v3';

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
  'css/font-awesome.css',
  'css/google-fonts.css',
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
  'fonts/UthmanicHafs_V20.ttf',
  'fonts/UthmanicHafs_V22.ttf',
  'fonts/fontawesome/fa-brands-400.ttf',
  'fonts/fontawesome/fa-brands-400.woff2',
  'fonts/fontawesome/fa-regular-400.ttf',
  'fonts/fontawesome/fa-regular-400.woff2',
  'fonts/fontawesome/fa-solid-900.ttf',
  'fonts/fontawesome/fa-solid-900.woff2',
  'fonts/fontawesome/fa-v4compatibility.ttf',
  'fonts/fontawesome/fa-v4compatibility.woff2',
  'fonts/google/Iura6YBj_oCad4k1nzGBCw.woff2',
  'fonts/google/Iura6YBj_oCad4k1nzSBC45I.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l4qkHrFpiQ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l4qkHrRpiYlJ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l5anHrFpiQ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l5anHrRpiYlJ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l5qjHrFpiQ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l5qjHrRpiYlJ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l8KiHrFpiQ.woff2',
  'fonts/google/Iurf6YBj_oCad4k1l8KiHrRpiYlJ.woff2',
  'fonts/google/J7acnpd8CGxBHp2VkaY6zp5yGw.woff2',
  'fonts/google/J7acnpd8CGxBHp2VkaYxzp5yGw.woff2',
  'fonts/google/J7acnpd8CGxBHp2VkaY_zp4.woff2',
  'fonts/google/J7afnpd8CGxBHpUrhL8Y66NL.woff2',
  'fonts/google/J7afnpd8CGxBHpUrhLEY6w.woff2',
  'fonts/google/J7afnpd8CGxBHpUrhLQY66NL.woff2',
  'fonts/google/J7aRnpd8CGxBHpUgtLMA7w.woff2',
  'fonts/google/J7aRnpd8CGxBHpUrtLMA7w.woff2',
  'fonts/google/J7aRnpd8CGxBHpUutLM.woff2',
  'fonts/google/QGYvz_MVcBeNP4NJtEtq.woff2',
  'fonts/google/QGYvz_MVcBeNP4NJuktqQ4E.woff2',
  'fonts/google/_Xmo-Hk0rD6DbUL4_vH8Zp5q5i0.woff2',
  'fonts/google/_Xmo-Hk0rD6DbUL4_vH8Zp5v5i2ssg.woff2',
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
      caches.match(req).then((cached) =>
        cached || fetch(req).catch(() =>
          new Response('Network error', { status: 504, headers: { 'Content-Type': 'text/plain' } })
        )
      )
    );
    return;
  }

  // Cross-origin CDN: cache-first, but only cache successful responses.
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              event.waitUntil(
                caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
              );
            }
            return res;
          })
          .catch(() =>
            new Response('Network error', { status: 504, headers: { 'Content-Type': 'text/plain' } })
          );
      })
    );
    return;
  }
});
