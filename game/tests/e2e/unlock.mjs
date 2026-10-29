// Уведомление «Доступна новая машина» при накоплении суммы + однократность (notifiedCars)
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await page.locator('#btn-play').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
await page.waitForFunction(() => __game.state === 'play' && __game.onFoot);
await page.keyboard.press('KeyE');
await page.waitForFunction(() => !__game.onFoot);
await sleep(600);
const toastTxt = () => page.evaluate(() => { const t = document.getElementById('toast'); return t && !t.classList.contains('hidden') && getComputedStyle(t).display !== 'none' ? t.textContent.trim() : ''; });
const grabCp = () => page.evaluate(() => { const G = window.__game, cp = G.g.checkpoints[0]; G.car.x = cp.x; G.car.z = cp.z; G.car.vx = 0; G.car.vz = 0; });
await page.evaluate(() => { window.__game.save.money = 5990; });
await grabCp();
let seen = '';
for (let i = 0; i < 20 && !seen; i++) { await sleep(150); seen = await toastTxt(); }
console.log('тост после чекпоинта ($5990 → $6050):', seen || '(нет)');
const notified = await page.evaluate(() => window.__game.save.notifiedCars);
console.log('notifiedCars:', JSON.stringify(notified));
await sleep(3500);
await page.evaluate(() => { window.__game.save.money = 5990; });
await grabCp();
let again = '';
for (let i = 0; i < 10 && !again; i++) { await sleep(150); again = await toastTxt(); }
console.log('повторный тост для той же машины:', again || '(нет — верно)');
console.log('ошибки:', errs.length ? errs : 'нет');
await browser.close();
