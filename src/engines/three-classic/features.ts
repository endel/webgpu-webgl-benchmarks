import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Features } from '../three/common';
import type { ClassicCtx } from './index';

const na = (why: string) => () => {
  throw new Error(`N/A: ${why}`);
};

export function webglFeatures({ renderer, scene, camera }: ClassicCtx): Features {
  return {
    label: {
      cascades: 'CSM addon (a DirectionalLight per cascade)',
      clustered: '',
      post: 'EffectComposer + UnrealBloomPass + OutputPass (addons)',
      overlay: 'second render() with autoClear=false, toneMapped=false materials',
    },
    cascades(sun, s) {
      // CSM brings one shadow-casting DirectionalLight per cascade in place of the sun
      scene.remove(sun, sun.target);
      const csm = new CSM({
        camera,
        parent: scene,
        cascades: s.cascades,
        maxFar: s.maxDistance,
        shadowMapSize: s.mapSize,
        lightDirection: sun.target.position.clone().sub(sun.position).normalize(),
        lightIntensity: sun.intensity,
      });
      for (const l of csm.lights) l.color.copy(sun.color);
      const mats = new Set<THREE.Material>();
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) mats.add((o as THREE.Mesh).material as THREE.Material);
      });
      mats.forEach((m) => csm.setupMaterial(m));
      return () => csm.update();
    },
    clustered: na('WebGLRenderer has no clustered or tiled lighting; every light is a forward uniform in every material'),
    post({ bloom: b }) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      // the composer's own target replaces the canvas MSAA
      const samples = renderer.getContext().getContextAttributes()?.antialias ? 4 : 0;
      const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples }));
      composer.addPass(new RenderPass(scene, camera));
      composer.addPass(new UnrealBloomPass(size, b.strength, b.radius, b.threshold));
      composer.addPass(new OutputPass());
      return () => composer.render();
    },
    rawOverlay: false,
    overlay(hud, hudCamera) {
      return () => {
        renderer.render(scene, camera);
        renderer.autoClear = false;
        renderer.render(hud, hudCamera);
        renderer.autoClear = true;
      };
    },
    particles: na('WebGLRenderer has no compute shaders'),
  };
}
