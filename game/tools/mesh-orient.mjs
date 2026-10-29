// Удаление двусторонних дублей с согласованной ориентацией граней.
// tri — индексы исходных вершин (тройками), wid — сварные id по позиции для каждой исходной вершины.
// Возвращает { idx: Uint32Array, removed }.
export function dedupOriented(idx, wid) {
  const T = idx.length / 3;
  const faces = new Map();            // ключ (сорт. сварные id) → массив номеров треугольников
  for (let t = 0; t < T; t++) {
    const a = wid[idx[t * 3]], b = wid[idx[t * 3 + 1]], c = wid[idx[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;   // вырожденные
    const k = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : (a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`);
    let f = faces.get(k); if (!f) faces.set(k, f = []); f.push(t);
  }
  const list = [...faces.values()];
  const dupCount = list.reduce((s, f) => s + (f.length > 1 ? 1 : 0), 0);
  if (dupCount < list.length * 0.25) return null;   // модель не двусторонняя — ничего не делаем
  const F = list.length;
  const fv = new Int32Array(F * 3);   // выбранная ориентация (сварные id)
  for (let i = 0; i < F; i++) { const t = list[i][0]; fv[i * 3] = wid[idx[t * 3]]; fv[i * 3 + 1] = wid[idx[t * 3 + 1]]; fv[i * 3 + 2] = wid[idx[t * 3 + 2]]; }
  const edges = new Map();            // неориентированное ребро → грани
  for (let i = 0; i < F; i++) for (let e = 0; e < 3; e++) {
    const u = fv[i * 3 + e], v = fv[i * 3 + (e + 1) % 3];
    const k = u < v ? u * 4194304 + v : v * 4194304 + u;
    let l = edges.get(k); if (!l) edges.set(k, l = []); l.push(i);
  }
  const want = new Int8Array(F);      // 0 — не посещена, 1 — как есть, -1 — перевернуть
  const hasDir = (i, u, v) => { for (let e = 0; e < 3; e++) if (fv[i * 3 + e] === u && fv[i * 3 + (e + 1) % 3] === v) return true; return false; };
  const queue = new Int32Array(F);
  for (let s = 0; s < F; s++) {
    if (want[s]) continue;
    want[s] = 1; let qh = 0, qt = 0; queue[qt++] = s;
    while (qh < qt) {
      const i = queue[qh++];
      for (let e = 0; e < 3; e++) {
        let u = fv[i * 3 + e], v = fv[i * 3 + (e + 1) % 3];
        if (want[i] < 0) { const tmp = u; u = v; v = tmp; }   // фактическое направление ребра у грани i
        const k = u < v ? u * 4194304 + v : v * 4194304 + u;
        const nb = edges.get(k);
        if (!nb || nb.length !== 2) continue;            // только манифолдные рёбра
        const j = nb[0] === i ? nb[1] : nb[0];
        if (want[j]) continue;
        // сосед должен проходить ребро в обратную сторону: v→u
        want[j] = hasDir(j, v, u) ? 1 : -1;
        queue[qt++] = j;
      }
    }
  }
  const out = new Uint32Array(F * 3);
  for (let i = 0; i < F; i++) {
    const cands = list[i];
    // желаемый порядок сварных id
    const a = fv[i * 3], b = want[i] < 0 ? fv[i * 3 + 2] : fv[i * 3 + 1], c = want[i] < 0 ? fv[i * 3 + 1] : fv[i * 3 + 2];
    let pick = cands[0], pickFlip = want[i] < 0;
    for (const t of cands) {
      const x = wid[idx[t * 3]], y = wid[idx[t * 3 + 1]], z = wid[idx[t * 3 + 2]];
      const same = (x === a && y === b && z === c) || (y === a && z === b && x === c) || (z === a && x === b && y === c);
      if (same) { pick = t; pickFlip = false; break; }
    }
    const t = pick;
    out[i * 3] = idx[t * 3];
    out[i * 3 + 1] = pickFlip ? idx[t * 3 + 2] : idx[t * 3 + 1];
    out[i * 3 + 2] = pickFlip ? idx[t * 3 + 1] : idx[t * 3 + 2];
  }
  return { idx: out, removed: T - F };
}
