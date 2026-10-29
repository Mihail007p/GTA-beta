// ============================================================================
//  CAR MODEL — машины игрока.
//  Основной вариант: реалистичные модели GLB (assets/cars/*.glb), подготовленные
//  конвейером tools/process-cars.mjs: ~30–55k треугольников, колёса — отдельные
//  узлы wheel_xx (руление) → spin_xx (качение), материалы помечены категорией
//  (userData.cat: paint / glass / head / tail / interior / trim / tire / caliper).
//  Все материалы переводятся в MeshStandardMaterial (дешёвый шейдер для Mali),
//  преломляющее стекло (transmission = лишний проход рендера) — в обычное
//  полупрозрачное; краска — MeshPhysical с лаком, цвет берётся из def.paint.
//
//  Запасной вариант: процедурная модель из примитивов — показывается, пока GLB
//  грузится, и если файл недоступен.
//
//  Ось машины: нос смотрит в локальный +X, ось колёс — локальный Z.
// ============================================================================
import * as THREE from '../vendor/three.js';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { MeshoptDecoder } from '../vendor/meshopt_decoder.module.js';

// Силуэты (м). x — от центра кузова к носу (+), y — высота. ws/rf/rr/rw — x-координаты
// основания лобового, начала и конца крыши, основания заднего стекла.
const STYLES = {
  coupe:  { noseY: 0.60, cowlY: 0.84, roofY: 1.22, deckY: 0.87, tailY: 0.83, ws: 0.62, rf: -0.18, rr: -0.92, rw: -1.48, taper: 0.84, axle: 0.04, quarter: true,  wing: false, scoop: false, lightBar: true },
  hatch:  { noseY: 0.64, cowlY: 0.88, roofY: 1.36, deckY: 1.00, tailY: 0.98, ws: 0.72, rf: -0.02, rr: -1.50, rw: -1.92, taper: 0.88, axle: 0.00, quarter: true,  wing: false, scoop: false, lightBar: false },
  muscle: { noseY: 0.70, cowlY: 0.86, roofY: 1.20, deckY: 0.89, tailY: 0.87, ws: 0.40, rf: -0.40, rr: -1.10, rw: -1.80, taper: 0.82, axle: 0.06, quarter: true,  wing: true,  scoop: true,  lightBar: true },
  super:  { noseY: 0.46, cowlY: 0.74, roofY: 1.06, deckY: 0.86, tailY: 0.80, ws: 0.95, rf: 0.02, rr: -0.62, rw: -1.72, taper: 0.78, axle: -0.05, quarter: false, wing: true,  scoop: false, lightBar: true },
};
const BEVEL = 0.06;          // скругление кромок кузова (м)
const WHEEL_R = 0.36;

/** Сглаженные нормали с порогом угла: гладкие изгибы, но острые рёбра остаются острыми */
function smoothNormals(geo, creaseDeg = 50) {
  const pos = geo.attributes.position.array;
  const n = pos.length / 3;
  const fn = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const ax = pos[i * 3], ay = pos[i * 3 + 1], az = pos[i * 3 + 2];
    const ux = pos[i * 3 + 3] - ax, uy = pos[i * 3 + 4] - ay, uz = pos[i * 3 + 5] - az;
    const vx = pos[i * 3 + 6] - ax, vy = pos[i * 3 + 7] - ay, vz = pos[i * 3 + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) { fn[(i + k) * 3] = nx; fn[(i + k) * 3 + 1] = ny; fn[(i + k) * 3 + 2] = nz; }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = Math.round(pos[i * 3] * 1e4) + ',' + Math.round(pos[i * 3 + 1] * 1e4) + ',' + Math.round(pos[i * 3 + 2] * 1e4);
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(i);
  }
  const cosT = Math.cos(creaseDeg * Math.PI / 180);
  const out = new Float32Array(n * 3);
  for (const g of groups.values()) {
    for (const i of g) {
      let sx = 0, sy = 0, sz = 0;
      for (const j of g) {
        const d = fn[i * 3] * fn[j * 3] + fn[i * 3 + 1] * fn[j * 3 + 1] + fn[i * 3 + 2] * fn[j * 3 + 2];
        if (d >= cosT) { sx += fn[j * 3]; sy += fn[j * 3 + 1]; sz += fn[j * 3 + 2]; }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

/** Внутренний отступ выпуклого многоугольника (CCW) на d */
function insetConvex(pts, d) {
  const n = pts.length, lines = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    lines.push({ px: a.x - dy / L * d, py: a.y + dx / L * d, dx, dy });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i + n - 1) % n], l2 = lines[i];
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    const t = Math.abs(den) < 1e-9 ? 0 : ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    out.push({ x: l1.px + l1.dx * t, y: l1.py + l1.dy * t });
  }
  return out;
}

