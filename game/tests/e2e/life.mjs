// Сквозной маршрут на мобильном viewport с реальными касаниями: магазин,
// покупки, заказ, кухня, еда, шкаф, отдых и офлайн. Это НЕ физический Android.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.GAME_URL || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage(), errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (fn, arg = null, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
const center = async sel => { const b = await page.locator(sel).boundingBox(); assert.ok(b, `не видна кнопка ${sel}`); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; };
const tap = async sel => { const p = await center(sel); await page.touchscreen.tap(p.x, p.y); };
const label = text => wait(t => document.querySelector('#vehicle-action').getAttribute('aria-label') === t && !document.querySelector('#vehicle-action').classList.contains('hidden'), text);
const note = s => console.log('  ✓ ' + s);
const shot = async name => { if (process.env.E2E_SHOTS) { await fs.mkdir(process.env.E2E_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + '.png') }); } };
const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id })) });

async function walkAxis(axis, target, tolerance = 0.35, run = false) {
  const startState = await page.evaluate(({ axis, target }) => {
    const h = __game.hero, sign = Math.sign(target - h[axis]);
    const vx = axis === 'x' ? sign : 0, vz = axis === 'z' ? sign : 0;
    return { sign, remaining: Math.abs(target - h[axis]), sx: -vx * Math.sin(h.camYaw) + vz * Math.cos(h.camYaw), sy: vx * Math.cos(h.camYaw) + vz * Math.sin(h.camYaw) };
  }, { axis, target });
  if (startState.remaining <= tolerance) return;
  const a = { x: 115, y: 275, id: 1 }, b = { x: Math.round(a.x + startState.sx * 55), y: Math.round(a.y - startState.sy * 55), id: 1 };
  await touch('touchStart', [a]); await touch('touchMove', [b]);
  if (run) await touch('touchStart', [b, { ...(await center('[data-foot="run"]')), id: 2 }]);
  try {
    await wait(({ axis, target, sign, tolerance }) => sign * (__game.hero[axis] - target) >= -tolerance,
      { axis, target, sign: startState.sign, tolerance }, 90000);
  } catch (err) { console.error('Не дошли', axis, target, await page.evaluate(() => ({ hero: __game.hero, room: __game.interior?.layout.kind }))); throw err; }
  finally { await touch('touchEnd', []); }
  await wait(() => __game.hero.speed < 0.2);
}
async function swipeList() {
  const box = await page.locator('#life-list').boundingBox();
  const x = Math.round(box.x + box.width * 0.8), y = Math.round(box.y + box.height * 0.8);
  const start = { x, y, id: 3 };
  await touch('touchStart', [start]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x, y: Math.round(y - k * 21), id: 3 }]);
  await touch('touchEnd', []);
  await wait(() => document.querySelector('#life-list').scrollTop > 10);
}

