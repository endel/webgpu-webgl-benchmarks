import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { CharactersScene, Variant } from '../../harness/types';
import type { Built, Ctx } from './common';

export async function buildCharacters({ scene }: Ctx, d: CharactersScene, variant: Variant): Promise<Built> {
  if (variant === 'optimized') {
    throw new Error('N/A: three has no instanced or baked skinning with a pose per instance (an instanced SkinnedMesh shares one skeleton, so every instance plays the same frame)');
  }
  const gltf = await new GLTFLoader().loadAsync(d.url);
  const clips = [gltf.animations[d.clip]];
  if (d.blend) clips.push(gltf.animations[d.blend.clip]);
  // tracks of unnamed nodes bind by uuid, which clone() changes
  gltf.scene.traverse((o) => {
    o.name ||= o.uuid;
  });
  const chars = Array.from({ length: d.count }, (_, i) => {
    const root = new THREE.Group();
    root.position.fromArray(d.position, i * 3);
    root.rotation.y = d.yaw[i];
    root.scale.setScalar(d.scale);
    const model = SkeletonUtils.clone(gltf.scene);
    root.add(model);
    scene.add(root);
    const mixer = new THREE.AnimationMixer(model);
    return { mixer, actions: clips.map((c) => mixer.clipAction(c).play()) };
  });
  return {
    path: `SkinnedMesh per character (SkeletonUtils.clone + AnimationMixer${d.blend ? ', two weighted AnimationActions' : ''})`,
    update(t) {
      for (let i = 0; i < d.count; i++) {
        const { mixer, actions } = chars[i];
        const w = d.blend ? d.blend.weight[i] : 0;
        for (let k = 0; k < actions.length; k++) {
          actions[k].time = (t + d.phase[i]) % clips[k].duration;
          actions[k].setEffectiveWeight(k ? w : 1 - w);
        }
        mixer.update(0);
      }
    },
  };
}
