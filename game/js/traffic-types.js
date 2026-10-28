// ============================================================================
//  TRAFFIC TYPES — типы машин трафика (модели assets/traffic.glb, CC0 Rgsdev).
//  Чистый модуль: используется логикой (длина капсулы столкновений) и рендером.
//  Габариты — как у реальных машин своего класса (м).
// ============================================================================
export const TRAFFIC_TYPES = [
  { id: 'sedan', L: 4.70, W: 1.84 },
  { id: 'hatch', L: 4.20, W: 1.80 },
  { id: 'suv', L: 4.70, W: 1.90 },
  { id: 'van', L: 5.10, W: 1.95 },
  { id: 'taxi', L: 4.70, W: 1.84 },
  { id: 'pickup', L: 5.10, W: 1.92 },
  { id: 'muscle', L: 4.80, W: 1.90 },
  { id: 'sports', L: 4.45, W: 1.90 },
];

// Тип по номеру машины (без расхода ГСЧ): обычных машин больше, фургонов и спорткаров меньше
const TYPE_SEQUENCE = [0, 1, 2, 0, 4, 1, 2, 3, 0, 5, 1, 7, 2, 0, 6, 4];
export function trafficTypeIndex(i) { return TYPE_SEQUENCE[i % TYPE_SEQUENCE.length]; }

/** Смещение кругов капсулы от центра вдоль кузова (радиус круга 0.95 м) */
export function trafficHalf(typeIdx) {
  const t = TRAFFIC_TYPES[typeIdx] || TRAFFIC_TYPES[0];
  return Math.max(0.9, t.L / 2 - 0.95);
}
