import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { GetSupportedSimultaneousLights } from '@babylonjs/core/Materials/materialHelper.functions';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { GPUPicker } from '@babylonjs/core/Collisions/gpuPicker';
// Side effects: scene.pick, scene.createOrUpdateSelectionOctree.
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Culling/Octrees/octreeSceneComponent';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { ClusteredLightContainer } from '@babylonjs/core/Lights/Clustered/clusteredLightContainer';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { SnapshotRenderingHelper } from '@babylonjs/core/Misc/snapshotRenderingHelper';
import { ScenePerformancePriority, type Scene } from '@babylonjs/core/scene';
import type { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import type { FieldScene, Geometry, PbrSpec, PointLightsSpec, PostSpec, Variant, Vec3 } from '../../harness/types';
import { fieldWorldMatrices } from '../../harness/scenes';
import { deg } from '../common';
import { LIGHT_SCALE, type BabylonCtx, type Built } from './index';

export function toMesh(g: Geometry, scene: Scene, name = g.name) {
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.uvs = g.uvs;
  // Babylon's front faces are clockwise (its builders' winding) even with useRightHandedSystem,
  // so the shared CCW triangles would be culled as back faces and the interiors drawn instead.
  const idx = g.indices.slice();
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  vd.indices = idx;
  vd.applyToMesh(m, false);
  return m;
}

export function toMaterial(m: PbrSpec, scene: Scene, name = 'pbr') {
  const mat = new PBRMaterial(name, scene);
  // PBR albedo is linear, like glTF baseColorFactor.
  mat.albedoColor = new Color3(...m.color);
  mat.roughness = m.roughness;
  mat.metallic = m.metalness;
  mat.ambientColor = Color3.White(); // scene.ambientColor × this is the flat ambient term
  if (m.opacity !== undefined && m.opacity < 1) {
    mat.alpha = m.opacity; // alpha-blends, skips depth write and sorts back to front by default
    // PBR raises alpha under highlights by default; the other engines blend with the plain opacity.
    mat.useRadianceOverAlpha = mat.useSpecularOverAlpha = false;
  }
  return mat;
}

/** S1 optimized candidates (`opt`). */
const FAST_PATHS = {
  priority: 'Mesh clone per object, Intermediate priority + frozen active meshes/materials',
  bundles: 'Mesh clone per object, Intermediate priority + WebGPU non-compatibility mode (render bundles)',
  snapshot: 'Mesh clone per object, FAST snapshot rendering (updateMesh per frame)',
  thin: 'One thin-instanced mesh per geometry',
};
type FastPath = keyof typeof FAST_PATHS;
// Measured fastest on both backends (per-mesh paths pay a UBO write per moved mesh per frame).
const DEFAULT_FAST = { webgpu: 'thin', webgl2: 'thin' } satisfies Record<string, FastPath>;

function pickFastPath(ctx: BabylonCtx, opt: string | undefined, notes: string[]): FastPath {
  const want = opt ?? DEFAULT_FAST[ctx.webgpu ? 'webgpu' : 'webgl2'];
  if (!(want in FAST_PATHS)) throw new Error(`babylon: unknown opt "${want}" (${Object.keys(FAST_PATHS).join(', ')})`);
  if (!ctx.webgpu && (want === 'bundles' || want === 'snapshot')) {
    notes.push(`${want} is WebGPU-only; WebGL2 uses ${DEFAULT_FAST.webgl2}`);
    return DEFAULT_FAST.webgl2;
  }
  return want as FastPath;
}

export function addPointLights(scene: Scene, pl: PointLightsSpec, clustered: boolean) {
  const lights: PointLight[] = [];
  for (let i = 0; i < pl.count; i++) {
    // Clustered lights belong to the container only (the docs advise not adding them to the scene).
    const l = new PointLight(`point${i}`, Vector3.FromArray(pl.position, i * 3), scene, clustered);
    l.diffuse = l.specular = Color3.FromArray(pl.color, i * 3);
    l.intensity = pl.intensity * LIGHT_SCALE;
    l.range = pl.range;
    lights.push(l);
  }
  if (clustered && !new ClusteredLightContainer('clustered', lights, scene).isSupported) {
    throw new Error('N/A: clustered lighting needs blendable float render targets');
  }
  const p = pl.position;
  return () => {
    for (let i = 0; i < lights.length; i++) lights[i].position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  };
}

function addSpotsAndShadows(ctx: BabylonCtx, d: FieldScene) {
  const gens: ShadowGenerator[] = [];
  d.spots?.forEach((s, i) => {
    const pos = new Vector3(...s.position);
    // Babylon cone angles are full angles; the spec's are half-angles.
    const l = new SpotLight(`spot${i}`, pos, new Vector3(...s.target).subtract(pos).normalize(), deg(2 * s.angle), 2, ctx.scene);
    l.innerAngle = deg(2 * s.angle * (1 - s.penumbra));
    l.diffuse = l.specular = new Color3(...s.color);
    l.intensity = s.intensity * LIGHT_SCALE;
    l.range = s.range;
    if (d.shadows) gens.push(new ShadowGenerator(s.shadowMapSize, l));
  });
  const sh = d.sun?.shadow;
  if (d.shadows && sh && ctx.sun) {
    const csm = new CascadedShadowGenerator(sh.mapSize, ctx.sun);
    csm.numCascades = sh.cascades;
    csm.shadowMaxZ = sh.maxDistance;
    gens.push(csm);
  }
  // The default bias (0.00005) self-shadows every object; 0.01 is the docs' example value.
  for (const g of gens) {
    g.bias = 0.01;
    g.normalBias = 0.02;
  }
  return gens;
}

export function addPost(ctx: BabylonCtx, { bloom }: PostSpec, clearColor: Vec3) {
  const p = new DefaultRenderingPipeline('post', true, ctx.scene, [ctx.camera]);
  p.samples = 4;
  p.fxaaEnabled = false;
  p.bloomEnabled = true;
  p.bloomWeight = bloom.strength;
  p.bloomThreshold = bloom.threshold;
  p.bloomKernel = 128 * bloom.radius; // Babylon's default kernel (64) ↔ radius 0.5
  // The clear now lands in the linear HDR target and is tone-mapped with the rest of the frame.
  ctx.scene.clearColor = new Color4(...clearColor, 1);
}

function cloneObjects(scene: Scene, d: FieldScene, mats: PBRMaterial[], tuned: boolean) {
  const sources = d.geometries.map((g) => {
    const m = toMesh(g, scene);
    m.setEnabled(false);
    return m;
  });
  const g = d.groups;
  const nodes: TransformNode[] = [];
  for (let k = 0; g && k < g.count; k++) {
    const n = new TransformNode(`group${k}`, scene);
    n.position.set(g.position[k * 3], g.position[k * 3 + 1], g.position[k * 3 + 2]);
    n.rotationQuaternion = Quaternion.FromArray(g.quat, k * 4);
    nodes.push(n);
  }
  const spawn = (i: number, material: PBRMaterial) => {
    // clone() shares the source geometry; each clone is still its own draw.
    const m = sources[d.geom[i]].clone(`m${i}`)!;
    m.setEnabled(true);
    m.material = material;
    if (g) m.parent = nodes[g.parent[i]];
    m.position.set(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
    m.scaling.setAll(d.scale[i]);
    m.rotationQuaternion = Quaternion.FromArray(d.quat, i * 4);
    m.receiveShadows = d.shadows;
    if (tuned) {
      m.isPickable = false;
      m.alwaysSelectAsActiveMesh = true;
      m.doNotSyncBoundingInfo = true;
    }
    return m;
  };
  const meshes: Mesh[] = new Array(d.count);
  for (let i = 0; i < d.count; i++) meshes[i] = spawn(i, mats[d.material[i]]);
  const q = d.quat;
  return {
    meshes,
    spawn,
    update() {
      for (let i = 0; i < meshes.length; i++) meshes[i].rotationQuaternion!.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
      for (let k = 0; g && k < nodes.length; k++) nodes[k].rotationQuaternion!.set(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
    },
  };
}

/** K3: respawn the frame's slots, each with a new material sampling the frame's new texture. */
function churner(scene: Scene, d: FieldScene, objects: ReturnType<typeof cloneObjects>) {
  const c = d.churn!;
  const owned: (PBRMaterial | undefined)[] = [];
  const textures: (BaseTexture | undefined)[] = [];
  return () => {
    if (!c.n) return;
    textures[c.batch]?.dispose();
    // The upload is synchronous, so the live pixel array can be handed over as is.
    const { size, pixels } = c.texture;
    // Like a loaded image: mipmapped, trilinear, in an sRGB buffer.
    const tex = (textures[c.batch] = RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, true));
    for (let k = 0; k < c.n; k++) {
      const i = c.slots[k];
      objects.meshes[i].dispose();
      owned[i]?.dispose();
      const mat = (owned[i] = toMaterial(d.materials[d.material[i]], scene, `spawn${i}`));
      mat.albedoTexture = tex;
      objects.meshes[i] = objects.spawn(i, mat);
    }
  };
}

/** K8. scene.pick takes render-target pixels; GPUPicker takes CSS pixels of the canvas. */
function picker(ctx: BabylonCtx, meshes: Mesh[], gpu: boolean): NonNullable<Built['pick']> {
  const { scene } = ctx;
  const slot = new Map(meshes.map((m, i) => [m.uniqueId, i]));
  const id = (m: { uniqueId: number } | null | undefined) => (m ? slot.get(m.uniqueId) ?? -1 : -1);
  if (!gpu) return (x, y) => id(scene.pick(x, y).pickedMesh);
  const gp = new GPUPicker();
  gp.setPickingList(meshes);
  const css = ctx.engine.getInputElementClientRect()!.width / ctx.engine.getRenderWidth();
  const height = ctx.engine.getRenderHeight();
  return async (x, y, render) => {
    let done = false, hit = -1;
    // On WebGPU (9.36) the picker reads the vertically mirrored pixel.
    gp.pickAsync(x * css, (ctx.webgpu ? height - 1 - y : y) * css).then((r) => ((hit = id(r?.mesh)), (done = true)));
    // The id pass runs as a custom render target inside scene.render(); the picker drops it from the
    // list once drawn. Further frames would only queue GPU work ahead of the readback.
    for (let drawn = false; !done; ) {
      await new Promise(requestAnimationFrame);
      if (drawn) continue;
      const pending = scene.customRenderTargets.length > 0;
      render();
      drawn = pending && !scene.customRenderTargets.length;
    }
    return hit;
  };
}

/**
 * K5: static thin-instance batches per (grid cell, geometry, material). Thin instances are not
 * culled individually, so the cell is the culling unit.
 */
function cellObjects(scene: Scene, d: FieldScene, mats: PBRMaterial[], cell: number) {
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < d.count; i++) {
    const key = `${Math.floor(d.position[i * 3] / cell)},${Math.floor(d.position[i * 3 + 2] / cell)},${d.geom[i]},${d.material[i]}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }
  const meshes: Mesh[] = [];
  for (const [key, idx] of buckets) {
    const i0 = idx[0];
    // Not a clone: thin-instance buffers live on the geometry, which clones share.
    const mesh = toMesh(d.geometries[d.geom[i0]], scene, `cell${key}`);
    mesh.material = mats[d.material[i0]];
    mesh.isPickable = false;
    const buf = new Float32Array(idx.length * 16);
    for (let k = 0; k < idx.length; k++) buf.set(world.subarray(idx[k] * 16, idx[k] * 16 + 16), k * 16);
    mesh.thinInstanceSetBuffer('matrix', buf, 16, true); // also fits the bounding box to the instances
    mesh.freezeWorldMatrix();
    meshes.push(mesh);
  }
  return { meshes, cells: new Set([...buckets.keys()].map((k) => k.split(',').slice(0, 2).join())).size };
}

function thinObjects(scene: Scene, d: FieldScene, mats: PBRMaterial[]) {
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < d.count; i++) {
    const key = d.geom[i] * mats.length + d.material[i];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }
  const world = new Float32Array(d.count * 16);
  const write = (idx: number[], out: Float32Array) => {
    for (let k = 0; k < idx.length; k++) {
      const o = idx[k] * 16, t = k * 16;
      for (let j = 0; j < 16; j++) out[t + j] = world[o + j];
    }
  };
  fieldWorldMatrices(d, world);
  const parts = [...buckets].map(([key, idx]) => {
    const mesh = toMesh(d.geometries[Math.floor(key / mats.length)], scene, `thin${key}`);
    mesh.material = mats[key % mats.length];
    mesh.receiveShadows = d.shadows;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    const buf = new Float32Array(idx.length * 16);
    write(idx, buf);
    mesh.thinInstanceSetBuffer('matrix', buf, 16, false);
    return { mesh, idx, buf };
  });
  return {
    meshes: parts.map((p) => p.mesh),
    update() {
      fieldWorldMatrices(d, world); // also flattens the K2 hierarchy
      for (const p of parts) {
        write(p.idx, p.buf);
        p.mesh.thinInstanceBufferUpdated('matrix');
      }
    },
  };
}

/** K5 optimized candidates (`opt`). */
const WORLD_PATHS = ['cells', 'frozen'];
const CELL = 40;

export function buildField(ctx: BabylonCtx, d: FieldScene, variant: Variant, opt?: string): Built {
  const { scene } = ctx;
  const notes: string[] = [];
  const optimized = variant === 'optimized';
  const clustered = optimized && !!d.pointLights;
  const gpuPick = optimized && !!d.pick;
  const world = optimized && !gpuPick && !d.animated && !!d.cameraLive ? opt ?? WORLD_PATHS[0] : null;
  if (world && !WORLD_PATHS.includes(world)) throw new Error(`babylon: unknown opt "${world}" (${WORLD_PATHS.join(', ')})`);
  const fast = optimized && !d.pointLights && !gpuPick && !world ? pickFastPath(ctx, opt, notes) : null;
  const tuned = fast === 'priority' || fast === 'bundles';
  if (tuned) {
    // Set before creating meshes, as the docs require.
    scene.performancePriority = ScenePerformancePriority.Intermediate;
    scene.autoClear = true; // Intermediate turns clearing off; the clear color is part of the image
    if (fast === 'bundles') (ctx.engine as WebGPUEngine).compatibilityMode = false;
  }

  const syncLights = d.pointLights ? addPointLights(scene, d.pointLights, clustered) : null;
  const shadowGens = addSpotsAndShadows(ctx, d);
  // On WebGPU each forward light is its own uniform buffer; Babylon silently drops lights past the
  // per-stage limit, which would render a different image — fail instead.
  const lights = scene.lights.length;
  const supported = GetSupportedSimultaneousLights(scene, lights);
  if (supported < lights) {
    const limit = ctx.engine.getCaps().maxUniformBuffersPerShaderStage;
    throw new Error(`babylon: ${lights} forward lights need ${lights} uniform buffers per stage, only ${supported} fit (maxUniformBuffersPerShaderStage ${limit} minus scene/mesh/material/leftover)`);
  }
  const material = (m: PbrSpec, name: string) => {
    const mat = toMaterial(m, scene, name);
    mat.maxSimultaneousLights = Math.max(mat.maxSimultaneousLights, lights);
    // Range-windowed falloff like the other engines' `range`; clustering needs it set on the material, not the lights.
    if (d.pointLights || d.spots) mat.useGLTFLightFalloff = true;
    return mat;
  };
  const mats = d.materials.map((m, i) => material(m, `mat${i}`));
  if (d.ground) {
    const g = CreateGround('ground', { width: d.ground.size, height: d.ground.size }, scene);
    g.material = material(d.ground.material, 'ground');
    g.receiveShadows = d.shadows;
  }

  if (world === 'cells') {
    const { meshes, cells } = cellObjects(scene, d, mats, CELL);
    scene.skipPointerMovePicking = true;
    return {
      path: `Static thin instances per ${CELL} m grid cell × geometry × material (${meshes.length} batches in ${cells} cells), frozen world matrices and materials`,
      update() {},
      afterReady: () => scene.freezeMaterials(),
    };
  }

  const clones = fast === 'thin' ? null : cloneObjects(scene, d, mats, fast !== null);
  const objects = clones ?? thinObjects(scene, d, mats);
  for (const g of shadowGens) g.getShadowMap()!.renderList!.push(...objects.meshes);
  if (d.post) addPost(ctx, d.post, d.clearColor);
  const snapshot = fast === 'snapshot' ? new SnapshotRenderingHelper(scene) : null;
  const churn = d.churn && clones ? churner(scene, d, clones) : null;
  if (world === 'frozen') {
    for (const m of objects.meshes) {
      m.freezeWorldMatrix();
      m.isPickable = false;
    }
    scene.skipPointerMovePicking = true;
    scene.createOrUpdateSelectionOctree(64, 6);
  }

  let path = 'Mesh clone per object (scene defaults)';
  if (clustered) path = 'Mesh clone per object + ClusteredLightContainer';
  else if (fast) path = FAST_PATHS[fast] + (fast === 'thin' ? ` × material (${objects.meshes.length} batches)` : '');
  else if (world) path = 'Mesh clone per object, frozen world matrices and materials, selection octree';
  else if (d.groups) path = 'Mesh clone per object parented to a TransformNode per group';
  else if (churn) path = 'Mesh clone + new PBRMaterial per spawn, one RawTexture per frame; dispose() on despawn';
  else if (d.materials.some((m) => (m.opacity ?? 1) < 1)) path = 'Mesh clone per object, PBR alpha blending (engine-sorted transparent queue)';
  if (d.pick) {
    path = !gpuPick ? 'scene.pick (CPU ray against bounding volumes, then triangles) over Mesh clones'
      : 'GPUPicker.pickAsync (id render target, 1-pixel scissor, async readback) over Mesh clones';
  }

  return {
    path,
    notes,
    update() {
      syncLights?.();
      churn?.();
      if (!d.animated) return;
      objects.update();
      snapshot?.updateMesh(objects.meshes, false);
    },
    afterReady() {
      if (tuned || world) scene.freezeMaterials();
      if (tuned) scene.freezeActiveMeshes();
      snapshot?.enableSnapshotRendering();
    },
    pick: d.pick ? picker(ctx, objects.meshes, gpuPick) : undefined,
  };
}
