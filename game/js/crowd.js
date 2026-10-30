// Небольшой пул прохожих: обычная прогулка по тротуару и лёгкая процедурная
// реакция на наезд. На телефоне держим прежний лимит скелетов.
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
    Object.assign(person, { x, z, axis, dir: rng() < 0.5 ? -1 : 1, alive: true, speed: 1.15, pause: 0,
      condition: 'walk', fall: 0, fatal: false, hitAge: 0, needsPath: false, y: 0.16 });
    person.heading = axis === 'x' ? (person.dir > 0 ? 0 : Math.PI) : (person.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return true;
  }
  person.alive = false;
  return false;
}

function clearOfWorld(hash, x, z) {
  hash.query(x, z, 0.5, near);
  return !circleVsAABBs(x, z, 0.42, near);
}
// Если после удара человек лежал на дороге, ищем рядом достижимый тротуар;
// он дойдёт до него пешком, а не телепортируется сквозь машину или здание.
function findSidewalk(person, city, hash) {
  let best = null;
  for (let radius = 1; radius <= 14 && !best; radius += 1) {
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const x = person.x + Math.cos(a) * radius, z = person.z + Math.sin(a) * radius;
      if (!isFree(city, hash, x, z)) continue;
      let clear = true;
      for (let t = 0.1; t < 1; t += 0.1) {
        if (!clearOfWorld(hash, person.x + (x - person.x) * t, person.z + (z - person.z) * t)) { clear = false; break; }
      }
      if (clear) { best = { x, z }; break; }
    }
  }
  return best;
}

function stepHit(person, city, hash, dt) {
  person.hitAge += dt;
  const steps = Math.max(1, Math.ceil(Math.hypot(person.hitVx || 0, person.hitVz || 0) * dt / 0.3));
  for (let i = 0; i < steps; i++) {
    const h = dt / steps;
    person.x += (person.hitVx || 0) * h; person.z += (person.hitVz || 0) * h;
    hash.query(person.x, person.z, 0.5, near);
    const hit = circleVsAABBs(person.x, person.z, 0.38, near);
    if (hit) {
      person.x += hit.nx * (hit.depth + 0.001); person.z += hit.nz * (hit.depth + 0.001);
      const into = person.hitVx * hit.nx + person.hitVz * hit.nz;
      if (into < 0) { person.hitVx -= into * hit.nx; person.hitVz -= into * hit.nz; }
    }
    const drag = Math.exp(-2.1 * h); person.hitVx *= drag; person.hitVz *= drag;
  }
  const ground = isOnRoad(city, person.x, person.z) ? 0 : 0.16;
  const air = Math.sin(Math.PI * Math.min(1, person.hitAge / 0.9)) * (person.hitHeight || 0);
  person.y = ground + air;
  // Падение и вставание — плавное вращение всей модели, не ragdoll.
  const down = Math.min(1, person.hitAge / 0.32);
  person.fall = person.fatal ? down : down * Math.min(1, Math.max(0, (4.6 - person.hitAge) / 0.8));
  if (person.fatal && person.hitAge >= 20) { person.alive = false; return; }
  if (!person.fatal && person.hitAge >= 4.6) {
    person.fall = 0; person.fatal = false; person.hitVx = person.hitVz = 0;
    if (isFree(city, hash, person.x, person.z)) {
      person.condition = 'walk'; person.pause = 0.5;
    } else {
      const point = findSidewalk(person, city, hash);
      if (point) { person.condition = 'return'; person.returnPoint = point; }
      else { person.alive = false; }
    }
  }
}

export function stepCrowd(crowd, city, hash, player, dt) {
  dt = Math.max(0, Math.min(Number.isFinite(dt) ? dt : 0, 0.1));
  for (const p of crowd.people) {
    // Таксисту выделяется один экземпляр из того же пула — без лишнего скелета.
    if (p.condition === 'taxi-wait' || p.condition === 'taxi-board' || p.condition === 'taxi-seat') continue;
    if (p.condition === 'taxi-exit') {
      p.exitAge = Math.min(1, p.exitAge + dt);
      const t = p.exitAge;
      p.x = p.exitX + (p.exitTarget.x - p.exitX) * t;
      p.z = p.exitZ + (p.exitTarget.z - p.exitZ) * t;
      p.y = (p.exitTarget.y ?? 0.16) * t + p.exitY * (1 - t); p.speed = 1.1;
      p.heading = Math.atan2(p.exitTarget.z - p.exitZ, p.exitTarget.x - p.exitX);
      if (t >= 1) {
        p.speed = 0; p.fall = 0;
        if (isFree(city, hash, p.x, p.z)) { p.condition = 'walk'; p.pause = 0.5; }
        else {
          const point = findSidewalk(p, city, hash);
          if (point) { p.condition = 'return'; p.returnPoint = point; } else p.alive = false;
        }
      }
      continue;
    }
    if (!p.alive || Math.hypot(p.x - player.x, p.z - player.z) > 65) {
      place(crowd, p, city, hash, player);
      continue;
    }
    if (p.condition === 'injured' || p.condition === 'dead') { stepHit(p, city, hash, dt); continue; }
    if (p.needsPath) {
      p.needsPath = false;
      for (let i = 0; i < 3; i++) {
        hash.query(p.x, p.z, 0.5, near);
        const hit = circleVsAABBs(p.x, p.z, 0.38, near);
        if (!hit) break;
        p.x += hit.nx * (hit.depth + 0.001); p.z += hit.nz * (hit.depth + 0.001);
      }
      if (p.condition === 'return' || !isFree(city, hash, p.x, p.z)) {
        const point = findSidewalk(p, city, hash);
        if (point) { p.condition = 'return'; p.returnPoint = point; }
        else { p.alive = false; continue; }
      }
    }
    if (p.condition === 'return') {
      const dx = p.returnPoint.x - p.x, dz = p.returnPoint.z - p.z, dist = Math.hypot(dx, dz);
      if (dist < 0.15) { p.condition = 'walk'; p.pause = 0.5; p.speed = 0; continue; }
      const move = Math.min(dist, 1.15 * dt);
      p.x += dx / dist * move; p.z += dz / dist * move;
      p.y = isOnRoad(city, p.x, p.z) ? 0 : 0.16;
      p.heading = Math.atan2(dz, dx); p.speed = 1.15;
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
    if (!p.alive || p.condition !== 'walk') continue;
    const d = Math.hypot(hero.x - p.x, hero.z - p.z);
    if (d < distance) { result = p; distance = d; }
  }
  return result;
}
