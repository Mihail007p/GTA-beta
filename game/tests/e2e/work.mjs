// Проверка работы и наездов в мобильном Chromium. Дальние координаты здесь
// подставляются только для сокращения маршрутов; кнопки, касание газа, физика,
// переключение этапов, вознаграждение и сохранение выполняются самой игрой.
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
const center = async sel => {
  const b = await page.locator(sel).boundingBox(); assert.ok(b, `кнопка не видна: ${sel}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};
const tap = async sel => { const p = await center(sel); await page.touchscreen.tap(p.x, p.y); };
const label = text => wait(t => document.querySelector('#vehicle-action').getAttribute('aria-label') === t && !document.querySelector('#vehicle-action').classList.contains('hidden'), text);
const shot = async name => { if (process.env.E2E_SHOTS) { await fs.mkdir(process.env.E2E_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.E2E_SHOTS, name + '.png') }); } };
const note = text => console.log('  ✓ ' + text);
const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(p => ({ ...p, id: p.id || 1 })) });
const hold = async sel => { const p = await center(sel); await touch('touchStart', [p]); };
const release = () => touch('touchEnd', []);

async function openStore() {
  assert.equal(await page.evaluate(() => __game.onFoot && !__game.interior), true);
  await page.evaluate(() => {
    const d = __game.entrances.find(x => x.id === 336);
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await label('Войти в магазин'); await tap('#vehicle-action');
  await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition);
  await page.evaluate(() => Object.assign(__game.hero, { x: 1.8, z: -3.5, vx: 0, vz: 0, speed: 0 }));
  await label('Поговорить с продавцом'); await tap('#vehicle-action');
  await wait(() => __game.state === 'life' && document.querySelector('#life-title').textContent.includes('Магазин'));
}
async function leaveStore() {
  await tap('#life-back'); await wait(() => __game.state === 'play');
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.15, vx: 0, vz: 0, speed: 0 }));
  await label('Выйти на улицу'); await tap('#vehicle-action');
  await wait(() => !__game.interior && !__game.roomTransition);
}
async function enterOwnCar() {
  await page.evaluate(() => {
    const g = __game, s = g.city.start;
    Object.assign(g.car, { x: s.x, z: s.z, heading: Math.PI / 2, vx: 0, vz: 0, speed: 0, lateral: 0, yawRate: 0 });
    Object.assign(g.hero, { x: s.x + 2, z: s.z, vx: 0, vz: 0, speed: 0 });
  });
  await label('Сесть в машину'); await tap('#vehicle-action'); await wait(() => !__game.onFoot);
}
async function positionCarAtTarget() {
  await page.evaluate(() => {
    const g = __game, d = g.entrances.find(x => x.id === g.save.life.job.targetId);
    Object.assign(g.car, { x: d.x + d.nx * 4.5, z: d.z + d.nz * 4.5, heading: Math.atan2(-d.nz, -d.nx),
      vx: 0, vz: 0, speed: 0, lateral: 0, yawRate: 0 });
    g.R._camInit = false;
  });
}
async function swipeJobs() {
  const box = await page.locator('#life-list').boundingBox();
  const x = Math.round(box.x + box.width * 0.8), y = Math.round(box.y + box.height * 0.8);
  await touch('touchStart', [{ x, y }]);
  for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x, y: Math.round(y - k * 20) }]);
  await release(); await wait(() => document.querySelector('#life-list').scrollTop > 10);
}

try {
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('openstreet.save.v1')) localStorage.setItem('openstreet.save.v1', JSON.stringify({
      version: 1, money: 500, bestScore: 900, ownedCars: ['strada'], activeCar: 'strada',
      selectedCharacter: 'hero-1', settings: { sound: false, quality: 'low' },
    }));
  });
  await page.goto(base + '/?shot&noaudio');
  await wait(() => window.__game?.state === 'menu'); await page.evaluate(() => __game.R.setQuality('low'));
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.heroVisible && __game.R.crowdActors.length === 4);
  await openStore(); await swipeJobs();
  await page.locator('[data-action="job"][data-id="taxi"]').scrollIntoViewIfNeeded();
  await tap('[data-action="job"][data-id="taxi"]');
  assert.equal(await page.evaluate(() => __game.save.life.job.stage), 'pickup');
  assert.match(await page.locator('#life-note').textContent(), /подъедьте/i);
  await shot('work-menu'); await leaveStore(); await enterOwnCar(); await positionCarAtTarget();
  await label('Посадить пассажира');
  assert.equal(await page.evaluate(() => __game.crowd.people.filter(p => p.taxiReserved && p.condition === 'taxi-wait').length), 1);
  await shot('taxi-passenger'); await tap('#vehicle-action');
  await wait(() => __game.save.life.job?.stage === 'drive');
  await hold('[data-btn="gas"]');
  await wait(() => __game.crowd.people.some(p => p.condition === 'taxi-board' && p.boardAge >= 0.1));
  assert.ok(await page.evaluate(() => Math.hypot(__game.car.vx, __game.car.vz) < 0.05), 'газ заблокирован, пока пассажир садится');
  await release();
  await wait(() => __game.crowd.people.some(p => p.condition === 'taxi-seat'));
  assert.equal(await page.evaluate(() => __game.crowd.people.length), 4);
  assert.equal(await page.evaluate(() => __game.R.crowdActors.some((a, i) => __game.crowd.people[i]?.condition === 'taxi-seat' && !!a.root)), true);
  if (process.env.E2E_SHOTS) {
    // Отдельный ракурс для визуальной проверки, что пассажир не выступает над крышей.
    await page.waitForTimeout(350);
    const data = await page.evaluate(() => {
      const g = __game, c = g.car, f = [Math.cos(c.heading), Math.sin(c.heading)], side = [-f[1], f[0]];
      g.R.camera.position.set(c.x + side[0] * 5 - f[0] * 1.4, 2, c.z + side[1] * 5 - f[1] * 1.4);
      g.R.camera.lookAt(c.x, 0.85, c.z); g.R.updateCrowd(g.crowd, 0, true); g.R.render();
      return g.R.canvas.toDataURL('image/png').split(',')[1];
    });
    await fs.writeFile(path.join(process.env.E2E_SHOTS, 'taxi-seated-side.png'), Buffer.from(data, 'base64'));
  }
  // Настоящее удержание газа: пассажир следует за машиной, а заказ не платит заранее.
  await page.evaluate(() => {
    const g = __game, s = g.city.start;
    Object.assign(g.car, { x: s.x, z: s.z, heading: Math.PI / 2, vx: 0, vz: 0, speed: 0, lateral: 0, yawRate: 0 });
    g.R._camInit = false;
  });
  const start = await page.evaluate(() => ({ x: __game.car.x, z: __game.car.z }));
  await hold('[data-btn="gas"]');
  await wait(start => Math.hypot(__game.car.x - start.x, __game.car.z - start.z) > 9, start, 90000);
  await release();
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 0);
  assert.ok(await page.evaluate(() => {
    const p = __game.crowd.people.find(x => x.taxiReserved);
    return p?.condition === 'taxi-seat' && Math.hypot(p.x - __game.car.x, p.z - __game.car.z) < 1;
  }));
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  await page.reload(); await wait(() => window.__game?.state === 'menu');
  assert.equal(await page.evaluate(() => __game.save.life.job?.stage), 'drive');
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.crowdActors.length === 4);
  assert.ok(await page.evaluate(() => __game.crowd.people.some(p => p.condition === 'taxi-seat')));
  await enterOwnCar(); await positionCarAtTarget(); await label('Высадить пассажира');
  const beforeTaxi = await page.evaluate(() => __game.save.money);
  await tap('#vehicle-action'); await wait(() => !__game.save.life.job);
  assert.equal(await page.evaluate(() => __game.save.money), Math.round((beforeTaxi + 380) * 100) / 100);
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 1);
  assert.ok(await page.evaluate(() => __game.crowd.people.some(p => p.condition === 'taxi-exit')));
  await label('Выйти из машины'); await tap('#vehicle-action'); await wait(() => __game.onFoot);
  note('таксист подбирает видимого пассажира, везёт его настоящим управлением; поездка сохраняется, оплата один раз');

  for (const type of ['route', 'cleanup']) {
    await openStore();
    await page.locator(`[data-action="job"][data-id="${type}"]`).scrollIntoViewIfNeeded();
    await tap(`[data-action="job"][data-id="${type}"]`);
    assert.equal(await page.evaluate(() => __game.save.life.job.type), type);
    await leaveStore();
    for (let i = 0; i < 3; i++) {
      await page.evaluate(type => {
        const g = __game, d = g.entrances.find(x => x.id === g.save.life.job.targetId);
        Object.assign(g.hero, { x: d.x + (type === 'cleanup' ? d.nx * 0.8 : 0),
          z: d.z + (type === 'cleanup' ? d.nz * 0.8 : 0), vx: 0, vz: 0, speed: 0 });
      }, type);
      if (type === 'cleanup') {
        await label('Собрать мусор'); assert.equal(await page.evaluate(() => __game.R.workBag.visible), true);
        if (!i) await shot('work-cleanup');
      } else await label('Доставить заказ');
      const before = await page.evaluate(() => __game.save.money);
      await tap('#vehicle-action');
      if (i < 2) {
        await wait(i => __game.save.life.job?.index === i + 1, i);
        assert.equal(await page.evaluate(() => __game.save.money), before);
        if (type === 'route' && i === 0) {
          await tap('#btn-pause'); await wait(() => __game.state === 'pause');
          await page.reload(); await wait(() => window.__game?.state === 'menu');
          assert.deepEqual(await page.evaluate(() => [__game.save.life.job?.type, __game.save.life.job?.index]), ['route', 1], 'этап маршрута сохраняется после перезапуска');
          await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.onFoot);
        }
      } else {
        await wait(() => !__game.save.life.job);
        assert.equal(await page.evaluate(() => __game.save.money), Math.round((before + (type === 'route' ? 650 : 360)) * 100) / 100);
      }
    }
    assert.equal(await page.evaluate(() => __game.save.life.completedJobs), type === 'route' ? 2 : 3);
    note(type === 'route' ? 'курьер доставляет по трём разным адресам и получает $650 в конце' : 'уборщик собирает три видимых мешка и получает $360 в конце');
  }

  await enterOwnCar();
  // Людей ставим в дорожную полосу для воспроизводимости. Наезд выполняется
  // настоящим газом и игровой фиксированной физикой, а не вызовом тестовой функции.
  await page.evaluate(() => {
    const g = __game, c = g.car, p = g.crowd.people.find(x => x.condition === 'walk');
    c.vx = c.vz = c.speed = c.yawRate = c.lateral = 0; c.heading = Math.PI / 2;
    Object.assign(p, { alive: true, condition: 'walk', x: c.x, z: c.z + 7, axis: 'x', dir: 1, pause: 60, speed: 0, fall: 0 });
    g.__testPerson = p.id; g.R._camInit = false;
  });
  await hold('[data-btn="gas"]');
  await wait(() => __game.crowd.people[__game.__testPerson].condition === 'injured', null, 90000); await release();
  await wait(() => __game.crowd.people[__game.__testPerson].fall > 0.95);
  assert.equal(await page.evaluate(() => __game.crowd.people[__game.__testPerson].fatal), false);
  await shot('work-collision');
  await tap('#btn-pause'); await wait(() => __game.state === 'pause');
  if (process.env.E2E_SHOTS) {
    const data = await page.evaluate(() => {
      const g = __game, p = g.crowd.people[g.__testPerson];
      g.R.camera.position.set(p.x + 4, 2.8, p.z + 4); g.R.camera.lookAt(p.x, 0.15, p.z);
      g.R.updateCrowd(g.crowd, 0, true); g.R.render();
      return g.R.canvas.toDataURL('image/png').split(',')[1];
    });
    await fs.writeFile(path.join(process.env.E2E_SHOTS, 'work-fallen-close.png'), Buffer.from(data, 'base64'));
  }
  const pausedHitAge = await page.evaluate(() => __game.crowd.people[__game.__testPerson].hitAge);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => __game.crowd.people[__game.__testPerson].hitAge), pausedHitAge, 'падение не продвигается на паузе');
  await tap('#pause-resume'); await wait(() => __game.state === 'play');
  await wait(() => ['walk', 'return'].includes(__game.crowd.people[__game.__testPerson].condition), null, 90000);
  // Сильный удар: задаём начальную скорость, столкновение обрабатывает игра.
  await page.evaluate(() => {
    const g = __game, s = g.city.start, p = g.crowd.people.find(x => x.condition === 'walk' && x.id !== g.__testPerson);
    Object.assign(g.car, { x: s.x, z: s.z, heading: Math.PI / 2, vx: 0, vz: 22, speed: 22, lateral: 0, yawRate: 0 });
    Object.assign(p, { alive: true, condition: 'walk', x: s.x, z: s.z + 4, axis: 'x', dir: 1, pause: 60, speed: 0, fall: 0 });
    g.__fatalPerson = p.id;
  });
  await wait(() => __game.crowd.people[__game.__fatalPerson].condition === 'dead', null, 30000);
  assert.equal(await page.evaluate(() => __game.crowd.people[__game.__fatalPerson].fatal), true);
  await wait(() => __game.crowd.people[__game.__fatalPerson].fall > 0.9);
  await shot('work-fatal');
  note('касание газа вызывает слабый наезд с падением и восстановлением; сильный удар может быть смертельным');

  // Если водитель вместо посадки сбивает ожидающего клиента, заказ нельзя оплатить.
  await page.evaluate(() => Object.assign(__game.car, { vx: 0, vz: 0, speed: 0, yawRate: 0, lateral: 0 }));
  await label('Выйти из машины'); await tap('#vehicle-action'); await wait(() => __game.onFoot);
  await openStore(); await page.locator('[data-action="job"][data-id="taxi"]').scrollIntoViewIfNeeded();
  await tap('[data-action="job"][data-id="taxi"]'); await leaveStore(); await enterOwnCar();
  await wait(() => __game.crowd.people.some(p => p.taxiReserved && p.condition === 'taxi-wait'));
  await page.evaluate(() => {
    const g = __game, d = g.entrances.find(x => x.id === g.save.life.job.targetId);
    const p = g.crowd.people.find(x => x.taxiReserved), c = g.car;
    g.__testPassenger = p.id;
    Object.assign(c, { x: d.x + d.nx * 4.8, z: d.z + d.nz * 4.8, heading: Math.atan2(-d.nz, -d.nx),
      vx: -d.nx * 8, vz: -d.nz * 8, speed: 8, yawRate: 0, lateral: 0 });
  });
  await wait(() => !__game.save.life.job, null, 30000);
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 3, 'сорванная поездка не оплачивается');
  assert.ok(await page.evaluate(() => ['injured', 'dead'].includes(__game.crowd.people[__game.__testPassenger].condition)));
  note('наезд на ожидающего клиента отменяет поездку без выплаты');

  await page.evaluate(() => Object.assign(__game.car, { vx: 0, vz: 0, speed: 0, yawRate: 0, lateral: 0 }));
  await label('Выйти из машины'); await tap('#vehicle-action'); await wait(() => __game.onFoot);
  await openStore(); await page.locator('[data-action="job"][data-id="taxi"]').scrollIntoViewIfNeeded();
  await tap('[data-action="job"][data-id="taxi"]'); await leaveStore(); await enterOwnCar(); await positionCarAtTarget();
  await label('Посадить пассажира'); await tap('#vehicle-action');
  await wait(() => __game.crowd.people.some(p => p.condition === 'taxi-seat'));
  const cancelledPassenger = await page.evaluate(() => __game.crowd.people.find(p => p.taxiReserved).id);
  await tap('#btn-bag'); await wait(() => __game.state === 'life');
  await page.locator('[data-action="cancel-job"]').scrollIntoViewIfNeeded();
  await tap('[data-action="cancel-job"]');
  assert.equal(await page.evaluate(() => __game.save.life.job), null);
  assert.equal(await page.evaluate(id => __game.crowd.people[id].condition, cancelledPassenger), 'taxi-exit');
  assert.ok(await page.evaluate(() => Math.hypot(__game.car.vx, __game.car.vz) < 0.01));
  await tap('#life-back'); await wait(() => __game.state === 'play');
  await wait(id => ['walk', 'return'].includes(__game.crowd.people[id].condition), cancelledPassenger);
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 3);
  note('отмена поездки в рюкзаке останавливает машину и выпускает пассажира без оплаты');

  await tap('#btn-pause'); await wait(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready, cache = await caches.open(`openstreet:${r.scope}:v16`);
    return Promise.all(['js/crowd-collisions.js', 'js/work-crowd.js'].map(async u => !!(await cache.match(u))));
  });
  assert.deepEqual(cached, [true, true]);
  await ctx.setOffline(true); await page.reload(); await wait(() => window.__game?.state === 'menu');
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 3);
  assert.ok(await page.evaluate(() => __game.save.money >= 500 + 380 + 650 + 360));
  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.R.crowdActors.length === 4);
  assert.deepEqual(errors, [], 'ошибки браузера');
  note('новые модули и сохранённый заработок работают без сети после первой загрузки');
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
} finally { await browser.close(); }
