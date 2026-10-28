import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash } from '../js/city.js';
import { carById } from '../js/cars.js';
import { makeCarState, stepCar } from '../js/car-physics.js';
import { makeTraffic, scatterTraffic, stepTraffic, trafficCollisions, knockTraffic } from '../js/traffic.js';
import { makeGameplay, updateGameplay } from '../js/gameplay.js';
import { makePedestrian, stepPedestrian, findExitSpot, circleVsCar, HERO_RADIUS } from '../js/pedestrian.js';
import { VehicleWorld, TRAFFIC_VEHICLES, MAX_HIJACK_SPEED } from '../js/vehicles.js';

const city = generateCity(CONFIG.city);
const hash = buildSpatialHash(city.colliders, 30);
const open = buildSpatialHash([], 30);

function setup(count = 3) {
  const ownDef = carById('strada');
  const own = makeCarState(ownDef, 0, 0, 0);
  const traffic = makeTraffic(city, count, 123);
  for (let i = 0; i < count; i++) Object.assign(traffic.cars[i], {
    alive: true, x: 20 + i * 20, z: 0, s: 20 + i * 20,
    axis: 'x', dir: 1, lane: 0, heading: 0, visHeading: 0,
    speed: 0, cruise: 0, plan: { kind: 'straight', cross: 9999 },
  });
  const world = new VehicleWorld(traffic, own, ownDef);
  return { world, own, ownDef, traffic };
}
const near = c => ({ x: c.x, z: c.z + 2.4, heading: 0 });

function steal(world, ref) {
  const target = world.nearest(near(ref));
  assert.equal(target?.ref, ref);
  const result = world.enter(target);
  assert.equal(result.ok, true);
  return result;
}

test('герой начинает рядом с собственной машиной, в безопасной точке', () => {
  const d = carById('strada'), own = makeCarState(d, city.start.x, city.start.z, city.start.heading);
  const traffic = makeTraffic(city, CONFIG.traffic.count, 4242);
  scatterTraffic(traffic, city, own, CONFIG.traffic);
  const spot = findExitSpot(own, d, hash, traffic);
  assert.ok(spot);
  assert.equal(circleVsCar(spot.x, spot.z, HERO_RADIUS, own, d.length, d.width), null);
  assert.ok(Math.hypot(spot.x - own.x, spot.z - own.z) < 4);
});

test('все восемь моделей трафика имеют работающую автомобильную физику', () => {
  assert.equal(TRAFFIC_VEHICLES.length, 8);
  for (const def of TRAFFIC_VEHICLES) {
    const car = makeCarState(def, 0, 0, 0);
    for (let i = 0; i < 120; i++) stepCar(car, def, { throttle: 1 }, 1 / 120, { onRoad: true });
    assert.ok(Number.isFinite(car.x) && car.x > 1 && car.speed > 1, def.name);
    assert.ok(def.length > 4 && def.width > 1.5, def.name);
  }
});

test('угон сохраняет модель и цвет, оставляет свою машину с коллизией и не сталкивает авто с собой', () => {
  const { world, own, ownDef, traffic } = setup();
  const ref = traffic.cars[0], color = ref.colorIdx, type = ref.type;
  const result = steal(world, ref);
  assert.equal(result.occupied, true);
  assert.equal(ref.colorIdx, color); assert.equal(ref.type, type);
  assert.equal(ref.playerControlled, true);
  assert.equal(world.own.car, own);
  assert.equal(world.own.def, ownDef);
  assert.ok(world.ownProxy && world.ownProxy.noRender && world.ownProxy.parked);
  const self = trafficCollisions({ cars: [ref] }, [{ x: ref.x, z: ref.z }], 0.95);
  assert.equal(self.length, 0, 'активная машина не должна сталкиваться сама с собой');
  const hit = trafficCollisions(traffic, [{ x: own.x + 1.1, z: own.z }], 0.95);
  assert.ok(hit.some(h => h.car === world.ownProxy), 'столкновение с оставленной своей машиной');
  const before = [own.x, own.z, world.ownProxy.x, world.ownProxy.z];
  knockTraffic(world.ownProxy, 1, 0, 20);
  assert.deepEqual([own.x, own.z, world.ownProxy.x, world.ownProxy.z], before);
  const spot = findExitSpot(world.current.car, world.current.def, open, traffic, ref);
  assert.ok(spot, 'выход не должен блокироваться собственным инстансом');
});

test('припаркованные угнанные машины и собственная машина остаются доступны при смене', () => {
  const { world, own, traffic } = setup();
  const first = traffic.cars[0], second = traffic.cars[1];
  assert.equal(steal(world, first).occupied, true);
  const firstCar = world.current.car;
  const stats = firstCar.stats;
  firstCar.x += 5; firstCar.z += 2; firstCar.heading = 0.7;
  world.sync();
  assert.equal(steal(world, second).occupied, true);
  assert.equal(first.parked, true); assert.equal(first.playerControlled, false);
  assert.equal(world.current.car.stats, stats);
  const oldPosition = [first.x, first.z];
  stepTraffic(traffic, city, 0.05, CONFIG.traffic, { x: first.x, z: first.z, heading: 0 });
  assert.deepEqual([first.x, first.z], oldPosition, 'припаркованный автомобиль не должен уехать');
  assert.equal(steal(world, first).occupied, false, 'в пустой автомобиль садимся без нового водителя');
  assert.equal(world.current.car, firstCar);
  assert.equal(second.parked, true);
  const targetOwn = world.nearest(near(own));
  assert.equal(targetOwn.ref, null);
  assert.equal(world.enter(targetOwn).ok, true);
  assert.equal(world.current.car, own);
  assert.equal(world.ownProxy, null);
  assert.equal(world.current.car.stats, stats);
});