/** Отсечение многоугольника вертикалью x = X (оставляем x >= X либо x <= X) */
function clipX(poly, X, keepGreater) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ina = keepGreater ? a.x >= X : a.x <= X;
    const inb = keepGreater ? b.x >= X : b.x <= X;
    if (ina) out.push(a);
    if (ina !== inb) { const t = (X - a.x) / (b.x - a.x); out.push({ x: X, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}

const shapeOf = (pts) => new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));

/** Панель (стекло) на наклонной грани профиля: от (x0,y0) к (x1,y1), наружу на offset */
function panelOnLine(x0, y0, x1, y1, width, offset, shrink = 0.94) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  // для CCW-контура внешняя нормаль — правая: (dy, -dx)
  const nx = dy / len, ny = -dx / len;
  const geo = new THREE.PlaneGeometry(len * shrink, width);
  geo.rotateX(-Math.PI / 2);                    // лежит в XZ, нормаль +Y
  const a = Math.atan2(-nx, ny);                // повернуть +Y в (nx, ny)
  return { geo, matrix: mat((x0 + x1) / 2 + nx * offset, (y0 + y1) / 2 + ny * offset, 0, 0, 0, a) };
}

function extrudeCentered(shape, totalWidth, bevel, curveSegments = 8) {
  const depth = Math.max(0.05, totalWidth - 2 * bevel);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments,
  });
  geo.translate(0, 0, -depth / 2);
  smoothNormals(geo, 50);
  return geo;
}

