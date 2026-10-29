// Конвейер подготовки реалистичных моделей машин для игры.
// Исходники: GLB (Ferrari 458 — из примеров three.js, Porsche — с Sketchfab через github.com/zaqifathis/Porsche).
// Что делает с каждой моделью:
//   1) запекает трансформации узлов в геометрию, разворачивает носом по +X, правым бортом по +Z;
//   2) масштабирует до реальной длины, ставит шины на y = 0, центрирует;
//   3) геометрически находит 4 колеса и выносит их в узлы wheel_xx → spin_xx (вращение) / суппорты (только поворот);
//   4) упрощает сетку по категориям (кузов детальнее, салон грубее) — бюджет ~45k треугольников;
//   5) помечает материалы категорией в extras.cat (paint/glass/head/tail/interior/trim/tire/caliper);
//   6) ужимает текстуры (webp ≤ 512), квантует и сжимает геометрию meshopt.
// Запуск (нужны пакеты @gltf-transform/core|extensions|functions@4, meshoptimizer, draco3dgltf, sharp):
//   node tools/process-cars.mjs <папка_исходников> <папка_вывода> [--analyze]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, simplifyPrimitive, weldPrimitive, quantize, meshopt, textureCompress, prune, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import fs from 'fs';
import { dedupOriented } from './mesh-orient.mjs';
import path from 'path';

const SRC = process.argv[2] || '/tmp/cars';
const OUT = process.argv[3] || './assets/cars';
const ANALYZE = process.argv.includes('--analyze');

// length — реальная длина, м; open — открытый верх (салон виден сверху → детальнее)
export const CAR_SOURCES = [
  { id: 'cayenne', src: 'cayenne.glb', length: 4.85, open: false },
  { id: 'gt3', src: 'gt3-touring.glb', length: 4.57, open: false },
  { id: 'f458', src: 'ferrari_raw.glb', length: 4.53, open: true },
  { id: 'cgt', src: 'carrera-gt.glb', length: 4.61, open: true },
];

// Категория части по имени материала и имени меша (имя меша важнее: у Ferrari один материал на разные детали)
function categorize(matName, meshName) {
  const m = (matName || '').toLowerCase(), n = (meshName || '').toLowerCase();
  const any = (re) => re.test(m) || re.test(n);
  if (/^brakes$/.test(n) || any(/cal+ip/)) return 'caliper';
  if (/grill|wiper/.test(n)) return 'trim';
  if (/^(tire|tyre|wheel|rim|nuts|centre|brake)(_|$)/.test(n)) return 'tire';
  if (/steering|interior|leather|carpet|seat/.test(n)) return 'interior';
  if (any(/red_glass|red glass|rojo|taillight|lights_red|red_light/)) return 'tail';
  if (any(/interior|leather|seat|carpet|steering|bealt|belt|internal|dash|mat_in_ex|gilla_int/)) return 'interior';
  if (any(/projector|light_glass|light_ref|lighta|c1_light|headl|turn_signal|leds/) || /^lights$/.test(m) || /^lights$/.test(n)) return 'head';
  if (any(/glass|window|vidrio|windscreen/)) return 'glass';
  if (any(/tire|tyre|wheel|disk|disc/) || /^rim/.test(n) || /_rim_/.test(n)) return 'tire';
  if (any(/paint|body_color|carpaint|coloured/)) return 'paint';
  if (any(/engine/)) return 'engine';
  return 'trim';
}

// Бюджет треугольников по категориям
function budgets(open) {
  return { paint: 15000, trim: 9000, glass: 1400, head: 1800, tail: 1600, interior: open ? 4500 : 1200,
    engine: 900, caliper: 900, wheelSpin: 2300 };
}
const ERR = { paint: 0.004, trim: 0.01, glass: 0.01, head: 0.01, tail: 0.01, interior: 0.03, engine: 0.03, caliper: 0.02, wheelSpin: 0.008 };

function normalMatrix(m) {      // inverse-transpose 3x3 of column-major 4x4
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  // inverse (row-major) then transpose → returns column-major 3x3 for n' = N * n
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
  // inv is row-major of inverse; transpose of inverse in column-major equals inv read as row-major → use directly as rows
  return inv; // построчно: n'x = inv[0]*nx + inv[1]*ny + inv[2]*nz
}

