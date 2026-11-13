import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GltfScene } from '../../harness/types';
import { pointLights, type Built, type Ctx, type Features } from './common';

export async function buildGltf({ scene, renderer }: Ctx, sun: THREE.DirectionalLight | null, d: GltfScene, f: Features): Promise<Built> {
  const root = (await new GLTFLoader().loadAsync(d.url)).scene;
  scene.add(root);
  const updates: (() => void)[] = [];
  let path = 'GLTFLoader scene graph';
  if (d.pointLights) {
    path += ` + ${d.pointLights.count} PointLights`;
    if (d.manyLights) {
      f.clustered();
      path += ` (${f.label.clustered})`;
    }
    updates.push(pointLights(scene, d.pointLights));
  }
  if (sun && d.sun?.shadow) {
    renderer.shadowMap.enabled = true;
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
    });
    // after the lights and materials exist (the classic CSM patches materials)
    const u = f.cascades(sun, d.sun.shadow);
    if (u) updates.push(u);
    path += ` + ${f.label.cascades}`;
  }
  if (d.post) path += ` + ${f.label.post}`;
  return {
    path,
    update: () => updates.forEach((u) => u()),
    render: d.post && f.post(d.post),
  };
}
