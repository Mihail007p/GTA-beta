// ============================================================================
//  MAIN — склейка: загрузка, игровой цикл, состояния экранов, эффекты.
//
//  Цикл: физика машины фиксированным шагом 1/120 (стабильно на любом FPS),
//  трафик/геймплей/рендер — раз в кадр. Если кадр «провис» (>0.1 с), время
//  обрезается — машина не телепортируется после сворачивания вкладки.
// ============================================================================
import { CONFIG, MS_TO_KMH } from './config.js';
import { generateCity, buildSpatialHash, isOnRoad, nearestRoadAxis } from './city.js';
import { makeCarState, stepCar, damp, clamp, wrapAngle } from './car-physics.js';
import { CARS, carById } from './cars.js';
import { preloadCarModel } from './car-model.js';
import { colliderOf, collideWorld, collideTraffic } from './collision.js';
import { makeTraffic, scatterTraffic, stepTraffic } from './traffic.js';
import { makeGameplay, updateGameplay, nearestCheckpoint } from './gameplay.js';
import { loadSave, markDirty, maybeFlush, flushNow, addMoney, ownCar, resetSave } from './save.js';
import { Renderer } from './renderer.js';
import { audio } from './audio.js';
import { TouchInput } from './input.js';
import { FootInput } from './foot-input.js';
import { CHARACTERS } from './characters.js';
import { makePedestrian, stepPedestrian, findExitSpot, canEnterCar, carIsStopped, stopParkedCar, circleVsCar, HERO_RADIUS } from './pedestrian.js';
import { UI } from './ui.js';

const ui = new UI();
let save = loadSave();
let R = null, city, hash, traffic, input, footInput;
let car, def, col, g, hero;
let onFoot = false;
const previewHero = { x: 0, z: 0, y: 0, heading: 0.6, speed: 0, running: false };
let state = 'loading';
let garageReturn = 'menu';
let time = 0;
let shake = 0;
let acc = 0;
let lastNow = 0;
const visual = { roll: 0, pitch: 0, braking: false };
const fx = {
  prevSkid: [null, null], stuckT: 0, impactCd: 0, hapticCd: 0, lastDist: 0,
  wasReset: false, smokeAcc: 0,
};
const PH = CONFIG.physics;

const SHOT = /[?&]shot\b/.test(location.search);   // режим автотестов
const NOAUDIO = /[?&]noaudio/.test(location.search);   // автотесты: в headless эмуляция звука отнимает CPU у рендера
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

// ------------------------------------------------------------- ЗАГРУЗКА --
async function boot() {
  ui.setLoading(0.05, 'Запуск 3D…');
  await nextFrame();
  try {
    R = new Renderer(document.getElementById('scene'), {
      quality: SHOT ? 'high' : save.settings.quality,
      preserveDrawingBuffer: /[?&]shot\b/.test(location.search),   // для автотестов скриншотами
    });
  } catch (e) {
    ui.fatal('Браузер не дал доступ к WebGL (3D-графике). Откройте игру в Chrome, обновите его, ' +
      'или включите аппаратное ускорение. Подробности: ' + (e && e.message ? e.message : e));
    return;
  }
  resize();

  ui.setLoading(0.2, 'Строим город…');
  await nextFrame();
  city = generateCity(CONFIG.city);
  hash = buildSpatialHash(city.colliders, 30);
  R.camHash = hash;

  ui.setLoading(0.4, 'Дома и улицы…');
  await nextFrame();
  R.buildCity(city);
  ui.buildMinimap(city);

  ui.setLoading(0.6, 'Трафик…');
  await nextFrame();
  traffic = makeTraffic(city, CONFIG.traffic.count, 4242);
  await Promise.race([R.loadTrafficModels(), new Promise(r => setTimeout(r, 8000))]);
  R.buildTraffic(CONFIG.traffic.count);

  ui.setLoading(0.72, 'Машина…');
  await nextFrame();
  // реалистичная модель активной машины (≈0.8 МБ); не дольше 12 с — иначе поедем на заглушке
  await Promise.race([preloadCarModel(carById(save.activeCar)), new Promise(r => setTimeout(r, 12000))]);
  setActiveCar(save.activeCar, true);
  newRun();
  ui.setLoading(0.80, 'Готовим персонажа…');
  await Promise.race([R.setHero(save.selectedCharacter), new Promise(r => setTimeout(r, 12000))]);

  ui.setLoading(0.86, 'Подготовка шейдеров…');
  await nextFrame();
  R.orbit = { a: 2.2, r: 7.2, h: 2.1, speed: 0.12 };
  R.updateTraffic(traffic.cars);
  R.updatePlayer(car, 1 / 60, visual);
  R.updateCamera(car, 1 / 60, 0);
  R.updateCheckpoints(g.checkpoints, 0);
  R.warmup();
  R.render();

  input = new TouchInput(document.getElementById('controls-root'), save.settings);
  footInput = new FootInput(document.getElementById('controls-root'));
  bindUi();
  ui.syncSettings(save);
  ui.setLoading(1, 'Готово');
  await nextFrame();
  window.__game = { get input() { return input; }, get footInput() { return footInput; }, get save() { return save; }, get traffic() { return traffic; }, get car() { return car; }, get hero() { return hero; }, get onFoot() { return onFoot; }, get g() { return g; }, get R() { return R; }, get state() { return state; }, setState: (s) => { state = s; } };
  await waitStartTap();
  goMenu();
  lastNow = performance.now();
  requestAnimationFrame(loop);
}

