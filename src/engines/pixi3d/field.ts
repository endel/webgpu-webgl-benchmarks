import { BatchedMesh3D, Container3D, createRaycastHit3D, Matrix4, Mesh3D, RenderPassBit, type Geometry3D, type Material3D } from '@pixi/3d';
import { BufferImageSource, Texture } from 'pixi.js';
import { fieldWorldMatrices } from '../../harness/scenes';
import type { FieldScene, Variant } from '../../harness/types';
import { aimCamera, toGeometry, toMaterial, type Built, type Ctx } from './common';
import { buildHud } from './hud';

interface Objects {
  path: string;
  notes?: string[];
  /** Per-frame work; absent for static fields. */
  update?(): void;
  pick?(x: number, y: number): number;
}

export async function buildField(ctx: Ctx, d: FieldScene, variant: Variant): Promise<Built> {
  if (d.ground || d.spots || d.pointLights || d.post) throw new Error('pixi3d field: ground / spots / pointLights / post are not part of the key tests');
  const geos = d.geometries.map(toGeometry);
  const mats = d.materials.map((m) => toMaterial(m));
  let objects: Objects;
  if (variant === 'optimized') {
    if (d.pick) throw new Error('N/A: @pixi/3d 0.1.0 has no accelerated picker (view.raycast is a CPU ray test with no BVH; no first-party GPU id-buffer picker)');
    objects = batched(ctx, d, geos, mats);
  } else if (d.churn) objects = churn(ctx, d, geos, mats);
  else objects = naive(ctx, d, geos, mats);

  const updates: (() => void)[] = [];
  if (d.cameraLive) updates.push(() => aimCamera(ctx.view, d));
  if (objects.update) updates.push(objects.update);
  let path = objects.path;
  if (d.hud) {
    const hud = await buildHud(ctx, d.hud);
    updates.push(hud.update);
    path += ` + ${hud.path}`;
  }
  return { path, notes: objects.notes, update: () => updates.forEach((u) => u()), pick: objects.pick };
}

function mesh(d: FieldScene, i: number, geometry: Geometry3D, material: Material3D, parent: Container3D) {
  const m = new Mesh3D({ geometry, material, castShadow: d.shadows, receiveShadow: d.shadows });
  m.position.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
  m.scale = d.scale[i];
  m.quaternion.set(d.quat[i * 4], d.quat[i * 4 + 1], d.quat[i * 4 + 2], d.quat[i * 4 + 3]);
  parent.addChild(m);
  return m;
}

function naive({ view }: Ctx, d: FieldScene, geos: Geometry3D[], mats: Material3D[]): Objects & { meshes: Mesh3D[] } {
  const g = d.groups;
  const groups = g
    ? Array.from({ length: g.count }, (_, k) => {
        const node = new Container3D({ position: { x: g.position[k * 3], y: g.position[k * 3 + 1], z: g.position[k * 3 + 2] } });
        node.quaternion.set(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
        view.root.addChild(node);
        return node;
      })
    : null;
  const meshes: Mesh3D[] = new Array(d.count);
  for (let i = 0; i < d.count; i++) meshes[i] = mesh(d, i, geos[d.geom[i]], mats[d.material[i]], groups ? groups[g!.parent[i]] : view.root);

  let pick: Objects['pick'];
  if (d.pick) {
    const ids = new Map<Container3D, number>();
    meshes.forEach((m, i) => {
      // nothing picks at the default 'passive'; the default hit shape is the bounding box
      m.eventMode = 'static';
      m.hitVolume = 'geometry';
      ids.set(m, i);
    });
    const hit = createRaycastHit3D(), p = { x: 0, y: 0 };
    pick = (x, y) => {
      p.x = x;
      p.y = y;
      return view.raycast(p, hit) ? ids.get(hit.target) ?? -1 : -1;
    };
  }
  const transparent = d.materials.some((m) => (m.opacity ?? 1) < 1);
  return {
    meshes,
    path: `${g ? 'Container3D per group, ' : ''}Mesh3D per object (auto-batched by the view, cull 'gpu' default)${transparent ? ", alphaMode 'blend'" : ''}${d.pick ? ", view.raycast with hitVolume 'geometry'" : ''}`,
    update: d.animated
      ? () => {
          const q = d.quat;
          for (let i = 0; i < d.count; i++) meshes[i].quaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
          if (g && groups) for (let k = 0; k < g.count; k++) groups[k].quaternion.set(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
        }
      : undefined,
    pick,
  };
}

/** K2 / K5 optimized: one BatchedMesh3D, a slot per object, world matrices written flat. */
function batched({ view }: Ctx, d: FieldScene, geos: Geometry3D[], mats: Material3D[]): Objects {
  // a static world spreads far beyond the screen: per-slot frustum culling, off by default on a batch
  const cull = d.animated ? 'off' : 'gpu';
  const batch = new BatchedMesh3D({ size: d.count, cull });
  const passes = RenderPassBit.OPAQUE | (d.shadows ? RenderPassBit.SHADOW : 0);
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const m = new Matrix4();
  for (let i = 0; i < d.count; i++) {
    batch.setGeometryAt(i, geos[d.geom[i]]);
    batch.setMaterialAt(i, mats[d.material[i]]);
    batch.setMatrixAt(i, m.fromArray(world, i * 16));
    batch.setPassesAt(i, passes);
  }
  view.root.addChild(batch);
  return {
    path: `BatchedMesh3D (one slot per object, ${mats.length} materials, cull '${cull}')${d.animated ? ', matrices written into batch.matrices' : ''}`,
    update: d.animated
      ? () => {
          const { data, stride, offset } = batch.matrices;
          fieldWorldMatrices(d, world);
          for (let i = 0, o = offset; i < d.count; i++, o += stride) for (let k = 0; k < 16; k++) data[o + k] = world[i * 16 + k];
          batch.matrices.update();
        }
      : undefined,
  };
}

/** K3: respawned slots own a material; each frame's texture is owned by its ring batch. */
function churn(ctx: Ctx, d: FieldScene, geos: Geometry3D[], mats: Material3D[]): Objects {
  const c = d.churn!;
  const { meshes } = naive(ctx, d, geos, mats);
  const owned: (Material3D | undefined)[] = new Array(d.count);
  const textures: (Texture | undefined)[] = [];
  const { size, pixels } = c.texture;
  return {
    path: 'Mesh3D per object; destroy() + new Mesh3D / Material3D per respawn, one BufferImageSource texture per frame (mipmapped, trilinear)',
    update() {
      if (c.n > 0) {
        textures[c.batch]?.destroy(true);
        // uploaded during this frame's render, before update(t) rewrites the pixels
        const tex = (textures[c.batch] = new Texture({ source: new BufferImageSource({ resource: pixels, width: size, height: size, format: 'rgba8unorm', alphaMode: 'no-premultiply-alpha', autoGenerateMipmaps: true, scaleMode: 'linear', mipmapFilter: 'linear' }) }));
        for (let k = 0; k < c.n; k++) {
          const i = c.slots[k];
          meshes[i].destroy();
          owned[i]?.destroy();
          const material = (owned[i] = toMaterial(d.materials[d.material[i]], tex));
          meshes[i] = mesh(d, i, geos[d.geom[i]], material, ctx.view.root);
        }
      }
      // the spin applies to every slot, fresh ones included
      const q = d.quat;
      for (let i = 0; i < d.count; i++) meshes[i].quaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
    },
  };
}
