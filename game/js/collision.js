// ============================================================================
//  COLLISION — столкновения машины игрока с миром и трафиком.
//  ЧИСТАЯ ЛОГИКА (тестируется в Node).
//
//  Машина = капсула из двух кругов (нос и корма). Один круг давал бы
//  «утопание» носа в стене на ~1 м при лобовом ударе.
// ============================================================================
import { circleVsAABBs } from './city.js';
import { resolveCollision } from './car-physics.js';
import { trafficCollisions, knockTraffic } from './traffic.js';

const _cand = [];
const _tHits = [];

/** Параметры коллайдера машины из её описания */
export function colliderOf(def) {
  const radius = def.width ? def.width / 2 : 0.95;
  const offset = Math.max(0.4, (def.length || 4.4) / 2 - radius);
  return { radius, offset };
}

/** Центры двух кругов машины (пишет в out[0], out[1]) */
export function carCircles(car, col, out) {
  const fx = Math.cos(car.heading), fz = Math.sin(car.heading);
  out[0].x = car.x + fx * col.offset; out[0].z = car.z + fz * col.offset;
  out[1].x = car.x - fx * col.offset; out[1].z = car.z - fz * col.offset;
  return out;
}

const _centers = [{ x: 0, z: 0 }, { x: 0, z: 0 }];

/**
 * Столкновения со статикой (дома, деревья, столбы, стены мира).
 * Возвращает {impact, kind} самого сильного удара за шаг.
 */
export function collideWorld(car, col, hash, physics) {
  let maxImpact = 0, kind = null;
  for (let iter = 0; iter < 3; iter++) {
    hash.query(car.x, car.z, col.offset + col.radius + 1, _cand);
    if (!_cand.length) break;
    let any = false;
    for (let k = 0; k < 2; k++) {
      carCircles(car, col, _centers);
      const c = _centers[k];
      const hit = circleVsAABBs(c.x, c.z, col.radius, _cand);
      if (!hit) continue;
      any = true;
      const rx = c.x - car.x, rz = c.z - car.z;
      const imp = resolveCollision(car, hit, physics, rx, rz);
      if (imp > maxImpact) { maxImpact = imp; kind = hit.item.kind; }
    }
    if (!any) break;
  }
  return { impact: maxImpact, kind };
}

/**
 * Столкновения с трафиком. Трафик «тяжёлый»: игрок отскакивает,
 * машина трафика встаёт. Возвращает самый сильный удар.
 */
export function collideTraffic(car, col, traffic, physics) {
  carCircles(car, col, _centers);
  trafficCollisions(traffic, _centers, col.radius, _tHits);
  let maxImpact = 0;
  for (const h of _tHits) {
    // точка контакта ≈ ближайший к машине трафика круг игрока
    const d0 = (_centers[0].x - h.car.x) ** 2 + (_centers[0].z - h.car.z) ** 2;
    const d1 = (_centers[1].x - h.car.x) ** 2 + (_centers[1].z - h.car.z) ** 2;
    const c = d0 < d1 ? _centers[0] : _centers[1];
    // удар считаем по относительной скорости
    const tvx = Math.cos(h.car.visHeading) * h.car.speed;
    const tvz = Math.sin(h.car.visHeading) * h.car.speed;
    car.vx -= tvx; car.vz -= tvz;
    const imp = resolveCollision(car, h, physics, c.x - car.x, c.z - car.z);
    car.vx += tvx; car.vz += tvz;
    if (imp > 0.5) knockTraffic(h.car, h.nx, h.nz, imp);
    else h.car._hitT = Math.max(h.car._hitT, 1.0);
    if (imp > maxImpact) maxImpact = imp;
  }
  return maxImpact;
}
