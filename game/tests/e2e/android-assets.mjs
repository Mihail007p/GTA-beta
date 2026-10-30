// Browser-level test of files extracted from the signed APK, NOT an Android/device test.
// APK_PATH=/path/to/OpenStreet.apk node android-assets.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const versionProperties = fs.readFileSync(path.join(here, '../../../android/version.properties'), 'utf8');
const versionName = versionProperties.match(/^VERSION_NAME=(.+)$/m)?.[1]?.trim();
if (!versionName) throw new Error('VERSION_NAME is missing from android/version.properties');
const apk = path.resolve(process.env.APK_PATH || path.join(here, `../../../android/app/build/outputs/apk/release/OpenStreet-v${versionName}.apk`));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openstreet-apk-'));
const missing = [], external = [], errors = [], loaded = new Set();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.webp': 'image/webp' };
let browser;
try {
  execFileSync('unzip', ['-q', apk, 'assets/game/*', '-d', temp]);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    window.__swCalls = 0;
    if (navigator.serviceWorker) {
      const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = (...args) => { window.__swCalls++; return register(...args); };
    }
  });
  await ctx.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() !== 'GET' || url.protocol !== 'https:' || url.hostname !== 'appassets.androidplatform.net' || !url.pathname.startsWith('/game/')) {
      external.push(req.url()); return route.abort();
    }
    const relative = decodeURIComponent(url.pathname).slice(1);
    const target = path.resolve(temp, 'assets', relative);
    if (!target.startsWith(path.join(temp, 'assets', 'game') + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      missing.push(url.pathname); return route.fulfill({ status: 404, body: '' });
    }
    loaded.add(relative);
    return route.fulfill({ status: 200, headers: { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: fs.readFileSync(target) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const wait = (fn, arg = null) => page.waitForFunction(fn, arg, { timeout: 90000 });
  const tap = async selector => {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, 'not visible: ' + selector);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  const back = () => page.evaluate(() => window.__openStreetAndroidBack());

  await page.goto('https://appassets.androidplatform.net/game/index.html?androidApp=1&noaudio');
  await wait(() => window.__game?.state === 'menu');
  assert.equal(await page.locator('#btn-fs').isHidden(), true, 'native shell is already fullscreen');
  assert.equal(await page.evaluate(() => window.__swCalls), 0, 'APK must not register a service worker');
  assert.equal(await back(), false, 'back from menu requests exit confirmation');
  assert.ok(await page.evaluate(() => !!__game.R.heroActor), 'bundled hero loaded');
  console.log('  ✓ APK assets load at the native origin, without a service worker or fullscreen prompt');

  await tap('#btn-settings'); await tap('#btn-credits');
  if (process.env.E2E_SHOTS) {
    fs.mkdirSync(process.env.E2E_SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.E2E_SHOTS, 'android-credits.png') });
  }
  assert.equal(await page.locator('#credits').isVisible(), true);
  assert.equal(await page.$eval('#credits a', a => a.target), '_self', 'native links use the external-browser handler');
  assert.equal(await back(), true);
  assert.equal(await page.locator('#settings').isVisible(), true);
  assert.equal(await back(), true);
  assert.equal(await page.locator('#menu').isVisible(), true);
  await tap('#btn-character'); await wait(() => __game.state === 'character');
  assert.equal(await back(), true); await wait(() => __game.state === 'menu');
  await tap('#btn-garage'); await wait(() => __game.state === 'garage');
  assert.equal(await back(), true); await wait(() => __game.state === 'menu');
  console.log('  ✓ settings/credits, character and garage return correctly on Android back');

  await tap('#btn-play'); await wait(() => __game.state === 'play' && __game.onFoot);
  const before = await page.evaluate(() => ({ x: __game.hero.x, z: __game.hero.z }));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 270, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: 210, id: 1 }] });
  await wait(p => Math.hypot(__game.hero.x - p.x, __game.hero.z - p.z) > 0.1, before);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await back(), true); await wait(() => __game.state === 'pause');
  await tap('#pause-settings'); await tap('#btn-credits');
  assert.equal(await back(), true); assert.equal(await page.locator('#settings').isVisible(), true);
  assert.equal(await back(), true); assert.equal(await page.locator('#pause').isVisible(), true);
  assert.equal(await back(), true); await wait(() => __game.state === 'play');

  // Проверяем именно файлы из APK: вход, позу, телевизор с дивана и native back.
  await page.evaluate(() => {
    const door = __game.entrances.find(d => d.kind === 'home');
    Object.assign(__game.hero, { x: door.x, z: door.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в дом');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition);
  await page.evaluate(() => {
    const sofa = __game.interior.layout.interactions.find(i => i.id === 'sofa');
    Object.assign(__game.hero, { x: sofa.x, z: sofa.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Сесть на диван');
  await tap('#vehicle-action'); await wait(() => __game.hero.pose?.kind === 'sit' && __game.hero.pose.amount === 1);
  await tap('#home-tv-action'); await wait(() => __game.interior.homeState.tv && __game.R.interiorScene.userData.home.tvPicture.visible);
  assert.equal(await back(), true); await wait(() => __game.state === 'pause');
  const paused = await page.evaluate(() => __game.hero.pose.amount);
  await page.waitForTimeout(300); assert.equal(await page.evaluate(() => __game.hero.pose.amount), paused);
  assert.equal(await back(), true); await wait(() => __game.state === 'play');
  await tap('#vehicle-action'); await wait(() => !__game.hero.pose);
  console.log('  ✓ packaged home interactions and pause/back work with the native-origin assets');

  // Готовка, инвентарь и back проверяются на файлах, извлечённых из APK.
  await page.evaluate(() => {
    const stove = __game.interior.layout.interactions.find(i => i.id === 'stove');
    Object.assign(__game.hero, { x: stove.x, z: stove.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Включить плиту');
  await tap('#vehicle-action'); await wait(() => __game.interior.homeState.stove);
  await wait(() => !document.querySelector('#life-context-action').classList.contains('hidden'));
  await tap('#life-context-action'); await wait(() => __game.state === 'life');
  await tap('[data-action="cook"][data-id="breakfast"]');
  assert.equal(await page.evaluate(() => __game.save.life.inventory.meal), 1);
  assert.equal(await back(), true); await wait(() => __game.state === 'play');
  await page.evaluate(() => { __game.save.life.health = 70; __game.save.life.satiety = 40; });
  await tap('#btn-bag'); await tap('[data-action="use"][data-id="meal"]');
  assert.equal(await page.evaluate(() => __game.save.life.health), 85);
  assert.equal(await back(), true); await wait(() => __game.state === 'play');
  console.log('  ✓ packaged cooking, inventory and Android back work');

  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  await page.evaluate(() => {
    __game.save.money = 1000;
    const d = __game.entrances.find(x => x.kind === 'shop');
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition && __game.R.vendorActor);
  await page.evaluate(() => {
    const i = __game.interior.layout.interactions[0]; Object.assign(__game.hero, { x: i.x, z: i.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Поговорить с продавцом');
  await tap('#vehicle-action'); await tap('[data-action="buy-outfit"][data-id="smart"]');
  assert.equal(await page.evaluate(() => __game.save.money), 750);
  assert.equal(await back(), true); await wait(() => __game.state === 'play');
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  await page.evaluate(() => {
    const d = __game.entrances.find(x => x.kind === 'home'); Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в дом');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition);
  await page.evaluate(() => {
    const i = __game.interior.layout.interactions.find(x => x.id === 'cabinet'); Object.assign(__game.hero, { x: i.x, z: i.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Открыть шкаф');
  await tap('#vehicle-action'); await wait(() => __game.interior.homeState.cabinet);
  await tap('#life-context-action'); await tap('[data-action="wear"][data-id="smart"]');
  await wait(() => __game.save.life.outfit === 'smart' && __game.R.heroOutfit === 'smart');
  assert.equal(await back(), true); await wait(() => __game.state === 'play');
  console.log('  ✓ packaged seller, purchased outfit and animated character load without remote requests');

  // Новая работа выполняется на ресурсах именно из APK; сохраняем её на середине.
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  await page.evaluate(() => {
    const d = __game.entrances.find(x => x.kind === 'shop');
    Object.assign(__game.hero, { x: d.x, z: d.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин');
  await tap('#vehicle-action'); await wait(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition);
  await page.evaluate(() => {
    const i = __game.interior.layout.interactions[0];
    Object.assign(__game.hero, { x: i.x, z: i.z, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Поговорить с продавцом');
  await tap('#vehicle-action');
  await page.locator('[data-action="job"][data-id="cleanup"]').scrollIntoViewIfNeeded();
  await tap('[data-action="job"][data-id="cleanup"]');
  assert.equal(await page.evaluate(() => __game.save.life.job?.type), 'cleanup');
  await back(); await wait(() => __game.state === 'play');
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу');
  await tap('#vehicle-action'); await wait(() => !__game.interior && !__game.roomTransition);
  await page.evaluate(() => {
    const d = __game.entrances.find(x => x.id === __game.save.life.job.targetId);
    Object.assign(__game.hero, { x: d.x + d.nx * 0.8, z: d.z + d.nz * 0.8, vx: 0, vz: 0, speed: 0 });
  });
  await wait(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Собрать мусор');
  await tap('#vehicle-action');
  await wait(() => __game.save.life.job?.type === 'cleanup' && __game.save.life.job.index === 1);
  assert.equal(await page.evaluate(() => __game.save.life.completedJobs), 0, 'partial cleanup must not pay');
  console.log('  ✓ packaged cleanup job accepts touch input and records the first of three pickups');

  await page.evaluate(() => { __game.save.money = 4321; window.__openStreetAndroidPause(); });
  await wait(() => __game.state === 'pause');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('openstreet.save.v1')).money), 4321);
  console.log('  ✓ touch movement, Android back/pause and local save work with packaged assets');

  await page.reload(); await wait(() => window.__game?.state === 'menu');
  assert.equal(await page.evaluate(() => __game.save.money), 4321, 'save survives reload on the same native origin');
  assert.deepEqual(await page.evaluate(() => [__game.save.life.job?.type, __game.save.life.job?.index]), ['cleanup', 1], 'partial job survives native-origin reload');
  assert.equal(await page.evaluate(() => window.__swCalls), 0);
  assert.ok(loaded.has('game/assets/characters/hero-1.glb'));
  assert.ok(loaded.has('game/js/home-interactions.js'));
  assert.ok(loaded.has('game/js/life.js'));
  assert.ok(loaded.has('game/js/crowd-collisions.js'));
  assert.ok(loaded.has('game/js/work-crowd.js'));
  assert.ok(loaded.has('game/assets/characters/hero-1-smart.glb'));
  assert.ok(loaded.has('game/assets/characters/citizen-1.glb'));
  assert.ok(loaded.has('game/assets/cars/cayenne.glb'));
  assert.ok(loaded.has('game/assets/traffic.glb'));
  assert.deepEqual(missing, [], 'all requested assets exist inside the APK');
  assert.deepEqual(external, [], 'game requested no remote URLs');
  assert.deepEqual(errors, [], 'no JS/console errors');
  console.log('  ✓ reload retains progress, all requested files came from the APK, no external requests');
  await ctx.close();
} finally {
  if (browser) await browser.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
