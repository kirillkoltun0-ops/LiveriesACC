// 3D-шоурум: .obj/.glb кузов + автосклейка decals.png + sponsors.png в CanvasTexture 2048².
import * as THREE from '../vendor/three/three.module.min.js';
import { OBJLoader } from '../vendor/three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';
import { decodeText, pick } from './util.js';

const invoke = (...a) => window.__TAURI__.core.invoke(...a);
const TEX = 2048;
const NOT_BODY = /wheel|tire|tyre|glass|window|windscreen|rim|brake|disc|light|lamp|mirror|seat|interior|cockpit|steer|driver|exhaust|grill|rubber|calliper|caliper/i;
const GLASS = /glass|window|windscreen/i;
const CACHE_NAME = 'dobeg-models-v1';
const cacheKey = (sha) => `https://cache.dobeg.local/${sha}`;

/** Удаляет из кэша модели, которых уже нет в репозитории. */
export async function pruneModelCache(shas) {
  try {
    const keep = new Set(shas.map(cacheKey));
    const c = await caches.open(CACHE_NAME);
    for (const req of await c.keys()) if (!keep.has(req.url)) await c.delete(req);
  } catch { /* Cache API недоступен — не страшно */ }
}

/** Загрузка картинки с crossOrigin=anonymous (канвас не «грязнится»), с запасным путём через Rust. */
export function loadImage(url) {
  const attempt = (src, cors) =>
    new Promise((res, rej) => {
      const im = new Image();
      if (cors) im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('img'));
      im.src = src;
    });
  return attempt(url, true).catch(async () => {
    const b64 = await invoke('fetch_b64', { url });
    return attempt(`data:image/png;base64,${b64}`, false);
  });
}

async function loadBuffer(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return await r.arrayBuffer();
  } catch {
    const b64 = await invoke('fetch_b64', { url });
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
}

async function loadModelBuffer(url, sha, onProgress) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey(sha));
    if (hit) { onProgress?.(1); return await hit.arrayBuffer(); }
  } catch { cache = null; }

  let buf;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const total = +r.headers.get('content-length') || 0;
    const reader = r.body.getReader();
    const parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (total) onProgress?.(got / total);
    }
    const all = new Uint8Array(got); let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    buf = all.buffer;
  } catch {
    buf = await loadBuffer(url);
  }
  try { await cache?.put(cacheKey(sha), new Response(buf.slice(0))); } catch { /* квота */ }
  onProgress?.(1);
  return buf;
}

