// Стенд: прогоняет каждую машину через типовые манёвры и печатает метрики.
// Запуск: node tests/physics-sim.mjs
import { CARS } from '../js/cars.js';
import { CONFIG } from '../js/config.js';
import { makeCarState, stepCar, wrapAngle } from '../js/car-physics.js';

const DT = CONFIG.physics.dt;
const KMH = 3.6;

function run(def, setup, inputFn, maxT, stopFn) {
  const car = makeCarState(def, 0, 0, 0);
  setup && setup(car);
  let t = 0;
  const log = [];
  while (t < maxT) {
    const inp = inputFn(t, car);
    stepCar(car, def, inp, DT, { onRoad: true });
    t += DT;
    log.push({ t, v: Math.hypot(car.vx, car.vz), car: { ...car } });
    if (stopFn && stopFn(t, car)) break;
  }
  return { car, t, log };
}

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

for (const def of CARS) {
  def._dragK = undefined;
  const top = def.topSpeed;
  const rows = [];

  // 1) 0-100 км/ч
  let r = run(def, null, () => ({ throttle: 1 }), 30, (t, c) => Math.hypot(c.vx, c.vz) * KMH >= 100);
  rows.push(['0-100 км/ч, с', fmt(r.t)]);

  // 2) время до 95% максималки и фактическая максималка за 40 с
  r = run(def, null, () => ({ throttle: 1 }), 40);
  const t95 = r.log.find(e => e.v >= top * 0.95);
  rows.push(['до 95% макс., с', t95 ? fmt(t95.t, 1) : 'не достигает']);
  rows.push(['макс. за 40 с, км/ч', fmt(r.log[r.log.length - 1].v * KMH, 0) + ' / ' + fmt(top * KMH, 0)]);

  // 3) тормозной путь 100→0
  r = run(def, c => { c.vx = 100 / KMH; }, () => ({ brake: 1 }), 10, (t, c) => c.vx <= 0.01 || c.speed <= 0.01);
  rows.push(['торможение 100→0: с / м', fmt(r.t) + ' / ' + fmt(r.car.x, 1)]);

  // 4) накат со 100 км/ч за 3 с
  r = run(def, c => { c.vx = 100 / KMH; }, () => ({}), 3);
  rows.push(['накат 3 с со 100, км/ч', fmt(r.log[r.log.length - 1].v * KMH, 0)]);

  // 5) радиус поворота на полном руле при разных скоростях (газ держит скорость)
  for (const kmh of [15, 50, 90, 140]) {
    const v0 = kmh / KMH;
    r = run(def, c => { c.vx = v0; }, (t, c) => ({
      steer: 1, throttle: Math.hypot(c.vx, c.vz) < v0 ? 1 : 0,
    }), 6);
    // радиус по последним 2 секундам: R = v / omega
    const tail = r.log.slice(-240);
    const omega = tail.reduce((s, e) => s + e.car.yawRate, 0) / tail.length;
    const vAvg = tail.reduce((s, e) => s + e.v, 0) / tail.length;
    const slipDeg = tail.reduce((s, e) => s + Math.abs(e.car.slip), 0) / tail.length * 57.3;
    const drift = tail.filter(e => e.car.drifting).length / tail.length;
    rows.push([`руль 100% @${kmh}: R м / v км/ч / скольж.° / занос`,
      `${fmt(vAvg / Math.max(1e-6, Math.abs(omega)), 1)} / ${fmt(vAvg * KMH, 0)} / ${fmt(slipDeg, 1)} / ${fmt(drift * 100, 0)}%`]);
  }

  // 6) дрифт на ручнике: вход на 90 км/ч, 0.6 с ручник+руль, дальше руль+газ
  {
    const v0 = 90 / KMH;
    r = run(def, c => { c.vx = v0; }, (t) => ({
      steer: t < 2.2 ? 1 : 0, throttle: 1, handbrake: t < 0.6,
    }), 4);
    const turned = r.log.find(e => Math.abs(wrapAngle(e.car.heading)) >= Math.PI / 2);
    const maxSlip = Math.max(...r.log.map(e => Math.abs(e.car.slip))) * 57.3;
    const driftT = r.log.filter(e => e.car.drifting).length * DT;
    const exitV = r.log[r.log.length - 1].v * KMH;
    const at90 = turned ? `${fmt(turned.t, 2)} с, v=${fmt(turned.v * KMH, 0)}` : 'не довернул';
    rows.push(['ручник-дрифт @90: поворот 90°', at90]);
    rows.push(['   макс.скольж.° / в заносе с / скорость в конце', `${fmt(maxSlip, 0)} / ${fmt(driftT, 2)} / ${fmt(exitV, 0)}`]);
    // смещение траектории: где машина, когда кузов повернулся на 90°
    if (turned) rows.push(['   позиция при 90° (вперёд, вбок) м', `${fmt(turned.car.x, 1)}, ${fmt(turned.car.z, 1)}`]);
  }

  // 7) тормоз+руль на 120 км/ч (срыв в занос без ручника)
  {
    const v0 = 120 / KMH;
    r = run(def, c => { c.vx = v0; }, (t) => ({ steer: 1, brake: t < 0.5 ? 1 : 0, throttle: t >= 0.5 ? 1 : 0 }), 2.5);
    const driftT = r.log.filter(e => e.car.drifting).length * DT;
    const turned = r.log.find(e => Math.abs(wrapAngle(e.car.heading)) >= Math.PI / 2);
    rows.push(['тормоз-срыв @120: в заносе с / 90° за', `${fmt(driftT, 2)} / ${turned ? fmt(turned.t, 2) + ' с' : 'нет'}`]);
  }

  // 8) смена полосы на максималке: руль 0.4 на 0.35 с — не должно срывать
  {
    r = run(def, c => { c.vx = top * 0.95; }, (t) => ({ steer: t < 0.35 ? 0.4 : (t < 0.7 ? -0.4 : 0), throttle: 1 }), 2);
    const drift = r.log.some(e => e.car.drifting);
    const lat = Math.max(...r.log.map(e => Math.abs(e.car.z)));
    rows.push(['смена полосы @макс: сорвало? / смещение м', `${drift ? 'ДА' : 'нет'} / ${fmt(lat, 1)}`]);
  }

  // 9) стабильность: сумасшедший ввод 20 с — без NaN, без «штопора»
  {
    let bad = false, maxYaw = 0;
    r = run(def, c => { c.vx = top; }, (t) => ({
      steer: Math.sin(t * 7.3) > 0 ? 1 : -1, throttle: 1, handbrake: Math.sin(t * 2.1) > 0.6, brake: Math.sin(t * 3.7) > 0.8 ? 1 : 0,
    }), 20, (t, c) => {
      if (!Number.isFinite(c.x + c.z + c.vx + c.vz + c.heading)) { bad = true; return true; }
      maxYaw = Math.max(maxYaw, Math.abs(c.yawRate));
      return false;
    });
    rows.push(['стресс 20 с: NaN? / макс. рысканье рад/с', `${bad ? 'NaN!' : 'нет'} / ${fmt(maxYaw, 2)}`]);
  }

  // 10) задний ход: максимум и разворот
  r = run(def, null, () => ({ brake: 1 }), 6);
  rows.push(['задний ход за 6 с, км/ч', fmt(Math.abs(r.car.speed) * KMH, 0)]);

  console.log(`\n=== ${def.name}  (accel ${def.accel}, top ${fmt(top * KMH, 0)} км/ч, dragK ${fmt(def._dragK, 5)}) ===`);
  for (const [k, v] of rows) console.log('  ' + k.padEnd(52) + v);
}
