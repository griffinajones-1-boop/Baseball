// Offline support: precache the app shell, serve from cache, refresh in background.
// Bump VERSION whenever you deploy changes so phones pick them up.
const VERSION = 'atbat-v11';
const ASSETS = [
  './', './index.html', './css/app.css',
  './js/app.js', './js/stats.js', './js/store.js', './js/field.js', './js/config.js', './js/pro.js', './js/share.js', './privacy.html',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // App navigations ("/", "/?session_id=...") get the cached shell; other pages (privacy.html) are served as themselves.
    const isShell = req.mode === 'navigate' && /\/(index\.html)?$/.test(url.pathname);
    const key = isShell ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