/** Слить набор (геометрия, матрица, [цвет]) в одну индексированную геометрию */
function mergeParts(parts, withColor = false) {
  let vCount = 0, iCount = 0;
  const prepared = parts.map(p => {
    const g = p.geo.index ? p.geo.clone() : p.geo.clone();
    g.applyMatrix4(p.matrix);
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
    return { g, color: p.color };
  });
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const col = withColor ? new Float32Array(vCount * 3) : null;
  const idx = new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const { g, color } of prepared) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    if (col) {
      const c = new THREE.Color(color);
      for (let k = 0; k < n; k++) { col[(vo + k) * 3] = c.r; col[(vo + k) * 3 + 1] = c.g; col[(vo + k) * 3 + 2] = c.b; }
    }
    if (g.index) {
      const gi = g.index.array;
      for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
      io += gi.length;
    } else {
      for (let k = 0; k < n; k++) idx[io + k] = vo + k;
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
function mat(x, y, z, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return _m.compose(_p.set(x, y, z), _q, _s).clone();
}

function buildProceduralCar(def, opts = {}) {
  const S = STYLES[def.bodyStyle] || STYLES.coupe;
  const env = opts.envMap || null;
  const group = new THREE.Group();

  // Лакированная краска: clearcoat даёт «мокрый» блик настоящего авто.
  const paint = new THREE.MeshPhysicalMaterial({
    color: def.paint, metalness: 0.45, roughness: 0.32,
    clearcoat: 1.0, clearcoatRoughness: 0.04,
    envMap: env, envMapIntensity: 1.35,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: def.trim, metalness: 0.35, roughness: 0.55, envMap: env, envMapIntensity: 0.6 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: def.glass, metalness: 0.9, roughness: 0.04,
    envMap: env, envMapIntensity: 1.8, side: THREE.DoubleSide,
  });
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 2.6, roughness: 0.15, metalness: 0.0,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x400606, emissive: 0xff2214, emissiveIntensity: 1.4, roughness: 0.35,
  });

  const L = def.length || 4.6;
  const W = def.width || 1.86;
  const wb = def.wheelbase || 2.6;
  const h = L / 2 - BEVEL;                 // полудлина контура (кромка добавит BEVEL)
  const yb = 0.25;                         // низ контура → клиренс ~0.19 м
  const xf = wb / 2 + S.axle, xr = -wb / 2 + S.axle;
  const Wc = W * S.taper;                  // ширина кабины (завал боковин)

  // ---------------------------------------------------- НИЖНИЙ КУЗОВ -------
  const ar = 0.50;                         // радиус арки в контуре (после кромки ≈0.44)
  const da = Math.asin(Math.min(0.99, (WHEEL_R - yb) / ar));
  const adx = Math.cos(da) * ar;
  const deckMidX = (S.rw + (-h + 0.04)) / 2;
  const body = new THREE.Shape();
  body.moveTo(-h + 0.10, yb);
  body.lineTo(xr - adx, yb);
  body.absarc(xr, WHEEL_R, ar, Math.PI + da, -da, true);
  body.lineTo(xf - adx, yb);
  body.absarc(xf, WHEEL_R, ar, Math.PI + da, -da, true);
  body.lineTo(h - 0.14, yb);
  body.quadraticCurveTo(h, yb, h, yb + 0.16);                                   // низ бампера
  body.quadraticCurveTo(h + 0.01, S.noseY - 0.06, h - 0.08, S.noseY);           // передняя панель
  body.quadraticCurveTo(h - 0.55, S.noseY + 0.09, S.ws, S.cowlY);               // капот
  body.lineTo(S.rw, S.deckY);                                                   // линия окон
  body.quadraticCurveTo(deckMidX, Math.max(S.deckY, S.tailY) + 0.03, -h + 0.04, S.tailY);   // крышка багажника
  body.quadraticCurveTo(-h - 0.01, S.tailY - 0.12, -h, S.tailY - 0.30);         // задняя панель
  body.lineTo(-h, yb + 0.14);
  body.quadraticCurveTo(-h, yb, -h + 0.10, yb);

  // ----------------------------------------------------------- КАБИНА ------
  const cabin = new THREE.Shape();
  cabin.moveTo(S.rw, S.deckY - 0.07);
  cabin.lineTo(S.ws, S.cowlY - 0.07);
  cabin.lineTo(S.ws, S.cowlY);
  cabin.lineTo(S.rf, S.roofY);
  cabin.quadraticCurveTo((S.rf + S.rr) / 2, S.roofY + 0.035, S.rr, S.roofY);
  cabin.lineTo(S.rw, S.deckY);
  cabin.lineTo(S.rw, S.deckY - 0.07);

  const paintParts = [
    { geo: extrudeCentered(body, W, BEVEL, 10), matrix: mat(0, 0, 0) },
    { geo: extrudeCentered(cabin, Wc, 0.05, 8), matrix: mat(0, 0, 0) },
  ];
  // зеркала
  for (const s of [-1, 1]) {
    paintParts.push({ geo: new THREE.BoxGeometry(0.16, 0.09, 0.16), matrix: mat(S.ws - 0.16, S.cowlY + 0.07, s * (Wc / 2 + 0.10)) });
  }

  // ------------------------------------------------------------ СТЁКЛА -----
  const glassParts = [];
  const dloQuad = [{ x: S.rw, y: S.deckY }, { x: S.ws, y: S.cowlY }, { x: S.rf, y: S.roofY }, { x: S.rr, y: S.roofY }];
  const dlo = insetConvex(dloQuad, 0.065);
  const bX = S.rr - 0.02;                                  // B-стойка
  const sideWins = [clipX(dlo, bX + 0.045, true)];
  if (S.quarter) sideWins.push(clipX(dlo, bX - 0.045, false));
  for (const poly of sideWins) {
    if (poly.length < 3) continue;
    const g = new THREE.ShapeGeometry(shapeOf(poly));
    for (const s of [-1, 1]) glassParts.push({ geo: g, matrix: mat(0, 0, s * (Wc / 2 + 0.004)) });
  }
  const flatW = (Wc - 2 * 0.05) * 0.97;
  glassParts.push(panelOnLine(S.ws, S.cowlY, S.rf, S.roofY, flatW, 0.05 + 0.006));    // лобовое
  glassParts.push(panelOnLine(S.rr, S.roofY, S.rw, S.deckY, flatW, 0.05 + 0.006));    // заднее

  // -------------------------------------------------- ПЛАСТИК / ДЕТАЛИ -----
  const trimParts = [
    // решётка радиатора и задний диффузор
    { geo: new THREE.BoxGeometry(0.06, 0.13, W * 0.46), matrix: mat(h + 0.045, yb + 0.17, 0) },
    { geo: new THREE.BoxGeometry(0.08, 0.10, W * 0.78), matrix: mat(-h - 0.035, yb + 0.05, 0) },
  ];
  for (const s of [-1, 1]) {
    // пороги между арками
    trimParts.push({ geo: new THREE.BoxGeometry(Math.max(0.3, (xf - xr) - 2 * adx - 0.05), 0.08, 0.05), matrix: mat((xf + xr) / 2, yb - 0.02, s * (W / 2 - 0.005)) });
  }
  if (S.wing) {
    const wy = S.deckY + (def.bodyStyle === 'super' ? 0.26 : 0.17);
    trimParts.push({ geo: new THREE.BoxGeometry(0.30, 0.035, W * 0.90), matrix: mat(-h + 0.22, wy, 0, 0, 0, 0.06) });
    for (const s of [-1, 1]) trimParts.push({ geo: new THREE.BoxGeometry(0.07, wy - S.deckY + 0.02, 0.05), matrix: mat(-h + 0.24, (wy + S.deckY) / 2, s * W * 0.32) });
  }
  if (S.scoop) {
    const hx = (h + S.ws) / 2;
    trimParts.push({ geo: new THREE.BoxGeometry(0.55, 0.07, 0.46), matrix: mat(hx, (S.noseY + S.cowlY) / 2 + 0.07, 0) });
  }

  // ------------------------------------------------------------- СВЕТ -----
  const headParts = [], tailParts = [];
  for (const s of [-1, 1]) {
    headParts.push({ geo: new THREE.BoxGeometry(0.08, 0.10, 0.40), matrix: mat(h + 0.035, S.noseY - 0.08, s * (W / 2 - 0.36)) });
    tailParts.push({ geo: new THREE.BoxGeometry(0.08, 0.10, 0.40), matrix: mat(-h - 0.045, S.tailY - 0.12, s * (W / 2 - 0.34)) });
  }
  if (S.lightBar) tailParts.push({ geo: new THREE.BoxGeometry(0.06, 0.035, W - 1.2), matrix: mat(-h - 0.04, S.tailY - 0.12, 0) });

  const add = (parts, material, castShadow) => {
    const m = new THREE.Mesh(mergeParts(parts), material);
    m.castShadow = castShadow;
    m.receiveShadow = false;
    group.add(m);
    return m;
  };
  const bodyMesh = add(paintParts, paint, true);
  add(trimParts, trimMat, false);
  add(glassParts, glassMat, false);
  add(headParts, lightMat, false);
  const tails = add(tailParts, tailMat, false);
  const S_bodyL = L;

  // ---------------------------------------------------------------- КОЛЁСА --
  // Одна геометрия на колесо (вершинные цвета): шина, тёмный барабан, 5 светлых спиц, обод.
  const wParts = [
    { geo: new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.24, 18, 1), matrix: mat(0, 0, 0, Math.PI / 2), color: 0x151517 },
    { geo: new THREE.CylinderGeometry(0.245, 0.245, 0.245, 18, 1), matrix: mat(0, 0, 0, Math.PI / 2), color: 0x23262a },
    { geo: new THREE.CylinderGeometry(0.055, 0.055, 0.27, 8, 1), matrix: mat(0, 0, 0, Math.PI / 2), color: 0xd8dde2 },
  ];
  for (let k = 0; k < 5; k++) {
    const a = k * Math.PI * 2 / 5;
    wParts.push({ geo: new THREE.BoxGeometry(0.20, 0.055, 0.26), matrix: mat(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0, 0, 0, a), color: 0xc9ced4 });
  }
  for (const s of [-1, 1]) {
    wParts.push({ geo: new THREE.RingGeometry(0.212, 0.25, 18, 1), matrix: mat(0, 0, s * 0.124, 0, s > 0 ? 0 : Math.PI, 0), color: 0xe0e4e8 });
  }
  const wheelGeo = mergeParts(wParts, true);
  const wheelMat = new THREE.MeshStandardMaterial({
    vertexColors: true, metalness: 0.55, roughness: 0.4, envMap: env, envMapIntensity: 0.8,
  });

  const wheels = [];
  const track = W / 2 - 0.13;
  const positions = [
    { x: xf, z: track, front: true },
    { x: xf, z: -track, front: true },
    { x: xr, z: track, front: false },
    { x: xr, z: -track, front: false },
  ];
  for (const p of positions) {
    // pivot  — поворот вокруг Y (руление); roller — качение вокруг Z (ось колеса)
    const pivot = new THREE.Group();
    pivot.position.set(p.x, WHEEL_R, p.z);
    const roller = new THREE.Mesh(wheelGeo, wheelMat);
    roller.castShadow = true;
    pivot.add(roller);
    group.add(pivot);
    wheels.push({ pivot, roller, front: p.front, spin: 0 });
  }

  // ---------------------------------------------------- КОНТАКТНАЯ ТЕНЬ ----
  let blob = null;
  if (opts.shadowTex) {
    blob = new THREE.Mesh(
      new THREE.PlaneGeometry(S_bodyL + 0.7, W + 0.8),
      new THREE.MeshBasicMaterial({ map: opts.shadowTex, transparent: true, depthWrite: false, opacity: 0.6, color: 0x000000 })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.025;
    blob.renderOrder = 1;
    group.add(blob);
  }

  // ------------------------------------------------- СВЕТ ФАР НА ДОРОГЕ ----
  let cone = null;
  if (opts.coneTex) {
    const coneGeo = new THREE.PlaneGeometry(7.5, 17);
    coneGeo.rotateX(-Math.PI / 2);     // лежит на земле, длинная сторона вдоль локального Z
    coneGeo.rotateY(-Math.PI / 2);     // длинная сторона → вдоль +X (нос машины)
    cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      map: opts.coneTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.34, fog: true,
    }));
    cone.position.set(S_bodyL / 2 + 8.4, 0.04, 0);
    cone.renderOrder = 4;
    group.add(cone);
  }

  group.userData = {
    wheels, body: bodyMesh, blob, cone, tails, tailMat,
    length: S_bodyL, width: W, wheelRadius: WHEEL_R,
    materials: [paint, trimMat, glassMat, lightMat, tailMat, wheelMat],
  };
  return group;
}

