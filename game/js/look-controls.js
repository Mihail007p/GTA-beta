// Положительный свайп вправо должен поворачивать взгляд вправо — одинаково
// пешком, в помещении и за рулём. Угол сохраняем в диапазоне [-π, π].
import { wrapAngle } from './car-physics.js';

export const LOOK_YAW_PER_PIXEL = 0.006;
export function turnLook(yaw, horizontalPixels) {
  return wrapAngle(yaw + horizontalPixels * LOOK_YAW_PER_PIXEL);
}
