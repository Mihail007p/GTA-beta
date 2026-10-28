// Проверка реалистичных моделей: каждая машина грузится из GLB (не заглушка),
// снимок в гараже и в езде, метрики draw calls / треугольников, ошибки консоли.
import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const W = Number(process.env.W || 820), H = Number(process.env.H || 370);
const only = process.argv[2] ? process.argv[2].split(',') : null;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('requestfailed', r => logs.push('[reqfail] ' + r.url()));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
await page.goto('http://localhost:8080/?shot&noaudio', { waitUntil: 'load' });
const ok = await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 120000 }).then(() => true).catch(() => false);
console.log('menu ready:', ok, 'in', Date.now() - t0, 'ms');
const first = await page.evaluate(() => { const ud = window.__game.R.playerMesh.userData; return { placeholder: !!ud.placeholder, isModel: !!ud.isModel }; });
console.log('активная машина на старте:', JSON.stringify(first));
await sleep(1200);
await page.screenshot({ path: OUT + 'cars_menu.png' });

const ids = await page.evaluate(async () => (await import('/js/cars.js')).CARS.map(c => c.id));
// спрятать интерфейс на время снимков машин
await page.addStyleTag({ content: '.screen, #hud, #controls-root, #toast { display: none !important; }' });
let bad = 0;
for (const id of ids) {
  if (only && !only.includes(id)) continue;
  const t1 = Date.now();
  const r = await page.evaluate(async (id) => {
    const { carById } = await import('/js/cars.js');
    const { preloadCarModel } = await import('/js/car-model.js');
    const G = window.__game, R = G.R;
    const def = carById(id);
    await preloadCarModel(def);
    R.setPlayerCar(def);
    const ud = R.playerMesh.userData;
    let tris = 0, meshes = 0, transp = 0, shadow = 0; const cats = {};
    R.playerMesh.traverse(o => { if (o.isMesh) { meshes++; const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      if (o.material.transparent) transp++; if (o.castShadow) shadow++; const c = o.userData.cat || '-'; cats[c] = (cats[c] || 0) + 1; } });
    const progs = R.renderer.info.programs ? R.renderer.info.programs.length : -1;
    return { name: def.name, isModel: !!ud.isModel, placeholder: !!ud.placeholder, meshes, tris: Math.round(tris), transp, shadow,
      wheels: ud.wheels.map(w => +w.r.toFixed(3)), L: +ud.length.toFixed(2), W: +ud.width.toFixed(2), tails: (ud.tailMats || []).length, cats, progs };
  }, id);
  console.log(`\n[${id}] за ${Date.now() - t1} мс:`, JSON.stringify(r));
  if (!r.isModel) { bad++; console.log('  !!! модель не загрузилась — показана заглушка'); }
  // гаражный ракурс: 3/4 спереди
  await page.evaluate(() => { const G = window.__game; G.R.orbit = { a: 0.75, r: 5.0, h: 1.25, speed: 0, lookY: 0.5 }; });
  await sleep(900);
  await page.screenshot({ path: OUT + `car_${id}_front.png` });
  await page.evaluate(() => { const G = window.__game; G.R.orbit = { a: 0.75 + Math.PI + 0.25, r: 5.0, h: 1.6, speed: 0, lookY: 0.5 }; });
  await sleep(900);
  await page.screenshot({ path: OUT + `car_${id}_rear.png` });
  const st = await page.evaluate(() => ({ calls: window.__game.R.drawCalls, tris: window.__game.R.triangles }));
  console.log('  кадр (меню-сцена):', JSON.stringify(st));
  // игровая камера: старт, газ 2.5 с, лёгкий поворот
  await page.evaluate(() => { window.__game.R.orbit = null; });
  await page.evaluate(() => document.getElementById('btn-play').click());
  // каждая машина стартует с одной точки (иначе 2–4-я упирались в дом после предыдущей)
  await page.evaluate(() => { const c = window.__game.car; c.x = -10.5; c.z = 6; c.heading = Math.PI / 2; c.vx = 0; c.vz = 0; c.speed = 0; c.yawRate = 0; c.lateral = 0; window.__game.R._camInit = false; });
  await sleep(500);
  await page.keyboard.down('ArrowUp'); await sleep(2200);
  await page.keyboard.down('ArrowLeft'); await sleep(450);
  await page.screenshot({ path: OUT + `car_${id}_play.png` });
  const pl = await page.evaluate(() => ({ calls: window.__game.R.drawCalls, tris: window.__game.R.triangles, kmh: Math.round(Math.abs(window.__game.car.speed) * 3.6) }));
  console.log('  в езде:', JSON.stringify(pl));
  await page.keyboard.up('ArrowLeft'); await page.keyboard.up('ArrowUp');
  await page.evaluate(() => { const G = window.__game; G.setState('menu'); });
  await page.evaluate(() => { const G = window.__game; G.R.orbit = { a: 0.75, r: 5.0, h: 1.25, speed: 0, lookY: 0.5 }; });
}
console.log('\nошибок загрузки моделей:', bad);
console.log('логи консоли (' + logs.length + '):\n' + logs.slice(0, 25).join('\n'));
await browser.close();
