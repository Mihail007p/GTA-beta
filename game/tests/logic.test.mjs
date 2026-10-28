// Тесты чистой логики: город, коллизии, трафик, геймплей, сохранения.
// Запуск: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash, circleVsAABBs, isOnRoad } from '../js/city.js';
import { makeCarState, stepCar } from '../js/car-physics.js';
import { CARS, carById } from '../js/cars.js';
import { colliderOf, collideWorld, carCircles } from '../js/collision.js';
import { makeTraffic, scatterTraffic, stepTraffic, laneOffset } from '../js/traffic.js';
import { makeGameplay, updateGameplay, nearestCheckpoint } from '../js/gameplay.js';

const city = generateCity(CONFIG.city);
const hash = buildSpatialHash(city.colliders, 30);
const DT = CONFIG.physics.dt;

// ------------------------------------------------------------------ ГОРОД --
test('город детерминирован', () => {
  const b = generateCity(CONFIG.city);
  assert.equal(b.buildings.length, city.buildings.length);
  for (let i = 0; i < city.buildings.length; i += 37) {
    assert.equal(b.buildings[i].x, city.buildings[i].x);
    assert.equal(b.buildings[i].h, city.buildings[i].h);
  }
});

test('город: разумные объёмы для Helio G85', () => {
  assert.ok(city.innerBuildingCount > 300 && city.innerBuildingCount <= CONFIG.city.maxBuildings,
    `зданий внутри: ${city.innerBuildingCount}`);
  assert.ok(city.buildings.length < 1500, `всего зданий: ${city.buildings.length}`);
  assert.ok(city.trees.length > 20, `деревьев: ${city.trees.length}`);
  assert.ok(city.lamps.length > 100, `фонарей: ${city.lamps.length}`);
});

test('дома не вылезают на дорогу и тротуар', () => {
  const sw = city.sidewalk;
  for (const b of city.blocks) {
    if (b.type !== 'urban') continue;
    for (const h of city.buildings) {
      if (h.x < b.minX || h.x > b.maxX || h.z < b.minZ || h.z > b.maxZ) continue;
      assert.ok(h.x - h.hw >= b.minX + sw - 1e-6, 'дом залез на тротуар (запад)');
      assert.ok(h.x + h.hw <= b.maxX - sw + 1e-6, 'дом залез на тротуар (восток)');
      assert.ok(h.z - h.hd >= b.minZ + sw - 1e-6, 'дом залез на тротуар (север)');
      assert.ok(h.z + h.hd <= b.maxZ - sw + 1e-6, 'дом залез на тротуар (юг)');
    }
  }
});

test('дома не пересекаются друг с другом', () => {
  const B = city.buildings;
  let overlaps = 0;
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      if (Math.abs(a.x - b.x) < a.hw + b.hw - 0.01 && Math.abs(a.z - b.z) < a.hd + b.hd - 0.01) overlaps++;
    }
  }
  assert.equal(overlaps, 0);
});

test('старт игрока на дороге и свободен', () => {
  const s = city.start;
  assert.ok(isOnRoad(city, s.x, s.z), 'старт не на дороге');
  const cand = hash.query(s.x, s.z, 8);
  assert.equal(circleVsAABBs(s.x, s.z, 3.0, cand), null, 'старт внутри препятствия');
});

test('isOnRoad: оси дорог — да, центры кварталов — нет', () => {
  for (let i = 0; i <= city.grid; i++) {
    assert.ok(isOnRoad(city, city.roadAt(i), 0) || isOnRoad(city, city.roadAt(i), city.roadAt(3)));
    assert.ok(isOnRoad(city, city.roadAt(i), city.blockCenter(5)));
  }
  for (const b of city.blocks) {
    if (b.type === 'perimeter') continue;
    assert.equal(isOnRoad(city, b.cx, b.cz), false);
  }
});

test('фонари и деревья не стоят на проезжей части и в домах', () => {
  for (const l of city.lamps) assert.equal(isOnRoad(city, l.x, l.z), false, `фонарь на дороге ${l.x},${l.z}`);
  for (const t of city.trees) assert.equal(isOnRoad(city, t.x, t.z), false);
  const bh = buildSpatialHash(city.buildings, 30);
  for (const l of city.lamps) {
    assert.equal(circleVsAABBs(l.x, l.z, 0.2, bh.query(l.x, l.z, 2)), null, 'фонарь внутри дома');
  }
});