// ============================================================== GLB-МОДЕЛИ ==
let _loader = null;
const getLoader = () => _loader || (_loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));
const templates = new Map();     // def.id → { promise, tpl, error }
// подготовленные данные шаблона — НЕ в userData: Object3D.clone() копирует userData через JSON
const prepared = new WeakMap();

/** Общий загрузчик GLB (с декодером meshopt) — для трафика */
export function loadGLTF(url) { return getLoader().loadAsync(url); }

/** Загрузить (один раз) модель машины. Промис никогда не отклоняется: null = ошибка. */
export function preloadCarModel(def) {
  if (!def || !def.model) return Promise.resolve(null);
  let e = templates.get(def.id);
  if (!e) {
    e = { tpl: null, error: null, promise: null };
    e.promise = getLoader().loadAsync(def.model)
      .then((gltf) => { e.tpl = gltf.scene; return e.tpl; })
      .catch((err) => { e.error = err; console.warn('[car-model] не загрузилась модель', def.id, err); return null; });
    templates.set(def.id, e);
  }
  return e.promise;
}

/** Готова ли модель (загружена или окончательно не загрузилась) */
export function carModelSettled(def) {
  if (!def || !def.model) return true;
  const e = templates.get(def.id);
  return !!(e && (e.tpl || e.error));
}

