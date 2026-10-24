/* かずの すごろく — Service Worker
 * アプリを更新したら VERSION を必ず上げる（例：v1.0.1）。
 * 次にオンラインで起動したとき、新しい版に切り替わる。
 */
const VERSION = 'v1.3.0';
const CACHE = `kazu-sugoroku-${VERSION}`;
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './audio/list.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })));
    // 録音ファイル（audio/list.json に書いたもの）もまとめて保存
    try {
      const res = await fetch('./audio/list.json', { cache: 'reload' });
      const list = await res.json();
      await Promise.all(list.map((key) =>
        cache.add(new Request(`./audio/${key}.mp3`, { cache: 'reload' })).catch(() => {})));
    } catch (e) { /* 録音なし */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('kazu-sugoroku-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const page = await cache.match('./index.html');
        if (page) return page;
      }
      throw e;
    }
  })());
});
