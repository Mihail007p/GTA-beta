// Экономика и потребности. Чистые операции: можно тестировать без DOM/WebGL.
// Сытость расходуется только во время активной игры, а не пока игра закрыта.
export const ITEMS = Object.freeze({
  apple: { name: 'Яблоко', price: 20, satiety: 30, health: 3, description: '+30 сытости · +3 здоровья' },
  bread: { name: 'Хлеб', price: 15, satiety: 18, health: 2, description: '+18 сытости · ингредиент' },
  egg: { name: 'Яйцо', price: 15, description: 'Ингредиент для завтрака' },
  meal: { name: 'Завтрак', satiety: 50, health: 15, description: '+50 сытости · +15 здоровья' },
  toast: { name: 'Фруктовый тост', satiety: 40, health: 8, description: '+40 сытости · +8 здоровья' },
  medkit: { name: 'Аптечка', price: 100, health: 45, description: '+45 здоровья' },
});
export const RECIPES = Object.freeze({
  breakfast: { name: 'Завтрак', ingredients: { bread: 1, egg: 1 }, result: 'meal', description: 'Хлеб ×1 + яйцо ×1 → завтрак ×1' },
  fruitToast: { name: 'Фруктовый тост', ingredients: { bread: 1, apple: 1 }, result: 'toast', description: 'Хлеб ×1 + яблоко ×1 → тост ×1' },
});
export const OUTFITS = Object.freeze({
  street: { name: 'Городской', price: 0 },
  smart: { name: 'Нарядный костюм', price: 250 },
});
export const JOBS = Object.freeze({
  home: { name: 'Доставка в дом', kind: 'home', reward: 220 },
  shop: { name: 'Поставка в магазин', kind: 'shop', reward: 180 },
});
const MAX_ITEMS = 99;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const bounded = (n, min, max, fallback) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;

export function makeLife(saved) {
  const raw = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  const inv = {};
  for (const key of Object.keys(ITEMS)) {
    // Стартовый набор получают и новые игроки, и существующие сохранения.
    const initial = key === 'bread' || key === 'egg' || key === 'apple' ? 1 : 0;
    inv[key] = Math.floor(bounded(raw?.inventory?.[key], 0, MAX_ITEMS, raw ? 0 : initial));
  }
  const owned = ['street'];
  if (Array.isArray(raw?.outfits) && raw.outfits.includes('smart')) owned.push('smart');
  let job = null;
  if (raw?.job && own(JOBS, raw.job.type) && Number.isInteger(raw.job.targetId) && raw.job.targetId >= 0 && raw.job.targetId <= 99999) {
    job = { type: raw.job.type, targetId: raw.job.targetId };
  }
  return {
    health: bounded(raw?.health, 0, 100, 100),
    satiety: bounded(raw?.satiety, 0, 100, 100),
    inventory: inv, outfits: owned,
    outfit: owned.includes(raw?.outfit) ? raw.outfit : 'street',
    job, completedJobs: Math.floor(bounded(raw?.completedJobs, 0, 1000000, 0)),
  };
}

export function buyItem(save, id) {
  const item = own(ITEMS, id) ? ITEMS[id] : null;
  if (!item || !item.price) return { ok: false, message: 'Этот предмет не продаётся' };
  if (save.life.inventory[id] >= MAX_ITEMS) return { ok: false, message: 'В рюкзаке нет места для этого предмета' };
  if (save.money < item.price) return { ok: false, message: `Не хватает $ ${item.price - Math.floor(save.money)}` };
  save.money = Math.round((save.money - item.price) * 100) / 100;
  save.life.inventory[id]++;
  return { ok: true, message: `Куплено: ${item.name}` };
}
export function buyOutfit(save, id) {
  const outfit = own(OUTFITS, id) ? OUTFITS[id] : null;
  if (!outfit || !outfit.price) return { ok: false, message: 'Этот комплект не продаётся' };
  if (save.life.outfits.includes(id)) return { ok: false, message: 'Этот комплект уже куплен' };
  if (save.money < outfit.price) return { ok: false, message: `Не хватает $ ${outfit.price - Math.floor(save.money)}` };
  save.money = Math.round((save.money - outfit.price) * 100) / 100;
  save.life.outfits.push(id);
  return { ok: true, message: `Куплено: ${outfit.name}. Наденьте его у шкафа` };
}
export function useItem(life, id) {
  const item = own(ITEMS, id) ? ITEMS[id] : null;
  if (!item || !life.inventory[id]) return { ok: false, message: 'Предмета нет в рюкзаке' };
  if (!item.satiety && !item.health) return { ok: false, message: 'Это ингредиент для плиты' };
  if ((!item.satiety || life.satiety >= 100) && (!item.health || life.health >= 100)) {
    return { ok: false, message: 'Здоровье и сытость уже в норме' };
  }
  life.inventory[id]--;
  life.satiety = Math.min(100, life.satiety + (item.satiety || 0));
  life.health = Math.min(100, life.health + (item.health || 0));
  return { ok: true, message: id === 'medkit' ? 'Вы использовали аптечку' : `Вы съели: ${item.name}` };
}
export function cookRecipe(life, id, stoveOn) {
  const recipe = own(RECIPES, id) ? RECIPES[id] : null;
  if (!recipe) return { ok: false, message: 'Неизвестный рецепт' };
  if (!stoveOn) return { ok: false, message: 'Сначала включите плиту' };
  if (life.inventory[recipe.result] >= MAX_ITEMS) return { ok: false, message: 'В рюкзаке нет места для готовой еды' };
  if (Object.entries(recipe.ingredients).some(([key, amount]) => life.inventory[key] < amount)) {
    return { ok: false, message: 'Не хватает ингредиентов — купите их в магазине' };
  }
  for (const [key, amount] of Object.entries(recipe.ingredients)) life.inventory[key] -= amount;
  life.inventory[recipe.result]++;
  return { ok: true, message: `${recipe.name} готов! Откройте рюкзак, чтобы поесть` };
}
export function cookBreakfast(life, stoveOn) { return cookRecipe(life, 'breakfast', stoveOn); }

