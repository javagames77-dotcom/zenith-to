// ═══════════════════════════════════════════════════════════
// Зеніт-Авто.фото — PWA фотографа (пилот)
// Фото снимается родной камерой телефона и уходит на сервер как есть,
// без сжатия. Пока нет сети — ждёт в очереди на телефоне (IndexedDB).
// ═══════════════════════════════════════════════════════════
// Любая ошибка на старте показывается на экране, а не оставляет белую страницу
function showFatal(msg) {
  const a = document.getElementById('app');
  if (a && !a.dataset.fatal) { a.dataset.fatal = '1'; a.innerHTML = '<div class="err" style="margin:14px">Ошибка приложения: ' + String(msg).replace(/</g, '&lt;') + '<br>Обновите страницу. Если повторяется — пришлите скриншот.</div>'; }
}
window.addEventListener('error', e => showFatal(e.message || 'неизвестная ошибка'));
window.addEventListener('unhandledrejection', e => showFatal((e.reason && e.reason.message) || e.reason || 'ошибка'));

const API_BASE = 'https://primary-production-4b93e.up.railway.app/webhook';
const APP_VERSION = 'v10';
const MIN_PHOTOS = 4, MAX_PHOTOS = 14;

// ─── утилиты ──────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const esc = v => v === null || v === undefined ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = v => Number(v) || 0;
const norm = s => String(s || '').toUpperCase().replace(/[\s./\\_-]/g, '');
const thumb = u => u ? u.replace('/image/upload/', '/image/upload/c_fill,w_300,h_300,q_auto,f_auto/') : '';
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function plural(n, a, b, c) { n = Math.abs(n) % 100; const d = n % 10; if (n > 10 && n < 20) return c; if (d > 1 && d < 5) return b; if (d === 1) return a; return c; }
function fileToBase64(file) {          // из GhostAudit app.js
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
const vibrate = p => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

// ─── вход ─────────────────────────────────────────────────
// Фотограф входит один раз: телефон хранит ключ входа (не пароль), сервер продлевает его при работе.
// Ключи хранилища свои, не как у админки, чтобы входы не путались.
const Auth = {
  token: null, user: null,
  load() { try { this.token = localStorage.getItem('zf_pwa_token'); this.user = JSON.parse(localStorage.getItem('zf_pwa_user') || 'null'); } catch (_) {} },
  save(token, user) { this.token = token; this.user = user; try { localStorage.setItem('zf_pwa_token', token); localStorage.setItem('zf_pwa_user', JSON.stringify(user)); localStorage.setItem('zf_pwa_login', user.login || ''); } catch (_) {} },
  clear() { this.token = null; this.user = null; try { localStorage.removeItem('zf_pwa_token'); localStorage.removeItem('zf_pwa_user'); } catch (_) {} },
  lastLogin() { try { return localStorage.getItem('zf_pwa_login') || ''; } catch (_) { return ''; } }
};
Auth.load();

// ─── API ──────────────────────────────────────────────────
// offline = true, если до сервера не достучались (нет сети). Тогда работаем по кэшу.
// auth = true, если вход истёк или отозван: фото в очереди остаются, приложение просит войти.
async function api(path, { method = 'GET', body, form, noAuth = false } = {}) {
  let res;
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (!noAuth && Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;
  try {
    res = await fetch(API_BASE + path, {
      method, headers,
      body: form || (body ? JSON.stringify(body) : undefined)
    });
  } catch (_) {
    const e = new Error('Нет связи с сервером'); e.offline = true; throw e;
  }
  if (res.headers.get('X-ZF-Offline') === '1') { const e = new Error('Нет связи с сервером'); e.offline = true; throw e; }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && !noAuth) {
    const e = new Error((data && data.error) || 'Нужно войти'); e.status = 401; e.auth = true;
    if (Auth.token) { Auth.clear(); setTimeout(() => showLogin(e.message), 0); }
    throw e;
  }
  if (!res.ok || !data || data.success === false) {
    const e = new Error((data && data.error) || ('Ошибка сервера: ' + res.status));
    e.status = res.status; e.data = data; throw e;
  }
  return data;
}

// ─── IndexedDB: очередь фото и кэш заданий ────────────────
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, fail) => {
      const r = indexedDB.open('zenit-foto', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('queue', { keyPath: 'photo_uid' });
        d.createObjectStore('cache');
      };
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => fail(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((ok, fail) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined);
      t.onerror = () => fail(t.error);
    });
  },
  put: (store, val, key) => DB.tx(store, 'readwrite', s => s.put(val, key)),
  get: (store, key) => DB.tx(store, 'readonly', s => s.get(key)),
  del: (store, key) => DB.tx(store, 'readwrite', s => s.delete(key)),
  all: store => DB.tx(store, 'readonly', s => s.getAll())
};
const cachePut = (v, k) => DB.put('cache', v, k).catch(() => {});
const cacheGet = k => DB.get('cache', k).catch(() => null);
// Просим браузер не чистить хранилище (важно для iOS)
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ─── состояние ────────────────────────────────────────────
const S = { tasks: null, task: {}, queue: [], online: navigator.onLine, syncing: false };
async function refreshQueue() {
  try { S.queue = (await DB.all('queue')) || []; } catch (e) { console.warn('IndexedDB', e); S.queue = S.queue || []; }
  drawQueueChip();
}
const queueFor = itemId => S.queue.filter(q => num(q.item_id) === num(itemId)).sort((a, b) => a.created - b.created);

async function loadTasks() {
  try { const d = await api('/photo/tasks'); S.tasks = d.tasks || []; await cachePut(S.tasks, 'tasks'); S.online = true; }
  catch (e) { if (!e.offline) throw e; S.online = false; S.tasks = (await cacheGet('tasks')) || []; }
  drawQueueChip();
  return S.tasks;
}
async function loadTask(id, { cachedFirst = false } = {}) {
  if (cachedFirst && S.task[id]) return S.task[id];
  try { const d = await api('/photo/task?task_id=' + id); S.task[id] = d; await cachePut(d, 'task-' + id); S.online = true; }
  catch (e) {
    if (!e.offline) throw e;
    S.online = false;
    const c = await cacheGet('task-' + id);
    if (!c) throw new Error('Нет сети, и задание ещё не загружалось на этот телефон');
    S.task[id] = c;
  }
  drawQueueChip();
  return S.task[id];
}
function findItem(taskId, itemId) { const d = S.task[taskId]; return d && (d.items || []).find(i => num(i.id) === num(itemId)); }