// --------------------------------------------------------- ЗАЕЗД / МАШИНА --
function newRun() {
  const s = city.start;
  const stats = car ? car.stats : undefined;
  car = makeCarState(def, s.x, s.z, s.heading);
  if (stats) car.stats = stats;
  hero = makePedestrian(s.x, s.z, s.heading);
  onFoot = false;
  ui.setOnFoot(false);
  if (R) R.showHero(false);
  if (input) input.setActive(true);
  if (footInput) footInput.setActive(false);
  g = makeGameplay(CONFIG.gameplay, city, (Date.now() & 0xffff) + 1, s);
  scatterTraffic(traffic, city, car, CONFIG.traffic);
  fx.lastDist = car.stats.distance;
  fx.prevSkid = [null, null];
  if (R) { R._camInit = false; R._camClip = 99; }
}

function setActiveCar(id, initial = false) {
  def = carById(id) || CARS[0];
  col = colliderOf(def);
  R.setPlayerCar(def);
  if (!initial && car) {
    // та же точка и курс, скорость обнуляем
    const stats = car.stats;
    car = makeCarState(def, car.x, car.z, car.heading);
    car.stats = stats;
    if (onFoot && hero && circleVsCar(hero.x, hero.z, HERO_RADIUS, car, def.length || 4.4, def.width || 1.9)) {
      const spot = findExitSpot(car, def, hash, traffic);
      if (spot) { hero.x = spot.x; hero.z = spot.z; hero.vx = hero.vz = 0; }
    }
  }
}

/** Вернуть машину на ближайшую полосу (правую по ходу движения) */
function respawn() {
  if (onFoot) {
    const spot = findExitSpot(car, def, hash, traffic);
    if (!spot) { ui.toast('Рядом с машиной нет свободного места'); return; }
    hero.x = spot.x; hero.z = spot.z; hero.vx = hero.vz = hero.speed = 0;
    hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
    R._camInit = false; ui.hint('');
    return;
  }
  const na = nearestRoadAxis(city, car.x, car.z);
  const L = city.lane;
  const lo = city.roadAt(0) + 6, hi = city.roadAt(city.grid) - 6;
  let x, z, h;
  if (na.axis === 'z') {
    const dir = Math.sin(car.heading) >= 0 ? 1 : -1;
    x = na.c - dir * L; z = clamp(car.z, lo, hi); h = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const dir = Math.cos(car.heading) >= 0 ? 1 : -1;
    z = na.c + dir * L; x = clamp(car.x, lo, hi); h = dir > 0 ? 0 : Math.PI;
  }
  for (let tries = 0; tries < 8; tries++) {
    const busy = traffic.cars.some(c => c.alive && Math.hypot(c.x - x, c.z - z) < 8);
    if (!busy) break;
    x -= Math.cos(h) * 9; z -= Math.sin(h) * 9;
  }
  const stats = car.stats;
  car = makeCarState(def, x, z, h);
  car.stats = stats;
  fx.prevSkid = [null, null];
  fx.stuckT = 0;
  R._camInit = false;
  ui.hint('');
}

