// ============================================================================
//  RENDERER — весь 3D-слой игры (Three.js r169).
//
//  СТРАТЕГИЯ ПОД HELIO G85 (Mali-G52 MC2):
//   • Инстансинг всего повторяющегося. Здания порезаны на чанки → отсечение
//     по пирамиде камеры и по зоне теней; внутри чанка THREE сортирует
//     спереди-назад → ранний Z-тест отбрасывает закрытые пиксели.
//   • Мир — MeshLambert (дёшево), машины — Standard/Physical с картой
//     отражений (PMREM, генерируется один раз).
//   • Свет фар и фонарей — аддитивные «пятна», а не настоящие источники:
//     настоящий SpotLight удорожал бы КАЖДЫЙ пиксель сцены.
//   • Небо рисуется последним с depth-test: закрытые домами пиксели не красятся.
//   • Одна карта теней 1024, привязана к игроку со снапом к текселю (без мерцания).
//   • Адаптивное разрешение рендера по реальному FPS.
// ============================================================================
import * as THREE from '../vendor/three.js';
import { CONFIG } from './config.js';
import { buildTextures, TEX } from './textures.js';
import { buildCarMesh, animateCar, disposeCarMesh, preloadCarModel, loadGLTF } from './car-model.js';
import { TRAFFIC_TYPES } from './traffic-types.js';
import { makeRng } from './rng.js';
import { wrapAngle, dampAngle, damp } from './car-physics.js';
import { createHero } from './hero-model.js';
import { characterById } from './characters.js';

const BUILDING_TINTS = [0xb8b2a8, 0xa39e98, 0xc4b8a4, 0x9aa3ad, 0xb5a08f, 0x8f98a3, 0xcfc6b6, 0xa8988a];
const TRAFFIC_COLORS = [0xd0d4da, 0x2e353d, 0xa8382f, 0x2f5d8a, 0xe2dccc, 0x50565e];

// Палитра «золотого часа»: тёплый низкий свет, холодные тени, синее небо в зените.
const SKY = {
  zenith: '#0f1a3a', upper: '#28407a', mid: '#5b6c9c', horizonHigh: '#c08a78',
  horizon: '#f0a66a', below: '#8c7a78',
};
const FOG_COLOR = 0x9a8c8e;

export class Renderer {
  constructor(canvas, opts = {}) {
    this.cfg = CONFIG.render;
    this.canvas = canvas;
    this.quality = opts.quality || 'auto';

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.cfg.antialias,
      powerPreference: this.cfg.powerPreference,
      alpha: false,
      stencil: false,
      depth: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    this.renderer.setPixelRatio(1);            // разрешением управляем сами (scale)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = true;

    this.scale = this.quality === 'high' ? this.cfg.maxScale
      : this.quality === 'low' ? this.cfg.minScale + 0.08 : this.cfg.startScale;
    this._w = 2; this._h = 2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.Fog(FOG_COLOR, this.cfg.fogNear, this.cfg.fogFar);

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 16 / 9, CONFIG.camera.near, CONFIG.camera.far);
    this.camera.position.set(0, 5, -10);

    this.maxAniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    buildTextures(this.maxAniso);