test('пространственный хэш совпадает с перебором', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < 300; n++) {
    const x = (rnd() - 0.5) * 760, z = (rnd() - 0.5) * 760, r = 1 + rnd() * 3;
    const fast = circleVsAABBs(x, z, r, hash.query(x, z, r + 1));
    const slow = circleVsAABBs(x, z, r, city.colliders);
    assert.equal(!!fast, !!slow, `расхождение в ${x},${z}`);
    if (fast) assert.ok(Math.abs(fast.depth - slow.depth) < 1e-9);
  }
});

// ------------------------------------------------------------- КОЛЛИЗИИ ----
function drive(def, x, z, heading, v0, seconds, input) {
  const car = makeCarState(def, x, z, heading);
  car.vx = Math.cos(heading) * v0; car.vz = Math.sin(heading) * v0;
  const col = colliderOf(def);
  let maxPen = 0, maxImpact = 0;
  const circles = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  for (let t = 0; t < seconds; t += DT) {
    stepCar(car, def, input, DT, { onRoad: isOnRoad(city, car.x, car.z) });
    const r = collideWorld(car, col, hash, def.physics);
    maxImpact = Math.max(maxImpact, r.impact);
    carCircles(car, col, circles);
    for (const c of circles) {
      const hit = circleVsAABBs(c.x, c.z, col.radius, hash.query(c.x, c.z, 4));
      if (hit) maxPen = Math.max(maxPen, hit.depth);
    }
  }
  return { car, maxPen, maxImpact };
}

test('лобовой удар в дом: без проникновения, скорость гасится', () => {
  const def = carById('feniks');
  // ищем дом и едем в него с запада
  const b = city.buildings.find(h => !h.perimeter && Math.abs(h.z) < 120 && h.hd > 6);
  const startX = b.x - b.hw - 25;
  const r = drive(def, startX, b.z, 0, 60, 2.0, { throttle: 1 });
  assert.ok(r.maxImpact > 20, `удар слишком слабый: ${r.maxImpact}`);
  assert.ok(r.maxPen < 0.05, `проникновение ${r.maxPen.toFixed(3)} м`);
  assert.ok(r.car.x < b.x - b.hw, 'машина прошла сквозь дом');
});

test('на максималке нельзя пробить столб или вылететь за край мира', () => {
  const def = carById('feniks');
  const lamp = city.lamps[40];
  const r1 = drive(def, lamp.x - 30, lamp.z, 0, 64, 1.5, { throttle: 1 });
  assert.ok(r1.car.x < lamp.x, 'туннелирование сквозь столб');
  // во все четыре стороны света в край мира
  for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const s = city.start;
    const r = drive(def, s.x, s.z, h, 64, 14, { throttle: 1 });
    const B = city.bounds;
    assert.ok(r.car.x > B.minX - 0.01 && r.car.x < B.maxX + 0.01 && r.car.z > B.minZ - 0.01 && r.car.z < B.maxZ + 0.01,
      `вылет за край при курсе ${h}: ${r.car.x.toFixed(1)}, ${r.car.z.toFixed(1)}`);
    assert.ok(Number.isFinite(r.car.x + r.car.z));
  }
});

test('скользящий удар о стену сохраняет большую часть скорости', () => {
  const def = carById('strada');
  // горизонтальная дорога, едем на восток под 12° к тротуару южной стороны
  const zRoad = city.roadAt(6);
  const car = makeCarState(def, city.roadAt(3) + 10, zRoad + 2, 0.21);
  car.vx = Math.cos(0.21) * 30; car.vz = Math.sin(0.21) * 30;
  const col = colliderOf(def);
  for (let t = 0; t < 1.5; t += DT) {
    stepCar(car, def, { throttle: 0 }, DT, { onRoad: true });
    collideWorld(car, col, hash, def.physics);
  }
  const v = Math.hypot(car.vx, car.vz);
  assert.ok(v > 15, `после касания осталось ${v.toFixed(1)} м/с`);
});

