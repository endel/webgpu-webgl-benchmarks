import '@babylonjs/loaders/glTF/2.0';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { VertexAnimationBaker } from '@babylonjs/core/BakedVertexAnimation/vertexAnimationBaker';
import { BakedVertexAnimationManager } from '@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager';
import type { CharactersScene, Variant } from '../../harness/types';
import type { BabylonCtx, Built } from './index';

// The glTF loader converts keyframe times to frames at 60 fps.
const FPS = 60;

export async function buildCharacters(ctx: BabylonCtx, d: CharactersScene, variant: Variant): Promise<Built> {
  const container = await LoadAssetContainerAsync(d.url, ctx.scene, {
    pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
  });
  return variant === 'optimized' ? baked(ctx, d, container) : skinned(ctx, d, container);
}

/** Clip frame range and duration in seconds. */
function clip(g: AnimationGroup) {
  return { from: g.from, frames: g.to - g.from, duration: (g.to - g.from) / FPS };
}

function skinned(ctx: BabylonCtx, d: CharactersScene, container: AssetContainer): Built {
  const clips = d.blend ? [d.clip, d.blend.clip] : [d.clip];
  const groups: AnimationGroup[][] = [];
  for (let i = 0; i < d.count; i++) {
    const inst = container.instantiateModelsToScene((name) => `${name}#${i}`);
    const root = new TransformNode(`character${i}`, ctx.scene);
    root.position.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
    root.rotation.y = d.yaw[i];
    root.scaling.setAll(d.scale);
    for (const n of inst.rootNodes) n.parent = root;
    inst.animationGroups.forEach((g, k) => !clips.includes(k) && g.dispose());
    groups.push(clips.map((k) => {
      const g = inst.animationGroups[k];
      g.start(true); // goToFrame() is a no-op on stopped groups
      if (d.blend) g.pause(); // paused groups keep their frame while scene.animate() resolves the weights
      return g;
    }));
  }
  const info = groups[0].map(clip);
  const w = d.blend?.weight;
  return {
    path: w
      ? 'instantiateModelsToScene per character (cloned skeletons), two weighted AnimationGroups per character'
      : 'instantiateModelsToScene per character (cloned skeletons, AnimationGroup.goToFrame)',
    animate: !!w,
    update(t) {
      for (let i = 0; i < groups.length; i++) {
        for (let k = 0; k < clips.length; k++) {
          const g = groups[i][k];
          if (w) g.setWeightForAllAnimatables(k ? w[i] : 1 - w[i]);
          g.goToFrame(info[k].from + ((t + d.phase[i]) % info[k].duration) * FPS, !!w);
        }
      }
    },
  };
}

/**
 * One thin-instanced mesh sampling a vertex animation texture. Per-instance offsets reproduce the
 * phases exactly: the shader picks floor((time + offset) mod frames), so feeding time = frac(t/dur)
 * * frames and offset = frac(phase/dur) * frames gives frame = floor(frames * frac((t+phase)/dur)).
 */
function baked(ctx: BabylonCtx, d: CharactersScene, container: AssetContainer): Built {
  container.addAllToScene();
  const mesh = container.meshes.find((m) => m.skeleton) as Mesh;
  const skeleton = mesh.skeleton!;
  const group = container.animationGroups[d.clip];
  const { from, frames: span, duration } = clip(group);
  const frames = Math.ceil(span);

  // VertexAnimationBaker drives skeleton animations; glTF animates the bones' linked nodes, so sample via the group.
  const stride = (skeleton.bones.length + 1) * 16;
  const data = new Float32Array(stride * frames);
  group.start(true);
  for (let k = 0; k < frames; k++) {
    group.goToFrame(from + (k / frames) * duration * FPS);
    skeleton.prepare(true);
    data.set(skeleton.getTransformMatrices(mesh), k * stride);
  }
  group.stop();
  const vat = new BakedVertexAnimationManager(ctx.scene);
  vat.texture = new VertexAnimationBaker(ctx.scene, mesh).textureFromBakedVertexData(data);
  mesh.bakedVertexAnimationManager = vat;

  // Thin-instance matrices apply in mesh space (world * instance): conjugate the placement by the mesh world.
  const world = mesh.computeWorldMatrix(true);
  const inv = world.clone().invert();
  const matrices = new Float32Array(d.count * 16);
  const settings = new Float32Array(d.count * 4);
  const scale = new Vector3(d.scale, d.scale, d.scale);
  for (let i = 0; i < d.count; i++) {
    const place = Matrix.Compose(scale, Quaternion.RotationYawPitchRoll(d.yaw[i], 0, 0), Vector3.FromArray(d.position, i * 3));
    world.multiply(place).multiply(inv).copyToArray(matrices, i * 16);
    settings.set([0, frames - 1, ((d.phase[i] / duration) % 1) * frames, 1], i * 4);
  }
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
  mesh.thinInstanceSetBuffer('bakedVertexAnimationSettingsInstanced', settings, 4, true);
  return {
    path: `Baked vertex animation texture (${frames} frames) on thin instances`,
    update(t) {
      vat.time = ((t / duration) % 1) * frames;
    },
  };
}
