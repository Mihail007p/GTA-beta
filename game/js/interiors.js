// Двери выбираются из существующего города без изменения его генератора и seed.
// Вход только с проходимого фасада, соединённого с ближайшей дорогой.
import { buildSpatialHash, circleVsAABBs } from './city.js';
import { HERO_RADIUS, circleVsCar } from './pedestrian.js';
import { makeHomeInteractions } from './home-interactions.js';

export const DOOR_REACH = 1.35;
export const EXIT_REACH = 1.35;

export function makeEntrances(city, hash) {
  const entrances = [], nearby = [];
  for (let id = 0; id < city.innerBuildingCount; id++) {
    const b = city.buildings[id];
    const sides = [
      { faceX: b.x - b.hw, faceZ: b.z, nx: -1, nz: 0 },
      { faceX: b.x + b.hw, faceZ: b.z, nx: 1, nz: 0 },
      { faceX: b.x, faceZ: b.z - b.hd, nx: 0, nz: -1 },
      { faceX: b.x, faceZ: b.z + b.hd, nx: 0, nz: 1 },
    ];
    const eligible = [];
    for (const side of sides) {
      const face = side.nx ? side.faceX : side.faceZ;
      const direction = side.nx || side.nz;
      let gap = Infinity;
      for (const road of city.roadCenters) {
        const d = (road - face) * direction - city.road / 2;
        if (d >= 0 && d < gap) gap = d;
      }
      if (gap > 10) continue;
      // Не ставим дверь за другим зданием, деревом, стеной или фонарём.
      // Пробуем не только сам маркер, но и весь путь до края дороги.
      let blocked = false;
      const end = Math.max(1.15, gap + 1);
      for (let d = 0.85; d <= end + 0.001; d += 0.5) {
        const x = side.faceX + side.nx * d, z = side.faceZ + side.nz * d;
        hash.query(x, z, HERO_RADIUS + 0.12, nearby);
        if (circleVsAABBs(x, z, HERO_RADIUS + 0.1, nearby)) { blocked = true; break; }
      }
      // Последняя проба обязательна даже при нецелом числе шагов.
      const x = side.faceX + side.nx * end, z = side.faceZ + side.nz * end;
      hash.query(x, z, HERO_RADIUS + 0.12, nearby);
      if (circleVsAABBs(x, z, HERO_RADIUS + 0.1, nearby)) blocked = true;
      if (!blocked) eligible.push({ ...side, gap });
    }
    if (!eligible.length) continue;
    eligible.sort((a, b) => a.gap - b.gap);
    const s = eligible[0];
    entrances.push({
      id, kind: b.windowSeed % 3 === 0 ? 'shop' : 'home',
      faceX: s.faceX, faceZ: s.faceZ, nx: s.nx, nz: s.nz,
      x: s.faceX + s.nx * 1.15, z: s.faceZ + s.nz * 1.15,
    });
  }
  return entrances;
}

export function nearestEntrance(hero, entrances, reach = DOOR_REACH) {
  let best = null, bestDistance = reach * reach;
  for (const door of entrances) {
    const dx = hero.x - door.x, dz = hero.z - door.z, d = dx * dx + dz * dz;
    if (d <= bestDistance) { best = door; bestDistance = d; }
  }
  return best;
}

// Комнаты построены из общих частей: геометрия мебели и её коллайдеры
// используют одни и те же размеры. Дверь на южной стене — выход по кнопке.
export function makeInteriorLayout(kind) {
  if (kind !== 'home' && kind !== 'shop') throw new Error('Неизвестный интерьер: ' + kind);
  const props = kind === 'home' ? [
    { kind: 'sofa', x: -4.4, z: -0.8, hw: 0.75, hd: 1.65 },
    { kind: 'bed', x: -3.2, z: -4.25, hw: 1.45, hd: 1.0 },
    { kind: 'table', x: -1.9, z: -0.6, hw: 0.8, hd: 0.55 },
    { kind: 'kitchen', x: 2.4, z: -4.95, hw: 2.0, hd: 0.48 },
    { kind: 'cabinet', x: 5.05, z: -3.4, hw: 0.48, hd: 1.3 },
    // Настенный телевизор не занимает проход, в отличие от напольной мебели.
    { kind: 'television', x: 5.68, z: -0.8, hw: 0.10, hd: 0.85, solid: false },
    { kind: 'plant', x: 4.8, z: 4.8, hw: 0.35, hd: 0.35 },
  ] : [
    { kind: 'shelf', x: -3.45, z: -0.9, hw: 0.5, hd: 2.65 },
    { kind: 'shelf', x: 3.45, z: -0.9, hw: 0.5, hd: 2.65 },
    { kind: 'counter', x: 3.35, z: -4.65, hw: 1.75, hd: 0.5 },
    { kind: 'chiller', x: -3.55, z: -4.7, hw: 1.65, hd: 0.5 },
  ];
  const walls = [
    { kind: 'wall', x: -6, z: 0, hw: 0.15, hd: 6.15 },
    { kind: 'wall', x: 6, z: 0, hw: 0.15, hd: 6.15 },
    { kind: 'wall', x: 0, z: -6, hw: 6.15, hd: 0.15 },
    { kind: 'wall', x: 0, z: 6, hw: 6.15, hd: 0.15 },
  ];
  return {
    kind, width: 12, depth: 12, height: 3.45,
    spawn: { x: 0, z: 3.25, heading: -Math.PI / 2 },
    exit: { x: 0, z: 5.15 }, props,
    interactions: kind === 'home' ? makeHomeInteractions(props) : [
      // Перед свободным левым краем прилавка: полка не закрывает подход.
      { id: 'cashier', kind: 'shop', x: 1.80, z: -3.50, reach: 0.85, target: { x: 3.35, z: -4.65 } },
    ],
    walls, colliders: [...walls, ...props.filter(p => p.solid !== false)],
  };
}

export function makeInteriorHash(layout) { return buildSpatialHash(layout.colliders, 4); }
export function nearInteriorExit(hero, layout) {
  return Math.hypot(hero.x - layout.exit.x, hero.z - layout.exit.z) <= EXIT_REACH;
}

// При выходе сначала вернуть в точку входа; если её заняла машина (например,
// после смены модели в гараже), ищем свободное место рядом с тем же фасадом.
export function findReturnSpot(door, saved, hash, car, def, traffic) {
  const tries = [{ x: saved.x, z: saved.z }, { x: door.x, z: door.z }];
  for (const d of [1.5, 2.3, 3.5, 5, 7, 9]) {
    for (const side of [0, -1.4, 1.4, -3, 3, -5, 5]) {
      tries.push({ x: door.faceX + door.nx * d - door.nz * side,
        z: door.faceZ + door.nz * d + door.nx * side });
    }
  }
  const nearby = [];
  for (const p of tries) {
    hash.query(p.x, p.z, HERO_RADIUS + 0.1, nearby);
    if (circleVsAABBs(p.x, p.z, HERO_RADIUS, nearby)) continue;
    if (car && def && circleVsCar(p.x, p.z, HERO_RADIUS, car, def.length || 4.4, def.width || 1.9)) continue;
    if (traffic && traffic.cars.some(t => t.alive && !t.playerControlled &&
      circleVsCar(p.x, p.z, HERO_RADIUS, { x: t.x, z: t.z, heading: t.visHeading ?? t.heading },
        t.length || (t.half || 1) * 2 + 1.9, t.width || 1.9))) continue;
    return p;
  }
  return null;
}
