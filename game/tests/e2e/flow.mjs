import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('[pageerror] ' + e.message + ' ' + (e.stack || '').split('\n')[1]));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push('[' + m.type() + '] ' + m.text()); });
await page.goto('http://localhost:8080/?shot');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tap = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
await tap('#btn-play');
await page.waitForFunction(() => __game.state === 'play' && __game.onFoot);
await tap('#vehicle-action');
await page.waitForFunction(() => !__game.onFoot);
const fr0 = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
console.log('кадров за 1 с после старта:', fr0);

// 1) Чекпоинты: телепорт машины на чекпоинт 3 раза подряд
for (let k = 0; k < 3; k++) {
  await page.evaluate(() => { const G = window.__game, cp = G.g.checkpoints[0]; G.car.x = cp.x; G.car.z = cp.z; G.car.vx = 0; G.car.vz = 0; });
  // На медленном программном рендерере кадр может занять больше 600 мс.
  // Ждём именно начисления, а не условной задержки.
  await page.waitForFunction(target => window.__game.g.chain >= target, k + 1, { timeout: 30000 });
  console.log('чекпоинт', k + 1, JSON.stringify(await page.evaluate(() => { const g = window.__game.g; return { chain: g.chain, combo: g.combo, time: +g.timeLeft.toFixed(1), score: Math.round(g.score), money: Math.round(window.__game.save.money), cps: g.checkpoints.length, popups: document.querySelectorAll('.popup').length }; })));
}
await page.screenshot({ path: OUT + 'chain.png' });

// 2) Удар о дом на скорости ~90 км/ч
const collisionCount = await page.evaluate(() => {
  // ставим машину на дорогу лицом к ближайшему дому: едем по X к кварталу
  const c = window.__game.car; c.x = -7 + 3.5; c.z = 40; c.heading = 0; c.vx = 25; c.vz = 0; c.speed = 25;
  return c.stats.collisions;
});
await page.waitForFunction(before => window.__game.car.stats.collisions > before, collisionCount, { timeout: 30000 });
const hit = await page.evaluate(before => {
  const c = window.__game.car;
  return { before, after: c.stats.collisions, kmh: Math.round(Math.abs(c.speed) * 3.6), x: c.x.toFixed(1), finite: isFinite(c.x) && isFinite(c.vx) };
}, collisionCount);
assert.ok(hit.finite && hit.after > hit.before, 'столкновение с домом не зафиксировано');
console.log('удар о дом:', JSON.stringify(hit));
await page.screenshot({ path: OUT + 'crash.png' });

// 3) Гараж: дать денег, купить Vektor RS, проверить смену модели и физики
await page.evaluate(() => { window.__game.save.money = 7000; });
await tap('#btn-pause'); await sleep(300);
await tap('#pause-garage'); await sleep(800);
await tap('#car-next'); await sleep(800);
const btnTxt = await page.locator('#car-action').textContent();
await tap('#car-action'); await sleep(800);
const bought = await page.evaluate(() => { const s = window.__game.save; return { money: s.money, owned: s.ownedCars, active: s.activeCar, stored: JSON.parse(localStorage.getItem('openstreet.save.v1')).activeCar }; });
assert.equal(bought.active, 'vektor'); assert.equal(bought.stored, 'vektor'); assert.ok(bought.owned.includes('vektor'));
console.log('гараж: кнопка была «' + btnTxt.trim() + '» →', JSON.stringify(bought));
await page.screenshot({ path: OUT + 'garage_bought.png' });
await tap('#garage-back'); await sleep(400);
await tap('#pause-resume'); await sleep(400);

// 4) Смена качества графики на лету
for (const q of ['low', 'high', 'auto']) {
  await page.evaluate((q) => { window.__game.R.setQuality(q); }, q);
  await sleep(1200);
  console.log('качество', q, JSON.stringify(await page.evaluate(() => { const R = window.__game.R; return { shadows: R.renderer.shadowMap.enabled, scale: R.scale, rw: R.renderW, rh: R.renderH }; })));
}

// 5) Стресс 45 с: случайный ввод, следим за NaN, памятью, DOM
const mem0 = await page.evaluate(() => performance.memory ? performance.memory.usedJSHeapSize : 0);
const keys = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'ArrowDown'];
await page.keyboard.down('ArrowUp');
let bad = 0;
for (let t = 0; t < 45; t++) {
  const k = keys[1 + (t * 7) % 4];
  await page.keyboard.down(k); await sleep(500); await page.keyboard.up(k); await sleep(500);
  const ok = await page.evaluate(() => { const c = window.__game.car; return isFinite(c.x) && isFinite(c.z) && isFinite(c.vx) && isFinite(c.heading); });
  if (!ok) bad++;
}
await page.keyboard.up('ArrowUp');
const fin = await page.evaluate(() => { const G = window.__game, c = G.car, R = G.R;
  return { coll: c.stats.collisions, dist: Math.round(c.stats.distance), score: Math.round(G.g.score), money: Math.round(G.save.money), heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    popupsDom: document.querySelectorAll('.popup').length, cpMeshes: R.cpMeshes.size, geometries: R.renderer.info.memory.geometries, textures: R.renderer.info.memory.textures, calls: R.drawCalls }; });
assert.equal(bad, 0, 'нечисловые координаты в стресс-тесте');
console.log('стресс 45с: NaN-кадров', bad, JSON.stringify(fin), 'heap старт MB', +(mem0 / 1048576).toFixed(1));
await page.screenshot({ path: OUT + 'stress_end.png' });
console.log('ошибки/предупреждения:', errs.length ? errs.slice(0, 10) : 'нет');
assert.deepEqual(errs, [], 'ошибки браузера');
await browser.close();
