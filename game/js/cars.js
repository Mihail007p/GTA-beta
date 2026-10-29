// ============================================================================
//  CARS — гараж. Каждая машина = свой характер (разгон / максималка / цепкость).
//  Открывается за деньги, заработанные в свободной езде.
//  Базовая физика берётся из CONFIG.physics и переопределяется per-car.
//  Цифры подобраны стендом tests/physics-sim.mjs (0–100, радиусы, дрифт).
// ============================================================================
import { CONFIG } from './config.js';

function car(overrides) {
  const physics = Object.assign({}, CONFIG.physics, overrides.physics || {});
  return Object.assign({}, overrides, { physics });
}

export const CARS = [
  car({
    id: 'strada',
    name: 'Porsche Cayenne Turbo',
    desc: 'Мощный кроссовер. Тяжёлый, но послушный и прощает ошибки — лучшая машина, чтобы освоиться.',
    model: 'assets/cars/cayenne.glb',
    accel: 9.8,
    topSpeed: 48,          // 173 км/ч
    mass: 1250,
    wheelbase: 2.6,
    radius: 1.0,
    unlockCost: 0,
    paint: 0x2a3d57,       // тёмно-синий металлик
    paintMetal: 0.6,
    trim: 0x1b1b1f,
    glass: 0x0d1a24,
    bodyStyle: 'coupe',
    length: 4.85, width: 1.94,   // габариты для коллайдера (реальные, без зеркал)
  }),
  car({
    id: 'vektor',
    name: 'Porsche 911 GT3 Touring',
    desc: 'Лёгкий заднемоторный 911. Резкий разгон и самый острый руль в гараже.',
    model: 'assets/cars/gt3.glb',
    accel: 11.8,
    topSpeed: 51,          // 184 км/ч
    mass: 1120,
    wheelbase: 2.45,
    radius: 0.95,
    unlockCost: 6000,
    paint: 0xe8b81a,       // жёлтый Racing Yellow
    paintMetal: 0.25,
    trim: 0x22242a,
    glass: 0x101a22,
    bodyStyle: 'hatch',
    length: 4.57, width: 1.85,   // габариты для коллайдера
    physics: { latAccelGrip: 23, steerSpeedMax: 0.56, yawResponse: 9.5 },
  }),
  car({
    id: 'taifun',
    name: 'Ferrari 458 Spider',
    desc: 'V8 за спиной и задний привод: много мощности, охотно идёт боком и держит скорость в заносе.',
    model: 'assets/cars/f458.glb',
    accel: 12.6,
    topSpeed: 55,          // 198 км/ч
    mass: 1520,
    wheelbase: 2.85,
    radius: 1.05,
    unlockCost: 18000,
    paint: 0xc40f0c,       // Rosso Corsa
    paintMetal: 0.3,
    trim: 0x15171c,
    glass: 0x0b141c,
    bodyStyle: 'muscle',
    length: 4.53, width: 1.94,   // габариты для коллайдера
    physics: {
      gripLateral: 8.2, driftLateral: 2.0, slideConserveDrift: 0.64,
      driftYawBoost: 1.85, latAccelGrip: 19.5, driftEnterSlip: 0.18,
    },
  }),
  car({
    id: 'feniks',
    name: 'Porsche Carrera GT',
    desc: 'Легендарный гиперкар с V10. 230 км/ч и цепкость как на рельсах, но на такой скорости город узкий.',
    model: 'assets/cars/cgt.glb',
    accel: 14.8,
    topSpeed: 64,          // 230 км/ч
    mass: 1380,
    wheelbase: 2.7,
    radius: 1.05,
    unlockCost: 45000,
    paint: 0xb3b6ba,       // GT Silver
    paintMetal: 0.75,
    trim: 0x0e1116,
    glass: 0x08131b,
    bodyStyle: 'super',
    length: 4.61, width: 1.92,   // габариты для коллайдера
    physics: {
      gripLateral: 12, latAccelGrip: 24, steerSpeedMin: 0.075,
      handbrakeLateral: 1.7, brakeForce: 16,
    },
  }),
];

export function carById(id) {
  for (const c of CARS) if (c.id === id) return c;
  return CARS[0];
}

export const STARTER_CAR = CARS[0].id;
