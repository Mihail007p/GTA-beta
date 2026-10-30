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
  home: { name: 'Доставка в дом', kind: 'home', reward: 220, description: 'Отнесите посылку к жёлтой метке' },
  shop: { name: 'Поставка в магазин', kind: 'shop', reward: 180, description: 'Отнесите товар к жёлтой метке' },
  taxi: { name: 'Таксист', kind: 'home', reward: 380, description: 'На своей или угнанной машине заберите пассажира и отвезите его' },
  route: { name: 'Курьер: три адреса', kind: 'home', reward: 650, description: 'Доставьте три посылки по очереди' },
  cleanup: { name: 'Уборка улиц', kind: null, reward: 360, description: 'Пешком соберите три мешка у жёлтых меток' },
});
const MAX_ITEMS = 99;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const bounded = (n, min, max, fallback) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
const validDoorId = id => Number.isInteger(id) && id >= 0 && id <= 99999;

function readJob(raw) {
  if (!raw || typeof raw !== 'object' || !own(JOBS, raw.type) || !validDoorId(raw.targetId)) return null;
  if (raw.type === 'taxi') {
    if (!validDoorId(raw.pickupId) || !validDoorId(raw.destinationId) || raw.pickupId === raw.destinationId ||
        !['pickup', 'drive'].includes(raw.stage) || raw.targetId !== (raw.stage === 'pickup' ? raw.pickupId : raw.destinationId)) return null;
    return { type: 'taxi', targetId: raw.targetId, pickupId: raw.pickupId, destinationId: raw.destinationId, stage: raw.stage };
  }
  if (raw.type === 'route' || raw.type === 'cleanup') {
    if (!Array.isArray(raw.targets) || raw.targets.length !== 3 || !raw.targets.every(validDoorId) ||
        new Set(raw.targets).size !== 3 || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > 2 ||
        raw.targetId !== raw.targets[raw.index]) return null;
    return { type: raw.type, targetId: raw.targetId, targets: raw.targets.slice(), index: raw.index };
  }
  // Заказы v0.15 не содержали дополнительных полей.
  return { type: raw.type, targetId: raw.targetId };
}

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
  const job = readJob(raw?.job);
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
// Несколько разных, проходимых адресов; каждый следующий расположен недалеко
// от предыдущего. Список и текущий шаг сохраняются, чтобы перезапуск не платил
// повторно и не сбрасывал уже выполненные этапы.
export function chooseWorkStops(type, origin, entrances) {
  const job = own(JOBS, type) ? JOBS[type] : null;
  if (!job || !origin || !Array.isArray(entrances)) return [];
  const used = new Set([origin.id]), result = [];
  let from = origin;
  for (let step = 0; step < 3; step++) {
    const pool = entrances.filter(d => !used.has(d.id) && (!job.kind || d.kind === job.kind))
      .map(d => ({ d, dist: Math.hypot(d.x - from.x, d.z - from.z) }))
      .sort((a, b) => a.dist - b.dist || a.d.id - b.d.id);
    const near = pool.filter(x => x.dist >= 35 && x.dist <= 140);
    const choices = near.length ? near : pool;
    if (!choices.length) return [];
    const pick = choices[(origin.id + step * 7) % Math.min(5, choices.length)].d;
    result.push(pick); used.add(pick.id); from = pick;
  }
  return result;
}

export function acceptJob(life, type, origin, entrances) {
  if (life.job) return { ok: false, message: 'Сначала выполните или отмените текущий заказ' };
  if (!own(JOBS, type) || !origin || !Array.isArray(entrances)) return { ok: false, message: 'Сейчас нет подходящего задания' };
  if (type === 'route' || type === 'cleanup') {
    const targets = chooseWorkStops(type, origin, entrances).map(d => d.id);
    if (targets.length !== 3) return { ok: false, message: 'Сейчас нет подходящих адресов' };
    life.job = { type, targets, index: 0, targetId: targets[0] };
    return { ok: true, message: type === 'cleanup' ? 'Работа принята. Соберите три мешка у жёлтых меток' : 'Маршрут принят. Доставьте три посылки по жёлтым меткам' };
  }
  const target = chooseJobTarget(type, origin, entrances);
  if (!target) return { ok: false, message: 'Сейчас нет подходящего адреса' };
  if (type === 'taxi') {
    const destination = chooseJobTarget('taxi', target, entrances);
    if (!destination || destination.id === target.id) return { ok: false, message: 'Сейчас нет подходящего маршрута' };
    life.job = { type, targetId: target.id, pickupId: target.id, destinationId: destination.id, stage: 'pickup' };
    return { ok: true, message: 'Заказ такси принят. Подъедьте на машине к пассажиру' };
  }
  life.job = { type, targetId: target.id };
  return { ok: true, message: 'Заказ принят. Жёлтая метка на карте — адрес доставки' };
}

export function jobPoint(job, door) {
  if (!job || !door) return null;
  // Мешок расположен у выхода на тротуар, а не внутри стены или помещения.
  return job.type === 'cleanup' ? { x: door.x + door.nx * 0.8, z: door.z + door.nz * 0.8 } : door;
}
export function jobInstruction(job) {
  if (!job || !own(JOBS, job.type)) return '';
  if (job.type === 'taxi') return job.stage === 'pickup' ? 'На машине подъедьте к пассажиру' : 'Отвезите пассажира к жёлтой метке';
  if (job.type === 'route') return `Доставка ${job.index + 1}/3 · жёлтая метка`;
  if (job.type === 'cleanup') return `Мешок ${job.index + 1}/3 · подойдите пешком`;
  return 'Доставьте заказ к жёлтой метке';
}
export function boardTaxi(life, door) {
  const job = life.job;
  if (!job || job.type !== 'taxi' || job.stage !== 'pickup' || job.targetId !== door?.id) return { ok: false, message: 'Пассажир не здесь' };
  job.stage = 'drive'; job.targetId = job.destinationId;
  return { ok: true, message: 'Пассажир садится. Отвезите его к жёлтой метке' };
}
function finishWork(save, job) {
  const reward = JOBS[job.type].reward;
  save.money = Math.round((save.money + reward) * 100) / 100;
  save.life.job = null; save.life.completedJobs++;
  return { ok: true, complete: true, message: `Работа выполнена! +$ ${reward}` };
}
export function completeTaxi(save, door) {
  const job = save.life.job;
  if (!job || job.type !== 'taxi' || job.stage !== 'drive' || job.targetId !== door?.id) return { ok: false, message: 'Это не адрес пассажира' };
  return finishWork(save, job);
}
export function completeJob(save, door) {
  const job = save.life.job;
  if (!job || job.type === 'taxi' || job.targetId !== door?.id || !own(JOBS, job.type)) return { ok: false, message: 'Это не адрес задания' };
  if (job.type === 'route' || job.type === 'cleanup') {
    const completed = job.index + 1;
    if (completed < job.targets.length) {
      job.index = completed; job.targetId = job.targets[completed];
      return { ok: true, complete: false, message: `${job.type === 'route' ? 'Доставлено' : 'Собрано'} ${completed}/3. Следующая жёлтая метка на карте` };
    }
  }
  return finishWork(save, job);
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
