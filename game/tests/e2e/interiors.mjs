// Реальные касания: направления камеры, пеший путь к двум дверям, комнаты,
// стены, пауза/гараж/меню, прежняя машина, сохранение и офлайн.
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
const wait = (fn, arg = null, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
const center = async sel => {
  const b = await page.locator(sel).boundingBox();
  assert.ok(b, `элемент ${sel} не виден`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
const tap = async sel => { const p = await center(sel); await page.touchscreen.tap(p.x, p.y); };
const shot = async name => {
  if (!process.env.E2E_SHOTS) return;
  await fs.mkdir(process.env.E2E_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + '.png') });
};
const note = s => console.log('  ✓ ' + s);
const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })),
});
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Проверяем не просто изменение угла, а сторону поворота камеры относительно
// экранного правого вектора. Используется настоящий touchStart/touchMove.
async function swipe(horizontal, driving = false) {
  const before = await page.evaluate(driving => {
    const r = __game.R, v = r.camera.getWorldDirection(r._tmp.v2);
    return { yaw: driving ? r.driveLookYaw : __game.hero.camYaw, camera: [v.x, v.z] };
  }, driving);
  const start = { x: 515, y: 155, id: 8 }, end = { x: 515 + horizontal, y: 155, id: 8 };
  await touch('touchStart', [start]);
  await touch('touchMove', [end]);
  await wait(({ old, sign, driving }) => {
    const value = driving ? __game.R.driveLookYaw : __game.hero.camYaw;
    return sign * Math.atan2(Math.sin(value - old), Math.cos(value - old)) > 0.35;
  }, { old: before.yaw, sign: Math.sign(horizontal), driving });
  await touch('touchEnd', []);
  await wait(({ x, z, sign }) => {
    const r = __game.R, v = r.camera.getWorldDirection(r._tmp.v2);
    const len = Math.hypot(x, z);
    return sign * ((v.x - x) * (-z / len) + (v.z - z) * (x / len)) > 0.025;
  }, { x: before.camera[0], z: before.camera[1], sign: Math.sign(horizontal) });
  const after = await page.evaluate(driving => driving ? __game.R.driveLookYaw : __game.hero.camYaw, driving);
  assert.equal(Math.sign(angleDiff(after, before.yaw)), Math.sign(horizontal));
}

// Ведём персонажа по одной мировой оси, переводя направление на реальный
// левый стик относительно текущей камеры. Бег удерживается вторым пальцем.
async function walkAxis(axis, target, tolerance = 0.7) {
  const startState = await page.evaluate(({ axis, target }) => {
    const h = __game.hero, delta = target - h[axis], sign = Math.sign(delta);
    const vx = axis === 'x' ? sign : 0, vz = axis === 'z' ? sign : 0;
    return { sign, remaining: Math.abs(delta), sx: -vx * Math.sin(h.camYaw) + vz * Math.cos(h.camYaw),
      sy: vx * Math.cos(h.camYaw) + vz * Math.sin(h.camYaw) };
  }, { axis, target });
  if (startState.remaining <= tolerance) return;
  const a = { x: 120, y: 265, id: 1 };
  const b = { x: Math.round(a.x + startState.sx * 58), y: Math.round(a.y - startState.sy * 58), id: 1 };
  const run = { ...(await center('[data-foot="run"]')), id: 2 };
  await touch('touchStart', [a]);
  await touch('touchMove', [b]);
  await touch('touchStart', [b, run]);
  try {
    await wait(({ axis, target, sign, tolerance }) => sign * (__game.hero[axis] - target) >= -tolerance,
      { axis, target, sign: startState.sign, tolerance }, 90000);
  } catch (err) {
    console.error('маршрут прерван', axis, target, await page.evaluate(() => ({ hero: __game.hero, interior: __game.interior?.layout.kind })));
    throw err;
  } finally { await touch('touchEnd', []); }
  await wait(() => __game.hero.speed < 0.2);
}

