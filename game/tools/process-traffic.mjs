// Конвейер моделей трафика: CC0 «Free Low Poly Vehicles Pack» (Rgsdev, FBX) → assets/traffic.glb
// Каждая машина = один меш (кузов + колёса слиты): POSITION, NORMAL, COLOR_0 (цвет материала),
// _PAINT (1 — кузовная краска, перекрашивается цветом инстанса; 0 — стекло, шины, фары, отделка),
// _GLOW (1 — фары и стоп-сигналы: светятся сами, без отдельных мешей).
// Пропорции пака «игрушечные» (ширина ≈ 0.54 длины) → кузов приводим к реальным габаритам,
// колёса масштабируем равномерно, чтобы остались круглыми.
// Запуск (нужны three@0.169.0, @gltf-transform/core|extensions|functions, meshoptimizer):
//   node tools/process-traffic.mjs <папка_пака> <выходной.glb>
import fs from 'fs';
globalThis.self = globalThis; globalThis.window = globalThis;
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { Document, NodeIO } = await import('@gltf-transform/core');
const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
const { quantize, meshopt } = await import('@gltf-transform/functions');
const { MeshoptEncoder } = await import('meshoptimizer');

const DIR = process.argv[2] || '/tmp/cars/rgs/Free Low Poly Vehicles Pack by Rgsdev';
const OUT = process.argv[3] || './assets/traffic.glb';

// длина / ширина кузова / высота (м) — как у реальных машин такого класса
export const TRAFFIC_TYPES = [
  { id: 'sedan', src: 'Sedan', L: 4.70, W: 1.84, H: 1.46, wheelR: 0.33 },
  { id: 'hatch', src: 'Hatchback', L: 4.20, W: 1.80, H: 1.48, wheelR: 0.32 },
  { id: 'suv', src: 'SUV', L: 4.70, W: 1.90, H: 1.70, wheelR: 0.37 },
  { id: 'van', src: 'Van', L: 5.10, W: 1.95, H: 1.95, wheelR: 0.35 },
  { id: 'taxi', src: 'Taxi', L: 4.70, W: 1.84, H: 1.55, wheelR: 0.33, fixedPaint: true },
  { id: 'pickup', src: 'Pickup', L: 5.10, W: 1.92, H: 1.78, wheelR: 0.37 },
  { id: 'muscle', src: 'Muscle', L: 4.80, W: 1.90, H: 1.36, wheelR: 0.34 },
  { id: 'sports', src: 'Sports', L: 4.45, W: 1.90, H: 1.25, wheelR: 0.33 },
];

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
// подправленные цвета деталей (пак слишком «пастельный»)
const PART_COLORS = {
  windows: [0.035, 0.045, 0.06], headlights: [0.85, 0.87, 0.9], 'rear lights': [0.45, 0.02, 0.02],
  wheels: [0.62, 0.64, 0.68], tires: [0.035, 0.035, 0.04], 'body black': [0.045, 0.045, 0.05], 'body white': [0.82, 0.82, 0.8],
};

