// Часы следуют локальному времени устройства: один круг за 24 реальных часа.
// Часовой пояс/переход на летнее время задаёт само устройство.
export function localHour(date = new Date()) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}
export function clockText(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function daylight(hour) {
  const phase = Math.sin((hour - 6) * Math.PI / 12);
  const day = Math.max(0, Math.min(1, (phase + 0.08) / 0.50));
  const twilight = Math.max(0, 1 - Math.abs(phase) / 0.3) * (1 - day * 0.45);
  return { day, night: 1 - day, twilight, phase };
}
