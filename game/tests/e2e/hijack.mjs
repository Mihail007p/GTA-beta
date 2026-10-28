// Путь игрока на мобильном экране: пеший старт, остановка трафика,
// управление угнанными машинами, возвращение к своей, гараж и офлайн.
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
const wait = (fn, arg = null, timeout = 90000) => page.waitForFunction(fn, arg, { timeout });
const center = async sel => {
  const b = await page.locator(sel).boundingBox();
  assert.ok(b, `нет элемента ${sel}`);
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
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id })),
});
const stick = async (dx, dy, condition) => {
  const start = { x: 120, y: 270, id: 1 }, end = { x: start.x + dx, y: start.y + dy, id: 1 };
  await touch('touchStart', [start]);
  await touch('touchMove', [end]);
  await wait(condition, null, 120000);
  await touch('touchEnd', []);
};
const stopAndExit = async () => {
  await page.evaluate(() => Object.assign(__game.car, { vx: 0, vz: 0, speed: 0, yawRate: 0 }));
  await tap('#vehicle-action');
  await wait(() => __game.onFoot && __game.R.heroVisible);
};

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
    hero: [__game.hero.x, __game.hero.z], own: [__game.vehicles.own.car.x, __game.vehicles.own.car.z],
    active: __game.save.activeCar, money: __game.save.money, score: __game.save.bestScore,
  }));
  assert.ok(Math.hypot(initial.hero[0] - initial.own[0], initial.hero[1] - initial.own[1]) < 4);
  assert.deepEqual([initial.active, initial.money, initial.score], ['vektor', 7500, 4321]);
  assert.equal(await page.locator('[data-foot="stick"]').isVisible(), true);
  assert.equal(await page.locator('[data-btn="gas"]').isVisible(), false);
  await shot('spawn-on-foot');
  note('выбранный герой начинает пешком у своей машины, старый прогресс на месте');

  // Размещаем одну реальную машину в полосе перед героем. Остальной трафик
  // убираем только в тесте, чтобы воспроизводимо проверить её торможение.
  await page.evaluate(() => {
    const G = __game, own = G.vehicles.own.car;
    for (const t of G.traffic.cars) t.alive = false;
    const t = G.traffic.cars.find(c => c.type === 0);
    window.__target = window.__firstRef = t;
    Object.assign(G.hero, { x: own.x, z: own.z + 35, vx: 0, vz: 0, speed: 0, heading: Math.PI / 2, camYaw: Math.PI / 2 });
    Object.assign(t, { alive: true, x: own.x, z: G.hero.z - 9, axis: 'z', dir: 1, lane: own.x, s: G.hero.z - 9,
      heading: Math.PI / 2, visHeading: Math.PI / 2, speed: 8, cruise: 10, stunned: 0, plan: { kind: 'straight', cross: 9999 } });
  });
  await wait(() => window.__target.speed < 1.5, null, 120000);
  // Два настоящих движения стиком: отходим в сторону и подходим к двери.
  await stick(-60, 0, () => __game.hero.x - __target.x > 1.8);
  // Программный WebGL может пропускать кадры, поэтому при промахе корректируем стик обратно.
  if (await page.evaluate(() => __game.hero.x - __target.x > 2.6)) {
    await stick(60, 0, () => __game.hero.x - __target.x < 2.5);
  }
  await stick(0, 60, () => Math.abs(__game.hero.z - __target.z) < 1.4);
  await wait(() => document.querySelector('#vehicle-action').textContent.includes('УГНАТЬ'), null, 15000);
  const targetAppearance = await page.evaluate(() => ({ color: __target.colorIdx, type: __target.type }));
  await shot('traffic-before-hijack');
  await tap('#vehicle-action');
  await wait(() => !!__game.pendingEntry && !!__game.R.driverActor);
  await shot('driver-exits');
  await tap('#btn-pause');
  await wait(() => __game.state === 'pause');
  const pausedAt = await page.evaluate(() => __game.pendingEntry?.elapsed);
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => __game.pendingEntry?.elapsed), pausedAt);
  await tap('#pause-resume');
  await wait(() => !__game.onFoot && !__game.pendingEntry);
  const taken = await page.evaluate(() => ({
    same: __game.vehicles.current.ref === __target, color: __target.colorIdx, type: __target.type,
    own: [__game.vehicles.own.car.x, __game.vehicles.own.car.z], proxy: !!__game.vehicles.ownProxy,
    active: __game.save.activeCar, owned: [...__game.save.ownedCars],
  }));
  assert.equal(taken.same, true); assert.deepEqual([taken.type, taken.color], [targetAppearance.type, targetAppearance.color]);
  assert.deepEqual(taken.own, initial.own); assert.equal(taken.proxy, true);
  assert.deepEqual([taken.active, taken.owned], ['vektor', ['strada', 'vektor']]);
  await page.evaluate(() => { window.__firstState = __game.car; });
  note('стик останавливает и позволяет подойти к трафику; водитель выходит, переход приостанавливается на паузе');

  // Ускорение реальным касанием педали; машина на экране остаётся тем же инстансом.
  const gas = { ...(await center('[data-btn="gas"]')), id: 3 };
  const before = await page.evaluate(() => [__game.car.x, __game.car.z]);
  await touch('touchStart', [gas]);
  await wait(() => Math.abs(__game.car.speed) > 1);
  await touch('touchEnd', []);
  const moved = await page.evaluate(() => ({ car: [__game.car.x, __game.car.z], ref: [__target.x, __target.z], visible: __game.R.tTypes[__target.type].visible }));
  assert.ok(Math.hypot(moved.car[0] - before[0], moved.car[1] - before[1]) > 0.05);
  assert.ok(Math.hypot(moved.car[0] - moved.ref[0], moved.car[1] - moved.ref[1]) < 0.2);
  assert.equal(moved.visible, true);
  await shot('driving-stolen');
  note('угнанная модель сохраняет цвет и действительно разгоняется от сенсорной педали');

  // Смена гаражной машины во время угона не должна заменить управляемую.
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await tap('#pause-garage'); await wait(() => __game.state === 'garage');
  await tap('#car-prev');
  await wait(() => document.querySelector('#car-action').textContent.includes('ВЫБРАТЬ'));
  await tap('#car-action');
  const garage = await page.evaluate(() => ({ current: __game.vehicles.current.ref === __target, own: __game.vehicles.own.def.id,
    active: __game.save.activeCar, money: __game.save.money, score: __game.save.bestScore, cars: [...__game.save.ownedCars] }));
  assert.equal(garage.current, true);
  assert.equal(garage.own, 'strada'); assert.equal(garage.active, 'strada');
  assert.ok(garage.money >= 7500 && garage.score >= 4321);
  assert.deepEqual(garage.cars, ['strada', 'vektor']);
  await tap('#garage-back'); await wait(() => __game.state === 'pause');
  await tap('#pause-resume'); await wait(() => __game.state === 'play' && !__game.onFoot);
  const blocked = await page.evaluate(() => {
    Object.assign(__game.car, { vx: 3, vz: 0, speed: 3 });
    document.querySelector('#vehicle-action').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return { onFoot: __game.onFoot, toast: document.querySelector('#toast').textContent };
  });
  assert.equal(blocked.onFoot, false); assert.match(blocked.toast, /останов/i);
  await stopAndExit();
  note('гараж меняет только собственную машину; на ходу выйти нельзя');

  // Все оставшиеся типы сажаем рядом с героем для повторяемости и угоняем
  // настоящими касаниями. Это не подменяет интерактивный подход выше.
  for (let type = 1; type < 8; type++) {
    await page.evaluate(type => {
      const G = __game, own = G.vehicles.own.car;
      const t = G.traffic.cars.find(c => c.type === type && !c.playerControlled && !c.parked);
      if (!t) throw new Error('нет машины типа ' + type);
      window.__target = t;
      const z = own.z + 60 + type * 12;
      Object.assign(G.hero, { x: own.x + 2.5, z, vx: 0, vz: 0, speed: 0, heading: Math.PI / 2, camYaw: Math.PI / 2 });
      Object.assign(t, { alive: true, x: own.x, z, axis: 'z', dir: 1, lane: own.x, s: z,
        heading: Math.PI / 2, visHeading: Math.PI / 2, speed: 0, cruise: 0, stunned: 30, plan: { kind: 'straight', cross: 9999 } });
    }, type);
    await wait(() => document.querySelector('#vehicle-action').textContent.includes('УГНАТЬ'));
    const beforeColor = await page.evaluate(() => __target.colorIdx);
    await tap('#vehicle-action');
    await wait(() => !__game.onFoot && __game.vehicles.current.ref === __target, null, 120000);
    assert.equal(await page.evaluate(() => __target.type), type);
    assert.equal(await page.evaluate(() => __target.colorIdx), beforeColor);
    assert.ok(await page.evaluate(() => __game.R.tTypes[__target.type].visible));
    const pedal = { ...(await center('[data-btn="gas"]')), id: 3 };
    await touch('touchStart', [pedal]);
    await wait(() => Math.abs(__game.car.speed) > 0.35);
    await touch('touchEnd', []);
    await stopAndExit();
  }
  assert.equal(await page.evaluate(() => __game.traffic.cars.filter(c => c.parked && !c.noRender).length >= 7), true);
  note('все восемь типов трафика можно угнать, разогнать и оставить на месте');

  // Вернуться к первой угнанной, потом к своей машине. Кузова не заменяются.
  await page.evaluate(() => {
    const t = window.__firstRef;
    Object.assign(__game.hero, { x: t.x + 2.2, z: t.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').textContent.includes('СЕСТЬ'));
  await tap('#vehicle-action');
  await wait(() => !__game.onFoot && __game.vehicles.current.ref === __firstRef);
  assert.equal(await page.evaluate(() => __game.car === __firstState && !__game.pendingEntry), true);
  await stopAndExit();
  await page.evaluate(() => {
    const c = __game.vehicles.own.car;
    Object.assign(__game.hero, { x: c.x + 2.2, z: c.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').textContent.includes('СЕСТЬ'));
  await tap('#vehicle-action');
  await wait(() => !__game.onFoot && __game.vehicles.current === __game.vehicles.own);
  assert.equal(await page.evaluate(() => __game.vehicles.ownProxy), null);
  assert.deepEqual(await page.evaluate(() => [__game.vehicles.own.car.x, __game.vehicles.own.car.z]), initial.own);
  note('можно снова сесть в брошенный угнанный автомобиль и вернуться к своей машине');

  // Прогресс переживает reload, а новый модуль и угон работают без сети.
  await wait(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const source = await (await fetch('sw.js', { cache: 'no-store' })).text();
    const version = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
    const cache = await caches.open(`openstreet:${reg.scope}:${version}`);
    return !!(await cache.match('js/vehicles.js'));
  });
  assert.equal(cached, true);
  // Пауза синхронно записывает последний заработок перед перезагрузкой.
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  const savedProgress = await page.evaluate(() => [__game.save.activeCar, __game.save.money, __game.save.bestScore]);
  assert.equal(savedProgress[0], 'strada'); assert.ok(savedProgress[1] >= 7500 && savedProgress[2] >= 4321);
  await ctx.setOffline(true);
  await page.reload();
  await wait(() => window.__game?.state === 'menu', null, 120000);
  assert.deepEqual(await page.evaluate(() => [__game.save.activeCar, __game.save.money, __game.save.bestScore]), savedProgress);
  await tap('#btn-play');
  await wait(() => __game.state === 'play' && __game.onFoot && __game.R.heroVisible);
  await page.evaluate(() => {
    const G = __game, t = G.traffic.cars[0], c = G.car;
    window.__target = t;
    Object.assign(G.hero, { x: c.x + 2.5, z: c.z + 25, vx: 0, vz: 0, speed: 0 });
    Object.assign(t, { alive: true, x: c.x, z: c.z + 25, axis: 'z', dir: 1, lane: c.x, s: c.z + 25,
      heading: Math.PI / 2, visHeading: Math.PI / 2, speed: 8, cruise: 10, stunned: 0, plan: { kind: 'straight', cross: 9999 } });
    // Нажимаем синхронно, до очередного кадра: быстрая машина должна тормозить.
    document.querySelector('#vehicle-action').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => __game.onFoot && __target.stunned > 0), true);
  assert.match(await page.locator('#toast').textContent(), /тормозит/i);
  await wait(() => __target.speed <= 4 && document.querySelector('#vehicle-action').textContent.includes('УГНАТЬ'));
  await tap('#vehicle-action');
  await wait(() => !__game.onFoot && __game.vehicles.current.ref === __target);
  assert.deepEqual(errors, [], 'ошибки страницы или консоли');
  note('новая версия сохраняет прогресс и позволяет угнать машину без интернета');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally {
  await browser.close();
}
