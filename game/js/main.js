// ============================================================================
//  MAIN — склейка: загрузка, игровой цикл, состояния экранов, эффекты.
//
//  Цикл: физика машины фиксированным шагом 1/120 (стабильно на любом FPS),
//  трафик/геймплей/рендер — раз в кадр. Если кадр «провис» (>0.1 с), время
//  обрезается — машина не телепортируется после сворачивания вкладки.
// ============================================================================
import { CONFIG, MS_TO_KMH } from './config.js';
import { generateCity, buildSpatialHash, isOnRoad, nearestRoadAxis } from './city.js';
import { makeCarState, stepCar, damp, clamp } from './car-physics.js';
import { turnLook } from './look-controls.js';
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
import { makePedestrian, stepPedestrian, findExitSpot, carIsStopped, stopParkedCar, circleVsCar, carEntryDistance, HERO_RADIUS } from './pedestrian.js';
import { VehicleWorld } from './vehicles.js';
import { makeEntrances, nearestEntrance, makeInteriorLayout, makeInteriorHash, nearInteriorExit, findReturnSpot } from './interiors.js';
import { makeHomeState, nearestHomeInteraction, homeActionMode, toggleHomeItem, startHomePose, requestStand, stepHomePose } from './home-interactions.js';
import { UI } from './ui.js';
import { buyItem, buyOutfit, useItem, cookRecipe, stepNeeds, damage, acceptJob, completeJob, boardTaxi, completeTaxi, jobPoint, taxiDestination, TAXI_FARES } from './life.js';
import { localHour, clockText, daylight } from './day-night.js';
import { makeCrowd, stepCrowd, nearestCitizen } from './crowd.js';
import { collideCrowd } from './crowd-collisions.js';
import { syncTaxiPassenger, releaseTaxiPassenger, cancelTaxiPassenger } from './work-crowd.js';

const ui = new UI();
let save = loadSave();
let R = null, city, hash, traffic, input, footInput;
let car, def, col, g, hero, vehicles;
let onFoot = true;
let pendingEntry = null, driverEvent = null;
let entrances = [], entranceById = new Map(), interior = null, roomTransition = null;
let crowd = null, lifeChanging = false, worldMinute = null, worldClock = '';
let footHitCd = 0;
let doorsTipShown = false;
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
  wasReset: false, smokeAcc: 0, healthCd: 0,
};
const PH = CONFIG.physics;

const SHOT = /[?&]shot\b/.test(location.search);   // режим автотестов
const NOAUDIO = /[?&]noaudio/.test(location.search);   // автотесты: в headless эмуляция звука отнимает CPU у рендера
// Android-оболочка уже полноэкранная и содержит все файлы: отдельный SW ей не нужен.
const ANDROID_APP = /[?&]androidApp=1(?:&|$)/.test(location.search);
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
    ui.fatal((ANDROID_APP
      ? 'Не удалось запустить 3D. Обновите Android System WebView и перезапустите игру. '
      : 'Браузер не дал доступ к WebGL (3D-графике). Откройте игру в Chrome, обновите его или включите аппаратное ускорение. ') +
      'Подробности: ' + (e && e.message ? e.message : e));
    return;
  }
  resize();

  ui.setLoading(0.2, 'Строим город…');
  await nextFrame();
  city = generateCity(CONFIG.city);
  hash = buildSpatialHash(city.colliders, 30);
  R.camHash = R.outdoorHash = hash;
  entrances = makeEntrances(city, hash);
  entranceById = new Map(entrances.map(d => [d.id, d]));

  ui.setLoading(0.4, 'Дома и улицы…');
  await nextFrame();
  R.buildCity(city);
  R.buildEntrances(city, entrances);
  R.setWorldTime(localHour());
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
  await Promise.race([R.setHero(save.selectedCharacter, save.life.outfit), new Promise(r => setTimeout(r, 12000))]);
  // Жители загружаются отдельно: медленный накопитель не блокирует старт игры.
  R.loadCitizens();

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
  window.__game = { get input() { return input; }, get footInput() { return footInput; }, get save() { return save; }, get traffic() { return traffic; }, get car() { return car; }, get vehicles() { return vehicles; }, get hero() { return hero; }, get onFoot() { return onFoot; }, get pendingEntry() { return pendingEntry; }, get entrances() { return entrances; }, get interior() { return interior; }, get roomTransition() { return roomTransition; }, get city() { return city; }, get g() { return g; }, get crowd() { return crowd; }, get R() { return R; }, get state() { return state; }, setState: (s) => { state = s; } };
  await waitStartTap();
  goMenu();
  lastNow = performance.now();
  requestAnimationFrame(loop);
}

// --------------------------------------------------------- ЗАЕЗД / МАШИНА --
function newRun() {
  const s = city.start;
  const stats = car ? car.stats : undefined;
  cancelRoomTransition();
  interior = null;
  ui.setInside(null);
  if (R) R.closeInterior();
  if (vehicles) vehicles.dispose();
  if (R) R.clearDriver();
  pendingEntry = driverEvent = null;
  def = carById(save.activeCar) || CARS[0];
  col = colliderOf(def);
  car = makeCarState(def, s.x, s.z, s.heading);
  if (stats) car.stats = stats;
  vehicles = new VehicleWorld(traffic, car, def);
  g = makeGameplay(CONFIG.gameplay, city, (Date.now() & 0xffff) + 1, s);
  scatterTraffic(traffic, city, car, CONFIG.traffic);
  // Игра начинается не внутри кузова: у героя есть безопасное место рядом.
  const spot = findExitSpot(car, def, hash, traffic);
  if (!spot) throw new Error('Не удалось найти безопасную стартовую позицию героя');
  hero = makePedestrian(spot.x, spot.z, spot.heading);
  hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
  crowd = makeCrowd(); stepCrowd(crowd, city, hash, hero, 0);
  onFoot = true;
  ui.setOnFoot(true);
  if (R) R.showHero(false); // герой показывается после выхода из меню
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  fx.lastDist = car.stats.distance;
  fx.prevSkid = [null, null];
  if (R) { R._camInit = false; R._camClip = 99; }
}

