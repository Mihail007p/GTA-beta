// Где тратится кадр (SwiftShader — относительные цифры!): полный кадр vs без трафика / без машины / без теней / краска Standard.
import { chromium } from 'playwright';
const q = process.argv[2] || 'auto';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 370 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8080/?shot&noaudio');
await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 120000 });
await page.evaluate(() => document.getElementById('btn-play').click());
await new Promise(r => setTimeout(r, 1500));
const res = await page.evaluate(async (q) => {
  const G = window.__game, R = G.R;
  G.setState('pause');                 // останавливаем цикл: рендерим сами
  R.setQuality(q);
  const gl = R.renderer.getContext();
  const t = (n = 6) => { R.render(); gl.finish(); const t0 = performance.now(); for (let i = 0; i < n; i++) { R.render(); gl.finish(); } return +((performance.now() - t0) / n).toFixed(1); };
  const out = { quality: q, scale: R.scale, shadows: R.renderer.shadowMap.enabled };
  out.full = t(); out.calls = R.renderer.info.render.calls; out.tris = R.renderer.info.render.triangles;
  const tv = R.tTypes.map(m => m.visible); R.tTypes.forEach(m => m.visible = false);
  out.noTraffic = t(); R.tTypes.forEach((m, i) => m.visible = tv[i]);
  R.playerMesh.visible = false; out.noCar = t(); R.playerMesh.visible = true;
  const sh = R.renderer.shadowMap.enabled; R.renderer.shadowMap.enabled = false; R.sun.castShadow = false; R.scene.traverse(o => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(m => m.needsUpdate = true); } }); t(2);
  out.noShadows = t(); R.renderer.shadowMap.enabled = sh; R.sun.castShadow = sh; R.scene.traverse(o => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(m => m.needsUpdate = true); } }); t(2);
  // краска кузова: Physical (clearcoat) → Standard
  let paint = null; R.playerMesh.traverse(o => { if (o.isMesh && o.material && o.material.isMeshPhysicalMaterial && !paint) paint = o.material; });
  if (paint) { const cc = paint.clearcoat; paint.clearcoat = 0; paint.needsUpdate = true; t(2); out.noClearcoat = t(); paint.clearcoat = cc; paint.needsUpdate = true; }
  out.carTris = 0; R.playerMesh.traverse(o => { if (o.isMesh) out.carTris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  out.carTris = Math.round(out.carTris);
  return out;
}, q);
console.log(JSON.stringify(res));
await browser.close();
