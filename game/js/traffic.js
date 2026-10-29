// ============================================================================
//  TRAFFIC — поток машин в городе.
//  ЧИСТАЯ ЛОГИКА (без THREE), тестируется в Node (tests/logic.test.mjs).
//
//  • Правостороннее движение по полосам сетки улиц.
//  • Поворот на перекрёстке выполняется в точке пересечения полос →
//    позиция непрерывна (никаких телепортов), курс плавно доворачивается.
//    Направо — по ближней полосе, налево — по дальней, как в жизни.
//  • Держат дистанцию до впереди идущей машины, тормозят перед игроком.
//  • Никогда не выезжают за сетку: на крайних перекрёстках обязательно поворот.
//  • Респавн — за спиной игрока или за пределом видимости, чтобы машины
//    не «возникали из воздуха» перед камерой.
// ============================================================================
import { trafficTypeIndex, trafficHalf } from './traffic-types.js';
import { makeRng } from './rng.js';

const TURN_SPEED = 6.5;       // м/с — скорость прохождения поворота
const PLAN_DIST = 26;         // м — за сколько до перекрёстка решаем, куда ехать

/** Смещение правой полосы от оси дороги для направления (axis, dir) */
export function laneOffset(axis, dir, lane) {
  return axis === 'z' ? -dir * lane : dir * lane;
}

export function headingFor(axis, dir) {
  if (axis === 'x') return dir > 0 ? 0 : Math.PI;
  return dir > 0 ? Math.PI / 2 : -Math.PI / 2;
}

export function makeTraffic(city, count, rngSeed) {
  const rng = makeRng(rngSeed || 4242);
  const cars = [];
  for (let i = 0; i < count; i++) {
    cars.push({
      id: i,
      x: 0, z: 0, s: 0, heading: 0, visHeading: 0,
      axis: 'x', dir: 1, lane: 0,
      speed: 0, targetSpeed: 10, cruise: 10,
      colorIdx: rng.int(0, 5),
      type: trafficTypeIndex(i),
      half: trafficHalf(trafficTypeIndex(i)),
      alive: false,
      plan: null,
      stunned: 0, yieldT: 0,
      _nearT: 0, _hitT: 0,
    });
  }
  return { cars, rng, lane: city.lane };
}

function roadIndexRange(city) {
  return { lo: city.roadAt(0), hi: city.roadAt(city.grid) };
}

/** Поставить машину на случайную точку дороги. Возвращает false, если место занято. */
function placeAt(c, city, axis, roadIdx, s, dir, cfg, rng) {
  c.axis = axis;
  c.dir = dir;
  c.lane = city.roadAt(roadIdx) + laneOffset(axis, dir, city.lane);
  c.s = s;
  c.cruise = cfg.speedMin + rng() * (cfg.speedMax - cfg.speedMin);
  c.targetSpeed = c.cruise;
  c.speed = c.cruise * 0.7;
  c.alive = true;
  c.plan = null;
  c.stunned = 0;
  c.yieldT = 0;
  c._nearT = 0;
  c._hitT = 0;
  c.spawnCount = (c.spawnCount || 0) + 1;
  syncPose(c);
  c.visHeading = c.heading;
}

function randomRoadPoint(city, rng) {
  const { lo, hi } = roadIndexRange(city);
  const axis = rng() < 0.5 ? 'x' : 'z';
  const roadIdx = rng.int(0, city.grid);
  // не ближе 9 м к крайним перекрёсткам, чтобы впереди всегда был перекрёсток
  const s = lo + 9 + rng() * (hi - lo - 18);
  const dir = rng() < 0.5 ? 1 : -1;
  return { axis, roadIdx, s, dir };
}

function poseOf(city, p) {
  const lane = city.roadAt(p.roadIdx) + laneOffset(p.axis, p.dir, city.lane);
  return p.axis === 'z' ? { x: lane, z: p.s } : { x: p.s, z: lane };
}

function spotIsFree(traffic, self, x, z, minD) {
  for (const o of traffic.cars) {
    if (o === self || !o.alive) continue;
    const dx = o.x - x, dz = o.z - z;
    if (dx * dx + dz * dz < minD * minD) return false;
  }
  return true;
}