function setActiveCar(id, initial = false) {
  const ownDef = carById(id) || CARS[0];
  R.setPlayerCar(ownDef);
  if (initial || !vehicles) {
    def = ownDef; col = colliderOf(def);
    return;
  }
  vehicles.setOwnedDef(ownDef);
  if (vehicles.current === vehicles.own) {
    car = vehicles.own.car; def = ownDef; col = colliderOf(def);
  }
  // При смене гаражной машины не оставляем стоящего рядом героя внутри кузова.
  const own = vehicles.own.car;
  if (onFoot && !interior && hero && circleVsCar(hero.x, hero.z, HERO_RADIUS, own, ownDef.length || 4.4, ownDef.width || 1.9)) {
    const spot = findExitSpot(own, ownDef, hash, traffic, vehicles.ownProxy);
    if (spot) { hero.x = spot.x; hero.z = spot.z; hero.vx = hero.vz = 0; }
  }
}

/** Вернуть машину на ближайшую полосу (правую по ходу движения) */
function respawn() {
  if (roomTransition) return;
  if (interior) {
    const p = interior.layout.spawn;
    hero = makePedestrian(p.x, p.z, p.heading);
    R._camInit = false; ui.hint(''); ui.setHomeTvAction(false, false);
    ui.toast('Вернулись к выходу из помещения');
    return;
  }
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
    const busy = traffic.cars.some(c => c.alive && !c.playerControlled && Math.hypot(c.x - x, c.z - z) < 8);
    if (!busy) break;
    x -= Math.cos(h) * 9; z -= Math.sin(h) * 9;
  }
  const stats = car.stats;
  Object.assign(car, makeCarState(def, x, z, h));
  car.stats = stats;
  vehicles.sync();
  fx.prevSkid = [null, null];
  fx.stuckT = 0;
  R._camInit = false;
  ui.hint('');
}

// ---------------------------------------------------------------- ЭКРАНЫ --
function goMenu() {
  cancelRoomTransition();
  state = 'menu';
  R.setInteriorView(false);
  // Если игрок вышел в меню во время короткого перехода, он остаётся пешком.
  pendingEntry = driverEvent = null;
  R.clearDriver();
  if (R.playerDef !== vehicles.own.def) R.setPlayerCar(vehicles.own.def);
  R.orbit = { a: R.orbit ? R.orbit.a : 2.2, r: 7.2, h: 2.1, speed: 0.12 };
  R.showHero(false);
  if (R.playerMesh) R.playerMesh.visible = true;
  // Также отменяет незавершённую загрузку другого предпросматриваемого героя.
  R.setHero(save.selectedCharacter, save.life.outfit);
  if (input) input.setActive(false);
  if (footInput) footInput.setActive(false);
  ui.syncMenu(save);
  ui.show('menu');
  audio.resume();
}

function goGarage() {
  cancelRoomTransition();
  garageReturn = state === 'pause' ? 'pause' : 'menu';
  state = 'garage';
  R.setInteriorView(false);
  if (R.playerDef !== vehicles.own.def) R.setPlayerCar(vehicles.own.def);
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
  R.setInteriorView(false);
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
  R.setHero(id, save.life.outfit).then(ok => {
    if (state !== 'character' || CHARACTERS[ui.characterIdx].id !== id) return;
    ui.characterStatus(ok ? '' : 'Модель не загрузилась. Проверьте соединение и повторите.');
    R.showHero(ok);
  });
}

function leaveGarage() {
  if (R.playerDef !== vehicles.own.def) R.setPlayerCar(vehicles.own.def); // вернуть свою машину после просмотра
  if (garageReturn === 'pause') goPause(); else goMenu();
}

