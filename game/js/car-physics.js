// ============================================================================
//  CAR PHYSICS — аркадная модель автомобиля.
//  ЧИСТАЯ ЛОГИКА, без THREE и DOM. Тестируется в Node (tests/physics.test.mjs).
//
//  Модель — «поворот вектора скорости», стандарт аркадных гонок:
//   1. Руль задаёт скорость рысканья (как велосипедная модель), но она
//      ограничена предельным боковым ускорением → на скорости машина не
//      «переламывается», а на парковочной скорости разворачивается на месте.
//   2. Вектор скорости догоняет направление кузова с темпом «сцепления».
//      Сцепление высокое → едет как по рельсам. Низкое (ручник/занос) →
//      кузов развёрнут относительно траектории = управляемый дрифт.
//   3. Гашение бокового скольжения частично ПЕРЕВОДИТСЯ в продольную скорость
//      (slideConserve), поэтому занос не «убивает» скорость — это и есть
//      ощущение аркады: в поворот входишь боком и выходишь быстро.
//   4. Угол скольжения в установившемся режиме = рысканье / сцепление, он
//      всегда ограничен → машину невозможно закрутить «в штопор». Прощает ошибки.
//
//  Система координат логики: +X — курс 0, +Z — «юг», курс растёт по часовой
//  стрелке (вид сверху). forward = (cos h, sin h), right = (-sin h, cos h).
// ============================================================================

export function makeCarState(def, x, z, heading) {
  return {
    x, z,
    heading,          // рад, 0 = +X
    vx: 0, vz: 0,     // мировая скорость, м/с
    yawRate: 0,       // рад/с
    steer: 0,         // сглаженное положение руля (-1..1)
    speed: 0,         // м/с вдоль кузова, со знаком (минус = задний ход)
    lateral: 0,       // м/с поперёк кузова (скольжение)
    slip: 0,          // рад, угол между кузовом и траекторией
    wheelAngle: 0,    // визуальный угол передних колёс, рад
    drifting: false,
    handbrake: false,
    throttle: 0,
    brake: 0,
    accelLong: 0,     // м/с² — для клевков кузова
    accelLat: 0,      // м/с² — для крена кузова
    onRoad: true,
    stats: { collisions: 0, driftTime: 0, distance: 0, topSpeed: 0 },
  };
}

/** Коэффициент аэродинамики подбирается так, чтобы машина реально выходила на свою максималку. */
export function dragCoefficient(def) {
  const P = def.physics;
  const thrustAtTop = def.accel * P.thrustAtTop;
  return Math.max(0, thrustAtTop - P.rollResist - P.topSpeedMargin) / (def.topSpeed * def.topSpeed);
}

/** Максимальный угол колёс в зависимости от скорости (на скорости руль «тяжелеет») */
export function maxSteerAngle(P, absSpeed) {
  const t = Math.min(1, absSpeed / P.steerFalloffSpeed);
  return P.steerSpeedMax + (P.steerSpeedMin - P.steerSpeedMax) * Math.pow(t, 0.75);
}