/**
 * Найти точку респавна: в кольце [minR, maxR] от игрока, вне конуса обзора
 * камеры (или достаточно далеко, в тумане), не впритык к другим машинам.
 */
function respawn(traffic, c, city, player, cfg, minR, maxR, parkedCar = null) {
  const rng = traffic.rng;
  const fx = Math.cos(player.heading || 0), fz = Math.sin(player.heading || 0);
  let fallback = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const p = randomRoadPoint(city, rng);
    const pos = poseOf(city, p);
    const dx = pos.x - player.x, dz = pos.z - player.z;
    const d = Math.hypot(dx, dz);
    if (d < minR || d > maxR) continue;
    if (parkedCar && Math.hypot(pos.x - parkedCar.x, pos.z - parkedCar.z) < 10) continue;
    if (!spotIsFree(traffic, c, pos.x, pos.z, 12)) continue;
    const cosA = (dx * fx + dz * fz) / Math.max(d, 1e-6);
    fallback = p;
    // за спиной/сбоку — всегда можно; впереди — только далеко (в тумане)
    if (cosA < 0.35 || d > maxR * 0.85) {
      placeAt(c, city, p.axis, p.roadIdx, p.s, p.dir, cfg, rng);
      return true;
    }
  }
  if (fallback) {
    placeAt(c, city, fallback.axis, fallback.roadIdx, fallback.s, fallback.dir, cfg, rng);
    return true;
  }
  return false;
}

/** Расставить трафик вокруг игрока на старте */
export function scatterTraffic(traffic, city, player, cfg) {
  for (const c of traffic.cars) {
    c.alive = false;
    c.playerControlled = false;
    c.parked = false;
  }
  for (const c of traffic.cars) {
    // на старте можно и впереди, но не вплотную к игроку
    const rng = traffic.rng;
    let placed = false;
    for (let attempt = 0; attempt < 60 && !placed; attempt++) {
      const p = randomRoadPoint(city, rng);
      const pos = poseOf(city, p);
      const d = Math.hypot(pos.x - player.x, pos.z - player.z);
      if (d < 30 || d > cfg.respawnDist * 0.85) continue;
      if (!spotIsFree(traffic, c, pos.x, pos.z, 14)) continue;
      placeAt(c, city, p.axis, p.roadIdx, p.s, p.dir, cfg, rng);
      placed = true;
    }
    if (!placed) respawn(traffic, c, city, player, cfg, 30, cfg.respawnDist * 0.85);
  }
}

export function syncPose(c) {
  if (c.axis === 'z') { c.x = c.lane; c.z = c.s; }
  else { c.x = c.s; c.z = c.lane; }
  c.heading = headingFor(c.axis, c.dir);
}

/** Центр дороги, по которой едет машина */
function currentRoadCenter(c, city) {
  return c.lane - laneOffset(c.axis, c.dir, city.lane);
}

/** Ближайший перекрёсток впереди (центр поперечной дороги) или null */
function nextCross(c, city) {
  const lo = city.roadAt(0);
  const margin = city.road / 2 + 1;   // перекрёсток, в котором уже стоим, не считается
  if (c.dir > 0) {
    const k = Math.ceil((c.s + margin - lo) / city.pitch);
    if (k > city.grid) return null;
    return lo + Math.max(0, k) * city.pitch;
  }
  const k = Math.floor((c.s - margin - lo) / city.pitch);
  if (k < 0) return null;
  return lo + Math.min(city.grid, k) * city.pitch;
}

function inGrid(v, city) {
  const { lo, hi } = roadIndexRange(city);
  return v >= lo - 0.5 && v <= hi + 0.5;
}

