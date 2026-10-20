// DOBEG LEAGUE Livery Launcher — основная логика интерфейса.
import { $, $$, esc, sleep, decodeText, parseJsonBuf, pick, bufToB64, strToB64, gitBlobSha, sha256Hex, safeName, fmtBytes, ls, previewDb } from './util.js';
import { CARS, carName, matchModel } from './cars.js';
import { Showroom, pruneModelCache } from './showroom.js';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
// хеш пароля администратора (SHA-256 от «dobeg2026»). Это защита от случайного входа, а не от взлома:
// реальная защита репозитория — это права GitHub-токена.
const ADMIN_HASH = '62d1e13b49fbbd4d1a08650bc3d2847bcdf05b70b0d07717f39289d4c759199a';
const SYNC_EVERY = 10 * 60 * 1000;

const S = {
  customs: '', remote: null, installed: {}, previews: new Map(),
  isAdmin: ls.get('isAdmin', false), token: ls.get('ghToken', ''),
  q: '', team: 'all', status: 'all',
  busy: new Set(), syncing: false, firstRender: true,
  dismissed: new Set(ls.get('dismissed', [])),
  opt: { autoUpd: true, autoNew: true, ...ls.get('opt', {}) },
};

// ───────────────────────── UI-примитивы ─────────────────────────
function toast(title, msg = '', kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b></b><span></span><div class="bar" hidden><i></i></div>`;
  const api = {
    update(t, m, p) {
      if (t != null) $('b', el).textContent = t;
      if (m != null) $('span', el).textContent = m;
      if (p != null) { $('.bar', el).hidden = false; $('.bar i', el).style.width = `${Math.round(p * 100)}%`; }
      return api;
    },
    close() { el.classList.add('out'); setTimeout(() => el.remove(), 300); },
  };
  api.update(title, msg);
  $('#toasts').append(el);
  if (ms) setTimeout(api.close, ms);
  return api;
}

const modalStack = [];
function openModal(id) { $('#' + id).classList.add('open'); modalStack.push(id); }
function closeModal(id) {
  $('#' + id).classList.remove('open');
  const i = modalStack.lastIndexOf(id); if (i >= 0) modalStack.splice(i, 1);
  if (id === 'm-show') show?.stop();
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) closeModal(c.closest('.overlay').id);
  else if (e.target.classList?.contains('overlay') && e.target.id !== 'm-show') closeModal(e.target.id);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalStack.length) closeModal(modalStack.at(-1)); });

/** Собственное окно подтверждения — window.confirm()/prompt() в WebView блокируются. */
function ask(title, text, yes = 'Подтвердить') {
  return new Promise((res) => {
    $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfYes').textContent = yes;
    openModal('m-confirm');
    const done = (v) => { $('#cfYes').onclick = $('#cfNo').onclick = null; closeModal('m-confirm'); res(v); };
    $('#cfYes').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
  });
}

const errText = (e) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e));

// ───────────────────────── Данные ─────────────────────────
const rawUrl = (path, rev = S.remote?.commit || 'HEAD') =>
  `https://raw.githubusercontent.com/${S.remote?.owner ?? 'kirillkoltun0-ops'}/${S.remote?.repo ?? 'dobeg-liveries'}/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`;

const statusOf = (l) => { const i = S.installed[l.id]; return !i ? 'new' : i.sig !== l.sig ? 'update' : 'ok'; };
const teamLabel = (t) => t || 'Без команды';
const fileOf = (l, name) => l.files.find((f) => f.name.toLowerCase() === name);

function setSync(state, text) {
  $('#syncDot').className = `dot ${state}`;
  $('#syncText').textContent = text;
  $('#btnSync').disabled = state === 'busy';
}

async function sync({ silent = false, auto = true } = {}) {
  if (S.syncing) return;
  S.syncing = true;
  setSync('busy', 'Синхронизация…');
  try {
    const data = await invoke('sync_remote', { token: S.token || null });
    S.remote = data;
    ls.set('remoteCache', data);
    S.installed = await invoke('installed_state', { customs: S.customs });
    const t = new Date();
    setSync('ok', `Синхронизировано ${t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    render();
    renderAdmin();
    pruneModelCache(data.models.map((m) => m.sha));
    if (data.truncated) toast('Репозиторий слишком большой', 'GitHub обрезал дерево файлов — часть ливрей может не отображаться.', 'warn', 8000);
    if (!silent && !auto) toast('Готово', `Ливрей в облаке: ${data.liveries.length}`, 'ok', 2500);
    if (auto) await autoInstall();
  } catch (e) {
    setSync('bad', 'Ошибка синхронизации');
    toast('Не удалось синхронизировать', errText(e), 'bad', 7000);
  } finally {
    S.syncing = false;
  }
}

async function autoInstall() {
  const list = S.remote.liveries.filter((l) => {
    const s = statusOf(l);
    return (s === 'update' && S.opt.autoUpd) || (s === 'new' && S.opt.autoNew && !S.dismissed.has(l.id));
  });
  if (list.length) await installMany(list, 'Автообновление');
}

async function installOne(l) {
  if (S.busy.has(l.id)) return false;
  S.busy.add(l.id); patchCard(l.id);
  try {
    S.installed[l.id] = await invoke('install_livery', { customs: S.customs, livery: l, commit: S.remote.commit });
    S.dismissed.delete(l.id); ls.set('dismissed', [...S.dismissed]);
    return true;
  } catch (e) {
    toast(`Ошибка: ${l.name}`, errText(e), 'bad', 7000);
    return false;
  } finally {
    S.busy.delete(l.id); patchCard(l.id); renderStats();
  }
}

async function installMany(list, label) {
  const t = toast(label, `0 / ${list.length}`, 'info', 0).update(null, null, 0);
  let done = 0, ok = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const l = queue.shift();
      if (await installOne(l)) ok++;
      done++; t.update(null, `${done} / ${list.length}: ${l.name}`, done / list.length);
    }
  };
  await Promise.all([worker(), worker()]);
  t.close();
  toast(label, ok === list.length ? `Установлено ливрей: ${ok}` : `Успешно ${ok} из ${list.length}`, ok === list.length ? 'ok' : 'warn');
}

async function uninstallOne(l) {
  S.busy.add(l.id); patchCard(l.id);
  try {
    await invoke('uninstall_livery', { customs: S.customs, id: l.id });
    delete S.installed[l.id];
    S.dismissed.add(l.id); ls.set('dismissed', [...S.dismissed]); // чтобы автоустановка не вернула её обратно
  } catch (e) { toast('Не удалось удалить', errText(e), 'bad'); }
  finally { S.busy.delete(l.id); patchCard(l.id); renderStats(); }
}

// ───────────────────────── Библиотека ─────────────────────────
const CAR_SVG = `<svg viewBox="0 0 120 40"><path d="M6 28c0-4 3-6 8-7l14-8c3-2 7-3 11-3h28c6 0 10 2 14 6l10 4c5 1 8 3 8 7v3H6z"/><circle cx="32" cy="30" r="6"/><circle cx="92" cy="30" r="6"/></svg>`;

function haystack(l) {
  const m = l.meta;
  return `${l.name} ${teamLabel(l.team)} ${m?.raceNumber != null ? '#' + m.raceNumber + ' ' + m.raceNumber : ''} ${m ? carName(m.carModelType) : ''}`.toLowerCase();
}

function filtered() {
  const q = S.q.trim().toLowerCase();
  return (S.remote?.liveries ?? []).filter((l) =>
    (S.team === 'all' || (S.team === '__none' ? !l.team : l.team === S.team)) &&
    (S.status === 'all' || (S.status === 'installed' ? statusOf(l) !== 'new' : statusOf(l) === S.status)) &&
    (!q || haystack(l).includes(q)));
}

function cardHTML(l, i, animate) {
  const st = statusOf(l), busy = S.busy.has(l.id), m = l.meta;
  const pv = S.previews.get(l.id);
  const pill = { ok: ['ok', 'Установлено'], update: ['update', 'Есть обновление'], new: ['new', 'Не установлено'] }[st];
  const main = st === 'new' ? `<button class="btn primary" data-act="install">Установить</button>`
    : st === 'update' ? `<button class="btn primary" data-act="install">Обновить</button><button class="btn danger icon" data-act="remove" title="Удалить">✕</button>`
    : `<button class="btn" data-act="show">3D-шоурум</button><button class="btn danger icon" data-act="remove" title="Удалить">✕</button>`;
  return `<article class="card ${animate ? '' : 'noanim'} ${busy ? 'busy' : ''}" data-id="${esc(l.id)}" style="--i:${i}">
    <div class="thumb" data-act="show">
      ${pv ? `<img src="${pv.url}" alt="" draggable="false">` : `<div class="ph">${CAR_SVG}<span>3D-превью появится после открытия</span></div>`}
      ${m?.raceNumber > 0 ? `<span class="num">#${m.raceNumber}</span>` : ''}
      <span class="pill ${pill[0]}">${pill[1]}</span>
      <button class="btn sm view3d" data-act="show">▶ 3D</button>
    </div>
    <div class="cbody">
      <h3 title="${esc(l.name)}">${esc(l.name)}</h3>
      <div class="cmeta"><span class="team">${esc(teamLabel(l.team))}</span><span>${m ? esc(carName(m.carModelType)) : ''}</span></div>
      <div class="cact">${main}</div>
    </div>
    <div class="cprog"><i></i></div>
  </article>`;
}

function renderStats() {
  const ls_ = S.remote?.liveries ?? [];
  $('#stTotal').textContent = ls_.length;
  $('#stInst').textContent = ls_.filter((l) => statusOf(l) !== 'new').length;
  $('#stUpd').textContent = ls_.filter((l) => statusOf(l) === 'update').length;
  $('#stTeams').textContent = new Set(ls_.map((l) => l.team)).size;
}

function renderChips() {
  const all = S.remote?.liveries ?? [];
  const teams = [...new Set(all.map((l) => l.team))].sort((a, b) => a.localeCompare(b, 'ru'));
  const cnt = (t) => all.filter((l) => l.team === t).length;
  const chip = (v, label, n) => `<button class="chip ${S.team === v ? 'on' : ''}" data-team="${esc(v)}">${esc(label)} <em>${n}</em></button>`;
  $('#chips').innerHTML = chip('all', 'Все команды', all.length) + teams.map((t) => chip(t || '__none', teamLabel(t), cnt(t))).join('');
  const btn = $('#btnTeamDl');
  const teamList = S.team === 'all' ? [] : all.filter((l) => (S.team === '__none' ? !l.team : l.team === S.team) && statusOf(l) !== 'ok');
  btn.hidden = !teamList.length;
  btn.textContent = `Скачать всю команду (${teamList.length})`;
  btn._list = teamList;
  $('#teamList').innerHTML = teams.filter(Boolean).map((t) => `<option value="${esc(t)}">`).join('');
}

function render(animate = false) {
  renderStats(); renderChips();
  const list = filtered();
  const grid = $('#grid');
  if (!S.remote) { grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skel"></div>').join(''); return; }
  const anim = animate || S.firstRender;
  S.firstRender = false;
  grid.innerHTML = list.length
    ? list.map((l, i) => cardHTML(l, i, anim)).join('')
    : `<div class="empty"><b>${S.remote.liveries.length ? 'Ничего не найдено' : 'В репозитории пока нет ливрей'}</b>Попробуйте изменить поиск или фильтры.</div>`;
}

const cardEl = (id) => $$('.card').find((c) => c.dataset.id === id);
function patchCard(id) {
  const el = cardEl(id), l = S.remote?.liveries.find((x) => x.id === id);
  if (!el || !l) return;
  const t = document.createElement('div');
  t.innerHTML = cardHTML(l, 0, false);
  el.replaceWith(t.firstElementChild);
}

// Прогресс установки из Rust
T.event.listen('install-progress', (ev) => {
  const { id, done, total } = ev.payload;
  const el = cardEl(id);
  if (el) $('.cprog i', el).style.width = `${Math.round((done / total) * 100)}%`;
});

// 3D-tilt и подсветка карточек
let lastTilt = null;
$('#grid').addEventListener('pointermove', (e) => {
  const c = e.target.closest('.card');
  if (lastTilt && lastTilt !== c) { lastTilt.style.setProperty('--rx', '0deg'); lastTilt.style.setProperty('--ry', '0deg'); }
  lastTilt = c;
  if (!c) return;
  const r = c.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  c.style.setProperty('--rx', `${((0.5 - py) * 7).toFixed(2)}deg`);
  c.style.setProperty('--ry', `${((px - 0.5) * 9).toFixed(2)}deg`);
  c.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
  c.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
});
$('#grid').addEventListener('pointerleave', () => { if (lastTilt) { lastTilt.style.setProperty('--rx', '0deg'); lastTilt.style.setProperty('--ry', '0deg'); lastTilt = null; } });

$('#grid').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  const c = e.target.closest('.card');
  if (!a || !c) return;
  const l = S.remote.liveries.find((x) => x.id === c.dataset.id);
  if (!l) return;
  e.stopPropagation();
  if (a.dataset.act === 'install') installOne(l);
  else if (a.dataset.act === 'remove') uninstallOne(l);
  else if (a.dataset.act === 'show') openShow(l.id);
});

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-team]'); if (!b) return;
  S.team = b.dataset.team; render(true);
});
let qT; $('#q').addEventListener('input', (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value; render(true); }, 90); });
$('#statusFilter').addEventListener('change', (e) => { S.status = e.target.value; render(true); });

$('#btnSync').onclick = () => sync({ auto: false });
$('#btnSyncAll').onclick = async () => {
  await sync({ auto: false });
  const list = (S.remote?.liveries ?? []).filter((l) => statusOf(l) !== 'ok');
  if (list.length) await installMany(list, 'Синхронизация'); else toast('Всё актуально', 'Все ливреи уже установлены и обновлены.', 'ok', 3000);
};
$('#btnTeamDl').onclick = (e) => { const l = e.currentTarget._list; if (l?.length) installMany(l, `Команда: ${teamLabel(S.team === '__none' ? '' : S.team)}`); };
$('#btnOpen').onclick = () => invoke('open_folder', { path: S.customs }).catch((e) => toast('Не удалось открыть папку', errText(e), 'bad'));
$('#btnRemoveAll').onclick = async () => {
  const n = Object.keys(S.installed).length;
  if (!n) return toast('Нечего удалять', 'Лаунчер не устанавливал ни одной ливреи.', 'info', 3000);
  if (!(await ask('Удалить все ливреи?', `Будут удалены ${n} ливрей, установленных лаунчером, вместе с их конфигами машин. Ваши собственные скины не пострадают.`, 'Удалить'))) return;
  try {
    const ids = Object.keys(S.installed);
    await invoke('uninstall_all', { customs: S.customs });
    ids.forEach((id) => S.dismissed.add(id)); ls.set('dismissed', [...S.dismissed]);
    S.installed = {};
    render(); toast('Удалено', `Ливрей: ${n}`, 'ok');
  } catch (e) { toast('Ошибка', errText(e), 'bad'); }
};

// ───────────────────────── 3D-шоурум ─────────────────────────
let show = null, cur = null, flipOn = false, spin = true;

function chooseModel(l) {
  const models = S.remote.models, t = l.meta?.carModelType;
  const saved = t != null && ls.get('model:' + t);
  return (saved && models.find((m) => m.path === saved)) || (t != null ? matchModel(t, models) : null);
}

function setLoader(on, txt, p) {
  $('#shLoader').hidden = !on;
  if (txt) $('#shLoadTxt').textContent = txt;
  if (p != null) $('#shLoadBar').style.width = `${Math.round(p * 100)}%`;
}

async function openShow(id) {
  const l = S.remote.liveries.find((x) => x.id === id); if (!l) return;
  cur = { l };
  $('#shTitle').textContent = `${l.meta?.raceNumber > 0 ? '#' + l.meta.raceNumber + ' · ' : ''}${l.name}`;
  $('#shTeam').textContent = teamLabel(l.team);
  openModal('m-show');
  try { show ??= new Showroom($('#glcanvas')); } catch (e) { toast('WebGL недоступен', errText(e), 'bad'); closeModal('m-show'); return; }
  show.resize(); show.start();
  show.setFlipY(!flipOn); show.setAutoRotate(spin);
  updateShowInstallBtn();

  const models = S.remote.models, sel = $('#shModel');
  const m = chooseModel(l);
  sel.innerHTML = `<option value="">— выберите кузов —</option>` + models.map((x, i) => `<option value="${i}" ${m && x.path === m.path ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#shModelNote').textContent = !models.length ? 'В папке models/ репозитория нет .obj / .glb файлов.'
    : m ? `Определено автоматически: ${carName(l.meta?.carModelType)}`
    : l.meta?.carModelType != null ? `Модель для «${carName(l.meta.carModelType)}» не найдена — выберите вручную.` : 'В конфиге нет carModelType — выберите кузов вручную.';
  $('#shInfo').textContent = `Файлов: ${l.files.length}${l.junkCount ? ` · мусорных .dds/.psd в облаке игнорируется: ${l.junkCount}` : ''}`;
  await loadShow(m);
}

async function loadShow(model) {
  if (!model) { setLoader(false); return; }
  const l = cur.l, my = cur;
  setLoader(true, 'Загрузка модели…', 0);
  try {
    await show.setModel({ url: rawUrl(model.path), name: model.name, sha: model.sha }, (p) => setLoader(true, `Загрузка модели… ${Math.round(p * 100)}%`, p));
    setLoader(true, 'Сборка текстуры…', 1);
    const f = (n) => { const x = fileOf(l, n); return x ? rawUrl(x.path) : null; };
    const problems = await show.setLivery({ decals: f('decals.png'), sponsors: f('sponsors.png'), decalsJson: f('decals.json'), sponsorsJson: f('sponsors.json') });
    if (problems.length) toast('Часть слоёв не загружена', problems.join(', '), 'warn');
    setLoader(false);
    if (my === cur) {
      const pv = S.previews.get(l.id);
      if (!pv || pv.sig !== l.sig) { await sleep(350); if (my === cur) await savePreview(true); } // авто-превью при первом показе
    }
  } catch (e) {
    setLoader(false);
    toast('Не удалось показать модель', errText(e), 'bad', 7000);
  }
}

async function savePreview(silent) {
  if (!cur || !show) return;
  const url = show.capture();
  if (!url.startsWith('data:image/')) return;
  const rec = { sig: cur.l.sig, url };
  S.previews.set(cur.l.id, rec);
  await previewDb.set(cur.l.id, rec);
  patchCard(cur.l.id);
  if (!silent) toast('Превью сохранено', cur.l.name, 'ok', 2500);
}

function updateShowInstallBtn() {
  const st = statusOf(cur.l), b = $('#shInstall');
  b.textContent = st === 'new' ? 'Установить в игру' : st === 'update' ? 'Обновить в игре' : 'Переустановить';
  b.disabled = S.busy.has(cur.l.id);
}

$('#shModel').addEventListener('change', async (e) => {
  const m = S.remote.models[+e.target.value];
  if (!m) return;
  if (cur.l.meta?.carModelType != null) ls.set('model:' + cur.l.meta.carModelType, m.path);
  await loadShow(m);
});
$('#shBase').addEventListener('input', (e) => show?.setBaseColor(e.target.value));
$('#shFlip').onclick = () => { flipOn = !flipOn; show?.setFlipY(!flipOn); $('#shFlip').classList.toggle('primary', flipOn); };
$('#shRotate').onclick = () => { spin = !spin; show?.setAutoRotate(spin); $('#shRotate').classList.toggle('primary', !spin); };
$('#shShot').onclick = () => savePreview(false);
$('#shInstall').onclick = async () => { await installOne(cur.l); updateShowInstallBtn(); };

/** Пакетная генерация превью на скрытом рендерере. */
$('#btnPrevAll').onclick = async () => {
  const all = S.remote?.liveries ?? [];
  const todo = all.map((l) => ({ l, m: chooseModel(l) })).filter((x) => x.m);
  if (!todo.length) return toast('Нет подходящих моделей', 'Не удалось сопоставить кузова с файлами в models/.', 'warn');
  const holder = document.createElement('div');
  Object.assign(holder.style, { position: 'fixed', left: '-9999px', top: '0', width: '800px', height: '450px' });
  holder.innerHTML = '<canvas></canvas>';
  document.body.append(holder);
  const t = toast('Генерация превью', `0 / ${todo.length}`, 'info', 0).update(null, null, 0);
  let sr;
  try {
    sr = new Showroom($('canvas', holder), { interactive: false });
    sr.resize();
    let n = 0;
    for (const { l, m } of todo) {
      try {
        await sr.setModel({ url: rawUrl(m.path), name: m.name, sha: m.sha });
        const f = (nm) => { const x = fileOf(l, nm); return x ? rawUrl(x.path) : null; };
        await sr.setLivery({ decals: f('decals.png'), sponsors: f('sponsors.png'), decalsJson: f('decals.json'), sponsorsJson: f('sponsors.json') });
        await sleep(60);
        const url = sr.capture();
        const rec = { sig: l.sig, url };
        S.previews.set(l.id, rec); await previewDb.set(l.id, rec); patchCard(l.id);
      } catch { /* пропускаем проблемную ливрею */ }
      t.update(null, `${++n} / ${todo.length}: ${l.name}`, n / todo.length);
    }
    t.close(); toast('Превью готовы', `Обновлено карточек: ${n}`, 'ok');
  } catch (e) { t.close(); toast('Ошибка генерации', errText(e), 'bad'); }
  finally { sr?.dispose(); holder.remove(); }
};

// ───────────────────────── Профиль и вход ─────────────────────────
function applyRole() {
  $('#profile').classList.toggle('admin', S.isAdmin);
  $('#roleName').textContent = S.isAdmin ? 'Администратор' : 'Пилот';
  $('#tab-admin').hidden = !S.isAdmin;
  if (!S.isAdmin && $('#tab-admin').classList.contains('on')) switchView('library');
}
function switchView(v) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === v));
  $('#view-library').hidden = v !== 'library';
  $('#view-admin').hidden = v !== 'admin';
}
$$('.tab').forEach((t) => (t.onclick = () => switchView(t.dataset.view)));

$('#profile').onclick = async () => {
  if (S.isAdmin) {
    if (await ask('Выйти из режима администратора?', 'Админ-панель будет скрыта.', 'Выйти')) {
      S.isAdmin = false; ls.set('isAdmin', false); applyRole(); toast('Вы вошли как пилот', '', 'info', 2500);
    }
    return;
  }
  $('#loginPass').value = '';
  openModal('m-login');
  setTimeout(() => $('#loginPass').focus(), 120);
};
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ((await sha256Hex($('#loginPass').value)) === ADMIN_HASH) {
    S.isAdmin = true; ls.set('isAdmin', true);
    closeModal('m-login'); applyRole(); switchView('admin');
    toast('Добро пожаловать', 'Режим администратора включён.', 'ok', 3000);
  } else {
    const m = $('#loginForm'); m.classList.remove('shake'); void m.offsetWidth; m.classList.add('shake');
    $('#loginPass').select();
    toast('Неверный пароль', '', 'bad', 2500);
  }
});