function goPlay() {
  state = 'play';
  R.orbit = null;
  R.setInteriorView(!!interior);
  R._camInit = false;
  if (R.playerMesh) R.playerMesh.visible = true;
  input.setActive(!onFoot && !pendingEntry && !roomTransition);
  footInput.setActive(onFoot && !pendingEntry && !roomTransition);
  ui.setInside(interior?.layout.kind || null);
  ui.setOnFoot(onFoot);
  if (pendingEntry) ui.setVehicleAction('busy');
  if (roomTransition) ui.setVehicleAction('none');
  R.showHero(onFoot && R.heroId === save.selectedCharacter);
  if (onFoot && R.heroId !== save.selectedCharacter) {
    ui.toast('Загружаем героя…');
    R.setHero(save.selectedCharacter, save.life.outfit).then(ok => {
      if (ok && onFoot && state === 'play') R.showHero(true);
      else if (!ok && onFoot && state === 'play') ui.toast('Не удалось загрузить героя');
    });
  }
  ui.show('play');
  if (!doorsTipShown && onFoot && !interior && !pendingEntry && !roomTransition) {
    doorsTipShown = true;
    ui.toast('Кольца у дверей — вход в дома и магазины');
  }
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

function finishVehicleEntry() {
  pendingEntry = null;
  onFoot = false;
  stopParkedCar(car);
  vehicles.sync();
  hero.vx = hero.vz = hero.speed = 0;
  R.showHero(false);
  input.setActive(state === 'play'); footInput.setActive(false);
  ui.setOnFoot(false); ui.hint('');
  R.driveLookYaw = 0; R.driveLookHeight = 0;
  R._camInit = false; acc = 0;
  ui.toast(vehicles.current.ref ? 'Машина под вашим управлением' : 'Вы в своей машине');
}

/** Короткая сцена: водитель покидает машину и убегает. Двери пока статичны. */
function startDriverExit() {
  const spot = findExitSpot(car, def, hash, traffic, vehicles.current.ref, hero);
  if (!spot || !R.spawnDriver()) return false;
  const heading = Math.atan2(spot.z - car.z, spot.x - car.x);
  const driver = makePedestrian(car.x, car.z, heading);
  driver.camYaw = heading;
  driver.speed = 1.8;
  driverEvent = { elapsed: 0, startX: car.x, startZ: car.z, spot, driver };
  R.updateDriver(driver, 0);
  return true;
}

function stepDriver(dt) {
  if (!driverEvent) return;
  if (!R.driverActor) { driverEvent = null; return; }
  const event = driverEvent, driver = event.driver;
  event.elapsed += dt;
  if (event.elapsed < 0.85) {
    const t = Math.min(1, event.elapsed / 0.85);
    driver.x = event.startX + (event.spot.x - event.startX) * t;
    driver.z = event.startZ + (event.spot.z - event.startZ) * t;
    driver.y = isOnRoad(city, driver.x, driver.z) ? 0 : 0.16;
    driver.speed = 1.8; driver.running = false;
  } else {
    stepPedestrian(driver, { x: 0, y: 1, run: true }, dt, city, hash, car, def, traffic);
  }
  R.updateDriver(driver, dt);
  if (event.elapsed > 4.5) { R.clearDriver(); driverEvent = null; }
}

// Один контекстный выбор для подписи кнопки и для самого нажатия.
function footAction() {
  if (interior) {
    if (hero.pose) return { mode: hero.pose.leaving ? 'home-rising' : 'home-stand' };
    if (nearInteriorExit(hero, interior.layout)) return { mode: 'room-exit' };
    const item = nearestHomeInteraction(hero, interior.layout.interactions);
    if (item?.kind === 'shop') return { mode: 'shop-buy', item };
    return { mode: homeActionMode(item, interior.homeState), item };
  }
  const job = save.life.job;
  const workDoor = job ? entranceById.get(job.targetId) : null;
  const workPoint = jobPoint(job, workDoor);
  if (job?.type === 'cleanup' && workPoint && Math.hypot(hero.x - workPoint.x, hero.z - workPoint.z) <= 1.5) {
    return { mode: 'job-clean', door: workDoor };
  }
  const door = nearestEntrance(hero, entrances);
  const vehicle = vehicles.nearest(hero);
  const person = R.crowdActors.length ? nearestCitizen(hero, crowd) : null;
  if (door && job?.targetId === door.id && job.type !== 'taxi' && job.type !== 'cleanup') return { mode: 'job-deliver', door };
  if (person && (!door || Math.hypot(hero.x - person.x, hero.z - person.z) < Math.hypot(hero.x - door.x, hero.z - door.z)) &&
      (!vehicle || Math.hypot(hero.x - person.x, hero.z - person.z) < carEntryDistance(hero, vehicle.car, vehicle.def))) return { mode: 'citizen-talk', person };
  if (door && (!vehicle || Math.hypot(hero.x - door.x, hero.z - door.z) <= carEntryDistance(hero, vehicle.car, vehicle.def))) {
    return { mode: 'enter-' + door.kind, door };
  }
  const occupied = vehicle?.ref && !vehicle.ref.parked && !vehicle.ref.playerControlled;
  return { mode: occupied ? 'hijack' : 'enter', vehicle };
}

// Плавное затемнение останавливается на паузе, а при выходе в меню/гараж
// отменяется в текущем безопасном состоянии (до или после смены сцены).
function cancelRoomTransition() {
  roomTransition = null;
  ui.roomFade(0);
}
function startRoomTransition(change) {
  if (roomTransition) return;
  hero.vx = hero.vz = hero.speed = 0;
  footInput.setActive(false);
  ui.setVehicleAction('none');
  roomTransition = { elapsed: 0, switched: false, change };
}
function stepRoomTransition(dt) {
  const t = roomTransition;
  if (!t) return;
  t.elapsed += dt;
  if (!t.switched && t.elapsed >= 0.22) {
    t.switched = true;
    try { t.change(); }
    catch (err) {
      console.error('[interior]', err);
      R.setInteriorView(!!interior);
      ui.toast('Не удалось открыть помещение');
    }
  }
  ui.roomFade(Math.max(0, Math.min(1, t.elapsed < 0.22 ? t.elapsed / 0.22 : (0.44 - t.elapsed) / 0.22)));
  if (t.elapsed >= 0.44) {
    cancelRoomTransition();
    if (state === 'play' && onFoot && !pendingEntry) footInput.setActive(true);
  }
}
function enterInterior(door) {
  const outside = { x: hero.x, z: hero.z, heading: hero.heading, camYaw: hero.camYaw, camPitch: hero.camPitch };
  startRoomTransition(() => {
    const layout = makeInteriorLayout(door.kind), roomHash = makeInteriorHash(layout);
    const homeState = door.kind === 'home' ? makeHomeState(save.homeStates[door.id]) : null;
    if (homeState) save.homeStates[door.id] = homeState;
    R.openInterior(layout, roomHash, door.id);
    interior = { door, outside, layout, hash: roomHash, homeState };
    if (homeState) R.updateHome(homeState, 1, null);
    hero = makePedestrian(layout.spawn.x, layout.spawn.z, layout.spawn.heading);
    R.updateHero(hero, 0); R.showHero(true);
    driverEvent = null; R.clearDriver();
    ui.setInside(door.kind); ui.hint('');
    ui.toast(homeState ? 'У плиты можно готовить, у шкафа — переодеться' : 'Подойдите к метке у прилавка: покупки и заказы');
  });
}
function exitInterior() {
  const room = interior;
  const spot = findReturnSpot(room.door, room.outside, hash, car, def, traffic);
  if (!spot) { ui.toast('Выход занят. Попробуйте ещё раз'); return; }
  startRoomTransition(() => {
    const saved = room.outside;
    hero = makePedestrian(spot.x, spot.z, saved.heading);
    hero.camYaw = saved.camYaw; hero.camPitch = saved.camPitch;
    hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
    interior = null;
    R.closeInterior();
    R.updateHero(hero, 0); R.showHero(true);
    ui.setInside(null); ui.hint('');
    ui.toast('Вы на улице');
  });
}

function drivingAction() {
  const job = save.life.job;
  if (job?.type !== 'taxi') return null;
  const passenger = crowd?.people.find(p => p.taxiReserved);
  if (passenger?.condition === 'taxi-board') return { mode: 'taxi-boarding' };
  const door = entranceById.get(job.targetId);
  if (!door || !carIsStopped(car) || Math.hypot(car.x - door.x, car.z - door.z) > 6) return null;
  if (job.stage === 'pickup' && passenger?.condition === 'taxi-wait' && R.crowdActors.length) return { mode: 'taxi-board', door };
  if (job.stage === 'drive' && passenger?.condition === 'taxi-seat') return { mode: 'taxi-drop', door };
  return null;
}

// Действие на клавиатуре — E, на телефоне — контекстная кнопка.
function toggleVehicle() {
  if (state !== 'play' || pendingEntry || roomTransition) return;
  if (onFoot) {
    const action = footAction();
    if (action.mode === 'room-exit') { exitInterior(); return; }
    if (action.mode === 'shop-buy') { openLife('shop'); return; }
    if (action.mode === 'job-deliver' || action.mode === 'job-clean') {
      const before = save.money, result = completeJob(save, action.door);
      if (result.ok) { markDirty(); flushNow(); if (result.complete) { audio.money(); checkAffordable(before); } }
      ui.toast(result.message);
      return;
    }
    if (action.mode === 'citizen-talk') {
      const phrases = ['Здравствуйте! У продавца есть заказы на доставку.', 'Привет! Дома можно отдохнуть и приготовить еду.', 'Добрый день! Жёлтая метка ведёт к адресу заказа.', 'Следите за здоровьем и сытостью вверху экрана.'];
      action.person.pause = 2.5; action.person.speed = 0;
      action.person.heading = Math.atan2(hero.z - action.person.z, hero.x - action.person.x);
      ui.toast(phrases[action.person.id % phrases.length]); return;
    }
    if (interior) {
      if (action.mode === 'home-stand') { requestStand(hero); R._camInit = false; return; }
      if (action.mode === 'home-rising') return;
      if (action.item?.kind === 'sit' || action.item?.kind === 'lie') {
        if (!R.heroActor || R.heroId !== save.selectedCharacter) { ui.toast('Сначала дождитесь загрузки героя'); return; }
        if (startHomePose(hero, action.item, interior.layout)) R._camInit = false;
        else ui.toast('Подойдите к мебели с другой стороны');
      } else if (action.item && toggleHomeItem(interior.homeState, action.item)) {
        // Поворачиваемся к предмету; если он был за камерой, один раз
        // показываем результат, после чего камера снова свободна для свайпа.
        const target = action.item.target;
        if (target) {
          const yaw = Math.atan2(target.z - hero.z, target.x - hero.x);
          hero.heading = yaw;
          const diff = Math.atan2(Math.sin(yaw - hero.camYaw), Math.cos(yaw - hero.camYaw));
          if (Math.abs(diff) > 1.0) { hero.camYaw = yaw; R._camInit = false; }
        }
        markDirty();
      } else ui.toast('Подойдите к голубой метке или к выходу');
      return;
    }
    if (action.door) { enterInterior(action.door); return; }
    if (save.life.job?.type === 'taxi' && save.life.job.stage === 'drive' && action.vehicle && action.vehicle.ref !== vehicles.current.ref) {
      ui.toast('Пассажир ждёт в вашей машине. Сначала завершите или отмените поездку'); return;
    }
    const result = vehicles.enter(action.vehicle);
    if (!result.ok) {
      ui.toast(result.reason === 'too-fast'
        ? 'Машина тормозит. Подойдите и нажмите ещё раз'
        : 'Подойдите ближе к машине');
      return;
    }
    car = vehicles.current.car; def = vehicles.current.def; col = colliderOf(def);
    fx.prevSkid = [null, null]; fx.stuckT = 0; acc = 0;
    if (result.occupied && startDriverExit()) {
      pendingEntry = { elapsed: 0 };
      hero.vx = hero.vz = hero.speed = 0;
      footInput.setActive(false);
      ui.setVehicleAction('busy');
      ui.toast('Водитель выходит из машины');
    } else finishVehicleEntry();
    return;
  }
  const taxi = drivingAction();
  if (taxi?.mode === 'taxi-boarding') { ui.toast('Подождите, пассажир садится'); return; }
  if (taxi?.mode === 'taxi-board') {
    const result = boardTaxi(save.life, taxi.door);
    if (result.ok) { stopParkedCar(car); markDirty(); flushNow(); }
    ui.toast(result.message); return;
  }
  if (taxi?.mode === 'taxi-drop') {
    const before = save.money, result = completeTaxi(save, taxi.door);
    if (result.ok) { releaseTaxiPassenger(crowd, taxi.door); markDirty(); flushNow(); audio.money(); checkAffordable(before); }
    ui.toast(result.message); return;
  }
  if (!carIsStopped(car)) { ui.toast('Сначала остановите машину'); return; }
  if (!R.heroActor || R.heroId !== save.selectedCharacter) {
    ui.toast('Загружаем героя. Попробуйте ещё раз');
    R.setHero(save.selectedCharacter, save.life.outfit).then(ok => { if (!ok && state === 'play') ui.toast('Не удалось загрузить героя'); });
    return;
  }
  const spot = findExitSpot(car, def, hash, traffic, vehicles.current.ref);
  if (!spot) { ui.toast('Нет места для выхода — отъедьте от препятствия'); return; }
  stopParkedCar(car);
  vehicles.sync();
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
function toggleSeatedTv() {
  if (state !== 'play' || roomTransition || interior?.layout.kind !== 'home' || hero.pose?.kind !== 'sit' || hero.pose.leaving) return;
  const tv = interior.layout.interactions.find(item => item.id === 'tv');
  if (toggleHomeItem(interior.homeState, tv)) markDirty();
}
window.addEventListener('keydown', e => {
  if (e.repeat || state !== 'play') return;
  if (e.code === 'KeyE') { e.preventDefault(); toggleVehicle(); }
  if (e.code === 'KeyT') { e.preventDefault(); toggleSeatedTv(); }
  if (e.code === 'KeyB') { e.preventDefault(); openLife('bag'); }
  if (e.code === 'KeyF') { e.preventDefault(); lifeContext(); }
});

// Окно покупок/рюкзака ставит симуляцию на паузу и снимает удерживаемый ввод.
function lifeContext() {
  if (state !== 'play' || !interior?.homeState || roomTransition || hero.pose) return;
  const item = nearestHomeInteraction(hero, interior.layout.interactions);
  if (item?.id === 'stove') openLife('cook');
  else if (item?.id === 'cabinet') {
    if (!interior.homeState.cabinet) { ui.toast('Сначала откройте шкаф основной кнопкой'); return; }
    openLife('wardrobe');
  }
}
function lifeContextInfo() { return { stove: !!interior?.homeState?.stove, changing: lifeChanging, canTaxi: !!(onFoot && !interior && !roomTransition && !pendingEntry) }; }
function openLife(mode) {
  if (state !== 'play' || roomTransition || pendingEntry) return;
  if (mode !== 'bag') {
    if (!onFoot || !interior) return;
    const item = nearestHomeInteraction(hero, interior.layout.interactions);
    if ((mode === 'shop' && item?.id !== 'cashier') || (mode === 'cook' && item?.id !== 'stove') ||
        (mode === 'wardrobe' && item?.id !== 'cabinet')) return;
  }
  state = 'life'; input.setActive(false); footInput.setActive(false);
  ui.openLife(mode, save, lifeContextInfo());
  flushNow();
}
function closeLife() {
  if (state !== 'life') return;
  if (lifeChanging) { ui.renderLife(save, lifeContextInfo(), 'Подождите загрузку одежды…'); return; }
  goPlay();
}
function takeTaxi(type) {
  if (state !== 'life' || ui.lifeMode !== 'bag' || !onFoot || interior || roomTransition || pendingEntry) return;
  const fare = TAXI_FARES[type];
  const door = taxiDestination(type, hero, entrances, save.life.job);
  if (!Number.isFinite(fare) || !door) { ui.renderLife(save, lifeContextInfo(), 'Нет подходящего адреса или вы уже рядом'); return; }
  if (save.money < fare) { ui.renderLife(save, lifeContextInfo(), `Не хватает $ ${fare - Math.floor(save.money)}`); return; }
  const spot = findReturnSpot(door, { x: door.x, z: door.z }, hash, car, def, traffic);
  if (!spot) { ui.renderLife(save, lifeContextInfo(), 'У адреса нет свободного места. Попробуйте позже'); return; }
  save.money = Math.round((save.money - fare) * 100) / 100;
  markDirty(); flushNow(); goPlay();
  startRoomTransition(() => {
    hero = makePedestrian(spot.x, spot.z, Math.atan2(-door.nz, -door.nx));
    hero.y = isOnRoad(city, hero.x, hero.z) ? 0 : 0.16;
    R.updateHero(hero, 0); R.showHero(true); R._camInit = false;
    ui.toast(`Такси: быстрый переезд · −$ ${fare}. Ваша машина осталась на месте`);
  });
}
function lifeAction(action, id) {
  if (state !== 'life' || lifeChanging) return;
  const mode = ui.lifeMode;
  let result = null;
  if (mode === 'shop' && action === 'buy') result = buyItem(save, id);
  else if (mode === 'shop' && action === 'buy-outfit') result = buyOutfit(save, id);
  else if (mode === 'shop' && action === 'job') result = acceptJob(save.life, id, interior?.door, entrances);
  else if (mode === 'bag' && action === 'use') result = useItem(save.life, id);
  else if (mode === 'bag' && action === 'taxi') { takeTaxi(id); return; }
  else if (mode === 'bag' && action === 'cancel-job' && save.life.job) {
    if (save.life.job.type === 'taxi') {
      let spot = null;
      if (save.life.job.stage === 'drive') {
        stopParkedCar(car); vehicles.sync();
        spot = findExitSpot(car, def, hash, traffic, vehicles.current.ref);
        if (spot) spot.y = isOnRoad(city, spot.x, spot.z) ? 0 : 0.16;
      }
      cancelTaxiPassenger(crowd, spot);
    }
    save.life.job = null; result = { ok: true, message: 'Заказ отменён' };
  }
  else if (mode === 'cook' && action === 'cook') result = cookRecipe(save.life, id, !!interior?.homeState?.stove);
  else if (mode === 'wardrobe' && action === 'wear' && save.life.outfits.includes(id)) {
    lifeChanging = true;
    ui.renderLife(save, lifeContextInfo(), 'Загружаем одежду…');
    R.setHero(save.selectedCharacter, id).then(ok => {
      lifeChanging = false;
      if (ok) {
        save.life.outfit = id; markDirty(); flushNow();
        R.updateHero(hero, 0); R.showHero(true);
      }
      if (state === 'life') ui.renderLife(save, lifeContextInfo(), ok ? 'Одежда изменена' : 'Не удалось загрузить одежду');
    });
    return;
  }
  if (!result) return;
  if (result.ok) { markDirty(); flushNow(); }
  ui.renderLife(save, lifeContextInfo(), result.message);
}

// ----------------------------------------------------------- ПОЛНЫЙ ЭКРАН --
// Браузер даёт полный экран только по жесту (для касаний — click/pointerup, не pointerdown).
// Поэтому: первое касание, ИГРАТЬ/ПРОДОЛЖИТЬ и отдельная кнопка в HUD.
// Браузер/оболочка могут отказать; в таком случае игра остаётся доступной в окне.
const FS_OK = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const FULL_DISPLAY = ANDROID_APP || matchMedia('(display-mode: fullscreen)').matches;
const STANDALONE = FULL_DISPLAY || matchMedia('(display-mode: standalone)').matches || !!navigator.standalone;
const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
let wasFullscreen = false;

function enterFullscreen(explicit = false) {
  if (SHOT) return;
  if (FULL_DISPLAY) { lockLandscape(); return; } // установленное приложение уже полноэкранное
  if (!FS_OK) {
    if (explicit) ui.toast('Полный экран недоступен. Попробуйте Chrome или ярлык на главном экране');
    return;
  }
  if (!isFullscreen()) {
    const el = document.documentElement;
    const denied = () => ui.toast('Браузер не разрешил полный экран. Попробуйте Chrome или ярлык игры');
    try {
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' })
        : el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null;
      if (!el.requestFullscreen && !el.webkitRequestFullscreen) { if (explicit) denied(); }
      else if (p && p.then) p.then(() => { lockLandscape(); syncFsButton(); }, denied);
    } catch (e) { denied(); }
  } else lockLandscape();
}

function lockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) { /* не везде поддерживается */ }
}