async function main() {
  await MeshoptEncoder.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('traffic');
  const mat = doc.createMaterial('traffic').setRoughnessFactor(0.5).setMetallicFactor(0.1);
  const meta = {};
  for (const t of TRAFFIC_TYPES) {
    const buf = fs.readFileSync(`${DIR}/${t.src}/${t.src}.fbx`);
    const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    obj.updateMatrixWorld(true);
    // габариты кузова (без колёс)
    const bodyBox = new THREE.Box3(), wheelBoxes = [];
    obj.traverse(o => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      if (/wheel/i.test(o.name)) wheelBoxes.push({ o, b }); else bodyBox.union(b);
    });
    const full = new THREE.Box3().setFromObject(obj);
    const len = full.max.z - full.min.z, wid = bodyBox.max.x - bodyBox.min.x, hei = full.max.y - full.min.y;
    const sL = t.L / len, sW = t.W / wid, sH = t.H / hei;
    const cz = (full.min.z + full.max.z) / 2, cx = (full.min.x + full.max.x) / 2;
    // игровые оси: нос (+Z пака) → +X, правый борт (−X пака) → +Z, низ → y = 0
    const toGame = (v) => new THREE.Vector3((v.z - cz) * sL, (v.y - full.min.y) * sH, -(v.x - cx) * sW);
    const pos = [], nrm = [], col = [], paint = [], glow = [];
    const nTmp = new THREE.Vector3(), vTmp = new THREE.Vector3();
    obj.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      const P = g.attributes.position, N = g.attributes.normal;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = g.groups.length ? g.groups : [{ start: 0, count: P.count, materialIndex: 0 }];
      const isWheel = /wheel/i.test(o.name);
      let wc = null, ws = 1;
      if (isWheel) {   // колесо: равномерный масштаб вокруг центра, центр — по общей схеме
        const wb = new THREE.Box3().setFromObject(o);
        wc = wb.getCenter(new THREE.Vector3());
        ws = t.wheelR / ((wb.max.y - wb.min.y) / 2);
      }
      const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
      for (const gr of groups) {
        const m = mats[gr.materialIndex] || mats[0];
        const name = (m.name || '').toLowerCase();
        const isPaint = /^body /.test(name) && !/white|black/.test(name);
        const isGlow = name === 'headlights' || name === 'rear lights';
        let c = PART_COLORS[name];
        if (!c) { c = [srgbToLinear(m.color.r), srgbToLinear(m.color.g), srgbToLinear(m.color.b)]; }
        if (isPaint && !t.fixedPaint) c = [1, 1, 1];        // перекрашивается цветом инстанса
        if (isPaint && t.fixedPaint) c = [0.95, 0.55, 0.02]; // такси — всегда жёлтое
        for (let i = gr.start; i < gr.start + gr.count; i++) {
          vTmp.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
          let gv;
          if (isWheel) {
            const cg = toGame(wc);
            const d = vTmp.clone().sub(wc).multiplyScalar(ws);
            gv = new THREE.Vector3(cg.x + d.z, cg.y + d.y, cg.z - d.x);
          } else gv = toGame(vTmp);
          pos.push(gv.x, gv.y, gv.z);
          nTmp.fromBufferAttribute(N, i).applyMatrix3(nm);
          // нормаль при неравномерном масштабе: делим на масштаб по осям и нормируем
          let nx = nTmp.z, ny = nTmp.y, nz = -nTmp.x;
          if (!isWheel) { nx /= sL; ny /= sH; nz /= sW; }
          const l = Math.hypot(nx, ny, nz) || 1;
          nrm.push(nx / l, ny / l, nz / l);
          col.push(c[0], c[1], c[2]);
          paint.push(isPaint && !t.fixedPaint ? 1 : 0);
          glow.push(isGlow ? 1 : 0);
        }
      }
    });
    const n = pos.length / 3;
    // сварка одинаковых вершин → индексы
    const key = (i) => `${pos[i*3].toFixed(4)},${pos[i*3+1].toFixed(4)},${pos[i*3+2].toFixed(4)},${nrm[i*3].toFixed(3)},${nrm[i*3+1].toFixed(3)},${nrm[i*3+2].toFixed(3)},${col[i*3].toFixed(3)},${paint[i]},${glow[i]}`;
    const map = new Map(), P2 = [], N2 = [], C2 = [], A2 = [], G2 = [], I = [];
    for (let i = 0; i < n; i++) {
      const k = key(i); let j = map.get(k);
      if (j === undefined) { j = P2.length / 3; map.set(k, j); P2.push(pos[i*3], pos[i*3+1], pos[i*3+2]); N2.push(nrm[i*3], nrm[i*3+1], nrm[i*3+2]); C2.push(col[i*3], col[i*3+1], col[i*3+2]); A2.push(paint[i]); G2.push(glow[i]); }
      I.push(j);
    }
    const prim = doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P2)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N2)).setBuffer(buffer))
      .setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(C2)).setBuffer(buffer))
      .setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(new Float32Array(A2)).setBuffer(buffer))
      .setAttribute('_GLOW', doc.createAccessor().setType('SCALAR').setArray(new Float32Array(G2)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(I)).setBuffer(buffer));
    const mesh = doc.createMesh(t.id).addPrimitive(prim);
    scene.addChild(doc.createNode(t.id).setMesh(mesh));
    meta[t.id] = { L: t.L, W: t.W, H: t.H, tris: I.length / 3, verts: P2.length / 3 };
    console.log(`${t.id.padEnd(7)} ${t.src.padEnd(10)} ${len.toFixed(0)}×${wid.toFixed(0)}×${hei.toFixed(0)} → ${t.L}×${t.W}×${t.H} м, треугольников ${I.length / 3}, вершин ${P2.length / 3}`);
  }
  await doc.transform(quantize({ quantizePosition: 12, quantizeNormal: 8, quantizeColor: 8, quantizeGeneric: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  await io.write(OUT, doc);
  console.log('→', OUT, (fs.statSync(OUT).size / 1024).toFixed(0), 'КБ');
}
main().catch(e => { console.error(e); process.exit(1); });
