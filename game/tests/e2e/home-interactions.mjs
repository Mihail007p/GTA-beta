// Игровой маршрут с настоящими касаниями стика/кнопок. Это эмуляция браузера,
// не тест на физическом Android-устройстве. Сервер: node tools/server.mjs 8080.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.GAME_URL || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (fn, arg = null, timeout = 100000) => page.waitForFunction(fn, arg, { timeout });
const center = async selector => {
  const b = await page.locator(selector).boundingBox();
  assert.ok(b, `не видна кнопка ${selector}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
const tap = async selector => { const p = await center(selector); await page.touchscreen.tap(p.x, p.y); };
const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })),
});
const note = text => console.log('  ✓ ' + text);
const shot = async name => {
  if (!process.env.E2E_SHOTS) return;
  await fs.mkdir(process.env.E2E_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + '.png') });
};
const label = text => wait(text => {
  const b = document.querySelector('#vehicle-action');
  return !b.classList.contains('hidden') && b.getAttribute('aria-label') === text;
}, text);

// Действительный левый стик: камера может быть повёрнута, поэтому переводим
// мировой вектор движения в координаты экрана. В узких местах не включаем бег.
async function walkAxis(axis, target, tolerance = 0.16, run = false) {
  const info = await page.evaluate(({ axis, target }) => {
    const h = __game.hero, delta = target - h[axis], sign = Math.sign(delta);
    const vx = axis === 'x' ? sign : 0, vz = axis === 'z' ? sign : 0;
    return { sign, remaining: Math.abs(delta), sx: -vx * Math.sin(h.camYaw) + vz * Math.cos(h.camYaw),
      sy: vx * Math.cos(h.camYaw) + vz * Math.sin(h.camYaw) };
  }, { axis, target });
  if (info.remaining <= tolerance) return;
  const start = { x: 115, y: 275, id: 1 };
  const move = { x: Math.round(start.x + info.sx * 55), y: Math.round(start.y - info.sy * 55), id: 1 };
  await touch('touchStart', [start]);
  await touch('touchMove', [move]);
  if (run) await touch('touchStart', [move, { ...(await center('[data-foot="run"]')), id: 2 }]);
  try {
    await wait(({ axis, target, sign, tolerance }) => sign * (__game.hero[axis] - target) >= -tolerance,
      { axis, target, sign: info.sign, tolerance }, 55000);
  } catch (err) {
    console.error('Не дошли', axis, target, await page.evaluate(() => ({ hero: __game.hero, room: __game.interior?.layout.kind })));
    throw err;
  } finally { await touch('touchEnd', []); }
  await wait(() => __game.hero.speed < 0.2);
}
async function assertFree() {
  const hit = await page.evaluate(async () => {
    const { circleVsAABBs } = await import('./js/city.js');
    return circleVsAABBs(__game.hero.x, __game.hero.z, 0.375, __game.interior.layout.colliders)?.item.kind || null;
  });
  assert.equal(hit, null, `герой застрял в ${hit}`);
}
async function checkSit() {
  return page.evaluate(() => {
    const { R, interior } = __game, actor = R.heroActor;
    actor.root.updateMatrixWorld(true);
    const world = n => { const v = R._tmp.v; actor.bones.find(b => b.name === n).getWorldPosition(v); return [v.x, v.y, v.z]; };
    const sofa = interior.layout.props.find(p => p.kind === 'sofa');
    return { visible: actor.root.visible, rootY: actor.root.position.y, pelvis: world('pelvis'),
      knee: world('calf_l'), foot: world('foot_l'), sofaFront: sofa.x + sofa.hw };
  });
}
async function checkLie() {
  return page.evaluate(() => {
    const { R, interior } = __game, actor = R.heroActor;
    actor.root.updateMatrixWorld(true);
    const world = n => { const v = R._tmp.v; actor.bones.find(b => b.name === n).getWorldPosition(v); return [v.x, v.y, v.z]; };
    const bed = interior.layout.props.find(p => p.kind === 'bed');
    return { visible: actor.root.visible, rotX: actor.root.rotation.x, head: world('head'), pelvis: world('pelvis'), foot: world('foot_l'),
      bed: { x: bed.x, z: bed.z, hw: bed.hw, hd: bed.hd } };
  });
}
const closeTo = (a, b, tol) => Math.abs(a - b) < tol;
async function checkToggle(flag, expected, actionLabel, reverseLabel) {
  await label(actionLabel);
  await tap('#vehicle-action');
  await wait(({ flag, expected }) => __game.interior.homeState[flag] === expected, { flag, expected });
  await label(reverseLabel);
}

try {
  // Старое сохранение без домашних данных — деньги и герой не сбрасываются.
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('openstreet.save.v1')) localStorage.setItem('openstreet.save.v1', JSON.stringify({
      version: 1, money: 7500, bestScore: 4321, ownedCars: ['strada'], activeCar: 'strada',
      selectedCharacter: 'hero-1', settings: { sound: false, quality: 'low' },
    }));
  });
  await page.goto(base + '/?shot&noaudio');
  await wait(() => window.__game?.state === 'menu');
  await page.evaluate(() => __game.R.setQuality('low'));
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.onFoot && __game.R.heroVisible);
  const home = await page.evaluate(() => __game.entrances.find(d => d.id === 371));
  await walkAxis('z', -7, 0.7, true);
  await walkAxis('x', home.x, 0.7, true);
  await walkAxis('z', home.z, 0.7, true);
  await label('Войти в дом'); await tap('#vehicle-action');
  await wait(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore]), [7500, 4321]);
  await shot('home-entrance');
  note('стиком дошли от машины до дома и вошли обычной кнопкой');

  // Книга: и открытие, и закрытие меняют реальную геометрию.
  await walkAxis('x', -1.9); await walkAxis('z', 0.43);
  await checkToggle('book', true, 'Открыть книгу', 'Закрыть книгу');
  await wait(() => __game.R.interiorScene.userData.home.book.rotation.x < -2.0);
  await checkToggle('book', false, 'Закрыть книгу', 'Открыть книгу');
  await wait(() => Math.abs(__game.R.interiorScene.userData.home.book.rotation.x) < 0.2);
  await checkToggle('book', true, 'Открыть книгу', 'Закрыть книгу');

  // В узкий проход у дивана идём без телепортации; коллизии всё время включены.
  await walkAxis('z', 1.5); await walkAxis('x', -3.2, 0.045); await walkAxis('z', -0.8);
  await label('Сесть на диван');
  await tap('#vehicle-action');
  await tap('#btn-pause'); await wait(() => __game.state === 'pause' && !!__game.hero.pose);
  const pausedAt = await page.evaluate(() => __game.hero.pose.amount);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => __game.hero.pose.amount), pausedAt);
  await tap('#pause-resume'); await wait(() => __game.hero.pose?.kind === 'sit' && __game.hero.pose.amount === 1);
  await label('Встать'); await assertFree();
  let pose = await checkSit();
  assert.ok(pose.visible && pose.pelvis[1] > 0.45 && pose.pelvis[1] < 0.7, JSON.stringify(pose));
  assert.ok(pose.knee[0] > pose.sofaFront && pose.foot[0] > pose.sofaFront && pose.foot[1] > 0 && pose.foot[1] < 0.25, JSON.stringify(pose));
  await shot('home-sit-hero1');
  assert.equal(await page.locator('#home-tv-action').getAttribute('aria-label'), 'Включить телевизор с дивана');
  await tap('#home-tv-action');
  await wait(() => __game.interior.homeState.tv && __game.R.interiorScene.userData.home.tvPicture.visible);
  assert.equal(await page.locator('#home-tv-action').getAttribute('aria-label'), 'Выключить телевизор с дивана');
  note('герой сидит с согнутыми ногами; пауза сохраняет позу; телевизор включается с дивана');

  // Двигаем правой частью экрана камеру, затем встаём настоящим стиком.
  const yaw = await page.evaluate(() => __game.hero.camYaw);
  await touch('touchStart', [{ x: 520, y: 150, id: 8 }]);
  await touch('touchMove', [{ x: 600, y: 150, id: 8 }]);
  await wait(old => Math.abs(Math.atan2(Math.sin(__game.hero.camYaw - old), Math.cos(__game.hero.camYaw - old))) > 0.2, yaw);
  await touch('touchEnd', []);
  const start = { x: 115, y: 275, id: 1 }, move = { x: 115, y: 220, id: 1 };
  await touch('touchStart', [start]); await touch('touchMove', [move]);
  await wait(() => !__game.hero.pose); await touch('touchEnd', []); await wait(() => __game.hero.speed < 0.2);
  await assertFree();
  assert.equal(await page.locator('#home-tv-action').isVisible(), false);
  note('поворот камеры работает сидя, движение стика поднимает героя на свободное место');

  await walkAxis('z', 1.5); await walkAxis('x', 1.6); await walkAxis('z', -3.99);
  await checkToggle('water', true, 'Открыть кран', 'Закрыть кран');
  assert.equal(await page.evaluate(() => __game.R.interiorScene.userData.home.water.visible), true);
  await walkAxis('x', 3.3);
  await checkToggle('stove', true, 'Включить плиту', 'Выключить плиту');
  assert.equal(await page.evaluate(() => __game.R.interiorScene.userData.home.burners.visible), true);
  await walkAxis('z', -3.4); await walkAxis('x', 3.55);
  await checkToggle('cabinet', true, 'Открыть шкаф', 'Закрыть шкаф');
  await wait(() => __game.R.interiorScene.userData.home.doors[0].rotation.y < -1);
  await assertFree(); await shot('home-open-cabinet');
  await walkAxis('z', -0.8); await walkAxis('x', 4.83);
  await checkToggle('tv', false, 'Выключить телевизор', 'Включить телевизор');
  assert.equal(await page.evaluate(() => __game.R.interiorScene.userData.home.tvPicture.visible), false);
  await checkToggle('tv', true, 'Включить телевизор', 'Выключить телевизор');
  await walkAxis('x', 1.65); await walkAxis('z', 4.75);
  await checkToggle('light', false, 'Выключить свет', 'Включить свет');
  assert.equal(await page.evaluate(() => __game.R.interiorScene.userData.home.ambient.intensity), 0.5);
  await shot('home-light-off');
  await checkToggle('light', true, 'Включить свет', 'Выключить свет');
  note('книга, кран, плита, шкаф, ТВ и свет переключаются; состояние видно в комнате');

  // Кровать: доходим вокруг стола, а не сквозь него.
  await walkAxis('x', -0.4); await walkAxis('z', -2.77); await walkAxis('x', -2.55);
  await label('Лечь на кровать'); await tap('#vehicle-action');
  await wait(() => __game.hero.pose?.kind === 'lie' && __game.hero.pose.amount === 1);
  await label('Встать'); await assertFree();
  pose = await checkLie();
  assert.ok(pose.visible && closeTo(pose.rotX, -Math.PI / 2, 0.01), JSON.stringify(pose));
  assert.ok(pose.head[2] < pose.pelvis[2] - 0.3 && pose.foot[2] > pose.pelvis[2] + 0.3, JSON.stringify(pose));
  assert.ok(pose.head[1] > 0.7 && pose.head[1] < 1.2 && Math.abs(pose.head[0] - pose.bed.x) < pose.bed.hw, JSON.stringify(pose));
  await shot('home-lie-hero1');

  // Смена героя через меню при активной позе: новый скелет должен лечь так же.
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await tap('#pause-menu'); await wait(() => __game.state === 'menu');
  await tap('#btn-character'); await wait(() => __game.state === 'character' && __game.R.heroVisible);
  await tap('#character-next'); await wait(() => __game.R.heroId === 'hero-2' && __game.R.heroVisible);
  await tap('#character-action'); await tap('#character-back'); await wait(() => __game.state === 'menu');
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.inInterior && __game.R.heroId === 'hero-2' && __game.hero.pose?.kind === 'lie');
  await wait(() => __game.R.heroActor.root.rotation.x < -1.5 && __game.R.heroActor.root.parent === __game.R.interiorScene);
  pose = await checkLie();
  assert.ok(pose.visible && closeTo(pose.rotX, -Math.PI / 2, 0.01) && pose.head[2] < pose.pelvis[2] - 0.3, JSON.stringify(pose));
  await shot('home-lie-hero2');
  await label('Встать'); await tap('#vehicle-action'); await wait(() => !__game.hero.pose); await assertFree();
  await walkAxis('x', -3.2, 0.045); await walkAxis('z', -0.8);
  await label('Сесть на диван'); await tap('#vehicle-action');
  await wait(() => __game.hero.pose?.kind === 'sit' && __game.hero.pose.amount === 1);
  pose = await checkSit();
  assert.ok(pose.visible && pose.knee[0] > pose.sofaFront && pose.foot[1] > 0 && pose.foot[1] < 0.25, JSON.stringify(pose));
  await shot('home-sit-hero2');
  await tap('#btn-reset'); await wait(() => !__game.hero.pose);
  assert.ok(await page.evaluate(() => Math.hypot(__game.hero.x - __game.interior.layout.spawn.x, __game.hero.z - __game.interior.layout.spawn.z) < 0.1));
  assert.equal(await page.locator('#home-tv-action').isVisible(), false);
  note('оба героя могут лежать и сидеть; смена героя и кнопка ⟲ не оставляют застрявшую позу');

  await walkAxis('z', 5.15); await label('Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  const before = await page.evaluate(() => ({ ...__game.R.renderer.info.memory }));
  const after = [];
  // Быстрые повторные посещения: перемещаемся только по улице/к выходу,
  // реальные касания открывают и закрывают сцены.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const d = __game.entrances.find(e => e.id === 371);
      Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
    });
    await label('Войти в дом'); await tap('#vehicle-action');
    await wait(() => __game.interior && !__game.roomTransition);
    assert.deepEqual(await page.evaluate(() => __game.interior.homeState),
      { light: true, tv: true, water: true, stove: true, cabinet: true, book: true });
    const draws = await page.evaluate(() => __game.R.renderer.info.render.calls);
    assert.ok(draws < 75, `слишком много draw calls в доме: ${draws}`);
    await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.15, vx: 0, vz: 0, speed: 0 }));
    await label('Выйти на улицу'); await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
    after.push(await page.evaluate(() => ({ ...__game.R.renderer.info.memory })));
  }
  for (const memory of after) {
    assert.ok(memory.geometries <= before.geometries + 1, JSON.stringify({ before, after }));
    assert.ok(memory.textures <= before.textures + 1, JSON.stringify({ before, after }));
  }

  // Другой дом не наследует переключатели первого.
  await page.evaluate(() => {
    const d = __game.entrances.find(e => e.kind === 'home' && e.id !== 371);
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await label('Войти в дом'); await tap('#vehicle-action'); await wait(() => __game.interior && !__game.roomTransition);
  assert.deepEqual(await page.evaluate(() => __game.interior.homeState),
    { light: true, tv: false, water: false, stove: false, cabinet: false, book: false });
  note('состояние предметов отдельно для каждого дома, повторные посещения не копят ресурсы');

  // Прогресс и новые модули работают после перезагрузки без сети.
  await wait(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const source = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const version = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
    const cache = await caches.open(`openstreet:${r.scope}:${version}`);
    return !!(await cache.match('js/home-interactions.js'));
  });
  assert.equal(cached, true);
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await ctx.setOffline(true); await page.reload();
  await wait(() => window.__game?.state === 'menu' && __game.R.heroId === 'hero-2', null, 150000);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore]), [7500, 4321]);
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.heroVisible);
  await page.evaluate(() => {
    const d = __game.entrances.find(e => e.id === 371);
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await label('Войти в дом'); await tap('#vehicle-action'); await wait(() => __game.interior && !__game.roomTransition);
  assert.deepEqual(await page.evaluate(() => __game.interior.homeState),
    { light: true, tv: true, water: true, stove: true, cabinet: true, book: true });
  assert.equal(await page.evaluate(() => __game.R.interiorScene.userData.home.tvPicture.visible && __game.R.interiorScene.userData.home.water.visible), true);
  await page.evaluate(() => {
    const item = __game.interior.layout.interactions.find(i => i.id === 'bed');
    Object.assign(__game.hero, { x: item.x, z: item.z, vx: 0, vz: 0, speed: 0 });
  });
  await label('Лечь на кровать'); await tap('#vehicle-action');
  await wait(() => __game.hero.pose?.kind === 'lie' && __game.hero.pose.amount === 1);
  await label('Встать'); await tap('#vehicle-action'); await wait(() => !__game.hero.pose); await assertFree();
  note('после офлайн-перезагрузки сохранения и взаимодействие с кроватью работают');

  assert.deepEqual(errors, [], 'ошибки страницы или консоли');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally { await browser.close(); }
