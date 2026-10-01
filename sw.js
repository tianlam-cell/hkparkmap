const CACHE_NAME = 'hk-meter-parking-shell-v1';
const SHELL_FILES = [
  './hk-meter-parking.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只為「網站外殼」（本站自己的 HTML / manifest / 圖示）提供離線快取，
  // 讓網站在離線或訊號不穩時至少能打開介面。
  // 所有政府及第三方真實資料 API 一律不攔截、直接連網，
  // 絕不用快取資料頂替，避免顯示過時或虛構的交通資訊。
  const isShellFile = url.origin === self.location.origin &&
    SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '/')));
  if (!isShellFile) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((res) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