function syncFsButton() {
  const btn = document.getElementById('btn-fs');
  const hud = document.getElementById('hud-fs');
  if (!btn || !hud) return;
  const scr = ui && ui.screen;
  const available = !FULL_DISPLAY && !SHOT && !isFullscreen();
  btn.classList.toggle('hidden', !(available && (scr === 'menu' || scr === 'pause')));
  hud.classList.toggle('hidden', !(available && scr === 'play'));
}

function onFullscreenChange() {
  const fs = isFullscreen();
  if (wasFullscreen && !fs && state === 'play') goPause();   // случайный «назад» — пауза, а не езда в окне
  wasFullscreen = fs;
  if (fs) lockLandscape();
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
    fullscreen: () => enterFullscreen(true),
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
    homeTv: () => toggleSeatedTv(),
    openLife: (mode) => openLife(mode),
    closeLife: () => closeLife(),
    lifeContext: () => lifeContext(),
    lifeAction: (action, id) => lifeAction(action, id),
    garageBack: () => leaveGarage(),
    resume: () => { enterFullscreen(); goPlay(); },
    pause: () => goPause(),
    menu: () => goMenu(),
    respawn: () => respawn(),
    previewCar: (id) => R.setPlayerCar(carById(id)),
    selectCar: (id) => {
      save.activeCar = id; markDirty(); flushNow();
      setActiveCar(id);
      ui.toast('В гараже выбрана: ' + vehicles.own.def.name);
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
      R.setHero(save.selectedCharacter, save.life.outfit);
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
  if (state === 'pause' || state === 'loading' || state === 'life') return;   // статичный кадр — не тратим батарею
  frame(dt, now);
}

function frame(dt, now) {
  time += dt;
  const playing = state === 'play';
  const date = new Date(), minute = Math.floor(date.getTime() / 60000);
  if (minute !== worldMinute) {
    worldMinute = minute; const hour = localHour(date); R.setWorldTime(hour);
    worldClock = (daylight(hour).day > 0.4 ? '☀ ' : '☾ ') + clockText(date);
  }
  const job = save.life.job;
  const targetDoor = job ? entranceById.get(job.targetId) : null;
  const target = jobPoint(job, targetDoor);
  R.setJobTarget(target, job?.type === 'cleanup');
  const passenger = syncTaxiPassenger(crowd, job, entranceById, car, def, playing && !interior && !roomTransition ? dt : 0);
  if (playing) {
    const rest = onFoot && interior?.homeState && hero.pose && !hero.pose.leaving && hero.pose.amount > 0.8 ? hero.pose.kind : null;
    stepNeeds(save.life, dt, { rest, starvationDamage: save.settings.starvationDamage });
    markDirty();
    fx.healthCd = Math.max(0, fx.healthCd - dt); footHitCd = Math.max(0, footHitCd - dt);
  }
  if (playing && roomTransition) stepRoomTransition(dt);
  if (playing && pendingEntry) {
    pendingEntry.elapsed += dt;
    if (pendingEntry.elapsed >= 0.9) finishVehicleEntry();
  }
  const driving = playing && !onFoot;
  let frameImpact = 0, impVx = 0, impVz = 0;
  let inp = null;

  if (driving) {
    inp = input.sample();
    if (passenger?.condition === 'taxi-board') {
      // Не уезжаем, пока модель пассажира подходит и садится.
      stopParkedCar(car); inp = { ...inp, throttle: 0, brake: 0, handbrake: false, steer: 0 };
    }
    R.moveCarCamera(inp.lookX, inp.lookY);
    if (inp.reset && !fx.wasReset) respawn();
    fx.wasReset = inp.reset;
    acc += dt;
    let steps = 0;
    while (acc >= PH.dt && steps < PH.maxStepsPerFrame) {
      const vx0 = car.vx, vz0 = car.vz, previous = { x: car.x, z: car.z };
      stepCar(car, def, inp, PH.dt, { onRoad: isOnRoad(city, car.x, car.z) });
      const w = collideWorld(car, col, hash, PH);
      const t = collideTraffic(car, col, traffic, PH);
      handleCitizenHits(collideCrowd(crowd, car, def, previous), true);
      const imp = Math.max(w.impact, t);
      if (imp > frameImpact) { frameImpact = imp; impVx = car.vx - vx0; impVz = car.vz - vz0; }
      acc -= PH.dt;
      steps++;
    }
    if (steps >= PH.maxStepsPerFrame) acc = 0;
    if (!isFinite(car.x) || !isFinite(car.z) || !isFinite(car.vx)) respawn();
  } else if (playing && onFoot && !pendingEntry && !roomTransition) {
    inp = footInput.sample();
    if (inp.reset && !fx.wasReset) respawn();
    fx.wasReset = inp.reset;
    hero.camYaw = turnLook(hero.camYaw, inp.lookX);
    hero.camPitch = clamp(hero.camPitch + inp.lookY * 0.004, -0.12, 0.72);
    if (interior) {
      if (!stepHomePose(hero, inp, dt)) stepPedestrian(hero, inp, dt, null, interior.hash, null, null, null);
      ui.hint('');
    } else stepPedestrian(hero, inp, dt, city, hash, car, def, traffic);
  }

  // Пока игрок в помещении или в переходе, наружный мир не меняется:
  // припаркованная машина и точка выхода не оказываются под трафиком.
  if (!interior && !roomTransition) {
    vehicles.sync();
    stepTraffic(traffic, city, Math.min(dt, 0.05), CONFIG.traffic, onFoot && playing ? hero : car, onFoot && playing ? car : null);
    if (playing) {
      stepDriver(dt);
      stepCrowd(crowd, city, hash, onFoot ? hero : car, dt);
      // Припаркованная машина тоже не прозрачна для прохожих.
      if (onFoot) handleCitizenHits(collideCrowd(crowd, car, def), false);
      // Машины трафика могут столкнуться с людьми на проезжей части. Проверяем
      // только близкие пары; 24×4 дешёвых расстояния вместо лишних скелетов.
      for (const t of traffic.cars) {
        if (!t.alive || t.playerControlled || t.parked || t.noRender || t.speed <= 0.5) continue;
        if (!crowd.people.some(p => p.alive && ['walk', 'return', 'taxi-wait'].includes(p.condition) &&
          Math.abs(p.x - t.x) < 7 && Math.abs(p.z - t.z) < 7)) continue;
        const h = t.visHeading ?? t.heading, vx = Math.cos(h) * t.speed, vz = Math.sin(h) * t.speed;
        const moving = { x: t.x, z: t.z, heading: h, vx, vz, speed: t.speed };
        const size = { length: t.length || (t.half || 1) * 2 + 1.9, width: t.width || 1.9 };
        const hits = collideCrowd(crowd, moving, size, { x: t.x - vx * Math.min(dt, 0.05), z: t.z - vz * Math.min(dt, 0.05) });
        if (hits.some(hit => hit.kind !== 'push')) { t.speed = Math.max(0, moving.speed); t.stunned = Math.max(t.stunned || 0, 1); }
        handleCitizenHits(hits, false);
      }
      if (onFoot && !pendingEntry && footHitCd <= 0) {
        const hit = traffic.cars.find(t => t.alive && !t.playerControlled && !t.noRender && Math.abs(t.speed) > 4 &&
          Math.hypot(t.x - hero.x, t.z - hero.z) < 4 && circleVsCar(hero.x, hero.z, HERO_RADIUS,
            { x: t.x, z: t.z, heading: t.visHeading ?? t.heading }, t.length || (t.half || 1) * 2 + 1.9, t.width || 1.9));
        if (hit) { damage(save.life, Math.min(30, 8 + Math.abs(hit.speed) * 1.5)); footHitCd = 2; ui.flashHit(0.6); markDirty(); }
      }
    }
  }

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

  if (playing && save.life.health <= 0) {
    save.life.health = 50; save.life.satiety = Math.max(30, save.life.satiety);
    if (!onFoot) { stopParkedCar(car); vehicles.sync(); }
    respawn(); markDirty(); flushNow(); ui.toast('Вы потеряли сознание и пришли в себя. Здоровье восстановлено до 50');
  }

  const rollT = driving ? clamp(-car.accelLat * 0.0042, -0.075, 0.075) : 0;
  const pitchT = driving ? clamp(car.accelLong * 0.0038, -0.05, 0.045) : 0;
  visual.roll = damp(visual.roll, rollT, 7, dt);
  visual.pitch = damp(visual.pitch, pitchT, 7, dt);
  visual.braking = driving && ((inp.brake > 0.1 && car.speed > 0.5) || inp.handbrake);

  shake = damp(shake, 0, CONFIG.camera.shakeDecay, dt);
  // В игре гаражная машина остаётся там, где её оставили. В меню/гараже
  // показываем её как витрину в точке текущего игрока.
  if (!R.inInterior) R.updatePlayer(playing ? vehicles.own.car : car, dt, playing && vehicles.current !== vehicles.own ? null : visual);
  if (state === 'character') {
    previewHero.x = car.x; previewHero.z = car.z; previewHero.y = car.onRoad === false ? 0.16 : 0;
    R.updateHero(previewHero, dt, true);
  } else if (onFoot && playing) R.updateHero(hero, dt);
  if (playing && onFoot) R.updateFootCamera(hero, dt);
  else R.updateCamera(car, dt, shake);
  const roomAction = playing && interior && onFoot && !roomTransition ? footAction() : null;
  if (playing && interior?.homeState) R.updateHome(interior.homeState, dt, roomAction?.item || null);
  if (!R.inInterior) {
    R.updateTraffic(traffic.cars, !playing);
    R.updateCheckpoints(g.checkpoints, time);
    R.updateParticles(dt);
  }
  syncTaxiPassenger(crowd, save.life.job, entranceById, car, def, 0);
  R.updateCrowd(crowd, dt, playing && !interior && !roomTransition);
  R.adaptPerformance(dt);
  R.render();

  if (playing) {
    if (onFoot && !pendingEntry) ui.setVehicleAction(roomTransition ? 'none' : (roomAction || footAction()).mode);
    else if (!onFoot) ui.setVehicleAction(drivingAction()?.mode || 'exit');
    ui.setLifeContext(!roomTransition && !hero.pose && interior?.homeState && roomAction?.item?.id === 'stove' ? 'cook'
      : !roomTransition && !hero.pose && interior?.homeState && roomAction?.item?.id === 'cabinet' ? 'wardrobe' : null);
    ui.setHomeTvAction(!!(interior?.homeState && hero.pose?.kind === 'sit' && !hero.pose.leaving && !roomTransition), !!interior?.homeState?.tv);
    const st = save.settings;
    const player = onFoot ? hero : car;
    ui.updateHud({
      car: player, def, g, dt, onFoot, interior: interior?.layout.kind || null,
      money: save.money, life: save.life, clock: worldClock, jobTarget: target,
      jobLabel: job?.type === 'taxi' ? (job.stage === 'pickup' ? 'ПАССАЖИР' : 'АДРЕС ТАКСИ')
        : job?.type === 'cleanup' ? `МЕШОК ${job.index + 1}/3`
        : job?.type === 'route' ? `ДОСТАВКА ${job.index + 1}/3` : 'ДОСТАВКА',
      nearest: interior ? null : nearestCheckpoint(g, player.x, player.z),
      camYaw: R.camYaw,
      fpsText: st.showFps ? `${Math.round(R.fps)} FPS · ${R.renderW}×${R.renderH} · ${R.drawCalls} dc` : '',
    });
  }
  maybeFlush(now);
}

// ------------------------------------------------------------- СОБЫТИЯ --
function handleCitizenHits(hits, byPlayer) {
  const hit = hits.find(h => h.kind !== 'push');
  if (!hit) return;
  const passengerHit = hits.find(h => h.kind !== 'push' && h.person.taxiReserved);
  if (passengerHit && save.life.job?.type === 'taxi' && save.life.job.stage === 'pickup') {
    passengerHit.person.taxiReserved = false;
    save.life.job = null; markDirty(); flushNow();
    ui.toast('Пассажир пострадал: заказ такси отменён');
  }
  if (byPlayer) {
    shake = Math.max(shake, Math.min(0.28, hit.impact * 0.015));
    audio.impact(Math.min(10, hit.impact));
    vibrate(Math.min(35, Math.round(12 + hit.impact)));
  }
}

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
  if (imp > 6 && fx.healthCd <= 0) {
    damage(save.life, Math.min(25, (imp - 6) * 1.5)); fx.healthCd = 1.2; markDirty();
  }
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

// В APK ресурсы уже локальные, а старый SW-кэш мог бы скрыть файлы обновления.
if (ANDROID_APP) {
  // Android «Назад» закрывает вложенные экраны, ставит игру на паузу или возвращает в меню.
  // false означает, что оболочка может спросить о выходе из приложения.
  window.__openStreetAndroidBack = () => {
    if (ui.screen === 'credits') { ui.show('settings'); return true; }
    if (ui.screen === 'settings') { ui.show(ui.settingsReturn); return true; }
    if (state === 'life') { closeLife(); return true; }
    if (state === 'play') { goPause(); return true; }
    if (state === 'pause') { goPlay(); return true; }
    if (state === 'garage') { leaveGarage(); return true; }
    if (state === 'character') { goMenu(); return true; }
    return false;
  };
  window.__openStreetAndroidPause = () => {
    if (state === 'play') goPause();
    else { flushNow(); audio.suspend(); }
  };
} else if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // В браузере офлайн-режим включается после первого открытия.
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot().catch((e) => {
  console.error(e);
  ui.fatal('Ошибка запуска: ' + (e && e.message ? e.message : e));
});
