import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 } });
await ctx.addInitScript(() => {
  const orig = window.requestAnimationFrame.bind(window);
  window.__rafLog = [];
  window.requestAnimationFrame = (cb) => orig((t) => { const s = performance.now(); cb(t); const d = performance.now() - s; window.__rafLog.push([Math.round(t), Math.round(d)]); });
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
});
const page = await ctx.newPage();
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
await new Promise(r => setTimeout(r, 1500));
const menuLog = await page.evaluate(async () => { window.__rafLog.length = 0; await new Promise(r => setTimeout(r, 3000)); return window.__rafLog.map(x => x[0]); });
const perSec = (ts) => { const a = {}; for (const t of ts) { const k = Math.floor(t / 1000); a[k] = (a[k] || 0) + 1; } return Object.values(a).join(' '); };
console.log('МЕНЮ кадров/сек:', perSec(menuLog));
const t0 = await page.evaluate(() => { window.__rafLog.length = 0; window.__long.length = 0; return Math.round(performance.now()); });
await page.click('#btn-play');
const t1 = await page.evaluate(() => Math.round(performance.now()));
await new Promise(r => setTimeout(r, 5000));
const res = await page.evaluate(() => ({ raf: window.__rafLog.map(x => x[0]), dur: window.__rafLog.map(x => x[1]), long: window.__long.slice(0, 20), now: Math.round(performance.now()), st: window.__game.state, info: window.__game.R.renderer.info.render }));
console.log('клик в', t0, '→', t1, '| сейчас', res.now, '| state', res.st);
console.log('ЗАЕЗД кадров/сек:', perSec(res.raf), '| JS мс/кадр (медиана):', res.dur.slice().sort((a,b)=>a-b)[res.dur.length>>1]);
const gaps = res.raf.slice(1).map((v, i) => v - res.raf[i]).sort((a, b) => b - a).slice(0, 6);
console.log('самые длинные паузы между кадрами, мс:', gaps.join(' '));
console.log('long tasks [старт, длит]:', JSON.stringify(res.long));
await browser.close();
