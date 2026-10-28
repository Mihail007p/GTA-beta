// Путь игрока: старое сохранение, выбор героя, мультитач, пауза,
// возвращение в свою машину и офлайн. Сервер: node tools/server.mjs 8080.
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
const wait = (predicate, arg = null, timeout = 90000) => page.waitForFunction(predicate, arg, { timeout });
const note = msg => console.log('  ✓ ' + msg);
const tap = async selector => {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `нет элемента ${selector}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};
const center = async selector => {
  const b = await page.locator(selector).boundingBox();
  assert.ok(b, `нет элемента ${selector}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
const shot = async name => {
  if (process.env.E2E_SHOTS) {
    await fs.mkdir(process.env.E2E_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + '.png') });
  }
};
const snapshot = () => page.evaluate(() => ({
  state: __game.state, onFoot: __game.onFoot,
  x: __game.hero?.x, z: __game.hero?.z, speed: __game.hero?.speed, running: __game.hero?.running,
  carX: __game.car.x, carZ: __game.car.z, camYaw: __game.hero?.camYaw,
  id: __game.R.heroId, chosen: __game.save.selectedCharacter,
}));

try {
  // У старых сохранений отсутствует selectedCharacter. Прогресс должен остаться.
  await ctx.addInitScript(() => {
    const key = 'openstreet.save.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
      version: 1, money: 1234, bestScore: 4321, ownedCars: ['strada'], activeCar: 'strada',
      settings: { sound: false, quality: 'low' },
    }));
  });
  await page.goto(base + '/?shot&noaudio');
  await wait(() => window.__game?.state === 'menu');
  await page.evaluate(() => __game.R.setQuality('low'));
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.selectedCharacter]), [1234, 4321, 'hero-1']);
  note('старое сохранение не потеряно и получает героя по умолчанию');

  await tap('#btn-character');
  await wait(() => __game.state === 'character' && __game.R.heroVisible && __game.R.heroId === 'hero-1');
  // Задерживаем загрузку второго героя и сразу выходим назад. Поздняя
  // загрузка не должна подменить первого героя в меню.
  const race = await page.evaluate(async () => {
    const originalFetch = window.fetch, renderer = __game.R, setHero = renderer.setHero.bind(renderer);
    let release, pending;
    window.fetch = (request, init) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.includes('hero-2.glb')) return new Promise(resolve => { release = () => resolve(originalFetch(request, init)); });
      return originalFetch(request, init);
    };
    renderer.setHero = id => {
      const p = setHero(id);
      if (id === 'hero-2') pending = p;
      return p;
    };
    try {
      document.querySelector('#character-next').click();
      for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 20));
      if (!release || !pending) throw new Error('загрузка второй модели не началась');
      document.querySelector('#character-back').click();
      release();
      const result = await pending;
      return { result, state: __game.state, actor: renderer.heroId, selected: __game.save.selectedCharacter };
    } finally { window.fetch = originalFetch; renderer.setHero = setHero; }
  });
  assert.deepEqual(race, { result: false, state: 'menu', actor: 'hero-1', selected: 'hero-1' });
  note('быстрый выход при загрузке другой модели не подменяет выбранного героя');
  await tap('#btn-character');
  await wait(() => __game.state === 'character' && __game.R.heroVisible && __game.R.heroId === 'hero-1');
  await tap('#character-next');
  await wait(() => __game.R.heroVisible && __game.R.heroId === 'hero-2');
  await shot('character-2');
  await tap('#character-action');
  assert.deepEqual(await page.evaluate(() => [__game.save.selectedCharacter, JSON.parse(localStorage.getItem('openstreet.save.v1')).selectedCharacter]), ['hero-2', 'hero-2']);
  await tap('#character-back');
  await page.reload();
  await wait(() => window.__game?.state === 'menu' && __game.R.heroId === 'hero-2');
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.selectedCharacter]), [1234, 4321, 'hero-2']);
  await page.evaluate(() => __game.R.setQuality('low'));
  note('выбранный герой и старый прогресс переживают перезагрузку');

  await tap('#btn-play');
  await wait(() => __game.state === 'play' && !__game.onFoot);
  // Синхронно: не даём физике затормозить до проверки.
  const blocked = await page.evaluate(() => {
    Object.assign(__game.car, { vx: 2, vz: 0, speed: 2 });
    document.querySelector('#vehicle-action').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const result = { onFoot: __game.onFoot, message: document.querySelector('#toast').textContent };
    Object.assign(__game.car, { vx: 0, vz: 0, speed: 0, yawRate: 0 });
    return result;
  });
  assert.equal(blocked.onFoot, false);
  assert.match(blocked.message, /останов/i);
  await tap('#vehicle-action');
  await wait(() => __game.onFoot && __game.R.heroActor?.root.visible);
  assert.equal(await page.locator('[data-foot="stick"]').isVisible(), true);
  assert.equal(await page.locator('[data-btn="gas"]').isVisible(), false);
  note('из движущейся машины выйти нельзя; касание переключает на пешее управление');
  await shot('on-foot');

  // При очень ранней паузе гараж должен вернуть на паузу, а не в главное меню.
  await page.evaluate(() => { __game.g.runTime = 0; });
  await tap('#btn-pause');
  await wait(() => __game.state === 'pause');
  await tap('#pause-garage');
  await wait(() => __game.state === 'garage');
  await tap('#garage-back');
  await wait(() => __game.state === 'pause');
  assert.equal(await page.evaluate(() => __game.onFoot), true);
  await tap('#pause-resume');
  await wait(() => __game.state === 'play' && __game.onFoot && __game.R.heroVisible);
  note('гараж, открытый из ранней паузы пешком, возвращает в паузу и затем в игру');

  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })),
  });
  const start = { x: 120, y: 270, id: 1 };
  let stick = { x: 120, y: 210, id: 1 };
  const before = await snapshot();
  await touch('touchStart', [start]);
  await touch('touchMove', [stick]);
  await wait(() => __game.hero.speed > 0.7 && !__game.hero.running && __game.R.heroActor.actions.walk.getEffectiveWeight() > 0.1);
  const t1 = await page.evaluate(() => __game.R.heroActor.actions.walk.time);
  await wait(t => Math.abs(__game.R.heroActor.actions.walk.time - t) > 0.05, t1);
  const walked = await snapshot();
  assert.ok(Math.hypot(walked.x - before.x, walked.z - before.z) > 0.1);
  await shot('walk-1');
  await page.waitForTimeout(450);
  await shot('walk-2');
  note('левый сенсорный стик двигает героя и проигрывает ходьбу');

  const run = { ...(await center('[data-foot="run"]')), id: 2 };
  await touch('touchStart', [stick, run]);
  await wait(() => __game.hero.running && __game.hero.speed > 2.15 && __game.R.heroActor.actions.run.getEffectiveWeight() > 0.1);
  const r1 = await page.evaluate(() => __game.R.heroActor.actions.run.time);
  await wait(t => Math.abs(__game.R.heroActor.actions.run.time - t) > 0.05, r1);
  await shot('run-1');
  await page.waitForTimeout(450);
  await shot('run-2');
  await wait(() => Math.hypot(__game.hero.x - __game.car.x, __game.hero.z - __game.car.z) > 7);
  note('стик + удержание кнопки БЕГ одновременно ускоряют героя и включают бег');

  const yaw = await page.evaluate(() => __game.hero.camYaw);
  const look = { x: 510, y: 140, id: 3 }, lookMoved = { x: 630, y: 165, id: 3 };
  await touch('touchStart', [stick, run, look]);
  await touch('touchMove', [stick, run, lookMoved]);
  await wait(y => Math.abs(__game.hero.camYaw - y) > 0.3 && __game.hero.running, yaw);
  await touch('touchEnd', []);
  await wait(() => __game.footInput.stickId === null && __game.footInput.runId === null && __game.footInput.lookId === null);
  note('третий палец вращает камеру без прерывания бега; отпускание не залипает');

  await tap('#vehicle-action');
  assert.equal((await snapshot()).onFoot, true);
  assert.match(await page.locator('#toast').textContent(), /подойдите/i);
  // Пауза вторым пальцем не должна оставлять нажатый стик.
  await page.evaluate(() => { __game.g.timeLeft = 10; __game.g.chain = 1; });
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => __game.g.timeLeft), 10, 'таймер чекпоинтов шёл пешком');
  const pausePoint = { ...(await center('#btn-pause')), id: 2 };
  await touch('touchStart', [start]);
  await touch('touchMove', [stick]);
  await touch('touchStart', [stick, pausePoint]);
  await wait(() => __game.state === 'pause');
  assert.equal(await page.evaluate(() => __game.footInput.stickId), null, 'стик залип при паузе');
  await touch('touchEnd', []);
  const far = await snapshot();
  await page.waitForTimeout(700);
  const paused = await snapshot();
  assert.equal(paused.x, far.x); assert.equal(paused.z, far.z);
  await tap('#pause-resume');
  await wait(() => __game.state === 'play' && __game.onFoot);
  note('издалека сесть нельзя; пауза не двигает героя, продолжение сохраняет позицию');

  // Направляем стик к машине относительно текущего угла камеры.
  const target = await page.evaluate(() => {
    const h = __game.hero, c = __game.car, dx = c.x - h.x, dz = c.z - h.z;
    const len = Math.hypot(dx, dz), cos = Math.cos(h.camYaw), sin = Math.sin(h.camYaw);
    return { x: (-dx * sin + dz * cos) / len, y: (dx * cos + dz * sin) / len };
  });
  stick = { x: Math.round(start.x + target.x * 60), y: Math.round(start.y - target.y * 60), id: 1 };
  await touch('touchStart', [start]);
  await touch('touchMove', [stick]);
  await touch('touchStart', [stick, run]);
  await wait(() => Math.hypot(__game.hero.x - __game.car.x, __game.hero.z - __game.car.z) < 3.2, null, 120000);
  await touch('touchEnd', []);
  await tap('#vehicle-action');
  await wait(() => !__game.onFoot);
  assert.equal(await page.locator('[data-btn="gas"]').isVisible(), true);
  assert.equal(await page.locator('[data-foot="stick"]').isVisible(), false);
  note('игрок вернулся к машине с помощью стика и снова сел за руль');

  // Два рабочих пальца + отдельный свайп камеры в машине.
  const left = { ...(await center('[data-arrow="left"]')), id: 1 };
  const gas = { ...(await center('[data-btn="gas"]')), id: 2 };
  const carLook = { x: 510, y: 150, id: 3 }, carLookMoved = { x: 610, y: 175, id: 3 };
  const yawBefore = await page.evaluate(() => __game.R.driveLookYaw);
  await touch('touchStart', [left, gas]);
  await touch('touchStart', [left, gas, carLook]);
  await touch('touchMove', [left, gas, carLookMoved]);
  await wait(y => __game.input.state.throttle === 1 && __game.input.state.steer < -0.3 && Math.abs(__game.R.driveLookYaw - y) > 0.3, yawBefore);
  await touch('touchEnd', []);
  note('газ, руль и свайп камеры в машине работают одновременно');

  // Респаун пешком возвращает к текущей машине, а не переносит её.
  await page.evaluate(() => Object.assign(__game.car, { vx: 0, vz: 0, speed: 0, yawRate: 0 }));
  await tap('#vehicle-action');
  await wait(() => __game.onFoot);
  await page.evaluate(() => { __game.hero.x += 20; __game.hero.vx = __game.hero.vz = 0; });
  const carBeforeReset = await page.evaluate(() => [__game.car.x, __game.car.z]);
  await tap('#btn-reset');
  const reset = await snapshot();
  assert.ok(Math.hypot(reset.x - reset.carX, reset.z - reset.carZ) < 5);
  assert.deepEqual([reset.carX, reset.carZ], carBeforeReset);
  note('кнопка возврата пешком переносит к своей машине, не сдвигая её');

  // Ждём установки ВСЕХ файлов, затем загружаем другую модель уже без сети.
  const cacheEntries = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const source = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const version = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
    const name = version && `openstreet:${registration.scope}:${version}`;
    if (!name || !(await caches.has(name))) throw new Error('Текущий офлайн-кэш не установлен');
    const cache = await caches.open(name);
    return Promise.all(['assets/characters/hero-1.glb', 'assets/characters/hero-2.glb', 'assets/characters/motion.json', 'js/foot-input.js'].map(async u => !!(await cache.match(u))));
  });
  assert.deepEqual(cacheEntries, [true, true, true, true]);
  await wait(() => !!navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload();
  await wait(() => window.__game?.state === 'menu' && __game.R.heroId === 'hero-2', null, 120000);
  await page.evaluate(() => __game.R.setQuality('low'));
  await tap('#btn-character');
  await tap('#character-prev');
  await wait(() => __game.R.heroVisible && __game.R.heroId === 'hero-1', null, 120000);
  await tap('#character-action');
  await tap('#character-back');
  await tap('#btn-play');
  await wait(() => __game.state === 'play' && __game.R.heroId === 'hero-1');
  await tap('#vehicle-action');
  await wait(() => __game.onFoot && __game.R.heroActor.root.visible);
  assert.equal((await snapshot()).chosen, 'hero-1');
  note('без сети загружаются игра, другая модель героя, движения и пеший режим');

  assert.deepEqual(errors, [], 'ошибки страницы или консоли');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally {
  await browser.close();
}
