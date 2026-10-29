import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash, circleVsAABBs, isOnRoad } from '../js/city.js';
import { makePedestrian, stepPedestrian, HERO_RADIUS } from '../js/pedestrian.js';
import { turnLook } from '../js/look-controls.js';
import { makeEntrances, nearestEntrance, makeInteriorLayout, makeInteriorHash, nearInteriorExit, findReturnSpot } from '../js/interiors.js';

const city = generateCity(CONFIG.city);
const world = buildSpatialHash(city.colliders, 30);
const doors = makeEntrances(city, world);
const diff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

test('свайп поворачивает направление взгляда именно вправо/влево, включая переход через π', () => {
  for (const yaw of [0, Math.PI / 2, -1.8, Math.PI - 0.01, -Math.PI + 0.01]) {
    for (const dx of [-100, 100]) {
      const next = turnLook(yaw, dx), delta = diff(next, yaw);
      assert.equal(Math.sign(delta), Math.sign(dx));
      const rightX = -Math.sin(yaw), rightZ = Math.cos(yaw);
      const towardRight = (Math.cos(next) - Math.cos(yaw)) * rightX + (Math.sin(next) - Math.sin(yaw)) * rightZ;
      assert.equal(Math.sign(towardRight), Math.sign(dx));
      assert.ok(next >= -Math.PI && next <= Math.PI);
    }
  }
});

test('входы детерминированы, разнообразны и расположены на свободных фасадах', () => {
  assert.deepEqual(doors, makeEntrances(generateCity(CONFIG.city), buildSpatialHash(generateCity(CONFIG.city).colliders, 30)));
  assert.ok(doors.length > 100 && doors.length <= city.innerBuildingCount);
  assert.ok(doors.some(d => d.kind === 'shop') && doors.some(d => d.kind === 'home'));
  assert.ok(doors.some(d => d.kind === 'shop' && Math.hypot(d.x - city.start.x, d.z - city.start.z) < 35));
  assert.ok(doors.some(d => d.kind === 'home' && Math.hypot(d.x - city.start.x, d.z - city.start.z) < 35));
  const nearby = [];
  for (const d of doors) {
    assert.equal(Math.abs(d.nx) + Math.abs(d.nz), 1);
    assert.equal(isOnRoad(city, d.x, d.z), false, 'маркер не на проезжей части');
    world.query(d.x, d.z, 1, nearby);
    assert.equal(circleVsAABBs(d.x, d.z, HERO_RADIUS, nearby), null, 'у двери достаточно места');
    assert.equal(nearestEntrance(d, doors)?.id, d.id);
  }
  assert.equal(nearestEntrance({ x: 10000, z: 10000 }, doors), null);
});

for (const kind of ['home', 'shop']) {
  test(`${kind}: можно ходить, мебель и стены твёрдые, к выходу можно вернуться`, () => {
    const layout = makeInteriorLayout(kind), hash = makeInteriorHash(layout), p = layout.spawn;
    const hero = makePedestrian(p.x, p.z, p.heading);
    for (let i = 0; i < 90; i++) stepPedestrian(hero, { x: 0, y: 1, run: true }, 1 / 60, null, hash, null, null, null);
    assert.ok(hero.z < p.z - 3, 'свободный проход вглубь помещения');
    assert.equal(hero.y, 0);
    for (let i = 0; i < 180; i++) stepPedestrian(hero, { x: 0, y: -1, run: true }, 1 / 60, null, hash, null, null, null);
    assert.ok(hero.z < 5.55, `через стену пройти нельзя: z=${hero.z}`);
    assert.ok(nearInteriorExit(hero, layout));
    hero.camYaw = 0;
    for (let i = 0; i < 180; i++) stepPedestrian(hero, { x: 0, y: 1, run: true }, 1 / 60, null, hash, null, null, null);
    assert.ok(hero.x < 5.55, `через боковую стену пройти нельзя: x=${hero.x}`);
    const items = []; hash.query(hero.x, hero.z, 1, items);
    assert.equal(circleVsAABBs(hero.x, hero.z, HERO_RADIUS - 0.01, items), null);
    // Столкновение с центром одного из предметов, а не только с внешней стеной.
    const prop = layout.props[0], atProp = makePedestrian(prop.x, prop.z, 0);
    stepPedestrian(atProp, { x: 0, y: 0 }, 1 / 60, null, hash, null, null, null);
    assert.ok(Math.hypot(atProp.x - prop.x, atProp.z - prop.z) > 0.2);
  });
}

test('выход возвращает к прежней двери и не размещает героя внутри машины или стены', () => {
  const d = doors.find(e => e.kind === 'shop');
  assert.deepEqual(findReturnSpot(d, d, world, null, null, { cars: [] }), { x: d.x, z: d.z });
  const car = { x: d.x, z: d.z, heading: 0 };
  const alternative = findReturnSpot(d, d, world, car, { length: 4.4, width: 1.9 }, { cars: [] });
  assert.ok(alternative && Math.hypot(alternative.x - d.x, alternative.z - d.z) > 0.5);
  assert.ok(Math.hypot(alternative.x - d.x, alternative.z - d.z) < 10);
  const blocked = buildSpatialHash([{ kind: 'wall', x: d.faceX, z: d.faceZ, hw: 100, hd: 100 }], 30);
  assert.equal(findReturnSpot(d, d, blocked, null, null, { cars: [] }), null);
});