// Один пункт сытости за минуту активной игры; при нуле — 1 здоровье за 10 секунд.
// На кровати и диване здоровье восстанавливается только если есть силы.
export function stepNeeds(life, dt, options = {}) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  const before = life.satiety;
  life.satiety = Math.max(0, life.satiety - dt / 60);
  if (life.satiety <= 0 && options.starvationDamage !== false) {
    const starving = Math.max(0, dt - before * 60);
    life.health = Math.max(0, life.health - starving * 0.1);
  }
  if (life.satiety > 5 && options.rest) {
    const rate = options.rest === 'lie' ? 2 : 0.7;
    life.health = Math.min(100, life.health + dt * rate);
  }
}
export function damage(life, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  life.health = Math.max(0, life.health - amount);
  return true;
}

export function chooseJobTarget(type, origin, entrances) {
  const job = own(JOBS, type) ? JOBS[type] : null;
  if (!job || !origin) return null;
  const candidates = entrances.filter(d => d.kind === job.kind && d.id !== origin.id)
    .map(d => ({ d, dist: Math.hypot(d.x - origin.x, d.z - origin.z) }))
    .filter(x => x.dist >= 90 && x.dist <= 210).sort((a, b) => a.dist - b.dist || a.d.id - b.d.id);
  if (candidates.length) return candidates[(origin.id + type.length) % Math.min(6, candidates.length)].d;
  return entrances.find(d => d.kind === job.kind && d.id !== origin.id) || null;
}
export function acceptJob(life, type, origin, entrances) {
  if (life.job) return { ok: false, message: 'Сначала выполните или отмените текущий заказ' };
  const target = chooseJobTarget(type, origin, entrances);
  if (!target) return { ok: false, message: 'Сейчас нет подходящего адреса' };
  life.job = { type, targetId: target.id };
  return { ok: true, message: 'Заказ принят. Жёлтая метка на карте — адрес доставки' };
}
export function completeJob(save, door) {
  const job = save.life.job;
  if (!job || job.targetId !== door?.id || !own(JOBS, job.type)) return { ok: false, message: 'Это не адрес доставки' };
  const reward = JOBS[job.type].reward;
  save.money = Math.round((save.money + reward) * 100) / 100;
  save.life.job = null; save.life.completedJobs++;
  return { ok: true, message: `Доставка выполнена! +$ ${reward}` };
}

// Честный быстрый трансфер: не симулируем поездку, перемещаем игрока после
// затемнения к свободной точке у выбранной двери; припаркованная машина остаётся.
export const TAXI_FARES = Object.freeze({ home: 40, shop: 40, job: 60 });
export function taxiDestination(type, player, entrances, job) {
  if (!own(TAXI_FARES, type) || !player) return null;
  if (type === 'job') {
    const door = job && entrances.find(d => d.id === job.targetId);
    return door && Math.hypot(door.x - player.x, door.z - player.z) >= 20 ? door : null;
  }
  return entrances.filter(d => d.kind === type)
    .map(d => ({ door: d, distance: Math.hypot(d.x - player.x, d.z - player.z) }))
    .filter(x => x.distance >= 35).sort((a, b) => a.distance - b.distance || a.door.id - b.door.id)[0]?.door || null;
}
