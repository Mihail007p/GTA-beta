import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import { generateCity, buildSpatialHash, circleVsAABBs, isOnRoad } from '../js/city.js';
import { makeEntrances, makeInteriorLayout } from '../js/interiors.js';
import { HERO_RADIUS } from '../js/pedestrian.js';
import { makeLife, buyItem, buyOutfit, useItem, cookRecipe, stepNeeds, damage, acceptJob, completeJob, JOBS, taxiDestination, TAXI_FARES } from '../js/life.js';
import { localHour, clockText, daylight } from '../js/day-night.js';
import { makeCrowd, stepCrowd, nearestCitizen } from '../js/crowd.js';

const fresh = money => ({ money, life: makeLife() });
const city = generateCity(CONFIG.city), hash = buildSpatialHash(city.colliders, 30), doors = makeEntrances(city, hash);

test('старая игра получает стартовый набор, битые поля и унаследованные ключи обезвреживаются', async () => {
  let raw = JSON.stringify({ money: 714, bestScore: 209, ownedCars: ['strada'], activeCar: 'strada',
    selectedCharacter: 'hero-2', homeStates: { 371: { tv: true } }, settings: { sound: false } });
  globalThis.localStorage = { getItem: () => raw, setItem: (_k, value) => { raw = value; } };
  const save = await import('../js/save.js?life-test');
  const data = save.loadSave();
  assert.equal(data.money, 714); assert.equal(data.bestScore, 209); assert.equal(data.selectedCharacter, 'hero-2');
  assert.equal(data.homeStates[371].tv, true); assert.equal(data.settings.sound, false);
  assert.equal(data.settings.starvationDamage, true);
  assert.deepEqual([data.life.inventory.bread, data.life.inventory.egg, data.life.inventory.apple], [1, 1, 1]);
  const corrupted = makeLife({ health: Infinity, satiety: -9, inventory: { apple: 400, egg: -2 },
    outfits: ['unknown'], outfit: 'unknown', job: { type: '__proto__', targetId: 1 } });
  assert.equal(corrupted.health, 100); assert.equal(corrupted.satiety, 0);
  assert.equal(corrupted.inventory.apple, 99); assert.equal(corrupted.inventory.egg, 0);
  assert.deepEqual(corrupted.outfits, ['street']); assert.equal(corrupted.outfit, 'street'); assert.equal(corrupted.job, null);
  data.life.inventory.apple = 7; save.markDirty(); save.flushNow();
  assert.equal(JSON.parse(raw).life.inventory.apple, 7);
  const reset = save.resetSave(); assert.equal(reset.money, 0); assert.equal(reset.life.inventory.apple, 1);
  assert.equal(reset.settings.sound, false); delete globalThis.localStorage;
});

test('покупка списывает деньги один раз, не покупает при нехватке, костюм не продаётся повторно', () => {
  const s = fresh(0), before = JSON.stringify(s);
  assert.equal(buyItem(s, 'apple').ok, false); assert.equal(JSON.stringify(s), before);
  assert.equal(buyItem(s, '__proto__').ok, false); assert.equal(buyOutfit(s, '__proto__').ok, false);
  s.money = 300;
  assert.equal(buyItem(s, 'apple').ok, true); assert.equal(s.money, 280); assert.equal(s.life.inventory.apple, 2);
  assert.equal(buyOutfit(s, 'smart').ok, true); assert.equal(s.money, 30);
  assert.equal(buyOutfit(s, 'smart').ok, false); assert.equal(s.money, 30);
  s.life.inventory.apple = 99; assert.equal(buyItem(s, 'apple').ok, false); assert.equal(s.money, 30);
});

test('две настоящие рецептуры: не готовим без огня и продуктов, расходуем, едим и лечимся', () => {
  const s = fresh(200), life = s.life;
  assert.equal(cookRecipe(life, 'breakfast', false).ok, false);
  assert.deepEqual([life.inventory.bread, life.inventory.egg, life.inventory.meal], [1, 1, 0]);
  assert.equal(cookRecipe(life, 'breakfast', true).ok, true);
  assert.deepEqual([life.inventory.bread, life.inventory.egg, life.inventory.meal], [0, 0, 1]);
  assert.equal(cookRecipe(life, 'breakfast', true).ok, false);
  assert.equal(cookRecipe(life, '__proto__', true).ok, false);
  assert.equal(useItem(life, 'meal').ok, false, 'при полном здоровье и сытости еда не теряется');
  life.health = 60; life.satiety = 30;
  assert.equal(useItem(life, 'meal').ok, true);
  assert.deepEqual([life.health, life.satiety, life.inventory.meal], [75, 80, 0]);
  assert.equal(buyItem(s, 'bread').ok, true);
  assert.equal(cookRecipe(life, 'fruitToast', true).ok, true);
  assert.deepEqual([life.inventory.bread, life.inventory.apple, life.inventory.toast], [0, 0, 1]);
  assert.equal(useItem(life, 'toast').ok, true); assert.deepEqual([life.health, life.satiety], [83, 100]);
  assert.equal(buyItem(s, 'medkit').ok, true); assert.equal(useItem(life, 'medkit').ok, true);
  assert.equal(life.health, 100); assert.equal(life.inventory.medkit, 0);
});