try {
  await ctx.addInitScript(() => {
    const key = 'openstreet.save.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      version: 1, money: 7500, bestScore: 4321, ownedCars: ['strada', 'vektor'], activeCar: 'vektor',
      selectedCharacter: 'hero-1', settings: { sound: false, quality: 'low' },
    }));
  });
  await page.goto(base + '/?shot&noaudio');
  await wait(() => window.__game?.state === 'menu');
  await page.evaluate(() => __game.R.setQuality('low'));
  await tap('#btn-play');
  await wait(() => __game.state === 'play' && __game.onFoot && __game.R.heroVisible);
  const initial = await page.evaluate(() => ({
    car: [__game.car.x, __game.car.z], money: __game.save.money, score: __game.save.bestScore,
    shop: __game.entrances.filter(e => e.kind === 'shop').sort((a, b) => Math.hypot(a.x - __game.hero.x, a.z - __game.hero.z) - Math.hypot(b.x - __game.hero.x, b.z - __game.hero.z))[0],
    home: __game.entrances.filter(e => e.kind === 'home').sort((a, b) => Math.hypot(a.x - __game.hero.x, a.z - __game.hero.z) - Math.hypot(b.x - __game.hero.x, b.z - __game.hero.z))[0],
  }));
  assert.deepEqual([initial.money, initial.score], [7500, 4321]);
  assert.equal(initial.shop.id, 336); assert.equal(initial.home.id, 371);
  const facadeCost = await page.evaluate(() => {
    const r = __game.R, doors = r.scene.children.filter(o => o.userData.isEntrance);
    r.render(); const withDoors = r.renderer.info.render.calls;
    for (const o of doors) o.visible = false;
    r.render(); const withoutDoors = r.renderer.info.render.calls;
    for (const o of doors) o.visible = true;
    return { meshes: doors.length, extraDrawCalls: withDoors - withoutDoors };
  });
  assert.ok(facadeCost.meshes <= 16 && facadeCost.extraDrawCalls <= 16, JSON.stringify(facadeCost));
  await swipe(100); await swipe(-100);
  note('свайп вправо и влево поворачивает пешую камеру в соответствующую сторону');

  await tap('#vehicle-action'); await wait(() => !__game.onFoot);
  await swipe(100, true); await swipe(-100, true);
  await tap('#vehicle-action'); await wait(() => __game.onFoot && __game.R.heroVisible);
  note('за рулём оба направления камеры также проверены настоящим касанием');

  // От стартовой машины идём сначала по дороге, затем к ближайшему магазину.
  await walkAxis('z', initial.shop.z);
  await walkAxis('x', initial.shop.x);
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
  const outsideShop = await page.evaluate(() => [__game.hero.x, __game.hero.z]);
  await shot('01-shop-entrance');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition);
  assert.equal(await page.evaluate(() => __game.R.heroActor.root.parent === __game.R.interiorScene && __game.R.camHash === __game.interior.hash), true);
  assert.equal(await page.locator('#minimap').isVisible(), false);
  assert.match(await page.locator('#cp-dist').textContent(), /МАГАЗИН/);
  const frozen = await page.evaluate(() => ({ car: [__game.car.x, __game.car.z], traffic: __game.traffic.cars.map(c => [c.x, c.z]), timer: __game.g.timeLeft }));
  await page.waitForTimeout(900);
  assert.deepEqual(await page.evaluate(() => ({ car: [__game.car.x, __game.car.z], traffic: __game.traffic.cars.map(c => [c.x, c.z]), timer: __game.g.timeLeft })), frozen);
  await shot('02-shop-inside');
  note('до магазина дошли стиком; вход работает, улица, машина и таймер не меняются внутри');

  await walkAxis('z', 0.2);
  await swipe(100); await swipe(-100);
  const insideBeforeGarage = await page.evaluate(() => [__game.hero.x, __game.hero.z]);
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await tap('#pause-garage'); await wait(() => __game.state === 'garage');
  assert.equal(await page.evaluate(() => __game.R.inInterior), false);
  await tap('#car-prev');
  await wait(() => document.querySelector('#car-action').textContent.includes('ВЫБРАТЬ'));
  await tap('#car-action');
  assert.equal(await page.evaluate(() => __game.save.activeCar), 'strada');
  await tap('#garage-back'); await wait(() => __game.state === 'pause');
  await tap('#pause-resume'); await wait(() => __game.state === 'play' && __game.R.inInterior);
  assert.ok(await page.evaluate(([x, z]) => Math.hypot(__game.hero.x - x, __game.hero.z - z) < 0.05, insideBeforeGarage));
  assert.equal(await page.evaluate(() => __game.R.heroActor.root.parent === __game.R.interiorScene), true);
  assert.deepEqual(await page.evaluate(() => [__game.car.x, __game.car.z]), initial.car);
  note('ходьба и камера внутри работают; после паузы и смены машины в гараже герой остаётся в магазине');

  await walkAxis('z', 5.15);
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await shot('03-shop-exit');
  // Пауза в тот же момент, что начало перехода: время анимации не идёт в фоне.
  await page.evaluate(() => {
    document.querySelector('#vehicle-action').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.querySelector('#btn-pause').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await wait(() => __game.state === 'pause' && !!__game.roomTransition);
  const pauseAt = await page.evaluate(() => __game.roomTransition.elapsed);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => __game.roomTransition.elapsed), pauseAt);
  await tap('#pause-resume'); await wait(() => !__game.interior && !__game.roomTransition);
  const afterShop = await page.evaluate(() => [__game.hero.x, __game.hero.z]);
  assert.ok(Math.hypot(afterShop[0] - outsideShop[0], afterShop[1] - outsideShop[1]) < 0.1);
  assert.equal(await page.evaluate(() => !__game.R.inInterior && __game.R.camHash === __game.R.outdoorHash), true);
  note('выход возвращает к той же двери; переход корректно останавливается на паузе');

  // Идём по проезжим улицам от магазина к ближайшему дому, не телепортируя героя.
  await walkAxis('x', -7);
  await walkAxis('z', -7);
  await walkAxis('x', initial.home.x);
  await walkAxis('z', initial.home.z);
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в дом');
  const outsideHome = await page.evaluate(() => [__game.hero.x, __game.hero.z]);
  await shot('04-home-entrance');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition);
  await shot('05-home-inside');
  assert.match(await page.locator('#cp-dist').textContent(), /ДОМ/);
  note('до дома также дошли стиком через город и вошли обычной кнопкой');

  // Бежим к боковой стене, затем разворачиваем взгляд так, чтобы камера
  // упиралась в неё: она должна остаться в комнате, а не видеть сквозь дом.
  await walkAxis('x', 5.45, 0.1);
  assert.ok(await page.evaluate(() => __game.hero.x < 5.55));
  await page.evaluate(() => { __game.hero.camYaw = Math.PI; __game.R._camInit = false; });
  await wait(() => __game.R.camera.position.x > 5.4);
  const wall = await page.evaluate(() => ({ camera: [__game.R.camera.position.x, __game.R.camera.position.z],
    height: __game.R.camera.position.y, hero: __game.hero.x }));
  assert.ok(wall.camera[0] <= 5.82 && Math.abs(wall.camera[1]) <= 5.82, JSON.stringify(wall));
  assert.ok(wall.height <= 3.2);
  await tap('#btn-reset');
  assert.equal(await page.evaluate(() => __game.interior?.layout.kind), 'home');
  assert.ok(await page.evaluate(() => Math.hypot(__game.hero.x - __game.interior.layout.spawn.x, __game.hero.z - __game.interior.layout.spawn.z) < 0.1));
  assert.equal(await page.locator('#btn-reset').getAttribute('aria-label'), 'Вернуться к выходу');
  note('стены удерживают героя и камеру; ⟲ внутри возвращает к выходу, а не переносит машину');

  // Смена героя через главное меню, пока открыта комната, не теряет её сцену.
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await tap('#pause-menu'); await wait(() => __game.state === 'menu');
  assert.equal(await page.evaluate(() => __game.R.inInterior), false);
  await tap('#btn-character'); await wait(() => __game.state === 'character' && __game.R.heroVisible);
  await tap('#character-next'); await wait(() => __game.R.heroId === 'hero-2' && __game.R.heroVisible);
  await tap('#character-action'); await tap('#character-back'); await wait(() => __game.state === 'menu');
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.inInterior && __game.R.heroVisible);
  assert.equal(await page.evaluate(() => __game.R.heroActor.root.parent === __game.R.interiorScene && __game.save.selectedCharacter === 'hero-2'), true);
  await walkAxis('z', 5.15);
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  assert.ok(await page.evaluate(([x, z]) => Math.hypot(__game.hero.x - x, __game.hero.z - z) < 0.1, outsideHome));
  assert.deepEqual(await page.evaluate(() => [__game.car.x, __game.car.z]), initial.car);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.activeCar, __game.save.selectedCharacter]), [7500, 4321, 'strada', 'hero-2']);
  note('меню и смена героя сохраняют комнату; выход из дома и ранее припаркованная машина работают');

  // Проверяем прекэш новых модулей и посещение здания после полной перезагрузки без сети.
  await wait(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const source = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const version = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
    const cache = await caches.open(`openstreet:${r.scope}:${version}`);
    return Promise.all(['js/look-controls.js', 'js/interiors.js', 'js/interior-render.js'].map(async u => !!(await cache.match(u))));
  });
  assert.deepEqual(cached, [true, true, true]);
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await ctx.setOffline(true);
  await page.reload(); await wait(() => window.__game?.state === 'menu' && __game.R.heroId === 'hero-2', null, 150000);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.activeCar, __game.save.selectedCharacter]), [7500, 4321, 'strada', 'hero-2']);
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.onFoot && __game.R.heroVisible);
  // Здесь только сокращаем повторный путь; взаимодействие и загрузка комнаты
  // по-прежнему настоящие и выполняются с отключённой сетью.
  await page.evaluate(() => {
    const d = __game.entrances.find(e => e.id === 336);
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition);
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  note('новые модули закэшированы; офлайн-перезагрузка, вход/выход и старый прогресс проверены');

  // Повторные переходы не должны накапливать геометрию и текстуры GPU.
  const memoryBefore = await page.evaluate(() => ({ ...__game.R.renderer.info.memory }));
  const memoryAfter = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const d = __game.entrances.find(e => e.id === 336);
      Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
    });
    await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
    await tap('#vehicle-action'); await wait(() => __game.interior && !__game.roomTransition);
    await wait(() => __game.R.renderer.info.render.calls > 0);
    const calls = await page.evaluate(() => __game.R.renderer.info.render.calls);
    assert.ok(calls < 60, `слишком много вызовов отрисовки в помещении: ${calls}`);
    await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
    await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
    await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
    memoryAfter.push(await page.evaluate(() => ({ ...__game.R.renderer.info.memory })));
  }
  for (const memory of memoryAfter) {
    assert.ok(memory.geometries <= memoryBefore.geometries + 1, JSON.stringify({ memoryBefore, memoryAfter }));
    assert.ok(memory.textures <= memoryBefore.textures + 1, JSON.stringify({ memoryBefore, memoryAfter }));
  }
  note('повторные посещения освобождают ресурсы комнаты; число вызовов отрисовки ограничено');

  // Прерывание перехода до смены сцены и подтверждённый сброс в помещении
  // выполняются только в этом изолированном тестовом профиле.
  await page.evaluate(() => {
    const d = __game.entrances.find(e => e.id === 336);
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
    document.querySelector('#vehicle-action').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.querySelector('#btn-pause').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await wait(() => __game.state === 'pause' && __game.roomTransition && !__game.roomTransition.switched);
  await tap('#pause-menu'); await wait(() => __game.state === 'menu');
  assert.equal(await page.evaluate(() => !__game.roomTransition && !__game.interior && !__game.R.inInterior && document.querySelector('#room-fade').style.opacity === '0'), true);
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.footInput.active);
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
  await tap('#vehicle-action'); await wait(() => __game.interior && !__game.roomTransition);
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await tap('#pause-settings');
  await tap('#btn-reset-save');
  assert.equal(await page.evaluate(() => __game.save.money), 7500, 'первое нажатие не должно сбрасывать прогресс');
  await tap('#btn-reset-save');
  assert.equal(await page.evaluate(() => __game.save.money), 0);
  assert.equal(await page.evaluate(() => !__game.interior && !__game.R.interiorScene && !__game.R.inInterior && __game.onFoot), true);
  await tap('#settings-back'); await tap('#pause-resume');
  await wait(() => __game.state === 'play' && __game.R.heroId === 'hero-1' && __game.R.heroVisible);
  assert.equal(await page.evaluate(() => __game.R.heroActor.root.parent === __game.R.scene), true);
  note('меню отменяет незавершённый переход; подтверждённый сброс безопасно закрывает помещение');

  assert.deepEqual(errors, [], 'ошибки страницы или консоли');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally {
  await browser.close();
}
