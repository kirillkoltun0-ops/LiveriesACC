// DOBEG Livery Server — Cloudflare Worker + KV (бесплатно, без банковской карты).
//
//  • Ливреи хранятся в Cloudflare KV. Старые ливреи из GitHub-репозитория остаются видны (только чтение),
//    3D-модели в models/ тоже берутся из публичного репозитория — переносить ничего не нужно.
//  • Пилоты ничего не вводят. Админы входят логином и паролем, которые выдаёт владелец лиги.
//
// Настройка в панели Cloudflare:
//   Bindings → KV namespace:  переменная LIVERIES
//   Variables and Secrets:    ADMINS (секрет) = "kirill:пароль1,ivan:пароль2"
//                             OWNER, REPO (текст) — репозиторий с моделями/старыми ливреями (необязательно)

const ALLOWED = /\.(png|json|webp)$/i;
const MAX_B64 = 34_000_000;          // ≈25 МБ файла — лимит значения KV
const TYPES = { png: 'image/png', json: 'application/json', webp: 'image/webp' };

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Поле auth тела запроса «логин:пароль» (не заголовок — в нём нельзя кириллицу) → имя админа или null. */
function authAdmin(b, env) {
  const cred = String(b.auth || '').trim();
  const i = cred.indexOf(':');
  if (i < 1 || !env.ADMINS) return null;
  const login = cred.slice(0, i).toLowerCase(), pass = cred.slice(i + 1);
  let found = null;
  for (const entry of env.ADMINS.split(',')) {
    const j = entry.indexOf(':');
    if (j < 1) continue;
    const l = entry.slice(0, j).trim().toLowerCase(), p = entry.slice(j + 1).trim();
    if (p && safeEqual(l, login) & safeEqual(p, pass)) found = entry.slice(0, j).trim(); // без раннего выхода
  }
  return found;
}

function validPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 300 && !p.includes('..') && !p.includes('\\') &&
    !p.startsWith('/') && p.split('/').every((s) => s && !s.startsWith('.')) && ALLOWED.test(p) &&
    p.split('/')[0].toLowerCase() !== 'models';
}

/** Git-совместимый blob SHA-1 — лаунчер сравнивает им файлы, чтобы не заливать лишнее. */
async function gitSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ── индекс ливрей в KV: один ключ, чтобы /tree стоил одно чтение ──
async function getIndex(env) {
  return (await env.LIVERIES.get('index', 'json')) || { files: {}, deleted: [] };
}
const saveIndex = (env, idx) => env.LIVERIES.put('index', JSON.stringify(idx));

/** Дерево публичного GitHub-репозитория (старые ливреи + models/). Кэш 10 минут, ошибки не ломают сервер.
 *  Если задан необязательный секрет GH_TOKEN (любой токен БЕЗ прав, только чтение публичных данных),
 *  лимит GitHub 5000 запросов/час вместо 60 на общий адрес Cloudflare. */
