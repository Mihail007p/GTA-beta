import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const scenario = process.argv[2] || 'basic';
const W = Number(process.env.W || 820), H = Number(process.env.H || 370), DPR = Number(process.env.DPR || 1);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR, hasTouch: true });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('requestfailed', r => logs.push('[reqfail] ' + r.url()));
const t0 = Date.now();
await page.goto('http://localhost:8080/?shot&noaudio', { waitUntil: 'load' });
const ok = await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 90000 }).then(() => true).catch(() => false);
console.log('menu ready:', ok, 'in', Date.now() - t0, 'ms');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const info = async (label) => {
  const s = await page.evaluate(() => {
    const G = window.__game; if (!G) return null; const c = G.car, R = G.R;
    return { state: G.state, x: +c.x.toFixed(1), z: +c.z.toFixed(1), h: +c.heading.toFixed(2), kmh: Math.round(Math.abs(c.speed) * 3.6),
      drift: c.drifting, fps: Math.round(R.fps), rw: R.renderW, rh: R.renderH, scale: +R.scale.toFixed(2), calls: R.drawCalls, tris: R.triangles,
      score: Math.round(G.g.score), chain: G.g.chain, cps: G.g.checkpoints.length, coll: c.stats.collisions };
  });
  console.log(label, JSON.stringify(s));
};
await sleep(1500);
await page.screenshot({ path: OUT + 'menu.png' });
await info('menu');
if (scenario === 'garage') {
  await page.click('#btn-garage');
  for (let i = 0; i < 4; i++) {
    await sleep(i === 0 ? 2500 : 1800);
    await page.screenshot({ path: OUT + 'garage' + i + '.png' });
    await page.click('#car-next');
  }
} else if (scenario !== 'menu') {
  await page.click('#btn-play');
  await sleep(800);
  await page.screenshot({ path: OUT + 'play0.png' });
  await info('play0');
  await page.keyboard.down('ArrowUp');
  await sleep(2500);
  await page.screenshot({ path: OUT + 'play1.png' });
  await info('accel 2.5s');
  await sleep(2500);
  await info('accel 5s');
  await page.keyboard.down('ArrowRight');
  await sleep(700);
  await page.keyboard.down('Space');
  await sleep(500);
  await page.screenshot({ path: OUT + 'drift.png' });
  await info('drift');
  await page.keyboard.up('Space');
  await sleep(600);
  await page.keyboard.up('ArrowRight');
  await sleep(2500);
  await page.screenshot({ path: OUT + 'play2.png' });
  await info('after');
  await page.keyboard.up('ArrowUp');
}
console.log('--- console errors/warnings (' + logs.length + ') ---');
for (const l of logs.slice(0, 30)) console.log(l);
await browser.close();
