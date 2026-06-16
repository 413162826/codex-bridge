// Codex Chat — Service Worker
// 作用：让 PWA 可被「安装」，并缓存应用外壳实现弱网/离线秒开。
// 注意：只处理 /m/ 作用域内的 GET 静态资源；/api/* 在作用域外，天然走网络，不缓存。
const CACHE = 'codex-chat-v4';
const SHELL = [
  '/m/index.html',
  '/m/styles.css',
  '/m/app.js?v=4',
  '/m/manifest.webmanifest',
  '/m/icon-192.png',
  '/m/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 只接管 /m/ 静态资源；其它（含 /api/）放行给网络。
  if (!url.pathname.startsWith('/m/')) return;

  // 导航请求：网络优先，失败回退缓存的外壳（离线也能打开）。
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/m/index.html')),
    );
    return;
  }

  // 其它静态资源：stale-while-revalidate，先给缓存、后台更新。
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