export function buildCarMesh(def, opts = {}) {
  const e = def && def.model ? templates.get(def.id) : null;
  if (e && e.tpl) return instantiateModel(def, e.tpl, opts);
  const g = buildProceduralCar(def, opts);
  g.userData.placeholder = !!(def && def.model) && !(e && e.error);
  return g;
}

const ROLL_CENTER = 0.42;                 // высота оси крена кузова, м
const CAT_ENV = { paint: 1.35, glass: 2.2, trim: 0.9, tire: 0.55, caliper: 0.8, head: 1.3, tail: 0.9, interior: 0.35, engine: 0.5 };
// тень в карту теней: кузов + по одному (самому крупному) мешу на колесо — мелочь карта теней не различит
const SHADOW_CATS = new Set(['paint']);

function convertMaterial(m, def, env, shared) {
  const cat = (m.userData && m.userData.cat) || 'trim';
  if (cat === 'paint') {
    if (!shared.paint) {
      shared.paint = new THREE.MeshPhysicalMaterial({
        name: 'paint', color: def.paint, metalness: def.paintMetal ?? 0.5, roughness: 0.3,
        clearcoat: 1.0, clearcoatRoughness: 0.03, envMap: env, envMapIntensity: CAT_ENV.paint, side: m.side,
      });
      shared.list.push(shared.paint);
    }
    return shared.paint;
  }
  if (cat === 'glass') {
    if (!shared.glass) {
      shared.glass = new THREE.MeshStandardMaterial({
        name: 'glass', color: def.glass ?? 0x0b1218, metalness: 0.1, roughness: 0.04,
        transparent: true, opacity: 0.6, depthWrite: false,
        envMap: env, envMapIntensity: CAT_ENV.glass, side: THREE.DoubleSide,
      });
      shared.list.push(shared.glass);
    }
    return shared.glass;
  }
  const transmissive = (m.transmission || 0) > 0;
  // В исходниках у многих непрозрачных деталей стоит alphaMode BLEND — это лишняя
  // сортировка и перерисовка. Без реальной прозрачности делаем деталь непрозрачной,
  // а «дырявые» текстуры (решётки, шильдики) режем alphaTest.
  let transparent = !!m.transparent || transmissive;
  let alphaTest = m.alphaTest || 0;
  if (transparent && !transmissive && (m.opacity ?? 1) >= 0.98) {
    transparent = false;
    if (m.map) alphaTest = Math.max(alphaTest, 0.5);
  }
  const s = new THREE.MeshStandardMaterial({
    name: m.name, color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
    map: m.map || null, normalMap: m.normalMap || null,
    roughness: m.roughness ?? 0.5, metalness: m.metalness ?? 0,
    roughnessMap: m.roughnessMap || null, metalnessMap: m.metalnessMap || null,
    aoMap: m.aoMap || null, aoMapIntensity: m.aoMapIntensity ?? 1,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0), emissiveMap: m.emissiveMap || null,
    emissiveIntensity: m.emissiveIntensity ?? 1,
    transparent,
    opacity: transmissive ? Math.min(m.opacity ?? 1, 0.4) : (transparent ? (m.opacity ?? 1) : 1),
    alphaTest, side: m.side,
    envMap: env, envMapIntensity: CAT_ENV[cat] ?? 0.8, vertexColors: !!m.vertexColors,
  });
  if (m.normalScale && s.normalMap) s.normalScale.copy(m.normalScale);
  if (s.transparent) s.depthWrite = false;
  if (cat === 'tail') {
    s.emissive.set(0xff1a0e); s.emissiveIntensity = 1.1;
    shared.tails.push(s);
  } else if (cat === 'head' && !s.transparent) {
    // лёгкое свечение ламп (ходовые огни), но без «засвета» корпуса фары
    s.emissive.lerp(new THREE.Color(0xfff4e0), 0.35);
    s.emissiveIntensity = Math.max(s.emissiveIntensity, 0.55);
  } else if (cat === 'interior') {
    s.envMapIntensity = CAT_ENV.interior;
  }
  shared.list.push(s);
  return s;
}