test('сытость уходит только при шаге игры, голод и отдых влияют на здоровье; урон голода отключаем', () => {
  const life = makeLife(); stepNeeds(life, 60); assert.equal(life.satiety, 99);
  life.satiety = 0.5; life.health = 80;
  stepNeeds(life, 60, { starvationDamage: true }); assert.equal(life.satiety, 0); assert.equal(life.health, 77);
  stepNeeds(life, 60, { starvationDamage: false }); assert.equal(life.health, 77);
  life.satiety = 50; stepNeeds(life, 5, { rest: 'lie' }); assert.equal(life.health, 87);
  damage(life, 30); assert.equal(life.health, 57); stepNeeds(life, 10, { rest: 'sit' }); assert.equal(life.health, 64);
  damage(life, Infinity); assert.equal(life.health, 64); damage(life, 200); assert.equal(life.health, 0);
});

test('два заказа ведут к доступным дверям, оплата только при доставке и ровно один раз', () => {
  const origin = doors.find(d => d.kind === 'shop'), s = fresh(0);
  for (const type of ['home', 'shop']) {
    assert.equal(acceptJob(s.life, type, origin, doors).ok, true);
    const target = doors.find(d => d.id === s.life.job.targetId);
    assert.equal(target.kind, JOBS[type].kind); assert.notEqual(target.id, origin.id);
    assert.equal(acceptJob(s.life, type, origin, doors).ok, false);
    assert.equal(completeJob(s, origin).ok, false);
    const previous = s.money;
    assert.equal(completeJob(s, target).ok, true); assert.equal(s.money, previous + JOBS[type].reward);
    assert.equal(completeJob(s, target).ok, false); assert.equal(s.money, previous + JOBS[type].reward);
  }
  assert.equal(s.life.completedJobs, 2);
  assert.equal(acceptJob(s.life, 'toString', origin, doors).ok, false);
});

test('местное время: полночь и полдень действительно разные, переход непрерывный, 24 часа на цикл', () => {
  assert.equal(daylight(0).day, 0); assert.equal(daylight(12).day, 1);
  assert.equal(daylight(24).day, daylight(0).day);
  assert.ok(daylight(6.5).day > daylight(5.5).day);
  const date = new Date(2026, 4, 5, 13, 7, 30);
  assert.equal(clockText(date), '13:07'); assert.ok(Math.abs(localHour(date) - (13 + 7 / 60 + 30 / 3600)) < 1e-8);
});

test('прохожие появляются на тротуарах, движутся и не проходят через здания или асфальт', () => {
  const crowd = makeCrowd(4), player = { x: city.start.x, z: city.start.z };
  stepCrowd(crowd, city, hash, player, 0);
  assert.equal(crowd.people.filter(p => p.alive).length, 4);
  const start = crowd.people.map(p => ({ x: p.x, z: p.z }));
  for (let i = 0; i < 300; i++) {
    stepCrowd(crowd, city, hash, player, 0.1);
    for (const p of crowd.people.filter(p => p.alive)) {
      assert.equal(isOnRoad(city, p.x, p.z), false);
      const near = hash.query(p.x, p.z, 0.5);
      assert.equal(circleVsAABBs(p.x, p.z, 0.48, near), null);
    }
  }
  assert.ok(crowd.people.some((p, i) => Math.hypot(p.x - start[i].x, p.z - start[i].z) > 1));
  assert.equal(nearestCitizen(crowd.people[0], crowd), crowd.people[0]);
});

test('маркер продавца в свободной точке, к нему можно дойти от входа', () => {
  const room = makeInteriorLayout('shop'), marker = room.interactions[0];
  assert.equal(circleVsAABBs(marker.x, marker.z, HERO_RADIUS, room.colliders), null);
  const step = 0.1, n = 111, min = -5.5, key = (x, z) => x * n + z;
  const xy = (x, z) => ({ x: min + x * step, z: min + z * step });
  const start = [Math.round((room.spawn.x - min) / step), Math.round((room.spawn.z - min) / step)];
  const queue = [start], seen = new Set([key(...start)]); let found = false;
  for (let i = 0; i < queue.length && !found; i++) {
    const [a, b] = queue[i], pos = xy(a, b);
    if (Math.hypot(pos.x - marker.x, pos.z - marker.z) < marker.reach) { found = true; break; }
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a2 = a + da, b2 = b + db, k = key(a2, b2);
      if (a2 < 0 || b2 < 0 || a2 >= n || b2 >= n || seen.has(k)) continue;
      seen.add(k); const p = xy(a2, b2);
      if (!circleVsAABBs(p.x, p.z, HERO_RADIUS + 0.005, room.colliders)) queue.push([a2, b2]);
    }
  }
  assert.ok(found, 'к продавцу можно подойти');
});


test('такси выбирает реальную доступную дверь или адрес заказа, а не случайную точку', () => {
  const player = { x: city.start.x, z: city.start.z }, shop = doors.find(d => d.kind === 'shop');
  const life = makeLife();
  assert.equal(taxiDestination('job', player, doors, null), null);
  for (const type of ['home', 'shop']) {
    const target = taxiDestination(type, player, doors, null);
    assert.equal(target.kind, type); assert.ok(Math.hypot(target.x - player.x, target.z - player.z) >= 35);
    assert.equal(TAXI_FARES[type], 40);
  }
  assert.equal(acceptJob(life, 'home', shop, doors).ok, true);
  const target = doors.find(d => d.id === life.job.targetId);
  assert.equal(taxiDestination('job', player, doors, life.job)?.id, target.id);
  assert.equal(taxiDestination('job', target, doors, life.job), null);
  assert.equal(taxiDestination('__proto__', player, doors, life.job), null);
});
