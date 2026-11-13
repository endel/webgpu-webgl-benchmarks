import '@babylonjs/loaders/glTF/2.0';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { GetSupportedSimultaneousLights } from '@babylonjs/core/Materials/materialHelper.functions';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import type { Engine } from '@babylonjs/core/Engines/engine';
import type { GltfScene } from '../../harness/types';
import type { BabylonCtx, Built } from './index';
import { addPointLights, addPost } from './field';

// Scene, Mesh, Material and one spare block share the stage with the per-light blocks.
const NON_LIGHT_BLOCKS = 4;

/** How many forward lights one material can take: every light is its own uniform block on both backends. */
function forwardLightLimit(ctx: BabylonCtx, wanted: number) {
  if (ctx.webgpu) return GetSupportedSimultaneousLights(ctx.scene, wanted);
  const gl = (ctx.engine as Engine)._gl;
  return Math.min(wanted, gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS) - NON_LIGHT_BLOCKS);
}

export async function buildGltf(ctx: BabylonCtx, d: GltfScene): Promise<Built> {
  const { scene } = ctx;
  const container = await LoadAssetContainerAsync(d.url, scene);
  container.addAllToScene();
  const steps = ['glTF 2.0 loader → AssetContainer'];
  const notes: string[] = [];
  const pbr = scene.materials.filter((m): m is PBRMaterial => m instanceof PBRMaterial);

  const sh = d.sun?.shadow;
  if (sh && ctx.sun) {
    const csm = new CascadedShadowGenerator(sh.mapSize, ctx.sun);
    csm.numCascades = sh.cascades;
    csm.shadowMaxZ = sh.maxDistance;
    // The default bias (0.00005) self-shadows every surface; 0.01 is the docs' example value.
    csm.bias = 0.01;
    csm.normalBias = 0.02;
    for (const m of scene.meshes) {
      if (!m.getTotalVertices()) continue;
      m.receiveShadows = true;
      csm.addShadowCaster(m, false);
    }
    steps.push(`CascadedShadowGenerator (${sh.cascades} × ${sh.mapSize}, PCF)`);
  }

  let syncLights: (() => void) | null = null;
  const pl = d.pointLights;
  if (pl) {
    const wanted = pl.count + scene.lights.length;
    const fit = forwardLightLimit(ctx, wanted);
    const clustered = !!d.manyLights || fit < wanted;
    syncLights = addPointLights(scene, pl, clustered);
    for (const m of pbr) {
      // Range-windowed falloff like the other engines' `range`; clustering needs it set on the material, not the lights.
      m.useGLTFLightFalloff = true;
      if (!clustered) m.maxSimultaneousLights = wanted;
    }
    steps.push(clustered ? `${pl.count} point lights in a ClusteredLightContainer` : `${pl.count} forward point lights (maxSimultaneousLights ${wanted})`);
    if (clustered && !d.manyLights) notes.push(`forward lighting fits ${fit} of ${wanted} lights per material on ${ctx.webgpu ? 'WebGPU' : 'WebGL2'} (one uniform block per light), so the ${pl.count} lights are clustered`);
  }
  if (d.post) {
    addPost(ctx, d.post, d.clearColor);
    steps.push('DefaultRenderingPipeline (HDR, bloom, 4× MSAA)');
  }
  return {
    path: steps.join(' + '),
    notes,
    update: () => syncLights?.(),
  };
}