/** Решение на перекрёстке: прямо / направо / налево (с учётом края карты) */
function planAt(c, city, rc, rng) {
  const roadC = currentRoadCenter(c, city);
  const options = [];
  // прямо — только если за перекрёстком есть ещё квартал
  if (inGrid(rc + c.dir * city.pitch, city)) options.push({ kind: 'straight', w: 0.56 });
  // направо / налево
  for (const side of ['right', 'left']) {
    let newAxis, newDir;
    if (side === 'right') {
      if (c.axis === 'x') { newAxis = 'z'; newDir = c.dir; } else { newAxis = 'x'; newDir = -c.dir; }
    } else {
      if (c.axis === 'x') { newAxis = 'z'; newDir = -c.dir; } else { newAxis = 'x'; newDir = c.dir; }
    }
    // после поворота должно быть куда ехать
    if (!inGrid(roadC + newDir * city.pitch, city)) continue;
    const newLane = rc + laneOffset(newAxis, newDir, city.lane);
    options.push({ kind: 'turn', side, newAxis, newDir, newLane, sTurn: newLane, w: 0.22 });
  }
  let total = 0;
  for (const o of options) total += o.w;
  let r = rng() * total;
  let pick = options[options.length - 1];
  for (const o of options) { r -= o.w; if (r <= 0) { pick = o; break; } }
  return Object.assign({ cross: rc }, pick);
}

/**
 * Шаг симуляции трафика.
 * player: {x, z, heading} — фокус респавна и препятствие для трафика.
 * parkedCar: дополнительное препятствие, когда игрок гуляет пешком.
 */
export function stepTraffic(traffic, city, dt, cfg, player, parkedCar = null) {
  const cars = traffic.cars;
  const rng = traffic.rng;
  const obstacles = parkedCar ? [player, parkedCar] : [player];

  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.alive || c.playerControlled) continue;
    if (c.parked) {
      // Оставленные угнанные авто остаются рядом; вдали могут снова стать
      // обычным трафиком, чтобы не накапливать объекты и не опустошать город.
      const d2 = (c.x - player.x) ** 2 + (c.z - player.z) ** 2;
      if (!c.noRender && d2 > cfg.respawnDist ** 2 &&
          respawn(traffic, c, city, player, cfg, 70, cfg.respawnDist * 0.92, parkedCar)) c.parked = false;
      continue;
    }

    // --- целевая скорость ------------------------------------------------
    let target = c.cruise;
    if (c.stunned > 0) {
      c.stunned -= dt;
      target = 0;
    }

    // Реагируем и на героя, и на оставленную им машину. Когда игрок за
    // рулём, второй объект отсутствует — прежнее поведение не меняется.
    const fwdX = Math.cos(c.heading), fwdZ = Math.sin(c.heading);
    const avoid = obstacle => {
      const pdx = obstacle.x - c.x, pdz = obstacle.z - c.z;
      const pd2 = pdx * pdx + pdz * pdz;
      if (pd2 >= cfg.avoidDist * cfg.avoidDist) return;
      const ahead = pdx * fwdX + pdz * fwdZ;
      const side = Math.abs(-pdx * fwdZ + pdz * fwdX);
      if (ahead > 0 && side < 3.2) {
        target = Math.min(target, Math.max(0, (ahead - 6) * 0.6));
        // Водитель даёт пешеходу время подойти к двери после остановки,
        // а не трогается в ту же секунду, как тот вышел из полосы.
        if (obstacle === player && player.camYaw !== undefined && ahead < 10) c.yieldT = 4;
      }
    };
    for (const obstacle of obstacles) avoid(obstacle);
    for (const obstacle of cars) {
      if (obstacle !== c && obstacle.alive && (obstacle.parked || obstacle.playerControlled)) avoid(obstacle);
    }
    if (c.yieldT > 0) { c.yieldT -= dt; target = 0; }

    // дистанция до машины впереди в той же полосе
    for (let j = 0; j < cars.length; j++) {
      if (j === i) continue;
      const o = cars[j];
      if (!o.alive || o.parked || o.playerControlled || o.axis !== c.axis || o.dir !== c.dir) continue;
      if (Math.abs(o.lane - c.lane) > 1.2) continue;
      const gap = (o.s - c.s) * c.dir;
      if (gap <= 0 || gap > 16) continue;
      if (gap < 7) target = 0;
      else target = Math.min(target, o.speed + (gap - 9) * 0.5);
    }

    // --- план на перекрёстке ---------------------------------------------
    if (!c.plan) {
      const rc = nextCross(c, city);
      if (rc !== null && (rc - c.s) * c.dir < PLAN_DIST) c.plan = planAt(c, city, rc, rng);
    }
    if (c.plan && c.plan.kind === 'turn') {
      const toTurn = (c.plan.sTurn - c.s) * c.dir;
      if (toTurn < 18) target = Math.min(target, TURN_SPEED + Math.max(0, toTurn) * 0.45);
    }

    target = Math.max(0, target);
    const rate = target < c.speed ? 4.0 : 1.6;     // тормозят резче, чем разгоняются
    c.speed += (target - c.speed) * Math.min(1, rate * dt);
    if (c.speed < 0.02 && target === 0) c.speed = 0;

    // --- движение --------------------------------------------------------
    const prevS = c.s;
    c.s += c.speed * dt * c.dir;

    if (c.plan) {
      if (c.plan.kind === 'turn') {
        const crossed = (prevS - c.plan.sTurn) * (c.s - c.plan.sTurn) <= 0;
        if (crossed) {
          const overshoot = Math.abs(c.s - c.plan.sTurn);
          const newS = c.lane + c.plan.newDir * overshoot;
          c.axis = c.plan.newAxis;
          c.dir = c.plan.newDir;
          c.lane = c.plan.newLane;
          c.s = newS;
          c.plan = null;
        }
      } else if ((c.s - c.plan.cross) * c.dir > city.road / 2 + 1) {
        c.plan = null;   // проехали перекрёсток прямо
      }
    }

    syncPose(c);
    // плавный доворот кузова на поворотах (визуально)
    let dh = c.heading - c.visHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    c.visHeading += dh * Math.min(1, 7.5 * dt);

    if (c._hitT > 0) c._hitT -= dt;

    // --- респавн, если уехали далеко от игрока / вышли за сетку ------------
    const rdx = c.x - player.x, rdz = c.z - player.z;
    const out = !inGrid(c.s, city);
    if (out || rdx * rdx + rdz * rdz > cfg.respawnDist * cfg.respawnDist) {
      respawn(traffic, c, city, player, cfg, 70, cfg.respawnDist * 0.92, parkedCar);
    }
  }
  return cars;
}