// ---------------------------------------------------------------- ЭКРАНЫ --
function goMenu() {
  state = 'menu';
  R.orbit = { a: R.orbit ? R.orbit.a : 2.2, r: 7.2, h: 2.1, speed: 0.12 };
  R.showHero(false);
  if (R.playerMesh) R.playerMesh.visible = true;
  // Также отменяет незавершённую загрузку другого предпросматриваемого героя.
  R.setHero(save.selectedCharacter);
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  ui.syncMenu(save);
  ui.show('menu');
  audio.resume();
}

function goGarage() {
  garageReturn = state === 'pause' ? 'pause' : 'menu';
  state = 'garage';
  R.orbit = { a: R.orbit ? R.orbit.a : 0.6, r: 6.3, h: 1.5, speed: 0.22, frameLeft: true, lookY: 0.62 };
  R.showHero(false);
  if (R.playerMesh) R.playerMesh.visible = true;
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  ui.openGarage(save);
  audio.resume();
}

function goCharacter() {
  state = 'character';
  R.orbit = { a: 0.6, r: 3.6, h: 1.25, speed: 0.20, frameLeft: true, lookY: 0.95, hero: true };
  if (R.playerMesh) R.playerMesh.visible = false;
  R.showHero(false);
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  ui.openCharacter(save);
  audio.resume();
}

function previewCharacter(id) {
  ui.characterStatus('Загружаем модель…');
  R.showHero(false);
  R.setHero(id).then(ok => {
    if (state !== 'character' || CHARACTERS[ui.characterIdx].id !== id) return;
    ui.characterStatus(ok ? '' : 'Модель не загрузилась. Проверьте соединение и повторите.');
    R.showHero(ok);
  });
}

function leaveGarage() {
  if (R.playerDef !== def) R.setPlayerCar(def);    // вернуть активную машину после просмотра
  if (garageReturn === 'pause') goPause(); else goMenu();
}

function goPlay() {
  state = 'play';
  R.orbit = null;
  R._camInit = false;
  if (R.playerMesh) R.playerMesh.visible = true;
  input.setActive(!onFoot);
  footInput.setActive(onFoot);
  ui.setOnFoot(onFoot);
  R.showHero(onFoot && R.heroId === save.selectedCharacter);
  if (onFoot && R.heroId !== save.selectedCharacter) {
    ui.toast('Загружаем героя…');
    R.setHero(save.selectedCharacter).then(ok => {
      if (ok && onFoot && state === 'play') R.showHero(true);
      else if (!ok && onFoot && state === 'play') ui.toast('Не удалось загрузить героя');
    });
  }
  ui.show('play');
  audio.resume();
  lastNow = performance.now();
  acc = 0;
}

function goPause() {
  if (state === 'loading') return;
  state = 'pause';
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  ui.show('pause');
  audio.suspend();
  flushNow();
}

