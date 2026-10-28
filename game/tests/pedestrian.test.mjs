import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCity, buildSpatialHash, circleVsAABBs } from '../js/city.js';
import { CONFIG } from '../js/config.js';
import { makePedestrian, stepPedestrian, findExitSpot, canEnterCar, carIsStopped, circleVsCar, HERO_RADIUS, stopParkedCar } from '../js/pedestrian.js';

const city = generateCity(CONFIG.city);
const hash = buildSpatialHash(city.colliders, 30);
const def = { length: 4.4, width: 1.9 };
const car = { x: city.start.x, z: city.start.z, heading: city.start.heading, vx: 0, vz: 0 };
const emptyTraffic = { cars: [] };

function move(hero, input, n = 120, world = hash, activeCar = car) {
  for (let i = 0; i < n; i++) stepPedestrian(hero, input, 1 / 60, city, world, activeCar, def, emptyTraffic);
}

test('выход только из остановившейся машины, безопасное место рядом с кузовом', () => {
  assert.equal(carIsStopped(car), true);
  assert.equal(carIsStopped({ ...car, vx: 1 }), false);
  assert.equal(carIsStopped({ ...car, yawRate: 1 }), false);
  const spot = findExitSpot(car, def, hash, emptyTraffic);
  assert.ok(spot);
  assert.equal(canEnterCar(spot, car, def), true);
  assert.equal(circleVsCar(spot.x, spot.z, HERO_RADIUS, car, def.length, def.width), null);
  const items = []; hash.query(spot.x, spot.z, 1, items);
  assert.equal(circleVsAABBs(spot.x, spot.z, HERO_RADIUS, items), null);
  assert.equal(canEnterCar({ x: car.x + 50, z: car.z }, car, def), false);
});

test('если все выходы закрыты, вместо телепортации сквозь стену выдаётся null', () => {
  const blocked = buildSpatialHash([{ x: car.x, z: car.z, hw: 10, hd: 10 }], 30);
  assert.equal(findExitSpot(car, def, blocked, emptyTraffic), null);
});

test('ходьба, бег и направление стика относительно камеры', () => {
  const open = buildSpatialHash([], 30);
  const far = { x: -100, z: -100, heading: 0, vx: 0, vz: 0 };
  const h1 = makePedestrian(car.x + 10, car.z, 0);
  const h2 = makePedestrian(car.x + 10, car.z + 8, 0);
  h1.camYaw = h2.camYaw = 0;
  const start1 = h1.x, start2 = h2.x;
  move(h1, { x: 0, y: 1 }, 120, open, far); move(h2, { x: 0, y: 1, run: true }, 120, open, far);
  assert.ok(h1.x - start1 > 2 && h1.x - start1 < 4);
  assert.ok(h2.x - start2 > h1.x - start1 + 2);
  assert.equal(h2.running, true);
  const h3 = makePedestrian(car.x + 10, car.z + 16, 0); h3.camYaw = Math.PI / 2;
  const z = h3.z; move(h3, { x: 0, y: 1 }, 30, open, far);
  assert.ok(h3.z > z + 0.4);
});

test('стена и припаркованная машина не пропускают героя', () => {
  const wall = buildSpatialHash([{ x: 5, z: 0, hw: 0.5, hd: 5 }], 30);
  const farCar = { x: -50, z: -50, heading: 0, vx: 0, vz: 0 };
  const h = makePedestrian(3, 0, 0); h.camYaw = 0;
  move(h, { x: 0, y: 1, run: true }, 120, wall, farCar);
  assert.ok(h.x <= 5 - 0.5 - HERO_RADIUS + 0.01, `x=${h.x}`);
  const noWalls = buildSpatialHash([], 30);
  const parked = { x: 0, z: 0, heading: 0, vx: 0, vz: 0 };
  const h2 = makePedestrian(0, 3, 0); h2.camYaw = -Math.PI / 2;
  move(h2, { x: 0, y: 1, run: true }, 120, noWalls, parked);
  assert.ok(h2.z >= def.width / 2 + HERO_RADIUS - 0.01, `z=${h2.z}`);
});

test('машина после выхода не продолжает ехать', () => {
  const moving = { vx: .1, vz: .2, speed: 1, lateral: .2, slip: .3, yawRate: .1, drifting: true, handbrake: true };
  stopParkedCar(moving);
  assert.equal(moving.vx, 0); assert.equal(moving.vz, 0); assert.equal(moving.speed, 0);
  assert.equal(moving.drifting, false); assert.equal(moving.handbrake, false);
});

test('трафик реагирует и на героя, и на его припаркованную машину', async () => {
  const { makeTraffic, stepTraffic } = await import('../js/traffic.js');
  const make = () => {
    const t = makeTraffic(city, 1, 123);
    Object.assign(t.cars[0], { alive: true, axis: 'x', dir: 1, lane: city.start.z, s: city.start.x - 20,
      x: city.start.x - 20, z: city.start.z, heading: 0, visHeading: 0, speed: 10, cruise: 10,
      plan: { kind: 'straight', cross: 9999 } });
    return t;
  };
  const initialX = city.start.x - 20, z = city.start.z;
  const near = { x: initialX + 7, z, heading: 0 }, far = { x: initialX - 100, z, heading: 0 };
  const byHero = make(), byCar = make(), clear = make();
  stepTraffic(byHero, city, 0.05, CONFIG.traffic, near, far);
  stepTraffic(byCar, city, 0.05, CONFIG.traffic, far, near);
  stepTraffic(clear, city, 0.05, CONFIG.traffic, far, far);
  assert.ok(byHero.cars[0].speed < clear.cars[0].speed, 'машина не притормозила перед героем');
  assert.ok(byCar.cars[0].speed < clear.cars[0].speed, 'машина не притормозила перед припаркованной машиной');
});

test('пешком трафик переселяется к герою, а не остаётся у далёкой машины', async () => {
  const { makeTraffic, stepTraffic } = await import('../js/traffic.js');
  const t = makeTraffic(city, 1, 4242);
  const parked = { x: -220, z: city.start.z, heading: 0 }, hero = { x: 120, z: city.start.z, heading: 0 };
  Object.assign(t.cars[0], { alive: true, axis: 'x', dir: 1, lane: parked.z, s: parked.x,
    x: parked.x, z: parked.z, heading: 0, visHeading: 0, speed: 0, cruise: 0,
    plan: { kind: 'straight', cross: 9999 } });
  stepTraffic(t, city, 0.05, CONFIG.traffic, hero, parked);
  const moved = t.cars[0], d = Math.hypot(moved.x - hero.x, moved.z - hero.z);
  assert.ok(d < CONFIG.traffic.respawnDist && d >= 70, `трафик не появился вокруг героя: ${d}`);
  assert.ok(Math.hypot(moved.x - parked.x, moved.z - parked.z) >= 10);
});
