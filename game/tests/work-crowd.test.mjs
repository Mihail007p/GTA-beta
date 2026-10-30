import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { CARS } from '../js/cars.js';
import { generateCity, buildSpatialHash } from '../js/city.js';
import { makeEntrances } from '../js/interiors.js';
import { makeLife, acceptJob, boardTaxi, completeTaxi } from '../js/life.js';
import { makeCrowd, stepCrowd } from '../js/crowd.js';
import { syncTaxiPassenger, releaseTaxiPassenger, cancelTaxiPassenger } from '../js/work-crowd.js';

const city = generateCity(CONFIG.city), hash = buildSpatialHash(city.colliders, 30);
const doors = makeEntrances(city, hash), byId = new Map(doors.map(d => [d.id, d]));
const def = { length: 4.4, width: 1.9 }, origin = doors.find(d => d.kind === 'shop');
const car = { x: origin.x + 4, z: origin.z, heading: 0 };

test('пассажир использует пул из четырёх моделей, садится, едет и выходит', () => {
  const s = { money: 0, life: makeLife() }, crowd = makeCrowd(4);
  stepCrowd(crowd, city, hash, car, 0);
  assert.equal(acceptJob(s.life, 'taxi', origin, doors).ok, true);
  const pickup = byId.get(s.life.job.pickupId), dest = byId.get(s.life.job.destinationId);
  const p = syncTaxiPassenger(crowd, s.life.job, byId, car, def, 0);
  assert.equal(crowd.people.length, 4); assert.equal(p.condition, 'taxi-wait');
  assert.ok(Math.hypot(p.x - pickup.x, p.z - pickup.z) <= 1);
  // Удалённый пассажир не перемещается в обычном пуле, пока игрок к нему едет.
  const start = { x: p.x, z: p.z };
  stepCrowd(crowd, city, hash, car, 0.1);
  assert.deepEqual({ x: p.x, z: p.z }, start);
  assert.equal(boardTaxi(s.life, pickup).ok, true);
  syncTaxiPassenger(crowd, s.life.job, byId, car, def, 0.4);
  assert.equal(p.condition, 'taxi-board'); assert.ok(p.x !== start.x || p.z !== start.z);
  syncTaxiPassenger(crowd, s.life.job, byId, car, def, 0.6);
  assert.equal(p.condition, 'taxi-seat');
  const before = p.x; car.x += 8;
  syncTaxiPassenger(crowd, s.life.job, byId, car, def, 0);
  assert.equal(p.x, before + 8);
  assert.equal(completeTaxi(s, dest).ok, true);
  assert.equal(releaseTaxiPassenger(crowd, dest), true); assert.equal(p.condition, 'taxi-exit');
  for (let i = 0; i < 11; i++) stepCrowd(crowd, city, hash, car, 0.1);
  assert.ok(['walk', 'return'].includes(p.condition));
  assert.equal(p.taxiReserved, false);
});

test('после перезапуска пассажир остаётся в машине; отмена не оставляет призрака', () => {
  const s = { money: 0, life: makeLife() }, crowd = makeCrowd(4);
  stepCrowd(crowd, city, hash, car, 0);
  acceptJob(s.life, 'taxi', origin, doors);
  boardTaxi(s.life, byId.get(s.life.job.pickupId));
  const restored = makeLife(JSON.parse(JSON.stringify(s.life)));
  const p = syncTaxiPassenger(crowd, restored.job, byId, car, def, 0);
  assert.equal(p.condition, 'taxi-seat'); assert.equal(p.taxiReserved, true);
  assert.equal(cancelTaxiPassenger(crowd, { x: car.x, z: car.z + 2, y: 0 }), true);
  assert.equal(p.taxiReserved, false); assert.equal(p.condition, 'taxi-exit');
  syncTaxiPassenger(crowd, null, byId, car, def, 0);
  assert.equal(p.alive, true, 'отмена даёт пассажиру выйти, а не удаляет его');
  for (let i = 0; i < 11; i++) stepCrowd(crowd, city, hash, car, 0.1);
  assert.ok(['walk', 'return'].includes(p.condition));
});

test('высота пассажира подбирается к кузову и поднимается вместе с машиной на тротуаре', () => {
  const life = makeLife(), crowd = makeCrowd(4), vehicle = { x: 0, z: 0, heading: 0, onRoad: true };
  acceptJob(life, 'taxi', origin, doors); boardTaxi(life, byId.get(life.job.pickupId));
  const expected = [-0.22, -0.52, -0.42, -0.52];
  CARS.forEach((def, i) => {
    vehicle.onRoad = true;
    const p = syncTaxiPassenger(crowd, life.job, byId, vehicle, def, 0);
    assert.equal(p.condition, 'taxi-seat'); assert.equal(p.y, expected[i]);
    vehicle.onRoad = false;
    syncTaxiPassenger(crowd, life.job, byId, vehicle, def, 0);
    assert.ok(Math.abs(p.y - expected[i] - 0.16) < 1e-9);
  });
});

test('отмена при ожидании освобождает пассажира и не оставляет занятого места', () => {
  const life = makeLife(), crowd = makeCrowd(4);
  stepCrowd(crowd, city, hash, car, 0); acceptJob(life, 'taxi', origin, doors);
  const p = syncTaxiPassenger(crowd, life.job, byId, car, def);
  assert.equal(p.condition, 'taxi-wait');
  assert.equal(cancelTaxiPassenger(crowd, null), true);
  assert.equal(p.taxiReserved, false); assert.equal(p.condition, 'walk');
  syncTaxiPassenger(crowd, null, byId, car, def, 0);
  assert.equal(p.alive, true);
});
