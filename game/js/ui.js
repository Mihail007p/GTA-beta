// ============================================================================
//  UI — экраны, HUD, мини-карта, гараж, настройки.
//  Правило производительности: DOM трогаем только когда значение изменилось,
//  текст HUD обновляем ~20 раз/с, мини-карту ~30 раз/с.
// ============================================================================
import { CARS } from './cars.js';
import { CHARACTERS } from './characters.js';
import { CONFIG, MS_TO_KMH } from './config.js';
import { makeCarState, stepCar } from './car-physics.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

/** Разгон 0–100 км/ч из той же физики, что в игре (честные цифры в гараже) */
function measure0to100(def) {
  const car = makeCarState(def, 0, 0, 0);
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 15; i++) {
    stepCar(car, def, { steer: 0, throttle: 1, brake: 0, handbrake: false }, dt, { onRoad: true });
    if (car.speed >= 100 / MS_TO_KMH) return (i + 1) * dt;
  }
  return 15;
}

export class UI {
  constructor() {
    this.h = {};                       // колбэки, задаёт main.js
    this.screen = 'loading';
    this._last = {};
    this._seen = new WeakSet();
    this.fxSpeed = document.getElementById('fx-speed');
    this.fxHit = document.getElementById('fx-hit');
    this._hudT = 1;
    this._mapT = 1;
    this.hitFlash = 0;
    this.garageIdx = 0;
    this.characterIdx = 0;
    this.carStats = CARS.map(def => ({
      t100: measure0to100(def),
      kmh: Math.round(def.topSpeed * MS_TO_KMH),
    }));
    this.settingsReturn = 'menu';
    // null означает, что подтверждение ещё не запрошено; 0 может быть временем первого нажатия.
    this._resetArmed = null;
    this._bind();
  }

  // ------------------------------------------------------------- ЭКРАНЫ ---
  show(name) {
    this.screen = name;
    for (const s of ['loading', 'menu', 'garage', 'character', 'settings', 'pause', 'fatal']) {
      $(s).classList.toggle('hidden', s !== name);
    }
    const playing = name === 'play';
    document.body.classList.toggle('playing', playing);
    $('hud').classList.toggle('hidden', !playing);
    $('controls-root').classList.toggle('hidden', !playing);
    $('fx-speed').style.display = playing ? '' : 'none';
    if (!playing) { this.fxSpeed.style.opacity = '0'; this._spdOp = 0; }
    if (this.onShow) this.onShow(name);
  }

  setLoading(p, text) {
    $('load-fill').style.width = Math.round(p * 100) + '%';
    if (text) $('load-text').textContent = text;
  }

  fatal(text) {
    $('fatal-text').textContent = text;
    this.show('fatal');
  }