// --------------------------------------------------------------- ТРАФИК ----
function rightSideOk(c) {
  const roadC = c.lane - laneOffset(c.axis, c.dir, city.lane);
  const off = c.lane - roadC;
  // вектор «вправо» для курса: (-sin h, cos h)
  const h = c.heading;
  const rx = -Math.sin(h), rz = Math.cos(h);
  const offX = c.axis === 'z' ? off : 0, offZ = c.axis === 'x' ? off : 0;
  return offX * rx + offZ * rz > 3.0;
}

test('трафик: правостороннее движение, без телепортов, не покидает сетку', () => {
  const tr = makeTraffic(city, 16, 4242);
  const player = { x: city.start.x, z: city.start.z, heading: city.start.heading };
  scatterTraffic(tr, city, player, CONFIG.traffic);
  for (const c of tr.cars) {
    assert.ok(c.alive);
    assert.ok(rightSideOk(c), 'машина на встречной после спавна');
  }
  const lo = city.roadAt(0) - 8, hi = city.roadAt(city.grid) + 8;
  let turns = 0, teleports = 0, wrongSide = 0, stuckLong = 0;
  const prev = tr.cars.map(c => ({ x: c.x, z: c.z, axis: c.axis, spawn: c.spawnCount }));
  const stopped = new Array(tr.cars.length).fill(0);
  // игрок медленно катается по кругу, чтобы был и респавн
  for (let step = 0; step < 120 * 120; step++) {
    const t = step * DT;
    player.x = city.start.x + Math.cos(t * 0.05) * 150;
    player.z = city.start.z + Math.sin(t * 0.05) * 150;
    player.heading = t * 0.05 + Math.PI / 2;
    stepTraffic(tr, city, DT, CONFIG.traffic, player);
    tr.cars.forEach((c, i) => {
      const p = prev[i];
      if (c.spawnCount === p.spawn) {
        const jump = Math.hypot(c.x - p.x, c.z - p.z);
        if (jump > c.speed * DT + 0.05) teleports++;
        if (c.axis !== p.axis) turns++;
      }
      if (!rightSideOk(c)) wrongSide++;
      if (c.x < lo || c.x > hi || c.z < lo || c.z > hi) assert.fail('машина вне сетки');
      stopped[i] = c.speed < 0.3 ? stopped[i] + DT : 0;
      if (stopped[i] > 20) stuckLong++;
      p.x = c.x; p.z = c.z; p.axis = c.axis; p.spawn = c.spawnCount;
    });
  }
  assert.equal(teleports, 0, 'телепорты');
  assert.equal(wrongSide, 0, 'езда по встречке');
  assert.ok(turns > 20, `слишком мало поворотов: ${turns}`);
  assert.equal(stuckLong, 0, 'машины встали намертво (пробка/дедлок)');
});

test('трафик: машины одной полосы держат дистанцию', () => {
  const tr = makeTraffic(city, 16, 777);
  const player = { x: 0, z: 0, heading: 0 };
  scatterTraffic(tr, city, player, CONFIG.traffic);
  let tooClose = 0;
  for (let step = 0; step < 120 * 60; step++) {
    stepTraffic(tr, city, DT, CONFIG.traffic, player);
    const cs = tr.cars;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (a.axis === b.axis && a.dir === b.dir && Math.abs(a.lane - b.lane) < 0.5 && Math.abs(a.s - b.s) < 4.0) tooClose++;
    }
  }
  // допускаем мгновения на перекрёстке, когда одна машина только что повернула в полосу
  assert.ok(tooClose < 120, `сближений в полосе: ${tooClose}`);
});