// ───────────────────────── Настройки ─────────────────────────
$('#btnSettings').onclick = () => {
  $('#pathInput').value = S.customs;
  $('#optAutoUpd').checked = S.opt.autoUpd; $('#optAutoNew').checked = S.opt.autoNew;
  openModal('m-settings');
};
$('#btnBrowse').onclick = async () => {
  try {
    const p = await T.dialog.open({ directory: true, multiple: false, defaultPath: $('#pathInput').value || undefined, title: 'Папка Customs' });
    if (p) $('#pathInput').value = p;
  } catch (e) { toast('Диалог недоступен', errText(e), 'bad'); }
};
$('#btnPathReset').onclick = async () => { $('#pathInput').value = await invoke('default_customs_path'); };
$('#btnSettingsSave').onclick = async () => {
  S.opt = { autoUpd: $('#optAutoUpd').checked, autoNew: $('#optAutoNew').checked }; ls.set('opt', S.opt);
  const p = $('#pathInput').value.trim();
  if (p && p !== S.customs) {
    try {
      await invoke('ensure_customs', { customs: p });
      S.customs = p; ls.set('customs', p);
      S.installed = await invoke('installed_state', { customs: p });
      render();
    } catch (e) { return toast('Путь недоступен', errText(e), 'bad', 6000); }
  }
  closeModal('m-settings'); toast('Настройки сохранены', '', 'ok', 2000);
};