/** Один раз на модель: материалы, тени, габариты, радиусы колёс */
function prepareTemplate(def, tpl, env) {
  if (prepared.has(tpl)) return prepared.get(tpl);
  const shared = { paint: null, glass: null, tails: [], list: [] };
  const conv = new Map();
  tpl.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (!conv.has(src)) conv.set(src, convertMaterial(src, def, env, shared));
    o.material = conv.get(src);
    const cat = (src.userData && src.userData.cat) || 'trim';
    o.castShadow = SHADOW_CATS.has(cat);
    o.receiveShadow = false;
    o.userData.cat = cat;
  });
  // Прозрачные двусторонние (стёкла): three.js рисует их в 2 прохода и КАЖДЫЙ кадр
  // ставит material.needsUpdate → пересборка параметров шейдера на CPU. Один проход —
  // разницы на стекле не видно, а кадр дешевле.
  for (const m of shared.list) if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
  for (const m of conv.keys()) m.dispose();          // исходные материалы GLTF больше не нужны
  const car = tpl.getObjectByName('car') || tpl;
  const body = car.getObjectByName('body');
  const box = new THREE.Box3().setFromObject(body);
  const wheelR = {};
  for (const n of ['fl', 'fr', 'rl', 'rr']) {
    const sp = car.getObjectByName('spin_' + n);
    let big = null, bigN = 0;
    if (sp) sp.traverse((o) => { if (o.isMesh) { const k = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count; if (k > bigN) { bigN = k; big = o; } } });
    if (big) big.castShadow = true;
    const b = sp ? new THREE.Box3().setFromObject(sp) : null;
    wheelR[n] = b && !b.isEmpty() ? (b.max.y - b.min.y) / 2 : WHEEL_R;
  }
  const info = {
    shared, wheelR,
    length: box.max.x - box.min.x, width: def.width || (box.max.z - box.min.z),
    frontX: box.max.x,
  };
  prepared.set(tpl, info);
  return info;
}