  _bind() {
    const tap = (id, fn) => $(id).addEventListener('click', (e) => { e.preventDefault(); this.h.click && this.h.click(); fn(); });
    tap('btn-play', () => this.h.play && this.h.play());
    $('btn-fs').addEventListener('click', (e) => { e.preventDefault(); this.h.fullscreen && this.h.fullscreen(); });
    tap('btn-garage', () => this.h.garage && this.h.garage());
    tap('btn-character', () => this.h.character && this.h.character());
    tap('character-back', () => this.h.characterBack && this.h.characterBack());
    tap('character-prev', () => this.characterStep(-1));
    tap('character-next', () => this.characterStep(1));
    tap('character-action', () => this._characterAction());
    tap('btn-settings', () => this.openSettings('menu'));
    tap('pause-resume', () => this.h.resume && this.h.resume());
    tap('pause-garage', () => this.h.garage && this.h.garage());
    tap('pause-settings', () => this.openSettings('pause'));
    tap('pause-menu', () => this.h.menu && this.h.menu());
    tap('settings-back', () => this.show(this.settingsReturn));
    tap('garage-back', () => this.h.garageBack && this.h.garageBack());
    tap('car-prev', () => this.garageStep(-1));
    tap('car-next', () => this.garageStep(1));
    tap('car-action', () => this._garageAction());
    $('btn-pause').addEventListener('pointerdown', (e) => { e.preventDefault(); this.h.pause && this.h.pause(); });
    $('btn-reset').addEventListener('pointerdown', (e) => { e.preventDefault(); this.h.respawn && this.h.respawn(); });
    $('vehicle-action').addEventListener('pointerdown', (e) => { e.preventDefault(); this.h.vehicle && this.h.vehicle(); });

    for (const seg of document.querySelectorAll('.seg')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const key = seg.dataset.set;
        let v = b.dataset.v;
        if (v === 'true') v = true; else if (v === 'false') v = false;
        this.h.click && this.h.click();
        this.h.setting && this.h.setting(key, v);
        this.syncSettings(this.h.getSave());
      });
    }
    $('btn-reset-save').addEventListener('click', () => {
      const btn = $('btn-reset-save');
      const now = performance.now();
      if (this._resetArmed !== null && now - this._resetArmed < 3500) {
        this._resetArmed = null;
        btn.textContent = 'Сбросить';
        this.h.resetProgress && this.h.resetProgress();
        this.toast('Прогресс сброшен');
      } else {
        this._resetArmed = now;
        btn.textContent = 'Точно? Ещё раз';
        setTimeout(() => { if (this._resetArmed === now) { this._resetArmed = null; btn.textContent = 'Сбросить'; } }, 3500);
      }
    });
  }

  openSettings(from) {
    this.settingsReturn = from;
    this.syncSettings(this.h.getSave());
    this.show('settings');
  }

  syncSettings(save) {
    const st = save.settings;
    for (const seg of document.querySelectorAll('.seg')) {
      const cur = String(st[seg.dataset.set]);
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === cur);
    }
    $('fps').classList.toggle('hidden', !st.showFps);
  }

  // --------------------------------------------------------------- МЕНЮ ---
  syncMenu(save) {
    $('menu-money').textContent = '$ ' + fmt(save.money);
    $('menu-best').textContent = fmt(save.bestScore);
    $('menu-speed').textContent = Math.round(save.bestSpeed) + ' км/ч';
    $('menu-dist').textContent = (save.totalDistance / 1000).toFixed(1) + ' км';
    $('menu-cars').textContent = save.ownedCars.length + ' / ' + CARS.length;
  }

  // ----------------------------------------------------------- ПЕРСОНАЖ ---
  openCharacter(save) {
    this.characterIdx = Math.max(0, CHARACTERS.findIndex(c => c.id === save.selectedCharacter));
    this.syncCharacter(save);
    this.show('character');
    this.h.previewCharacter && this.h.previewCharacter(CHARACTERS[this.characterIdx].id);
  }
  characterStep(d) {
    this.characterIdx = (this.characterIdx + d + CHARACTERS.length) % CHARACTERS.length;
    this.syncCharacter(this.h.getSave());
    this.h.previewCharacter && this.h.previewCharacter(CHARACTERS[this.characterIdx].id);
  }
  syncCharacter(save) {
    const def = CHARACTERS[this.characterIdx];
    $('character-name').textContent = def.name;
    $('character-desc').textContent = def.description;
    const btn = $('character-action');
    const selected = save.selectedCharacter === def.id;
    btn.textContent = selected ? 'ВЫБРАН ✓' : 'ВЫБРАТЬ';
    btn.classList.toggle('disabled', selected);
  }
  _characterAction() {
    const def = CHARACTERS[this.characterIdx];
    if (this.h.getSave().selectedCharacter !== def.id && this.h.selectCharacter) this.h.selectCharacter(def.id);
    this.syncCharacter(this.h.getSave());
  }
  characterStatus(text) { $('character-status').textContent = text; }
  setOnFoot(onFoot) {
    document.body.classList.toggle('on-foot', onFoot);
    $('vehicle-action').innerHTML = onFoot ? 'СЕСТЬ<br><span>В МАШИНУ</span>' : 'ВЫЙТИ<br><span>ИЗ МАШИНЫ</span>';
    $('vehicle-action').setAttribute('aria-label', onFoot ? 'Сесть в свою машину' : 'Выйти из машины');
    $('btn-reset').setAttribute('aria-label', onFoot ? 'Вернуться к машине' : 'Вернуть на дорогу');
  }

  // -------------------------------------------------------------- ГАРАЖ ---
  openGarage(save) {
    this.garageIdx = Math.max(0, CARS.findIndex(c => c.id === save.activeCar));
    this.syncGarage(save);
    this.show('garage');
  }

  garageStep(d) {
    this.garageIdx = (this.garageIdx + d + CARS.length) % CARS.length;
    this.syncGarage(this.h.getSave());
    this.h.previewCar && this.h.previewCar(CARS[this.garageIdx].id);
  }

  syncGarage(save) {
    const def = CARS[this.garageIdx];
    const st = this.carStats[this.garageIdx];
    $('garage-money').textContent = '$ ' + fmt(save.money);
    $('car-name').textContent = def.name;
    $('car-desc').textContent = def.desc;
    const P = def.physics;
    const speedN = (def.topSpeed - 38) / (66 - 38);
    const accelN = (6.0 - st.t100) / (6.0 - 2.2);
    const handN = ((P.latAccelGrip || 21) - 17) / (25 - 17) * 0.7 + ((P.steerSpeedMax || 0.52) - 0.45) / 0.15 * 0.3;
    const driftN = 1 - ((P.gripLateral || 10) - 7) / 6;
    const pct = (x) => Math.round(Math.max(0.06, Math.min(1, x)) * 100) + '%';
    $('bar-speed').style.width = pct(speedN);
    $('bar-accel').style.width = pct(accelN);
    $('bar-handling').style.width = pct(handN);
    $('bar-drift').style.width = pct(driftN);
    $('val-speed').textContent = st.kmh + ' км/ч';
    $('val-accel').textContent = st.t100.toFixed(1) + ' с';

    const btn = $('car-action');
    btn.classList.remove('primary', 'locked', 'disabled');
    const owned = save.ownedCars.includes(def.id);
    if (owned && save.activeCar === def.id) {
      btn.textContent = 'ВЫБРАНА ✓';
      btn.classList.add('disabled');
    } else if (owned) {
      btn.textContent = 'ВЫБРАТЬ';
      btn.classList.add('primary');
    } else if (save.money >= def.unlockCost) {
      btn.textContent = 'КУПИТЬ  $ ' + fmt(def.unlockCost);
      btn.classList.add('locked');
    } else {
      btn.textContent = 'НЕ ХВАТАЕТ $ ' + fmt(def.unlockCost - save.money);
      btn.classList.add('disabled');
    }
  }

  _garageAction() {
    const save = this.h.getSave();
    const def = CARS[this.garageIdx];
    const owned = save.ownedCars.includes(def.id);
    if (owned && save.activeCar !== def.id) this.h.selectCar(def.id);
    else if (!owned && save.money >= def.unlockCost) this.h.buyCar(def.id);
    this.syncGarage(this.h.getSave());
  }

  // ---------------------------------------------------------------- ТОСТ ---
  toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('hidden');
    void t.offsetWidth;                 // перезапуск CSS-анимации
    t.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 3300);
  }

  hint(text) {
    const el = $('hint');
    if (!text) { if (this._last.hint) { el.classList.add('hidden'); this._last.hint = ''; } return; }
    if (this._last.hint === text) return;
    this._last.hint = text;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  flashHit(strength) {
    this.hitFlash = Math.max(this.hitFlash, Math.min(0.85, strength));
  }

  // ----------------------------------------------------------------- HUD ---
  /**
   * s: {car, def, g, money, nearest, camYaw, fpsText, dt}
   */
  updateHud(s) {
    const L = this._last;
    // эффекты — каждый кадр (дёшево: одна CSS-переменная / opacity)
    if (this.hitFlash > 0.001) {
      this.hitFlash = Math.max(0, this.hitFlash - s.dt * 2.8);
      this.fxHit.style.opacity = this.hitFlash.toFixed(3);
    } else if (L.hitOn) {
      this.fxHit.style.opacity = '0';
    }
    L.hitOn = this.hitFlash > 0.001;

    this._popups(s.g);

    this._hudT += s.dt;
    if (this._hudT >= 0.05) {
      this._hudT = 0;
      const car = s.car, g = s.g;
      const kmh = Math.round(Math.abs(car.speed) * MS_TO_KMH);
      if (kmh !== L.kmh) {
        L.kmh = kmh;
        $('speed-num').textContent = kmh;
        $('speed-fill').style.width = Math.min(100, Math.abs(car.speed) / s.def.topSpeed * 100).toFixed(1) + '%';
        const spd = Math.max(0, Math.min(1, (kmh - 95) / 110));
        const op = spd * 0.55;                          // прямо в opacity: без пересчёта стилей всего документа
        if (Math.abs(op - (this._spdOp || 0)) > 0.02) { this._spdOp = op; this.fxSpeed.style.opacity = op.toFixed(3); }
      }
      const money = Math.floor(s.money);
      if (money !== L.money) { L.money = money; $('money').textContent = '$ ' + fmt(money); }
      const score = Math.round(g.score);
      if (score !== L.score) { L.score = score; $('score').textContent = fmt(score) + ' очк.'; }

      const chainOn = g.chain > 0;
      if (chainOn !== L.chainOn) { L.chainOn = chainOn; $('chain').classList.toggle('hidden', !chainOn); }
      if (chainOn) {
        if (g.combo !== L.combo) { L.combo = g.combo; $('chain-mult').textContent = 'x' + g.combo; }
        const txt = 'цепочка ' + g.chain + ' · ' + g.timeLeft.toFixed(1) + ' с';
        if (txt !== L.chainTxt) { L.chainTxt = txt; $('chain-count').textContent = txt; }
        const fill = Math.min(1, g.timeLeft / CONFIG.gameplay.checkpointTime);
        $('chain-fill').style.width = (fill * 100).toFixed(1) + '%';
        const low = g.timeLeft < 4;
        if (low !== L.low) { L.low = low; $('chain').classList.toggle('low', low); }
      }
      const cpTxt = s.onFoot ? 'ЧЕКПОИНТЫ — НА МАШИНЕ' : s.nearest ? 'ЧЕКПОИНТ ' + Math.round(s.nearest.dist) + ' м' : '';
      if (cpTxt !== L.cpTxt) { L.cpTxt = cpTxt; $('cp-dist').textContent = cpTxt; }

      const d = g.drift;
      const driftOn = d.active && d.points >= 5;
      if (driftOn !== L.driftOn) { L.driftOn = driftOn; $('drift-live').classList.toggle('hidden', !driftOn); }
      if (driftOn) {
        const pts = fmt(d.points * g.combo);
        if (pts !== L.driftPts) { L.driftPts = pts; $('drift-pts').textContent = pts; }
      }
      if (s.fpsText && s.fpsText !== L.fpsText) { L.fpsText = s.fpsText; $('fps').textContent = s.fpsText; }
    }

    this._mapT += s.dt;
    if (this._mapT >= 1 / 30) {
      this._mapT = 0;
      this.drawMinimap(s.car, s.g.checkpoints, s.camYaw);
    }
  }

  _popups(g) {
    const box = $('popups');
    for (const e of g.events) {
      if (this._seen.has(e)) continue;
      this._seen.add(e);
      const div = document.createElement('div');
      div.className = 'popup ' + e.type;
      div.textContent = e.text;
      if (e.value && e.type !== 'chainend') {
        const b = document.createElement('b');
        b.textContent = '+' + fmt(e.value);
        div.appendChild(b);
      }
      box.appendChild(div);
      while (box.children.length > 3) box.removeChild(box.firstChild);
      setTimeout(() => div.remove(), 1700);
    }
  }

  popup(type, text) {
    this._popups({ events: [{ type, text, value: 0 }] });
  }

  // ------------------------------------------------------------ МИНИКАРТА --
  buildMinimap(city) {
    const pad = 40;
    const lo = city.roadAt(0) - city.road / 2 - pad;
    const hi = city.roadAt(city.grid) + city.road / 2 + pad;
    const size = Math.ceil(hi - lo);           // 1 px = 1 м
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#141925';
    g.fillRect(0, 0, size, size);
    for (const b of city.blocks) {
      g.fillStyle = b.type === 'park' ? '#1f3a26' : b.type === 'perimeter' ? '#1a1f2c' : '#252c3b';
      g.fillRect(b.minX - lo, b.minZ - lo, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    g.fillStyle = '#6a7388';
    const r0 = city.roadAt(0) - city.road / 2, r1 = city.roadAt(city.grid) + city.road / 2;
    for (let i = 0; i <= city.grid; i++) {
      const rc = city.roadAt(i) - city.road / 2;
      g.fillRect(rc - lo, r0 - lo, city.road, r1 - r0);
      g.fillRect(r0 - lo, rc - lo, r1 - r0, city.road);
    }
    this.mapBase = c;
    this.mapLo = lo;
    this.mapCtx = $('minimap').getContext('2d');
  }

  drawMinimap(car, checkpoints, camYaw) {
    const ctx = this.mapCtx;
    if (!ctx) return;
    const W = ctx.canvas.width, R = W / 2;
    const viewR = 150;                      // радиус обзора, м
    const k = R / viewR;
    const rot = -Math.PI / 2 - camYaw;     // «вперёд» = вверх
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(R, R);
    ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.drawImage(this.mapBase, -(car.x - this.mapLo), -(car.z - this.mapLo));
    ctx.restore();

    // чекпоинты: внутри — точка, за краем — стрелка на кромке
    const cs = Math.cos(rot), sn = Math.sin(rot);
    for (const cp of checkpoints) {
      const dx = cp.x - car.x, dz = cp.z - car.z;
      let sx = (dx * cs - dz * sn) * k, sy = (dx * sn + dz * cs) * k;
      const d = Math.hypot(sx, sy);
      ctx.fillStyle = '#3ae6ff';
      if (d < R - 14) {
        ctx.beginPath();
        ctx.arc(R + sx, R + sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        const ux = sx / d, uy = sy / d;
        const ex = R + ux * (R - 12), ey = R + uy * (R - 12);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.atan2(uy, ux));
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(-6, -8); ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // игрок — стрелка в центре, повёрнута относительно курса камеры
    const rel = car.heading - camYaw;
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(rel);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ff6a3d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -13); ctx.lineTo(9, 10); ctx.lineTo(0, 5); ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}
