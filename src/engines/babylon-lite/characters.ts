import {
  addAnimationGroups, addToScene, attachVat, bakeVat, createAnimationManager, createTransformNode, enableAnimationBlending,
  getContainerMeshes, loadGltf, playAnimation, setAnimationWeight, setThinInstances, setVatTime, stopAnimation, updateAnimationManager,
  type AnimationGroup, type AssetContainer, type SceneNode,
} from '@babylonjs/lite';
import type { CharactersScene, Variant } from '../../harness/types';
import type { Built, LiteCtx } from './index';

function pickGroups(asset: AssetContainer, d: CharactersScene) {
  const groups = asset.animationGroups ?? [];
  const a = groups[d.clip];
  if (!a) throw new Error(`babylon-lite: clip ${d.clip} missing (${groups.length} animation groups)`);
  const b = d.blend ? groups[d.blend.clip] : undefined;
  if (d.blend && !b) throw new Error(`babylon-lite: blend clip ${d.blend.clip} missing`);
  return { groups, a, b };
}

/**
 * One loadGltf per character: cloneTransformNode shares the skeleton (every clone would take the
 * same pose) and there is no API that instantiates an asset with a skeleton of its own.
 */
async function liveCharacters(ctx: LiteCtx, d: CharactersScene): Promise<Built> {
  const { engine, scene } = ctx;
  const file = await (await fetch(d.url)).arrayBuffer();
  const manager = createAnimationManager({ engine });
  const clips: { a: AnimationGroup; b?: AnimationGroup }[] = [];
  const BATCH = 8;
  for (let start = 0; start < d.count; start += BATCH) {
    const n = Math.min(BATCH, d.count - start);
    const assets = await Promise.all(Array.from({ length: n }, () => loadGltf(engine, file)));
    assets.forEach((asset, k) => {
      const i = start + k;
      const half = d.yaw[i] / 2;
      const root = createTransformNode(`char${i}`, d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2], 0, Math.sin(half), 0, Math.cos(half), d.scale, d.scale, d.scale);
      for (const e of asset.entities) {
        e.parent = root;
        root.children.push(e as SceneNode);
      }
      // The node, not the container: the container would hand its clips to the scene's own ticker.
      addToScene(scene, root);
      const { groups, a, b } = pickGroups(asset, d);
      for (const g of groups) {
        stopAnimation(g);
        setAnimationWeight(g, 0);
      }
      const active = b ? [a, b] : [a];
      for (const g of active) {
        g.loopAnimation = true;
        playAnimation(g);
      }
      setAnimationWeight(a, 1);
      addAnimationGroups(manager, active);
      clips.push({ a, b });
    });
  }
  if (d.blend) enableAnimationBlending(manager);
  const w = d.blend?.weight;
  return {
    path: d.blend
      ? 'loadGltf per character, two AnimationGroups mixed per skeleton (enableAnimationBlending), CPU bone matrices'
      : 'loadGltf per character, one AnimationGroup per skeleton, CPU bone matrices',
    notes: ['no API instantiates a skinned asset with its own skeleton (clones share one), so every character is a full loadGltf with its own geometry and textures'],
    update(t) {
      for (let i = 0; i < clips.length; i++) {
        const { a, b } = clips[i];
        const time = t + d.phase[i];
        a.currentTime = time % a.duration;
        if (b && w) {
          b.currentTime = time % b.duration;
          setAnimationWeight(a, 1 - w[i]);
          setAnimationWeight(b, w[i]);
        }
      }
      // The clocks are set above; the manager only evaluates and uploads.
      updateAnimationManager(manager, 0);
    },
  };
}

/** The clip baked to a vertex animation texture, the whole crowd one thin-instanced draw per primitive. */
async function vatCharacters(ctx: LiteCtx, d: CharactersScene): Promise<Built> {
  const { engine, scene } = ctx;
  const asset = await loadGltf(engine, d.url);
  for (const e of asset.entities) addToScene(scene, e as SceneNode);
  const { a } = pickGroups(asset, d);
  const skinned = getContainerMeshes(asset).filter((m) => m.skeleton);
  if (!skinned.length) throw new Error('babylon-lite: no skinned mesh in the asset');

  const matrices = new Float32Array(d.count * 16);
  const s = d.scale;
  for (let i = 0; i < d.count; i++) {
    const c = Math.cos(d.yaw[i]) * s, sn = Math.sin(d.yaw[i]) * s;
    matrices.set([c, 0, -sn, 0, 0, s, 0, 0, sn, 0, c, 0, d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2], 1], i * 16);
  }
  for (const mesh of skinned) {
    const baked = bakeVat(engine, mesh, [a]);
    const handle = attachVat(engine, mesh, baked, a.name);
    const clip = baked.clips[a.name];
    // Before registerScene: the per-instance params texture is part of the bind group.
    setThinInstances(mesh, matrices, d.count);
    const params = new Float32Array(d.count * 4);
    for (let i = 0; i < d.count; i++) params.set([clip.fromRow, clip.fromRow + clip.frameCount - 1, d.phase[i] * clip.fps, clip.fps], i * 4);
    handle.setInstances(params);
  }
  return {
    path: 'Vertex animation texture (bakeVat) + thin instances, per-instance phase, no CPU skinning',
    notes: ['VAT rows are baked at the clip frame rate and read without interpolation between frames'],
    update(t) {
      for (const mesh of skinned) setVatTime(engine, mesh, t);
    },
  };
}

export function buildCharacters(ctx: LiteCtx, d: CharactersScene, variant: Variant): Promise<Built> {
  return variant === 'optimized' ? vatCharacters(ctx, d) : liveCharacters(ctx, d);
}
