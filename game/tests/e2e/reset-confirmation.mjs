// Защита прогресса: первое нажатие только спрашивает подтверждение,
// даже сразу после запуска; повторное работает лишь в пределах 3,5 секунд.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  const ctx = await browser.newContext({
    viewport: { width: 820, height: 370 }, hasTouch: true, isMobile: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('http://localhost:8080/?shot&noaudio');
  await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 90000 });
  await page.evaluate(() => window.__game.R.setQuality('low'));
  await page.locator('#btn-settings').click();

  // Подменяем только часы подтверждения внутри синхронного блока, не дожидаясь
  // физического устройства, которое успеет загрузить игру за несколько секунд.
  const result = await page.evaluate(() => {
    const key = 'openstreet.save.v1';
    const button = document.getElementById('btn-reset-save');
    const realNow = performance.now;
    let now = 0;
    const seed = (money) => {
      const save = window.__game.save;
      save.money = money;
      save.bestScore = 4321;
      save.ownedCars = ['strada', 'vektor'];
      save.settings.showFps = true;
      localStorage.setItem(key, JSON.stringify(save));
    };
    const snapshot = () => {
      const save = window.__game.save;
      const stored = JSON.parse(localStorage.getItem(key));
      return {
        money: save.money,
        score: save.bestScore,
        cars: [...save.ownedCars],
        settingsKept: save.settings.showFps,
        storedMoney: stored.money,
        label: button.textContent,
      };
    };
    try {
      performance.now = () => now;
      seed(1234);
      now = 1000;
      button.click();
      const firstEarly = snapshot();
      now = 2000;
      button.click();
      const confirmedEarly = snapshot();

      // Значение 0 само по себе тоже может быть валидным временем нажатия.
      seed(2222);
      now = 0;
      button.click();
      const firstAtZero = snapshot();
      now = 500;
      button.click();
      const confirmedAtZero = snapshot();

      seed(3333);
      now = 10000;
      button.click();
      now = 13501;
      button.click();
      const expired = snapshot();
      now = 13600;
      button.click();
      const confirmedAfterExpiry = snapshot();
      return { firstEarly, confirmedEarly, firstAtZero, confirmedAtZero, expired, confirmedAfterExpiry };
    } finally {
      performance.now = realNow;
    }
  });

  const assertArmed = (state, money) => {
    assert.equal(state.money, money, 'первое нажатие не должно изменять деньги');
    assert.equal(state.storedMoney, money, 'первое нажатие не должно изменять сохранение');
    assert.equal(state.score, 4321, 'первое нажатие не должно изменять рекорд');
    assert.deepEqual(state.cars, ['strada', 'vektor'], 'первое нажатие не должно удалять машины');
    assert.equal(state.label, 'Точно? Ещё раз');
  };
  const assertReset = (state) => {
    assert.equal(state.money, 0);
    assert.equal(state.storedMoney, 0);
    assert.equal(state.score, 0);
    assert.deepEqual(state.cars, ['strada']);
    assert.equal(state.settingsKept, true, 'сброс прогресса должен сохранить настройки');
    assert.equal(state.label, 'Сбросить');
  };

  assertArmed(result.firstEarly, 1234);
  assertReset(result.confirmedEarly);
  assertArmed(result.firstAtZero, 2222);
  assertReset(result.confirmedAtZero);
  assertArmed(result.expired, 3333);
  assertReset(result.confirmedAfterExpiry);

  // Проверяем также реальные касания и реальный таймер, а не только подменённые часы.
  await page.evaluate(() => {
    const save = window.__game.save;
    save.money = 4444;
    localStorage.setItem('openstreet.save.v1', JSON.stringify(save));
  });
  const tapReset = async () => {
    const box = await page.locator('#btn-reset-save').boundingBox();
    assert.ok(box, 'кнопка сброса должна быть видна');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  };
  const uiState = () => page.evaluate(() => ({
    money: window.__game.save.money,
    storedMoney: JSON.parse(localStorage.getItem('openstreet.save.v1')).money,
    label: document.getElementById('btn-reset-save').textContent,
  }));
  await tapReset();
  assert.deepEqual(await uiState(), { money: 4444, storedMoney: 4444, label: 'Точно? Ещё раз' });
  await page.waitForFunction(() => document.getElementById('btn-reset-save').textContent === 'Сбросить', null, { timeout: 12000 });
  assert.deepEqual(await uiState(), { money: 4444, storedMoney: 4444, label: 'Сбросить' });
  await tapReset();
  assert.deepEqual(await uiState(), { money: 4444, storedMoney: 4444, label: 'Точно? Ещё раз' });
  await tapReset();
  assert.deepEqual(await uiState(), { money: 0, storedMoney: 0, label: 'Сбросить' });

  assert.deepEqual(errors, [], 'в браузере не должно быть ошибок JavaScript');
  console.log('Сброс прогресса: раннее нажатие, касания, подтверждение и истечение срока проверены.');
} finally {
  await browser.close();
}
