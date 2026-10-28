// Проверка размещения в глубоком пути без ответа сервера на папку и с
// кросс-доменными редиректами бинарных файлов (как у Raw.githack).
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = '/owner/repo/1234567890abcdef1234567890abcdef12345678/game/';
const nextPrefix = '/owner/repo/abcdef1234567890abcdef1234567890abcdef12/game/';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary' };
const requests = [];
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
const close = s => new Promise(resolve => s.close(resolve));
const read = async pathname => {
  const scope = [prefix, nextPrefix].find(p => pathname.startsWith(p));
  if (!scope) throw new Error('outside test prefix');
  const file = path.resolve(root, pathname.slice(scope.length));
  if (!file.startsWith(root + path.sep)) throw new Error('outside game');
  return fs.readFile(file);
};
const assetHost = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const body = await read(pathname);
    res.writeHead(200, { 'Content-Type': types[path.extname(pathname)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
});
await listen(assetHost);
const appHost = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push(pathname);
  if (pathname === prefix + 'seed.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html>'); }
  if (pathname === prefix || pathname === nextPrefix) { res.writeHead(404); return res.end('no directory listing'); }
  if (pathname.endsWith('.png') || pathname.endsWith('.glb')) {
    res.writeHead(301, { Location: `http://localhost:${assetHost.address().port}${pathname}`, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end();
  }
  try {
    const body = await read(pathname);
    res.writeHead(200, { 'Content-Type': types[path.extname(pathname)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await listen(appHost);
const origin = `http://localhost:${appHost.address().port}`;
const base = origin + prefix;
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + 'seed.html');
  const otherScopeCache = `openstreet:${origin}/other-project/:v1`;
  await page.evaluate(async other => {
    await caches.open('other-site-cache');
    await caches.open(other);
  }, otherScopeCache);
  await page.goto(base + 'index.html?shot&noaudio');
  const menu = () => page.waitForFunction(() => window.__game?.state === 'menu', null, { timeout: 120000 });
  await menu();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 90000 });
  const installed = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const own = keys.find(k => k.startsWith(`openstreet:${r.scope}:`));
    const cache = own && await caches.open(own);
    return {
      keys, scope: r.scope, own,
      files: await Promise.all(['index.html', 'manifest.json', 'assets/characters/hero-1.glb', 'assets/characters/hero-2.glb', 'js/vehicles.js', 'vendor/THREE-LICENSE.txt'].map(async u => !!(await cache?.match(u)))),
      manifestType: (await fetch('manifest.json')).headers.get('content-type'),
    };
  });
  assert.equal(installed.scope, base);
  assert.ok(installed.own);
  assert.ok(installed.keys.includes('other-site-cache') && installed.keys.includes(otherScopeCache));
  assert.deepEqual(installed.files, [true, true, true, true, true, true]);
  assert.match(installed.manifestType, /application\/json/);
  assert.equal(requests.filter(r => r === prefix).length, 0, 'установка не должна требовать ответ на адрес папки');
  // Новый хеш Raw.githack — другой путь и свой SW-кэш, но тот же origin
  // и localStorage: прогресс не должен исчезать при открытии новой ссылки.
  await page.evaluate(() => {
    const s = __game.save;
    Object.assign(s, { money: 3456, bestScore: 1234, ownedCars: ['strada', 'vektor'], activeCar: 'vektor' });
    localStorage.setItem('openstreet.save.v1', JSON.stringify(s));
  });
  const nextBase = origin + nextPrefix;
  await page.goto(nextBase + 'index.html?shot&noaudio');
  await menu();
  assert.deepEqual(await page.evaluate(() => [__game.save.money, __game.save.bestScore, __game.save.activeCar, ...__game.save.ownedCars]),
    [3456, 1234, 'vektor', 'strada', 'vektor']);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 90000 });
  const scopes = await page.evaluate(async () => ({ scope: (await navigator.serviceWorker.ready).scope, keys: await caches.keys() }));
  assert.equal(scopes.scope, nextBase);
  assert.ok(scopes.keys.includes(installed.own), 'кэш предыдущего пути не должен удаляться');
  assert.ok(scopes.keys.some(k => k.startsWith(`openstreet:${nextBase}`)), 'кэш нового пути установлен');
  assert.equal(requests.filter(r => r === nextPrefix).length, 0);
  await ctx.setOffline(true);
  await page.reload();
  await menu();
  await page.locator('#btn-character').click();
  await page.locator('#character-next').click();
  await page.waitForFunction(() => __game.R.heroId === 'hero-2' && __game.R.heroVisible, null, { timeout: 90000 });
  await page.goto(nextBase + '?shot&noaudio');
  await menu();
  assert.deepEqual(errors, []);
  console.log('Глубокий URL, переход на новый хеш с сохранением прогресса, независимые SW-кэши, CORS-редиректы и офлайн проверены. Чужие кэши сохранены.');
} finally {
  if (browser) await browser.close();
  await close(appHost); await close(assetHost);
}