async function githubTree(env, origin, info = {}) {
  if (!env.OWNER || !env.REPO) { info.error = 'OWNER/REPO не заданы'; return []; }
  const key = new Request(`${origin}/__gh`);
  const hit = await caches.default.match(key);
  if (hit) { info.cached = true; return hit.json(); }
  let tree = [];
  try {
    const headers = { 'User-Agent': 'dobeg-livery-server', Accept: 'application/vnd.github+json' };
    if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
    const r = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/git/trees/HEAD?recursive=1`, { headers });
    info.status = r.status;
    if (r.ok) tree = ((await r.json()).tree || []).filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
    else info.error = ((await r.json().catch(() => ({}))).message || '').slice(0, 200);
  } catch (e) { info.error = String(e.message || e); }
  if (tree.length) await caches.default.put(key, new Response(JSON.stringify(tree), { headers: { 'cache-control': 'max-age=600', 'content-type': 'application/json' } }));
  return tree;
}

async function handleTree(req, env, ctx) {
  const origin = new URL(req.url).origin;
  const cacheKey = new Request(`${origin}/tree`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const [idx, gh] = await Promise.all([getIndex(env), githubTree(env, origin)]);
  const hidden = new Set(idx.deleted || []);
  const map = new Map();
  for (const e of gh) {
    if (hidden.has(e.path)) continue;
    map.set(e.path, { path: e.path, type: 'blob', sha: e.sha, size: e.size, url: `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/HEAD/${enc(e.path)}?v=${e.sha}` });
  }
  for (const [path, m] of Object.entries(idx.files)) {
    map.set(path, { path, type: 'blob', sha: m.sha, size: m.size, url: `${origin}/f/${enc(path)}?v=${m.sha}` });
  }
  const tree = [...map.values()];
  const commit = await gitSha(new TextEncoder().encode(tree.map((t) => t.path + t.sha).sort().join('|')));
  const res = json({ commit, tree, truncated: false }, 200, { 'cache-control': 'public, max-age=20' });
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}

async function handleFile(url, env) {
  const path = decodeURIComponent(url.pathname.slice(3));
  if (!validPath(path)) return new Response('Not found', { status: 404, headers: CORS });
  const data = await env.LIVERIES.get('f:' + path, 'arrayBuffer');
  if (!data) return new Response('Not found', { status: 404, headers: CORS });
  const ext = path.split('.').pop().toLowerCase();
  return new Response(data, { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', ...CORS } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (req.method === 'GET') {
        if (url.pathname === '/tree') return await handleTree(req, env, ctx);
        if (url.pathname.startsWith('/f/')) return await handleFile(url, env);
        if (url.pathname === '/debug') { const info = {}; const t = await githubTree(env, url.origin, info); const idx = await getIndex(env); return json({ github: { ...info, files: t.length, tokenSet: !!env.GH_TOKEN, owner: env.OWNER, repo: env.REPO }, kvFiles: Object.keys(idx.files).length }); }
        if (url.pathname === '/') return json({ service: 'dobeg-livery-server', ok: true, kv: !!env.LIVERIES });
        return json({ error: 'Not found' }, 404);
      }
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
      if (!env.LIVERIES) return json({ error: 'К Worker не привязано хранилище KV (переменная LIVERIES)' }, 500);

      const b = await req.json().catch(() => ({}));
      const admin = authAdmin(b, env);
      if (!admin) return json({ error: 'Неверный логин или пароль' }, 401);
      const purge = () => caches.default.delete(new Request(`${url.origin}/tree`));

      if (url.pathname === '/check') return json({ ok: true, name: admin });

      if (url.pathname === '/put') {
        if (!validPath(b.path)) return json({ error: 'Недопустимый путь или тип файла' }, 400);
        if (typeof b.content !== 'string' || !b.content || b.content.length > MAX_B64) return json({ error: 'Файл пустой или больше 25 МБ' }, 400);
        const bytes = b64ToBytes(b.content);
        const sha = await gitSha(bytes);
        await env.LIVERIES.put('f:' + b.path, bytes);            // сначала файл…
        const idx = await getIndex(env);
        idx.files[b.path] = { sha, size: bytes.length, by: admin, at: Date.now() };
        idx.deleted = (idx.deleted || []).filter((p) => p !== b.path);
        await saveIndex(env, idx);                               // …потом индекс: пилот не увидит файл, которого ещё нет
        await purge();
        return json({ sha });
      }

      if (url.pathname === '/delete') {
        if (!validPath(b.path)) return json({ error: 'Недопустимый путь' }, 400);
        const idx = await getIndex(env);
        delete idx.files[b.path];
        if (!(idx.deleted || []).includes(b.path)) (idx.deleted ||= []).push(b.path);   // скрывает и файл из старого GitHub-репозитория
        await saveIndex(env, idx);
        await env.LIVERIES.delete('f:' + b.path);
        await purge();
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
