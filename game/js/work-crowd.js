// Пассажир такси использует один из четырёх существующих экземпляров толпы.
// Координаты и этап заказа сохраняются, отдельная тяжёлая модель не нужна.
// Корень модели находится у ступней. Высоты подобраны под высокую кабину
// кроссовера и низкие спортивные кузова; поза car-sit вытягивает ноги вперёд.
const SEAT_Y = { strada: -0.22, vektor: -0.52, taifun: -0.42, feniks: -0.52,
  'traffic-suv': -0.22, 'traffic-van': -0.22, 'traffic-pickup': -0.22 };
function seat(car, def) {
  const f = 0.15, r = (def.width || 1.9) * 0.24;
  const c = Math.cos(car.heading), s = Math.sin(car.heading);
  return { x: car.x + c * f - s * r, z: car.z + s * f + c * r,
    y: (SEAT_Y[def.id] ?? -0.42) + (car.onRoad === false ? 0.16 : 0) };
}

export function syncTaxiPassenger(crowd, job, entrancesById, car, def, dt = 0) {
  if (!crowd) return null;
  let p = crowd.people.find(person => person.taxiReserved);
  if (job?.type !== 'taxi') {
    if (p) {
      p.taxiReserved = false;
      if (['taxi-wait', 'taxi-board', 'taxi-seat'].includes(p.condition)) { p.alive = false; p.condition = 'walk'; }
    }
    return null;
  }
  const door = entrancesById.get(job.stage === 'pickup' ? job.pickupId : job.destinationId);
  if (!door) return null;
  if (!p) {
    p = crowd.people.find(person => person.condition === 'walk' || !person.alive);
    if (!p) return null; // Все четыре человека ещё лежат: ждём освобождения слота.
    Object.assign(p, { taxiReserved: true, alive: true, fatal: false, fall: 0, speed: 0 });
    if (job.stage === 'pickup') {
      Object.assign(p, { condition: 'taxi-wait', x: door.x + door.nx * 0.8, z: door.z + door.nz * 0.8,
        y: 0.16, heading: Math.atan2(door.nz, door.nx), pause: 0 });
    } else {
      // При повторном запуске пассажир ожидает в машине; этап не оплачивается заново.
      p.condition = 'taxi-seat';
    }
  }
  if (job.stage === 'pickup') return p;
  const target = seat(car, def);
  if (p.condition === 'taxi-wait') {
    p.condition = 'taxi-board'; p.boardAge = 0;
    p.boardX = p.x; p.boardZ = p.z; p.boardY = p.y;
  }
  if (p.condition === 'taxi-board') {
    p.boardAge = Math.min(1, p.boardAge + Math.max(0, dt));
    const t = p.boardAge;
    p.x = p.boardX + (target.x - p.boardX) * t;
    p.z = p.boardZ + (target.z - p.boardZ) * t;
    p.y = p.boardY + (target.y - p.boardY) * t;
    p.heading = Math.atan2(target.z - p.boardZ, target.x - p.boardX);
    p.speed = 1.2;
    if (t >= 1) p.condition = 'taxi-seat';
  }
  if (p.condition === 'taxi-seat') {
    p.x = target.x; p.z = target.z; p.y = target.y;
    p.heading = car.heading; p.speed = 0;
  }
  return p;
}

function startExit(p, point) {
  Object.assign(p, { taxiReserved: false, condition: 'taxi-exit', exitAge: 0, exitX: p.x, exitZ: p.z, exitY: p.y,
    exitTarget: point, speed: 0, fall: 0 });
}

// На конечной пассажир выходит из автомобиля к доступному фасаду.
export function releaseTaxiPassenger(crowd, door) {
  const p = crowd?.people.find(person => person.taxiReserved);
  if (!p || !door) return false;
  startExit(p, { x: door.x + door.nx * 0.8, z: door.z + door.nz * 0.8, y: 0.16 });
  return true;
}

// Отмена в рюкзаке: ожидающий клиент снова становится прохожим, а сидящий
// выходит рядом с остановленной машиной, если для него найдено свободное место.
export function cancelTaxiPassenger(crowd, exitSpot) {
  const p = crowd?.people.find(person => person.taxiReserved);
  if (!p) return false;
  if (p.condition === 'taxi-wait') {
    Object.assign(p, { taxiReserved: false, condition: 'walk', needsPath: true, speed: 0, pause: 0.5 });
  } else if (exitSpot && ['taxi-board', 'taxi-seat'].includes(p.condition)) {
    startExit(p, exitSpot);
  } else {
    // Машина со всех сторон прижата к препятствиям: не помещаем человека в стену.
    Object.assign(p, { taxiReserved: false, alive: false, condition: 'walk' });
  }
  return true;
}
