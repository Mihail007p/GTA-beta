// ============================================================================
//  SAVE — прогресс игрока. Только localStorage, без серверов и аналитики.
//  Пишем не чаще раза в 2 секунды: частые записи на мобильной флешке — лаги.
// ============================================================================
import { STARTER_CAR } from './cars.js';
import { DEFAULT_CHARACTER, characterById } from './characters.js';
import { makeHomeState } from './home-interactions.js';
import { makeLife } from './life.js';

const KEY = 'openstreet.save.v1';

export const DEFAULT_SAVE = {
  version: 1,
  money: 0,
  totalDistance: 0,       // метры
  totalDrift: 0,          // секунды в заносе
  bestScore: 0,
  bestSpeed: 0,           // км/ч
  ownedCars: [STARTER_CAR],
  activeCar: STARTER_CAR,
  selectedCharacter: DEFAULT_CHARACTER,
  homeStates: {},         // состояния предметов отдельно для каждого дома
  life: null,             // создаётся отдельно, чтобы инвентарь не был общим
  settings: { sound: true, haptics: true, quality: 'auto', steerSens: 'mid', steerMode: 'arrows', stickPedals: false, showFps: false, starvationDamage: true },
  notifiedCars: [],       // о каких машинах уже сообщали «можно купить»
  runs: 0,
  lastPlayed: 0,
};

let _cache = null;
let _dirty = false;
let _lastFlush = 0;

export function loadSave() {
  if (_cache) return _cache;
  let data = null;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(KEY) : null;
    if (raw) data = JSON.parse(raw);
  } catch (e) {
    data = null;
  }
  _cache = mergeDefaults(data);
  return _cache;
}

function mergeDefaults(data) {
  const out = Object.assign({}, DEFAULT_SAVE, data || {});
  out.settings = Object.assign({}, DEFAULT_SAVE.settings, (data && data.settings) || {});
  if (typeof out.settings.starvationDamage !== 'boolean') out.settings.starvationDamage = true;
  out.life = makeLife(data?.life);
  // массивы всегда копируем: иначе ownCar() мутировал бы DEFAULT_SAVE
  out.ownedCars = (Array.isArray(out.ownedCars) && out.ownedCars.length) ? out.ownedCars.slice() : [STARTER_CAR];
  out.notifiedCars = Array.isArray(out.notifiedCars) ? out.notifiedCars.slice() : [];
  // Старые сохранения не содержат домов. Читаем только ограниченные числовые
  // id и известные boolean-поля, не доверяя повреждённому localStorage.
  const homes = {};
  const rawHomes = data?.homeStates;
  if (rawHomes && typeof rawHomes === 'object' && !Array.isArray(rawHomes)) {
    for (const [id, value] of Object.entries(rawHomes)) {
      if (/^(0|[1-9]\d{0,4})$/.test(id) && value && typeof value === 'object' && !Array.isArray(value)) homes[id] = makeHomeState(value);
    }
  }
  out.homeStates = homes;
  if (!out.ownedCars.includes(out.activeCar)) out.activeCar = out.ownedCars[0];
  if (!characterById(out.selectedCharacter)) out.selectedCharacter = DEFAULT_CHARACTER;
  if (typeof out.money !== 'number' || !isFinite(out.money) || out.money < 0) out.money = 0;
  return out;
}

export function markDirty() { _dirty = true; }

/** Вызывается из игрового цикла; реально пишет редко. */
export function maybeFlush(now) {
  if (!_dirty) return false;
  if (now - _lastFlush < 2000) return false;
  _lastFlush = now;
  _dirty = false;
  try {
    if (typeof localStorage !== 'undefined') {
      _cache.lastPlayed = Date.now();
      localStorage.setItem(KEY, JSON.stringify(_cache));
    }
  } catch (e) {
    // приватный режим / переполнение — молча продолжаем играть
  }
  return true;
}

export function flushNow() {
  if (!_cache) return;
  try {
    if (typeof localStorage !== 'undefined') {
      _cache.lastPlayed = Date.now();
      localStorage.setItem(KEY, JSON.stringify(_cache));
    }
  } catch (e) { /* ignore */ }
  _dirty = false;
}

export function addMoney(n) {
  const s = loadSave();
  s.money = Math.max(0, Math.round((s.money + n) * 100) / 100);
  markDirty();
  return s.money;
}

export function ownCar(id) {
  const s = loadSave();
  if (!s.ownedCars.includes(id)) { s.ownedCars.push(id); markDirty(); }
}

/** Сброс прогресса (деньги, машины, рекорды). Настройки (звук, руль, графика) сохраняются. */
export function resetSave() {
  const keep = _cache && _cache.settings ? Object.assign({}, _cache.settings) : {};
  _cache = Object.assign({}, DEFAULT_SAVE, { settings: Object.assign({}, DEFAULT_SAVE.settings, keep) });
  _cache.ownedCars = [STARTER_CAR];
  _cache.notifiedCars = [];
  _cache.homeStates = {};
  _cache.life = makeLife();
  markDirty();
  flushNow();
  return _cache;
}
