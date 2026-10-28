// CMU BVH → выбранные циклы quaternion-дельт для js/hero-model.js.
// Использование: node build-motion.mjs 07_01.bvh 09_01.bvh output.json
import fs from 'node:fs';
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';

const [walkPath, runPath, outPath] = process.argv.slice(2);
if (!walkPath || !runPath || !outPath) throw new Error('Укажите BVH ходьбы, BVH бега и путь результата');
const map = {
  pelvis: 'Hips', thigh_l: 'LeftUpLeg', calf_l: 'LeftLeg', foot_l: 'LeftFoot', ball_l: 'LeftToeBase',
  thigh_r: 'RightUpLeg', calf_r: 'RightLeg', foot_r: 'RightFoot', ball_r: 'RightToeBase',
  spine_01: 'LowerBack', spine_02: 'Spine', spine_03: 'Spine1',
  clavicle_l: 'LeftShoulder', upperarm_l: 'LeftArm', lowerarm_l: 'LeftForeArm', hand_l: 'LeftHand',
  clavicle_r: 'RightShoulder', upperarm_r: 'RightArm', lowerarm_r: 'RightForeArm', hand_r: 'RightHand',
  neck_01: 'Neck1', head: 'Head',
};
function convert(path, start, end) {
  const source = new BVHLoader().parse(fs.readFileSync(path, 'utf8'));
  const bones = source.skeleton.bones;
  const tracks = new Map(source.clip.tracks.filter(t => t.name.endsWith('.quaternion')).map(t => [t.name.split('.')[0], t]));
  const count = tracks.get('Hips').times.length;
  const worldsAt = i => {
    const worlds = new Map();
    for (const bone of bones) {
      const track = tracks.get(bone.name);
      const q = track ? new THREE.Quaternion().fromArray(track.values, i * 4) : new THREE.Quaternion();
      if (bone.parent?.isBone) q.premultiply(worlds.get(bone.parent.name));
      worlds.set(bone.name, q);
    }
    return worlds;
  };
  const ref = worldsAt(0), frames = [];
  for (let i = 1; i < count; i++) {
    const worlds = worldsAt(i), root = worlds.get('Hips');
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(root);
    const inverseYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(f.x, f.z));
    const frame = {};
    for (const [target, src] of Object.entries(map)) {
      frame[target] = inverseYaw.clone().multiply(worlds.get(src)).multiply(ref.get(src).clone().invert())
        .normalize().toArray().map(v => +v.toFixed(5));
    }
    frames.push(frame);
  }
  // Индексы оригинального BVH, включая добавленную Hahne T-позу в кадре 0.
  const clip = frames.slice(start - 1, end - 1);
  if (clip.length !== end - start) throw new Error('Входной BVH слишком короткий');
  return { fps: 120, frameCount: clip.length, samples: clip.flatMap((v, i) => i % 4 === 0 ? [[i, v]] : []) };
}
const result = { walk: convert(walkPath, 101, 231), run: convert(runPath, 11, 99) };
fs.writeFileSync(outPath, JSON.stringify(result));
console.log('Сохранено', outPath, 'walk:', result.walk.frameCount, 'run:', result.run.frameCount);