// В этом этапе доступна только собственная машина. Действие на клавиатуре — E.
function toggleVehicle() {
  if (state !== 'play') return;
  if (onFoot) {
    if (!canEnterCar(hero, car, def)) { ui.toast('Подойдите к своей машине'); return; }
    onFoot = false;
    stopParkedCar(car);
    hero.vx = hero.vz = hero.speed = 0;
    R.showHero(false);
    input.setActive(true); footInput.setActive(false);
    ui.setOnFoot(false); ui.hint('');
    R.driveLookYaw = 0; R.driveLookHeight = 0;
    R._camInit = false; acc = 0;
    ui.toast('Вы в своей машине');
    return;
  }
  if (!carIsStopped(car)) { ui.toast('Сначала остановите машину'); return; }
  if (!R.heroActor || R.heroId !== save.selectedCharacter) {
    ui.toast('Загружаем героя. Попробуйте ещё раз');
    R.setHero(save.selectedCharacter).then(ok => { if (!ok && state === 'play') ui.toast('Не удалось загрузить героя'); });
    return;
  }
  const spot = findExitSpot(car, def, hash, traffic);
  if (!spot) { ui.toast('Нет места для выхода — отъедьте от препятствия'); return; }
  stopParkedCar(car);
  hero = makePedestrian(spot.x, spot.z, spot.heading);
  hero.camYaw = R.camYaw;
  hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
  onFoot = true;
  R.updateHero(hero, 0); R.showHero(true); R._camInit = false;
  input.setActive(false); footInput.setActive(true);
  ui.setOnFoot(true); ui.hint('');
  fx.prevSkid = [null, null]; fx.stuckT = 0; acc = 0;
  ui.toast('Стик — движение · свайп справа — камера');
}
window.addEventListener('keydown', e => {
  if (e.code === 'KeyE' && !e.repeat && state === 'play') { e.preventDefault(); toggleVehicle(); }
});

// ----------------------------------------------------------- ПОЛНЫЙ ЭКРАН --
// Браузер даёт полный экран только по жесту (для касаний — click/pointerup, не pointerdown).
// Поэтому: экран «Нажмите, чтобы начать», повторный вход по ЕХАТЬ/ПРОДОЛЖИТЬ,
// кнопка в углу меню и пауза, если полный экран сбросили (жест «назад»).
// Ярлык на главном экране (PWA, display: fullscreen) открывается сразу без панелей.
const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const STANDALONE = matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches;
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
let wasFullscreen = false;

function enterFullscreen() {
  if (SHOT || STANDALONE || !FS_OK) return;   // в автотестах headless-fullscreen тормозит кадры
  if (!isFullscreen()) {
    const el = document.documentElement;
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' })
        : el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null;
      if (p && p.then) p.then(lockLandscape, () => { /* не дали — играем так */ });
    } catch (e) { /* не дали — играем так */ }
  } else lockLandscape();
}

function lockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) { /* не везде поддерживается */ }
}

function syncFsButton() {
  const btn = document.getElementById('btn-fs');
  if (!btn) return;
  const scr = ui && ui.screen;
  const show = FS_OK && !STANDALONE && !SHOT && !isFullscreen() && (scr === 'menu' || scr === 'pause');
  btn.classList.toggle('hidden', !show);
}