// ───────────────────────── Админ-панель ─────────────────────────
const A = { items: [], publishing: false };

function renderAdmin() {
  $('#tokenInput').value = S.token;
  const rows = (S.remote?.liveries ?? []).map((l) => `<tr><td>${esc(teamLabel(l.team))}</td><td>${esc(l.name)}</td>
    <td>${l.files.length + (l.carFile ? 1 : 0)}${l.junkCount ? ` <span class="muted">(+${l.junkCount} мусор)</span>` : ''}</td>
    <td><button class="btn sm danger" data-del="${esc(l.id)}">Удалить из репозитория</button></td></tr>`).join('');
  $('#repoRows').innerHTML = rows || `<tr><td colspan="4" class="muted">Пусто</td></tr>`;
}

$('#btnTokenSave').onclick = async () => {
  const t = $('#tokenInput').value.trim();
  S.token = t; ls.set('ghToken', t);
  if (!t) { $('#tokenState').textContent = 'Токен удалён'; return refreshPublish(); }
  $('#tokenState').innerHTML = '<span class="spin"></span>';
  try {
    const r = await invoke('github_check_token', { token: t });
    $('#tokenState').textContent = r.canPush ? `✔ ${r.login} · запись разрешена` : `⚠ ${r.login} · нет права записи в репозиторий`;
    toast(r.canPush ? 'Токен принят' : 'Токен без прав записи', r.login, r.canPush ? 'ok' : 'warn');
  } catch (e) { $('#tokenState').textContent = '✖ ' + errText(e); }
  refreshPublish();
};

