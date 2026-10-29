import test from 'node:test';
import assert from 'node:assert/strict';
import { circleVsAABBs } from '../js/city.js';
import { HERO_RADIUS, makePedestrian } from '../js/pedestrian.js';
import { makeInteriorLayout, nearInteriorExit } from '../js/interiors.js';
import { HOME_DEFAULTS, makeHomeState, nearestHomeInteraction, homeActionMode, toggleHomeItem,
  startHomePose, requestStand, stepHomePose } from '../js/home-interactions.js';

const layout = makeInteriorLayout('home');
const noInput = { x: 0, y: 0 };
const moving = { x: 0, y: 1 };

// Обходим всю комнату сеткой, не проходя сквозь мебель с радиусом героя.
function reachableCells() {
  const step = 0.1, n = 111, min = -5.5;
  const key = (a, b) => a * n + b;
  const xy = (a, b) => ({ x: min + a * step, z: min + b * step });
  const start = [Math.round((layout.spawn.x - min) / step), Math.round((layout.spawn.z - min) / step)];
  const queue = [start], seen = new Set([key(...start)]), points = [];
  for (let i = 0; i < queue.length; i++) {
    const [a, b] = queue[i], point = xy(a, b); points.push(point);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = a + dx, z = b + dz, id = key(x, z);
      if (x < 0 || z < 0 || x >= n || z >= n || seen.has(id)) continue;
      seen.add(id);
      const p = xy(x, z);
      if (!circleVsAABBs(p.x, p.z, HERO_RADIUS + 0.005, layout.colliders)) queue.push([x, z]);
    }
  }
  return points;
}

const reachable = reachableCells();
test('до всех восьми действий можно дойти от входа, не проходя сквозь мебель', () => {
  assert.deepEqual(layout.interactions.map(i => i.id), ['sofa', 'bed', 'book', 'water', 'stove', 'cabinet', 'tv', 'light']);
  assert.equal(makeInteriorLayout('shop').interactions.length, 0);
  for (const item of layout.interactions) {
    assert.equal(circleVsAABBs(item.x, item.z, HERO_RADIUS, layout.colliders), null, `${item.id}: маркер не на мебели`);
    const valid = reachable.filter(p => !nearInteriorExit(p, layout) && nearestHomeInteraction(p, layout.interactions)?.id === item.id);
    assert.ok(valid.length > 0, `${item.id}: действие недостижимо или перекрыто другой кнопкой`);
  }
  assert.equal(nearestHomeInteraction({ x: 100, z: 100 }, layout.interactions), null);
});

test('домашние предметы переключаются независимо и имеют корректные действия', () => {
  const state = makeHomeState();
  assert.deepEqual(state, HOME_DEFAULTS);
  for (const item of layout.interactions.filter(i => i.kind === 'toggle')) {
    const before = state[item.flag], other = { ...state };
    assert.equal(homeActionMode(item, state), `home-${item.flag}-${before ? 'off' : 'on'}`);
    assert.equal(toggleHomeItem(state, item), true);
    assert.equal(state[item.flag], !before);
    assert.equal(homeActionMode(item, state), `home-${item.flag}-${before ? 'on' : 'off'}`);
    for (const key of Object.keys(state).filter(k => k !== item.flag)) assert.equal(state[key], other[key]);
    assert.equal(toggleHomeItem(state, item), true);
    assert.deepEqual(state, other);
  }
  assert.equal(toggleHomeItem(state, { kind: 'toggle', flag: '__proto__' }), false);
  assert.equal(toggleHomeItem(state, { kind: 'sit' }), false);
  assert.deepEqual(makeHomeState({ tv: true, light: 'false', water: 1, unrelated: true }), { ...HOME_DEFAULTS, tv: true });
});

test('посадка и вставание из разных доступных точек не сдвигают физическую позицию в коллайдер', () => {
  for (const item of layout.interactions.filter(i => i.kind === 'sit' || i.kind === 'lie')) {
    const points = reachable.filter(p => !nearInteriorExit(p, layout) && nearestHomeInteraction(p, layout.interactions)?.id === item.id);
    for (const p of points.filter((_, i) => i % 17 === 0)) {
      const hero = makePedestrian(p.x, p.z, 0.7), original = [p.x, p.z];
      hero.vx = 2; hero.vz = -2; hero.speed = 3;
      assert.equal(startHomePose(hero, item, layout), true);
      assert.deepEqual([hero.vx, hero.vz, hero.speed], [0, 0, 0]);
      // Удержание стика во время нажатия не отменяет посадку.
      for (let i = 0; i < 30; i++) stepHomePose(hero, moving, 1 / 60);
      assert.equal(hero.pose?.kind, item.kind);
      assert.equal(hero.pose.amount, 1);
      assert.equal(hero.pose.leaving, false);
      assert.deepEqual([hero.x, hero.z], original);
      assert.equal(requestStand(hero), true);
      assert.equal(requestStand(hero), false);
      for (let i = 0; i < 30; i++) stepHomePose(hero, noInput, 1 / 60);
      assert.equal(hero.pose, null);
      assert.deepEqual([hero.x, hero.z], original);
      assert.equal(circleVsAABBs(hero.x, hero.z, HERO_RADIUS, layout.colliders), null);
    }
  }
  const bad = makePedestrian(-4.4, -0.8, 0);
  assert.equal(startHomePose(bad, layout.interactions[0], layout), false);
});

test('стик поднимает героя после отпускания; пауза (нулевой dt) не меняет позу', () => {
  const item = layout.interactions[0], hero = makePedestrian(item.x, item.z, 0);
  assert.equal(startHomePose(hero, item, layout), true);
  for (let i = 0; i < 3; i++) stepHomePose(hero, noInput, 0.1);
  const before = hero.pose.amount;
  stepHomePose(hero, noInput, 0);
  assert.equal(hero.pose.amount, before);
  stepHomePose(hero, moving, 0.1);
  assert.equal(hero.pose.leaving, true);
  for (let i = 0; i < 10; i++) stepHomePose(hero, moving, 0.1);
  assert.equal(hero.pose, null);
});

test('старые и повреждённые сохранения домов восстанавливаются; сброс не трогает настройки', async () => {
  let raw = JSON.stringify({ money: 123, settings: { sound: false }, homeStates: {
    371: { tv: true, light: false, water: 'bad', book: true }, 12: null,
    '99999999': { tv: true }, '__proto__': { tv: true },
  } });
  globalThis.localStorage = { getItem: () => raw, setItem: (_k, v) => { raw = v; } };
  const save = await import('../js/save.js?home-test');
  const s = save.loadSave();
  assert.equal(s.money, 123);
  assert.deepEqual(s.homeStates, { 371: { ...HOME_DEFAULTS, tv: true, light: false, book: true } });
  s.homeStates[372] = makeHomeState({ water: true });
  save.markDirty(); save.flushNow();
  assert.equal(JSON.parse(raw).homeStates['372'].water, true);
  const reset = save.resetSave();
  assert.deepEqual(reset.homeStates, {});
  assert.equal(reset.settings.sound, false);
});
