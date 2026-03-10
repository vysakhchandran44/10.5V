const CACHE_NAME = 'gs1-vault-pro-v3';
const APP_ASSETS = [
  './', './index.html', './css/styles.css', './js/app.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './data/master-seed.csv'
];
const RUNTIME_ALLOWLIST = ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const cacheableRuntime = RUNTIME_ALLOWLIST.some(host => url.hostname.includes(host));
  event.respondWith(
    caches.match(event.request).then(hit => hit || fetch(event.request).then(resp => {
      if (resp && resp.status === 200 && (url.origin === self.location.origin || cacheableRuntime)) {
        caches.open(CACHE_NAME).then(c => c.put(event.request, resp.clone()));
      }
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
