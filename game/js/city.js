// ============================================================================
//  CITY — процедурная генерация города.
//  ЧИСТАЯ ЛОГИКА: никаких DOM, никаких THREE. Поэтому её можно тестировать в Node.
//  Возвращает: кварталы, здания (AABB), деревья, фонари, коллайдеры, границы.
//
//  Геометрия сетки: дорога i занимает [origin + i*pitch - road, origin + i*pitch],
//  квартал i — [origin + i*pitch, origin + i*pitch + block].
//  Внутри квартала по краю — тротуар (cfg.sidewalk), дома стоят за ним.
//  Вокруг города — кольцо плотной высокой застройки + невидимые стены:
//  уехать «в пустоту» невозможно, а горизонт закрыт домами.
// ============================================================================
import { makeRng } from './rng.js';

export function generateCity(cfg) {
  const rng = makeRng(cfg.seed);
  const grid = cfg.grid;
  const block = cfg.block;
  const road = cfg.road;
  const sidewalk = cfg.sidewalk ?? 3;
  const pitch = block + road;
  const extent = grid * pitch;
  const origin = -extent / 2;

  /** Центр i-й дороги (0..grid) */
  const roadAt = (i) => origin + i * pitch - road / 2;
  /** Центр квартала с индексом i (может быть -1 или grid для внешнего кольца) */
  const blockCenter = (i) => origin + i * pitch + block / 2;

  const maxDist = Math.hypot(extent / 2, extent / 2);

  const blocks = [];
  const buildings = [];   // {x,z,hw,hd,h,colorIdx,windowSeed}
  const trees = [];       // {x,z,s}
  const lamps = [];       // {x,z,ox,oz}

  // ------------------------------------------------------------- КВАРТАЛЫ --
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const cx = blockCenter(i);
      const cz = blockCenter(j);

      // Дальность от центра → высота застройки (деловой центр выше)
      const d = Math.hypot(cx, cz) / maxDist;           // 0..1
      const downtown = Math.max(0, 1 - d * 1.35);       // 1 в центре, 0 на окраине
      const isPark = rng.chance(cfg.parkChance) && downtown < 0.55;

      const b = makeBlock(i, j, cx, cz, block, isPark ? 'park' : 'urban');
      blocks.push(b);

      if (isPark) {
        const n = 4;
        const inner = block - sidewalk * 2;
        const step = inner / n;
        for (let a = 0; a < n; a++) {
          for (let c = 0; c < n; c++) {
            if (!rng.chance(0.72)) continue;
            if (trees.length >= cfg.maxTrees) break;
            trees.push({
              x: b.minX + sidewalk + step * (a + 0.5) + rng.range(-1.4, 1.4),
              z: b.minZ + sidewalk + step * (c + 0.5) + rng.range(-1.4, 1.4),
              s: rng.range(0.85, 1.35),
            });
          }
        }
        continue;
      }

      // Участки: 2x2 в центре, на окраинах 2x2 или 3x3
      const sub = downtown > 0.45 ? 2 : (rng.chance(0.45) ? 3 : 2);
      const gap = 2.4;
      const inner = block - sidewalk * 2;
      const lot = (inner - gap * (sub - 1)) / sub;

      for (let a = 0; a < sub; a++) {
        for (let c = 0; c < sub; c++) {
          if (buildings.length >= cfg.maxBuildings) continue;
          if (rng.chance(0.07)) continue; // пустой участок (двор)

          const hw = (lot / 2) * rng.range(0.74, 0.96);
          const hd = (lot / 2) * rng.range(0.74, 0.96);
          // сдвиг внутри участка, не выходя за его границы
          const jx = rng.range(-1, 1) * (lot / 2 - hw);
          const jz = rng.range(-1, 1) * (lot / 2 - hd);
          const lx = b.minX + sidewalk + a * (lot + gap) + lot / 2 + jx;
          const lz = b.minZ + sidewalk + c * (lot + gap) + lot / 2 + jz;

          const hNorm = downtown * rng.range(0.75, 1.25) + rng.range(0, 0.30);
          const h = Math.max(cfg.minH, Math.min(cfg.maxH, cfg.minH + hNorm * (cfg.maxH - cfg.minH)));

          buildings.push({
            x: lx, z: lz, hw, hd, h,
            colorIdx: rng.int(0, 7),
            windowSeed: rng.int(0, 1 << 20),
          });
          b.count++;
        }
      }
    }
  }
  const innerBuildingCount = buildings.length;

  // ---------------------------------------------------- ВНЕШНЕЕ КОЛЬЦО ----
  // Сплошная стена домов без проходов: закрывает горизонт и край мира.
  for (let i = -1; i <= grid; i++) {
    for (let j = -1; j <= grid; j++) {
      if (i >= 0 && i < grid && j >= 0 && j < grid) continue;
      const cx = blockCenter(i), cz = blockCenter(j);
      const b = makeBlock(i, j, cx, cz, block, 'perimeter');
      blocks.push(b);
      const inner = block - sidewalk * 2;
      const n = 3;
      const lot = inner / n;
      for (let a = 0; a < n; a++) {
        for (let c = 0; c < n; c++) {
          // внутренние участки не видны — ставим только внешний периметр квартала
          if (a === 1 && c === 1) continue;
          buildings.push({
            x: b.minX + sidewalk + lot * (a + 0.5),
            z: b.minZ + sidewalk + lot * (c + 0.5),
            hw: lot / 2, hd: lot / 2,
            h: rng.range(22, 46),
            colorIdx: rng.int(0, 7),
            windowSeed: rng.int(0, 1 << 20),
            perimeter: true,
          });
          b.count++;
        }
      }
    }
  }

  // ------------------------------------------------------------- ФОНАРИ ----
  // На углах перекрёстков, на тротуаре (1.1 м от бордюра).
  const off = road / 2 + 1.1;
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      const x = roadAt(i), z = roadAt(j);
      for (const [sx, sz] of [[1, 1], [-1, -1]]) {
        if (lamps.length >= cfg.maxLamps) break;
        if (!rng.chance(0.85)) continue;
        lamps.push({ x: x + sx * off, z: z + sz * off, ox: sx, oz: sz });
      }
    }
  }

  // ------------------------------------------------------------ ГРАНИЦЫ ----
  // Игровая зона: от внешнего края дороги 0 до внешнего края дороги grid,
  // плюс тротуар внешнего кольца (до фасадов).
  const minEdge = roadAt(0) - road / 2 - sidewalk;
  const maxEdge = roadAt(grid) + road / 2 + sidewalk;
  const bounds = { minX: minEdge, maxX: maxEdge, minZ: minEdge, maxZ: maxEdge };
  const far = pitch * 2;
  const walls = [
    boxFromMinMax(minEdge - far, minEdge, minEdge - far, maxEdge + far),   // запад
    boxFromMinMax(maxEdge, maxEdge + far, minEdge - far, maxEdge + far),   // восток
    boxFromMinMax(minEdge - far, maxEdge + far, minEdge - far, minEdge),   // север
    boxFromMinMax(minEdge - far, maxEdge + far, maxEdge, maxEdge + far),   // юг
  ];

  // ---------------------------------------------------------- КОЛЛАЙДЕРЫ ---
  // Все препятствия одним списком AABB: дома, стволы деревьев, столбы, стены.
  const colliders = [];
  for (const b of buildings) colliders.push({ x: b.x, z: b.z, hw: b.hw, hd: b.hd, kind: 'building' });
  for (const t of trees) colliders.push({ x: t.x, z: t.z, hw: 0.3 * t.s, hd: 0.3 * t.s, kind: 'tree' });
  for (const l of lamps) colliders.push({ x: l.x, z: l.z, hw: 0.2, hd: 0.2, kind: 'lamp' });
  for (const w of walls) colliders.push(Object.assign(w, { kind: 'wall' }));

  // --------------------------------------------------------- СТАРТ ИГРОКА --
  // Правая полоса вертикальной дороги, лицом на юг (+Z).
  const startRoad = roadAt(Math.floor(grid / 2));
  const lane = road * 0.25; // 3.5 м от оси дороги
  const start = { x: startRoad - lane, z: blockCenter(Math.floor(grid / 2)) - block / 2 + 6, heading: Math.PI / 2 };

  const roadCenters = [];
  for (let i = 0; i <= grid; i++) roadCenters.push(roadAt(i));

  return {
    seed: cfg.seed,
    grid, block, road, sidewalk, pitch, extent, origin,
    blocks, buildings, innerBuildingCount, trees, lamps, colliders, walls, bounds, start,
    roadAt, blockCenter, lane, roadCenters,
  };
}

