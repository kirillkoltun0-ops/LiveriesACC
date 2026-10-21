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

const SKIN_EXT = /\.(png|json|webp)$/i;
const MODEL_EXT = /\.(obj|glb|gltf)$/i;
const MAX_PART = 24 * 1024 * 1024;   // лимит значения KV 25 МБ — большие модели режутся на части
const TYPES = { png: 'image/png', json: 'application/json', webp: 'image/webp', obj: 'text/plain; charset=utf-8', glb: 'model/gltf-binary', gltf: 'model/gltf+json' };

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
function authAdmin(b, env, req) {
  let cred = String(b.auth || '').trim();
  if (!cred && req?.headers.get('x-auth')) { try { cred = decodeURIComponent(req.headers.get('x-auth')).trim(); } catch { cred = ''; } }
  const i = cred.indexOf(':');
  if (i < 1 || !env.ADMINS) return null;
  const login = cred.slice(0, i).toLowerCase(), pass = cred.slice(i + 1);
  let found = null;
  for (const entry of env.ADMINS.split(',')) {
    const j = entry.indexOf(':');
    if (j < 1) continue;
    const l = entry.slice(0, j).trim().toLowerCase(), p = entry.slice(j + 1).trim();
    const okLogin = safeEqual(l, login), okPass = safeEqual(p, pass);   // считаем оба — одинаковое время ответа
    if (p && okLogin && okPass) found = entry.slice(0, j).trim();
  }
  return found;
}

function validPath(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || p.includes('..') || p.includes('\\') || p.startsWith('/')) return false;
  const segs = p.split('/');
  if (!segs.every((x) => x && !x.startsWith('.'))) return false;
  if (segs[0].toLowerCase() === 'models') return segs.length === 2 && MODEL_EXT.test(p);   // модели — только models/<имя>
  return SKIN_EXT.test(p);
}

/** Git-совместимый blob SHA-1 — лаунчер сравнивает им файлы, чтобы не заливать лишнее. */
async function gitSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head); all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

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
  const ext = path.split('.').pop().toLowerCase();
  const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', ...CORS };
  const meta = path.toLowerCase().startsWith('models/') ? (await getIndex(env)).files[path] : null;
  if (meta?.parts > 1) {                                           // большая модель: склеиваем части потоком
    let i = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (i >= meta.parts) return c.close();
        const part = await env.LIVERIES.get(`f:${path}#${i++}`, 'arrayBuffer');
        if (!part) return c.error(new Error('part missing'));
        c.enqueue(new Uint8Array(part));
      },
    });
    return new Response(stream, { headers: { ...headers, 'content-length': String(meta.size) } });
  }
  const data = await env.LIVERIES.get('f:' + path, 'arrayBuffer');
  if (!data) return new Response('Not found', { status: 404, headers: CORS });
  return new Response(data, { headers });
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
      const purge = () => caches.default.delete(new Request(`${url.origin}/tree`));

      // Загрузка файла: тело — сырые байты (без base64: бесплатный тариф даёт всего ~10 мс процессора).
      // Метаданные — в заголовках: x-auth, x-path, x-sha, x-size, x-part, x-parts (все percent-encoded).
      if (url.pathname === '/put') {
        const admin = authAdmin({}, env, req);
        if (!admin) return json({ error: 'Неверный логин или пароль' }, 401);
        const h = (n) => { try { return decodeURIComponent(req.headers.get(n) || ''); } catch { return ''; } };
        const path = h('x-path'), sha = h('x-sha'), part = +(h('x-part') || 0), parts = +(h('x-parts') || 1), size = +(h('x-size') || 0);
        if (!validPath(path)) return json({ error: 'Недопустимый путь или тип файла' }, 400);
        if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: 'Не передана контрольная сумма файла' }, 400);
        const body = await req.arrayBuffer();
        if (!body.byteLength || body.byteLength > MAX_PART) return json({ error: 'Часть файла пустая или больше 24 МБ' }, 400);
        if (parts > 1 && !path.toLowerCase().startsWith('models/')) return json({ error: 'Большие файлы допустимы только для моделей' }, 400);
        if (parts <= 1) {
          await env.LIVERIES.put('f:' + path, body);
        } else {
          await env.LIVERIES.put(`f:${path}#${part}`, body);
          if (part < parts - 1) return json({ ok: true, part });   // индекс обновляем только после последней части
        }
        const idx = await getIndex(env);
        idx.files[path] = { sha, size: parts > 1 ? size : body.byteLength, parts: parts > 1 ? parts : 1, by: admin, at: Date.now() };
        idx.deleted = (idx.deleted || []).filter((x) => x !== path);
        await saveIndex(env, idx);
        await purge();
        return json({ sha });
      }

      const b = await req.json().catch(() => ({}));
      const admin = authAdmin(b, env, req);
      if (!admin) return json({ error: 'Неверный логин или пароль' }, 401);
      if (url.pathname === '/check') return json({ ok: true, name: admin });

      if (url.pathname === '/delete') {
        if (!validPath(b.path)) return json({ error: 'Недопустимый путь' }, 400);
        const idx = await getIndex(env);
        const old = idx.files[b.path];
        delete idx.files[b.path];
        if (!(idx.deleted || []).includes(b.path)) (idx.deleted ||= []).push(b.path);   // скрывает и файл из старого GitHub-репозитория
        await saveIndex(env, idx);
        await env.LIVERIES.delete('f:' + b.path);
        for (let i = 0; i < (old?.parts || 0); i++) await env.LIVERIES.delete(`f:${b.path}#${i}`);
        await purge();
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