// ─── отправка очереди ─────────────────────────────────────
async function sync() {
  if (S.syncing || !Auth.token) return;
  S.syncing = true;
  try {
    await refreshQueue();
    const list = S.queue.filter(q => q.status !== 'rejected').sort((a, b) => a.created - b.created);
    for (const q of list) {
      q.status = 'sending'; await DB.put('queue', q); drawQueueChip(); redrawItemIfOpen(q);
      if (!q.file_base64) {
        q.status = 'rejected'; q.error = 'старая версия очереди — переснимите'; await DB.put('queue', q);
        await refreshQueue(); redrawItemIfOpen(q); continue;
      }
      try {
        const r = await api('/photo/upload', { method: 'POST', body: {
          photo_uid: q.photo_uid, item_id: q.item_id, seq: q.seq, shot_at: q.shot_at,
          mime_type: q.type, file_base64: q.file_base64
        }});
        S.online = true;
        await DB.del('queue', q.photo_uid);
        const it = findItem(q.task_id, q.item_id);
        if (it) {
          it.photos = it.photos || [];
          if (!it.photos.some(p => p.photo_uid === r.photo_uid)) {
            it.photos.push({ photo_uid: r.photo_uid, photo_index: r.photo_index, file_name: r.file_name, file_url: r.file_url, width: r.width, height: r.height, size_bytes: r.size_bytes, status: 'stored', seq: q.seq });
            it.photos_stored = num(it.photos_stored) + 1;
          }
          await cachePut(S.task[q.task_id], 'task-' + q.task_id);
        }
      } catch (e) {
        if (e.offline) { S.online = false; q.status = 'wait'; await DB.put('queue', q); break; }
        // вход истёк или нет прав: фото ждёт, после входа уйдёт само
        if (e.status === 401 || e.status === 403) { q.status = 'wait'; q.error = e.message; await DB.put('queue', q); break; }
        // 4xx — сервер отклонил (например, неверный формат) — повторять бессмысленно
        q.status = e.status && e.status < 500 ? 'rejected' : 'wait';
        q.error = e.message; q.tries = (q.tries || 0) + 1;
        await DB.put('queue', q);
        if (q.status === 'wait') break;
      }
      await refreshQueue(); redrawItemIfOpen(q);
    }
  } finally {
    S.syncing = false;
    await refreshQueue();
    redrawCurrent();
  }
}
window.addEventListener('online', () => { S.online = true; sync(); });
window.addEventListener('offline', () => { S.online = false; drawQueueChip(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (S.queue.some(q => q.status !== 'rejected')) sync(); }, 30000);

// ─── шапка ────────────────────────────────────────────────
function header({ back, title } = {}) {
  $('#top').innerHTML = `
    ${back ? `<button class="back" type="button" aria-label="Назад" id="back">←</button>` : `<span class="logo"><svg viewBox="0 0 384 462" role="img" aria-label="Зеніт-Авто"><use href="#logo"/></svg></span>`}
    <span class="ttl">${title ? esc(title) : 'Зеніт-Авто<span>.фото</span>'}</span><span class="mu" style="font-size:11px;flex:none">${APP_VERSION}</span>
    <button class="qchip" type="button" id="qchip"></button>`;
  if (back) $('#back').onclick = () => { location.hash = back; };
  $('#qchip').onclick = () => { location.hash = '#queue'; };
  drawQueueChip();
}
function drawQueueChip() {
  const c = $('#qchip'); if (!c) return;
  const wait = S.queue.filter(q => q.status !== 'rejected').length;
  const bad = S.queue.filter(q => q.status === 'rejected').length;
  c.className = 'qchip' + (bad ? ' er' : !S.online ? ' off' : wait ? ' wa' : '');
  c.textContent = bad ? `ошибки: ${bad}` : !S.online ? (wait ? `нет сети · ${wait}` : 'нет сети') : wait ? `отправка · ${wait}` : 'всё отправлено';
}

// ─── маршруты ─────────────────────────────────────────────
const app = $('#app');
let current = null;
const routes = [
  [/^#?(tasks)?$/, () => viewTasks()],
  [/^#task-(\d+)$/, m => viewTask(m[1])],
  [/^#item-(\d+)-(\d+)$/, m => viewItem(m[1], m[2])],
  [/^#scan-(\d+)$/, m => viewScan(m[1])],
  [/^#queue$/, () => viewQueue()],
  [/^#add(?:-(.*))?$/, m => viewAdd(m[1] ? decodeURIComponent(m[1]) : '')]
];
function route() {
  stopScanner();
  if (!Auth.token) return showLogin();
  document.body.classList.remove('login-on');
  const h = location.hash || '#tasks';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) { current = { h, m }; fn(m); window.scrollTo(0, 0); return; }
  }
  location.hash = '#tasks';
}
window.addEventListener('hashchange', route);
function redrawCurrent() {
  if (!current) return;
  if (/^#item-/.test(current.h)) drawItem(current.m[1], current.m[2]);
  else if (/^#queue$/.test(current.h)) viewQueue();
}
function redrawItemIfOpen(q) {
  if (current && /^#item-/.test(current.h) && num(current.m[2]) === num(q.item_id)) drawItem(current.m[1], current.m[2]);
}
const loading = t => { app.innerHTML = `<div class="empty">${esc(t || 'Загрузка…')}</div>`; };
function failView(e, retry) {
  app.innerHTML = `<div class="stack"><div class="err">${esc(e.message || e)}</div>${retry ? '<button class="btn" type="button" id="retry">Повторить</button>' : ''}</div>`;
  if (retry) $('#retry').onclick = retry;
}

// ─── Задания ──────────────────────────────────────────────
async function viewTasks() {
  header(); loading();
  let tasks;
  try { tasks = await loadTasks(); } catch (e) { return failView(e, viewTasks); }
  const open = tasks.filter(t => t.status === 'open');
  app.innerHTML = `
    <div class="stack">
      <div><h1>Задания</h1><div class="sub">${S.online ? 'Выберите задание для съёмки' : 'Нет сети — показаны сохранённые задания'}</div></div>
      ${open.length ? `<div class="list">${open.map(t => {
        const total = num(t.items_total), done = num(t.items_done);
        return `<a class="row" href="#task-${num(t.id)}">
          <span><b>${esc(t.title)}</b></span><span class="pill ${done === total && total ? 'ok' : 'bl'}">${done} / ${total}</span>
          <span class="n">${[t.file_name].filter(Boolean).map(esc).join(' · ')}</span>
          <span class="prog" style="grid-column:1/-1;margin-top:6px"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span></a>`;
      }).join('')}</div>` : '<div class="card empty">Открытых заданий у вас нет. Задание назначает менеджер; товар с приёмки можно добавить кнопкой ниже.</div>'}
      <button class="btn" type="button" id="add-new">+ Новый товар без Excel</button>
      <button class="btn" type="button" id="refresh">Обновить</button>
      <div id="push-box"></div>
      <div class="whoami">Вы вошли как <b>${esc(Auth.user ? Auth.user.full_name : '')}</b> · <button type="button" class="link" id="logout">Выйти</button></div>
    </div>`;
  $('#refresh').onclick = viewTasks;
  $('#logout').onclick = logout;
  Push.draw();
  $('#add-new').onclick = () => { location.hash = '#add'; };
}

// ─── Задание ──────────────────────────────────────────────
let taskFilter = 'todo', taskSearch = '';
let taskSort = 'row';
try { taskSort = localStorage.getItem('zf-sort') || 'row'; } catch (_) {}
const cellKey = c => String(c || '').toUpperCase().replace(/\d+/g, d => d.padStart(6, '0'));
async function viewTask(id) {
  header({ back: '#tasks', title: 'Задание' });
  if (!S.task[id]) loading();
  let d;
  try { d = await loadTask(id); } catch (e) { return failView(e, () => viewTask(id)); }
  await refreshQueue();
  const items = d.items || [];
  const localCount = it => queueFor(it.id).length;
  const done = items.filter(i => i.status === 'done').length;
  header({ back: '#tasks', title: d.task.title });
  app.innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="count"><span class="mu">Снято товаров</span><b>${done} / ${items.length}</b></div>
        <div class="prog" style="margin-top:8px"><i style="width:${items.length ? Math.round(done / items.length * 100) : 0}%"></i></div>
      </div>
      <button class="btn pri big" type="button" id="scan">Сканировать коробку</button>
      <input class="in" id="search" type="search" placeholder="Артикул, код 1С или название" value="${esc(taskSearch)}" aria-label="Поиск товара" autocomplete="off">
      <div class="chips" role="tablist">
        <button type="button" data-f="todo">Не сняты ${items.filter(i => i.status === 'todo').length}</button>
        <button type="button" data-f="all">Все ${items.length}</button>
        <button type="button" data-f="done">Сняты ${done}</button>
        <button type="button" data-f="absent">Нет на приёмке ${items.filter(i => i.status === 'absent').length}</button>
      </div>
      <div class="chips" role="group" aria-label="Порядок">
        <button type="button" data-s="row">По номеру</button>
        <button type="button" data-s="cell">По ячейке</button>
      </div>
      <div class="list" id="items"></div>
    </div>`;
  const body = $('#items');
  function draw() {
    app.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === taskFilter));
    const q = taskSearch.trim(), qn = norm(q), qu = q.toUpperCase();
    let list = taskFilter === 'all' ? items : items.filter(i => i.status === taskFilter);
    if (q) list = items.filter(i => (i.article_norm || '').includes(qn) || norm(i.code_1c).includes(qn) || (i.name || '').toUpperCase().includes(qu) || norm(i.cell).includes(qn));
    list = [...list];
    if (taskSort === 'cell') list.sort((a, b) => (a.cell ? 0 : 1) - (b.cell ? 0 : 1) || cellKey(a.cell).localeCompare(cellKey(b.cell)) || num(a.row_no) - num(b.row_no));
    else list.sort((a, b) => num(a.row_no) - num(b.row_no));
    app.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === taskSort));
    body.innerHTML = list.map(i => {
      const n = num(i.photos_stored) + localCount(i);
      const pill = i.status === 'done' ? '<span class="pill ok">снят</span>' : i.status === 'absent' ? '<span class="pill er">нет</span>' : n ? `<span class="pill bl">${n} фото</span>` : '<span class="pill">не снят</span>';
      return `<a class="row" href="#item-${num(d.task.id)}-${num(i.id)}"><span class="a">${i.cell ? `<span class="cell">${esc(i.cell)}</span> ` : ''}${esc(i.article)}</span>${pill}<span class="n">${i.row_no ? '№ ' + esc(i.row_no) + ' · ' : ''}${esc(i.brand || '')} · ${esc(i.name || '')}</span></a>`;
    }).join('') || `<div class="empty">${q ? 'Ничего не найдено' : 'Здесь пусто'}</div>`;
  }
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { taskFilter = b.dataset.f; taskSearch = ''; $('#search').value = ''; draw(); });
  app.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { taskSort = b.dataset.s; try { localStorage.setItem('zf-sort', taskSort); } catch (_) {} draw(); });
  $('#search').oninput = e => { taskSearch = e.target.value; draw(); };
  $('#scan').onclick = () => { location.hash = '#scan-' + num(d.task.id); };
  draw();
}

// ─── Товар: съёмка ────────────────────────────────────────
async function viewItem(taskId, itemId) {
  header({ back: '#task-' + taskId, title: 'Товар' });
  if (!S.task[taskId]) { loading(); try { await loadTask(taskId); } catch (e) { return failView(e, () => viewItem(taskId, itemId)); } }
  await refreshQueue();
  drawItem(taskId, itemId);
}
function localSrc(q) { return q.file_base64 ? 'data:' + (q.type || 'image/jpeg') + ';base64,' + q.file_base64 : ''; }
function drawItem(taskId, itemId) {
  const it = findItem(taskId, itemId);
  if (!it) return failView(new Error('Товар не найден в задании'));
  const keepComment = $('#comment') ? $('#comment').value : null;
  header({ back: '#task-' + taskId, title: it.article });
  const server = (it.photos || []).filter(p => p.file_url).sort((a, b) => num(a.photo_index) - num(b.photo_index));
  const local = queueFor(it.id);
  const n = server.length + local.length;
  const pct = Math.min(100, Math.round(n / MIN_PHOTOS * 100));
  const tiles = [
    ...server.map(p => ({ src: thumb(p.file_url), badge: '', cls: '' })),
    ...local.map(q => ({ src: localSrc(q), badge: q.status === 'rejected' ? 'ошибка' : q.status === 'sending' ? 'отправка…' : 'в очереди', cls: q.status === 'rejected' ? 'er' : '' }))
  ];
  app.innerHTML = `
    <div class="stack">
      <div>
        <h1 class="mono">${esc(it.article)} <span class="mu" style="font-family:'Golos Text',system-ui,sans-serif;font-size:15px;font-weight:400">${esc(it.brand || '')}</span></h1>
        <div class="sub">${esc(it.name || '')}</div>
        <div class="sub mono" style="font-size:12.5px">код 1С ${esc(it.code_1c)}${it.row_no ? ' · № ' + esc(it.row_no) : ''}</div>
      </div>
      <div class="card" style="display:flex;justify-content:space-between;align-items:center"><span class="mu">Ячейка на складе</span><b class="mono" style="font-size:20px">${it.cell ? esc(it.cell) : '—'}</b></div>
      ${it.status === 'done' ? '<div class="info">Товар отмечен снятым. Можно доснять фото.</div>' : it.status === 'absent' ? '<div class="note">Отмечено: нет на приёмке.</div>' : ''}
      <div class="card">
        <div class="count"><span class="mu">Снято</span><b>${n} <span class="mu" style="font-size:14px;font-weight:400">· минимум ${MIN_PHOTOS}, максимум ${MAX_PHOTOS}</span></b></div>
        <div class="prog" style="margin-top:8px"><i style="width:${pct}%"></i></div>
      </div>
      ${n === 0 ? '<div class="info">Первое фото — этикетка коробки, чтобы было видно артикул.</div>' : ''}
      <div class="grid">
        ${tiles.map((t, k) => `<div class="ph ${k === 0 ? 'first' : ''}"><img src="${esc(t.src)}" alt="Фото ${k + 1}" loading="lazy"><span class="n">${k + 1}</span>${t.badge ? `<span class="b ${t.cls}">${t.badge}</span>` : ''}</div>`).join('')}
        ${n < MAX_PHOTOS ? `<button class="add" type="button" id="add-tile" aria-label="Снять фото"><span>+</span>Снять</button>` : ''}
      </div>
      ${local.some(q => q.status === 'rejected') ? `<div class="err">Часть фото сервер не принял: ${esc(local.find(q => q.status === 'rejected').error || '')}. Переснимите их.</div>` : ''}
      <div>
        <label class="mu" for="comment" style="display:block;font-size:13px;margin-bottom:4px">Комментарий ${n < MIN_PHOTOS ? '(обязателен, если фото меньше ' + MIN_PHOTOS + ')' : ''}</label>
        <textarea class="in" id="comment" placeholder="Например: мелкая деталь">${esc(keepComment !== null ? keepComment : it.comment || '')}</textarea>
      </div>
      <button class="btn" type="button" id="absent">Нет на приёмке</button>
    </div>
    <div class="dock"><div class="in-dock">
      <div class="row2">
        <button class="btn pri big" type="button" id="shoot" ${n >= MAX_PHOTOS ? 'disabled' : ''}>Снять фото</button>
        <button class="btn big" type="button" id="done">${n >= MIN_PHOTOS ? 'Готово' : 'Готово · ' + n + '/' + MIN_PHOTOS}</button>
      </div>
    </div></div>`;
  const shoot = () => takePhoto(taskId, it, n);
  $('#shoot').onclick = shoot;
  if ($('#add-tile')) $('#add-tile').onclick = shoot;
  $('#done').onclick = () => setStatus(taskId, it, 'done', n);
  $('#absent').onclick = () => setStatus(taskId, it, 'absent', n);
}
function takePhoto(taskId, it, n) {
  if (n >= MAX_PHOTOS) { toast('Уже ' + MAX_PHOTOS + ' фото — это максимум'); return; }
  const cam = $('#cam');
  cam.value = '';
  cam.onchange = async () => {
    const file = cam.files && cam.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast(file.type === 'image/heic' || file.type === 'image/heif'
        ? 'Фото в HEIC. На iPhone: Настройки → Камера → Форматы → «Наиболее совместимый»'
        : 'Нужен JPEG или PNG, получено: ' + (file.type || 'неизвестный формат'), 5000);
      return;
    }
    // Как в GhostAudit: снимок сразу переводим в base64 и храним в очереди строкой.
    let b64;
    try { b64 = await fileToBase64(file); } catch (_) { b64 = ''; }
    if (!b64) { toast('Не удалось прочитать фото, снимите ещё раз', 4000); return; }
    const q = {
      photo_uid: uuid(), task_id: num(taskId), item_id: num(it.id),
      seq: n + 1, shot_at: new Date().toISOString(), created: Date.now(),
      file_base64: b64, type: file.type || 'image/jpeg', size: file.size, status: 'wait'
    };
    await DB.put('queue', q);
    await refreshQueue();
    vibrate(30);
    drawItem(taskId, it.id);
    sync();
  };
  cam.click();
}
async function setStatus(taskId, it, status, n) {
  const comment = ($('#comment').value || '').trim();
  if (status === 'done' && n < MIN_PHOTOS && !comment) {
    toast('Фото меньше ' + MIN_PHOTOS + '. Доснимите или напишите причину в комментарии', 4000);
    $('#comment').focus(); return;
  }
  const btns = [$('#done'), $('#absent')]; btns.forEach(b => b.disabled = true);
  try {
    await api('/photo/item-status', { method: 'POST', body: { item_id: num(it.id), status, comment } });
    it.status = status; it.comment = comment;
    await cachePut(S.task[taskId], 'task-' + taskId);
    vibrate([20, 40, 20]);
    toast(status === 'done' ? 'Готово: ' + it.article : 'Отмечено: нет на приёмке');
    location.hash = '#task-' + taskId;
  } catch (e) {
    btns.forEach(b => b.disabled = false);
    toast(e.offline ? 'Нет сети. Фото сохранены, отметьте «Готово», когда появится связь' : e.message, 4000);
  }
}

// ─── Новый товар без Excel ────────────────────────────────
// Товар попадает в задание «Поток с приёмки» за сегодня (создаётся автоматически)
function viewAdd(prefill) {
  header({ back: '#tasks', title: 'Новый товар' });
  app.innerHTML = `
    <div class="stack">
      <div class="info">Товар без Excel попадёт в задание «Поток с приёмки» за сегодня. Нужна сеть.</div>
      <label class="stack" style="gap:4px"><span class="mu" style="font-size:13px">Артикул *</span><input class="in mono" id="a-article" value="${esc(prefill)}" autocomplete="off" autocapitalize="characters"></label>
      <label class="stack" style="gap:4px"><span class="mu" style="font-size:13px">Бренд *</span><input class="in" id="a-brand" autocomplete="off" placeholder="Mobis, VAG, GMB…"></label>
      <label class="stack" style="gap:4px"><span class="mu" style="font-size:13px">Код 1С (если знаете)</span><input class="in mono" id="a-code" autocomplete="off"></label>
      <label class="stack" style="gap:4px"><span class="mu" style="font-size:13px">Название</span><input class="in" id="a-name" autocomplete="off"></label>
      <label class="stack" style="gap:4px"><span class="mu" style="font-size:13px">Ячейка на складе</span><input class="in mono" id="a-cell" autocomplete="off" autocapitalize="characters"></label>
      <div class="mu" style="font-size:12.5px">Если кода 1С нет, товару дадут временный код NEW-артикул; админ сверит его с 1С позже.</div>
    </div>
    <div class="dock"><div class="in-dock"><button class="btn pri big" type="button" id="a-save">Добавить и снимать</button></div></div>`;
  $(prefill ? '#a-brand' : '#a-article').focus();
  $('#a-save').onclick = async () => {
    const body = {
      article: $('#a-article').value.trim(), brand: $('#a-brand').value.trim(),
      code_1c: $('#a-code').value.trim(), name: $('#a-name').value.trim(), cell: $('#a-cell').value.trim(),
      source: 'pwa'
    };
    if (!body.article) { toast('Введите артикул'); $('#a-article').focus(); return; }
    if (!body.brand) { toast('Введите бренд — он нужен для имени файла'); $('#a-brand').focus(); return; }
    const btn = $('#a-save'); btn.disabled = true; btn.textContent = 'Добавляю…';
    try {
      const r = await api('/photo/item-add', { method: 'POST', body });
      await loadTask(r.task_id);
      toast(r.created ? 'Товар добавлен в поток с приёмки' : 'Товар уже есть в потоке — открываю');
      location.hash = `#item-${num(r.task_id)}-${num(r.item_id)}`;
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Добавить и снимать';
      toast(e.offline ? 'Нет сети. Добавить товар можно только онлайн' : e.message, 4000);
    }
  };
}

// ─── Очередь ──────────────────────────────────────────────
async function viewQueue() {
  header({ back: history.length > 1 ? '#tasks' : '#tasks', title: 'Очередь отправки' });
  await refreshQueue();
  const list = [...S.queue].sort((a, b) => a.created - b.created);
  app.innerHTML = `
    <div class="stack">
      <div class="${S.online ? 'info' : 'note'}">${S.online ? 'Сеть есть.' : 'Нет сети.'} ${list.length ? 'Фото хранятся на телефоне и отправятся автоматически.' : 'Все фото отправлены.'}</div>
      ${list.length ? `<div class="list">${list.map(q => {
        const it = findItem(q.task_id, q.item_id);
        return `<div class="row" style="cursor:default"><span class="a">${esc(it ? it.article : 'товар ' + q.item_id)}</span>
          <span class="pill ${q.status === 'rejected' ? 'er' : 'wa'}">${q.status === 'rejected' ? 'ошибка' : q.status === 'sending' ? 'отправка' : 'ждёт'}</span>
          <span class="n">фото ${q.seq} · ${(q.size / 1048576).toFixed(1)} МБ${q.error ? ' · ' + esc(q.error) : ''}</span></div>`;
      }).join('')}</div>
      <button class="btn pri" type="button" id="send">Отправить сейчас</button>
      ${list.some(q => q.status === 'rejected') ? '<button class="btn" type="button" id="drop">Удалить фото с ошибками</button>' : ''}` : ''}
    </div>`;
  if ($('#send')) $('#send').onclick = () => { S.queue.forEach(q => { if (q.status === 'rejected') q.status = 'wait'; }); Promise.all(S.queue.map(q => DB.put('queue', q))).then(sync); };
  if ($('#drop')) $('#drop').onclick = async () => {
    if (!confirm('Удалить фото, которые сервер не принял?')) return;
    for (const q of S.queue.filter(q => q.status === 'rejected')) await DB.del('queue', q.photo_uid);
    viewQueue();
  };
}

// ─── Сканер ───────────────────────────────────────────────
// Распознавание — zxing-wasm (тот же движок ZXing-C++, которым проверяли коробку LPR):
// файлы лежат у нас в vendor/, без внешних CDN.
const SCAN_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'QRCode', 'DataMatrix'];
let zxReady = null;
function zxInit() {
  if (zxReady) return zxReady;
  if (!window.ZXingWASM) return Promise.reject(new Error('Модуль сканера не загрузился'));
  // .wasm загружаем сами: не зависит от настроек MIME на хостинге и работает из кэша без сети
  zxReady = fetch('./vendor/zxing_reader.wasm')
    .then(r => { if (!r.ok) throw new Error('Модуль сканера не найден (' + r.status + ')'); return r.arrayBuffer(); })
    .then(buf => { ZXingWASM.prepareZXingModule({ overrides: { wasmBinary: buf }, fireImmediately: true }); })
    .catch(e => { zxReady = null; throw e; });
  return zxReady;
}
async function readCodes(imageData) {
  await zxInit();
  const res = await ZXingWASM.readBarcodes(imageData, { formats: SCAN_FORMATS, tryHarder: true, maxNumberOfSymbols: 6 });
  return res.filter(r => r.isValid && r.text).map(r => r.text);
}
let scanStream = null, scanTimer = null, scanDone = false;
function stopScanner() {
  scanDone = true;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const s = $('#scan-ui'); if (s) s.remove();
}
function codeCandidates(text) {
  const out = new Set([text]);
  try { // QR LPR: http://www.qrvehiclelabel.biz/show.php?qr=<артикул в base64>
    const u = new URL(text);
    const qr = u.searchParams.get('qr');
    if (qr) out.add(atob(qr));
  } catch (_) {}
  return [...out].map(norm).filter(Boolean);
}
function matchItem(items, text) {
  const c = codeCandidates(text);
  return items.find(i => c.includes(i.article_norm) || c.includes(norm(i.code_1c)))
      || items.find(i => i.article_norm && c.some(x => x.length >= 6 && (x.includes(i.article_norm) || i.article_norm.includes(x))));
}
function matchAny(items, texts) {
  for (const t of texts) { const it = matchItem(items, t); if (it) return it; }
  return null;
}
async function viewScan(taskId) {
  header({ back: '#task-' + taskId, title: 'Сканер' });
  let d;
  try { d = await loadTask(taskId, { cachedFirst: true }); } catch (e) { return failView(e); }
  app.innerHTML = '';
  scanDone = false;
  const ui = document.createElement('div');
  ui.className = 'scan'; ui.id = 'scan-ui';
  ui.innerHTML = `
    <video id="v" playsinline muted autoplay></video>
    <div class="frame" aria-hidden="true"></div>
    <div class="hint" id="s-hint">Наведите на штрих-код или QR. Держите 15–25 см</div>
    <div class="tools"><button type="button" id="s-close">✕ Закрыть</button><span><button type="button" id="s-zoom" hidden>×2</button> <button type="button" id="s-torch" hidden>Фонарик</button></span></div>
    <div class="sheet" id="s-sheet">
      <div class="mu" id="s-status" style="font-size:13px" aria-live="polite">Запуск камеры…</div>
      <button class="btn pri" type="button" id="s-photo">Сфотографировать код</button>
      <div class="row2"><input class="in" id="s-manual" placeholder="Или артикул" autocomplete="off" aria-label="Артикул вручную"><button class="btn" type="button" id="s-find">Найти</button></div>
    </div>`;
  document.body.appendChild(ui);
  $('#s-close').onclick = () => { location.hash = '#task-' + taskId; };
  $('#s-find').onclick = () => { const v = $('#s-manual').value.trim(); if (v) onScan(d, taskId, [v], true); };
  $('#s-manual').onkeydown = e => { if (e.key === 'Enter') $('#s-find').click(); };
  $('#s-photo').onclick = () => scanFromPhoto(d, taskId);
  const status = t => { const el = $('#s-status'); if (el) el.textContent = t; };
  try { await zxInit(); } catch (e) { status(e.message + '. Используйте «Сфотографировать код» или ввод артикула.'); }
  const video = $('#v');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    status(e && e.name === 'NotAllowedError' ? 'Нет доступа к камере. Разрешите камеру для сайта или используйте «Сфотографировать код».' : 'Камера недоступна: ' + (e.message || e.name));
    return;
  }
  if (scanDone) { scanStream.getTracks().forEach(t => t.stop()); return; }
  video.srcObject = scanStream;
  try { await video.play(); } catch (_) {}
  const track = scanStream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) {}
  if (caps.torch) { const tb = $('#s-torch'); tb.hidden = false; let on = false; tb.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); }; }
  if (caps.zoom && caps.zoom.max >= 2) { const zb = $('#s-zoom'); zb.hidden = false; let z = false; zb.onclick = () => { z = !z; zb.textContent = z ? '×1' : '×2'; track.applyConstraints({ advanced: [{ zoom: z ? 2 : (caps.zoom.min || 1) }] }).catch(() => {}); }; }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let frames = 0, lastRead = '', misses = 0;
  const loop = async () => {
    if (scanDone || !scanStream) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      const k = Math.min(1, 1920 / Math.max(w, h));
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const texts = await readCodes(ctx.getImageData(0, 0, canvas.width, canvas.height));
        frames++;
        if (texts.length) {
          if (onScan(d, taskId, texts, false)) return;
          // код прочитан, но товара нет — показываем после двух одинаковых чтений
          if (texts[0] === lastRead) misses++; else { lastRead = texts[0]; misses = 1; }
          if (misses >= 2) { onScan(d, taskId, texts, true); return; }
          status('Прочитано: ' + texts[0] + ' — ищу в задании…');
        } else if (frames % 5 === 0) {
          status('Ищу код… Держите ровно, код целиком в рамке');
        }
      } catch (e) { status('Ошибка распознавания: ' + (e.message || e)); }
    }
    scanTimer = setTimeout(loop, 80);
  };
  status('Ищу код…');
  loop();
}
// Запасной путь: снимок родной камерой (резкий, с автофокусом) и распознавание по нему
function scanFromPhoto(d, taskId) {
  const cam = $('#cam');
  cam.value = '';
  cam.onchange = async () => {
    const file = cam.files && cam.files[0];
    if (!file) return;
    const st = $('#s-status'); if (st) st.textContent = 'Распознаю фото…';
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const cx = c.getContext('2d'); cx.drawImage(bmp, 0, 0, c.width, c.height);
      const texts = await readCodes(cx.getImageData(0, 0, c.width, c.height));
      if (!texts.length) { if (st) st.textContent = 'На фото код не найден. Снимите ближе и ровнее.'; return; }
      onScan(d, taskId, texts, true);
    } catch (e) { if (st) st.textContent = 'Не удалось обработать фото: ' + (e.message || e); }
  };
  cam.click();
}
// Возвращает true, если товар найден и открыт
function onScan(d, taskId, texts, showMiss) {
  const it = matchAny(d.items || [], texts);
  if (it) {
    vibrate(60); stopScanner();
    location.hash = `#item-${num(taskId)}-${num(it.id)}`;
    return true;
  }
  if (!showMiss) return false;
  vibrate([30, 60, 30]);
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  const sheet = $('#s-sheet');
  if (!sheet) return false;
  sheet.innerHTML = `
    <div><b>Нет в этом задании</b><div class="mu mono" style="font-size:13px;word-break:break-all">${texts.map(esc).join('<br>')}</div></div>
    <button class="btn pri" type="button" id="s-again">Сканировать ещё</button>
    <button class="btn" type="button" id="s-list">Найти в списке вручную</button>
    <button class="btn" type="button" id="s-add">Добавить как новый товар</button>`;
  $('#s-again').onclick = () => { stopScanner(); viewScan(taskId); };
  $('#s-list').onclick = () => { taskFilter = 'all'; taskSearch = ''; location.hash = '#task-' + taskId; };
  $('#s-add').onclick = () => {
    const c = codeCandidates(texts[0]);
    location.hash = '#add-' + encodeURIComponent(c[c.length - 1] || texts[0]);
  };
  return false;
}