const clamp01 = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export class Showroom {
  constructor(canvas, { interactive = true } = {}) {
    this.canvas = canvas;
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 200);
    this.camera.position.set(5.6, 2.2, 6.4);

    const pm = new THREE.PMREMGenerator(this.r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    const key = new THREE.DirectionalLight(0xfff1e0, 2.1);
    key.position.set(4, 7, 5);
    const rim = new THREE.DirectionalLight(0xff5500, 1.4);
    rim.position.set(-6, 3, -5);
    this.scene.add(key, rim, new THREE.HemisphereLight(0x9db4ff, 0x14161d, 0.5));

    // «тень» под машиной
    const g = document.createElement('canvas'); g.width = g.height = 256;
    const gx = g.getContext('2d');
    const gr = gx.createRadialGradient(128, 128, 10, 128, 128, 128);
    gr.addColorStop(0, 'rgba(0,0,0,.65)'); gr.addColorStop(0.55, 'rgba(0,0,0,.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    gx.fillStyle = gr; gx.fillRect(0, 0, 256, 256);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(g), transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = 0.01;
    this.scene.add(this.shadow);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3; this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0.7, 0);
    this.controls.autoRotate = true; this.controls.autoRotateSpeed = 1.1;
    this.controls.enabled = interactive;

    // склейка слоёв: база + decals + sponsors
    this.texCanvas = document.createElement('canvas');
    this.texCanvas.width = this.texCanvas.height = TEX;
    this.tex = new THREE.CanvasTexture(this.texCanvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = Math.min(8, this.r.capabilities.getMaxAnisotropy());
    this.tex.flipY = true;
    this.layers = { decals: null, sponsors: null };
    this.baseColor = '#1c1f29';
    this.mat = new THREE.MeshPhysicalMaterial({ map: this.tex, roughness: 0.35, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 });
    this.modelCache = new Map();
    this.token = 0;
    this.running = false;
    this.compose();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
  }

  resize() {
    const p = this.canvas.parentElement || this.canvas;
    const w = Math.max(2, p.clientWidth), h = Math.max(2, p.clientHeight);
    this.r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      this.controls.update();
      this.r.render(this.scene, this.camera);
    };
    loop();
  }
  stop() { this.running = false; cancelAnimationFrame(this._raf); }

  setAutoRotate(v) { this.controls.autoRotate = v; }
  setBaseColor(hex) { this.baseColor = hex; this.compose(); }
  setFlipY(v) { this.tex.flipY = v; this.tex.needsUpdate = true; }

  /** Тёмная база + decals + sponsors → единая текстура. */
  compose() {
    const c = this.texCanvas.getContext('2d');
    c.clearRect(0, 0, TEX, TEX);
    c.fillStyle = this.baseColor; c.fillRect(0, 0, TEX, TEX);
    c.imageSmoothingQuality = 'high';
    for (const im of [this.layers.decals, this.layers.sponsors]) if (im) c.drawImage(im, 0, 0, TEX, TEX);
    this.tex.needsUpdate = true;
  }

  /** livery: { decals, sponsors, decalsJson, sponsorsJson } — URL или null. Возвращает список проблем. */
  async setLivery(livery) {
    const t = ++this.token;
    const problems = [];
    const img = (u, label) => (u ? loadImage(u).catch(() => { problems.push(`${label}.png не загрузился`); return null; }) : null);
    const js = (u) => (u ? loadBuffer(u).then((b) => JSON.parse(decodeText(b))).catch(() => null) : null);
    const [d, s, dj, sj] = await Promise.all([img(livery.decals, 'decals'), img(livery.sponsors, 'sponsors'), js(livery.decalsJson), js(livery.sponsorsJson)]);
    if (t !== this.token) return problems;
    this.layers = { decals: d, sponsors: s };
    this.compose();

    // параметры материала из decals.json / sponsors.json (если есть)
    const num = (k) => [dj, sj].map((j) => pick(j, k)).find((v) => typeof v === 'number');
    this.mat.roughness = clamp01(num('baseRoughness'), 0.35);
    this.mat.metalness = clamp01(num('metallic') ?? num('baseMetallic'), 0.25);
    this.mat.clearcoat = clamp01(num('clearCoat'), 1);
    this.mat.clearcoatRoughness = clamp01(num('clearCoatRoughness'), 0.05);
    this.mat.needsUpdate = true;
    return problems;
  }

  async _parseModel(url, name, sha, onProgress) {
    const buf = await loadModelBuffer(url, sha, onProgress);
    if (/\.(glb|gltf)$/i.test(name)) {
      return new Promise((res, rej) => new GLTFLoader().parse(buf, '', (g) => res(g.scene), rej));
    }
    return new OBJLoader().parse(decodeText(buf));
  }

  /** model: { url, name, sha } */
  async setModel(model, onProgress) {
    let p = this.modelCache.get(model.sha);
    if (!p) {
      p = this._parseModel(model.url, model.name, model.sha, onProgress);
      this.modelCache.set(model.sha, p);
      if (this.modelCache.size > 3) this.modelCache.delete(this.modelCache.keys().next().value); // не раздуваем память
      p.catch(() => this.modelCache.delete(model.sha));
    } else onProgress?.(1);
    const root = (await p).clone(true);

    this.pivot.clear();
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const isBody = (m) => !NOT_BODY.test(`${m.name} ${m.material?.name ?? ''} ${m.parent?.name ?? ''}`);
    const anyBody = meshes.some(isBody);
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0c12, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.55 });
    let bodyCount = 0;
    for (const m of meshes) {
      if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
      const label = `${m.name} ${m.material?.name ?? ''}`;
      if (!anyBody || isBody(m)) { m.material = this.mat; bodyCount++; }
      else m.material = GLASS.test(label) ? glass : dark;
    }

    // нормализация: центр, длина ≈ 4.6, колёса на «земле»
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
    const k = 4.6 / Math.max(size.x, size.z, 0.0001);
    root.scale.multiplyScalar(k);
    root.position.set(-ctr.x * k, -box.min.y * k, -ctr.z * k);
    this.pivot.add(root);
    return { meshes: meshes.length, bodyCount };
  }

  /** Снимок для карточки: фиксированный ракурс ¾, прозрачный фон, webp. */
  capture(w = 800, h = 450) {
    const saved = { pos: this.camera.position.clone(), tgt: this.controls.target.clone(), ar: this.controls.autoRotate };
    this.controls.autoRotate = false;
    this.camera.position.set(5.4, 1.9, 6.2);
    this.controls.target.set(0, 0.65, 0);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const pr = this.r.getPixelRatio();
    this.r.setPixelRatio(1); this.r.setSize(w, h, false);
    this.camera.lookAt(this.controls.target);
    this.r.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/webp', 0.85); // рендер и снимок в одной задаче — буфер ещё не очищен
    this.r.setPixelRatio(pr);
    this.camera.position.copy(saved.pos); this.controls.target.copy(saved.tgt); this.controls.autoRotate = saved.ar;
    this.resize();
    return url;
  }

  dispose() { this.stop(); this._ro.disconnect(); this.r.dispose(); }
}
