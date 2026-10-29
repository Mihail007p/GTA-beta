// ============================================================================
//  GAMEPLAY — ядро игрового цикла свободной езды.
//  ЧИСТАЯ ЛОГИКА (тестируется в Node).
//
//  Цикл:
//  • Свободная езда без поражений. По городу всегда горят 3 чекпоинта.
//  • Собрал чекпоинт → началась ЦЕПОЧКА с таймером. Каждый следующий
//    чекпоинт добавляет время и растит множитель (x1 → x8).
//    Не успел — цепочка просто обнуляется (без «game over»).
//  • Дрифт копит серию очков; серия засчитывается, когда выходишь из заноса,
//    и сгорает, если врезался. Риск/награда — главное топливо аркады.
//  • Рискованный пролёт рядом с машиной трафика (без касания) = бонус.
//  • Деньги — за метры (на скорости больше), чекпоинты, дрифт, пролёты.
//    Деньги открывают машины в гараже.
// ============================================================================
import { makeRng } from './rng.js';

export function makeGameplay(cfg, city, seed, startPos) {
  const rng = makeRng(seed || 99991);
  const g = {
    cfg, city, rng,
    checkpoints: [],
    score: 0,
    combo: 1,
    chain: 0,
    bestChain: 0,
    timeLeft: 0,          // таймер цепочки (идёт только при chain > 0)
    moneyEarned: 0,
    nearMiss: 0,
    drift: { active: false, points: 0, time: 0, grace: 0 },
    events: [],           // {type, text, value, life, maxLife} — всплывашки HUD
    runTime: 0,
    _lastX: startPos ? startPos.x : null,
    _lastZ: startPos ? startPos.z : null,
    _nextId: 1,
  };
  const p = startPos || city.start;
  for (let i = 0; i < cfg.checkpointCount; i++) spawnCheckpoint(g, p);
  return g;
}

function pushEvent(g, type, text, value) {
  const life = type === 'chainend' ? 2.2 : 1.6;
  g.events.push({ type, text, value, life, maxLife: life });
  if (g.events.length > 5) g.events.shift();
}

/**
 * Спавн чекпоинта на полосе дороги в кольце [spawnMin, spawnMax] от игрока
 * и не ближе 40 м к другим активным чекпоинтам.
 */
export function spawnCheckpoint(g, player) {
  const city = g.city, rng = g.rng, cfg = g.cfg;
  const lo = city.roadAt(0) + 10, hi = city.roadAt(city.grid) - 10;
  const want = cfg.spawnMin + rng() * (cfg.spawnMax - cfg.spawnMin);
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rc = city.roadAt(rng.int(0, city.grid));
    const along = lo + rng() * (hi - lo);
    const side = rng() < 0.5 ? 1 : -1;
    const vertical = rng() < 0.5;
    const x = vertical ? rc + side * city.lane : along;
    const z = vertical ? along : rc + side * city.lane;
    const d = Math.hypot(x - player.x, z - player.z);
    if (d < cfg.spawnMin * 0.8 || d > cfg.spawnMax * 1.25) continue;
    let crowded = false;
    for (const o of g.checkpoints) {
      if (Math.hypot(o.x - x, o.z - z) < 40) { crowded = true; break; }
    }
    if (crowded) continue;
    const score = Math.abs(d - want);
    if (!best || score < best.score) best = { x, z, score };
  }
  if (!best) {
    // фолбэк: ближайший перекрёсток в стороне от игрока (всегда на дороге)
    const k = Math.max(0, Math.min(city.grid, Math.round((player.x - city.roadAt(0)) / city.pitch) + (rng() < 0.5 ? 2 : -2)));
    const k2 = Math.max(0, Math.min(city.grid, Math.round((player.z - city.roadAt(0)) / city.pitch)));
    best = { x: city.roadAt(Math.max(0, Math.min(city.grid, k))), z: city.roadAt(k2) };
  }
  const cp = { x: best.x, z: best.z, collected: false, age: 0, id: g._nextId++ };
  g.checkpoints.push(cp);
  return cp;
}

/**
 * Главный апдейт.
 * car — состояние машины игрока; trafficCars — массив трафика;
 * impact — сила самого сильного удара за этот кадр (м/с), 0 если не было.
 */