// ─── Push-уведомления ─────────────────────────────────────
// Телефон подписывается один раз (кнопка на экране заданий), подписка уходит в n8n.
// Публичный VAPID-ключ берём с сервера, чтобы он всегда совпадал с ключом отправки.
// iPhone: push работает только в приложении, установленном на экран «Домой» из Safari (iOS 16.4+).
const b64uToBytes = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const r = atob(s), a = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a;
};
const bytesToB64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  const m = ua.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/);
  if (m) return 'Android · ' + m[1].trim();
  return /Android/.test(ua) ? 'Android' : (navigator.platform || 'браузер');
}
const Push = {
  reg: null, key: null,
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:'; },
  isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); },
  standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; },
  state() {
    if (Local.on()) return 'local';
    if (!this.supported()) return this.isIOS() && !this.standalone() ? 'ios-install' : (Local.supported() ? 'off' : 'unsupported');
    if (Notification.permission === 'denied') return 'denied';
    let on = false; try { on = localStorage.getItem('zf-push') === 'on'; } catch (_) {}
    return Notification.permission === 'granted' && on ? 'on' : 'off';
  },
  // Готовим заранее, чтобы по нажатию кнопки сразу спросить разрешение (iPhone требует это в момент нажатия)
  prepare() {
    if (!this.supported()) return Promise.resolve();
    if (this.reg && this.key) return Promise.resolve();
    if (!this._prep) this._prep = (async () => {
      try {
        if (!this.reg) this.reg = await navigator.serviceWorker.ready;
        if (!this.key) this.key = (await api('/photo/push/key')).key;
      } catch (_) {}
      this._prep = null;
    })();
    return this._prep;
  },
  async subscribe() {
    if (!this.reg || !this.key) await this.prepare();
    if (!this.reg || !this.key) throw new Error('Нет связи с сервером');
    let sub = await this.reg.pushManager.getSubscription();
    // подписка со старым ключом не получит уведомления — пересоздаём
    if (sub && sub.options && sub.options.applicationServerKey && bytesToB64u(sub.options.applicationServerKey) !== this.key) {
      await sub.unsubscribe(); sub = null;
    }
    if (!sub) sub = await this.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(this.key) });
    const j = sub.toJSON();
    await api('/photo/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys, device: deviceName() } });
    try { localStorage.setItem('zf-push', 'on'); } catch (_) {}
  },
  async enable(btn) {
    // запрос разрешения — первым действием, без ожиданий до него
    const perm = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    btn.disabled = true; btn.textContent = 'Включаю…';
    try {
      if (await perm !== 'granted') { this.draw(); return; }
      if (!this.supported()) throw new Error('push не поддерживается');
      await this.subscribe();
      Local.set(false);
      toast('Уведомления включены');
    } catch (e) {
      // Нет службы push (например, Android без сервисов Google) — уведомления от самого приложения
      if (Notification.permission === 'granted' && Local.supported()) {
        Local.set(true);
        toast('Push на этом устройстве недоступен. Включены уведомления, пока приложение открыто', 5000);
      } else {
        toast('Не удалось включить уведомления: ' + (e.message || e), 4000);
      }
    }
    this.draw();
  },
  // при каждом запуске тихо обновляем подписку на сервере (адрес подписки иногда меняется)
  async refresh() {
    if (!Auth.token) return;
    if (Local.on()) { Local.start(); return; }
    if (this.state() === 'unsupported' || !this.supported() || Notification.permission !== 'granted') return;
    try { await this.subscribe(); this.draw(); } catch (e) { console.warn('push', e); }
  },
  draw() {
    const box = $('#push-box'); if (!box) return;
    const st = this.state();
    if (st === 'off') {
      box.innerHTML = '<button class="btn" type="button" id="push-on">🔔 Включить уведомления о новых заданиях</button>';
      $('#push-on').onclick = e => this.enable(e.currentTarget);
      this.prepare();
    } else if (st === 'on') {
      box.innerHTML = '<div class="mu" style="font-size:13px;text-align:center">🔔 Уведомления включены</div>';
    } else if (st === 'local') {
      box.innerHTML = '<div class="mu" style="font-size:13px;text-align:center">🔔 Уведомления включены, пока приложение открыто<br>(на этом устройстве нет службы push)</div>';
    } else if (st === 'denied') {
      box.innerHTML = '<div class="info">Уведомления запрещены. Разрешите их для этого приложения в настройках телефона.</div>';
    } else if (st === 'ios-install') {
      box.innerHTML = '<div class="info">Чтобы получать уведомления на iPhone, откройте сайт в Safari → «Поделиться» → «На экран „Домой“» и запускайте приложение с иконки.</div>';
    } else box.innerHTML = '';
  }
};
// ─── Уведомления без push-службы ──────────────────────────
// Для КПК без сервисов Google (push в Chrome там не работает): пока приложение открыто,
// раз в 45 с проверяем задания и показываем системное уведомление о новом.
const Local = {
  timer: null, KEY: 'zf-notify-local', SEEN: 'zf-seen',
  supported() { return 'Notification' in window && 'serviceWorker' in navigator; },
  on() { try { return localStorage.getItem(this.KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'; } catch (_) { return false; } },
  set(v) {
    try { v ? localStorage.setItem(this.KEY, '1') : localStorage.removeItem(this.KEY); } catch (_) {}
    if (v) this.start(); else this.stop();
  },
  start() {
    if (this.timer || !this.on() || !Auth.token) return;
    this.check(true);
    this.timer = setInterval(() => this.check(false), 45000);
  },
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
  async check(baseline) {
    let tasks;
    try { tasks = (await api('/photo/tasks')).tasks || []; } catch (_) { return; }
    const now = {};
    tasks.filter(t => t.status === 'open').forEach(t => { now[num(t.id)] = num(t.items_total); });
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(this.SEEN) || 'null'); } catch (_) {}
    try { localStorage.setItem(this.SEEN, JSON.stringify(now)); } catch (_) {}
    if (baseline && seen === null) return;          // первый запуск — только запоминаем
    seen = seen || {};
    for (const t of tasks) {
      const id = num(t.id);
      if (!(id in now)) continue;
      const before = seen[id];
      if (before === undefined) await this.notify('Новое задание', t.title + ' · ' + now[id] + ' ' + plural(now[id], 'товар', 'товара', 'товаров'), '#task-' + id);
      else if (now[id] > before) { const d = now[id] - before; await this.notify('Новые товары для съёмки', t.title + ': +' + d + ' ' + plural(d, 'товар', 'товара', 'товаров'), '#task-' + id); }
    }
  },
  async notify(title, body, url) {
    vibrate([200, 100, 200]);
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 3000))]);
      if (reg) await reg.showNotification(title, { body, icon: './icons/icon-192.png', tag: 'zf-local-' + url, renotify: true, data: { url } });
      else { const n = new Notification(title, { body, icon: './icons/icon-192.png' }); n.onclick = () => { window.focus(); location.hash = url; }; }
    } catch (_) { toast(title + ': ' + body, 5000); }
    if (current && /^#?(tasks)?$/.test(current.h)) viewTasks();
  }
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Local.on()) Local.check(false); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    const m = String(d.url || '').match(/^#(?:task|item)-(\d+)/);
    if (m) delete S.task[m[1]];                      // задание изменилось — при открытии взять свежее
    if (d.type === 'open' && d.url) {
      if (location.hash === d.url) route(); else location.hash = d.url;
    } else if (d.type === 'push' && current && /^#?(tasks)?$/.test(current.h)) {
      viewTasks();                                   // на списке заданий — сразу показать новое
    }
  });
}

