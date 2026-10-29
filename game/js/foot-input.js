// Стик слева, свободная камера свайпом справа, отдельная кнопка бега.
// Pointer Events дают независимые пальцы; cancel/пауза всегда снимают ввод.
export class FootInput {
  constructor(root) {
    this.root = root;
    this.active = false;
    this.keys = new Set();
    this.stickId = null; this.lookId = null; this.runId = null;
    this.stick = { x: 0, y: 0 }; this.origin = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 }; this.lastLook = { x: 0, y: 0 };
    this.radius = 60; this.onFirstTouch = null;
    this.el = document.createElement('div');
    this.el.className = 'foot-controls'; this.el.hidden = true;
    this.el.innerHTML = `
      <div class="foot-stick-zone" data-foot="stick"></div>
      <div class="foot-stick-ghost">ДВИЖЕНИЕ</div>
      <div class="stick foot-stick" hidden><div class="stick-base"></div><div class="stick-knob"></div></div>
      <div class="foot-look-zone" data-foot="look" aria-label="Камера: проведите пальцем"></div>
      <button class="btn foot-run" data-foot="run" aria-label="Бег, удерживайте">БЕГ</button>`;
    root.appendChild(this.el);
    this.zone = this.el.querySelector('[data-foot="stick"]');
    this.stickEl = this.el.querySelector('.foot-stick');
    this.knobEl = this.el.querySelector('.stick-knob');
    this.ghost = this.el.querySelector('.foot-stick-ghost');
    this.lookZone = this.el.querySelector('[data-foot="look"]');
    this.runButton = this.el.querySelector('[data-foot="run"]');
    this._bind();
  }
  setActive(active) {
    this.releaseAll();
    this.active = !!active;
    this.el.hidden = !active;
  }
  _touch() { if (this.onFirstTouch) this.onFirstTouch(); }
  _bind() {
    this.zone.addEventListener('pointerdown', e => {
      if (!this.active || this.stickId !== null) return;
      this.stickId = e.pointerId; this.origin.x = e.clientX; this.origin.y = e.clientY;
      this.stick.x = this.stick.y = 0; this.stickEl.hidden = false; this.ghost.hidden = true;
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      this.knobEl.style.transform = 'translate(-50%, -50%)';
      try { this.zone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._touch(); e.preventDefault();
    }, { passive: false });
    this.zone.addEventListener('pointermove', e => {
      if (e.pointerId !== this.stickId) return;
      let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
      const len = Math.hypot(dx, dy);
      if (len > this.radius) { dx *= this.radius / len; dy *= this.radius / len; }
      this.stick.x = dx / this.radius; this.stick.y = -dy / this.radius;
      this.knobEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      e.preventDefault();
    }, { passive: false });
    const endStick = e => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null; this.stick.x = this.stick.y = 0; this.stickEl.hidden = true;
    };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.zone.addEventListener(name, endStick);

    this.lookZone.addEventListener('pointerdown', e => {
      if (!this.active || this.lookId !== null) return;
      this.lookId = e.pointerId; this.lastLook.x = e.clientX; this.lastLook.y = e.clientY;
      try { this.lookZone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._touch(); e.preventDefault();
    }, { passive: false });
    this.lookZone.addEventListener('pointermove', e => {
      if (e.pointerId !== this.lookId) return;
      this.look.x += e.clientX - this.lastLook.x; this.look.y += e.clientY - this.lastLook.y;
      this.lastLook.x = e.clientX; this.lastLook.y = e.clientY;
      e.preventDefault();
    }, { passive: false });
    const endLook = e => { if (e.pointerId === this.lookId) this.lookId = null; };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.lookZone.addEventListener(name, endLook);

    this.runButton.addEventListener('pointerdown', e => {
      if (!this.active || this.runId !== null) return;
      this.runId = e.pointerId; this.runButton.classList.add('active');
      try { this.runButton.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._touch(); e.preventDefault();
    }, { passive: false });
    const endRun = e => {
      if (e.pointerId !== this.runId) return;
      this.runId = null; this.runButton.classList.remove('active');
    };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.runButton.addEventListener(name, endRun);
    window.addEventListener('keydown', e => {
      if (!this.active) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
  }
  releaseAll() {
    this.keys.clear(); this.stickId = this.lookId = this.runId = null;
    this.stick.x = this.stick.y = this.look.x = this.look.y = 0;
    if (this.stickEl) this.stickEl.hidden = true;
    if (this.runButton) this.runButton.classList.remove('active');
  }
  sample() {
    const k = this.keys;
    let x = this.stick.x, y = this.stick.y;
    if (Math.hypot(x, y) < 0.12) x = y = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
    const len = Math.hypot(x, y); if (len > 1) { x /= len; y /= len; }
    const out = { x, y, reset: k.has('KeyR'), run: this.runId !== null || k.has('ShiftLeft') || k.has('ShiftRight'),
      lookX: this.look.x, lookY: this.look.y };
    this.look.x = this.look.y = 0;
    return out;
  }
}
