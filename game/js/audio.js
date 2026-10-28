// ============================================================================
//  AUDIO — весь звук синтезируется WebAudio в рантайме.
//  Ноль аудиофайлов → нулевой вес, нулевая задержка, работает офлайн.
//
//  Движок: две расстроенные пилы через lowpass → тембр зависит от оборотов.
//  Занос: зацикленный белый шум через bandpass, громкость = сила скольжения.
//  Удар: короткий шумовой всплеск с быстрым затуханием.
// ============================================================================

export class AudioEngine {
  // пороги передач как доля максималки (6 передач)
  static GEARS = [0, 0.16, 0.31, 0.47, 0.64, 0.82, 1.02];

  constructor() {
    this.enabled = true;
    this.ready = false;
    this.ctx = null;
  }

  /** Должно вызываться из обработчика жеста пользователя (политика браузера) */
  init() {
    if (this.ready) { this.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      return false;
    }
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // ------------------------------------------------ ДВИГОК -----------
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.0;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 700;
    this.engFilter.Q.value = 3.5;
    this.engGain.connect(this.engFilter);
    this.engFilter.connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc1.frequency.value = 60;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.frequency.value = 90;
    this.osc3 = ctx.createOscillator();
    this.osc3.type = 'sawtooth';
    this.osc3.frequency.value = 30;

    const g1 = ctx.createGain(); g1.gain.value = 0.55;
    const g2 = ctx.createGain(); g2.gain.value = 0.22;
    const g3 = ctx.createGain(); g3.gain.value = 0.35;
    this.osc1.connect(g1); g1.connect(this.engGain);
    this.osc2.connect(g2); g2.connect(this.engGain);
    this.osc3.connect(g3); g3.connect(this.engGain);
    this.osc1.start(); this.osc2.start(); this.osc3.start();

    // ------------------------------------------------ ШУМ (занос/удар) --
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = buf;
    this.skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1500;
    this.skidFilter.Q.value = 1.1;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.master);
    this.skidSrc.start();

    // ветер на скорости
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = buf;
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 420;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    this.ready = true;
    this.resume();
    return true;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Пауза / свёрнутая вкладка: полностью глушим контекст (экономия батареи) */
  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ready) this.master.gain.value = on ? 0.85 : 0.0;
  }

  /**
   * Каждый кадр. car: {speed, throttle, drifting, lateral, topSpeed}
   */
  update(car, dt) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const absSpeed = Math.abs(car.speed);
    // --- имитация 6-ступенчатой КПП: обороты растут внутри передачи и падают при переключении
    const G = AudioEngine.GEARS;
    const f = Math.min(1, absSpeed / Math.max(1, car.topSpeed));
    let gi = this.gear || 0;
    if (gi < G.length - 2 && f > G[gi + 1] + 0.01) { gi++; this.shiftT = 0.09; }        // вверх
    else if (gi > 0 && f < G[gi] - 0.035) gi--;                                         // вниз (гистерезис)
    this.gear = gi;
    const lo = G[gi], hi = G[gi + 1];
    let rpm = 0.30 + 0.70 * Math.min(1, Math.max(0, (f - lo) / (hi - lo)));
    if (absSpeed < 1.5) rpm = 0.16 + 0.42 * car.throttle;                               // холостые / перегазовка
    else if (car.throttle < 0.1) rpm *= 0.9;                                           // сброс газа
    if (car.drifting && car.throttle > 0.5) rpm = Math.min(1, rpm + 0.12);              // в заносе колёса крутятся быстрее
    this.rpm = this.rpm === undefined ? rpm : this.rpm + (rpm - this.rpm) * Math.min(1, dt * 14);
    const base = 38 + this.rpm * 165;
    this.shiftT = Math.max(0, (this.shiftT || 0) - dt);
    const cut = this.shiftT > 0 ? 0.35 : 1.0;                                          // отсечка на переключении

    this.osc1.frequency.setTargetAtTime(base, t, 0.03);
    this.osc2.frequency.setTargetAtTime(base * 1.5, t, 0.03);
    this.osc3.frequency.setTargetAtTime(base * 0.5, t, 0.04);
    this.engFilter.frequency.setTargetAtTime(380 + this.rpm * 2100 + car.throttle * 400, t, 0.05);
    this.engGain.gain.setTargetAtTime((0.08 + car.throttle * 0.14 + this.rpm * 0.06) * cut, t, 0.03);

    // занос
    const slip = Math.min(1, Math.abs(car.lateral || 0) / 14);
    const skid = (car.drifting ? 0.05 + slip * 0.20 : 0);
    this.skidGain.gain.setTargetAtTime(skid, t, 0.05);
    this.skidFilter.frequency.setTargetAtTime(1100 + slip * 1400, t, 0.08);

    // ветер
    const w = Math.min(1, absSpeed / 45);
    this.windGain.gain.setTargetAtTime(w * w * 0.075, t, 0.15);
  }

  impact(strength) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = Math.min(1, strength / 14);
    if (s < 0.04) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(160, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * s + 0.05, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30 + s * 0.2);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
    src.stop(t + 0.6);

    // низкий «бум»
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.3 * s, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.35);
  }

  blip(freq = 880, dur = 0.09, type = 'sine', vol = 0.16) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  checkpoint(combo) {
    this.blip(660 + combo * 55, 0.10, 'triangle', 0.16);
    setTimeout(() => this.blip(990 + combo * 70, 0.12, 'triangle', 0.12), 70);
  }

  money() { this.blip(1320, 0.06, 'sine', 0.08); }
  ui() { this.blip(520, 0.05, 'square', 0.07); }
  unlock() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.blip(f, 0.16, 'triangle', 0.14), i * 110));
  }
}

export const audio = new AudioEngine();
