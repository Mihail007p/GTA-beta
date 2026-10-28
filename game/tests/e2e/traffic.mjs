// Трафик на моделях: загрузились ли модели, сколько машин видно, кадры из игры.
import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, deviceScaleFactor: 1, hasTouch: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
await page.goto('http://localhost:8080/?shot&noaudio', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 120000 });
const st = await page.evaluate(() => { const R = window.__game.R; return { models: !!R.tTypes, types: R.tTypes ? R.tTypes.length : 0, shadowMeshes: (() => { let n = 0; R.playerMesh.traverse(o => { if (o.isMesh && o.castShadow) n++; }); return n; })() }; });
console.log('трафик на моделях:', JSON.stringify(st));
await page.evaluate(() => document.getElementById('btn-play').click());
await sleep(600);
// встать позади реальных машин трафика разных типов
for (let shot = 0; shot < 3; shot++) {
  const info = await page.evaluate((shot) => {
    const G = window.__game, c = G.car, cars = G.traffic.cars.filter(t => t.alive);
    const seen = new Set(); const pick = [];
    for (const t of cars) if (!seen.has(t.type)) { seen.add(t.type); pick.push(t); }
    const t = pick[shot % pick.length];
    const h = t.visHeading, back = 11 + shot * 2;
    c.x = t.x - Math.cos(h) * back - Math.sin(h) * 1.2; c.z = t.z - Math.sin(h) * back + Math.cos(h) * 1.2;
    c.heading = h; c.speed = 0; c.vx = 0; c.vz = 0; c.lateral = 0; c.yawRate = 0;
    G.R._camInit = false;
    return { type: t.type, x: t.x.toFixed(0), z: t.z.toFixed(0) };
  }, shot);
  await sleep(700);
  await page.screenshot({ path: OUT + 'traffic_close' + shot + '.png' });
  console.log('снимок', shot, JSON.stringify(info));
}
const st2 = await page.evaluate(() => { const R = window.__game.R; return { calls: R.drawCalls, tris: R.triangles, visibleTypes: R.tTypes.filter(m => m.visible).length, counts: R.tTypes.map(m => m.count) }; });
console.log('кадр:', JSON.stringify(st2));
// обычная езда 6 с — трафик сам по себе
await page.evaluate(() => { const G = window.__game; for (const t of G.traffic.cars) t.stunned = 0; });
await page.keyboard.down('ArrowUp'); await sleep(4000); await page.keyboard.up('ArrowUp'); await sleep(800);
await page.screenshot({ path: OUT + 'traffic_drive.png' });
const st3 = await page.evaluate(() => { const R = window.__game.R; const G = window.__game; return { calls: R.drawCalls, tris: R.triangles, alive: G.traffic.cars.filter(c => c.alive).length, coll: G.car.stats.collisions, kmh: Math.round(Math.abs(G.car.speed) * 3.6) }; });
console.log('езда:', JSON.stringify(st3));
console.log('логи (' + logs.length + '):', logs.slice(0, 10).join('\n'));
await browser.close();
