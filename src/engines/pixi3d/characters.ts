import { Geometry3D, getAttributeData, Mesh3D, Model3D, Vector3, type Scene3DSource } from '@pixi/3d';
import { Assets, type Ticker } from 'pixi.js';
import type { CharactersScene, Variant } from '../../harness/types';
import type { Built, Ctx } from './common';

// update() advances by ticker.deltaMS; the harness sets absolute clip times, so the step is zero
const NO_STEP = { deltaMS: 0 } as Ticker;

export async function buildCharacters({ view }: Ctx, d: CharactersScene, variant: Variant): Promise<Built> {
  if (variant === 'optimized') {
    throw new Error('N/A: @pixi/3d 0.1.0 has no instanced or baked skinning path (BatchedMesh3D slots take a geometry, a material and a matrix, no skeleton); Model3D per character is the only crowd path');
  }
  const source = await Assets.load<Scene3DSource>(d.url);
  const labels = Object.keys(source.animations);
  const clipA = labels[d.clip], clipB = d.blend ? labels[d.blend.clip] : null;
  const durA = source.animations[clipA].duration, durB = clipB ? source.animations[clipB].duration : 0;
  const fixed = new Map<Geometry3D, Geometry3D>();
  const chars = Array.from({ length: d.count }, (_, i) => {
    const model = new Model3D({
      source,
      autoUpdate: false,
      castShadow: false,
      receiveShadow: false,
      position: { x: d.position[i * 3], y: d.position[i * 3 + 1], z: d.position[i * 3 + 2] },
      rotation: { x: 0, y: d.yaw[i], z: 0 },
      scale: d.scale,
    });
    model.traverse((n) => {
      if (!(n instanceof Mesh3D) || n.geometry.attributes.aNormal) return;
      let g = fixed.get(n.geometry);
      if (!g) fixed.set(n.geometry, (g = withFaceNormals(n.geometry)));
      n.geometry = g;
    });
    view.root.addChild(model);
    const player = model.player!;
    return { player, a: player.play(clipA), b: clipB ? player.play(clipB) : null };
  });
  const notes = fixed.size ? ['glTF has no normals: flat normals rebuilt once with getAttributeData (documented 0.1.0 limitation, from-threejs.md)'] : [];
  return {
    path: `Model3D per character (shared Scene3DSource), AnimationPlayer${clipB ? ' with two weighted AnimationStates' : ''}`,
    notes,
    update(t) {
      const w = d.blend?.weight;
      for (let i = 0; i < d.count; i++) {
        const c = chars[i];
        const time = t + d.phase[i];
        c.a.time = time % durA;
        if (c.b && w) {
          // weights are relative shares between the playing states
          c.a.weight = 1 - w[i];
          c.b.weight = w[i];
          c.b.time = time % durB;
        }
        c.player.update(NO_STEP);
      }
    },
  };
}

/** The loader lights a mesh without normals as if every face pointed +Z; its triangles share no vertices. */
function withFaceNormals(old: Geometry3D) {
  const positions = getAttributeData(old, 'aPosition', 3);
  const normals = new Float32Array(positions.length);
  const a = new Vector3(), ab = new Vector3(), ac = new Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i);
    ab.fromArray(positions, i + 3).subtract(a);
    ac.fromArray(positions, i + 6).subtract(a);
    ab.cross(ac).normalize();
    for (let v = 0; v < 9; v += 3) ab.toArray(normals, i + v);
  }
  return new Geometry3D({ positions, normals, uvs: old.attributes.aUV, joints: old.attributes.aJoints, weights: old.attributes.aWeights });
}
