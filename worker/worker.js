// DOBEG Livery Proxy — Cloudflare Worker.
// Хранит токен GitHub у себя: лаунчер пилотов читает через него (с кэшем),
// админы записывают по личному ключу. Токена в приложении нет.
//
// Переменные (Settings → Variables and Secrets):
//   OWNER, REPO          — текст, например kirillkoltun0-ops / dobeg-liveries
//   GH_TOKEN             — секрет: fine-grained PAT, Contents: Read and write
//   ADMIN_KEYS           — секрет: "Кирилл:ключ1,Иван:ключ2" (имя:ключ через запятую)

const GH = 'https://api.github.com';
const ALLOWED = /\.(png|json|webp|obj|glb|gltf)$/i;
const MAX_B64 = 70_000_000; // ≈50 МБ файла

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

function ghHeaders(env, accept = 'application/vnd.github+json') {
  return { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: accept, 'User-Agent': 'dobeg-livery-proxy', 'X-GitHub-Api-Version': '2022-11-28' };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Возвращает имя администратора по ключу из заголовка или null. */
function authAdmin(req, env) {
  const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key || !env.ADMIN_KEYS) return null;
  let found = null;
  for (const entry of env.ADMIN_KEYS.split(',')) {
    const i = entry.indexOf(':');
    const name = i < 0 ? 'admin' : entry.slice(0, i).trim();
    const k = (i < 0 ? entry : entry.slice(i + 1)).trim();
    if (k && safeEqual(k, key)) found = name; // без раннего выхода — одинаковое время ответа
  }
  return found;
}

function validPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 300 && !p.includes('..') && !p.includes('\\') &&
    !p.startsWith('/') && p.split('/').every((s) => s && !s.startsWith('.')) && ALLOWED.test(p);
}

async function ghJson(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { message: t.slice(0, 200) }; }
}

async function handleTree(req, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL('/tree', req.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const c = await fetch(`${GH}/repos/${env.OWNER}/${env.REPO}/commits/HEAD`, { headers: ghHeaders(env, 'application/vnd.github.sha') });
  if (!c.ok) return json({ error: `GitHub: ${(await ghJson(c)).message || c.status}` }, 502);
  const commit = (await c.text()).trim();
  const t = await fetch(`${GH}/repos/${env.OWNER}/${env.REPO}/git/trees/${commit}?recursive=1`, { headers: ghHeaders(env) });
  const body = await ghJson(t);
  if (!t.ok) return json({ error: `GitHub: ${body.message || t.status}` }, 502);
  const res = json({ commit, tree: body.tree || [], truncated: !!body.truncated }, 200, { 'cache-control': 'public, max-age=30' });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function currentSha(env, path) {
  const r = await fetch(`${GH}/repos/${env.OWNER}/${env.REPO}/contents/${enc(path)}`, { headers: ghHeaders(env) });
  if (r.status === 404) return null;
  const b = await ghJson(r);
  if (!r.ok) throw new Error(b.message || `GitHub ${r.status}`);
  return b.sha || null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/tree') return await handleTree(req, env, ctx);
      if (req.method === 'GET' && url.pathname === '/') return json({ service: 'dobeg-livery-proxy', ok: true });
      if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

      const admin = authAdmin(req, env);
      if (!admin) return json({ error: 'Неверный ключ администратора' }, 401);
      const b = await req.json().catch(() => ({}));
      const purge = () => caches.default.delete(new Request(new URL('/tree', req.url).toString()));

      if (url.pathname === '/check') return json({ ok: true, name: admin });

      if (url.pathname === '/put') {
        if (!validPath(b.path)) return json({ error: 'Недопустимый путь или тип файла' }, 400);
        if (typeof b.content !== 'string' || !b.content || b.content.length > MAX_B64) return json({ error: 'Файл пустой или слишком большой' }, 400);
        const sha = await currentSha(env, b.path);
        const body = { message: `[${admin}] ${String(b.message || 'Update').slice(0, 200)}`, content: b.content };
        if (sha) body.sha = sha;
        const r = await fetch(`${GH}/repos/${env.OWNER}/${env.REPO}/contents/${enc(b.path)}`, { method: 'PUT', headers: { ...ghHeaders(env), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = await ghJson(r);
        if (!r.ok) return json({ error: `GitHub: ${out.message || r.status}` }, 502);
        await purge();
        return json({ sha: out.content?.sha || '' });
      }

      if (url.pathname === '/delete') {
        if (!validPath(b.path)) return json({ error: 'Недопустимый путь' }, 400);
        const sha = await currentSha(env, b.path);
        if (!sha) return json({ ok: true });
        const r = await fetch(`${GH}/repos/${env.OWNER}/${env.REPO}/contents/${enc(b.path)}`, { method: 'DELETE', headers: { ...ghHeaders(env), 'content-type': 'application/json' }, body: JSON.stringify({ message: `[${admin}] ${String(b.message || 'Remove').slice(0, 200)}`, sha }) });
        if (!r.ok) return json({ error: `GitHub: ${(await ghJson(r)).message || r.status}` }, 502);
        await purge();
        return json({ ok: true });
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },
};
