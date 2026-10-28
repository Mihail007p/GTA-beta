import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 820, height: 370 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
await page.screenshot({ path: OUT + 'menu.png' });
await page.click('#btn-play');
await new Promise(r => setTimeout(r, 600));
// машина у правой кромки дороги (x≈-1), смотрит на запад → камера за ней оказалась бы в доме (x>3)
const r = await page.evaluate(async () => {
  const G = window.__game, c = G.car, R = G.R;
  // найдём z, где за спиной точно стоит дом
  c.x = -1.2; c.z = 26; c.heading = Math.PI; c.vx = 0; c.vz = 0; c.speed = 0;
  R._camInit = false; R._camClip = 99;
  await new Promise(r => setTimeout(r, 5000));
  return { carX: c.x.toFixed(1), camX: R.camera.position.x.toFixed(2), camZ: R.camera.position.z.toFixed(2), clip: R._camClip.toFixed(2), dist: R.camDist.toFixed(2) };
});
console.log('камера у стены:', JSON.stringify(r));
await page.screenshot({ path: OUT + 'camclip.png' });
console.log('ошибки:', errs.length ? errs : 'нет');
await browser.close();
