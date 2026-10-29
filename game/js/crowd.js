// Небольшой пул прохожих: ходят по тротуарам, разворачиваются перед дорогой
// и препятствиями. Для телефона число скелетов ограничено; мира за кадром не
// заполняем сотнями дорогих моделей. Далёкие прохожие пересоздаются у игрока.
import { circleVsAABBs, isOnRoad } from './city.js';
import { makeRng } from './rng.js';
const near = [];

export function makeCrowd(count = 4, seed = 8123) {
  return { rng: makeRng(seed), people: Array.from({ length: count }, (_, id) => ({ id, alive: false, speed: 0, y: 0.16 })) };
}
function isFree(city, hash, x, z) {
  if (isOnRoad(city, x, z)) return false;
  const lo = city.roadAt(0) + 5, hi = city.roadAt(city.grid) - 5;
  if (x < lo || x > hi || z < lo || z > hi) return false;
  hash.query(x, z, 0.5, near);
  return !circleVsAABBs(x, z, 0.48, near);
}
function place(crowd, person, city, hash, player) {
  const rng = crowd.rng;
  for (let i = 0; i < 80; i++) {
    const axis = rng() < 0.5 ? 'x' : 'z';
    const base = axis === 'x' ? player.z : player.x;
    const road = city.roadCenters.reduce((a, b) => Math.abs(a - base) <= Math.abs(b - base) ? a : b);
    const side = rng() < 0.5 ? -1 : 1;
    const along = (axis === 'x' ? player.x : player.z) + (rng() * 56 - 28);
    const lane = road + side * (city.road / 2 + 1.4);
    const x = axis === 'x' ? along : lane, z = axis === 'x' ? lane : along;
    const distance = Math.hypot(x - player.x, z - player.z);
    if (distance < 7 || distance > 38 || !isFree(city, hash, x, z)) continue;
    if (crowd.people.some(p => p !== person && p.alive && Math.hypot(p.x - x, p.z - z) < 4)) continue;
    Object.assign(person, { x, z, axis, dir: rng() < 0.5 ? -1 : 1, alive: true, speed: 1.15, pause: 0 });
    person.heading = axis === 'x' ? (person.dir > 0 ? 0 : Math.PI) : (person.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return true;
  }
  person.alive = false;
  return false;
}
export function stepCrowd(crowd, city, hash, player, dt) {
  dt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
  for (const p of crowd.people) {
    if (!p.alive || Math.hypot(p.x - player.x, p.z - player.z) > 65) {
      place(crowd, p, city, hash, player);
      continue;
    }
    if (p.pause > 0) { p.pause -= dt; p.speed = 0; continue; }
    const dx = p.axis === 'x' ? p.dir * 1.15 * dt : 0;
    const dz = p.axis === 'z' ? p.dir * 1.15 * dt : 0;
    // Запас по направлению движения останавливает модель до выхода на асфальт.
    if (!isFree(city, hash, p.x + dx * 3, p.z + dz * 3)) {
      p.dir *= -1; p.pause = 0.4; p.speed = 0;
    } else { p.x += dx; p.z += dz; p.speed = 1.15; }
    p.heading = p.axis === 'x' ? (p.dir > 0 ? 0 : Math.PI) : (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}
export function nearestCitizen(hero, crowd, reach = 1.6) {
  let result = null, distance = reach;
  for (const p of crowd?.people || []) {
    if (!p.alive) continue;
    const d = Math.hypot(hero.x - p.x, hero.z - p.z);
    if (d < distance) { result = p; distance = d; }
  }
  return result;
}
