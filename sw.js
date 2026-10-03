const CACHE_NAME = 'hk-meter-parking-shell-v2';
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

  // 只處理「網站外殼」（本站自己的 HTML / manifest / 圖示）。
  // 所有政府及第三方真實資料 API 一律不攔截、直接連網，絕不用快取資料頂替。
  const isShellFile = url.origin === self.location.origin &&
    SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '/')));
  if (!isShellFile) return;

  // 網絡優先：有網絡時永遠取最新版本（更新網站後馬上生效），
  // 只有離線時才用快取的外殼，讓介面至少打得開。
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