function instantiateModel(def, tpl, opts) {
  const env = opts.envMap || null;
  const prep = prepareTemplate(def, tpl, env);
  const src = tpl.clone(true);                       // геометрия и материалы общие с шаблоном
  const car = src.getObjectByName('car') || src;
  const group = new THREE.Group();
  const bodyPivot = new THREE.Group();
  bodyPivot.position.y = ROLL_CENTER;
  group.add(bodyPivot);
  const body = car.getObjectByName('body');
  body.position.y -= ROLL_CENTER;
  bodyPivot.add(body);
  const wheels = [];
  for (const n of ['fl', 'fr', 'rl', 'rr']) {
    const w = car.getObjectByName('wheel_' + n);
    if (!w) continue;
    const roller = w.getObjectByName('spin_' + n) || w;
    group.add(w);
    wheels.push({ pivot: w, roller, front: n[0] === 'f', spin: 0, r: prep.wheelR[n] });
  }
  const L = prep.length, W = prep.width;
  let blob = null;
  if (opts.shadowTex) {
    blob = new THREE.Mesh(
      new THREE.PlaneGeometry(L + 0.6, W + 0.7),
      new THREE.MeshBasicMaterial({ map: opts.shadowTex, transparent: true, depthWrite: false, opacity: 0.62, color: 0x000000 })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.025;
    blob.renderOrder = 1;
    group.add(blob);
  }
  let cone = null;
  if (opts.coneTex) {
    const coneGeo = new THREE.PlaneGeometry(7.5, 17);
    coneGeo.rotateX(-Math.PI / 2);
    coneGeo.rotateY(-Math.PI / 2);
    cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      map: opts.coneTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.34, fog: true,
    }));
    cone.position.set(prep.frontX + 8.4, 0.04, 0);
    cone.renderOrder = 4;
    group.add(cone);
  }
  const avgR = wheels.reduce((s, w) => s + w.r, 0) / Math.max(1, wheels.length);
  group.userData = {
    wheels, body, bodyPivot, blob, cone, tailMats: prep.shared.tails,
    length: L, width: W, wheelRadius: avgR || WHEEL_R, isModel: true,
    materials: [],                                   // общие с шаблоном — освобождаем отдельно
  };
  return group;
}

