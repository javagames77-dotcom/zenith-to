// Зеніт-Авто.фото — service worker
// Оболочка приложения: сначала сеть, без сети — копия из кэша.
// Чтение из n8n (GET): всегда в сеть; без сети — ответ с маркером X-ZF-Offline.
// Отправка (POST) идёт мимо service worker.
const CACHE = 'zf-pwa-v3';
const SHELL = ['./', './index.html', './app.js?v=3', './manifest.json', './vendor/zxing.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Отправку данных (POST с фото) не трогаем совсем: Safari теряет тело
  // multipart-запроса, если service worker передаёт его дальше.
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('railway.app')) {
    e.respondWith(fetch(e.request).catch(() => new Response(
      JSON.stringify({ success: false, error: 'Нет связи с сервером' }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'X-ZF-Offline': '1' } })));
    return;
  }
  if (url.origin !== self.location.origin) return;   // шрифты и прочее — как обычно
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(r => r || caches.match('./index.html')))
  );
});