// — сбор файлов из drag&drop и <input webkitdirectory> —
async function walkEntry(entry, base, out) {
  const path = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    await new Promise((res) => entry.file((file) => { out.push({ path, file }); res(); }, res));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const ch of batch) await walkEntry(ch, path, out);
    }
  }
}

const drop = $('#drop');
drop.onclick = () => $('#dirInput').click();
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean); // синхронно, до await
  const out = [];
  for (const en of entries) await walkEntry(en, '', out);
  await ingest(out);
});
$('#dirInput').addEventListener('change', async (e) => {
  const list = [...e.target.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
  e.target.value = '';
  await ingest(list);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

const lc = (s) => s.toLowerCase();
const extOf = (n) => (n.includes('.') ? lc(n.split('.').pop()) : '');

async function readCar(file) {
  const buf = await file.arrayBuffer();
  const json = parseJsonBuf(buf);
  if (!json || typeof json !== 'object') return null;
  const n = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
  return { file, buf, json, carModelType: n(pick(json, 'carModelType')), raceNumber: n(pick(json, 'raceNumber')), skin: (pick(json, 'customSkinName') || '').toString().trim() };
}

async function ingest(list) {
  if (!list.length) return toast('Папка пуста', '', 'warn');
  const byDir = new Map();
  for (const x of list) {
    const i = x.path.lastIndexOf('/');
    const dir = i < 0 ? '' : x.path.slice(0, i), name = x.path.slice(i + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ name, file: x.file });
  }
  let skinDirs = [...byDir].filter(([, fs]) => fs.some((f) => ['decals.png', 'sponsors.png'].includes(lc(f.name)))).map(([d]) => d);
  if (!skinDirs.length) skinDirs = [[...byDir.keys()].sort((a, b) => a.length - b.length)[0]]; // покажем чек-лист с ошибками

  // кандидаты конфигов из папок Cars/
  const carsPool = [];
  for (const [dir, fs] of byDir) {
    if (lc(dir.split('/').pop()) !== 'cars') continue;
    for (const f of fs.filter((f) => extOf(f.name) === 'json')) { const c = await readCar(f.file); if (c) carsPool.push(c); }
  }

  const items = [];
  for (const dir of skinDirs) {
    const fs = byDir.get(dir) ?? [];
    const name = dir.split('/').pop() || 'Skin';
    const it = { name, dir, files: {}, junk: [], ignored: [], car: null, carSource: '', model: '', race: '', include: true };
    for (const f of fs) {
      const l = lc(f.name), e = extOf(l);
      if (['decals.png', 'sponsors.png', 'decals.json', 'sponsors.json'].includes(l)) it.files[l] = f.file;
      else if (['dds', 'psd', 'bak'].includes(e)) it.junk.push(f.name);   // жёсткий фильтр мусора
      else if (e === 'json') { const c = await readCar(f.file); if (c && !it.car) { it.car = c; it.carSource = 'в папке скина'; } else it.ignored.push(f.name); }
      else it.ignored.push(f.name);
    }
    if (!it.car) {
      const c = carsPool.find((x) => lc(x.skin) === lc(name)) || carsPool.find((x) => lc(x.file.name).includes(lc(name)));
      if (c) { it.car = c; it.carSource = 'из папки Cars'; }
    }
    if (it.car?.carModelType != null) it.model = String(it.car.carModelType);
    if (it.car?.raceNumber != null) it.race = String(it.car.raceNumber);
    items.push(it);
  }
  A.items = items;
  renderItems();
  const dds = items.reduce((s, i) => s + i.junk.length, 0);
  toast(`Найдено скинов: ${items.length}`, dds ? `Отфильтровано мусорных файлов: ${dds}` : 'Проверьте чек-лист ниже', 'info', 3500);
}

function itemChecks(it) {
  const c = [];
  const hasD = !!it.files['decals.png'], hasS = !!it.files['sponsors.png'];
  if (hasD && hasS) c.push(['ok', 'Найдены <b>decals.png</b> и <b>sponsors.png</b>']);
  else if (hasD || hasS) c.push(['warn', `Найден только <b>${hasD ? 'decals.png' : 'sponsors.png'}</b> — второй слой будет пустым`]);
  else c.push(['bad', 'Нет <b>decals.png</b> / <b>sponsors.png</b> — публикация заблокирована']);

  const modelOk = it.model !== '';
  if (it.car && it.car.carModelType != null) {
    c.push(['ok', `Конфиг авто найден (${it.carSource}): <b>${esc(carName(it.car.carModelType))}</b>${it.car.raceNumber > 0 ? ` · #${it.car.raceNumber}` : ''}`]);
    if (it.car.skin && lc(it.car.skin) !== lc(it.name)) c.push(['warn', `customSkinName в конфиге «${esc(it.car.skin)}» ≠ имя папки «${esc(it.name)}» — в игре будет использовано «${esc(it.car.skin)}»`]);
    if (!it.car.skin) c.push(['info', 'В конфиге нет customSkinName — лаунчер подставит имя папки при установке']);
  } else {
    c.push([modelOk ? 'info' : 'bad', `<span class="grow">${it.car ? 'В конфиге нет carModelType' : 'Конфиг авто из Cars не найден'} — выберите кузов, <b>car_config.json</b> создастся автоматически:
      <select class="input" data-f="model"><option value="">— кузов —</option>${CARS.map((x) => `<option value="${x.id}" ${String(x.id) === it.model ? 'selected' : ''}>${x.id} · ${esc(x.name)}</option>`).join('')}</select>
      № <input class="input" data-f="race" type="number" min="0" max="999" value="${esc(it.race)}" style="width:80px" placeholder="77"></span>`]);
  }
  if (it.junk.length) c.push(['info', `Автоматически отфильтровано мусорных файлов: <b>${it.junk.length}</b> <span class="muted">(${esc(it.junk.slice(0, 4).join(', '))}${it.junk.length > 4 ? '…' : ''})</span>`]);
  if (it.ignored.length) c.push(['info', `Пропущено лишних файлов: ${it.ignored.length} <span class="muted">(${esc(it.ignored.slice(0, 3).join(', '))})</span>`]);
  if (!it.files['decals.json'] && !it.files['sponsors.json']) c.push(['warn', 'Нет decals.json / sponsors.json — в игре будут параметры материала по умолчанию']);
  return c;
}

const itemValid = (it) => (!!it.files['decals.png'] || !!it.files['sponsors.png']) && (it.car?.carModelType != null || it.model !== '');

function renderItems() {
  $('#items').innerHTML = A.items.map((it, idx) => {
    const ok = itemValid(it);
    return `<div class="item ${ok ? '' : 'bad'}" data-idx="${idx}">
      <header><label class="switch" style="border:0;padding:0;gap:10px"><input type="checkbox" data-f="include" ${it.include ? 'checked' : ''}><i></i></label>
      <h4>${esc(it.name)}</h4><span class="tiny muted">${esc(it.dir)}</span></header>
      <ul class="checks">${itemChecks(it).map(([k, h]) => `<li class="${k}"><div class="grow">${h}</div></li>`).join('')}</ul></div>`;
  }).join('');
  refreshPublish();
}

$('#items').addEventListener('change', (e) => {
  const f = e.target.dataset.f, card = e.target.closest('.item'); if (!f || !card) return;
  const it = A.items[+card.dataset.idx];
  if (f === 'include') it.include = e.target.checked;
  else it[f] = e.target.value;
  if (f === 'model') renderItems(); else refreshPublish();
});
$('#items').addEventListener('input', (e) => { if (e.target.dataset.f === 'race') A.items[+e.target.closest('.item').dataset.idx].race = e.target.value; });
$('#teamInput').addEventListener('input', refreshPublish);

function refreshPublish() {
  const sel = A.items.filter((i) => i.include && itemValid(i));
  const team = safeName($('#teamInput').value);
  let info = '';
  if (!S.token) info = 'Введите GitHub-токен (шаг 1)';
  else if (!A.items.length) info = 'Выберите папку со скином';
  else if (!sel.length) info = 'Нет скинов, готовых к публикации';
  else if (lc(team) === 'models') info = 'Имя команды «models» зарезервировано';
  else info = `Будет опубликовано скинов: ${sel.length}${team ? ` → ${team}/` : ' → корень репозитория'}`;
  $('#publishInfo').textContent = info;
  $('#btnPublish').disabled = A.publishing || !S.token || !sel.length || lc(team) === 'models';
}

function buildCarConfig(it) {
  if (it.car?.carModelType != null) return it.car.buf;                 // оригинальные байты (UTF-16/UTF-8) — как есть
  const base = it.car?.json && typeof it.car.json === 'object' ? { ...it.car.json } : {
    carGuid: -1, teamGuid: -1, raceNumber: 0, carModelType: 0, customSkinName: '', skinTemplateKey: '',
    teamName: '', nationality: 0, displayName: '', competitorName: '', competitorNationality: 0, cupCategory: 0, driverCategory: 0,
  };
  base.carModelType = +it.model;
  base.raceNumber = it.race === '' ? (base.raceNumber ?? 0) : +it.race;
  base.customSkinName = base.customSkinName || it.name;
  return new TextEncoder().encode(JSON.stringify(base, null, 2));
}

$('#btnPublish').onclick = async () => {
  const team = safeName($('#teamInput').value);
  const sel = A.items.filter((i) => i.include && itemValid(i));
  const bar = $('#pubBar'), step = $('#pubStep');
  A.publishing = true; refreshPublish();
  bar.hidden = false; $('i', bar).style.width = '0%';
  try {
    // 1. подготовка и сравнение с репозиторием по git-sha — неизменённое не заливаем
    const remote = new Map();
    for (const l of S.remote?.liveries ?? []) for (const f of [...l.files, l.carFile].filter(Boolean)) remote.set(f.path, f.sha);
    const plan = [];
    for (const it of sel) {
      const prefix = `${team ? team + '/' : ''}${safeName(it.name)}/`;
      const files = Object.entries(it.files).map(([n, f]) => [n, f]);
      for (const [n, f] of files) plan.push({ it, path: prefix + n, buf: await f.arrayBuffer() });
      plan.push({ it, path: prefix + 'car_config.json', buf: buildCarConfig(it) });
    }
    for (const p of plan) p.same = remote.get(p.path) === (await gitBlobSha(p.buf));
    const todo = plan.filter((p) => !p.same);
    if (!todo.length) { toast('Изменений нет', 'Все файлы уже совпадают с репозиторием.', 'info'); return; }

    // 2. последовательная заливка (параллельные коммиты в одну ветку GitHub отклоняет)
    let done = 0;
    for (const p of todo) {
      step.textContent = `Загрузка ${done + 1}/${todo.length}: ${p.path}`;
      await invoke('github_put_file', { token: S.token, path: p.path, contentB64: bufToB64(p.buf), message: `${remote.has(p.path) ? 'Update' : 'Add'} ${p.path}` });
      done++; $('i', bar).style.width = `${Math.round((done / todo.length) * 100)}%`;
    }
    step.textContent = `Готово: загружено файлов — ${done}, без изменений — ${plan.length - done}`;
    toast('Опубликовано', `Ливрей: ${sel.length} · файлов: ${done}`, 'ok', 6000);
    A.items = []; renderItems();
    await sync({ silent: true, auto: false });
  } catch (e) {
    step.textContent = '✖ ' + errText(e);
    toast('Ошибка публикации', errText(e), 'bad', 9000);
  } finally {
    A.publishing = false; refreshPublish();
    setTimeout(() => { bar.hidden = true; }, 2500);
  }
};

$('#repoRows').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  const l = S.remote.liveries.find((x) => x.id === b.dataset.del); if (!l) return;
  if (!S.token) return toast('Нужен токен', 'Введите GitHub-токен в шаге 1.', 'warn');
  if (!(await ask(`Удалить «${l.name}»?`, `Все файлы ливреи будут удалены из репозитория, и у пилотов она пропадёт при следующей проверке.`, 'Удалить'))) return;
  const paths = [...l.files.map((f) => f.path), ...(l.carFile ? [l.carFile.path] : []), ...(l.junkPaths ?? [])];
  const t = toast('Удаление из репозитория', l.name, 'info', 0).update(null, null, 0);
  try {
    let n = 0;
    for (const p of paths) {
      await invoke('github_delete_file', { token: S.token, path: p, message: `Remove ${p}` });
      t.update(null, p, ++n / paths.length);
    }
    t.close(); toast('Удалено', l.name, 'ok');
    await sync({ silent: true, auto: false });
  } catch (err) { t.close(); toast('Ошибка удаления', errText(err), 'bad', 8000); }
});

// ───────────────────────── Запуск ─────────────────────────
async function boot() {
  applyRole();
  // мгновенная отрисовка из кэша, пока идёт сетевая синхронизация
  const cached = ls.get('remoteCache');
  S.customs = ls.get('customs') || (await invoke('default_customs_path'));
  try { await invoke('ensure_customs', { customs: S.customs }); } catch (e) { toast('Папка Customs недоступна', errText(e), 'warn', 8000); }
  S.previews = await previewDb.all();
  try { S.installed = await invoke('installed_state', { customs: S.customs }); } catch { S.installed = {}; }
  if (cached?.liveries) S.remote = cached;
  render(true);
  renderAdmin();
  await sync();
  setInterval(() => sync({ silent: true }), SYNC_EVERY);
}
boot().catch((e) => toast('Критическая ошибка запуска', errText(e), 'bad', 0));
