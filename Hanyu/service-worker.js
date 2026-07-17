'use strict';

const CACHE_NAME = 'hanyu-v1';
const ASSETS_TO_CACHE = [
  './',
  './Hanyu.html',
  './words.json',
  './manifest.json',
];

// インストール時: 主要ファイルをキャッシュに保存
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// アクティベート時: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// フェッチ時: キャッシュ優先（Cache First）戦略
// Wi-Fiで一度取得すれば、以降はキャッシュから返す → 通信量ゼロ
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse;
      }
      // キャッシュに無い場合はネットワークから取得してキャッシュに保存
      return fetch(event.request).then(networkResponse => {
        // 同一オリジンのGETリクエストのみキャッシュ
        if (event.request.method === 'GET' && event.request.url.startsWith(self.location.origin)) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      });
    }).catch(() => {
      // オフラインでキャッシュも無い場合のフォールバック
      if (event.request.destination === 'document') {
        return caches.match('./Hanyu.html');
      }
    })
  );
});