function makeBlock(i, j, cx, cz, block, type) {
  return {
    i, j, cx, cz, hw: block / 2, hd: block / 2, type,
    minX: cx - block / 2, maxX: cx + block / 2,
    minZ: cz - block / 2, maxZ: cz + block / 2,
    count: 0,
  };
}

function boxFromMinMax(x0, x1, z0, z1) {
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, hw: (x1 - x0) / 2, hd: (z1 - z0) / 2 };
}

// ============================================================================
//  КОЛЛИЗИИ — пространственный хэш.
//  Хэш строится ОДИН раз на старте; каждый кадр — только O(1) выборка соседей.
//  Это критично для Helio G85: перебор ~1000 препятствий 120 раз в секунду убьёт FPS.
// ============================================================================
export function buildSpatialHash(items, cellSize) {
  const cell = cellSize || 60;
  const map = new Map();
  const key = (cx, cy) => (cx + 32768) * 65536 + (cy + 32768);

  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    const x0 = Math.floor((b.x - b.hw - 1) / cell);
    const x1 = Math.floor((b.x + b.hw + 1) / cell);
    const z0 = Math.floor((b.z - b.hd - 1) / cell);
    const z1 = Math.floor((b.z + b.hd + 1) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = z0; cy <= z1; cy++) {
        const k = key(cx, cy);
        let arr = map.get(k);
        if (!arr) { arr = []; map.set(k, arr); }
        arr.push(b);
      }
    }
  }
  let stamp = 0;
  return {
    cell,
    /** Кандидаты рядом с (x,z) в радиусе r. Без аллокаций (пишет в out). */
    query(x, z, r, out) {
      const res = out || [];
      res.length = 0;
      stamp++;
      const x0 = Math.floor((x - r) / cell);
      const x1 = Math.floor((x + r) / cell);
      const z0 = Math.floor((z - r) / cell);
      const z1 = Math.floor((z + r) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = z0; cy <= z1; cy++) {
          const arr = map.get(key(cx, cy));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const it = arr[i];
            if (it._q === stamp) continue;   // дедупликация без indexOf (O(1))
            it._q = stamp;
            res.push(it);
          }
        }
      }
      return res;
    },
    get size() { return map.size; },
  };
}

