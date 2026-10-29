// Недорогая графика посещаемых фасадов и отдельных комнат. Машины и город
// остаются в наружной сцене; для телефона повторяющиеся детали инстанцируются.
import * as THREE from '../vendor/three.js';
import { mergeGeometries } from '../vendor/BufferGeometryUtils.js';

function signTexture(text, background, color = '#fff') {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = background; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(255,255,255,.65)'; g.lineWidth = 5; g.strokeRect(5, 5, 502, 118);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 76px Arial, sans-serif'; g.fillStyle = color; g.fillText(text, 256, 68, 480);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Видимые двери, подписи и маркеры; четыре больших чанка вместо сотен
 * отдельных объектов. Цвета и две вывески объединены в общие draw calls. */
export function buildEntranceMeshes(scene, city, entrances) {
  const colorAttribute = (geometry, color) => {
    const c = new THREE.Color(color), count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  };
  const frame = colorAttribute(new THREE.BoxGeometry(1.52, 2.35, 0.10).translate(0, 1.31, 0.045), 0x344047);
  const leaf = colorAttribute(new THREE.BoxGeometry(1.28, 2.16, 0.08).translate(0, 1.27, 0.105), 0xffffff);
  const doorGeo = mergeGeometries([frame, leaf]);
  frame.dispose(); leaf.dispose(); doorGeo.clearGroups();
  const ringGeo = new THREE.RingGeometry(0.43, 0.64, 24); ringGeo.rotateX(-Math.PI / 2);
  const arrowGeo = new THREE.ConeGeometry(0.34, 0.65, 4); arrowGeo.rotateX(Math.PI);
  const doorMat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

  // Атлас подписей: дом сверху, магазин снизу. Одна текстура и один вызов
  // отрисовки на чанк вместо отдельных материалов на каждый тип двери.
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
  const g = canvas.getContext('2d');
  for (const [row, text, background] of [[0, 'ДОМ', '#a95027'], [1, 'МАГАЗИН', '#087866']]) {
    const y = row * 128;
    g.fillStyle = background; g.fillRect(0, y, 512, 128);
    g.strokeStyle = 'rgba(255,255,255,.65)'; g.lineWidth = 5; g.strokeRect(5, y + 5, 502, 118);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '900 76px Arial, sans-serif';
    g.fillStyle = '#fff'; g.fillText(text, 256, y + 68, 480);
  }
  const atlas = new THREE.CanvasTexture(canvas); atlas.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.MeshBasicMaterial({ map: atlas, toneMapped: false });

  const chunks = new Map(), chunkSize = city.pitch * 6;
  for (const door of entrances) {
    const key = `${Math.floor((door.x - city.origin) / chunkSize)},${Math.floor((door.z - city.origin) / chunkSize)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(door);
  }
  const pos = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1), q = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0), matrix = new THREE.Matrix4(), color = new THREE.Color();
  for (const doors of chunks.values()) {
    const n = doors.length;
    const doorMesh = new THREE.InstancedMesh(doorGeo, doorMat, n);
    const ring = new THREE.InstancedMesh(ringGeo, markerMat, n);
    const arrow = new THREE.InstancedMesh(arrowGeo, markerMat, n);
    const vertices = [], uvs = [];
    for (let i = 0; i < n; i++) {
      const d = doors[i], angle = Math.atan2(d.nx, d.nz);
      q.setFromAxisAngle(axis, angle);
      matrix.compose(pos.set(d.faceX, 0, d.faceZ), q, scale); doorMesh.setMatrixAt(i, matrix);
      doorMesh.setColorAt(i, color.setHex(d.kind === 'home' ? 0x9e6346 : 0x547f89));
      matrix.compose(pos.set(d.x, 0.175, d.z), q, scale); ring.setMatrixAt(i, matrix);
      matrix.compose(pos.set(d.x, 2.05, d.z), q, scale); arrow.setMatrixAt(i, matrix);
      color.setHex(d.kind === 'home' ? 0xffbe4b : 0x36f0c3);
      ring.setColorAt(i, color); arrow.setColorAt(i, color);

      // Две треугольные грани вывески, обращённые от стены к улице.
      const cx = d.faceX + d.nx * 0.105, cz = d.faceZ + d.nz * 0.105;
      const rx = d.nz * 0.925, rz = -d.nx * 0.925;
      const leftX = cx - rx, leftZ = cz - rz, rightX = cx + rx, rightZ = cz + rz;
      const low = 2.485, high = 2.915;
      vertices.push(leftX, low, leftZ, rightX, low, rightZ, rightX, high, rightZ,
        leftX, low, leftZ, rightX, high, rightZ, leftX, high, leftZ);
      const v0 = d.kind === 'home' ? 0.5 : 0, v1 = d.kind === 'home' ? 1 : 0.5;
      uvs.push(0, v0, 1, v0, 1, v1, 0, v0, 1, v1, 0, v1);
    }
    const signGeo = new THREE.BufferGeometry();
    signGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    signGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    signGeo.computeBoundingSphere();
    const sign = new THREE.Mesh(signGeo, signMat);
    for (const mesh of [doorMesh, ring, arrow]) {
      mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    for (const mesh of [doorMesh, sign, ring, arrow]) {
      mesh.renderOrder = 3;
      mesh.userData.isEntrance = true;
      scene.add(mesh);
    }
  }
}

function floorTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  if (kind === 'home') {
    g.fillStyle = '#a2734f'; g.fillRect(0, 0, 512, 512);
    for (let y = 0; y < 512; y += 32) {
      g.fillStyle = y % 64 ? 'rgba(80,42,20,.10)' : 'rgba(255,230,200,.08)';
      g.fillRect(0, y + 1, 512, 30);
      g.strokeStyle = 'rgba(65,35,24,.40)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
      for (let x = (y % 64 ? 128 : 0); x < 512; x += 256) g.fillRect(x, y, 2, 32);
      g.strokeStyle = 'rgba(80,50,30,.15)';
      for (let k = 0; k < 3; k++) { g.beginPath(); g.moveTo(0, y + 7 + k * 7); g.lineTo(512, y + 8 + k * 7); g.stroke(); }
    }
  } else {
    g.fillStyle = '#dedbd1'; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#aaa99f'; g.lineWidth = 3;
    for (let i = 0; i <= 512; i += 64) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
    }
    for (let y = 0; y < 512; y += 64) for (let x = 0; x < 512; x += 64) {
      if ((x + y) % 128 === 0) { g.fillStyle = 'rgba(143,176,166,.10)'; g.fillRect(x + 2, y + 2, 60, 60); }
    }
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 2);
  return tex;
}

/** Создать одну комнату; ни наружная сцена, ни сохранённый автомобиль не меняются. */
export function buildInteriorScene(layout, variation = 0) {
  const home = layout.kind === 'home';
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(home ? 0xc5b7a3 : 0xb6c6c4);
  scene.add(new THREE.HemisphereLight(0xf7f3e8, 0xb6afa2, 2.3));
  const lamp = new THREE.DirectionalLight(0xffe6c6, 1.2);
  lamp.position.set(-3, 8, 4); scene.add(lamp);

  const palette = home ? [0xe7ddca, 0xe0d7c9, 0xd7ded7] : [0xe1e8df, 0xe5e6db, 0xd9e4df];
  const mat = {
    wall: new THREE.MeshLambertMaterial({ color: palette[variation % palette.length] }),
    trim: new THREE.MeshLambertMaterial({ color: home ? 0xf3e6d3 : 0xf0f0e6 }),
    ceiling: new THREE.MeshLambertMaterial({ color: 0xf5f0e4 }),
    wood: new THREE.MeshLambertMaterial({ color: home ? 0x754a31 : 0x687d78 }),
    dark: new THREE.MeshLambertMaterial({ color: 0x303d40 }),
    door: new THREE.MeshLambertMaterial({ color: home ? 0x8e5a3d : 0x466e70 }),
    glass: new THREE.MeshLambertMaterial({ color: 0x99c7d0 }),
    metal: new THREE.MeshLambertMaterial({ color: 0x9fa8a2 }),
    white: new THREE.MeshLambertMaterial({ color: 0xf4e9d6 }),
    accent: new THREE.MeshLambertMaterial({ color: home ? [0x526e6e, 0x6c727f, 0x83715e][variation % 3] : 0x278c71 }),
    accent2: new THREE.MeshLambertMaterial({ color: home ? 0xc78559 : 0xe4a842 }),
    fabric: new THREE.MeshLambertMaterial({ color: home ? 0xd4c7b2 : 0xf1f0e5 }),
    leaf: new THREE.MeshLambertMaterial({ color: 0x4b8559 }),
    rug: new THREE.MeshLambertMaterial({ color: home ? 0x9c6655 : 0x466f68 }),
  };
  const unit = new THREE.BoxGeometry(1, 1, 1), batches = new Map();
  const matrix = new THREE.Matrix4();
  function box(material, x, y, z, w, h, d) {
    if (!batches.has(material)) batches.set(material, []);
    const m = new THREE.Matrix4().makeScale(w, h, d); m.setPosition(x, y, z);
    batches.get(material).push(m);
  }
  // Пол с отдельной текстурой, стены и потолок полностью окружают игрока.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12),
    new THREE.MeshLambertMaterial({ map: floorTexture(layout.kind) }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.015; scene.add(floor);
  for (const w of layout.walls) box(mat.wall, w.x, layout.height / 2, w.z, w.hw * 2, layout.height, w.hd * 2);
  box(mat.ceiling, 0, layout.height + 0.04, 0, 12.3, 0.08, 12.3);
  box(mat.trim, -5.82, 0.12, 0, 0.08, 0.24, 11.7);
  box(mat.trim, 5.82, 0.12, 0, 0.08, 0.24, 11.7);
  box(mat.trim, 0, 0.12, -5.82, 11.7, 0.24, 0.08);
  box(mat.trim, 0, 0.12, 5.82, 11.7, 0.24, 0.08);
  // Закрытая дверь, за которой с помощью кнопки возвращаемся на улицу.
  box(mat.dark, 0, 1.27, 5.79, 1.72, 2.54, 0.09);
  box(mat.door, 0, 1.20, 5.73, 1.48, 2.35, 0.07);
  box(mat.metal, -0.50, 1.12, 5.67, 0.12, 0.12, 0.07);
  box(mat.white, 0, 3.35, 0, 1.5, 0.07, 0.55); // потолочный светильник
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 0.37),
    new THREE.MeshBasicMaterial({ map: signTexture('ВЫХОД', '#1b795e'), toneMapped: false }));
  exitSign.position.set(0, 2.79, 5.68); exitSign.rotation.y = Math.PI; scene.add(exitSign);
  const exitRing = new THREE.Mesh(new THREE.RingGeometry(0.43, 0.64, 24),
    new THREE.MeshBasicMaterial({ color: 0xffcf58, toneMapped: false }));
  exitRing.rotation.x = -Math.PI / 2; exitRing.position.set(layout.exit.x, 0.012, layout.exit.z); scene.add(exitRing);

  // Настенное окно — декоративное, не портал в отдельный несуществующий мир.
  box(mat.trim, 5.79, 2.0, 2.0, 0.07, 1.45, 2.2);
  box(mat.glass, 5.72, 2.0, 2.0, 0.06, 1.25, 2.0);
  box(mat.trim, 5.66, 2.0, 2.0, 0.04, 1.3, 0.07);
  box(mat.trim, 5.66, 2.0, 2.0, 0.04, 0.07, 2.0);

  if (home) {
    box(mat.rug, -2.1, 0.015, -0.8, 3.5, 0.03, 3.0);
    for (const p of layout.props) {
      if (p.kind === 'sofa') {
        box(mat.wood, p.x, 0.23, p.z, p.hw * 2, 0.38, p.hd * 2);
        box(mat.accent, p.x, 0.53, p.z, p.hw * 2, 0.45, p.hd * 2);
        box(mat.accent, p.x - 0.57, 0.95, p.z, 0.28, 1.0, p.hd * 2);
        for (const dz of [-1.46, 1.46]) box(mat.accent, p.x, 0.75, p.z + dz, 1.5, 0.50, 0.35);
        for (const dz of [-0.95, 0, 0.95]) box(mat.fabric, p.x + 0.10, 0.80, p.z + dz, 0.55, 0.18, 0.65);
      } else if (p.kind === 'bed') {
        box(mat.wood, p.x, 0.25, p.z, p.hw * 2, 0.45, p.hd * 2);
        box(mat.fabric, p.x, 0.57, p.z, p.hw * 2 - 0.12, 0.22, p.hd * 2 - 0.12);
        box(mat.accent2, p.x, 0.70, p.z + 0.38, p.hw * 2 - 0.14, 0.08, 1.0);
        for (const dx of [-0.65, 0.65]) box(mat.white, p.x + dx, 0.74, p.z - 0.55, 0.85, 0.18, 0.42);
        box(mat.wood, p.x, 0.85, p.z - 0.93, p.hw * 2, 1.0, 0.13);
      } else if (p.kind === 'table') {
        box(mat.wood, p.x, 0.58, p.z, p.hw * 2, 0.12, p.hd * 2);
        for (const dx of [-0.65, 0.65]) for (const dz of [-0.4, 0.4]) box(mat.wood, p.x + dx, 0.29, p.z + dz, 0.11, 0.58, 0.11);
        box(mat.white, p.x - 0.22, 0.67, p.z, 0.45, 0.06, 0.30);
      } else if (p.kind === 'kitchen') {
        box(mat.wood, p.x, 0.48, p.z, p.hw * 2, 0.92, p.hd * 2);
        box(mat.trim, p.x, 0.98, p.z, p.hw * 2 + 0.06, 0.10, p.hd * 2 + 0.06);
        box(mat.metal, p.x - 0.8, 1.04, p.z, 0.9, 0.04, 0.6);
        box(mat.dark, p.x + 0.9, 1.04, p.z, 0.75, 0.04, 0.6);
        box(mat.wood, p.x, 2.55, -5.54, p.hw * 2, 0.65, 0.45);
      } else if (p.kind === 'cabinet') {
        box(mat.wood, p.x, 1.05, p.z, p.hw * 2, 2.1, p.hd * 2);
        box(mat.dark, p.x - 0.5, 1.15, p.z, 0.05, 1.7, p.hd * 2 - 0.2);
      } else if (p.kind === 'plant') {
        box(mat.accent2, p.x, 0.25, p.z, 0.58, 0.5, 0.58);
        box(mat.leaf, p.x, 0.85, p.z, p.hw * 2, 0.9, p.hd * 2);
      }
    }
    // Картина и растение оживляют комнату без дорогих источников света.
    box(mat.wood, -3.4, 2.35, -5.79, 2.3, 1.0, 0.08);
    box(mat.glass, -3.4, 2.35, -5.72, 2.05, 0.78, 0.05);
  } else {
    const products = [];
    for (const p of layout.props) {
      if (p.kind === 'shelf') {
        // Тонкая центральная стенка и торцы: товары не прячутся внутри
        // сплошного ящика и видны с обеих сторон прохода.
        box(mat.dark, p.x, 1.05, p.z, 0.08, 2.1, p.hd * 2);
        for (const dz of [-p.hd + 0.04, p.hd - 0.04]) box(mat.dark, p.x, 1.05, p.z + dz, p.hw * 2, 2.1, 0.08);
        for (const y of [0.22, 0.78, 1.34, 1.9]) {
          box(mat.trim, p.x, y, p.z, p.hw * 2 + 0.1, 0.10, p.hd * 2);
          if (y < 1.9) for (let i = 0; i < 12; i++) {
            const z = p.z - p.hd + 0.26 + i * 0.43;
            for (const dx of [-0.26, 0.26]) products.push({ x: p.x + dx, y: y + 0.23, z, color: (i + Math.round(y * 10) + (dx > 0 ? 2 : 0)) % 5 });
          }
        }
      } else if (p.kind === 'counter') {
        box(mat.accent, p.x, 0.55, p.z, p.hw * 2, 1.1, p.hd * 2);
        box(mat.trim, p.x, 1.13, p.z, p.hw * 2 + 0.1, 0.10, p.hd * 2 + 0.1);
        box(mat.dark, p.x + 0.7, 1.28, p.z, 0.55, 0.25, 0.38);
        box(mat.metal, p.x + 0.7, 1.48, p.z - 0.12, 0.45, 0.3, 0.08);
      } else if (p.kind === 'chiller') {
        box(mat.metal, p.x, 1.1, p.z, p.hw * 2, 2.2, p.hd * 2);
        box(mat.glass, p.x, 1.15, p.z + 0.52, p.hw * 2 - 0.18, 1.8, 0.05);
        for (const dx of [-1, 0, 1]) box(mat.trim, p.x + dx, 1.15, p.z + 0.56, 0.04, 1.8, 0.04);
      }
    }
    const productMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(unit, productMat, products.length);
    const colors = [0xde7160, 0x5d9f93, 0xe4bc69, 0x7c9ac5, 0xe6e2ca], col = new THREE.Color();
    products.forEach((p, i) => {
      matrix.makeScale(0.30, 0.32, 0.28); matrix.setPosition(p.x, p.y, p.z);
      mesh.setMatrixAt(i, matrix); mesh.setColorAt(i, col.setHex(colors[p.color]));
    });
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; scene.add(mesh);
    box(mat.accent, 0, 2.5, -5.78, 3.5, 0.8, 0.07);
    const market = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.62),
      new THREE.MeshBasicMaterial({ map: signTexture('МАРКЕТ', '#16846c'), toneMapped: false }));
    market.position.set(0, 2.5, -5.70); scene.add(market);
  }

  for (const [material, transforms] of batches) {
    const mesh = new THREE.InstancedMesh(unit, material, transforms.length);
    transforms.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); scene.add(mesh);
  }
  return scene;
}

/** Освобождаем только принадлежащие комнате ресурсы, не затрагивая героя. */
export function disposeInteriorScene(scene) {
  const geometries = new Set(), materials = new Set(), textures = new Set(), instances = [];
  scene.traverse(o => {
    if (o.geometry) geometries.add(o.geometry);
    if (o.isInstancedMesh) instances.push(o);
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of ms) { materials.add(m); if (m.map) textures.add(m.map); }
  });
  // InstanceMatrix/instanceColor имеют собственные буферы WebGL.
  instances.forEach(o => o.dispose());
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
  textures.forEach(t => t.dispose());
}