try {
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('openstreet.save.v1')) localStorage.setItem('openstreet.save.v1', JSON.stringify({
      version: 1, money: 1000, bestScore: 4321, ownedCars: ['strada'], activeCar: 'strada', selectedCharacter: 'hero-1',
      homeStates: { 371: { tv: true } }, settings: { sound: false, quality: 'low' },
    }));
  });
  await page.goto(base + '/?shot&noaudio');
  await wait(() => window.__game?.state === 'menu');
  await page.evaluate(() => __game.R.setQuality('low'));
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.heroVisible && __game.R.crowdActors.length === 4);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.homeStates['371'].tv,
    __game.save.life.inventory.bread, __game.save.life.inventory.egg, __game.save.life.inventory.apple]), [1000, 4321, true, 1, 1, 1]);
  const { shop, home } = await page.evaluate(() => ({ shop: __game.entrances.find(d => d.id === 336), home: __game.entrances.find(d => d.id === 371) }));
  await walkAxis('z', shop.z, 0.7, true); await walkAxis('x', shop.x, 0.7, true);
  await label('Войти в магазин'); await tap('#vehicle-action');
  await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition && !!__game.R.vendorActor);
  await walkAxis('x', 1.8, 0.25); await walkAxis('z', -3.5, 0.25);
  await label('Поговорить с продавцом');
  assert.equal(await page.evaluate(() => { let skinned = 0; __game.R.vendorActor.root.traverse(o => { if (o.isSkinnedMesh) skinned++; }); return skinned > 0; }), true);
  await shot('life-vendor'); await tap('#vehicle-action'); await wait(() => __game.state === 'life' && document.querySelector('#life-title').textContent.includes('Магазин'));
  const before = await page.evaluate(() => ({ ...__game.save.life }));
  await tap('[data-action="buy"][data-id="apple"]'); await tap('[data-action="buy"][data-id="bread"]');
  await tap('[data-action="buy"][data-id="egg"]'); await tap('[data-action="buy"][data-id="medkit"]');
  await tap('[data-action="buy-outfit"][data-id="smart"]');
  assert.equal(await page.evaluate(() => __game.save.money), 600);
  assert.deepEqual(await page.evaluate(() => [__game.save.life.inventory.apple, __game.save.life.inventory.bread, __game.save.life.inventory.egg, __game.save.life.inventory.medkit]), [2, 2, 2, 1]);
  assert.deepEqual(await page.evaluate(() => __game.save.life.outfits), ['street', 'smart']);
  await swipeList(); await shot('life-shop');
  await tap('[data-action="job"][data-id="home"]');
  assert.equal(await page.evaluate(() => __game.save.life.job.type), 'home');
  assert.equal(before.outfit, 'street');
  await tap('#life-back'); await wait(() => __game.state === 'play');
  note('до продавца дошли стиком; настоящим касанием купили продукты, аптечку и костюм, пролистали список и взяли заказ');

  await walkAxis('z', 3, 0.25); await walkAxis('x', 0, 0.25); await walkAxis('z', 5.15, 0.4);
  await label('Выйти на улицу'); await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  assert.equal(await page.evaluate(() => __game.R.jobMarker.visible), true);
  await walkAxis('x', -7, 0.7, true); await walkAxis('z', -7, 0.7, true);
  await walkAxis('x', home.x, 0.7, true); await walkAxis('z', home.z, 0.7, true);
  await label('Войти в дом'); await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition);
  await walkAxis('x', 3.3, 0.15); await walkAxis('z', -3.95, 0.15);
  await label('Включить плиту'); await wait(() => document.querySelector('#life-context-action').getAttribute('aria-label') === 'Готовить у плиты' && !document.querySelector('#life-context-action').classList.contains('hidden'));
  await tap('#life-context-action'); await tap('[data-action="cook"][data-id="breakfast"]');
  assert.match(await page.locator('#life-note').textContent(), /включите плиту/i);
  await tap('#life-back'); await label('Включить плиту'); await tap('#vehicle-action'); await wait(() => __game.interior.homeState.stove);
  await tap('#life-context-action'); await tap('[data-action="cook"][data-id="breakfast"]'); await tap('[data-action="cook"][data-id="fruitToast"]');
  assert.deepEqual(await page.evaluate(() => [__game.save.life.inventory.bread, __game.save.life.inventory.egg, __game.save.life.inventory.apple, __game.save.life.inventory.meal, __game.save.life.inventory.toast]), [0, 1, 1, 1, 1]);
  await shot('life-cooking'); await tap('#life-back');
  // Подготавливаем травму и сытость для проверки лечения без долгого ожидания голода.
  await page.evaluate(() => { __game.save.life.health = 50; __game.save.life.satiety = 35; });
  await tap('#btn-bag'); await tap('[data-action="use"][data-id="meal"]');
  assert.deepEqual(await page.evaluate(() => [__game.save.life.health, Math.round(__game.save.life.satiety), __game.save.life.inventory.meal]), [65, 85, 0]);
  await tap('[data-action="use"][data-id="toast"]');
  assert.deepEqual(await page.evaluate(() => [__game.save.life.health, __game.save.life.satiety, __game.save.life.inventory.toast]), [73, 100, 0]);
  await tap('[data-action="use"][data-id="medkit"]'); assert.equal(await page.evaluate(() => __game.save.life.health), 100);
  await tap('#life-back');
  note('до дома и плиты дошли стиком; два рецепта проверены с выключенным/включённым огнём, еда и аптечка изменили показатели');

  await walkAxis('z', -3.4, 0.12); await walkAxis('x', 3.55, 0.12);
  await label('Открыть шкаф'); await tap('#life-context-action');
  assert.match(await page.locator('#toast').textContent(), /откройте шкаф/i);
  await tap('#vehicle-action'); await wait(() => __game.interior.homeState.cabinet);
  await tap('#life-context-action'); await wait(() => __game.state === 'life');
  await tap('[data-action="wear"][data-id="smart"]');
  await wait(() => __game.save.life.outfit === 'smart' && __game.R.heroOutfit === 'smart', null, 120000);
  assert.equal(await page.evaluate(() => !!__game.R.heroActor.model.getObjectByName('male_elegantsuit01')), true);
  await shot('life-wardrobe'); await tap('#life-back');
  await page.evaluate(() => { __game.save.life.health = 60; __game.save.life.satiety = 80; });
  await walkAxis('z', -2.3, 0.2); await walkAxis('x', -2.55, 0.2); await walkAxis('z', -2.77, 0.2);
  await label('Лечь на кровать'); await tap('#vehicle-action');
  await wait(() => __game.hero.pose?.kind === 'lie' && __game.hero.pose.amount > 0.8 && __game.save.life.health > 60, null, 120000);
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  const resting = await page.evaluate(() => __game.save.life.health);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => __game.save.life.health), resting, 'на паузе лечение не идёт');
  await tap('#pause-resume'); await label('Встать'); await tap('#vehicle-action'); await wait(() => !__game.hero.pose);
  note('купленный костюм виден на скелетной модели; отдых лечит, а пауза останавливает восстановление');

  await tap('#btn-reset'); await walkAxis('z', 5.15, 0.4);
  await label('Выйти на улицу'); await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  // Пользуемся настоящим игровым быстрым трансфером, а не перемещаем героя из теста.
  const parked = await page.evaluate(() => [__game.car.x, __game.car.z]);
  await tap('#btn-bag'); await swipeList();
  await page.locator('[data-action="taxi"][data-id="job"]').scrollIntoViewIfNeeded();
  await tap('[data-action="taxi"][data-id="job"]');
  await wait(() => __game.state === 'play' && !__game.roomTransition && __game.save.money === 540);
  assert.deepEqual(await page.evaluate(() => [__game.car.x, __game.car.z]), parked, 'такси не переносит припаркованную машину');
  await label('Доставить заказ'); await tap('#vehicle-action');
  await wait(() => !__game.save.life.job); assert.equal(await page.evaluate(() => __game.save.money), 760);
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 1);
  await wait(() => !__game.R.jobMarker.visible);
  note('такси переносит к адресу за $60, оставляя машину на месте; доставка начисляет $220 ровно один раз');

  // Ставим героя рядом с одним реально загруженным прохожим, чтобы не ждать
  // случайной встречи; сама кнопка и ответ работают как в обычной игре.
  await page.evaluate(() => {
    const p = __game.crowd.people.find(x => x.alive && Math.hypot(x.x - __game.car.x, x.z - __game.car.z) > 8);
    p.pause = 30; p.speed = 0;
    Object.assign(__game.hero, { x: p.x + 1, z: p.z, vx: 0, vz: 0, speed: 0, camYaw: Math.PI });
  });
  await label('Поговорить с прохожим'); await tap('#vehicle-action');
  assert.match(await page.locator('#toast').textContent(), /заказ|еду|здоров|метка/i);
  await shot('life-citizen');
  note('анимированный прохожий откликается на контекстную кнопку');

  await tap('#btn-pause'); await tap('#pause-settings');
  await tap('[data-set="starvationDamage"] [data-v="false"]');
  assert.equal(await page.evaluate(() => __game.save.settings.starvationDamage), false);
  await tap('#settings-back'); await tap('#pause-resume');
  await page.evaluate(() => { __game.save.life.health = 50; __game.save.life.satiety = 0; });
  await page.waitForTimeout(1000); assert.equal(await page.evaluate(() => __game.save.life.health), 50);
  await tap('#btn-pause'); await tap('#pause-settings'); await tap('[data-set="starvationDamage"] [data-v="true"]');
  await tap('#settings-back'); await tap('#pause-resume');
  await wait(() => __game.save.life.health < 50, null, 30000);
  await page.evaluate(() => { __game.save.life.health = 0.001; });
  await wait(() => __game.save.life.health === 50 && __game.save.life.satiety >= 30, null, 30000);
  note('урон от голода отключается в настройках; при обмороке герой восстанавливается, игра не блокируется');

  // Визуальная проверка освещения для полдня/полночи без ожидания реальных 12 часов.
  const lighting = await page.evaluate(() => {
    __game.R.setWorldTime(12); const day = { h: __game.R.hemi.intensity, glow: __game.R.windowUniforms.uWindowGlow.value };
    __game.R.setWorldTime(0); return { day, night: { h: __game.R.hemi.intensity, glow: __game.R.windowUniforms.uWindowGlow.value, lamps: __game.R.lampPools.visible } };
  });
  assert.ok(lighting.day.h > lighting.night.h && lighting.night.glow > lighting.day.glow && lighting.night.lamps);
  await shot('life-night');
  await tap('#btn-pause'); await wait(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const cache = await caches.open(`openstreet:${r.scope}:v15`);
    return Promise.all(['js/life.js', 'js/crowd.js', 'js/day-night.js', 'assets/characters/hero-1-smart.glb', 'assets/characters/citizen-1.glb'].map(async u => !!(await cache.match(u))));
  });
  assert.deepEqual(cached, [true, true, true, true, true]);
  await ctx.setOffline(true); await page.reload(); await wait(() => window.__game?.state === 'menu' && __game.R.heroOutfit === 'smart', null, 150000);
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.life.outfit, __game.save.life.completedJobs, __game.save.settings.starvationDamage]), [760, 4321, 'smart', 1, true]);
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.crowdActors.length === 4 && __game.R.heroVisible);
  assert.equal(await page.evaluate(() => !!__game.R.heroActor.model.getObjectByName('male_elegantsuit01')), true);
  await tap('#btn-bag'); assert.equal(await page.locator('#life-title').textContent(), 'Рюкзак'); await tap('#life-back');
  await tap('#btn-pause'); await tap('#pause-menu'); await wait(() => __game.state === 'menu');
  await tap('#btn-character'); await wait(() => __game.state === 'character' && __game.R.heroId === 'hero-1' && __game.R.heroVisible);
  await tap('#character-next'); await wait(() => __game.R.heroId === 'hero-2' && __game.R.heroOutfit === 'smart' && __game.R.heroVisible);
  assert.equal(await page.evaluate(() => !!__game.R.heroActor.model.getObjectByName('female_elegantsuit01')), true);
  await tap('#character-action'); await tap('#character-back'); await wait(() => __game.state === 'menu');
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.heroId === 'hero-2' && __game.R.heroVisible);
  await shot('life-second-hero');
  note('день/ночь различаются; оба варианта костюма, жители, сохранение и рюкзак работают без сети');
  await label('Сесть в машину'); await tap('#vehicle-action'); await wait(() => !__game.onFoot);
  // Задаём начальное положение и скорость, затем столкновение и урон выполняет игровая физика.
  await page.evaluate(() => {
    const G = __game, building = G.city.buildings[100];
    G.save.life.health = 100;
    Object.assign(G.car, { x: building.x - building.hw - 2.8, z: building.z, heading: 0, vx: 28, vz: 0, speed: 28, lateral: 0, yawRate: 0 });
  });
  await wait(() => __game.car.stats.collisions > 0 && __game.save.life.health < 100, null, 30000);
  note('сильный удар машины об здание действительно уменьшает здоровье');
  assert.deepEqual(errors, [], 'ошибки браузера');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally { await browser.close(); }
