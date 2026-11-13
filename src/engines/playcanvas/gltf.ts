import type { GltfScene } from '../../harness/types';
import { addPointLights, addPost } from './field';
import { loadContainer, type Built, type PcCtx } from './index';

export async function buildGltf(ctx: PcCtx, d: GltfScene): Promise<Built> {
  const { app, camera } = ctx;
  const res = await loadContainer(app, d.url);
  app.root.addChild(res.instantiateRenderEntity()); // casts + receives shadows by default
  const notes: string[] = [];
  let path = 'container asset + instantiateRenderEntity';
  if (d.sun?.shadow) path += `, ${d.sun.shadow.cascades}-cascade sun shadows`;
  let updateLights: (() => void) | undefined;
  if (d.pointLights) {
    updateLights = addPointLights(app, d.pointLights, true, notes);
    path += `, ${d.pointLights.count} omni lights (clustered lighting, the engine default)`;
  }
  if (d.post) {
    addPost(ctx, d.post, d.clearColor, notes);
    path += ', CameraFrame bloom';
  }
  const c = d.camera; // rewritten by scene.update(t)
  return {
    path,
    notes,
    update() {
      camera.setPosition(...c.position);
      camera.lookAt(...c.target);
      updateLights?.();
    },
  };
}
