// ============================================================================
//  INPUT — сенсорное управление для телефона + клавиатура для отладки на ПК.
//
//  Схема (альбом):
//   СЛЕВА  — РУЛЬ. По умолчанию две большие стрелки ◀ ▶ (зона-разделитель:
//            сторону решает половина зоны, где палец, — промахнуться нельзя,
//            палец можно катать между стрелками, не отрывая).
//            Опция в настройках — плавающий стик (как раньше).
//   СПРАВА — ГАЗ (крупная), ТОРМОЗ (левее), РУЧНИК (над газом).
//            Палец можно перекатывать между кнопками: газ → ручник → газ.
//
//  Стрелки — цифровой ввод, поэтому руль нарастает плавно: короткое касание —
//  лёгкое подруливание, удержание — полный выворот за ~0.18 с; возврат в центр
//  быстрее (~0.09 с). «Чувствительность руля» меняет скорость нарастания.
//  touch-action:none — иначе браузер начнёт скроллить.
// ============================================================================

const SENS_RADIUS = { low: 74, mid: 60, high: 48 };
// время (с) до полного выворота / возврата в центр для стрелок и клавиатуры
const RAMP_TIME = { low: 0.30, mid: 0.18, high: 0.11 };
const RETURN_TIME = { low: 0.12, mid: 0.09, high: 0.07 };

const ARROW_SVG = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

export class TouchInput {
  constructor(root, opts = {}) {
    this.root = root;
    this.state = { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, cam: false };

    this.steerMode = opts.steerMode === 'stick' ? 'stick' : 'arrows';
    this.sens = RAMP_TIME[opts.steerSens] ? opts.steerSens : 'mid';

    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.stickVec = { x: 0, y: 0 };
    this.RADIUS = SENS_RADIUS[this.sens];
    this.DEADZONE = 0.10;
    this.stickPedals = !!opts.stickPedals;
    this.lookId = null; this.lookDelta = { x: 0, y: 0 }; this.lookLast = { x: 0, y: 0 };
    this.everTouched = false;
    this.onFirstTouch = null;

    // стрелки: pointerId → -1 (◀) | 1 (▶)
    this.arrowPointers = new Map();
    this.arrowOn = { left: false, right: false };
    this.digSteer = 0;          // сглаженный цифровой руль (стрелки + клавиатура)
    this._lastT = 0;

    this.keys = new Set();
    // pointerId → 'gas' | 'brake' | 'hand' (палец может переезжать между кнопками)
    this.padPointers = new Map();
    this.btnEls = {};

    this._build();
    this._bindStick();
    this._bindArrows();
    this._bindButtons();
    this._bindLook();
    this._bindKeyboard();
    this.setOptions(opts);
  }

  setOptions({ steerSens, stickPedals, steerMode } = {}) {
    if (steerSens && RAMP_TIME[steerSens]) { this.sens = steerSens; this.RADIUS = SENS_RADIUS[steerSens]; }
    if (stickPedals !== undefined) this.stickPedals = !!stickPedals;
    if (steerMode) {
      const m = steerMode === 'stick' ? 'stick' : 'arrows';
      if (m !== this.steerMode) this.releaseAll();
      this.steerMode = m;
    }
    const base = this.stickEl.querySelector('.stick-base');
    const d = Math.round(this.RADIUS * 2 + 10);
    base.style.width = base.style.height = d + 'px';
    base.style.left = base.style.top = (-d / 2) + 'px';
    const arrows = this.steerMode === 'arrows';
    this.arrowZone.hidden = !arrows;
    this.zone.hidden = arrows;
    this.ghostEl.hidden = arrows || this.everTouched;
  }

  _build() {
    const d = document.createElement('div');
    d.className = 'controls';
    d.innerHTML = `
      <div class="stick-zone" data-zone="stick"></div>
      <div class="stick-ghost" data-el="ghost">РУЛЬ</div>
      <div class="stick" data-el="stick" hidden>
        <div class="stick-base"></div>
        <div class="stick-knob" data-el="knob"></div>
      </div>
      <div class="arrow-zone" data-zone="arrows">
        <div class="arrow-btn" data-arrow="left">${ARROW_SVG('M15.5 4.5 L6.5 12 L15.5 19.5 Z')}</div>
        <div class="arrow-btn" data-arrow="right">${ARROW_SVG('M8.5 4.5 L17.5 12 L8.5 19.5 Z')}</div>
      </div>
      <div class="drive-look-zone" data-zone="look" aria-label="Камера: проведите пальцем"></div>
      <div class="pad">
        <button class="btn btn-hand" data-btn="hand">РУЧНИК</button>
        <button class="btn btn-brake" data-btn="brake">ТОРМОЗ</button>
        <button class="btn btn-gas" data-btn="gas">ГАЗ</button>
      </div>
    `;
    this.root.appendChild(d);
    this.controlsEl = d;
    this.zone = d.querySelector('[data-zone="stick"]');
    this.stickEl = d.querySelector('[data-el="stick"]');
    this.knobEl = d.querySelector('[data-el="knob"]');
    this.ghostEl = d.querySelector('[data-el="ghost"]');
    this.arrowZone = d.querySelector('[data-zone="arrows"]');
    this.lookZone = d.querySelector('[data-zone="look"]');
    this.arrowEls = {
      left: d.querySelector('[data-arrow="left"]'),
      right: d.querySelector('[data-arrow="right"]'),
    };
    for (const name of ['gas', 'brake', 'hand']) this.btnEls[name] = d.querySelector(`[data-btn="${name}"]`);
  }

