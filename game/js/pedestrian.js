// Пешее движение и безопасный вход/выход из СВОЕЙ машины. Чистая логика —
// не зависит от DOM/Three и проверяется отдельными тестами.
import { circleVsAABBs, isOnRoad } from './city.js';
import { dampAngle } from './car-physics.js';

export const HERO_RADIUS = 0.38;
export const WALK_SPEED = 1.75;  // м/с при полном отклонении стика
export const RUN_SPEED = 4.4;
export const MAX_EXIT_SPEED = 0.65; // м/с: нельзя выйти из движущейся машины
const candidates = [];

export function makePedestrian(x, z, heading) {
  return { x, z, heading, camYaw: heading, camPitch: 0.22, vx: 0, vz: 0,
    speed: 0, running: false, y: 0 };
}

/** Круг против повёрнутого прямоугольника; нормаль направлена от машины. */
export function circleVsCar(x, z, radius, car, length, width) {
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const dx = x - car.x, dz = z - car.z;
  const f = dx * c + dz * s, r = -dx * s + dz * c;
  const hit = circleVsAABBs(f, r, radius, [{ x: 0, z: 0, hw: length / 2, hd: width / 2 }]);
  if (!hit) return null;
  return { depth: hit.depth, nx: hit.nx * c - hit.nz * s, nz: hit.nx * s + hit.nz * c };
}

function blockedAt(x, z, hash, traffic) {
  hash.query(x, z, HERO_RADIUS + 0.1, candidates);
  if (circleVsAABBs(x, z, HERO_RADIUS, candidates)) return true;
  return !!(traffic && traffic.cars.some(c => c.alive &&
    circleVsCar(x, z, HERO_RADIUS + 0.25, { ...c, heading: c.visHeading ?? c.heading }, (c.half || 1) * 2 + 1.9, 1.9)));
}

/** Сначала водительская сторона; если она занята, ищем безопасное место вокруг. */
export function findExitSpot(car, def, hash, traffic) {
  const length = def.length || 4.4, width = def.width || 1.9;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const side = width / 2 + HERO_RADIUS + 0.32;
  for (const [f, r] of [[0.25, -side], [0.25, side], [-1, -side], [-1, side],
    [length / 2 + HERO_RADIUS + 0.35, 0], [-length / 2 - HERO_RADIUS - 0.35, 0]]) {
    const x = car.x + c * f - s * r, z = car.z + s * f + c * r;
    if (!blockedAt(x, z, hash, traffic) && !circleVsCar(x, z, HERO_RADIUS, car, length, width))
      return { x, z, heading: car.heading };
  }
  return null;
}

/** Сесть можно рядом с кузовом, не только с одной идеально точной точки. */
export function canEnterCar(hero, car, def) {
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  const dx = hero.x - car.x, dz = hero.z - car.z;
  const f = Math.abs(dx * c + dz * s), r = Math.abs(-dx * s + dz * c);
  const a = Math.max(0, f - (def.length || 4.4) / 2);
  const b = Math.max(0, r - (def.width || 1.9) / 2);
  return Math.hypot(a, b) <= 1.65;
}

export function carIsStopped(car) {
  return Math.hypot(car.vx, car.vz) <= MAX_EXIT_SPEED && Math.abs(car.yawRate || 0) <= 0.3;
}
export function stopParkedCar(car) {
  for (const key of ['vx', 'vz', 'speed', 'lateral', 'slip', 'yawRate', 'accelLong', 'accelLat', 'throttle', 'brake']) car[key] = 0;
  car.drifting = false; car.handbrake = false;
}

function resolve(hero, hit) {
  if (!hit) return false;
  hero.x += hit.nx * (hit.depth + 0.001);
  hero.z += hit.nz * (hit.depth + 0.001);
  const into = hero.vx * hit.nx + hero.vz * hit.nz;
  if (into < 0) { hero.vx -= into * hit.nx; hero.vz -= into * hit.nz; }
  return true;
}

/** Стик относительно камеры; ограниченные подшаги не дают проходить сквозь стены. */
export function stepPedestrian(hero, input, dt, city, hash, car, def, traffic) {
  dt = Math.max(0, Math.min(dt, 0.1));
  if (!dt) return;
  const sx = Math.max(-1, Math.min(1, input.x || 0));
  const sy = Math.max(-1, Math.min(1, input.y || 0)); // вперёд положительный
  const len = Math.hypot(sx, sy), strength = Math.min(1, len);
  const nx = len > 1e-5 ? sx / len : 0, ny = len > 1e-5 ? sy / len : 0;
  const c = Math.cos(hero.camYaw), s = Math.sin(hero.camYaw);
  const speed = (input.run ? RUN_SPEED : WALK_SPEED) * strength;
  const tx = (c * ny - s * nx) * speed, tz = (s * ny + c * nx) * speed;
  const beforeX = hero.x, beforeZ = hero.z;
  const steps = Math.ceil(dt / 0.025), h = dt / steps;
  for (let k = 0; k < steps; k++) {
    const a = 1 - Math.exp(-(strength ? 12 : 18) * h);
    hero.vx += (tx - hero.vx) * a; hero.vz += (tz - hero.vz) * a;
    hero.x += hero.vx * h; hero.z += hero.vz * h;
    // Несколько проходов помогают выйти из угла между домом и припаркованной машиной.
    for (let i = 0; i < 3; i++) {
      hash.query(hero.x, hero.z, HERO_RADIUS + 0.1, candidates);
      let hit = circleVsAABBs(hero.x, hero.z, HERO_RADIUS, candidates);
      if (hit) { resolve(hero, hit); continue; }
      hit = circleVsCar(hero.x, hero.z, HERO_RADIUS, car, def.length || 4.4, def.width || 1.9);
      if (hit) { resolve(hero, hit); continue; }
      if (traffic) {
        for (const t of traffic.cars) {
          if (!t.alive || Math.abs(t.x - hero.x) > 6 || Math.abs(t.z - hero.z) > 6) continue;
          const pose = { x: t.x, z: t.z, heading: t.visHeading ?? t.heading };
          hit = circleVsCar(hero.x, hero.z, HERO_RADIUS, pose, (t.half || 1) * 2 + 1.9, 1.9);
          if (hit) { resolve(hero, hit); break; }
        }
      }
      if (!hit) break;
    }
  }
  hero.speed = Math.min(RUN_SPEED, Math.hypot(hero.x - beforeX, hero.z - beforeZ) / dt);
  hero.running = !!input.run && hero.speed > 2.15;
  if (Math.hypot(hero.vx, hero.vz) > 0.08) hero.heading = dampAngle(hero.heading, Math.atan2(hero.vz, hero.vx), 12, dt);
  hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
}
