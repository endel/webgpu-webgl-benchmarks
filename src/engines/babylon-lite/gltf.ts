import {
  addClusteredLightContainer, addToScene, createClusteredLightContainer, createClusteredPointLight, createCsmDirectionalShadowGenerator,
  getContainerMeshes, loadGltf, markClusteredLightContainerDirty, registerSceneWithShadowSupport, setShadowTaskCasterMeshes,
  type ClusteredPointLight,
} from '@babylonjs/lite';
import type { GltfScene } from '../../harness/types';
import type { Built, LiteCtx } from './index';
import { addForwardPointLights, addPost } from './lighting';
import { LIGHT_SCALE } from './index';

export async function buildGltf(ctx: LiteCtx, d: GltfScene, opt?: string): Promise<Built> {
  const { engine, scene } = ctx;
  const steps = ['loadGltf → AssetContainer'];
  const notes: string[] = [];

  // Forward point lights have no range window (inverse-square only), which over-lights the scene;
  // the clustered container is the only path with the range-windowed falloff of the spec.
  let syncLights: (() => void) | null = null;
  const pl = d.pointLights;
  const clustered = !!pl && opt !== 'forward';
  if (pl && !clustered) {
    if (d.manyLights) throw new Error('N/A: opt=forward cannot run the many-light step');
    syncLights = addForwardPointLights(scene, pl);
    steps.push(`${pl.count} forward point lights (setMaxLights ${scene.lights.length}, range ignored)`);
  }

  const asset = await loadGltf(engine, d.url);
  addToScene(scene, asset);
  const meshes = getContainerMeshes(asset);

  if (pl && clustered) {
    const container = createClusteredLightContainer();
    const lights: ClusteredPointLight[] = [];
    for (let i = 0; i < pl.count; i++) {
      lights.push(createClusteredPointLight(container, {
        position: [pl.position[i * 3], pl.position[i * 3 + 1], pl.position[i * 3 + 2]],
        diffuse: [pl.color[i * 3], pl.color[i * 3 + 1], pl.color[i * 3 + 2]],
        range: pl.range,
        intensity: pl.intensity * LIGHT_SCALE,
      }));
    }
    addClusteredLightContainer(scene, container);
    const p = pl.position;
    syncLights = () => {
      for (let i = 0; i < lights.length; i++) {
        const lp = lights[i].position;
        lp[0] = p[i * 3];
        lp[1] = p[i * 3 + 1];
        lp[2] = p[i * 3 + 2];
      }
      markClusteredLightContainerDirty(container);
    };
    steps.push(`${pl.count} point lights in a ClusteredLightContainer`);
    if (!d.manyLights) notes.push('forward PBR point lights have no range-windowed falloff (inverse-square only, `range` ignored), so the 32 lights are clustered too');
  }

  const sh = d.sun?.shadow;
  if (sh && ctx.sun) {
    ctx.sun.shadowGenerator = createCsmDirectionalShadowGenerator(engine, ctx.sun, { mapSize: sh.mapSize, numCascades: sh.cascades, shadowMaxZ: sh.maxDistance });
    for (const m of meshes) m.receiveShadows = true;
    setShadowTaskCasterMeshes(ctx.sun.shadowGenerator, meshes);
    steps.push(`CSM directional shadow generator (${sh.cascades} × ${sh.mapSize}, PCF)`);
  }
  if (d.post) {
    addPost(ctx, d.post);
    steps.push('bloom post-process task (after the in-shader ACES, 4× MSAA resolve)');
    notes.push('PBR shaders always write tone-mapped, gamma-encoded, clamped colour, so bloom runs on the display-referred image, not on HDR');
  }
  return {
    path: steps.join(' + '),
    notes,
    register: sh ? () => registerSceneWithShadowSupport(scene) : undefined,
    update: () => syncLights?.(),
  };
}