function onFullscreenChange() {
  const fs = isFullscreen();
  if (wasFullscreen && !fs && state === 'play') goPause();   // случайный «назад» — пауза, а не езда в окне
  wasFullscreen = fs;
  syncFsButton();
  setTimeout(resize, 120);
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

/** После загрузки: ждём первое касание → полный экран + звук. */
function waitStartTap() {
  if (SHOT || STANDALONE || !FS_OK) return Promise.resolve();
  return new Promise((resolve) => {
    const scr = document.getElementById('loading');
    scr.classList.add('tap-ready');
    const go = (e) => {
      e.preventDefault();
      scr.removeEventListener('click', go);
      enterFullscreen();       // строго синхронно внутри жеста
      ensureAudio();
      scr.classList.remove('tap-ready');
      resolve();
    };
    scr.addEventListener('click', go);
  });
}

function ensureAudio() {
  if (NOAUDIO) return;
  if (!audio.ready) {
    audio.init();
    audio.setEnabled(!!save.settings.sound);
  } else {
    audio.resume();
  }
}

function bindUi() {
  ui.onShow = () => syncFsButton();
  ui.h = {
    click: () => { ensureAudio(); audio.ui(); },
    getSave: () => save,
    play: () => { enterFullscreen(); goPlay(); },
    fullscreen: () => enterFullscreen(),
    garage: () => goGarage(),
    character: () => goCharacter(),
    characterBack: () => goMenu(),
    previewCharacter: (id) => previewCharacter(id),
    selectCharacter: (id) => {
      if (R.heroId !== id || !R.heroActor) { ui.toast('Подождите загрузку модели'); return; }
      save.selectedCharacter = id; markDirty(); flushNow();
      ui.toast('Герой выбран');
    },
    vehicle: () => toggleVehicle(),
    garageBack: () => leaveGarage(),
    resume: () => { enterFullscreen(); goPlay(); },
    pause: () => goPause(),
    menu: () => goMenu(),
    respawn: () => respawn(),
    previewCar: (id) => R.setPlayerCar(carById(id)),
    selectCar: (id) => {
      save.activeCar = id; markDirty(); flushNow();
      setActiveCar(id);
      ui.toast('Выбрана: ' + def.name);
    },
    buyCar: (id) => {
      const d = carById(id);
      if (!d || save.money < d.unlockCost) return;
      addMoney(-d.unlockCost);
      ownCar(id);
      save.activeCar = id; markDirty(); flushNow();
      setActiveCar(id);
      audio.unlock();
      ui.toast('Куплена: ' + d.name + '!');
    },
    setting: (key, v) => {
      save.settings[key] = v; markDirty(); flushNow();
      if (key === 'sound') { ensureAudio(); audio.setEnabled(!!v); }
      if (key === 'quality') R.setQuality(v);
      if (key === 'steerSens' || key === 'stickPedals' || key === 'steerMode') input.setOptions(save.settings);
    },
    resetProgress: () => {
      save = resetSave();
      setActiveCar(save.activeCar);
      newRun();
      R.setQuality(save.settings.quality);
      input.setOptions(save.settings);
      audio.setEnabled(!!save.settings.sound);
      ui.syncSettings(save);
      ui.syncMenu(save);
      R.setHero(save.selectedCharacter);
    },
  };
  input.onFirstTouch = () => ensureAudio();
  footInput.onFirstTouch = () => ensureAudio();
}

// ------------------------------------------------------------------ ЦИКЛ --
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  if (!(dt > 0)) return;
  if (dt > 0.1) dt = 0.1;
  if (state === 'pause' || state === 'loading') return;   // статичный кадр — не тратим батарею
  frame(dt, now);
}

