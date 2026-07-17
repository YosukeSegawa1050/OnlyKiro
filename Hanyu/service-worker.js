'use strict';

const CACHE_NAME = 'hanyu-v4';
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

// フェッチ時: Network First 戦略
// ネットワークが使えればそこから取得しキャッシュを更新、失敗時はキャッシュから返す
// → 開発中も最新ファイルが反映される、オフラインでもキャッシュで動作する
self.addEventListener('fetch', event => {
  // クエリパラメータを除いたURLでキャッシュを管理
  const url = new URL(event.request.url);
  url.search = ''; // キャッシュバスティングのパラメータを除去
  const cleanRequest = new Request(url.toString(), { method: event.request.method });

  event.respondWith(
    fetch(event.request).then(networkResponse => {
      // ネットワーク成功 → キャッシュを更新（クリーンURLで保存）
      if (event.request.method === 'GET' && event.request.url.startsWith(self.location.origin)) {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(cleanRequest, responseClone);
        });
      }
      return networkResponse;
    }).catch(() => {
      // ネットワーク失敗 → キャッシュから返す（オフライン対応）
      return caches.match(cleanRequest).then(cachedResponse => {
        if (cachedResponse) return cachedResponse;
        // ドキュメントリクエストならHTMLを返す
        if (event.request.destination === 'document') {
          return caches.match('./Hanyu.html');
        }
      });
    })
  );
});