  setActive(active) {
    this.releaseAll();
    this.controlsEl.hidden = !active;
  }

  _firstTouch() {
    if (this.everTouched) return;
    this.everTouched = true;
    this.ghostEl.hidden = true;
    if (this.onFirstTouch) this.onFirstTouch();
  }

  // ------------------------------------------------------------- стрелки --
  _arrowSide(e) {
    // граница — середина между кнопками (а не край зоны): так обе половины честные
    const l = this.arrowEls.left.getBoundingClientRect();
    const r = this.arrowEls.right.getBoundingClientRect();
    const mid = (l.right + r.left) / 2;
    return e.clientX < mid ? -1 : 1;
  }

  _refreshArrows() {
    let left = false, right = false;
    for (const s of this.arrowPointers.values()) { if (s < 0) left = true; else right = true; }
    if (left !== this.arrowOn.left) this.arrowEls.left.classList.toggle('active', left);
    if (right !== this.arrowOn.right) this.arrowEls.right.classList.toggle('active', right);
    this.arrowOn.left = left;
    this.arrowOn.right = right;
  }

  _bindArrows() {
    const zone = this.arrowZone;
    zone.addEventListener('pointerdown', (e) => {
      this.arrowPointers.set(e.pointerId, this._arrowSide(e));
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* старые браузеры */ }
      this._firstTouch();
      this._refreshArrows();
      e.preventDefault();
    }, { passive: false });
    zone.addEventListener('pointermove', (e) => {
      if (!this.arrowPointers.has(e.pointerId)) return;
      const s = this._arrowSide(e);
      if (s !== this.arrowPointers.get(e.pointerId)) {
        this.arrowPointers.set(e.pointerId, s);
        this._refreshArrows();
      }
      e.preventDefault();
    }, { passive: false });
    const off = (e) => {
      if (!this.arrowPointers.has(e.pointerId)) return;
      this.arrowPointers.delete(e.pointerId);
      this._refreshArrows();
    };
    zone.addEventListener('pointerup', off);
    zone.addEventListener('pointercancel', off);
    zone.addEventListener('lostpointercapture', off);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------- стик --
  _bindStick() {
    const zone = this.zone;
    zone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      this.stickOrigin.x = e.clientX;
      this.stickOrigin.y = e.clientY;
      this.stickVec.x = 0; this.stickVec.y = 0;
      this.stickEl.hidden = false;
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knobEl.style.transform = 'translate(-50%, -50%)';
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* старые браузеры */ }
      this._firstTouch();
      e.preventDefault();
    }, { passive: false });

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      if (!this.stickPedals) dy *= 0.25;            // ось Y почти не нужна — ручка «катается» по горизонтали
      const len = Math.hypot(dx, dy);
      if (len > this.RADIUS) { dx = dx / len * this.RADIUS; dy = dy / len * this.RADIUS; }
      this.stickVec.x = dx / this.RADIUS;
      this.stickVec.y = dy / this.RADIUS;
      this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      e.preventDefault();
    }, { passive: false });

    const end = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stickVec.x = 0; this.stickVec.y = 0;
      this.stickEl.hidden = true;
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
  }

  // ------------------------------------------------------------- педали --
  _btnAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !el.dataset) return null;
    return el.dataset.btn || null;
  }

  _refreshButtons() {
    const on = { gas: false, brake: false, hand: false };
    for (const b of this.padPointers.values()) if (b) on[b] = true;
    for (const name in on) this.btnEls[name].classList.toggle('active', on[name]);
    this.btnOn = on;
  }

  _bindButtons() {
    this.btnOn = { gas: false, brake: false, hand: false };
    for (const name of ['gas', 'brake', 'hand']) {
      const el = this.btnEls[name];
      el.addEventListener('pointerdown', (e) => {
        this.padPointers.set(e.pointerId, name);
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        this._firstTouch();
        this._refreshButtons();
        e.preventDefault();
      }, { passive: false });
      el.addEventListener('pointermove', (e) => {
        if (!this.padPointers.has(e.pointerId)) return;
        // перекат пальца на соседнюю кнопку; в щели между кнопками — держим прежнюю
        const b = this._btnAt(e.clientX, e.clientY);
        if (b && b !== this.padPointers.get(e.pointerId)) {
          this.padPointers.set(e.pointerId, b);
          this._refreshButtons();
        }
        e.preventDefault();
      }, { passive: false });
      const off = (e) => {
        if (!this.padPointers.has(e.pointerId)) return;
        this.padPointers.delete(e.pointerId);
        this._refreshButtons();
      };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('lostpointercapture', off);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  // В машине камера также вращается свайпом по свободной правой части экрана;
  // педали находятся поверх этой зоны и продолжают работать независимо.
  _bindLook() {
    const zone = this.lookZone;
    zone.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId; this.lookLast.x = e.clientX; this.lookLast.y = e.clientY;
      try { zone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._firstTouch(); e.preventDefault();
    }, { passive: false });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.lookDelta.x += e.clientX - this.lookLast.x; this.lookDelta.y += e.clientY - this.lookLast.y;
      this.lookLast.x = e.clientX; this.lookLast.y = e.clientY;
      e.preventDefault();
    }, { passive: false });
    const off = (e) => { if (e.pointerId === this.lookId) this.lookId = null; };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) zone.addEventListener(event, off);
  }

  _bindKeyboard() {
    const down = (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    const up = (e) => this.keys.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.releaseAll());
  }

  /** Сброс всего (пауза, сворачивание вкладки): ничего не должно «залипнуть» */
  releaseAll() {
    this.keys.clear();
    this.padPointers.clear();
    this.arrowPointers.clear();
    this.digSteer = 0;
    this._lastT = 0;
    this.stickId = null;
    this.lookId = null; this.lookDelta.x = this.lookDelta.y = 0;
    this.stickVec.x = 0; this.stickVec.y = 0;
    if (this.stickEl) this.stickEl.hidden = true;
    if (this.arrowEls) this._refreshArrows();
    if (this.btnEls.gas) this._refreshButtons();
  }

  /** Сглаженный цифровой руль: нарастание за RAMP_TIME, возврат/перекладка за RETURN_TIME */
  _digitalSteer(target) {
    const now = performance.now();
    // время реальное: при просадке кадров руль не «вязнет» (палец держали — значит, держали)
    const dt = this._lastT ? Math.min(0.25, Math.max(0, (now - this._lastT) / 1000)) : 0;
    this._lastT = now;
    const cur = this.digSteer;
    const back = target === 0 || cur * target < 0;      // отпустили или перекладываем в другую сторону
    const step = dt / (back ? RETURN_TIME[this.sens] : RAMP_TIME[this.sens]);
    if (cur < target) this.digSteer = Math.min(target, cur + step);
    else if (cur > target) this.digSteer = Math.max(target, cur - step);
    return this.digSteer;
  }

  /** Собирает итоговое состояние ввода из всех источников */
  sample() {
    const k = this.keys;
    const s = this.state;

    // --- руль: стрелки/клавиатура (плавно) + стик (мёртвая зона + экспонента)
    let target = 0;
    if (this.arrowOn.left || k.has('ArrowLeft') || k.has('KeyA')) target -= 1;
    if (this.arrowOn.right || k.has('ArrowRight') || k.has('KeyD')) target += 1;
    let steer = this._digitalSteer(target);
    const mx = Math.abs(this.stickVec.x);
    if (mx > this.DEADZONE) {
      const m = (mx - this.DEADZONE) / (1 - this.DEADZONE);
      steer += Math.sign(this.stickVec.x) * (0.4 * m + 0.6 * m * m);
    }
    s.steer = Math.max(-1, Math.min(1, steer));

    // --- педали
    let throttle = 0, brake = 0;
    if (this.stickPedals && this.steerMode === 'stick') {
      const sy = -this.stickVec.y;                 // вверх = газ
      const dz = 0.25;
      if (sy > dz) throttle = (sy - dz) / (1 - dz);
      else if (sy < -dz) brake = (-sy - dz) / (1 - dz);
    }
    if (this.btnOn.gas || k.has('ArrowUp') || k.has('KeyW')) throttle = 1;
    if (this.btnOn.brake || k.has('ArrowDown') || k.has('KeyS')) brake = 1;
    s.throttle = Math.min(1, throttle);
    s.brake = Math.min(1, brake);
    s.handbrake = this.btnOn.hand || k.has('Space');
    s.reset = k.has('KeyR');
    s.lookX = this.lookDelta.x; s.lookY = this.lookDelta.y;
    this.lookDelta.x = this.lookDelta.y = 0;
    return s;
  }
}