/**
 * Столкновения игрока с трафиком. Машины трафика — капсулы из двух кругов,
 * игрок — тоже (centers: массив {x,z} центров кругов игрока).
 * Возвращает список [{car, nx, nz, depth}] — нормаль от трафика к игроку.
 */
export function trafficCollisions(traffic, centers, playerRadius, out) {
  const res = out || [];
  res.length = 0;
  const cars = traffic.cars;
  const half0 = 1.0;        // смещение кругов от центра вдоль кузова (по умолчанию)
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.alive || c.playerControlled) continue;
    const rSum = playerRadius + (c.radius || 0.95);
    // быстрый отсев
    const qx = centers[0].x - c.x, qz = centers[0].z - c.z;
    if (qx * qx + qz * qz > 64) continue;
    const fx = Math.cos(c.visHeading), fz = Math.sin(c.visHeading);
    const half = c.half || half0;
    let best = null;
    for (let a = 0; a < 2; a++) {
      const tx = c.x + fx * (a === 0 ? half : -half);
      const tz = c.z + fz * (a === 0 ? half : -half);
      for (let p = 0; p < centers.length; p++) {
        const dx = centers[p].x - tx, dz = centers[p].z - tz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rSum * rSum || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const depth = rSum - d;
        if (!best || depth > best.depth) best = { car: c, nx: dx / d, nz: dz / d, depth };
      }
    }
    if (best) res.push(best);
  }
  return res;
}

/** Реакция машины трафика на удар игрока: встаёт и чуть сдвигается по полосе */
export function knockTraffic(c, nx, nz, impact) {
  // Припаркованную машину не привязываем обратно к старой полосе трафика.
  if (c.parked) { c._hitT = 2.0; return; }
  c.stunned = Math.max(c.stunned, 1.2 + Math.min(2.5, impact * 0.12));
  c.speed *= 0.3;
  c._hitT = 2.0;
  // толчок вдоль своей оси (поперёк полосы машина не сдвигается — она «на рельсах»)
  const along = c.axis === 'z' ? -nz : -nx;
  c.s += along * Math.min(1.2, impact * 0.05);
  syncPose(c);
}
