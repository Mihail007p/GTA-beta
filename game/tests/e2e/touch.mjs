// Сенсорное управление (мультитач через CDP): стрелки руля (по умолчанию), стик (опция),
// педали с перекатом пальца, пауза / продолжить / респаун.
import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 90000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const box = async (sel) => page.locator(sel).boundingBox();
const center = async (sel) => { const b = await box(sel); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const st = () => page.evaluate(() => { const G = window.__game, c = G.car, i = G.input.state;
  return { state: G.state, kmh: Math.round(Math.abs(c.speed) * 3.6), steerIn: +i.steer.toFixed(2), thr: i.throttle, brk: i.brake, hb: i.handbrake, carSteer: +c.steer.toFixed(2) }; });
const frames = (n = 2) => page.evaluate((n) => new Promise(res => { let k = 0; const f = () => (++k >= n ? res(k) : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const settle = async (ms) => { await sleep(ms); await frames(2); };
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, k) => ({ x: p.x, y: p.y, id: p.id ?? k })) });
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : '')); };

await page.touchscreen.tap(...Object.values(await center('#btn-play')));
await sleep(600);
console.log('после тапа ЕХАТЬ:', JSON.stringify(await st()));
const fps = await page.evaluate(() => new Promise(res => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
console.log('кадров/с в headless (SwiftShader, без GPU):', fps);

// ---------------------------------------------------------------- СТРЕЛКИ --
const vis = await page.evaluate(() => { const shown = (sel) => { const e = document.querySelector(sel); const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0; }; return {
  arrows: shown('[data-zone="arrows"]'),
  stick: shown('[data-zone="stick"]'),
  ghost: shown('[data-el="ghost"]'),
  mode: window.__game.save.settings.steerMode,
}; });
check('по умолчанию стрелки (стик и «РУЛЬ» скрыты)', vis.arrows && !vis.stick && !vis.ghost && vis.mode === 'arrows', JSON.stringify(vis));
const L = await box('[data-arrow="left"]'), Rb = await box('[data-arrow="right"]');
check('стрелки крупные и внизу слева', L.width >= 96 && L.height >= 84 && L.x < 60 && L.y + L.height > 330 && Rb.x > L.x + L.width,
  `◀ ${Math.round(L.x)},${Math.round(L.y)} ${Math.round(L.width)}×${Math.round(L.height)}  ▶ x=${Math.round(Rb.x)}`);
const left = { x: L.x + L.width / 2, y: L.y + L.height / 2 }, right = { x: Rb.x + Rb.width / 2, y: Rb.y + Rb.height / 2 };
const gas = await center('[data-btn="gas"]'), hand = await center('[data-btn="hand"]'), brake = await center('[data-btn="brake"]');

// закон нарастания — детерминированно, с подменой времени (кадры в headless слишком редкие)
const ramp = await page.evaluate(() => {
  const inp = window.__game.input, real = performance.now.bind(performance);
  let t = 1000; performance.now = () => t;
  const r = {};
  try {
    inp.releaseAll(); inp._digitalSteer(0);
    const at = (ms, target) => { const end = t + ms; let v = 0; while (t < end) { t += 1000 / 60; v = inp._digitalSteer(target); } return +v.toFixed(3); };
    r.f1 = at(1000 / 60, -1);           // 1 кадр
    r.t60 = at(1000 / 60 * 3, -1);      // ~67 мс
    r.t200 = at(140, -1);               // ~200 мс
    r.back50 = at(50, 0);               // отпустили: 50 мс
    r.back100 = at(50, 0);              // 100 мс
    r.flip = (at(1000, -1), at(100, 1)); // перекладка −1 → +1 за 100 мс
    inp.setOptions({ steerSens: 'high' }); inp.releaseAll(); inp._digitalSteer(0);
    r.high100 = at(100, 1);
    inp.setOptions({ steerSens: 'low' }); inp.releaseAll(); inp._digitalSteer(0);
    r.low100 = at(100, 1);
  } finally {
    performance.now = real;
    inp.setOptions({ steerSens: window.__game.save.settings.steerSens }); inp.releaseAll();
  }
  return r;
});
check('нарастание: кадр — подруливание, ~0.2 с — полный выворот', ramp.f1 > -0.15 && ramp.f1 < 0 && ramp.t60 > -0.5 && ramp.t200 === -1, JSON.stringify(ramp));
check('возврат в центр быстрее нарастания (≤0.1 с)', ramp.back50 > -0.6 && ramp.back100 === 0);
check('перекладка влево→вправо: за 0.1 с уже на другой стороне', ramp.flip > 0 && ramp.flip < 0.3);
check('чувствительность: острый быстрее среднего быстрее мягкого', ramp.high100 > 0.85 && ramp.low100 < 0.4);
await touch('touchStart', [{ ...gas, id: 1 }]);
await settle(1200);
await touch('touchStart', [{ ...gas, id: 1 }, { ...left, id: 2 }]);
await settle(500);
const s2 = await st();
check('◀ удержание → полный выворот влево', s2.steerIn <= -0.99 && s2.thr === 1, JSON.stringify(s2));
await page.screenshot({ path: OUT + 'arrows_left.png' });
// перекат пальца ◀ → ▶ не отрывая
for (let k = 1; k <= 6; k++) {
  await touch('touchMove', [{ ...gas, id: 1 }, { x: left.x + (right.x - left.x) * k / 6, y: left.y, id: 2 }]); await sleep(30);
}
await settle(450);
const s3 = await st();
const act = await page.evaluate(() => [...document.querySelectorAll('.arrow-btn.active')].map(e => e.dataset.arrow).join(','));
check('палец перекатился на ▶ → полный выворот вправо', s3.steerIn >= 0.99, JSON.stringify(s3) + ' подсвечено: ' + act);
check('подсвечена только ▶', act === 'right', act);
// перекат газа на ручник, руль держим
for (let k = 1; k <= 6; k++) {
  await touch('touchMove', [{ x: gas.x + (hand.x - gas.x) * k / 6, y: gas.y + (hand.y - gas.y) * k / 6, id: 1 }, { ...right, id: 2 }]); await sleep(35);
}
await settle(200);
const s4 = await st();
check('газ → РУЧНИК перекатом, руль вправо держится', s4.hb === true && s4.steerIn >= 0.99, JSON.stringify(s4));
// отпустить стрелку — руль быстро в центр
await touch('touchMove', [{ ...hand, id: 1 }]);
await touch('touchEnd', []);
await settle(160);
const s5 = await st();
check('отпустил всё → руль в центре за ~0.1 с', s5.steerIn === 0 && !s5.hb && s5.thr === 0, JSON.stringify(s5));
// касание в щели между стрелками — всё равно руль (без мёртвой зоны)
const gapX = (L.x + L.width + Rb.x) / 2;
await touch('touchStart', [{ x: gapX - 3, y: left.y, id: 4 }]); await settle(300);
const g1 = await st();
await touch('touchEnd', []); await settle(150);
await touch('touchStart', [{ x: gapX + 3, y: left.y, id: 5 }]); await settle(300);
const g2 = await st();
await touch('touchEnd', []); await settle(150);
check('щель между стрелками: левее середины — влево, правее — вправо', g1.steerIn < -0.9 && g2.steerIn > 0.9, `${g1.steerIn} / ${g2.steerIn}`);
// касание выше кнопки, но в зоне — тоже руль
await touch('touchStart', [{ x: left.x, y: L.y - 30, id: 6 }]); await settle(300);
const g3 = await st();
await touch('touchEnd', []); await settle(150);
check('касание чуть выше ◀ (в зоне) тоже рулит', g3.steerIn < -0.9, String(g3.steerIn));
await touch('touchStart', [{ ...brake, id: 3 }]); await settle(400);
const sb = await st();
check('ТОРМОЗ', sb.brk === 1, JSON.stringify(sb));
await touch('touchEnd', []); await sleep(200);

// ------------------------------------------------------------------ СТИК --
await page.evaluate(() => { const G = window.__game; G.save.settings.steerMode = 'stick'; G.input.setOptions(G.save.settings); });
await sleep(100);
const vis2 = await page.evaluate(() => { const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none'; return { arrows: shown('[data-zone="arrows"]'), stick: shown('[data-zone="stick"]') }; });
check('опция «Стик»: стик вместо стрелок', !vis2.arrows && vis2.stick, JSON.stringify(vis2));
const stick0 = { x: 160, y: 260 };
await touch('touchStart', [{ ...gas, id: 1 }, { ...stick0, id: 2 }]);
await sleep(100);
for (let dx = 10; dx <= 50; dx += 10) { await touch('touchMove', [{ ...gas, id: 1 }, { x: stick0.x + dx, y: stick0.y, id: 2 }]); await sleep(30); }
await settle(300);
const sk = await st();
check('стик вправо 50 px → руль ~0.7', sk.steerIn > 0.6 && sk.steerIn < 0.85 && sk.thr === 1, JSON.stringify(sk));
await touch('touchEnd', []); await settle(250);
check('стик отпущен → 0', (await st()).steerIn === 0);
await page.evaluate(() => { const G = window.__game; G.save.settings.steerMode = 'arrows'; G.input.setOptions(G.save.settings); });

// ------------------------------------------------------- пауза / респаун --
await page.touchscreen.tap(...Object.values(await center('#btn-pause'))); await sleep(400);
check('пауза', (await st()).state === 'pause' && await page.locator('#pause').isVisible());
await page.touchscreen.tap(...Object.values(await center('#pause-resume'))); await sleep(400);
check('продолжить', (await st()).state === 'play');
const before = await page.evaluate(() => [window.__game.car.x, window.__game.car.z]);
await page.touchscreen.tap(...Object.values(await center('#btn-reset'))); await sleep(400);
const after = await page.evaluate(() => [window.__game.car.x, window.__game.car.z]);
check('⟲ респаун', Math.hypot(after[0] - before[0], after[1] - before[1]) >= 0 && after.every(Number.isFinite), before.map(v => v.toFixed(1)) + ' → ' + after.map(v => v.toFixed(1)));
check('ошибок нет', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
await browser.close();
process.exit(fails ? 1 : 0);