    this._tmp = {
      m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(),
      v: new THREE.Vector3(), v2: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1),
      col: new THREE.Color(),
    };

    this.windowUniforms = {
      uWindowGlow: { value: 0.85 },
      uLitThreshold: { value: 0.66 },
    };

    this.buildSky();
    this.buildLights();
    this.buildEnvironment();

    // камера
    this.camYaw = 0;
    this.camDist = CONFIG.camera.distBase;
    this.camHeight = CONFIG.camera.heightBase;
    this.driveLookYaw = 0; this.driveLookHeight = 0;
    this._camClip = 99;
    this.camHash = null;
    this._camInit = false;
    this.orbit = null;          // режим витрины (меню/гараж)
    this.heroActor = null; this.heroId = null; this.heroVisible = false; this._heroRequest = 0;

    // perf
    this.frames = 0;
    this.fpsAccum = 0;
    this.fps = 60;
    this.drawCalls = 0;
    this.triangles = 0;
    this._scaleCooldown = 2.0;
    this._ceiling = this.cfg.maxScale;
    this._ceilingTimer = 0;
  }

  // ------------------------------------------------------------------ НЕБО --
  buildSky() {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const g = c.getContext('2d');
    // canvas y=0 — зенит, y=128 — горизонт (экватор сферы), ниже — под землёй
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0.00, SKY.zenith);
    grd.addColorStop(0.20, SKY.upper);
    grd.addColorStop(0.36, SKY.mid);
    grd.addColorStop(0.45, SKY.horizonHigh);
    grd.addColorStop(0.50, SKY.horizon);
    grd.addColorStop(0.56, SKY.below);
    grd.addColorStop(1.00, SKY.below);
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.skyTex = tex;

    const geo = new THREE.SphereGeometry(CONFIG.camera.far * 0.9, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = 1000;     // последним среди непрозрачных: закрытое домами не красим
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  // ----------------------------------------------------------------- СВЕТ ---
  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xa8c0e8, 0x5a4a3c, 2.7);
    this.scene.add(this.hemi);

    this.sunOffset = new THREE.Vector3(-75, 80, 45);   // ~42° над горизонтом: длинные тени, но улицы не тонут в тени
    this.sun = new THREE.DirectionalLight(0xffcf9a, 3.4);
    this.sun.position.copy(this.sunOffset);
    this.sun.castShadow = this.renderer.shadowMap.enabled;
    const s = this.cfg.shadowBox;
    const sc = this.sun.shadow.camera;
    sc.left = -s; sc.right = s; sc.top = s; sc.bottom = -s;
    sc.near = 1; sc.far = 300;
    this.sun.shadow.mapSize.set(this.cfg.shadowMapSize, this.cfg.shadowMapSize);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // базис пространства света — для снапа теней к текселю
    const f = this.sunOffset.clone().negate().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    this._lightRight = new THREE.Vector3().crossVectors(f, up).normalize();
    this._lightUp = new THREE.Vector3().crossVectors(this._lightRight, f).normalize();
    this._lightFwd = f;

    this.fill = new THREE.DirectionalLight(0x8fa8d8, 0.6);
    this.fill.position.set(60, 40, -50);
    this.scene.add(this.fill);
  }

  /** Карта отражений для машин: небо + огни города, один раз через PMREM */
  buildEnvironment() {
    const envScene = new THREE.Scene();
    const skyMat = new THREE.MeshBasicMaterial({ map: this.skyTex, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 24, 16), skyMat));
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(49, 24),
      new THREE.MeshBasicMaterial({ color: 0x23242a })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    // силуэты домов с огнями по кругу — отражения «города» на кузове
    const rng = makeRng(77);
    const bMat = new THREE.MeshBasicMaterial({ color: 0x2c2f38 });
    const wMat = new THREE.MeshBasicMaterial({ color: 0xffc078 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const h = rng.range(8, 26);
      const b = new THREE.Mesh(new THREE.BoxGeometry(rng.range(6, 12), h, 4), bMat);
      b.position.set(Math.cos(a) * 40, h / 2 - 2, Math.sin(a) * 40);
      b.lookAt(0, h / 2 - 2, 0);
      envScene.add(b);
      if (rng.chance(0.7)) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(rng.range(2, 5), rng.range(1, 4)), wMat);
        w.position.set(Math.cos(a) * 37.8, rng.range(2, h - 3), Math.sin(a) * 37.8);
        w.lookAt(0, w.position.y, 0);
        envScene.add(w);
      }
    }
    // яркое солнце
    const sunDisk = new THREE.Mesh(new THREE.SphereGeometry(3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff0d0 }));
    sunDisk.position.copy(this.sunOffset).normalize().multiplyScalar(45);
    envScene.add(sunDisk);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();
    envScene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== skyMat) o.material.dispose(); });
    skyMat.dispose();
  }

  // ---------------------------------------------------------------- ГОРОД ---
  buildCity(city) {
    this.city = city;
    this.buildGround(city);
    this.buildBuildings(city);
    this.buildSidewalks(city);
    this.buildRoadMarkings(city);
    this.buildLamps(city);
    this.buildTrees(city);
    this.buildSkids();
    this.buildParticles();
    this.buildCheckpointRing();
  }

  buildGround(city) {
    const size = city.extent + 560;
    const asphalt = TEX.asphalt.clone();
    asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping;
    asphalt.repeat.set(size / 10, size / 10);
    asphalt.needsUpdate = true;
    const asphaltN = TEX.asphaltNormal.clone();
    asphaltN.wrapS = asphaltN.wrapT = THREE.RepeatWrapping;
    asphaltN.repeat.copy(asphalt.repeat);
    asphaltN.needsUpdate = true;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshLambertMaterial({
        map: asphalt, normalMap: asphaltN, normalScale: new THREE.Vector2(0.55, 0.55),
      })
    );
    ground.material.color.setRGB(1.85, 1.78, 1.70);    // линейный множитель > 1: текстура тёмная
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(city.origin + city.extent / 2, 0, city.origin + city.extent / 2);
    ground.receiveShadow = true;
    ground.renderOrder = 2;          // после домов и тротуаров → ранний Z отбрасывает закрытое
    ground.matrixAutoUpdate = false;
    ground.updateMatrix();
    this.scene.add(ground);
  }

  /** Материал фасада: окна в мировых метрах + процедурно горящие окна и витрины */
  makeFacadeMaterial() {
    const tex = TEX.facadeTile;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshLambertMaterial({ map: tex, color: 0xffffff });
    const U = this.windowUniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindowGlow = U.uWindowGlow;
      shader.uniforms.uLitThreshold = U.uLitThreshold;
      const hash = `
        float osHash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec2 vFacadeUv;
          varying float vRoof;
          varying float vSeed;
          ${hash}`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          #ifdef USE_INSTANCING
            float sX = length(instanceMatrix[0].xyz);
            float sY = length(instanceMatrix[1].xyz);
            float sZ = length(instanceMatrix[2].xyz);
            vec2 iPos = instanceMatrix[3].xz;
          #else
            float sX = 1.0; float sY = 1.0; float sZ = 1.0;
            vec2 iPos = vec2(0.0);
          #endif
          float faceW = abs(normal.x) > 0.5 ? sZ : sX;
          float cols = max(1.0, floor(faceW / 3.3 + 0.5));
          float floors = max(1.0, floor(sY / 3.4 + 0.5));
          vRoof = abs(normal.y) > 0.5 ? 1.0 : 0.0;
          vFacadeUv = vec2(uv.x * cols, uv.y * floors);
          if (vRoof > 0.5) vFacadeUv = vec2(0.04, 0.04);
          #ifdef USE_MAP
            vMapUv = vFacadeUv * 0.25;
          #endif
          vSeed = floor(osHash12(iPos * 0.37 + normal.xz * 7.1) * 97.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vFacadeUv;
          varying float vRoof;
          varying float vSeed;
          uniform float uWindowGlow;
          uniform float uLitThreshold;
          ${hash}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec2 cellC = floor(vFacadeUv);
            vec2 fC = fract(vFacadeUv);
            float shopC = (1.0 - step(1.0, cellC.y)) * (1.0 - vRoof);
            // первый этаж — витрина: большое тёмное стекло с импостом посередине
            float inShopC = step(0.06, fC.x) * step(fC.x, 0.94) * step(0.10, fC.y) * step(fC.y, 0.80);
            float mull = step(0.485, fC.x) * step(fC.x, 0.515);
            vec3 glass = mix(vec3(0.03, 0.035, 0.045), vec3(0.08, 0.10, 0.13), fC.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, shopC * inShopC * (1.0 - mull));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.20, 0.205, 0.22), vRoof);
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec2 cell = floor(vFacadeUv);
            vec2 f = fract(vFacadeUv);
            float notRoof = 1.0 - vRoof;
            float shop = (1.0 - step(1.0, cell.y)) * notRoof;
            float upper = notRoof - shop;
            // зерно — целое; округляем, т.к. интерполяция varying даёт ~1e-6 погрешности,
            // а хэш её многократно усиливает (была «рябь» по пикселям)
            float seed = floor(vSeed + 0.5);
            float h = osHash12(cell + vec2(seed, seed * 1.37));
            float h2 = fract(h * 17.31);
            float h3 = fract(h * 31.77);
            // окна этажей: тёплый свет, у потолка ярче (лампы), у подоконника темнее
            float inWin = step(0.16, f.x) * step(f.x, 0.84) * step(0.18, f.y) * step(f.y, 0.80);
            float isLit = step(uLitThreshold, h);
            float gy = clamp((f.y - 0.18) / 0.62, 0.0, 1.0);
            vec3 wc = mix(vec3(1.0, 0.60, 0.28), vec3(0.62, 0.78, 1.0), step(0.82, h2));
            vec3 em = wc * (inWin * upper * isLit) * (0.30 + 0.70 * h3) * (0.50 + 0.50 * gy);
            // тёмное стекло: слабый отблеск неба
            em += vec3(0.016, 0.024, 0.038) * (inWin * upper * (1.0 - isLit)) * (0.3 + gy);
            // витрины
            float inShop = step(0.06, f.x) * step(f.x, 0.94) * step(0.10, f.y) * step(f.y, 0.80);
            float gs = clamp((f.y - 0.10) / 0.70, 0.0, 1.0);
            vec3 sc = mix(vec3(1.0, 0.70, 0.40), vec3(0.75, 0.85, 1.0), step(0.8, h2));
            em += sc * (inShop * shop * step(0.45, h)) * (0.08 + 0.26 * gs * gs) * (0.6 + 0.4 * h3);
            // вывески над витринами
            float inSign = step(0.10, f.x) * step(f.x, 0.90) * step(0.84, f.y) * step(f.y, 0.95) * shop * step(0.55, h3);
            vec3 signC = h2 < 0.25 ? vec3(1.0, 0.22, 0.18) : (h2 < 0.5 ? vec3(0.22, 0.55, 1.0) : (h2 < 0.75 ? vec3(0.25, 1.0, 0.45) : vec3(1.0, 0.82, 0.25)));
            em += signC * inSign * 0.85;
            // вдали ячейка окна меньше пикселя → заменяем узор средним (без мерцания)
            float fw = max(fwidth(vFacadeUv.x), fwidth(vFacadeUv.y));
            em = mix(em, vec3(0.075, 0.048, 0.026) * upper + vec3(0.06, 0.045, 0.03) * shop, smoothstep(0.35, 0.9, fw));
            totalEmissiveRadiance += em * uWindowGlow;
          }`);
    };
    mat.customProgramCacheKey = () => 'facade-v3';
    return mat;
  }

  buildBuildings(city) {
    const bld = city.buildings;
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    boxGeo.translate(0, 0.5, 0);           // опорная точка — низ коробки
    // нижняя грань никогда не видна — выкидываем её (−2 треугольника на дом)
    const idx = boxGeo.index.array;
    const keep = [];
    for (let g = 0; g < boxGeo.groups.length; g++) {
      if (g === 3) continue;               // группа 3 = грань −Y у BoxGeometry
      const gr = boxGeo.groups[g];
      for (let k = gr.start; k < gr.start + gr.count; k++) keep.push(idx[k]);
    }
    boxGeo.setIndex(keep);
    boxGeo.clearGroups();

    this.facadeMat = this.makeFacadeMaterial();
    this.buildingBoxGeo = boxGeo;

    // чанки по 3×3 квартала: отсечение камерой и зоной теней
    const chunkSize = city.pitch * 3;
    const chunks = new Map();
    for (let i = 0; i < bld.length; i++) {
      const b = bld[i];
      const k = Math.floor((b.x - city.origin) / chunkSize) + ',' + Math.floor((b.z - city.origin) / chunkSize);
      let arr = chunks.get(k);
      if (!arr) { arr = []; chunks.set(k, arr); }
      arr.push(b);
    }
    const M = this._tmp.m, col = this._tmp.col;
    this.buildingChunks = [];
    for (const arr of chunks.values()) {
      const mesh = new THREE.InstancedMesh(boxGeo, this.facadeMat, arr.length);
      mesh.castShadow = true;
      mesh.receiveShadow = this.quality === 'high';
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        M.makeScale(b.hw * 2, b.h, b.hd * 2);
        M.setPosition(b.x, 0, b.z);
        mesh.setMatrixAt(i, M);
        col.setHex(BUILDING_TINTS[b.colorIdx % BUILDING_TINTS.length]);
        col.multiplyScalar(0.80 + (b.windowSeed % 100) / 400);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      mesh.renderOrder = 0;
      this.scene.add(mesh);
      this.buildingChunks.push(mesh);
    }
  }

  buildSidewalks(city) {
    const sw = TEX.sidewalk.clone();
    sw.wrapS = sw.wrapT = THREE.RepeatWrapping;
    sw.repeat.set(city.block / 3, city.block / 3);
    sw.needsUpdate = true;
    const mat = new THREE.MeshLambertMaterial({
      map: sw, normalMap: TEX.sidewalkNormal, normalScale: new THREE.Vector2(0.5, 0.5), color: 0xc9c2b6,
    });
    const geo = new THREE.BoxGeometry(1, 0.16, 1);
    geo.translate(0, 0.08, 0);
    const mesh = new THREE.InstancedMesh(geo, mat, city.blocks.length);
    mesh.receiveShadow = true;
    const M = this._tmp.m, col = this._tmp.col;
    for (let i = 0; i < city.blocks.length; i++) {
      const b = city.blocks[i];
      M.makeScale(b.hw * 2, 1, b.hd * 2);
      M.setPosition(b.cx, 0, b.cz);
      mesh.setMatrixAt(i, M);
      col.setHex(b.type === 'park' ? 0x6f8f58 : 0xffffff);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.renderOrder = 1;
    this.scene.add(mesh);
  }

  /** Разметка: пунктир по оси (без перекрёстков) + «зебры». Две геометрии = 2 draw call. */
  buildRoadMarkings(city) {
    const lo = city.roadAt(0) - city.road / 2;
    const hi = city.roadAt(city.grid) + city.road / 2;
    const half = city.road / 2;
    const inIntersection = (p) => {
      for (let k = 0; k <= city.grid; k++) if (Math.abs(p - city.roadAt(k)) < half + 1.5) return true;
      return false;
    };
    const quad = (arr, x0, z0, x1, z1, y) => {
      // против часовой при взгляде сверху → нормаль +Y
      arr.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
    };

    const dash = [];
    const dashLen = 3, gap = 4.5, w = 0.11;
    for (let i = 0; i <= city.grid; i++) {
      const c = city.roadAt(i);
      for (let p = lo; p < hi; p += dashLen + gap) {
        const mid = p + dashLen / 2;
        if (inIntersection(mid)) continue;
        quad(dash, c - w, p, c + w, p + dashLen, 0.012);         // вдоль Z
        quad(dash, p, c - w, p + dashLen, c + w, 0.012);         // вдоль X
      }
    }
    const zebra = [];
    const stripeW = 0.5, stripeGap = 0.55, depth = 2.6;
    for (let i = 0; i <= city.grid; i++) {
      for (let j = 0; j <= city.grid; j++) {
        const cx = city.roadAt(i), cz = city.roadAt(j);
        const edge = half + 0.6;   // зебра сразу за перекрёстком
        for (let s = -half + 0.6; s + stripeW <= half - 0.6; s += stripeW + stripeGap) {
          // на дорогах вдоль Z (поперёк — по X)
          quad(zebra, cx + s, cz - edge - depth, cx + s + stripeW, cz - edge, 0.013);
          quad(zebra, cx + s, cz + edge, cx + s + stripeW, cz + edge + depth, 0.013);
          // на дорогах вдоль X
          quad(zebra, cx - edge - depth, cz + s, cx - edge, cz + s + stripeW, 0.013);
          quad(zebra, cx + edge, cz + s, cx + edge + depth, cz + s + stripeW, 0.013);
        }
      }
    }
    const mk = (arr, color, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const n = new Float32Array(arr.length);
      for (let k = 1; k < n.length; k += 3) n[k] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        color, transparent: true, opacity, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      }));
      m.receiveShadow = true;
      m.renderOrder = 3;
      this.scene.add(m);
      return m;
    };
    mk(dash, 0xe8e2d0, 0.55);
    mk(zebra, 0xe6e2d8, 0.42);
    this.markingTris = (dash.length + zebra.length) / 9;
  }

  buildLamps(city) {
    const lamps = city.lamps;
    if (!lamps.length) return;
    const n = lamps.length;
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 6.2, 6, 1, true);
    poleGeo.translate(0, 3.1, 0);
    const armGeo = new THREE.BoxGeometry(0.08, 0.08, 1.6);
    armGeo.translate(0, 6.1, 0.8);
    const headGeo = new THREE.BoxGeometry(0.42, 0.12, 0.7);
    headGeo.translate(0, 6.02, 1.55);
    const poolGeo = new THREE.PlaneGeometry(9, 9);
    poolGeo.rotateX(-Math.PI / 2);

    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3e45 });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffe2b0 });   // светящийся плафон без расчёта света
    const poolMat = new THREE.MeshBasicMaterial({
      map: TEX.lightPool, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.30, color: 0xffd9a8,
    });

    this.lampPoles = new THREE.InstancedMesh(poleGeo, poleMat, n);
    this.lampArms = new THREE.InstancedMesh(armGeo, poleMat, n);
    this.lampHeads = new THREE.InstancedMesh(headGeo, headMat, n);
    this.lampPools = new THREE.InstancedMesh(poolGeo, poolMat, n);

    const M = this._tmp.m, q = this._tmp.q, v = this._tmp.v, one = this._tmp.one;
    for (let i = 0; i < n; i++) {
      const l = lamps[i];
      // локальный +Z кронштейна смотрит по диагонали на центр перекрёстка
      const dx = -l.ox, dz = -l.oz;
      q.setFromEuler(this._tmp.e.set(0, Math.atan2(dx, dz), 0));
      M.compose(v.set(l.x, 0.16, l.z), q, one);
      this.lampPoles.setMatrixAt(i, M);
      this.lampArms.setMatrixAt(i, M);
      this.lampHeads.setMatrixAt(i, M);
      // пятно света на асфальте под плафоном
      const len = Math.hypot(dx, dz) || 1;
      M.makeTranslation(l.x + (dx / len) * 1.6, 0.03, l.z + (dz / len) * 1.6);
      this.lampPools.setMatrixAt(i, M);
    }
    for (const m of [this.lampPoles, this.lampArms, this.lampHeads, this.lampPools]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      this.scene.add(m);
    }
    this.lampPools.renderOrder = 5;
  }

  buildTrees(city) {
    const trees = city.trees;
    if (!trees.length) return;
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.6, 5, 1, true);
    trunkGeo.translate(0, 1.3, 0);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2c });
    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);

    const leafGeo = new THREE.IcosahedronGeometry(1.6, 0);
    leafGeo.translate(0, 3.5, 0);
    const leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.leaves = new THREE.InstancedMesh(leafGeo, leafMat, trees.length);
    this.leaves.castShadow = true;

    const M = this._tmp.m, col = this._tmp.col;
    const rng = makeRng((city.seed || 1) + 5);
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const s = t.s;
      M.makeScale(s, s, s);
      M.setPosition(t.x, 0.16, t.z);
      this.trunks.setMatrixAt(i, M);
      M.makeScale(s * rng.range(0.85, 1.2), s * rng.range(0.8, 1.25), s * rng.range(0.85, 1.2));
      M.setPosition(t.x, 0.16, t.z);
      this.leaves.setMatrixAt(i, M);
      col.setHSL(0.24 + rng() * 0.07, 0.38, 0.24 + rng() * 0.08);
      this.leaves.setColorAt(i, col);
    }
    for (const m of [this.trunks, this.leaves]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      this.scene.add(m);
    }
    if (this.leaves.instanceColor) this.leaves.instanceColor.needsUpdate = true;
  }

  // --------------------------------------------------------------- ТРАФИК --
  /** Модели трафика (assets/traffic.glb). Без них buildTraffic построит простые коробки. */
  async loadTrafficModels(url = 'assets/traffic.glb') {
    try {
      const gltf = await loadGLTF(url);
      gltf.scene.updateMatrixWorld(true);
      const geos = {};
      const toFloat = (a) => {
        const out = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
        return new THREE.BufferAttribute(out, a.itemSize);
      };
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const src = o.geometry, g = new THREE.BufferGeometry();
        g.setAttribute('position', toFloat(src.attributes.position));
        g.setAttribute('normal', toFloat(src.attributes.normal));
        g.setAttribute('color', toFloat(src.attributes.color));
        g.setAttribute('paint', toFloat(src.attributes._paint));
        g.setAttribute('glow', toFloat(src.attributes._glow));
        g.setIndex(src.index);
        g.applyMatrix4(o.matrixWorld);      // снять квантование (масштаб/сдвиг узла)
        g.computeBoundingSphere();
        geos[o.name] = g;
        src.dispose();
      });
      this.trafficGeos = TRAFFIC_TYPES.every(t => geos[t.id]) ? geos : null;
    } catch (e) {
      console.warn('[renderer] модели трафика не загрузились — будут простые машины', e);
      this.trafficGeos = null;
    }
    return !!this.trafficGeos;
  }

  _buildTrafficModels(count) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, metalness: 0.35, roughness: 0.36, envMap: this.envMap, envMapIntensity: 1.0,
    });
    // краска = цвет инстанса только там, где paint = 1; фары/стопы (glow = 1) светятся сами
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float paint;\nattribute float glow;\nvarying float vGlow;')
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex
          .replace('vColor.xyz *= instanceColor.xyz;', 'vColor.xyz *= mix( vec3( 1.0 ), instanceColor.xyz, paint );') + '\nvGlow = glow;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * vGlow * 2.4;');
    };
    mat.customProgramCacheKey = () => 'traffic-paint-glow-v1';
    this.tMat = mat;
    const white = new THREE.Color(1, 1, 1);
    this.tTypes = TRAFFIC_TYPES.map((t) => {
      const m = new THREE.InstancedMesh(this.trafficGeos[t.id], mat, count);
      m.castShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < count; i++) m.setColorAt(i, white);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      this.scene.add(m);
      return m;
    });
    this._tCounts = new Int32Array(this.tTypes.length);
    this.trafficCount = count;
  }

  buildTraffic(count) {
    if (this.trafficGeos) return this._buildTrafficModels(count);
    const bodyGeo = new THREE.BoxGeometry(4.1, 0.62, 1.78);
    bodyGeo.translate(0, 0.62, 0);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.45, roughness: 0.42, envMap: this.envMap, envMapIntensity: 0.9,
    });
    this.tBodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
    this.tBodies.castShadow = true;

    const cabGeo = new THREE.BoxGeometry(2.0, 0.58, 1.58);
    cabGeo.translate(-0.15, 1.22, 0);
    const cabMat = new THREE.MeshStandardMaterial({
      color: 0x141c26, metalness: 0.85, roughness: 0.12, envMap: this.envMap, envMapIntensity: 1.3,
    });
    this.tCabins = new THREE.InstancedMesh(cabGeo, cabMat, count);
    this.tCabins.castShadow = true;

    // колёса — тёмные цилиндры, 4 на машину, один draw call
    const wGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10, 1);
    wGeo.rotateX(Math.PI / 2);
    this.tWheels = new THREE.InstancedMesh(wGeo, new THREE.MeshLambertMaterial({ color: 0x141518 }), count * 4);

    const lightGeo = new THREE.BoxGeometry(0.08, 0.13, 0.34);
    this.tHead = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xfff4dc }), count * 2);
    this.tTail = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xff3020 }), count * 2);

    for (const m of [this.tBodies, this.tCabins, this.tWheels, this.tHead, this.tTail]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }
    this.trafficCount = count;
  }

  updateTraffic(cars) {
    const M = this._tmp.m, q = this._tmp.q, v = this._tmp.v, one = this._tmp.one;
    const col = this._tmp.col;
    if (this.tTypes) {
      const cnt = this._tCounts;
      cnt.fill(0);
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (!c.alive) continue;
        const ti = c.type || 0, mesh = this.tTypes[ti], k = cnt[ti]++;
        const h = c.visHeading !== undefined ? c.visHeading : c.heading;
        q.setFromEuler(this._tmp.e.set(0, -h, 0));
        M.compose(v.set(c.x, 0, c.z), q, one);
        mesh.setMatrixAt(k, M);
        col.setHex(TRAFFIC_COLORS[c.colorIdx % TRAFFIC_COLORS.length]);
        mesh.setColorAt(k, col);
      }
      for (let t = 0; t < this.tTypes.length; t++) {
        const m = this.tTypes[t];
        m.count = cnt[t];
        m.visible = cnt[t] > 0;
        m.instanceMatrix.needsUpdate = true;
        m.instanceColor.needsUpdate = true;
      }
      return;
    }
    let n = 0, ln = 0, wn = 0;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.alive) continue;
      const h = c.visHeading !== undefined ? c.visHeading : c.heading;
      q.setFromEuler(this._tmp.e.set(0, -h, 0));
      M.compose(v.set(c.x, 0, c.z), q, one);
      this.tBodies.setMatrixAt(n, M);
      this.tCabins.setMatrixAt(n, M);
      col.setHex(TRAFFIC_COLORS[c.colorIdx % TRAFFIC_COLORS.length]);
      this.tBodies.setColorAt(n, col);

      const cos = Math.cos(h), sin = Math.sin(h);
      // локальные (вперёд f, вправо r) → мир: x = cx + f*cos - r*sin, z = cz + f*sin + r*cos
      const wx = (f, r) => c.x + f * cos - r * sin;
      const wz = (f, r) => c.z + f * sin + r * cos;
      M.compose(v.set(wx(2.06, 0.58), 0.72, wz(2.06, 0.58)), q, one); this.tHead.setMatrixAt(ln, M);
      M.compose(v.set(wx(2.06, -0.58), 0.72, wz(2.06, -0.58)), q, one); this.tHead.setMatrixAt(ln + 1, M);
      M.compose(v.set(wx(-2.06, 0.6), 0.74, wz(-2.06, 0.6)), q, one); this.tTail.setMatrixAt(ln, M);
      M.compose(v.set(wx(-2.06, -0.6), 0.74, wz(-2.06, -0.6)), q, one); this.tTail.setMatrixAt(ln + 1, M);
      for (const [f, r] of [[1.3, 0.86], [1.3, -0.86], [-1.3, 0.86], [-1.3, -0.86]]) {
        M.compose(v.set(wx(f, r), 0.34, wz(f, r)), q, one);
        this.tWheels.setMatrixAt(wn++, M);
      }
      n++; ln += 2;
    }
    this.tBodies.count = n;
    this.tCabins.count = n;
    this.tWheels.count = wn;
    this.tHead.count = ln;
    this.tTail.count = ln;
    for (const m of [this.tBodies, this.tCabins, this.tWheels, this.tHead, this.tTail]) m.instanceMatrix.needsUpdate = true;
    if (this.tBodies.instanceColor) this.tBodies.instanceColor.needsUpdate = true;
  }

  // --------------------------------------------------------- МАШИНА ИГРОКА --
  setPlayerCar(def) {
    if (this.playerMesh) {
      this.scene.remove(this.playerMesh);
      disposeCarMesh(this.playerMesh);
    }
    this.playerMesh = buildCarMesh(def, { shadowTex: TEX.shadowBlob, coneTex: TEX.headCone, envMap: this.envMap });
    this.playerMesh.rotation.order = 'YXZ';
    this.playerMesh.traverse(o => { o.renderOrder = o.renderOrder || -1; });
    this.scene.add(this.playerMesh);
    this.playerDef = def;
    this._carY = 0;
    // пока GLB грузится, показана процедурная заглушка — подменим, как только модель готова
    if (this.playerMesh.userData.placeholder) {
      preloadCarModel(def).then(() => {
        if (this.playerDef === def && this.playerMesh && this.playerMesh.userData.placeholder) this.setPlayerCar(def);
      });
    }
  }

  updatePlayer(car, dt, visual) {
    const g = this.playerMesh;
    if (!g) return;
    // на тротуаре кузов приподнят на высоту бордюра
    const targetY = car.onRoad === false ? 0.16 : 0;
    this._carY = damp(this._carY, targetY, 18, dt);
    g.position.set(car.x, this._carY, car.z);
    g.rotation.y = -car.heading;
    animateCar(g, car, dt, visual);
  }

  // ---------------------------------------------------------- ПЕРСОНАЖ ---
  async setHero(id) {
    const def = characterById(id);
    if (!def) return false;
    // Уничтожаем устаревшие результаты загрузки: быстрые нажатия стрелок
    // не должны подменить последнего выбранного героя более ранним запросом.
    if (this.heroId === id && this.heroActor) { ++this._heroRequest; return true; }
    const request = ++this._heroRequest;
    let actor;
    try { actor = await createHero(def); }
    catch (err) { console.warn('[hero] не загрузилась модель', id, err); return false; }
    if (request !== this._heroRequest) { actor.dispose(); return false; }
    if (this.heroActor) { this.scene.remove(this.heroActor.root); this.heroActor.dispose(); }
    this.heroActor = actor; this.heroId = id;
    actor.root.visible = this.heroVisible;
    this.scene.add(actor.root);
    return true;
  }

  showHero(show) {
    this.heroVisible = !!show;
    if (this.heroActor) this.heroActor.root.visible = this.heroVisible;
  }

  updateHero(hero, dt, preview = false) {
    if (!this.heroActor || !hero) return;
    const root = this.heroActor.root;
    root.position.set(hero.x, hero.y || 0, hero.z);
    // Модель MakeHuman смотрит вдоль +Z, логика игры — вдоль +X.
    root.rotation.y = Math.PI / 2 - hero.heading;
    this.heroActor.update(dt, preview ? 0 : hero.speed, !preview && hero.running);
  }

  moveCarCamera(dx, dy) {
    this.driveLookYaw = wrapAngle(this.driveLookYaw - dx * 0.006);
    this.driveLookHeight = THREE.MathUtils.clamp(this.driveLookHeight + dy * 0.012, -1, 3);
  }

  updateFootCamera(hero, dt) {
    const yaw = hero.camYaw, pitch = hero.camPitch, distance = 4.2;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const flat = distance * Math.cos(pitch);
    const allowed = this._cameraClearance(hero.x, hero.z, -c, -s, flat);
    if (!this._camInit) { this._camClip = allowed; this._camInit = true; }
    else if (allowed < this._camClip) this._camClip = allowed;
    else this._camClip = damp(this._camClip, allowed, 2.5, dt);
    const d = Math.min(flat, this._camClip);
    this.camera.position.set(hero.x - c * d, (hero.y || 0) + 1.08 + distance * Math.sin(pitch), hero.z - s * d);
    this.camera.lookAt(hero.x, (hero.y || 0) + 1.05, hero.z);
    this.camYaw = yaw;
    if (this.camera.view && this.camera.view.enabled) this.camera.clearViewOffset();
    this.camera.fov = damp(this.camera.fov, 57, 4, dt);
    this.camera.updateProjectionMatrix();
    this._followSun(hero);
  }

  // ------------------------------------------------------------ СЛЕДЫ ШИН --
  buildSkids() {
    const geo = new THREE.PlaneGeometry(0.26, 1);
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(Math.PI / 2);            // длина вдоль +X (курс)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0b0c0f, transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.SKID_MAX = 600;
    this.skids = new THREE.InstancedMesh(geo, mat, this.SKID_MAX);
    this.skids.frustumCulled = false;
    this.skids.renderOrder = 3;
    this.skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.skidIdx = 0;
    const M = this._tmp.m;
    M.makeScale(0, 0, 0);
    for (let i = 0; i < this.SKID_MAX; i++) this.skids.setMatrixAt(i, M);
    this.skids.instanceMatrix.needsUpdate = true;
    this.scene.add(this.skids);
  }

  /** Отрезок следа от (x0,z0) до (x1,z1) */
  addSkid(x0, z0, x1, z1, y = 0.02) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || len > 4) return;
    const M = this._tmp.m, q = this._tmp.q, v = this._tmp.v;
    q.setFromEuler(this._tmp.e.set(0, -Math.atan2(dz, dx), 0));
    M.compose(v.set((x0 + x1) / 2, y, (z0 + z1) / 2), q, this._tmp.v2.set(len + 0.05, 1, 1));
    this.skids.setMatrixAt(this.skidIdx, M);
    this.skidIdx = (this.skidIdx + 1) % this.SKID_MAX;
    this.skids.instanceMatrix.needsUpdate = true;
  }

  // ----------------------------------------------------------- ЧАСТИЦЫ -----
  buildParticles() {
    const mk = (count, tex, color, size, blending, opacity) => {
      const pos = new Float32Array(count * 3).fill(0);
      for (let i = 0; i < count; i++) pos[i * 3 + 1] = -100;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.PointsMaterial({
        size, map: tex, transparent: true, depthWrite: false, opacity,
        sizeAttenuation: true, color, blending,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      this.scene.add(pts);
      return { pts, pos, vel: new Float32Array(count * 3), life: new Float32Array(count), max: count, idx: 0, alive: 0 };
    };
    this.smoke = mk(160, TEX.smoke, 0xa9aeb6, 2.0, THREE.NormalBlending, 0.30);
    this.sparks = mk(90, TEX.spark, 0xffd28a, 0.45, THREE.AdditiveBlending, 1.0);
  }

  _emit(sys, x, y, z, vx, vy, vz, life) {
    const i = sys.idx;
    sys.idx = (sys.idx + 1) % sys.max;
    sys.pos[i * 3] = x; sys.pos[i * 3 + 1] = y; sys.pos[i * 3 + 2] = z;
    sys.vel[i * 3] = vx; sys.vel[i * 3 + 1] = vy; sys.vel[i * 3 + 2] = vz;
    sys.life[i] = life;
  }
  emitSmoke(x, y, z, vx, vy, vz) { this._emit(this.smoke, x, y, z, vx, vy, vz, 1.1); }
  emitSpark(x, y, z, vx, vy, vz) { this._emit(this.sparks, x, y, z, vx, vy, vz, 0.45); }

  _updateSys(sys, dt, gravity, drag) {
    let alive = 0;
    const pos = sys.pos, vel = sys.vel, life = sys.life;
    for (let i = 0; i < sys.max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { pos[i * 3 + 1] = -100; continue; }
      alive++;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      vel[i * 3 + 1] += gravity * dt;
      const k = Math.max(0, 1 - drag * dt);
      vel[i * 3] *= k; vel[i * 3 + 2] *= k;
      if (pos[i * 3 + 1] < 0.05 && gravity < 0) { pos[i * 3 + 1] = 0.05; vel[i * 3 + 1] *= -0.3; }
    }
    if (alive > 0 || sys.alive > 0) sys.pts.geometry.attributes.position.needsUpdate = true;
    sys.alive = alive;
  }

  updateParticles(dt) {
    this._updateSys(this.smoke, dt, 1.4, 1.8);
    this._updateSys(this.sparks, dt, -14, 0.6);
  }

  // ----------------------------------------------------------- ЧЕКПОИНТЫ ---
  buildCheckpointRing() {
    this.cpGroup = new THREE.Group();
    this.cpMeshes = new Map();
    this.scene.add(this.cpGroup);
    const R = CONFIG.gameplay.checkpointRadius;
    this._ringGeo = new THREE.TorusGeometry(R * 0.85, 0.22, 8, 36);
    this._beamGeo = new THREE.CylinderGeometry(R * 0.8, R * 0.8, 70, 16, 4, true);
    this._beamGeo.translate(0, 35, 0);
    {
      // затухание луча кверху: аддитивный режим + чёрная вершина = невидимо
      const pos = this._beamGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const t = Math.pow(1 - pos.getY(i) / 70, 1.6);
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = t;
      }
      this._beamGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0x3ae6ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this._beamMat = new THREE.MeshBasicMaterial({
      color: 0x22c8ff, transparent: true, opacity: 0.22, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      forceSinglePass: true,   // аддитивный: порядок сторон не важен, а 2 прохода = needsUpdate каждый кадр
    });
  }

  updateCheckpoints(cps, time) {
    const seen = this._cpSeen || (this._cpSeen = new Set());
    seen.clear();
    for (const cp of cps) {
      seen.add(cp.id);
      let m = this.cpMeshes.get(cp.id);
      if (!m) {
        m = new THREE.Group();
        const ring = new THREE.Mesh(this._ringGeo, this._ringMat);
        ring.position.y = 2.6;
        const beam = new THREE.Mesh(this._beamGeo, this._beamMat);
        m.add(ring, beam);
        m.userData = { ring, beam, born: time };
        m.renderOrder = 7;
        ring.renderOrder = 7; beam.renderOrder = 7;
        this.cpMeshes.set(cp.id, m);
        this.cpGroup.add(m);
      }
      m.position.set(cp.x, 0, cp.z);
      // кольцо всегда повёрнуто к камере (читается с любого направления)
      const ring = m.userData.ring;
      ring.rotation.y = Math.atan2(this.camera.position.x - cp.x, this.camera.position.z - cp.z);
      const appear = Math.min(1, (time - m.userData.born) * 2.5);
      const p = (1 + Math.sin(time * 3.2 + cp.id) * 0.05) * appear;
      ring.scale.set(p, p, p);
    }
    this._beamMat.opacity = 0.20 + Math.sin(time * 2.1) * 0.05;
    for (const [id, m] of this.cpMeshes) {
      if (!seen.has(id)) {
        this.cpGroup.remove(m);
        this.cpMeshes.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------- КАМЕРА --
  /** Камера погони. Сглаживается курс и дистанция (а не мировая позиция): без отставания на скорости. */
  updateCamera(car, dt, shake) {
    const C = CONFIG.camera;
    const v = Math.hypot(car.vx, car.vz);
    const t = Math.min(1, v / CONFIG.gameplay.referenceSpeed);

    if (this.orbit) {
      // витрина: облёт машины в меню/гараже
      this.orbit.a += dt * this.orbit.speed;
      const a = this.orbit.a;
      const r = this.orbit.r;
      const focus = this.orbit.hero && this.heroActor ? this.heroActor.root.position : car;
      this.camera.position.set(focus.x + Math.cos(a) * r, this.orbit.h, focus.z + Math.sin(a) * r);
      this.camera.lookAt(focus.x, this.orbit.lookY || 0.7, focus.z);
      this.camera.fov = 50;
      if (this.orbit.frameLeft) {
        // машина в левой трети кадра — справа панель гаража
        this.camera.setViewOffset(this._w * 1.3, this._h, this._w * 0.3, 0, this._w, this._h);
      } else if (this.camera.view && this.camera.view.enabled) {
        this.camera.clearViewOffset();
      }
      this.camera.updateProjectionMatrix();
      this._camInit = false;
      this._followSun(car);
      return;
    }

    // курс камеры: кузов + часть направления движения (в заносе видно траекторию)
    let targetYaw = car.heading;
    if (v > 5 && car.speed > 0) {
      const velYaw = Math.atan2(car.vz, car.vx);
      targetYaw = car.heading + wrapAngle(velYaw - car.heading) * 0.5;
    }
    targetYaw += this.driveLookYaw;
    const targetDist = C.distBase + C.distSpeed * t;
    const targetH = THREE.MathUtils.clamp(C.heightBase + C.heightSpeed * t + this.driveLookHeight, 1.5, 7.0);
    if (!this._camInit) {
      this.camYaw = targetYaw; this.camDist = targetDist; this.camHeight = targetH;
      this._camInit = true;
    } else {
      this.camYaw = dampAngle(this.camYaw, targetYaw, C.yawSmooth, dt);
      this.camDist = damp(this.camDist, targetDist, 2.5, dt);
      this.camHeight = damp(this.camHeight, targetH, 2.5, dt);
    }
    const cx = Math.cos(this.camYaw), cz = Math.sin(this.camYaw);
    // камера не должна залезать в дома: укорачиваем дистанцию до препятствия
    const allowed = this._cameraClearance(car.x, car.z, -cx, -cz, this.camDist);
    if (allowed < this._camClip) this._camClip = allowed;                 // приблизиться — сразу
    else this._camClip = damp(this._camClip, allowed, 2.2, dt);           // отъехать — плавно
    const dist = Math.min(this.camDist, this._camClip);
    let px = car.x - cx * dist;
    let pz = car.z - cz * dist;
    let py = this.camHeight + (this._carY || 0);
    if (shake > 0.001) {
      px += (Math.random() - 0.5) * shake;
      py += (Math.random() - 0.5) * shake * 0.6;
      pz += (Math.random() - 0.5) * shake;
    }
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(car.x + cx * C.lookAhead, 1.0 + (this._carY || 0), car.z + cz * C.lookAhead);

    if (this.camera.view && this.camera.view.enabled) this.camera.clearViewOffset();
    const targetFov = C.fov + C.fovKick * t * t;
    this.camera.fov = damp(this.camera.fov, targetFov, 3, dt);
    this.camera.updateProjectionMatrix();
    this._followSun(car);
  }

  /** Сколько метров свободно от (x,z) в направлении (dx,dz), не дальше maxD (дома и стены) */
  _cameraClearance(x, z, dx, dz, maxD) {
    const hash = this.camHash;
    if (!hash) return maxD;
    const out = this._camCand || (this._camCand = []);
    hash.query(x + dx * maxD * 0.5, z + dz * maxD * 0.5, maxD * 0.5 + 2, out);
    const pad = 0.45;
    let best = 1;
    const sx = dx * maxD, sz = dz * maxD;
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (b.kind !== 'building' && b.kind !== 'wall') continue;
      const minX = b.x - b.hw - pad, maxX = b.x + b.hw + pad;
      const minZ = b.z - b.hd - pad, maxZ = b.z + b.hd + pad;
      if (x > minX && x < maxX && z > minZ && z < maxZ) continue;     // машина вплотную к стене — не дёргаем
      let t0 = 0, t1 = 1;
      if (Math.abs(sx) < 1e-9) { if (x < minX || x > maxX) continue; }
      else {
        let a = (minX - x) / sx, c = (maxX - x) / sx;
        if (a > c) { const tmp = a; a = c; c = tmp; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        if (t0 > t1) continue;
      }
      if (Math.abs(sz) < 1e-9) { if (z < minZ || z > maxZ) continue; }
      else {
        let a = (minZ - z) / sz, c = (maxZ - z) / sz;
        if (a > c) { const tmp = a; a = c; c = tmp; }
        t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        if (t0 > t1) continue;
      }
      if (t0 < best) best = t0;
    }
    return Math.max(1.8, best * maxD);
  }

  _followSun(car) {
    this.sky.position.copy(this.camera.position);
    // снап центра теневой камеры к текселю в пространстве света → тени не «плывут»
    const texel = (this.cfg.shadowBox * 2) / this.cfg.shadowMapSize;
    const v = this._tmp.v.set(car.x, 0, car.z);
    const r = Math.round(v.dot(this._lightRight) / texel) * texel;
    const u = Math.round(v.dot(this._lightUp) / texel) * texel;
    const f = v.dot(this._lightFwd);
    v.copy(this._lightRight).multiplyScalar(r)
      .addScaledVector(this._lightUp, u)
      .addScaledVector(this._lightFwd, f);
    this.sun.target.position.copy(v);
    this.sun.position.copy(v).add(this.sunOffset);
    this.sun.target.updateMatrixWorld();
  }

  // -------------------------------------------------------- АДАПТИВНЫЙ FPS --
  setQuality(q) {
    this.quality = q;
    const shadows = q !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      this.sun.castShadow = shadows;
      // материалы надо перекомпилировать при смене теней
      this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    }
    if (this.buildingChunks) {
      for (const m of this.buildingChunks) m.receiveShadow = q === 'high';
      this.facadeMat.needsUpdate = true;
    }
    if (q === 'high') this.scale = this.cfg.maxScale;
    else if (q === 'low') this.scale = this.cfg.minScale + 0.08;
    else this.scale = this.cfg.startScale;
    this._ceiling = this.cfg.maxScale;
    this.resize(this._w, this._h);
  }

  /** Подстраивает разрешение рендера под реальную производительность. */
  adaptPerformance(dt) {
    this.frames++;
    this.fpsAccum += dt;
    this._scaleCooldown -= dt;
    this._ceilingTimer += dt;
    if (this._ceilingTimer > 25) {          // потолок медленно «прощает» прошлые просадки
      this._ceilingTimer = 0;
      this._ceiling = Math.min(this.cfg.maxScale, this._ceiling + 0.04);
    }
    if (this.fpsAccum < 1.0) return false;
    this.fps = this.frames / this.fpsAccum;
    this.frames = 0;
    this.fpsAccum = 0;
    this.drawCalls = this.renderer.info.render.calls;
    this.triangles = this.renderer.info.render.triangles;
    if (this.quality !== 'auto' || this._scaleCooldown > 0) return false;
    let changed = false;
    if (this.fps < this.cfg.targetFps - 6 && this.scale > this.cfg.minScale) {
      // чем сильнее просадка, тем крупнее шаг
      const step = this.fps < 35 ? 0.12 : 0.06;
      this._ceiling = Math.max(this.cfg.minScale, this.scale - 0.02);
      this.scale = Math.max(this.cfg.minScale, this.scale - step);
      this._scaleCooldown = 1.5;
      changed = true;
    } else if (this.fps > this.cfg.targetFps + 2.5 && this.scale < Math.min(this.cfg.maxScale, this._ceiling)) {
      this.scale = Math.min(this.cfg.maxScale, this._ceiling, this.scale + 0.04);
      this._scaleCooldown = 3.0;
      changed = true;
    }
    if (changed) this.resize(this._w, this._h);
    return changed;
  }

  resize(w, h) {
    this._w = w; this._h = h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rw = Math.max(2, Math.floor(w * dpr * this.scale));
    const rh = Math.max(2, Math.floor(h * dpr * this.scale));
    this.renderer.setSize(rw, rh, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderW = rw; this.renderH = rh;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Прогрев: компиляция всех шейдеров до старта, чтобы не было фризов в игре */
  warmup() {
    try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* не критично */ }
  }
}