function frame(dt, now) {
  time += dt;
  const playing = state === 'play', driving = playing && !onFoot;
  let frameImpact = 0, impVx = 0, impVz = 0;
  let inp = null;

  if (driving) {
    inp = input.sample();
    R.moveCarCamera(inp.lookX, inp.lookY);
    if (inp.reset && !fx.wasReset) respawn();
    fx.wasReset = inp.reset;
    acc += dt;
    let steps = 0;
    while (acc >= PH.dt && steps < PH.maxStepsPerFrame) {
      const vx0 = car.vx, vz0 = car.vz;
      stepCar(car, def, inp, PH.dt, { onRoad: isOnRoad(city, car.x, car.z) });
      const w = collideWorld(car, col, hash, PH);
      const t = collideTraffic(car, col, traffic, PH);
      const imp = Math.max(w.impact, t);
      if (imp > frameImpact) { frameImpact = imp; impVx = car.vx - vx0; impVz = car.vz - vz0; }
      acc -= PH.dt;
      steps++;
    }
    if (steps >= PH.maxStepsPerFrame) acc = 0;
    if (!isFinite(car.x) || !isFinite(car.z) || !isFinite(car.vx)) respawn();
  } else if (playing && onFoot) {
    inp = footInput.sample();
    if (inp.reset && !fx.wasReset) respawn();
    fx.wasReset = inp.reset;
    hero.camYaw = wrapAngle(hero.camYaw - inp.lookX * 0.006);
    hero.camPitch = clamp(hero.camPitch + inp.lookY * 0.004, -0.12, 0.72);
    stepPedestrian(hero, inp, dt, city, hash, car, def, traffic);
  }

  // Пешком центр трафика следует за героем; на дороге учитываем и его, и припаркованную машину.
  stepTraffic(traffic, city, Math.min(dt, 0.05), CONFIG.traffic, onFoot && playing ? hero : car, onFoot && playing ? car : null);

  if (driving) {
    const res = updateGameplay(g, dt, car, traffic.cars, frameImpact);
    onGameplay(res, dt);
    onImpact(frameImpact, impVx, impVz, dt);
    trackStats(dt);
    effects(dt, inp);
    stuckCheck(dt, inp);
    audio.update({ speed: car.speed, throttle: inp.throttle, drifting: car.drifting, lateral: car.lateral, topSpeed: def.topSpeed }, dt);
  } else {
    // Чекпоинты и их таймер не тикают, пока игрок гуляет пешком.
    audio.update({ speed: 0, throttle: 0, drifting: false, lateral: 0, topSpeed: def.topSpeed }, dt);
  }

  const rollT = driving ? clamp(-car.accelLat * 0.0042, -0.075, 0.075) : 0;
  const pitchT = driving ? clamp(car.accelLong * 0.0038, -0.05, 0.045) : 0;
  visual.roll = damp(visual.roll, rollT, 7, dt);
  visual.pitch = damp(visual.pitch, pitchT, 7, dt);
  visual.braking = driving && ((inp.brake > 0.1 && car.speed > 0.5) || inp.handbrake);

  shake = damp(shake, 0, CONFIG.camera.shakeDecay, dt);
  R.updatePlayer(car, dt, visual);
  if (state === 'character') {
    previewHero.x = car.x; previewHero.z = car.z; previewHero.y = car.onRoad === false ? 0.16 : 0;
    R.updateHero(previewHero, dt, true);
  } else if (onFoot && playing) R.updateHero(hero, dt);
  if (playing && onFoot) R.updateFootCamera(hero, dt);
  else R.updateCamera(car, dt, shake);
  R.updateTraffic(traffic.cars);
  R.updateCheckpoints(g.checkpoints, time);
  R.updateParticles(dt);
  R.adaptPerformance(dt);
  R.render();

  if (playing) {
    const st = save.settings;
    const player = onFoot ? hero : car;
    ui.updateHud({
      car: player, def, g, dt, onFoot,
      money: save.money,
      nearest: nearestCheckpoint(g, player.x, player.z),
      camYaw: R.camYaw,
      fpsText: st.showFps ? `${Math.round(R.fps)} FPS · ${R.renderW}×${R.renderH} · ${R.drawCalls} dc` : '',
    });
  }
  maybeFlush(now);
}

// ------------------------------------------------------------- СОБЫТИЯ --
function onGameplay(res, dt) {
  if (res.money > 0) {
    const before = save.money;
    addMoney(res.money);
    checkAffordable(before);
  }
  if (res.collected.length) {
    audio.checkpoint(g.combo);
    vibrate(25);
  }
  if (res.nearMiss) audio.blip(1180, 0.07, 'triangle', 0.10);
  if (res.driftBanked) audio.money();
  if (res.chainEnded) audio.blip(196, 0.28, 'sawtooth', 0.08);
  if (g.score > save.bestScore) { save.bestScore = Math.round(g.score); markDirty(); }
}

function checkAffordable(before) {
  for (const d of CARS) {
    if (save.ownedCars.includes(d.id) || save.notifiedCars.includes(d.id)) continue;
    if (before < d.unlockCost && save.money >= d.unlockCost) {
      save.notifiedCars.push(d.id);
      markDirty();
      ui.toast('Можно купить ' + d.name + '! Загляни в гараж (пауза → гараж)');
      audio.unlock();
    }
  }
}

function onImpact(imp, ivx, ivz, dt) {
  fx.impactCd -= dt;
  fx.hapticCd -= dt;
  if (imp <= 2) return;
  car.stats.collisions++;
  shake = Math.max(shake, Math.min(0.9, imp * CONFIG.camera.shakeOnImpact * 0.08));
  ui.flashHit(Math.min(0.7, (imp - 2) / 14));
  if (fx.impactCd <= 0) { audio.impact(imp); fx.impactCd = 0.15; }
  if (fx.hapticCd <= 0) { vibrate(Math.round(15 + Math.min(25, imp * 1.6))); fx.hapticCd = 0.18; }
  // искры: из точки контакта по нормали удара (≈ направление изменения скорости)
  const L = Math.hypot(ivx, ivz) || 1;
  const nx = ivx / L, nz = ivz / L;
  const px = car.x - nx * 1.0, pz = car.z - nz * 1.0;
  const n = Math.min(22, Math.round(4 + imp * 1.3));
  for (let i = 0; i < n; i++) {
    const sp = 3 + Math.random() * (4 + imp * 0.4);
    R.emitSpark(px, 0.5 + Math.random() * 0.5, pz,
      nx * sp + (Math.random() - 0.5) * 6 + car.vx * 0.3, 1.5 + Math.random() * 4, nz * sp + (Math.random() - 0.5) * 6 + car.vz * 0.3);
  }
}

