import type { SceneData, Variant } from '../../harness/types';
import { setupCommon, type Built, type Ctx, type Features } from './common';
import { buildField } from './field';
import { buildInstances } from './instances';
import { buildGltf } from './gltf';
import { buildCharacters } from './characters';

/** Scene construction shared by both renderers; `f` supplies what differs. */
export async function buildScene(ctx: Ctx, data: SceneData, variant: Variant, opt: string | undefined, f: Features): Promise<Built> {
  const { scene, camera } = ctx;
  const { sun } = setupCommon(scene, camera, data, camera.aspect);
  let built: Built;
  switch (data.kind) {
    case 'field':
      built = await buildField(ctx, sun, data, variant, opt, f);
      break;
    case 'instances':
      built = buildInstances(ctx, data);
      break;
    case 'gltf-scene':
      built = await buildGltf(ctx, sun, data, f);
      break;
    case 'characters':
      built = await buildCharacters(ctx, data, variant);
      break;
    case 'particles':
      built = await f.particles(data);
      break;
  }
  if (!data.cameraLive) return built;
  const { update } = built, c = data.camera;
  return {
    ...built,
    update(t, dt) {
      camera.position.fromArray(c.position);
      camera.lookAt(c.target[0], c.target[1], c.target[2]);
      // the classic CSM reads the camera's world matrix before the render updates it
      camera.updateMatrixWorld();
      update(t, dt);
    },
  };
}
