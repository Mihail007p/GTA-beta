// Собственная машина остаётся в мире, а машины трафика можно занять и
// оставить. Этот модуль не зависит от DOM и рендера; гаражное сохранение
// намеренно не меняется при угоне.
import { CONFIG } from './config.js';
import { makeCarState } from './car-physics.js';
import { TRAFFIC_TYPES } from './traffic-types.js';
import { carEntryDistance, stopParkedCar } from './pedestrian.js';

export const MAX_HIJACK_SPEED = 4; // м/с: быструю машину сначала надо остановить

const TRAFFIC_NAMES = ['Седан', 'Хэтчбек', 'Внедорожник', 'Фургон', 'Такси', 'Пикап', 'Маслкар', 'Спорткар'];
const ACCEL = [8.0, 8.2, 7.5, 6.6, 8.0, 7.3, 9.2, 10.0];
const TOP_SPEED = [42, 40, 41, 36, 42, 40, 45, 49];
export const TRAFFIC_VEHICLES = TRAFFIC_TYPES.map((type, i) => ({
  id: `traffic-${type.id}`,
  name: TRAFFIC_NAMES[i],
  length: type.L,
  width: type.W,
  wheelbase: type.L * 0.57,
  accel: ACCEL[i],
  topSpeed: TOP_SPEED[i],
  physics: { ...CONFIG.physics },
}));

/** Управление автомобилями одного игрового сеанса. */
export class VehicleWorld {
  constructor(traffic, ownCar, ownDef) {
    this.traffic = traffic;
    this.own = { car: ownCar, def: ownDef, ref: null };
    this.current = this.own;
    this.stolen = new Map();
    this.ownProxy = null;
  }

  /** Невидимый коллайдер собственной машины, пока игрок пользуется другой. */
  syncOwnProxy() {
    if (this.current === this.own) {
      if (this.ownProxy) {
        const i = this.traffic.cars.indexOf(this.ownProxy);
        if (i >= 0) this.traffic.cars.splice(i, 1);
        this.ownProxy = null;
      }
      return;
    }
    if (!this.ownProxy) {
      this.ownProxy = { id: 'owned-car', alive: true, parked: true, noRender: true, speed: 0, _hitT: 0 };
      this.traffic.cars.push(this.ownProxy);
    }
    const c = this.own.car, d = this.own.def, proxy = this.ownProxy;
    const axis = Math.abs(Math.cos(c.heading)) >= Math.abs(Math.sin(c.heading)) ? 'x' : 'z';
    Object.assign(proxy, {
      x: c.x, z: c.z, heading: c.heading, visHeading: c.heading,
      axis, dir: (axis === 'x' ? Math.cos(c.heading) : Math.sin(c.heading)) >= 0 ? 1 : -1,
      lane: axis === 'x' ? c.z : c.x, s: axis === 'x' ? c.x : c.z,
      half: Math.max(0.4, d.length / 2 - d.width / 2), radius: d.width / 2,
      length: d.length, width: d.width,
    });
  }

  /** Не заставляем отрисовщик менять модель/цвет машины после угона. */
  sync() {
    const { car, ref } = this.current;
    if (ref) Object.assign(ref, { x: car.x, z: car.z, heading: car.heading, visHeading: car.heading, speed: car.speed });
    this.syncOwnProxy();
    // Далеко оставленные угнанные машины возвращаются в поток трафика.
    for (const ref of this.stolen.keys()) {
      if (!ref.parked && !ref.playerControlled) this.stolen.delete(ref);
    }
  }

  /** Ближайший доступный кузов, а не обязательно последняя машина игрока. */
  nearest(hero) {
    let best = null, bestDistance = 1.65;
    const consider = (car, def, ref) => {
      const distance = carEntryDistance(hero, car, def);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { car, def, ref };
      }
    };
    consider(this.own.car, this.own.def, null);
    for (const ref of this.traffic.cars) {
      if (!ref.alive || ref.noRender) continue;
      const parked = this.stolen.get(ref);
      const def = parked?.def || TRAFFIC_VEHICLES[ref.type] || TRAFFIC_VEHICLES[0];
      const car = ref.playerControlled && this.current.ref === ref ? this.current.car
        : parked?.car || { x: ref.x, z: ref.z, heading: ref.visHeading ?? ref.heading };
      consider(car, def, ref);
    }
    return best;
  }

  /** Вернуть статус, чтобы UI мог попросить остановить быстрое авто. */
  enter(target) {
    if (!target) return { ok: false, reason: 'too-far' };
    const ref = target.ref;
    if (ref && !ref.parked && !ref.playerControlled && Math.abs(ref.speed) > MAX_HIJACK_SPEED) {
      // Водитель затормозит; игрок может повторить попытку рядом с машиной.
      ref.stunned = Math.max(ref.stunned || 0, 3.5);
      return { ok: false, reason: 'too-fast' };
    }
    const occupied = !!(ref && !ref.parked && !ref.playerControlled && !this.stolen.has(ref));
    if ((ref && this.current.ref === ref) || (!ref && this.current === this.own)) {
      stopParkedCar(this.current.car);
      return { ok: true, occupied: false };
    }

    const stats = this.current.car.stats;
    if (this.current.ref) {
      stopParkedCar(this.current.car);
      this.sync();
      this.current.ref.playerControlled = false;
      this.current.ref.parked = true;
      this.current.ref._nearT = 0;
    }
    if (!ref) {
      this.current = this.own;
    } else {
      let vehicle = this.stolen.get(ref);
      if (!vehicle) {
        const def = TRAFFIC_VEHICLES[ref.type] || TRAFFIC_VEHICLES[0];
        const car = makeCarState(def, ref.x, ref.z, ref.visHeading ?? ref.heading);
        vehicle = { car, def, ref };
        this.stolen.set(ref, vehicle);
      }
      this.current = vehicle;
      ref.playerControlled = true;
      ref.parked = false;
      ref.plan = null;
      ref._nearT = 0;
    }
    this.current.car.stats = stats; // статистика заезда общая для всех машин
    stopParkedCar(this.current.car);
    this.sync();
    return { ok: true, occupied };
  }

  /** Смена машины гаража не превращает угнанный автомобиль в собственный. */
  setOwnedDef(def) {
    const car = this.own.car;
    const stats = car.stats;
    Object.assign(car, makeCarState(def, car.x, car.z, car.heading));
    car.stats = stats;
    this.own.def = def;
    this.syncOwnProxy();
  }

  dispose() {
    if (this.ownProxy) {
      const i = this.traffic.cars.indexOf(this.ownProxy);
      if (i >= 0) this.traffic.cars.splice(i, 1);
      this.ownProxy = null;
    }
    for (const ref of this.stolen.keys()) {
      ref.playerControlled = false;
      ref.parked = false;
    }
    this.stolen.clear();
  }
}