export function stepCar(car, def, input, dt, env) {
  const P = def.physics;
  const wheelbase = def.wheelbase || 2.7;
  if (def._dragK === undefined) def._dragK = dragCoefficient(def);
  const dragK = def._dragK;

  const throttle = clamp(input.throttle || 0, 0, 1);
  const brake = clamp(input.brake || 0, 0, 1);
  const handbrake = !!input.handbrake;
  car.throttle = throttle;
  car.brake = brake;
  car.handbrake = handbrake;

  // --- РУЛЬ: сглаживание (без рывков от пальца) -----------------------------
  const targetSteer = clamp(input.steer || 0, -1, 1);
  car.steer += (targetSteer - car.steer) * (1 - Math.exp(-P.steerSmooth * dt));

  // --- Разложение скорости по ТЕКУЩЕМУ курсу --------------------------------
  const cosH = Math.cos(car.heading);
  const sinH = Math.sin(car.heading);
  let vF = car.vx * cosH + car.vz * sinH;     // вдоль кузова
  let vL = -car.vx * sinH + car.vz * cosH;    // поперёк кузова (+ = вправо)
  const vF0 = vF, vL0 = vL;

  // --- ПРОДОЛЬНАЯ ДИНАМИКА ---------------------------------------------------
  if (throttle > 0) {
    // на ручнике задние колёса заблокированы — тяга почти не передаётся
    const drive = handbrake ? 0.25 : 1;
    if (vF < -0.5) {
      // газ при движении назад = торможение
      vF += P.brakeForce * throttle * dt;
    } else {
      const t = clamp(vF / def.topSpeed, 0, 1);
      const thrust = def.accel * (1 - (1 - P.thrustAtTop) * t);
      vF += thrust * throttle * drive * dt;
    }
  }
  if (brake > 0) {
    if (vF > 0.5) {
      vF -= P.brakeForce * brake * dt;
      if (vF < 0) vF = 0;
    } else {
      // задний ход
      vF = Math.max(-P.reverseMax, vF - P.reverseAccel * brake * dt);
    }
  }
  if (handbrake && Math.abs(vF) > 0.1) {
    const d = P.handbrakeDecel * dt;
    vF = Math.abs(vF) <= d ? 0 : vF - Math.sign(vF) * d;
  }

  // сопротивления: воздух ~v², качение + торможение двигателем
  vF -= dragK * vF * Math.abs(vF) * dt;
  let resist = P.rollResist;
  if (env && env.onRoad === false) resist += P.offroadDrag;
  const rd = resist * dt;
  if (throttle === 0 || vF < 0) {
    vF = Math.abs(vF) <= rd ? 0 : vF - Math.sign(vF) * rd;
  } else {
    vF -= Math.sign(vF) * rd;
  }
  vF = clamp(vF, -P.reverseMax, def.topSpeed);

  // --- СОСТОЯНИЕ ЗАНОСА (с гистерезисом) ------------------------------------
  const absF = Math.abs(vF);
  const slipNow = Math.atan2(Math.abs(vL), Math.max(absF, 1));
  const brakeFlick = brake > 0.5 && Math.abs(car.steer) > 0.6 && vF > P.brakeDriftSpeed;
  if (absF < P.driftMinSpeed) {
    car.drifting = false;
  } else if (car.drifting) {
    if (slipNow < P.driftExitSlip && !handbrake) car.drifting = false;
  } else if (slipNow > P.driftEnterSlip || (handbrake && absF > P.driftMinSpeed + 2)) {
    car.drifting = true;
  }

  // --- РУЛЁЖКА: скорость рысканья -------------------------------------------
  // Лимит = min(кинематика колёс, предельное боковое ускорение / скорость).
  // Руль масштабируется на этот лимит → весь ход стика полезен, без «мёртвой» зоны.
  const steerAng = maxSteerAngle(P, absF);
  const kinYaw = Math.tan(steerAng) * absF / wheelbase;
  const capYaw = P.latAccelGrip / Math.max(absF, 1);
  let maxYaw = Math.min(kinYaw, capYaw);
  if (car.drifting || handbrake || brakeFlick) maxYaw *= P.driftYawBoost;
  // направление поворота при заднем ходе меняется, как у настоящей машины
  const dirSign = vF >= 0 ? 1 : -1;
  const desiredYaw = car.steer * maxYaw * dirSign;
  car.wheelAngle = absF > 0.5
    ? clamp(Math.atan(Math.abs(desiredYaw) * wheelbase / absF), 0, P.steerSpeedMax) * Math.sign(car.steer)
    : car.steer * P.steerSpeedMax;

  car.yawRate += (desiredYaw - car.yawRate) * (1 - Math.exp(-P.yawResponse * dt));

  // --- БОКОВОЕ СЦЕПЛЕНИЕ: траектория догоняет кузов --------------------------
  let grip = P.gripLateral;
  if (handbrake) grip = P.handbrakeLateral;
  else if (brakeFlick) grip = Math.min(grip, P.driftLateral);
  else if (car.drifting) grip = P.driftLateral;
  if (env && env.onRoad === false) grip *= 0.8;

  const speedSq = vF * vF + vL * vL;
  const vLnew = vL * Math.exp(-grip * dt);
  // часть погашенного скольжения превращается в скорость вдоль кузова
  const fTarget = Math.sqrt(Math.max(0, speedSq - vLnew * vLnew));
  const conserve = car.drifting ? P.slideConserveDrift : P.slideConserve;
  const absFnew = Math.abs(vF) + (fTarget - Math.abs(vF)) * conserve;
  vF = (vF >= 0 ? 1 : -1) * Math.min(absFnew, def.topSpeed);
  vL = Math.abs(vLnew) < 0.02 ? 0 : vLnew;

  // --- СБОРКА СКОРОСТИ ПО ТОМУ ЖЕ КУРСУ, ЗАТЕМ ПОВОРОТ КУЗОВА ---------------
  // Важно: курс меняется ПОСЛЕ сборки. На следующем шаге поворот кузова
  // проявится как боковое скольжение — именно так рождается занос.
  car.vx = cosH * vF - sinH * vL;
  car.vz = sinH * vF + cosH * vL;
  car.heading = wrapAngle(car.heading + car.yawRate * dt);

  // --- ИНТЕГРИРОВАНИЕ ПОЗИЦИИ -----------------------------------------------
  const px = car.x, pz = car.z;
  car.x += car.vx * dt;
  car.z += car.vz * dt;

  // --- ТЕЛЕМЕТРИЯ -----------------------------------------------------------
  car.speed = vF;
  car.lateral = vL;
  car.slip = Math.atan2(vL, Math.max(Math.abs(vF), 1));
  car.accelLong = (vF - vF0) / dt;
  car.accelLat = vF * car.yawRate;
  const absSpeed = Math.hypot(car.vx, car.vz);
  car.stats.distance += Math.hypot(car.x - px, car.z - pz);
  if (absSpeed > car.stats.topSpeed) car.stats.topSpeed = absSpeed;
  if (car.drifting) car.stats.driftTime += dt;
  void vL0;
  return car;
}

