import {
  addToScene, cloneTransformNode, createDynamicTexture, createGpuPicker, createMeshFromData, createPbrMaterial, createPickingRay,
  createTransformNode, disposePicker, enableThinInstanceGpuCulling, flushThinInstances, getViewProjectionMatrix, pickAsync,
  pickWithRayPrecise, releaseTexture, removeFromScene, setThinInstances, updateDynamicTexture,
  type EngineContext, type Mesh, type PbrMaterialProps, type Texture2D, type TransformNode,
} from '@babylonjs/lite';
import { fieldWorldMatrices } from '../../harness/scenes';
import type { FieldScene, Geometry, PbrSpec, Variant } from '../../harness/types';
import { buildHud } from './hud';
import type { Built, LiteCtx } from './index';

export function toMesh(engine: EngineContext, g: Geometry, name = g.name) {
  // Lite's front faces are clockwise (Babylon's winding) even in the right-handed build.
  const idx = new Uint32Array(g.indices);
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  return createMeshFromData(engine, name, g.positions, g.normals, idx, g.uvs);
}

export function toMaterial(m: PbrSpec): PbrMaterialProps {
  const mat = createPbrMaterial({ baseColorFactor: [...m.color, 1], roughnessFactor: m.roughness, metallicFactor: m.metalness });
  if (m.opacity !== undefined && m.opacity < 1) {
    mat.alpha = m.opacity;
    mat.alphaBlend = true;
  }
  return mat;
}

/** One mesh per object, sharing its geometry's GPU buffers; parented to a node per group when the field has a hierarchy. */
function meshObjects(ctx: LiteCtx, d: FieldScene, mats: PbrMaterialProps[]) {
  const { engine, scene } = ctx;
  const sources = d.geometries.map((g) => toMesh(engine, g));
  const g = d.groups;
  const groups: TransformNode[] = [];
  if (g) {
    for (let k = 0; k < g.count; k++) {
      groups.push(createTransformNode(`group${k}`, g.position[k * 3], g.position[k * 3 + 1], g.position[k * 3 + 2], g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]));
    }
  }
  const meshes: Mesh[] = new Array(d.count);
  /** Build slot i from its current data; the caller adds it to the scene. */
  const spawn = (i: number, material: PbrMaterialProps) => {
    const m = cloneTransformNode(sources[d.geom[i]]) as Mesh;
    m.name = `m${i}`;
    m.material = material;
    m.position.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
    m.scaling.set(d.scale[i], d.scale[i], d.scale[i]);
    m.rotationQuaternion.set(d.quat[i * 4], d.quat[i * 4 + 1], d.quat[i * 4 + 2], d.quat[i * 4 + 3]);
    return (meshes[i] = m);
  };
  for (let i = 0; i < d.count; i++) {
    const m = spawn(i, mats[d.material[i]]);
    if (g) {
      const parent = groups[g.parent[i]];
      m.parent = parent;
      parent.children.push(m);
    } else addToScene(scene, m);
  }
  for (const node of groups) addToScene(scene, node);
  const q = d.quat;
  return {
    meshes,
    spawn,
    update() {
      if (g) for (let k = 0; k < groups.length; k++) groups[k].rotationQuaternion.set(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
      if (!d.animated) return;
      for (let i = 0; i < meshes.length; i++) meshes[i].rotationQuaternion.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
    },
  };
}

/** One thin-instanced mesh per (geometry, material): roughness and metalness are per material, not per instance. */
function thinObjects(ctx: LiteCtx, d: FieldScene, mats: PbrMaterialProps[], culled: boolean) {
  const { engine, scene } = ctx;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < d.count; i++) {
    const key = d.geom[i] * mats.length + d.material[i];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const parts = [...buckets].map(([key, idx]) => {
    const mesh = toMesh(engine, d.geometries[Math.floor(key / mats.length)], `thin${key}`);
    mesh.material = mats[key % mats.length];
    const buf = new Float32Array(idx.length * 16);
    for (let k = 0; k < idx.length; k++) buf.set(world.subarray(idx[k] * 16, idx[k] * 16 + 16), k * 16);
    setThinInstances(mesh, buf, idx.length);
    // Compute-shader culling into an indirect draw; must be set before registerScene.
    if (culled) enableThinInstanceGpuCulling(mesh);
    addToScene(scene, mesh);
    return { mesh, idx, buf };
  });
  return {
    meshes: parts.map((p) => p.mesh),
    update() {
      if (!d.animated && !d.groups) return;
      fieldWorldMatrices(d, world);
      for (const p of parts) {
        const { idx, buf } = p;
        for (let k = 0; k < idx.length; k++) {
          const o = idx[k] * 16, t = k * 16;
          for (let c = 0; c < 16; c++) buf[t + c] = world[o + c];
        }
        flushThinInstances(p.mesh);
      }
    },
  };
}

