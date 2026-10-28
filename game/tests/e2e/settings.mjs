import { chromium } from 'playwright';
const OUT = new URL('../shots/', import.meta.url).pathname;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const tap = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await sleep(250); };
await tap('#btn-settings');
console.log('экран настроек виден:', await page.locator('#settings').isVisible());
await page.screenshot({ path: OUT + 'settings.png' });
const segs = await page.$$eval('[data-set]', els => els.map(e => ({ key: e.dataset.set, vals: [...e.querySelectorAll('button')].map(b => b.dataset.v) })));
let okAll = true;
for (const s of segs) {
  for (const v of s.vals) {
    await tap(`[data-set="${s.key}"] button[data-v="${v}"]`);
    const got = await page.evaluate((k) => window.__game.save.settings[k], s.key);
    const exp = v === 'true' ? true : v === 'false' ? false : v;
    const hl = await page.$eval(`[data-set="${s.key}"] button[data-v="${v}"]`, b => b.className);
    if (got !== exp) { okAll = false; console.log('  НЕСОВПАДЕНИЕ', s.key, v, '→', got); }
    if (!/on|active|sel/.test(hl)) { okAll = false; console.log('  кнопка не подсвечена', s.key, v, 'class=', hl); }
  }
}
console.log('все переключатели сохраняются и подсвечиваются:', okAll, '| ключи:', segs.map(s => s.key).join(','));
// итоговые значения для проверки эффектов
await tap('[data-set="showFps"] button[data-v="true"]');
await tap('[data-set="stickPedals"] button[data-v="true"]');
await tap('[data-set="quality"] button[data-v="auto"]');
const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('openstreet.save.v1') || '{}').settings);
console.log('в localStorage:', JSON.stringify(persisted));
await tap('#settings-back');
await tap('#btn-play');
await page.waitForFunction(() => __game.state === 'play' && __game.onFoot);
await tap('#vehicle-action');
await page.waitForFunction(() => !__game.onFoot);
await sleep(1500);
console.log('FPS-счётчик в заезде виден:', await page.locator('#fps').isVisible(), '| текст:', (await page.locator('#fps').textContent()).trim());
// педали на стике: тянем стик вверх
const cdp = await ctx.newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y: 270, id: 1 }] });
for (let k = 1; k <= 5; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: 270 - k * 11, id: 1 }] }); await sleep(30); }
await sleep(300);
const st = await page.evaluate(() => window.__game.input.state);
console.log('стик вверх при «педалях на стике»: throttle', st.throttle.toFixed(2), 'brake', st.brake.toFixed(2));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
// сброс прогресса: одиночный тап не должен сбрасывать
await page.evaluate(() => { window.__game.save.money = 1234; });
await tap('#btn-pause'); await tap('#pause-settings');
await tap('#btn-reset-save');
const m1 = await page.evaluate(() => window.__game.save.money);
const txt = (await page.locator('#btn-reset-save').textContent()).trim();
await tap('#btn-reset-save');
const m2 = await page.evaluate(() => ({ money: window.__game.save.money, cars: window.__game.save.ownedCars, settingsKept: window.__game.save.settings.showFps }));
console.log('сброс: после 1-го тапа деньги', m1, '(кнопка «' + txt + '») → после 2-го', JSON.stringify(m2));
await tap('#settings-back');
console.log('после «ГОТОВО» состояние:', await page.evaluate(() => window.__game.state));
// портрет
await page.setViewportSize({ width: 370, height: 820 }); await sleep(800);
console.log('портрет: оверлей «поверните»:', await page.locator('#rotate').isVisible(), '| состояние:', await page.evaluate(() => window.__game.state));
await page.screenshot({ path: OUT + 'portrait.png' });
await page.setViewportSize({ width: 820, height: 370 }); await sleep(800);
console.log('обратно в ландшафт: оверлей:', await page.locator('#rotate').isVisible(), '| canvas', await page.evaluate(() => { const R = window.__game.R; return R.renderW + 'x' + R.renderH; }));
console.log('ошибки:', errs.length ? errs.slice(0, 8) : 'нет');
await browser.close();