/**
 * Разрешение коллизии «круг коллайдера против препятствия».
 * hit: {nx, nz, depth} — нормаль от препятствия к машине.
 * (rx, rz) — смещение точки контакта от центра машины (для момента вращения).
 * Выталкивает машину, гасит нормальную составляющую скорости с отскоком,
 * сохраняет касательную (скольжение вдоль стены прощается),
 * разворачивает кузов моментом удара. Возвращает силу удара, м/с.
 */
export function resolveCollision(car, hit, physics, rx = 0, rz = 0) {
  if (!hit) return 0;
  car.x += hit.nx * hit.depth;
  car.z += hit.nz * hit.depth;

  const vn = car.vx * hit.nx + car.vz * hit.nz;
  if (vn >= 0) return 0;               // уже расходимся
  const impact = -vn;
  const e = physics.collideRestitution;
  car.vx -= (1 + e) * vn * hit.nx;
  car.vz -= (1 + e) * vn * hit.nz;

  // потеря скорости растёт с силой удара: касание стены почти бесплатно,
  // лобовой удар — ощутимо
  const severity = Math.min(1, impact / 25);
  const keep = 1 - physics.collideSpeedLoss * severity;
  car.vx *= keep;
  car.vz *= keep;

  // момент от удара в нос/корму: r × n (по часовой = +)
  const torque = rx * hit.nz - rz * hit.nx;
  car.yawRate += clamp(torque * impact * (physics.collideSpin ?? 0.05), -2.2, 2.2);
  return impact;
}

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
export function lerp(a, b, t) { return a + (b - a) * t; }
/** Экспоненциальное сглаживание, независимое от dt */
export function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }
/** То же для углов (кратчайший путь через ±PI) */
export function dampAngle(a, b, lambda, dt) {
  return a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
}