/**
 * Круг против набора AABB. Возвращает самое глубокое проникновение
 * {nx, nz, depth, item} (нормаль от препятствия к кругу) или null.
 */
export function circleVsAABBs(px, pz, radius, items) {
  let best = null;
  let bestDepth = 0;
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    const cx = Math.max(b.x - b.hw, Math.min(px, b.x + b.hw));
    const cz = Math.max(b.z - b.hd, Math.min(pz, b.z + b.hd));
    const dx = px - cx;
    const dz = pz - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;

    let depth, nxn, nzn;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      depth = radius - d;
      nxn = dx / d;
      nzn = dz / d;
    } else {
      // Центр круга внутри бокса — выталкиваем по кратчайшей оси
      const left = (px - (b.x - b.hw)) + radius;
      const right = ((b.x + b.hw) - px) + radius;
      const top = (pz - (b.z - b.hd)) + radius;
      const bottom = ((b.z + b.hd) - pz) + radius;
      const m = Math.min(left, right, top, bottom);
      depth = m;
      if (m === left) { nxn = -1; nzn = 0; }
      else if (m === right) { nxn = 1; nzn = 0; }
      else if (m === top) { nxn = 0; nzn = -1; }
      else { nxn = 0; nzn = 1; }
    }
    if (!best || depth > bestDepth) {
      bestDepth = depth;
      best = { nx: nxn, nz: nzn, depth, item: b };
    }
  }
  return best;
}

/** Точка на проезжей части? (для оффроуд-замедления). O(1). */
export function isOnRoad(city, x, z) {
  const span = city.grid * city.pitch + city.road;
  const ux = x - (city.origin - city.road);
  const uz = z - (city.origin - city.road);
  const onX = ux >= 0 && ux < span && (ux % city.pitch) < city.road;
  const onZ = uz >= 0 && uz < span && (uz % city.pitch) < city.road;
  // дорога вдоль Z (x фиксирован) или вдоль X; плюс в пределах сетки по другой оси
  return (onX && uz >= 0 && uz < span) || (onZ && ux >= 0 && ux < span);
}

/** Ближайшая ось дороги (для ИИ трафика и чекпоинтов) */
export function nearestRoadAxis(city, x, z) {
  let bestAxis = 'x', bestC = city.roadAt(0), bestD = Infinity;
  for (let i = 0; i <= city.grid; i++) {
    const c = city.roadAt(i);
    const dx = Math.abs(x - c);
    const dz = Math.abs(z - c);
    if (dx < bestD) { bestD = dx; bestAxis = 'z'; bestC = c; }
    if (dz < bestD) { bestD = dz; bestAxis = 'x'; bestC = c; }
  }
  return { axis: bestAxis, c: bestC, dist: bestD };
}
