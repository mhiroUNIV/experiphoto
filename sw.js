// 実験室で電波が弱くても開けるように、画面のファイルだけを手元に置く。
// Dropbox への通信（別のサイト）には手を出さない。直したら VERSION を上げる
const VERSION = 'experiphoto-0.2.2';
const SHELL = ['./', 'index.html', 'app.js', 'dropbox.js', 'queue.js', 'exif.js', 'review.js', 'config.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 先に網から取り、取れなければ手元のものを出す（新しい版がすぐ届くように）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./'))),
  );
});
