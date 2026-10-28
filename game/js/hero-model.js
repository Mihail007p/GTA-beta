// Готовые человеческие модели с одним общим циклом анимации. Модели и
// текстуры грузятся локально (в том числе из service worker), не из CDN.
import * as THREE from '../vendor/three.js';
import { loadGLTF } from './car-model.js';

let motionPromise;
function loadMotion() {
  if (!motionPromise) motionPromise = fetch('assets/characters/motion.json').then(r => {
    if (!r.ok) throw new Error('Не удалось загрузить анимации');
    return r.json();
  }).catch(err => { motionPromise = null; throw err; });
  return motionPromise;
}

// CMU mocap приводит суставы ног/торса к общей системе координат; руки и
// голова дополнительно подстроены под A-позу наших MakeHuman-персонажей.
function motionClip(name, data, bones) {
  const names = new Set(['pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l',
    'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'spine_01', 'spine_02', 'spine_03',
    'clavicle_l', 'clavicle_r', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'upperarm_r', 'lowerarm_r', 'hand_r', 'neck_01', 'head']);
  const times = [], values = new Map();
  for (const bone of bones) if (names.has(bone.name)) values.set(bone.name, []);
  const axis = new THREE.Vector3(1, 0, 0), identity = new THREE.Quaternion();
  const frames = [...data.samples, [data.frameCount, data.samples[0][1]]];
  for (const [frameIndex, frame] of frames) {
    times.push(frameIndex / data.fps);
    const world = new Map();
    for (const bone of bones) {
      const parent = bone.parent?.isBone ? world.get(bone.parent.name) : identity;
      let desired = frame[bone.name] ? new THREE.Quaternion().fromArray(frame[bone.name]) : parent.clone();
      let local = parent.clone().invert().multiply(desired);
      if (bone.name.startsWith('upperarm_')) {
        const side = bone.name.endsWith('_l') ? 'l' : 'r';
        const thigh = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(frame[`thigh_${side}`]), 'XYZ');
        const swing = THREE.MathUtils.clamp(-thigh.x * (name === 'run' ? 1 : 0.8), -0.75, 0.75);
        local.setFromEuler(new THREE.Euler(swing, 0, side === 'l' ? -0.47 : 0.47, 'XZY'));
      }
      if (bone.name.startsWith('lowerarm_')) local.setFromAxisAngle(axis, name === 'run' ? -0.7 : -0.12);
      if (bone.name.startsWith('hand_')) local.slerp(identity, 0.6);
      if (bone.name === 'neck_01') local.slerp(identity, 0.75);
      if (bone.name === 'head') local.copy(parent).invert();
      world.set(bone.name, parent.clone().multiply(local));
      if (values.has(bone.name)) values.get(bone.name).push(...local.toArray());
    }
  }
  const tracks = [...values].map(([n, v]) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, v));
  return new THREE.AnimationClip(name, data.frameCount / data.fps, tracks);
}

function idleClip(bones) {
  const names = ['pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r',
    'spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'lowerarm_l',
    'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'neck_01', 'head'];
  const present = new Set(bones.map(b => b.name));
  const tracks = [];
  for (const name of names) {
    if (!present.has(name)) continue;
    const q = new THREE.Quaternion();
    if (name === 'upperarm_l') q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.47);
    if (name === 'upperarm_r') q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.47);
    if (name.startsWith('lowerarm_')) q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12);
    const middle = q.clone();
    if (name === 'spine_02') middle.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.012);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1, 2], [...q.toArray(), ...middle.toArray(), ...q.toArray()]));
  }
  return new THREE.AnimationClip('idle', 2, tracks);
}

export async function createHero(def) {
  const [gltf, motion] = await Promise.all([loadGLTF(def.model), loadMotion()]);
  const model = gltf.scene;
  const rig = model.getObjectByName('rig');
  const bones = [];
  if (rig) rig.traverse(o => { if (o.isBone) bones.push(o); });
  if (!bones.length || !bones.some(b => b.name === 'thigh_l')) throw new Error('В модели нет скелета');

  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (!Number.isFinite(box.min.y)) throw new Error('Некорректная геометрия персонажа');
  model.position.y -= box.min.y;
  model.traverse(o => {
    if (!o.isMesh) return;
    o.frustumCulled = false; // конечности могут выходить за границы A-позы
    o.castShadow = !['eyes', 'eyebrows', 'eyelashes', 'hair'].includes(o.name);
    o.receiveShadow = true;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      // В исходном генераторе все прокси помечены как BLEND. Для одежды,
      // волос и ресниц достаточно альфа-теста: меньше перерисовки на телефоне.
      if (mat.transparent && mat.map && (mat.opacity ?? 1) >= 0.99) {
        mat.transparent = false; mat.alphaTest = 0.22; mat.depthWrite = true; mat.needsUpdate = true;
      }
    }
  });
  const root = new THREE.Group();
  root.add(model);
  root.scale.setScalar((def.height || 1.72) / (box.max.y - box.min.y));
  const mixer = new THREE.AnimationMixer(model);
  const actions = {
    idle: mixer.clipAction(idleClip(bones)),
    walk: mixer.clipAction(motionClip('walk', motion.walk, bones)),
    run: mixer.clipAction(motionClip('run', motion.run, bones)),
  };
  actions.idle.play();
  let active = 'idle';
  return {
    root, model, bones, mixer, actions,
    update(dt, speed = 0, running = false) {
      const next = speed < 0.16 ? 'idle' : running ? 'run' : 'walk';
      if (next !== active) {
        actions[active].fadeOut(0.18);
        actions[next].reset().fadeIn(0.18).play();
        active = next;
      }
      mixer.timeScale = next === 'idle' ? 1 : next === 'run'
        ? THREE.MathUtils.clamp(speed / 4.1, 0.72, 1.25)
        : THREE.MathUtils.clamp(speed / 1.75, 0.55, 1.2);
      mixer.update(dt);
    },
    dispose() {
      mixer.stopAllAction();
      const geometries = new Set(), materials = new Set(), textures = new Set();
      model.traverse(o => {
        if (o.geometry) geometries.add(o.geometry);
        if (o.material) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) materials.add(m);
      });
      for (const m of materials) {
        for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
        m.dispose();
      }
      for (const t of textures) { t.dispose(); if (t.image?.close) t.image.close(); }
      for (const g of geometries) g.dispose();
      root.remove(model);
    },
  };
}
