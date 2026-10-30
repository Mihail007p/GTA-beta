import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash, circleVsAABBs } from '../js/city.js';
import { makeCrowd, stepCrowd, nearestCitizen } from '../js/crowd.js';
import { collideCrowd, FALL_SPEED, FATAL_SPEED } from '../js/crowd-collisions.js';

const def = { length: 4.4, width: 1.9 };
const person = (x = 0, z = 0) => ({ id: 0, x, z, alive: true, condition: 'walk', axis: 'z', dir: 1, speed: 0, y: 0.16 });
const vehicle = (x, z, speed, heading = 0) => ({ x, z, heading, vx: Math.cos(heading) * speed, vz: Math.sin(heading) * speed, speed });

test('контакт на малой скорости выталкивает человека, а не пропускает сквозь кузов', () => {
  const p = person(2.45), c = vehicle(0, 0, FALL_SPEED / 2), crowd = { people: [p] };
  const hits = collideCrowd(crowd, c, def);
  assert.equal(hits.length, 1); assert.equal(hits[0].kind, 'push');
  assert.equal(p.condition, 'walk'); assert.ok(p.x > 2.5); assert.equal(p.speed, 0);
  assert.deepEqual(collideCrowd({ people: [person(20, 20)] }, c, def), []);
});

test('непрерывный контакт: даже перескок нескольких метров не пропускает прохожего', () => {
  const p = person(), c = vehicle(5, 0, 8), crowd = { people: [p] };
  const hits = collideCrowd(crowd, c, def, { x: -5, z: 0 });
  assert.equal(hits.length, 1); assert.equal(hits[0].kind, 'injured');
  assert.equal(p.condition, 'injured'); assert.equal(p.fatal, false);
  assert.ok(c.vx < 8 && p.hitVx > 0);
  assert.deepEqual(collideCrowd(crowd, c, def), [], 'лежачий человек не получает бесконечную серию повторных ударов');
  const far = person(), teleported = vehicle(50, 0, 8);
  assert.deepEqual(collideCrowd({ people: [far] }, teleported, def, { x: -50, z: 0 }), [], 'сброс автомобиля не должен сбивать всех на пути телепорта');
});

test('сильный удар фатален; учитывается также задний ход и косой контакт', () => {
  const p = person(-2.45), c = vehicle(0, 0, -FATAL_SPEED - 2);
  const [hit] = collideCrowd({ people: [p] }, c, def);
  assert.equal(hit.kind, 'fatal'); assert.equal(p.condition, 'dead'); assert.equal(p.fatal, true);
  assert.ok(p.hitVx < 0);
  const q = person(0, 1.3), side = vehicle(0, 0, 0);
  side.vz = 8; side.speed = 8;
  assert.equal(collideCrowd({ people: [q] }, side, def)[0].kind, 'injured');
});

test('возвращающийся на тротуар прохожий остаётся уязвим, учитывается его направление', () => {
  const p = person(2.45), c = vehicle(0, 0, 7);
  Object.assign(p, { condition: 'return', returnPoint: { x: 12, z: 0 }, speed: 1.15, axis: 'z', dir: -1 });
  const [hit] = collideCrowd({ people: [p] }, c, def);
  assert.equal(hit.kind, 'injured');
  assert.ok(hit.impact > 5 && hit.impact < 7, 'считается относительная скорость движения к тротуару');
});

test('после несильного удара человек поднимается, после сильного остаётся лежать до удаления', () => {
  const city = generateCity(CONFIG.city), hash = buildSpatialHash(city.colliders, 30), focus = { x: city.start.x, z: city.start.z };
  const crowd = makeCrowd(2); stepCrowd(crowd, city, hash, focus, 0);
  const p = crowd.people[0], original = { x: p.x, z: p.z };
  const c = vehicle(p.x - 2.45, p.z, 6);
  assert.equal(collideCrowd({ people: [p] }, c, def)[0].kind, 'injured');
  assert.equal(nearestCitizen(p, crowd), null);
  for (let i = 0; i < 10; i++) stepCrowd(crowd, city, hash, focus, 0.1);
  assert.equal(p.condition, 'injured'); assert.equal(p.fall, 1);
  assert.ok(Math.hypot(p.x - original.x, p.z - original.z) > 0.05);
  for (let i = 0; i < 38; i++) stepCrowd(crowd, city, hash, focus, 0.1);
  assert.ok(['walk', 'return'].includes(p.condition)); assert.equal(p.fall, 0);
  const nearby = hash.query(p.x, p.z, 0.5);
  assert.equal(circleVsAABBs(p.x, p.z, 0.38, nearby), null);
  const q = crowd.people[1], strong = vehicle(q.x - 2.45, q.z, FATAL_SPEED + 3);
  assert.equal(collideCrowd({ people: [q] }, strong, def)[0].kind, 'fatal');
  for (let i = 0; i < 100; i++) stepCrowd(crowd, city, hash, focus, 0.1);
  assert.equal(q.condition, 'dead'); assert.equal(q.fall, 1); assert.equal(q.alive, true);
  for (let i = 0; i < 101 && q.alive; i++) stepCrowd(crowd, city, hash, focus, 0.1);
  assert.equal(q.alive, false);
});