function vibrate(ms) {
  if (!save.settings.haptics || !navigator.vibrate) return;
  try { navigator.vibrate(ms); } catch (e) { /* ignore */ }
}

function trackStats(dt) {
  const d = car.stats.distance - fx.lastDist;
  fx.lastDist = car.stats.distance;
  if (d > 0 && d < 50) { save.totalDistance += d; markDirty(); }
  if (car.drifting) save.totalDrift += dt;
  const kmh = Math.abs(car.speed) * MS_TO_KMH;
  if (kmh > save.bestSpeed + 0.5) { save.bestSpeed = Math.round(kmh); markDirty(); }
}

/** Следы шин и дым от задних колёс */
function effects(dt, inp) {
  const absV = Math.hypot(car.vx, car.vz);
  const skidding = absV > 4 && (car.drifting || (inp.handbrake && absV > 5) ||
    (inp.brake > 0.6 && car.speed > 14) || Math.abs(car.lateral) > 3.2);
  const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
  const rearF = -(def.wheelbase || 2.7) * 0.5, half = 0.78;
  for (let k = 0; k < 2; k++) {
    const r = k === 0 ? half : -half;
    const x = car.x + ch * rearF - sh * r;
    const z = car.z + sh * rearF + ch * r;
    if (skidding) {
      const p = fx.prevSkid[k];
      if (p) R.addSkid(p.x, p.z, x, z, car.onRoad === false ? 0.18 : 0.02);
      fx.prevSkid[k] = { x, z };
    } else {
      fx.prevSkid[k] = null;
    }
  }
  // дым: интенсивность от скольжения
  if (skidding && absV > 7) {
    const slip = Math.min(1, Math.abs(car.lateral) / 9 + (inp.handbrake ? 0.3 : 0));
    fx.smokeAcc += dt * (8 + 28 * slip);
    while (fx.smokeAcc >= 1) {
      fx.smokeAcc -= 1;
      const r = Math.random() < 0.5 ? half : -half;
      const x = car.x + ch * rearF - sh * r, z = car.z + sh * rearF + ch * r;
      R.emitSmoke(x - ch * 0.6, 0.35, z - sh * 0.6, car.vx * 0.15 + (Math.random() - 0.5) * 1.5, 0.6 + Math.random() * 0.8, car.vz * 0.15 + (Math.random() - 0.5) * 1.5);
    }
  } else fx.smokeAcc = 0;
}

function stuckCheck(dt, inp) {
  if (Math.abs(car.speed) < 1.0 && (inp.throttle > 0.5 || inp.brake > 0.5)) fx.stuckT += dt;
  else fx.stuckT = Math.max(0, fx.stuckT - dt * 2);
  ui.hint(fx.stuckT > 3 ? 'Застрял? Нажми ⟲ — вернём на дорогу' : '');
}

// -------------------------------------------------------------- СИСТЕМА --
function resize() {
  if (!R) return;
  const w = window.innerWidth, h = window.innerHeight;
  R.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state === 'play') goPause();
    flushNow();
    audio.suspend();
  }
});
window.addEventListener('pagehide', () => flushNow());
// долгое нажатие / двойной тап не должны открывать меню браузера и зумить
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// офлайн-режим: кэш всех файлов (работает на https и localhost)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot().catch((e) => {
  console.error(e);
  ui.fatal('Ошибка запуска: ' + (e && e.message ? e.message : e));
});