async function main() {
  await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
  });
  fs.mkdirSync(OUT, { recursive: true });
  const meta = {};
  const only = process.argv.find(a => a.startsWith('--only='));
  for (const car of CAR_SOURCES) {
    if (only && !only.slice(7).split(',').includes(car.id)) continue;
    meta[car.id] = await processCar(io, car);
  }
  if (!ANALYZE) {
    const metaPath = path.join(OUT, 'cars-meta.json');
    const prev = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
    fs.writeFileSync(metaPath, JSON.stringify(Object.assign(prev, meta), null, 1));
  }
}

async function processCar(io, car) {
  const doc = await io.read(path.join(SRC, car.src));
  await doc.transform(dequantize());
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];

  // ---- 1. собрать все треугольники в мировых координатах
  const parts = [];   // { mat, meshName, pos: Float32Array, nrm, uv, uv1, idx: Uint32Array }
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const W = node.getWorldMatrix();
    const N = normalMatrix(W);
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;               // только TRIANGLES
      const P = prim.getAttribute('POSITION'); if (!P) continue;
      const cnt = P.getCount();
      const pos = new Float32Array(cnt * 3), nrm = new Float32Array(cnt * 3);
      const Na = prim.getAttribute('NORMAL'), T0 = prim.getAttribute('TEXCOORD_0'), T1 = prim.getAttribute('TEXCOORD_1');
      const uv = T0 ? new Float32Array(cnt * 2) : null, uv1 = T1 ? new Float32Array(cnt * 2) : null;
      const v = [0, 0, 0], t = [0, 0];
      for (let i = 0; i < cnt; i++) {
        P.getElement(i, v);
        pos[i * 3] = W[0] * v[0] + W[4] * v[1] + W[8] * v[2] + W[12];
        pos[i * 3 + 1] = W[1] * v[0] + W[5] * v[1] + W[9] * v[2] + W[13];
        pos[i * 3 + 2] = W[2] * v[0] + W[6] * v[1] + W[10] * v[2] + W[14];
        if (Na) {
          Na.getElement(i, v);
          // N — обратная-транспонированная матрица (построчно): n' = N·n
          let x = N[0] * v[0] + N[1] * v[1] + N[2] * v[2], y = N[3] * v[0] + N[4] * v[1] + N[5] * v[2], z = N[6] * v[0] + N[7] * v[1] + N[8] * v[2];
          const l = Math.hypot(x, y, z) || 1; nrm[i * 3] = x / l; nrm[i * 3 + 1] = y / l; nrm[i * 3 + 2] = z / l;
        }
        if (uv) { T0.getElement(i, t); uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1]; }
        if (uv1) { T1.getElement(i, t); uv1[i * 2] = t[0]; uv1[i * 2 + 1] = t[1]; }
      }
      const I = prim.getIndices();
      const idx = I ? Uint32Array.from(I.getArray()) : Uint32Array.from({ length: cnt }, (_, i) => i);
      parts.push({ mat: prim.getMaterial(), meshName: mesh.getName() || node.getName(), pos, nrm, hasN: !!Na, uv, uv1, idx });
    }
  });

  // ---- 1b. двусторонние дубли (лицо + изнанка с перевёрнутыми нормалями, типично для FBX2glTF):
  // оставляем одну согласованно ориентированную копию, материал помечаем doubleSided
  let dupRemoved = 0;
  for (const p of parts) {
    const n = p.pos.length / 3, wid = new Uint32Array(n), map = new Map();
    for (let i = 0; i < n; i++) {
      const k = p.pos[i * 3].toFixed(5) + ',' + p.pos[i * 3 + 1].toFixed(5) + ',' + p.pos[i * 3 + 2].toFixed(5);
      let id = map.get(k); if (id === undefined) { id = i; map.set(k, i); } wid[i] = id;
    }
    const r = dedupOriented(p.idx, wid);
    if (r) { p.idx = r.idx; dupRemoved += r.removed; if (p.mat) p.mat.setDoubleSided(true); }
  }
  if (dupRemoved) console.log(`  удалено двусторонних дублей: ${dupRemoved}`);

  // ---- 2. ориентация: длинная ось → X, нос (противоположно красным фонарям) → +X
  let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
  for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.pos[i + k]); max[k] = Math.max(max[k], p.pos[i + k]); }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longAxis = ext[0] > ext[2] ? 0 : 2;
  // центр фонарей вдоль длинной оси
  let tailSum = 0, tailN = 0;
  for (const p of parts) if (categorize(p.mat && p.mat.getName(), p.meshName) === 'tail')
    for (let i = 0; i < p.pos.length; i += 3) { tailSum += p.pos[i + longAxis]; tailN++; }
  const mid = (min[longAxis] + max[longAxis]) / 2;
  const tailPos = tailN ? tailSum / tailN - mid : -1;     // по умолчанию считаем, что фонари в минусе
  const scale = car.length / ext[longAxis];
  // строим функцию преобразования (x,y,z) → игровые (нос +X, верх +Y, право +Z)
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const fwdSign = tailPos > 0 ? -1 : 1;                   // нос — противоположно фонарям
  const tf = (x, y, z) => {
    x -= cx; z -= cz; y -= min[1];
    let X, Z;
    if (longAxis === 0) { X = x * fwdSign; Z = z * fwdSign; }          // поворот на 0 или 180°
    else { X = z * fwdSign; Z = -x * fwdSign; }                          // поворот на ±90° вокруг Y
    return [X * scale, y * scale, Z * scale];
  };
  const tfn = (x, y, z) => longAxis === 0 ? [x * fwdSign, y, z * fwdSign] : [z * fwdSign, y, -x * fwdSign];
  for (const p of parts) {
    for (let i = 0; i < p.pos.length; i += 3) {
      const r = tf(p.pos[i], p.pos[i + 1], p.pos[i + 2]); p.pos[i] = r[0]; p.pos[i + 1] = r[1]; p.pos[i + 2] = r[2];
      const n = tfn(p.nrm[i], p.nrm[i + 1], p.nrm[i + 2]); p.nrm[i] = n[0]; p.nrm[i + 1] = n[1]; p.nrm[i + 2] = n[2];
    }
  }

  // ---- 3. колёса: треугольники категории tire по квадрантам
  const quad = [{ n: 'fl', sx: 1, sz: -1 }, { n: 'fr', sx: 1, sz: 1 }, { n: 'rl', sx: -1, sz: -1 }, { n: 'rr', sx: -1, sz: 1 }];
  for (const q of quad) { q.min = [1e9, 1e9, 1e9]; q.max = [-1e9, -1e9, -1e9]; q.tris = 0; }
  for (const p of parts) {
    if (categorize(p.mat && p.mat.getName(), p.meshName) !== 'tire') continue;
    if (p.mat && /tire|tyre/i.test(p.mat.getName()) === false && /^(tire|wheel|rim)/i.test(p.meshName) === false && /wheel|rim|tire/i.test(p.mat.getName()) === false) continue;
    for (let i = 0; i < p.idx.length; i += 3) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) { const j = p.idx[i + k] * 3; x += p.pos[j]; y += p.pos[j + 1]; z += p.pos[j + 2]; }
      x /= 3; y /= 3; z /= 3;
      const q = quad[(x > 0 ? 0 : 2) + (z > 0 ? 1 : 0)];
      q.tris++;
      for (let k = 0; k < 3; k++) { const j = p.idx[i + k] * 3; for (let a = 0; a < 3; a++) { q.min[a] = Math.min(q.min[a], p.pos[j + a]); q.max[a] = Math.max(q.max[a], p.pos[j + a]); } }
    }
  }
  const wheels = quad.map(q => ({
    name: q.n, x: (q.min[0] + q.max[0]) / 2, y: (q.min[1] + q.max[1]) / 2, z: (q.min[2] + q.max[2]) / 2,
    r: Math.max(q.max[1] - q.min[1], q.max[0] - q.min[0]) / 2, w: (q.max[2] - q.min[2]) / 2, tris: q.tris,
  }));
  // посадка: низ шин → y = 0
  const groundY = Math.min(...quad.map(q => q.min[1]));
  if (Math.abs(groundY) > 1e-4) {
    for (const p of parts) for (let i = 1; i < p.pos.length; i += 3) p.pos[i] -= groundY;
    for (const w of wheels) w.y -= groundY;
  }

  // ---- 4. разнести треугольники по группам: body / wheel_i spin / wheel_i steer
  const groups = new Map();   // key → { part, tris: [] }
  const catStat = {};
  const wheelHit = (x, y, z) => {
    for (let wi = 0; wi < 4; wi++) {
      const w = wheels[wi];
      if (Math.abs(z - w.z) > w.w + 0.025) continue;
      if (Math.hypot(x - w.x, y - w.y) < w.r * 1.005) return wi;
    }
    return -1;
  };
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    const cat = categorize(p.mat && p.mat.getName(), p.meshName);
    for (let i = 0; i < p.idx.length; i += 3) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) { const j = p.idx[i + k] * 3; x += p.pos[j]; y += p.pos[j + 1]; z += p.pos[j + 2]; }
      x /= 3; y /= 3; z /= 3;
      const wi = (cat === 'paint' || cat === 'glass' || cat === 'interior') ? -1 : wheelHit(x, y, z);
      let gk, gcat;
      if (wi >= 0) { gcat = cat === 'caliper' ? 'caliper' : 'wheelSpin'; gk = `w${wi}:${gcat}:${pi}`; }
      else { gcat = cat === 'tire' ? 'trim' : cat; gk = `body:${gcat}:${pi}`; }
      let g = groups.get(gk);
      if (!g) { g = { part: p, cat: gcat, wheel: wi, tris: [] }; groups.set(gk, g); }
      g.tris.push(i);
      const sk = (wi >= 0 ? 'wheel/' : 'body/') + gcat;
      catStat[sk] = (catStat[sk] || 0) + 1;
    }
  }

  const matInfo = {};
  for (const p of parts) {
    const nm = p.mat ? p.mat.getName() : '(none)';
    const key = nm;
    if (!matInfo[key]) matInfo[key] = { cat: categorize(nm, p.meshName), tris: 0, meshes: new Set() };
    matInfo[key].tris += p.idx.length / 3; matInfo[key].meshes.add(p.meshName);
  }
  console.log(`\n=== ${car.id}: ${car.src}  длина ${ext[longAxis].toFixed(4)} → ${car.length} м (×${scale.toFixed(2)}), ось ${longAxis ? 'Z' : 'X'}, фонари ${tailPos > 0 ? '+' : '−'} → нос ${fwdSign > 0 ? '+' : '−'}`);
  console.log('  колёса:', wheels.map(w => `${w.name}(x${w.x.toFixed(2)} y${w.y.toFixed(2)} z${w.z.toFixed(2)} r${w.r.toFixed(3)} w${w.w.toFixed(3)} n${w.tris})`).join(' '));
  console.log('  треугольники по группам:', JSON.stringify(catStat));
  if (ANALYZE) {
    for (const [k, v] of Object.entries(matInfo).sort((a, b) => b[1].tris - a[1].tris))
      console.log(`   ${v.cat.padEnd(9)} ${String(v.tris).padStart(7)}  ${k}  [${[...v.meshes].slice(0, 4).join(', ')}]`);
    return null;
  }

  // ---- 5. построить новые примитивы и упростить
  const B = budgets(car.open);
  const catTotals = {};
  for (const g of groups.values()) {
    const key = g.wheel >= 0 ? (g.cat === 'caliper' ? 'caliper' : `wheelSpin${g.wheel}`) : g.cat;
    catTotals[key] = (catTotals[key] || 0) + g.tris.length;
  }
  // один материал → одна категория; при конфликте (стоп-сигнал и суппорт у Ferrari) — клон
  const matCat = new Map(), matClone = new Map();
  const matFor = (mat, cat) => {
    if (!mat) return mat;
    if (cat === 'wheelSpin') cat = 'tire';
    if (!matCat.has(mat)) { matCat.set(mat, cat); return mat; }
    if (matCat.get(mat) === cat) return mat;
    const k = mat.getName() + '|' + cat;
    if (!matClone.has(k)) { const c = mat.clone().setName(mat.getName() + '_' + cat); matCat.set(c, cat); matClone.set(k, c); }
    return matClone.get(k);
  };
  const bodyMesh = doc.createMesh('body');
  const wheelMeshes = wheels.map(w => ({ spin: doc.createMesh('spin_' + w.name), steer: doc.createMesh('steer_' + w.name) }));
  const buffer = root.listBuffers()[0] || doc.createBuffer();
  let trisOut = 0;
  for (const g of groups.values()) {
    const p = g.part;
    const isWheel = g.wheel >= 0;
    const w = isWheel ? wheels[g.wheel] : null;
    // компактные вершины
    const remap = new Map(); const vlist = [];
    const outIdx = new Uint32Array(g.tris.length * 3);
    let o = 0;
    for (const ti of g.tris) for (let k = 0; k < 3; k++) {
      const vi = p.idx[ti + k];
      let ni = remap.get(vi);
      if (ni === undefined) { ni = vlist.length; remap.set(vi, ni); vlist.push(vi); }
      outIdx[o++] = ni;
    }
    const n = vlist.length;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
    const uv = p.uv ? new Float32Array(n * 2) : null, uv1 = p.uv1 ? new Float32Array(n * 2) : null;
    for (let i = 0; i < n; i++) {
      const s = vlist[i];
      pos[i * 3] = p.pos[s * 3] - (w ? w.x : 0); pos[i * 3 + 1] = p.pos[s * 3 + 1] - (w ? w.y : 0); pos[i * 3 + 2] = p.pos[s * 3 + 2] - (w ? w.z : 0);
      nrm[i * 3] = p.nrm[s * 3]; nrm[i * 3 + 1] = p.nrm[s * 3 + 1]; nrm[i * 3 + 2] = p.nrm[s * 3 + 2];
      if (uv) { uv[i * 2] = p.uv[s * 2]; uv[i * 2 + 1] = p.uv[s * 2 + 1]; }
      if (uv1) { uv1[i * 2] = p.uv1[s * 2]; uv1[i * 2 + 1] = p.uv1[s * 2 + 1]; }
    }
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(n > 65535 ? outIdx : Uint16Array.from(outIdx)).setBuffer(buffer))
      .setMaterial(matFor(p.mat, g.cat === 'wheelSpin' ? categorize(p.mat && p.mat.getName(), p.meshName) : g.cat));
    if (p.hasN) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(buffer));
    if (uv) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
    if (uv1) prim.setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(uv1).setBuffer(buffer));
    // упрощение
    const key = isWheel ? (g.cat === 'caliper' ? 'caliper' : `wheelSpin${g.wheel}`) : g.cat;
    const budget = isWheel ? (g.cat === 'caliper' ? B.caliper : B.wheelSpin) : (B[g.cat] || 2000);
    const ratio = Math.min(1, budget / Math.max(1, catTotals[key]));
    const err = isWheel ? (g.cat === 'caliper' ? ERR.caliper : ERR.wheelSpin) : (ERR[g.cat] || 0.01);
    if (ratio < 0.98 && g.tris.length > 24) {
      try { weldPrimitive(prim, { tolerance: 0.0001 }); simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error: err, lockBorder: false }); }
      catch (e) { console.log('  simplify fail', g.cat, e.message); }
    }
    const tcount = prim.getIndices().getCount() / 3;
    if (tcount === 0) { prim.dispose(); continue; }
    trisOut += tcount;
    if (!isWheel) bodyMesh.addPrimitive(prim);
    else if (g.cat === 'caliper') wheelMeshes[g.wheel].steer.addPrimitive(prim);
    else wheelMeshes[g.wheel].spin.addPrimitive(prim);
  }

  // ---- 6. новое дерево узлов
  for (const ch of scene.listChildren()) scene.removeChild(ch);
  const carNode = doc.createNode('car');
  carNode.addChild(doc.createNode('body').setMesh(bodyMesh));
  wheels.forEach((w, i) => {
    const wn = doc.createNode('wheel_' + w.name).setTranslation([w.x, w.y, w.z]);
    const sp = doc.createNode('spin_' + w.name).setMesh(wheelMeshes[i].spin);
    wn.addChild(sp);
    if (wheelMeshes[i].steer.listPrimitives().length) wn.addChild(doc.createNode('caliper_' + w.name).setMesh(wheelMeshes[i].steer));
    else wheelMeshes[i].steer.dispose();
    carNode.addChild(wn);
  });
  scene.addChild(carNode);

  // категории материалов → extras (three.js: material.userData.cat)
  const cats = {};
  for (const [m, cat] of matCat) {
    if (!m.listParents().some(p => p.propertyType === 'Primitive')) continue;
    m.setExtras(Object.assign({}, m.getExtras(), { cat }));
    (cats[cat] = cats[cat] || []).push(m.getName());
  }

  // ---- 7. объединить примитивы одного материала, ужать текстуры, сжать
  await doc.transform(prune(), dedup());
  mergeSameMaterial(doc);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 82 }),
    prune(),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const outFile = path.join(OUT, car.id + '.glb');
  await io.write(outFile, doc);
  const size = fs.statSync(outFile).size;
  let prims = 0; for (const m of root.listMeshes()) prims += m.listPrimitives().length;
  console.log(`  → ${outFile}: ${(size / 1024).toFixed(0)} КБ, треугольников ${trisOut}, примитивов (draw calls) ${prims}, текстур ${root.listTextures().length}`);
  const bb = [1e9, -1e9, 1e9, -1e9, 0];
  for (const p of parts) for (let i = 0; i < p.pos.length; i += 3) { bb[0] = Math.min(bb[0], p.pos[i + 2]); bb[1] = Math.max(bb[1], p.pos[i + 2]); bb[4] = Math.max(bb[4], p.pos[i + 1]); }
  return {
    file: car.id + '.glb', length: car.length, width: +(bb[1] - bb[0]).toFixed(3), height: +bb[4].toFixed(3),
    wheels: wheels.map(w => ({ name: w.name, x: +w.x.toFixed(4), y: +w.y.toFixed(4), z: +w.z.toFixed(4), r: +w.r.toFixed(4) })),
    tris: trisOut, prims, kb: Math.round(size / 1024), cats,
  };
}

