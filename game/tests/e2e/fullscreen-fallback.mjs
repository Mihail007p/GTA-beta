// Отказ Fullscreen API и отсутствие поддержки: игра не зависает, есть понятная подсказка.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const opts = { viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true };
const tap = async (page, selector) => {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `кнопка ${selector} не видна`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
};
try {
  const unsupported = await browser.newContext(opts);
  await unsupported.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
  });
  const p = await unsupported.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto('http://localhost:8080/?noaudio');
  await p.waitForFunction(() => window.__game?.state === 'menu', null, { timeout: 120000 });
  assert.equal(await p.locator('#btn-fs').isVisible(), true);
  await tap(p, '#btn-fs');
  assert.match(await p.locator('#toast').textContent(), /недоступен.*Chrome/i);
  await tap(p, '#btn-play');
  await p.waitForFunction(() => __game.state === 'play' && __game.onFoot);
  assert.equal(await p.locator('#hud-fs').isVisible(), true);
  await tap(p, '#hud-fs');
  assert.match(await p.locator('#toast').textContent(), /недоступен.*Chrome/i);
  await p.setViewportSize({ width: 370, height: 820 });
  assert.equal(await p.locator('#rotate').isVisible(), true);
  await tap(p, '#rotate-fs');
  assert.match(await p.locator('#toast').textContent(), /недоступен.*Chrome/i);
  await p.setViewportSize({ width: 820, height: 370 });
  assert.equal(await p.locator('#rotate').isVisible(), false);
  assert.equal(await p.evaluate(() => __game.state), 'play');
  assert.deepEqual(errors, []);
  await unsupported.close();
  console.log('  ✓ без Fullscreen API: подсказка в меню, HUD и портрете; игра продолжает работать');

  const rejected = await browser.newContext(opts);
  await rejected.addInitScript(() => {
    window.__fsRejected = 0;
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
    Element.prototype.requestFullscreen = function () {
      window.__fsRejected++;
      return Promise.reject(new DOMException('Blocked by browser', 'NotAllowedError'));
    };
  });
  const q = await rejected.newPage();
  const rejectedErrors = [];
  q.on('pageerror', e => rejectedErrors.push(e.message));
  await q.goto('http://localhost:8080/?noaudio');
  await q.waitForFunction(() => document.getElementById('loading').classList.contains('tap-ready'), null, { timeout: 120000 });
  await q.touchscreen.tap(410, 200);
  await q.waitForFunction(() => __game.state === 'menu');
  await q.waitForFunction(() => /не разрешил/.test(document.querySelector('#toast').textContent));
  assert.equal(await q.locator('#btn-fs').isVisible(), true);
  await tap(q, '#btn-play');
  await q.waitForFunction(() => __game.state === 'play' && __game.onFoot);
  assert.equal(await q.locator('#hud-fs').isVisible(), true);
  const before = await q.evaluate(() => window.__fsRejected);
  await tap(q, '#hud-fs');
  assert.equal(await q.evaluate(() => window.__fsRejected), before + 1);
  assert.match(await q.locator('#toast').textContent(), /не разрешил/i);
  assert.deepEqual(rejectedErrors, []);
  await rejected.close();
  console.log('  ✓ отказ браузера: повторная попытка через HUD и внятное сообщение вместо зависания');

  // Некоторые оболочки устанавливают PWA в standalone, а не в fullscreen.
  // В этом случае пользователь всё ещё должен иметь возможность развернуть игру.
  const standalone = await browser.newContext(opts);
  await standalone.addInitScript(() => {
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = realMatchMedia(query);
      if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { configurable: true, value: true });
      if (query === '(display-mode: fullscreen)') Object.defineProperty(result, 'matches', { configurable: true, value: false });
      return result;
    };
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
    window.__standaloneCalls = [];
    Element.prototype.requestFullscreen = function () {
      window.__standaloneCalls.push(navigator.userActivation.isActive);
      return Promise.reject(new DOMException('Blocked by browser', 'NotAllowedError'));
    };
  });
  const s = await standalone.newPage();
  await s.goto('http://localhost:8080/?noaudio');
  await s.waitForFunction(() => window.__game?.state === 'menu', null, { timeout: 120000 });
  assert.equal(await s.locator('#btn-fs').isVisible(), true);
  await tap(s, '#btn-play');
  await s.waitForFunction(() => __game.state === 'play' && __game.onFoot);
  assert.deepEqual(await s.evaluate(() => window.__standaloneCalls), [true]);
  assert.equal(await s.locator('#hud-fs').isVisible(), true);
  await standalone.close();
  console.log('  ✓ standalone без полноэкранного режима: запрос при запуске и кнопка в игре доступны');
} finally {
  await browser.close();
}
