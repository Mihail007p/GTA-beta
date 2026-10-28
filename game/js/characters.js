// Готовые герои. Файлы — модели, сгенерированные для проекта из CC0-данных
// MakeHuman; подробное происхождение и параметры — в assets/characters/README.md.
export const CHARACTERS = Object.freeze([
  { id: 'hero-1', name: 'ГЕРОЙ 1', description: 'Городской стиль · рубашка и джинсы', model: 'assets/characters/hero-1.glb', height: 1.76 },
  { id: 'hero-2', name: 'ГЕРОЙ 2', description: 'Городской стиль · футболка и шорты', model: 'assets/characters/hero-2.glb', height: 1.68 },
]);
export const DEFAULT_CHARACTER = CHARACTERS[0].id;
export function characterById(id) { return CHARACTERS.find(c => c.id === id) || null; }