// ------------------------------------------------------------- ГЕЙМПЛЕЙ ----
test('чекпоинты: на дороге, в кольце спавна, цепочка и таймер', () => {
  const G = CONFIG.gameplay;
  const g = makeGameplay(G, city, 99991, city.start);
  assert.equal(g.checkpoints.length, G.checkpointCount);
  for (const cp of g.checkpoints) {
    assert.ok(isOnRoad(city, cp.x, cp.z), 'чекпоинт не на дороге');
    const d = Math.hypot(cp.x - city.start.x, cp.z - city.start.z);
    assert.ok(d >= G.spawnMin * 0.8 - 1 && d <= G.spawnMax * 1.25 + 1, `дистанция чекпоинта ${d.toFixed(0)}`);
    assert.equal(circleVsAABBs(cp.x, cp.z, 1.5, hash.query(cp.x, cp.z, 4)), null, 'чекпоинт в препятствии');
  }
  // таймер не идёт без цепочки
  const car = makeCarState(CARS[0], city.start.x, city.start.z, 0);
  updateGameplay(g, 1.0, car, []);
  assert.equal(g.chain, 0);
  assert.equal(g.timeLeft, 0);

  // собираем три чекпоинта подряд
  for (let k = 0; k < 3; k++) {
    const n = nearestCheckpoint(g, car.x, car.z);
    car.x = n.cp.x; car.z = n.cp.z; g._lastX = car.x; g._lastZ = car.z;
    const out = updateGameplay(g, DT, car, []);
    assert.equal(out.collected.length, 1);
  }
  assert.equal(g.chain, 3);
  assert.equal(g.combo, 2);
  assert.equal(g.checkpoints.length, G.checkpointCount);
  assert.ok(g.timeLeft > G.checkpointTime);
  // не успеваем — цепочка рвётся, без game over
  let ended = false;
  for (let t = 0; t < G.maxChainTime + 2; t += 0.1) {
    const out = updateGameplay(g, 0.1, car, []);
    if (out.chainEnded) ended = true;
  }
  assert.ok(ended);
  assert.equal(g.chain, 0);
  assert.equal(g.combo, 1);
});

test('дрифт-серия: засчитывается после выхода и сгорает при ударе', () => {
  const G = CONFIG.gameplay;
  const g = makeGameplay(G, city, 5, city.start);
  const car = makeCarState(CARS[0], 0, 0, 0);
  car.vx = 20; car.drifting = true; car.slip = 0.5;
  for (let t = 0; t < 2; t += DT) updateGameplay(g, DT, car, []);
  car.drifting = false;
  let banked = 0;
  for (let t = 0; t < 1.5; t += DT) banked += updateGameplay(g, DT, car, []).driftBanked;
  assert.ok(banked > 100, `засчитано ${banked}`);

  car.drifting = true;
  for (let t = 0; t < 2; t += DT) updateGameplay(g, DT, car, []);
  const out = updateGameplay(g, DT, car, [], 12);
  assert.ok(out.driftLost);
  car.drifting = false;
  banked = 0;
  for (let t = 0; t < 1.5; t += DT) banked += updateGameplay(g, DT, car, []).driftBanked;
  assert.equal(banked, 0);
});

test('пролёт «на волоске» засчитывается только без касания', () => {
  const G = CONFIG.gameplay;
  for (const touched of [false, true]) {
    const g = makeGameplay(G, city, 6, city.start);
    const car = makeCarState(CARS[0], -30, 0, 0);
    car.vx = 30;
    const t = { alive: true, x: 0, z: 2.6, heading: Math.PI, speed: 8, _nearT: 0, _hitT: touched ? 2 : 0 };
    let total = 0;
    for (let k = 0; k < 240; k++) {
      car.x += car.vx * DT;
      t.x -= t.speed * DT;
      total += updateGameplay(g, DT, car, [t]).nearMiss;
    }
    assert.equal(total, touched ? 0 : 1, touched ? 'засчитан пролёт с касанием' : 'пролёт не засчитан');
  }
});

test('телепорт (сброс машины) не начисляет деньги за дистанцию', () => {
  const g = makeGameplay(CONFIG.gameplay, city, 7, city.start);
  const car = makeCarState(CARS[0], city.start.x, city.start.z, 0);
  updateGameplay(g, DT, car, []);
  car.x += 300;
  const out = updateGameplay(g, DT, car, []);
  assert.ok(out.money < 1);
});

// -------------------------------------------------------------- СОХРАНЕНИЯ --
test('сохранения: дефолты, деньги, битые данные', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  store.set('openstreet.save.v1', '{битый json');
  const S = await import('../js/save.js?' + Date.now());
  const s = S.loadSave();
  assert.equal(s.money, 0);
  assert.deepEqual(s.ownedCars, ['strada']);
  S.addMoney(150.555);
  S.flushNow();
  const raw = JSON.parse(store.get('openstreet.save.v1'));
  assert.equal(raw.money, 150.56);
});
