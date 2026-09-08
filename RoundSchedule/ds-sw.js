'use strict';
const VERSION = '2.2.0';
const CACHE_NAME = `daily-schedule-${VERSION}`;
const ASSETS = [
  './RoundSchedule.html',
  './styles.css?v=2.2.0',
  './core.js?v=2.2.0',
  './storage.js?v=2.2.0',
  './shared-storage.js?v=2.2.0',
  './shared-ui.js?v=2.2.0',
  './notifications.js?v=2.2.0',
  './category-interactions.js?v=2.2.0',
  './app.js?v=2.2.0',
  './ds-manifest.json',
  './icon-192.png',
  './icon-512.png',
];
const assetURLs = new Set(ASSETS.map((path) => new URL(path, self.location.href).href));
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('daily-schedule-') && key !== CACHE_NAME) await caches.delete(key);
      await self.clients.claim();
    })()
  );
});
async function network(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const appPaths = new Set(
    ['./', './index.html', './RoundSchedule.html'].map(
      (p) => new URL(p, self.location.href).pathname
    )
  );
  const navigation = event.request.mode === 'navigate' && appPaths.has(url.pathname);
  if (!navigation && !assetURLs.has(url.href)) return;
  event.respondWith(
    (async () => {
      // A release's HTML/CSS/JS are kept together. New releases activate on request.
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(navigation ? './RoundSchedule.html' : event.request);
      if (cached) return cached;
      try {
        const response = await network(event.request);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Cache only verified precache resources. No HTML fallback for image/JSON requests.
        if (assetURLs.has(url.href)) {
          try {
            await cache.put(event.request, response.clone());
          } catch {
            /* Return the usable network response. */
          }
        }
        return response;
      } catch {
        return new Response(
          navigation
            ? 'オフライン用の画面がまだ保存されていません。オンラインで開き直してください。'
            : '',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        );
      }
    })()
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL('./RoundSchedule.html', self.location.href);
  if (/^\d{4}-\d{2}-\d{2}$/.test(data.date || '')) target.searchParams.set('date', data.date);
  if (typeof data.taskId === 'string') target.searchParams.set('task', data.taskId);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url === target.href);
      if (existing) return existing.focus();
      return self.clients.openWindow(target.href);
    })()
  );
});
