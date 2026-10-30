// Столкновения транспорта с прохожими. Без THREE/DOM: работает на каждом
// фиксированном подшаге машины и проверяется отдельно от рендерера.
import { circleVsCar } from './pedestrian.js';

export const CITIZEN_RADIUS = 0.38;
export const FALL_SPEED = 1.8;     // м/с (~6.5 км/ч), ниже — только отталкивание
export const FATAL_SPEED = 13;     // м/с (~47 км/ч), по направлению удара

// Пробуем промежуточные положения кузова: при низком FPS или большой скорости
// пешеход не должен оказаться между двумя дискретными кадрами. Телепорт/сброс
// длиннее 12 м намеренно не считается непрерывной поездкой.
function contact(person, car, def, previous) {
  const dx = car.x - (previous?.x ?? car.x), dz = car.z - (previous?.z ?? car.z);
  const travel = Math.hypot(dx, dz);
  const start = previous && travel <= 12 ? previous : car;
  const sx = car.x - start.x, sz = car.z - start.z;
  const denom = sx * sx + sz * sz;
  const t = denom ? Math.max(0, Math.min(1, ((person.x - start.x) * sx + (person.z - start.z) * sz) / denom)) : 1;
  const ex = start.x + sx * t, ez = start.z + sz * t;
  const reach = (def.length || 4.4) / 2 + CITIZEN_RADIUS + 0.75;
  if ((person.x - ex) ** 2 + (person.z - ez) ** 2 > reach * reach) return null;
  const steps = Math.max(1, Math.min(36, Math.ceil(Math.hypot(sx, sz) / 0.35)));
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const pose = { x: start.x + sx * u, z: start.z + sz * u, heading: car.heading };
    const hit = circleVsCar(person.x, person.z, CITIZEN_RADIUS, pose, def.length || 4.4, def.width || 1.9);
    if (hit) return hit;
  }
  return null;
}

/** Возвращает массив результатов; один человек не получает повторный удар, пока лежит. */
export function collideCrowd(crowd, car, def, previous = null) {
  const results = [];
  if (!crowd || !car || !def) return results;
  let vx = Number.isFinite(car.vx) ? car.vx : 0, vz = Number.isFinite(car.vz) ? car.vz : 0;
  for (const person of crowd.people) {
    // Во время короткого выхода пассажир ещё находится внутри своего автомобиля.
    if (!person.alive || !['walk', 'return', 'taxi-wait'].includes(person.condition || 'walk')) continue;
    const hit = contact(person, car, def, previous);
    if (!hit) continue;
    const target = person.condition === 'return' ? person.returnPoint : null;
    const d = target ? Math.hypot(target.x - person.x, target.z - person.z) || 1 : 1;
    const pvx = target ? (target.x - person.x) / d * (person.speed || 0) : person.axis === 'x' ? (person.dir || 0) * (person.speed || 0) : 0;
    const pvz = target ? (target.z - person.z) / d * (person.speed || 0) : person.axis === 'z' ? (person.dir || 0) * (person.speed || 0) : 0;
    const closing = Math.max(0, (vx - pvx) * hit.nx + (vz - pvz) * hit.nz);
    // Немного выталкиваем даже при парковочной скорости. Прохожий не остаётся
    // внутри кузова и не проходит сквозь стоящий автомобиль.
    person.x += hit.nx * (hit.depth + 0.06);
    person.z += hit.nz * (hit.depth + 0.06);
    if (closing < FALL_SPEED) {
      person.pause = 0.6; person.speed = 0; person.needsPath = true;
      if (person.condition !== 'taxi-wait') person.dir = -(person.dir || 1);
      results.push({ person, impact: closing, kind: 'push' });
      continue;
    }
    const fatal = closing >= FATAL_SPEED;
    person.condition = fatal ? 'dead' : 'injured';
    person.fatal = fatal;
    person.fall = 0;
    person.hitAge = 0;
    const sideX = -Math.sin(car.heading), sideZ = Math.cos(car.heading);
    const sideOffset = (person.x - car.x) * sideX + (person.z - car.z) * sideZ;
    const sideSign = Math.abs(sideOffset) > 0.12 ? Math.sign(sideOffset) : (person.id % 2 ? 1 : -1);
    const sideways = Math.min(5.5, 0.7 + closing * 0.30) * sideSign;
    const push = Math.min(24, 1.2 + closing * 0.85);
    person.hitVx = hit.nx * push + vx * 0.15 + sideX * sideways;
    person.hitVz = hit.nz * push + vz * 0.15 + sideZ * sideways;
    person.hitHeight = Math.min(0.9, closing * 0.055);
    person.heading = Math.atan2(person.hitVz, person.hitVx);
    person.speed = 0; person.pause = 0;
    // Человек легче машины: ощутимая, но не остановка как от стены.
    const loss = Math.min(0.18, 0.035 + closing * 0.003);
    car.vx = vx *= (1 - loss); car.vz = vz *= (1 - loss);
    car.speed = (car.speed || 0) * (1 - loss);
    results.push({ person, impact: closing, kind: fatal ? 'fatal' : 'injured' });
  }
  return results;
}