test('быструю машину нельзя мгновенно угнать: водитель тормозит, затем возможен угон', () => {
  const { world, traffic } = setup();
  const ref = traffic.cars[0];
  ref.speed = MAX_HIJACK_SPEED + 2;
  const target = world.nearest(near(ref));
  const result = world.enter(target);
  assert.deepEqual(result, { ok: false, reason: 'too-fast' });
  assert.ok(ref.stunned > 0);
  assert.equal(world.current, world.own);
  ref.speed = 0;
  assert.equal(world.enter(world.nearest(near(ref))).occupied, true);
});

test('гараж меняет только собственную машину, а активный угнанный автомобиль не пропадает', () => {
  const { world, own, traffic } = setup();
  const ref = traffic.cars[0]; steal(world, ref);
  const stolen = world.current.car, def = carById('vektor');
  world.setOwnedDef(def);
  assert.equal(world.current.car, stolen);
  assert.equal(world.own.car, own);
  assert.equal(world.own.def, def);
  assert.equal(world.ownProxy.length, def.length);
  assert.equal(world.enter(world.nearest(near(own))).ok, true);
  assert.equal(world.current.def, def);
  assert.equal(ref.parked, true);
});

test('герой не проходит сквозь оставленную собственную машину', () => {
  const { world, traffic } = setup();
  steal(world, traffic.cars[0]);
  const hero = makePedestrian(0, 3, -Math.PI / 2);
  for (let i = 0; i < 150; i++) stepPedestrian(hero, { x: 0, y: 1, run: true }, 1 / 60, city, open, world.current.car, world.current.def, traffic);
  assert.ok(hero.z >= world.own.def.width / 2 + HERO_RADIUS - 0.01, `z=${hero.z}`);
});

test('управляемая машина не переселяется как трафик; далёкую брошенную можно вернуть в поток', () => {
  const { world, traffic } = setup();
  const first = traffic.cars[0], second = traffic.cars[1];
  steal(world, first);
  const controlledPos = [first.x, first.z];
  stepTraffic(traffic, city, 0.05, CONFIG.traffic, { x: 300, z: 300, heading: 0 });
  assert.deepEqual([first.x, first.z], controlledPos);
  steal(world, second);
  const viewer = { x: city.start.x, z: city.start.z, heading: 0 };
  first.x = viewer.x + CONFIG.traffic.respawnDist + 10;
  first.z = viewer.z;
  for (let i = 0; i < 20 && first.parked; i++) stepTraffic(traffic, city, 0.05, CONFIG.traffic, viewer);
  assert.equal(first.parked, false, 'заброшенная вдали машина вернулась в трафик');
  world.sync();
  assert.equal(world.stolen.has(first), false);
});

test('управляемый инстанс трафика не приносит очки за пролёт мимо самого себя', () => {
  const { world, traffic } = setup(1);
  const ref = traffic.cars[0]; steal(world, ref);
  const car = world.current.car, g = makeGameplay(CONFIG.gameplay, city, 7, city.start);
  Object.assign(car, { vx: 30, vz: 0, speed: 30 });
  for (let i = 0; i < 30; i++) updateGameplay(g, 0.05, car, traffic.cars);
  car.x += 50;
  updateGameplay(g, 0.05, car, traffic.cars);
  assert.equal(g.nearMiss, 0);
});

test('остановившийся перед пешеходом водитель немного ждёт, пока тот подходит сбоку', () => {
  const { traffic } = setup(1);
  const c = traffic.cars[0];
  Object.assign(c, { x: 20, z: city.start.z, s: 20, lane: city.start.z, speed: 7, cruise: 10, yieldT: 0 });
  const pedestrian = { x: 27, z: city.start.z, heading: 0, camYaw: 0 };
  for (let i = 0; i < 30; i++) stepTraffic(traffic, city, 0.05, CONFIG.traffic, pedestrian);
  assert.ok(c.speed < 0.1);
  pedestrian.z += 4; // герой пошёл к двери, водитель пока не трогается
  for (let i = 0; i < 30; i++) stepTraffic(traffic, city, 0.05, CONFIG.traffic, pedestrian);
  assert.ok(c.speed < 0.1, `машина тронулась слишком рано: ${c.speed}`);
  for (let i = 0; i < 100; i++) stepTraffic(traffic, city, 0.05, CONFIG.traffic, pedestrian);
  assert.ok(c.speed > 1, 'после ожидания поток продолжает движение');
});
