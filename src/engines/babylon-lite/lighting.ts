import {
  addTask, addTaskAtStart, addToScene, createBloomPostProcessTask, createPointLight, createRenderTarget, createRenderTask,
  type PointLight, type SceneContext,
} from '@babylonjs/lite';
import type { PointLightsSpec, PostSpec } from '../../harness/types';
import { LIGHT_SCALE, type LiteCtx } from './index';

export function addForwardPointLights(scene: SceneContext, pl: PointLightsSpec) {
  const lights: PointLight[] = [];
  for (let i = 0; i < pl.count; i++) {
    const l = createPointLight([pl.position[i * 3], pl.position[i * 3 + 1], pl.position[i * 3 + 2]], pl.intensity * LIGHT_SCALE);
    l.diffuse = l.specular = [pl.color[i * 3], pl.color[i * 3 + 1], pl.color[i * 3 + 2]];
    l.range = pl.range;
    addToScene(scene, l);
    lights.push(l);
  }
  const p = pl.position;
  return () => {
    for (let i = 0; i < lights.length; i++) lights[i].position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  };
}

/** Scene → 4× MSAA target resolved to a texture → bloom → swapchain. Needs a scene created without its default render task. */
export function addPost(ctx: LiteCtx, post: PostSpec) {
  const { engine, scene } = ctx;
  const color = createRenderTarget({ lbl: 'scene-color', format: engine.format, dFormat: 'depth24plus-stencil8', samples: engine.msaaSamples, size: engine });
  const resolved = createRenderTarget({ lbl: 'scene-resolved', format: engine.format, samples: 1, size: engine });
  const msaa = engine.msaaSamples > 1;
  addTaskAtStart(scene, createRenderTask({ name: 'scene', rt: msaa ? color : resolved, rst: msaa ? resolved : undefined, clrColor: scene.clearColor, clr: true }, engine, scene));
  const { bloom } = post;
  const task = createBloomPostProcessTask(
    // Lite's default kernel (64) ↔ radius 0.5, as in Babylon.js.
    { name: 'bloom', sourceTexture: resolved, targetTexture: engine.scRT, threshold: bloom.threshold, weight: bloom.strength, kernel: 128 * bloom.radius },
    engine,
    scene,
  );
  addTask(scene, task);
  return task;
}
