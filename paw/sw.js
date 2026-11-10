// Зеніт-Авто.фото — service worker
// Оболочка приложения: сначала сеть, без сети — копия из кэша.
// Чтение из n8n (GET): всегда в сеть; без сети — ответ с маркером X-ZF-Offline.
// Отправка (POST) идёт мимо service worker.
// Push: показ уведомления и переход к заданию/товару по нажатию.
const CACHE = 'zf-pwa-v12';
const SHELL = ['./', './index.html', './app.js?v=12', './manifest.json', './vendor/zxing-reader.js', './vendor/zxing_reader.wasm',
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

// ─── Push-уведомления ──────────────────────────────────────
// Сервер (n8n, /photo/push/send) шлёт JSON {title, body, url, tag}; url — маршрут PWA, например #task-5.
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = { body: e.data ? e.data.text() : '' }; }
  const opts = { body: p.body || '', icon: './icons/icon-192.png', data: { url: p.url || '#tasks' } };
  if (p.tag) { opts.tag = p.tag; opts.renotify = true; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(p.title || 'Зеніт-Авто.фото', opts),
    // открытое приложение обновит список заданий
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(cs => cs.forEach(c => c.postMessage({ type: 'push', url: p.url || '' })))
  ]));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '#tasks';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ type: 'open', url }); return c.focus(); }
    return self.clients.openWindow(self.registration.scope + url);
  }));
});
