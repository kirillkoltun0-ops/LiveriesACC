// Общие утилиты фронтенда
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Декодирует ACC-json: UTF-16 LE/BE (с BOM и без) или UTF-8. */
export function decodeText(buf) {
  const b = new Uint8Array(buf);
  let enc = 'utf-8', off = 0;
  if (b[0] === 0xff && b[1] === 0xfe) { enc = 'utf-16le'; off = 2; }
  else if (b[0] === 0xfe && b[1] === 0xff) { enc = 'utf-16be'; off = 2; }
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { off = 3; }
  else if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[3] === 0) enc = 'utf-16le';
  else if (b.length >= 4 && b[0] === 0 && b[1] !== 0 && b[2] === 0) enc = 'utf-16be';
  return new TextDecoder(enc).decode(b.subarray(off)).replace(/^﻿/, '').replace(/\0/g, '');
}

/** Читает JSON любой кодировки; null, если файл битый. */
export function parseJsonBuf(buf) {
  try { return JSON.parse(decodeText(buf)); } catch { return null; }
}

/** Достаёт поле JSON без учёта регистра ключа. */
export function pick(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

export function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function strToB64(str) {
  return bufToB64(new TextEncoder().encode(str));
}

/** Git blob SHA-1 — чтобы не перезаливать файлы, которые уже совпадают с репозиторием. */
export async function gitBlobSha(buf) {
  const data = new Uint8Array(buf);
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head); all.set(data, head.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\.+$/, '');

export function fmtBytes(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / 1048576).toFixed(1)} МБ`;
}

export const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Крошечное IndexedDB-хранилище для превью (data URL). */
export const previewDb = (() => {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('dobeg-previews', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('p', mode);
      const out = fn(t.objectStore('p'));
      t.oncomplete = () => res(out?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    async all() {
      try {
        const db = await open();
        return await new Promise((res) => {
          const m = new Map();
          const c = db.transaction('p').objectStore('p').openCursor();
          c.onsuccess = () => { const cur = c.result; if (cur) { m.set(cur.key, cur.value); cur.continue(); } else res(m); };
          c.onerror = () => res(m);
        });
      } catch { return new Map(); }
    },
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
    del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {}),
  };
})();
