// ============================================================================
//  TEXTURES — все текстуры генерируются кодом на <canvas> при старте.
//  Почему так: ноль сетевых запросов, игра работает офлайн, вес билда минимальный.
//  Плюс мы получаем нормал-карты (рельеф асфальта) — это и есть «реалистичность»
//  на слабом GPU: дёшево, но поверхность читается объёмной.
// ============================================================================
import * as THREE from '../vendor/three.js';

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(canvas, { repeat = 1, srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// Простой детерминированный шум на canvas
function noiseInto(ctx, size, amount, seed) {
  let s = seed || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** Асфальт: мелкое серое зерно низкого контраста, мягкие пятна износа, редкие трещины.
 *  Бесшовный: пятна рисуются с переносом через края, трещины — вдали от краёв. */
export function makeAsphalt(size = 256) {
  const c = canvas2d(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  const rnd = seeded(20251028);
  g.fillStyle = '#3b3c40';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 22; i++) {
    const x = rnd() * size, y = rnd() * size, r = 12 + rnd() * 46;
    const light = rnd() < 0.5;
    const a = (0.05 + rnd() * 0.07).toFixed(3);
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grd.addColorStop(0, light ? `rgba(96,96,100,${a})` : `rgba(16,16,18,${a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  g.strokeStyle = 'rgba(18,18,21,0.30)';
  for (let i = 0; i < 5; i++) {
    g.lineWidth = 0.6 + rnd() * 0.9;
    g.beginPath();
    let x = 30 + rnd() * (size - 60), y = 30 + rnd() * (size - 60);
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x = Math.max(8, Math.min(size - 8, x + (rnd() - 0.5) * 34));
      y = Math.max(8, Math.min(size - 8, y + (rnd() - 0.5) * 34));
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // зерно щебня: слабый серый шум + редкие светлые камешки
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let n = (rnd() - 0.5) * 16;
    if (rnd() < 0.025) n += 14 + rnd() * 10;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.95));
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Нормал-карта из высот (превращает зернистость асфальта в рельеф) */
export function makeNormalFromCanvas(src, strength = 2.2) {
  const size = src.width;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const s = sctx.getImageData(0, 0, size, size).data;
  const out = canvas2d(size);
  const octx = out.getContext('2d', { willReadFrequently: true });
  const img = octx.createImageData(size, size);
  const d = img.data;
  const h = (x, y) => {
    x = (x + size) % size; y = (y + size) % size;
    const i = (y * size + x) * 4;
    return (s[i] + s[i + 1] + s[i + 2]) / (3 * 255);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      let nx = dx, ny = dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/**
 * Тайл фасада: 4 окна × 4 этажа. Свет в окнах НЕ запекается — его считает
 * шейдер (renderer.js), поэтому у каждого дома свой рисунок горящих окон.
 * Геометрия окна в ячейке совпадает с шейдером: x 0.16–0.84, y 0.18–0.80 (снизу).
 */
export function makeFacadeTile(size = 256) {
  const c = canvas2d(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  const cell = size / 4;
  // стена — светлая, оттенок даёт цвет инстанса
  g.fillStyle = '#c9c6c0';
  g.fillRect(0, 0, size, size);
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      const x0 = col * cell, y0 = r * cell;
      // межэтажная плита (низ ячейки = низ этажа; canvas y растёт вниз)
      g.fillStyle = 'rgba(70,70,74,0.35)';
      g.fillRect(x0, y0 + cell * 0.94, cell, cell * 0.06);
      // окно
      const wx = x0 + cell * 0.16, wy = y0 + cell * 0.20;
      const ww = cell * 0.68, wh = cell * 0.62;
      const grd = g.createLinearGradient(0, wy, 0, wy + wh);
      grd.addColorStop(0, '#5d6f86');
      grd.addColorStop(0.45, '#2a3646');
      grd.addColorStop(1, '#161c25');
      g.fillStyle = grd;
      g.fillRect(wx, wy, ww, wh);
      // блик неба на стекле
      g.fillStyle = 'rgba(190,210,235,0.10)';
      g.beginPath();
      g.moveTo(wx, wy); g.lineTo(wx + ww * 0.55, wy); g.lineTo(wx, wy + wh * 0.7);
      g.closePath(); g.fill();
      // рама и импост
      g.strokeStyle = 'rgba(30,30,34,0.85)';
      g.lineWidth = Math.max(1, cell * 0.035);
      g.strokeRect(wx, wy, ww, wh);
      g.beginPath();
      g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh);
      g.stroke();
      // подоконник
      g.fillStyle = 'rgba(235,232,225,0.55)';
      g.fillRect(wx - cell * 0.03, wy + wh, ww + cell * 0.06, cell * 0.035);
    }
  }
  noiseInto(g, size, 18, 1234);
  return c;
}

/** Мягкое световое пятно (фонарь на асфальте, фары) — тёплое, для аддитивного смешивания */
export function makeLightPool(size = 128, r = 255, gC = 196, b = 128) {
  const c = canvas2d(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0.0, `rgba(${r},${gC},${b},0.85)`);
  grd.addColorStop(0.35, `rgba(${r},${gC},${b},0.38)`);
  grd.addColorStop(0.7, `rgba(${r},${gC},${b},0.10)`);
  grd.addColorStop(1.0, `rgba(${r},${gC},${b},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Конус света фар на дороге: ярко у бампера, гаснет вдаль и к краям */
export function makeHeadlightCone(w = 128, h = 256) {
  // Два пятна от левой и правой фары: максимум в ~4–6 м от бампера, у самой машины пусто
  // (иначе в кадре сзади яркое пятно висит над крышей и читается как дым).
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(w, h);
  const d = img.data;
  const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);                                    // 0 = у бампера
    const along = sstep(0.04, 0.26, t) * Math.pow(1 - t, 1.25);
    const width = 0.13 + t * 0.42;                            // пятна расширяются
    const cpos = 0.30 + t * 0.10;                             // и чуть расходятся
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1;
      const l1 = Math.exp(-Math.pow((u - cpos) / width, 2));
      const l2 = Math.exp(-Math.pow((u + cpos) / width, 2));
      const a = along * Math.min(1, Math.max(l1, l2) + 0.35 * Math.min(l1, l2));
      const i = ((h - 1 - y) * w + x) * 4;
      d[i] = 255; d[i + 1] = 240; d[i + 2] = 214;
      d[i + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Тротуарная плитка */
export function makeSidewalk(size = 128) {
  const c = canvas2d(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#6e6f74';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(0,0,0,0.30)';
  g.lineWidth = 2;
  const n = 4, st = size / n;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * st, 0); g.lineTo(i * st, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * st); g.lineTo(size, i * st); g.stroke();
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${90 + Math.random() * 40 | 0},${92 + Math.random() * 40 | 0},${98 + Math.random() * 40 | 0},0.25)`;
    g.fillRect(Math.random() * size, Math.random() * size, 6 + Math.random() * 20, 6 + Math.random() * 20);
  }
  noiseInto(g, size, 30, 11);
  return c;
}

/** Круглое мягкое пятно (тень под машиной, блик, частица дыма) */
export function makeRadial(size = 128, inner = 'rgba(0,0,0,0.55)', outer = 'rgba(0,0,0,0)') {
  const c = canvas2d(size);
  const g = c.getContext('2d', { willReadFrequently: true });
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.6, inner.replace(/[\d.]+\)$/, '0.22)'));
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

export const TEX = {};

/** Создать все текстуры один раз и закэшировать */
export function buildTextures(aniso) {
  if (TEX.asphalt) return TEX;

  const asphaltCanvas = makeAsphalt(256);
  TEX.asphalt = toTexture(asphaltCanvas, { repeat: 1, srgb: true, aniso });
  TEX.asphaltNormal = toTexture(makeNormalFromCanvas(asphaltCanvas, 2.4), { repeat: 1, srgb: false, aniso: 1 });

  const sw = makeSidewalk(128);
  TEX.sidewalk = toTexture(sw, { repeat: 1, srgb: true, aniso });
  TEX.sidewalkNormal = toTexture(makeNormalFromCanvas(sw, 1.6), { repeat: 1, srgb: false, aniso: 1 });

  TEX.facadeTile = toTexture(makeFacadeTile(256), { repeat: 1, srgb: true, aniso });

  TEX.lightPool = toTexture(makeLightPool(128), { srgb: true, aniso: 1 });
  TEX.lightPool.wrapS = TEX.lightPool.wrapT = THREE.ClampToEdgeWrapping;
  TEX.headCone = toTexture(makeHeadlightCone(128, 256), { srgb: true, aniso: 2 });
  TEX.headCone.wrapS = TEX.headCone.wrapT = THREE.ClampToEdgeWrapping;

  TEX.shadowBlob = toTexture(makeRadial(128), { srgb: true, aniso: 1 });
  TEX.shadowBlob.wrapS = TEX.shadowBlob.wrapT = THREE.ClampToEdgeWrapping;

  TEX.spark = toTexture(makeRadial(64, 'rgba(255,235,190,0.95)', 'rgba(255,180,90,0)'), { srgb: true, aniso: 1 });
  TEX.spark.wrapS = TEX.spark.wrapT = THREE.ClampToEdgeWrapping;

  TEX.smoke = toTexture(makeRadial(64, 'rgba(190,195,205,0.55)', 'rgba(150,155,165,0)'), { srgb: true, aniso: 1 });
  TEX.smoke.wrapS = TEX.smoke.wrapT = THREE.ClampToEdgeWrapping;

  return TEX;
}
