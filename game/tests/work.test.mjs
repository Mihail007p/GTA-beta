import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash, circleVsAABBs, isOnRoad } from '../js/city.js';
import { makeEntrances } from '../js/interiors.js';
import { CARS } from '../js/cars.js';
import { colliderOf, carCircles } from '../js/collision.js';
import { circleVsCar } from '../js/pedestrian.js';
import { makeLife, acceptJob, completeJob, boardTaxi, completeTaxi, jobPoint, jobInstruction, JOBS } from '../js/life.js';

const city = generateCity(CONFIG.city), hash = buildSpatialHash(city.colliders, 30), doors = makeEntrances(city, hash);
const origin = doors.find(d => d.kind === 'shop'), byId = id => doors.find(d => d.id === id);
const fresh = () => ({ money: 100, life: makeLife() });

test('работа таксистом: сначала посадка, затем поездка к другому адресу и ровно одна оплата', () => {
  const s = fresh();
  assert.equal(acceptJob(s.life, 'taxi', origin, doors).ok, true);
  const job = s.life.job, pickup = byId(job.pickupId), destination = byId(job.destinationId);
  assert.ok(pickup && destination && pickup.id !== destination.id);
  assert.equal(job.stage, 'pickup');
  assert.equal(completeTaxi(s, pickup).ok, false); assert.equal(completeJob(s, pickup).ok, false);
  assert.equal(boardTaxi(s.life, destination).ok, false);
  assert.equal(boardTaxi(s.life, pickup).ok, true); assert.equal(job.targetId, destination.id);
  assert.equal(job.stage, 'drive'); assert.match(jobInstruction(job), /отвезите/i);
  assert.equal(boardTaxi(s.life, pickup).ok, false);
  assert.equal(completeTaxi(s, pickup).ok, false); assert.equal(s.money, 100);
  // Пассажир и маршрут переживают перезапуск и не создают повторного платежа.
  s.life = makeLife(JSON.parse(JSON.stringify(s.life)));
  assert.equal(s.life.job.stage, 'drive'); assert.equal(s.life.job.destinationId, destination.id);
  assert.equal(completeTaxi(s, destination).ok, true); assert.equal(s.money, 100 + JOBS.taxi.reward);
  assert.equal(s.life.job, null); assert.equal(s.life.completedJobs, 1);
  assert.equal(completeTaxi(s, destination).ok, false); assert.equal(s.money, 100 + JOBS.taxi.reward);
});

test('курьер и уборщик проходят три разные точки: прогресс сохраняется, деньги начисляются в конце', () => {
  for (const type of ['route', 'cleanup']) {
    const s = fresh(); assert.equal(acceptJob(s.life, type, origin, doors).ok, true);
    const ids = s.life.job.targets.slice();
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => !!byId(id) && id !== origin.id));
    for (let i = 0; i < 3; i++) {
      const target = byId(ids[i]), point = jobPoint(s.life.job, target);
      assert.equal(s.life.job.targetId, target.id);
      assert.match(jobInstruction(s.life.job), new RegExp(`${i + 1}/3`));
      if (type === 'cleanup') {
        hash.query(point.x, point.z, 0.5, []);
        assert.equal(circleVsAABBs(point.x, point.z, 0.3, hash.query(point.x, point.z, 0.5)), null, 'мешок не внутри здания');
      }
      assert.equal(completeJob(s, origin).ok, false);
      const result = completeJob(s, target);
      assert.equal(result.ok, true);
      if (i < 2) {
        assert.equal(result.complete, false); assert.equal(s.money, 100);
        s.life = makeLife(JSON.parse(JSON.stringify(s.life)));
        assert.equal(s.life.job.index, i + 1);
        assert.equal(completeJob(s, target).ok, false, 'повторный адрес не оплачивается');
      } else {
        assert.equal(result.complete, true); assert.equal(s.money, 100 + JOBS[type].reward);
        assert.equal(s.life.job, null); assert.equal(s.life.completedJobs, 1);
        assert.equal(completeJob(s, target).ok, false);
      }
    }
  }
});

test('у всех возможных адресов такси есть свободное место остановки на дороге; мешки вне стен', () => {
  const taxiTargets = new Set();
  for (const shop of doors.filter(d => d.kind === 'shop')) {
    const life = makeLife();
    if (acceptJob(life, 'taxi', shop, doors).ok) {
      taxiTargets.add(life.job.pickupId); taxiTargets.add(life.job.destinationId);
    }
  }
  const def = CARS[0], col = colliderOf(def), circles = [{}, {}];
  for (const d of doors) {
    const bag = jobPoint({ type: 'cleanup' }, d);
    assert.equal(circleVsAABBs(bag.x, bag.z, 0.3, hash.query(bag.x, bag.z, 0.6)), null, `мешок ${d.id}`);
    if (!taxiTargets.has(d.id)) continue;
    let available = false;
    // Выборка свободных положений: центр на дороге, не дальше 6 м от метки,
    // кузов не в стене и не пересекает ожидающего пассажира.
    for (let dx = -6; dx <= 6 && !available; dx += 0.5) for (let dz = -6; dz <= 6 && !available; dz += 0.5) {
      if (Math.hypot(dx, dz) > 5.9 || !isOnRoad(city, d.x + dx, d.z + dz)) continue;
      for (let a = 0; a < Math.PI; a += Math.PI / 4) {
        const car = { x: d.x + dx, z: d.z + dz, heading: a };
        carCircles(car, col, circles);
        if (circles.every(p => !circleVsAABBs(p.x, p.z, col.radius, hash.query(p.x, p.z, col.radius))) &&
            !circleVsCar(bag.x, bag.z, 0.38, car, def.length, def.width)) { available = true; break; }
      }
    }
    assert.ok(available, `нет свободной остановки у адреса ${d.id}`);
  }
  assert.ok(taxiTargets.size > 200);
});

test('старые активные задания сохраняются; повреждённые новые не проходят валидацию', () => {
  assert.deepEqual(makeLife({ job: { type: 'home', targetId: 371 } }).job, { type: 'home', targetId: 371 });
  for (const job of [
    { type: 'taxi', targetId: 2, pickupId: 1, destinationId: 2, stage: 'pickup' },
    { type: 'taxi', targetId: 1, pickupId: 1, destinationId: 1, stage: 'drive' },
    { type: 'route', targetId: 1, targets: [1, 1, 2], index: 0 },
    { type: 'cleanup', targetId: 2, targets: [1, 2, 3], index: 9 },
    { type: '__proto__', targetId: 2 },
  ]) assert.equal(makeLife({ job }).job, null);
});