export function updateGameplay(g, dt, car, trafficCars, impact = 0) {
  const cfg = g.cfg;
  const out = {
    collected: [], money: 0, score: 0, nearMiss: 0,
    driftBanked: 0, driftLost: false, chainEnded: false,
  };
  g.runTime += dt;
  const absSpeed = Math.hypot(car.vx, car.vz);

  // ---- таймер цепочки ----------------------------------------------------
  if (g.chain > 0) {
    g.timeLeft -= dt;
    if (g.timeLeft <= 0) {
      g.timeLeft = 0;
      pushEvent(g, 'chainend', 'ЦЕПОЧКА ОБОРВАЛАСЬ', g.chain);
      g.chain = 0;
      g.combo = 1;
      out.chainEnded = true;
    }
  }

  // ---- чекпоинты ---------------------------------------------------------
  const r2 = cfg.checkpointRadius * cfg.checkpointRadius;
  for (const cp of g.checkpoints) {
    cp.age += dt;
    const dx = car.x - cp.x, dz = car.z - cp.z;
    if (dx * dx + dz * dz < r2) {
      cp.collected = true;
      out.collected.push(cp);
      g.chain++;
      if (g.chain > g.bestChain) g.bestChain = g.chain;
      g.combo = Math.min(cfg.comboMax, 1 + Math.floor((g.chain - 1) / 2));
      g.timeLeft = g.chain === 1
        ? cfg.checkpointTime * 1.3
        : Math.min(cfg.maxChainTime, g.timeLeft + cfg.checkpointTime);
      const pts = cfg.checkpointScore * g.combo;
      const mon = cfg.checkpointMoney * g.combo;
      g.score += pts;
      g.moneyEarned += mon;
      out.score += pts;
      out.money += mon;
      pushEvent(g, 'checkpoint', g.combo > 1 ? `ЧЕКПОИНТ  x${g.combo}` : 'ЧЕКПОИНТ', pts);
    }
  }
  if (out.collected.length) {
    g.checkpoints = g.checkpoints.filter(c => !c.collected);
    while (g.checkpoints.length < cfg.checkpointCount) spawnCheckpoint(g, car);
  }

  // ---- дрифт-серия -------------------------------------------------------
  const D = g.drift;
  const drifting = car.drifting && absSpeed > cfg.driftMinSpeed;
  if (impact > cfg.driftCrashImpact && D.active) {
    if (D.points >= 50) pushEvent(g, 'driftlost', 'ДРИФТ СОРВАН', Math.round(D.points));
    D.active = false; D.points = 0; D.time = 0; D.grace = 0;
    out.driftLost = true;
  } else if (drifting) {
    if (!D.active) { D.active = true; D.points = 0; D.time = 0; }
    D.grace = cfg.driftGrace;
    D.time += dt;
    // очки растут со скоростью и углом заноса
    const angleK = 0.6 + Math.min(1, Math.abs(car.slip || 0) / 0.6) * 0.8;
    const speedK = absSpeed / 20;
    D.points += cfg.driftScorePerSec * angleK * speedK * dt;
  } else if (D.active) {
    D.grace -= dt;
    if (D.grace <= 0) {
      const pts = Math.round(D.points * g.combo);
      if (pts >= 30) {
        g.score += pts;
        const mon = pts * cfg.moneyPerDriftPoint;
        g.moneyEarned += mon;
        out.score += pts;
        out.money += mon;
        out.driftBanked = pts;
        pushEvent(g, 'drift', D.time > 2.5 ? 'СУПЕР ДРИФТ' : 'ДРИФТ', pts);
      }
      D.active = false; D.points = 0; D.time = 0;
    }
  }

  // ---- деньги за дистанцию (на скорости — больше) ------------------------
  if (g._lastX === null) { g._lastX = car.x; g._lastZ = car.z; }
  const distDelta = Math.hypot(car.x - g._lastX, car.z - g._lastZ);
  g._lastX = car.x; g._lastZ = car.z;
  if (distDelta < 5) {   // защита от телепорта (сброс машины)
    const speedBonus = 1 + Math.max(0, (absSpeed - 25) / 25);
    const distMoney = distDelta * cfg.moneyPerMeter * speedBonus;
    g.moneyEarned += distMoney;
    out.money += distMoney;
  }

  // ---- рискованные пролёты мимо трафика ----------------------------------
  // Засчитываются на ВЫХОДЕ из опасной зоны и только если не было касания.
  if (trafficCars) {
    const nm2 = cfg.nearMissDist * cfg.nearMissDist;
    const exit2 = (cfg.nearMissDist + 1.2) * (cfg.nearMissDist + 1.2);
    for (const t of trafficCars) {
      if (!t.alive || t.playerControlled) continue;
      const dx = car.x - t.x, dz = car.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nm2) {
        if (absSpeed > cfg.nearMissMinSpeed) {
          // относительная скорость — обгон «впритирку» ползком не считается
          const rvx = car.vx - Math.cos(t.heading) * t.speed;
          const rvz = car.vz - Math.sin(t.heading) * t.speed;
          if (Math.hypot(rvx, rvz) > 7) t._nearT = (t._nearT || 0) + dt;
        }
      } else if (d2 > exit2 && t._nearT > 0) {
        if (!(t._hitT > 0)) {
          g.nearMiss++;
          const pts = cfg.nearMissScore * g.combo;
          g.score += pts;
          const mon = cfg.nearMissMoney * g.combo;
          g.moneyEarned += mon;
          out.score += pts;
          out.money += mon;
          out.nearMiss++;
          pushEvent(g, 'nearmiss', 'НА ВОЛОСКЕ!', pts);
        }
        t._nearT = 0;
      }
    }
  }

  // ---- затухание надписей ------------------------------------------------
  for (const e of g.events) e.life -= dt;
  if (g.events.length && g.events[0].life <= 0) g.events = g.events.filter(e => e.life > 0);

  out.moneyEarned = g.moneyEarned;
  return out;
}

/** Ближайший активный чекпоинт к точке и расстояние до него */
export function nearestCheckpoint(g, x, z) {
  let best = null, bd = Infinity;
  for (const cp of g.checkpoints) {
    const d = Math.hypot(cp.x - x, cp.z - z);
    if (d < bd) { bd = d; best = cp; }
  }
  return best ? { cp: best, dist: bd } : null;
}