// Слить примитивы с одинаковым материалом внутри каждого меша (меньше draw calls)
function mergeSameMaterial(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    const byMat = new Map();
    for (const prim of mesh.listPrimitives()) {
      const k = prim.getMaterial();
      if (!byMat.has(k)) byMat.set(k, []);
      byMat.get(k).push(prim);
    }
    for (const [mat, prims] of byMat) {
      if (prims.length < 2) continue;
      const sig = (p) => p.listSemantics().slice().sort().join(',');
      const groupsBySig = new Map();
      for (const p of prims) { const s = sig(p); if (!groupsBySig.has(s)) groupsBySig.set(s, []); groupsBySig.get(s).push(p); }
      for (const arr of groupsBySig.values()) {
        if (arr.length < 2) continue;
        const sems = arr[0].listSemantics();
        let vtot = 0, itot = 0;
        for (const p of arr) { vtot += p.getAttribute('POSITION').getCount(); itot += p.getIndices().getCount(); }
        const out = doc.createPrimitive().setMaterial(mat);
        const buffer = doc.getRoot().listBuffers()[0];
        for (const s of sems) {
          const a0 = arr[0].getAttribute(s); const es = a0.getElementSize();
          const data = new Float32Array(vtot * es); let off = 0;
          for (const p of arr) { const a = p.getAttribute(s); const el = new Array(es);
            for (let i = 0; i < a.getCount(); i++) { a.getElement(i, el); for (let k = 0; k < es; k++) data[off++] = el[k]; } }
          out.setAttribute(s, doc.createAccessor().setType(a0.getType()).setArray(data).setBuffer(buffer));
        }
        const idx = vtot > 65535 ? new Uint32Array(itot) : new Uint16Array(itot);
        let io2 = 0, base = 0;
        for (const p of arr) { const ia = p.getIndices().getArray(); for (let i = 0; i < ia.length; i++) idx[io2++] = ia[i] + base; base += p.getAttribute('POSITION').getCount(); }
        out.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx).setBuffer(buffer));
        for (const p of arr) { mesh.removePrimitive(p); p.dispose(); }
        mesh.addPrimitive(out);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