/** Освободить GPU-ресурсы машины (при смене в гараже) */
export function disposeCarMesh(group) {
  const ud = group.userData || {};
  if (ud.isModel) {
    // геометрия/текстуры общие с шаблоном: dispose() освобождает только видеопамять,
    // при повторном показе three.js загрузит их заново
    const seenT = new Set();
    group.traverse((o) => {
      if (!o.isMesh) return;
      if (o === ud.blob || o === ud.cone) return;
      o.geometry.dispose();
      const m = o.material;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'])
        if (m[k] && !seenT.has(m[k])) { seenT.add(m[k]); m[k].dispose(); }
      m.dispose();
    });
    if (ud.blob) { ud.blob.geometry.dispose(); ud.blob.material.dispose(); }
    if (ud.cone) { ud.cone.geometry.dispose(); ud.cone.material.dispose(); }
    return;
  }
  const seen = new Set();
  group.traverse(o => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
  });
  for (const m of ud.materials || []) m.dispose();
  if (ud.blob) ud.blob.material.dispose();
  if (ud.cone) ud.cone.material.dispose();
}

/**
 * Визуальное оживление: качение колёс, поворот руля, крен, клевки, стопы.
 * visual: {roll, pitch, braking}
 *  roll  > 0 — кузов кренится вправо (к локальному +Z)
 *  pitch > 0 — нос вверх
 * У GLB-моделей кренится только кузов (колёса остаются на асфальте).
 */
export function animateCar(group, car, dt, visual) {
  const ud = group.userData;
  if (!ud || !ud.wheels) return;
  for (const w of ud.wheels) {
    w.spin += (car.speed * dt) / (w.r || ud.wheelRadius);
    if (w.spin > 1e4 || w.spin < -1e4) w.spin %= Math.PI * 2;
    // курс в логике растёт по часовой, а rotation.y в THREE — против → знак минус
    w.pivot.rotation.y = w.front ? -car.wheelAngle * 1.6 : 0;
    w.roller.rotation.z = -w.spin;
  }
  const v = visual || { roll: 0, pitch: 0, braking: false };
  if (ud.bodyPivot) {
    group.rotation.x = 0; group.rotation.z = 0;
    ud.bodyPivot.rotation.x = v.roll * 1.15;
    ud.bodyPivot.rotation.z = v.pitch * 1.15;
  } else {
    // порядок YXZ (задан снаружи): курс → крен вокруг продольной оси X → тангаж вокруг Z
    group.rotation.x = v.roll;
    group.rotation.z = v.pitch;
  }
  const lit = v.braking ? 4.0 : 1.1;
  if (ud.tailMats) for (const m of ud.tailMats) m.emissiveIntensity = lit;
  else if (ud.tailMat) ud.tailMat.emissiveIntensity = v.braking ? 4.2 : 1.4;
}