// ─── Экран входа фотографа ───────────────────────────────
// Нарочно не похож на вход в админку: тёмный, крупный, «приложение фотографа».
const ADMIN_URL = 'https://zenith-to.onrender.com/admin.html';
function showLogin(msg) {
  stopScanner();
  Local.stop();
  document.body.classList.add('login-on');
  document.title = 'Вход — приложение фотографа';
  $('#top').innerHTML = '';
  const wait = S.queue.filter(q => q.status !== 'rejected').length;
  app.innerHTML = `<form class="login" id="pwa-login-form" name="photographer-login" novalidate>
    <div class="login-cam" aria-hidden="true">📷</div>
    <div class="login-kicker">Зеніт-Авто.фото</div>
    <h1>Приложение фотографа</h1>
    <p class="login-sub">Войдите один раз — дальше телефон помнит вход</p>
    ${wait ? `<div class="login-note">На телефоне ${wait} ${plural(wait, 'фото ждёт', 'фото ждут', 'фото ждут')} отправки. После входа они уйдут сами.</div>` : ''}
    ${msg ? `<div class="login-note">${esc(msg)}</div>` : ''}
    <label>Логин<input id="pl-login" name="photographer-login-name" autocomplete="section-photographer username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(Auth.lastLogin())}"></label>
    <label>Пароль<input id="pl-pass" name="photographer-login-password" type="password" autocomplete="section-photographer current-password"></label>
    <button class="login-go" type="submit" id="pl-go">Войти</button>
    <div id="pl-err"></div>
    <p class="login-foot">Менеджер или администратор? Вам в админку на компьютере: ${ADMIN_URL.replace('https://', '')}</p>
    <p class="login-foot">${APP_VERSION}</p>
  </form>`;
  $('#pwa-login-form').onsubmit = async e => {
    e.preventDefault();
    const login = $('#pl-login').value.trim(), password = $('#pl-pass').value;
    const err = m => { $('#pl-err').innerHTML = '<div class="login-err">' + esc(m) + '</div>'; };
    if (!login || !password) return err('Введите логин и пароль');
    const b = $('#pl-go'); b.disabled = true; b.textContent = 'Входим…';
    try {
      const d = await api('/photo/auth/login', { method: 'POST', noAuth: true, body: { login, password, scope: 'pwa', device: deviceName(), app_version: APP_VERSION } });
      Auth.save(d.token, d.user);
      S.tasks = null; S.task = {};
      location.hash = '#tasks'; route();
      sync().catch(() => {});
      Push.refresh();
    } catch (ex) {
      err(ex.offline ? 'Нет связи с сервером. Для входа нужен интернет' : ex.message);
      b.disabled = false; b.textContent = 'Войти';
    }
  };
  (Auth.lastLogin() ? $('#pl-pass') : $('#pl-login')).focus();
}
async function logout() {
  await refreshQueue();
  const wait = S.queue.filter(q => q.status !== 'rejected').length;
  const ask = wait
    ? `На телефоне ${wait} неотправленных фото. Они останутся и уйдут после следующего входа. Выйти?`
    : 'Выйти из приложения? Для входа понадобятся логин и пароль.';
  if (!confirm(ask)) return;
  const t = Auth.token;
  Auth.clear();
  try { localStorage.removeItem('zf-push'); } catch (_) {}
  try {     // этот телефон больше не получает уведомления прежнего пользователя
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (sub) await sub.unsubscribe();
  } catch (_) {}
  try { await fetch(API_BASE + '/photo/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t } }); } catch (_) {}
  try { await DB.del('cache', 'tasks'); } catch (_) {}
  S.tasks = null; S.task = {};
  showLogin();
}
// проверка входа при запуске: заблокированного или чужого пользователя — на экран входа
async function checkMe() {
  if (!Auth.token) return;
  try {
    const d = await api('/photo/auth/me?scope=pwa');
    if (d.user) Auth.save(Auth.token, d.user);
  } catch (e) {
    if (e.status === 403) { Auth.clear(); showLogin(e.message); }
  }
}

// ─── запуск ───────────────────────────────────────────────
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
// Старт не зависит от хранилища: даже если IndexedDB недоступна, интерфейс рисуется.
(async () => {
  try { await Promise.race([refreshQueue(), new Promise(r => setTimeout(r, 2500))]); } catch (e) { console.warn('queue', e); }
  route();
  if (Auth.token) {
    checkMe();
    sync().catch(() => {});
    Push.refresh();
  }
})();
