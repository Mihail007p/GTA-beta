// Домашние действия не зависят от Three.js и DOM. Визуальная поза находится
// на мебели, но физическая позиция героя остаётся в свободной точке рядом:
// поэтому при вставании коллизии не выталкивают его сквозь мебель/стены.
import { circleVsAABBs } from './city.js';
import { HERO_RADIUS } from './pedestrian.js';

export const HOME_DEFAULTS = Object.freeze({
  light: true, tv: false, water: false, stove: false, cabinet: false, book: false,
});

export function makeHomeState(saved) {
  const state = {};
  for (const [key, fallback] of Object.entries(HOME_DEFAULTS)) {
    state[key] = typeof saved?.[key] === 'boolean' ? saved[key] : fallback;
  }
  return state;
}

// Маркеры находятся перед предметами и не требуют входить в их коллайдеры.
// Все координаты производятся из мебели, чтобы не расходиться с геометрией.
export function makeHomeInteractions(props) {
  const prop = name => {
    const result = props.find(p => p.kind === name);
    if (!result) throw new Error('В доме отсутствует предмет: ' + name);
    return result;
  };
  const sofa = prop('sofa'), bed = prop('bed'), table = prop('table');
  const kitchen = prop('kitchen'), cabinet = prop('cabinet'), tv = prop('television');
  return [
    { id: 'sofa', kind: 'sit', x: sofa.x + sofa.hw + 0.45, z: sofa.z, reach: 0.82,
      visual: { x: sofa.x + 0.48, z: sofa.z, y: -0.34, heading: 0 },
      focus: { x: sofa.x + 0.48, z: sofa.z, y: 0.91 }, camera: { yaw: -2.65, pitch: 0.24 } },
    { id: 'bed', kind: 'lie', x: bed.x + 0.65, z: bed.z + bed.hd + 0.48, reach: 0.82,
      visual: { x: bed.x + 0.65, z: bed.z + 0.86, y: 0.84, heading: Math.PI / 2 },
      focus: { x: bed.x + 0.65, z: bed.z, y: 0.95 }, camera: { yaw: -2.1, pitch: 0.42 } },
    { id: 'book', kind: 'toggle', flag: 'book', x: table.x, z: table.z + table.hd + 0.48, reach: 0.75,
      target: { x: table.x - 0.22, z: table.z } },
    { id: 'water', kind: 'toggle', flag: 'water', x: kitchen.x - 0.8, z: kitchen.z + kitchen.hd + 0.48, reach: 0.72,
      target: { x: kitchen.x - 0.8, z: kitchen.z } },
    { id: 'stove', kind: 'toggle', flag: 'stove', x: kitchen.x + 0.9, z: kitchen.z + kitchen.hd + 0.48, reach: 0.72,
      target: { x: kitchen.x + 0.9, z: kitchen.z } },
    { id: 'cabinet', kind: 'toggle', flag: 'cabinet', x: cabinet.x - cabinet.hw - 1.02, z: cabinet.z, reach: 0.72,
      target: { x: cabinet.x - cabinet.hw, z: cabinet.z } },
    { id: 'tv', kind: 'toggle', flag: 'tv', x: tv.x - 0.85, z: tv.z, reach: 0.82, target: { x: tv.x, z: tv.z } },
    { id: 'light', kind: 'toggle', flag: 'light', x: 1.65, z: 4.75, reach: 0.75, target: { x: 1.65, z: 5.68 } },
  ];
}

export function nearestHomeInteraction(hero, interactions) {
  let best = null, bestDistance = Infinity;
  for (const item of interactions || []) {
    const d = Math.hypot(hero.x - item.x, hero.z - item.z);
    if (d <= item.reach && d < bestDistance) { best = item; bestDistance = d; }
  }
  return best;
}

export function homeActionMode(item, state) {
  if (!item) return 'none';
  if (item.kind === 'sit' || item.kind === 'lie') return 'home-' + item.kind;
  if (item.kind === 'toggle' && Object.prototype.hasOwnProperty.call(HOME_DEFAULTS, item.flag)) {
    return `home-${item.flag}-${state[item.flag] ? 'off' : 'on'}`;
  }
  return 'none';
}

export function toggleHomeItem(state, item) {
  if (item?.kind !== 'toggle' || !Object.prototype.hasOwnProperty.call(HOME_DEFAULTS, item.flag)) return false;
  state[item.flag] = !state[item.flag];
  return true;
}

export function startHomePose(hero, item, layout) {
  if (hero.pose || (item?.kind !== 'sit' && item?.kind !== 'lie')) return false;
  // Не запоминаем потенциально небезопасную точку вставания.
  if (circleVsAABBs(hero.x, hero.z, HERO_RADIUS - 0.005, layout.colliders)) return false;
  hero.vx = hero.vz = hero.speed = 0;
  hero.running = false;
  hero.pose = { kind: item.kind, visual: item.visual, focus: item.focus,
    amount: 0, leaving: false, moveReady: false };
  hero.camYaw = item.camera.yaw;
  hero.camPitch = item.camera.pitch;
  return true;
}

export function requestStand(hero) {
  if (!hero.pose || hero.pose.leaving) return false;
  hero.pose.leaving = true;
  return true;
}

// На стул/кровать можно попасть, удерживая стик другим пальцем. Чтобы не
// встать мгновенно, движение начинает вставание только после отпускания стика.
export function stepHomePose(hero, input, dt) {
  const pose = hero.pose;
  if (!pose) return false;
  const moving = Math.hypot(input.x || 0, input.y || 0) > 0.12;
  if (!moving) pose.moveReady = true;
  else if (pose.moveReady) pose.leaving = true;
  const step = Math.max(0, Math.min(dt, 0.1)) / 0.42;
  pose.amount = Math.max(0, Math.min(1, pose.amount + (pose.leaving ? -step : step)));
  hero.vx = hero.vz = hero.speed = 0;
  hero.running = false;
  if (pose.leaving && pose.amount <= 0) hero.pose = null;
  return true;
}
