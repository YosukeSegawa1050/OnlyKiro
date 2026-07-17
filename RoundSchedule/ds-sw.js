const CACHE_NAME = 'daily-schedule-v1';
const ASSETS = ['./DailySchedule.html', './ds-manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('cdn.tailwindcss.com')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./DailySchedule.html')))
  );
});