/** K3: slots are removed and re-added with a fresh material; one texture per frame, released when its batch comes round. */
function churner(ctx: LiteCtx, d: FieldScene, objects: ReturnType<typeof meshObjects>) {
  const { engine, scene } = ctx;
  const churn = d.churn!;
  const { size, pixels } = churn.texture;
  // A view on the live pixels: update(t) rewrites them in place.
  const image = new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength), size, size);
  const textures: (Texture2D | undefined)[] = [];
  return () => {
    if (!churn.n) return;
    for (let k = 0; k < churn.n; k++) removeFromScene(scene, objects.meshes[churn.slots[k]]);
    const old = textures[churn.batch];
    if (old) releaseTexture(old);
    // The only synchronous texture factory with a mip chain; sRGB + trilinear like a loaded image.
    const texture = createDynamicTexture(engine, size, size, { mipMaps: true, srgb: true, addressModeU: 'repeat', addressModeV: 'repeat' });
    updateDynamicTexture(engine, texture, image, { invertY: false });
    textures[churn.batch] = texture;
    for (let k = 0; k < churn.n; k++) {
      const i = churn.slots[k];
      const material = toMaterial(d.materials[d.material[i]]);
      material.baseColorTexture = texture;
      const m = objects.spawn(i, material);
      addToScene(scene, m);
    }
  };
}

function picking(ctx: LiteCtx, meshes: Mesh[], gpu: boolean) {
  const { scene, camera, engine } = ctx;
  const slot = new Map<Mesh, number>(meshes.map((m, i) => [m, i]));
  const canvas = engine.canvas as HTMLCanvasElement;
  if (gpu) {
    const picker = createGpuPicker(scene);
    return {
      // pickAsync takes CSS pixels; the canvas backing store is 1:1 with the spec's pixels.
      pick: async (x: number, y: number) => {
        const css = canvas.clientWidth / canvas.width;
        const info = await pickAsync(picker, x * css, y * css);
        return info.hit ? slot.get(info.pickedMesh as Mesh) ?? -1 : -1;
      },
      dispose: () => disposePicker(picker),
    };
  }
  return {
    pick: (x: number, y: number) => {
      const ray = createPickingRay(x, y, getViewProjectionMatrix(camera, canvas.width / canvas.height), canvas.width, canvas.height);
      if (!ray) return -1;
      // pickWithRay only tests bounding boxes; the precise variant walks triangles.
      const info = pickWithRayPrecise(scene, ray);
      return info.hit ? slot.get(info.pickedMesh as Mesh) ?? -1 : -1;
    },
    dispose: () => {},
  };
}

export async function buildField(ctx: LiteCtx, d: FieldScene, variant: Variant, _opt?: string): Promise<Built> {
  if (d.ground || d.spots || d.pointLights || d.post || d.shadows) throw new Error('N/A: field ground/spot/point-light/post features are not part of the key tests and are not implemented for Babylon Lite');
  const mats = d.materials.map(toMaterial);
  const optimized = variant === 'optimized';
  if (optimized && !d.pick) {
    const culled = !d.animated && !d.groups;
    const objects = thinObjects(ctx, d, mats, culled);
    return {
      path: culled ? 'One thin-instanced mesh per geometry × material + GPU frustum culling (enableThinInstanceGpuCulling)' : 'One thin-instanced mesh per geometry × material',
      update: objects.update,
    };
  }
  const objects = meshObjects(ctx, d, mats);
  const churn = d.churn ? churner(ctx, d, objects) : null;
  const hud = d.hud ? await buildHud(ctx, d.hud) : null;
  const picker = d.pick ? picking(ctx, objects.meshes, optimized) : null;
  const steps = [d.groups ? 'Mesh per object parented to a TransformNode per group (scene defaults)' : 'Mesh per object (scene defaults)'];
  const notes: string[] = [];
  if (d.materials.some((m) => (m.opacity ?? 1) < 1)) steps.push('alphaBlend PBR, engine back-to-front sort');
  if (churn) steps.push('removeFromScene + addToScene per respawn, createDynamicTexture per frame');
  if (hud) {
    steps.push(hud.path);
    notes.push(...hud.notes);
  }
  if (picker) steps.push(optimized ? 'GPU picker (createGpuPicker + pickAsync, 1×1 id pass + readback)' : 'CPU triangle ray pick (createPickingRay + pickWithRayPrecise)');
  if (d.cameraLive && !d.animated) notes.push('ordinary meshes are not frustum-culled: every mesh is drawn from the cached render bundle');
  return {
    path: steps.join(' + '),
    notes,
    update() {
      churn?.();
      objects.update();
      hud?.update();
    },
    afterReady: () => hud?.register(),
    pick: picker?.pick,
    dispose() {
      hud?.dispose();
      picker?.dispose();
    },
  };
}
