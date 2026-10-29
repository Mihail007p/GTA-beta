// Настоящее обновление старой установленной игры на текущую версию.
// LEGACY_GAME_ROOT=/путь/к/старой/game node upgrade.mjs
// Сервер создаётся на отдельном порту; старые файлы не меняются.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

if (!process.env.LEGACY_GAME_ROOT) throw new Error('Укажите LEGACY_GAME_ROOT: путь к распакованной старой папке game');
const legacy = path.resolve(process.env.LEGACY_GAME_ROOT);
const current = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const currentVersion = (await fs.readFile(path.join(current, 'sw.js'), 'utf8')).match(/const CACHE_VERSION = '([^']+)'/)?.[1];
if (!currentVersion) throw new Error('Не определена версия кэша новой игры');
let root = legacy;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const bytes = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const currentCache = `openstreet:http://localhost:${server.address().port}/:${currentVersion}`;
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const menu = () => page.waitForFunction(() => window.__game?.state === 'menu', null, { timeout: 120000 });
  await page.goto(`http://localhost:${server.address().port}/?shot&noaudio`);
  await menu();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 });
  const previousCaches = await page.evaluate(() => caches.keys());
  const ownScope = `openstreet:http://localhost:${server.address().port}/:`;
  const oldOwn = previousCaches.filter(c => (c.startsWith('openstreet-') || c.startsWith(ownScope)) && c !== currentCache);
  assert.ok(oldOwn.length, `неожиданный старый кэш: ${previousCaches}`);
  await page.evaluate(async () => {
    await caches.open('another-application-cache');
    await caches.open(`openstreet:${location.origin}/another-scope/:v1`);
    const s = window.__game.save;
    Object.assign(s, { money: 7500, bestScore: 4321, ownedCars: ['strada', 'vektor'], activeCar: 'vektor' });
    s.settings.quality = 'low';
    delete s.selectedCharacter;
    localStorage.setItem('openstreet.save.v1', JSON.stringify(s));
    window.__workerChanged = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { window.__workerChanged = true; }, { once: true });
  });
  root = current;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => window.__workerChanged, null, { timeout: 90000 });
  // controllerchange может прийти до завершения асинхронного activate и очистки кэшей.
  // Проверяем конечное состояние, а не скорость удаления на конкретном устройстве.
  const scopedOld = oldOwn.filter(c => c.startsWith(ownScope));
  await page.waitForFunction(async ({ currentCache, scopedOld }) => {
    const keys = await caches.keys();
    return keys.includes(currentCache) && scopedOld.every(k => !keys.includes(k));
  }, { currentCache, scopedOld }, { timeout: 30000 });
  const newCaches = await page.evaluate(() => caches.keys());
  assert.ok(newCaches.includes(currentCache));
  for (const key of oldOwn.filter(c => c.startsWith(ownScope))) assert.ok(!newCaches.includes(key), 'старый кэш этого приложения должен быть заменён');
  assert.ok(newCaches.includes('another-application-cache'), 'нельзя удалять чужие кэши');
  assert.ok(newCaches.some(k => k.includes('/another-scope/')), 'нельзя удалять кэш другой области');
  await page.reload();
  await menu();
  await page.waitForFunction(() => __game.R.heroId === 'hero-1', null, { timeout: 90000 });
  const loaded = await page.evaluate(() => ({
    money: __game.save.money, score: __game.save.bestScore, cars: [...__game.save.ownedCars],
    activeCar: __game.save.activeCar, hero: __game.save.selectedCharacter,
  }));
  assert.deepEqual(loaded, { money: 7500, score: 4321, cars: ['strada', 'vektor'], activeCar: 'vektor', hero: 'hero-1' });
  console.log(`Старый кэш → ${currentCache}: деньги, рекорд, машины и выбранный автомобиль сохранены; герой добавлен.`);
  await ctx.setOffline(true);
  await page.reload();
  await menu();
  await page.waitForFunction(() => __game.R.heroId === 'hero-1', null, { timeout: 90000 });
  await page.locator('#btn-play').click();
  await page.waitForFunction(() => __game.state === 'play' && __game.onFoot && __game.R.heroActor.root.visible, null, { timeout: 30000 });
  const box = await page.locator('#vehicle-action').boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => !__game.onFoot, null, { timeout: 30000 });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => __game.onFoot && __game.R.heroActor.root.visible, null, { timeout: 30000 });
  // Новый интерьер также должен работать после обновления и перезагрузки без сети.
  await page.evaluate(() => {
    const door = __game.entrances.find(d => d.kind === 'shop');
    Object.assign(__game.hero, { x: door.x, z: door.z, vx: 0, vz: 0, speed: 0 });
  });
  await page.waitForFunction(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в магазин', null, { timeout: 30000 });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => __game.interior?.layout.kind === 'shop' && !__game.roomTransition, null, { timeout: 30000 });
  await page.evaluate(() => Object.assign(__game.hero, { x: 0, z: 5.1, vx: 0, vz: 0, speed: 0 }));
  await page.waitForFunction(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Выйти на улицу', null, { timeout: 30000 });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => !__game.interior && !__game.roomTransition, null, { timeout: 30000 });
  await page.evaluate(() => {
    const door = __game.entrances.find(d => d.kind === 'home');
    Object.assign(__game.hero, { x: door.x, z: door.z, vx: 0, vz: 0, speed: 0 });
  });
  await page.waitForFunction(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Войти в дом', null, { timeout: 30000 });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => __game.interior?.layout.kind === 'home' && !__game.roomTransition, null, { timeout: 30000 });
  await page.evaluate(() => {
    const sofa = __game.interior.layout.interactions.find(i => i.id === 'sofa');
    Object.assign(__game.hero, { x: sofa.x, z: sofa.z, vx: 0, vz: 0, speed: 0 });
  });
  await page.waitForFunction(() => document.querySelector('#vehicle-action').getAttribute('aria-label') === 'Сесть на диван', null, { timeout: 30000 });
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => __game.hero.pose?.kind === 'sit' && __game.hero.pose.amount === 1, null, { timeout: 30000 });
  const tvButton = await page.locator('#home-tv-action').boundingBox();
  assert.ok(tvButton);
  await page.touchscreen.tap(tvButton.x + tvButton.width / 2, tvButton.y + tvButton.height / 2);
  await page.waitForFunction(() => __game.interior.homeState.tv && __game.R.interiorScene.userData.home.tvPicture.visible, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => __game.save.money), 7500);
  assert.deepEqual(errors, []);
  console.log('Обновлённая игра, герой, магазин, диван и телевизор работают без сети; сохранение не потеряно.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
