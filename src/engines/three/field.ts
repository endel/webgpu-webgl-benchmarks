import * as THREE from 'three';
import { fieldWorldMatrices, HEIGHT, WIDTH } from '../../harness/scenes';
import type { FieldScene, Variant } from '../../harness/types';
import { deg } from '../common';
import { LIGHT_SCALE, linear, pointLights, toGeometry, toMaterial, type Built, type Ctx, type Features } from './common';
import { buildHud } from './hud';

interface Objects {
  path: string;
  update?(): void;
  /** One mesh per slot, where the path keeps them (picking). */
  meshes?: THREE.Mesh[];
}

export async function buildField(ctx: Ctx, sun: THREE.DirectionalLight | null, d: FieldScene, variant: Variant, opt: string | undefined, f: Features): Promise<Built> {
  const { scene, camera } = ctx;
  if (d.pick && variant === 'optimized') {
    throw new Error('N/A: three ships no accelerated picker (Raycaster tests every triangle of every candidate mesh; three-mesh-bvh is third-party)');
  }
  if (d.hud && d.post) throw new Error('three field: hud + post is not implemented');
  ctx.renderer.shadowMap.enabled = d.shadows;
  const geos = d.geometries.map(toGeometry);
  const mats = d.materials.map((m) => toMaterial(m));
  const objects = variant === 'naive' ? naive(scene, d, geos, mats) : d.animated ? dynamicFast(scene, d, geos, mats, opt ?? 'instanced') : staticFast(scene, d, geos, mats, opt ?? 'batched');
  const updates: (() => void)[] = objects.update ? [objects.update] : [];
  let path = objects.path;
  let render: (() => void) | undefined;

  if (d.ground) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(d.ground.size, d.ground.size), toMaterial(d.ground.material));
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = d.shadows;
    scene.add(g);
  }
  if (d.pointLights) updates.push(pointLights(scene, d.pointLights));
  for (const s of d.spots ?? []) {
    const l = new THREE.SpotLight(linear(s.color), s.intensity * LIGHT_SCALE, s.range, deg(s.angle), s.penumbra);
    l.position.fromArray(s.position);
    l.target.position.fromArray(s.target);
    l.castShadow = d.shadows;
    l.shadow.mapSize.setScalar(s.shadowMapSize);
    scene.add(l, l.target);
  }
  // last, so every material already exists (the classic CSM patches materials)
  if (sun && d.sun?.shadow) {
    const u = f.cascades(sun, d.sun.shadow);
    if (u) updates.push(u);
    path += ` + ${f.label.cascades}`;
  }
  if (d.post) {
    render = f.post(d.post);
    path += ` + ${f.label.post}`;
  }
  if (d.hud) {
    const hud = await buildHud(d.hud, f.rawOverlay);
    updates.push(hud.update);
    render = f.overlay(hud.scene, hud.camera);
    path += ` + HUD: ${hud.path}, ${f.label.overlay}`;
  }

  const meshes = objects.meshes;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  return {
    path,
    update: () => updates.forEach((u) => u()),
    render,
    pick: meshes && ((x, y) => {
      ray.setFromCamera(ndc.set((x / WIDTH) * 2 - 1, 1 - (y / HEIGHT) * 2), camera);
      const hit = ray.intersectObjects(meshes, false)[0];
      return hit ? meshes.indexOf(hit.object as THREE.Mesh) : -1;
    }),
  };
}

function naive(scene: THREE.Scene, d: FieldScene, geos: THREE.BufferGeometry[], mats: THREE.Material[]): Objects {
  const g = d.groups;
  const nodes = Array.from({ length: g?.count ?? 0 }, (_, i) => {
    const n = new THREE.Group();
    n.position.fromArray(g!.position, i * 3);
    n.quaternion.fromArray(g!.quat, i * 4);
    scene.add(n);
    return n;
  });
  const meshes: THREE.Mesh[] = new Array(d.count);
  const spawn = (i: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(geos[d.geom[i]], mat);
    m.position.fromArray(d.position, i * 3);
    m.scale.setScalar(d.scale[i]);
    m.quaternion.fromArray(d.quat, i * 4);
    m.castShadow = m.receiveShadow = d.shadows;
    (g ? nodes[g.parent[i]] : scene).add(m);
    meshes[i] = m;
  };
  for (let i = 0; i < d.count; i++) spawn(i, mats[d.material[i]]);

  const c = d.churn;
  const owned: THREE.Material[] = [], textures: THREE.Texture[] = [];
  const respawn = () => {
    if (!c!.n) return;
    textures[c!.batch]?.dispose();
    // no copy: the upload happens in this frame's render, before update() rewrites the pixels
    const tex = new THREE.DataTexture(c!.texture.pixels, c!.texture.size, c!.texture.size);
    tex.colorSpace = THREE.SRGBColorSpace;
    // DataTexture defaults to nearest/no mips; filter it like a loaded image texture
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    textures[c!.batch] = tex;
    for (let k = 0; k < c!.n; k++) {
      const i = c!.slots[k];
      meshes[i].removeFromParent();
      owned[i]?.dispose();
      spawn(i, (owned[i] = toMaterial(d.materials[d.material[i]], tex)));
    }
  };
  const spin = () => {
    for (let i = 0; i < nodes.length; i++) nodes[i].quaternion.fromArray(g!.quat, i * 4);
    for (let i = 0; i < d.count; i++) meshes[i].quaternion.fromArray(d.quat, i * 4);
  };
  return {
    path: `${g ? 'Group per group > ' : ''}Mesh per object (Object3D defaults)${c ? ', respawned with a new MeshStandardMaterial + mipmapped DataTexture' : ''}`,
    meshes,
    update: c || d.animated ? () => {
      if (c) respawn();
      if (d.animated) spin();
    } : undefined,
  };
}

const _m = new THREE.Matrix4();

/** One BatchedMesh per material (roughness/metalness differ, so per-instance colour would change the image). */
function batched(scene: THREE.Scene, d: FieldScene, geos: THREE.BufferGeometry[], mats: THREE.Material[], world: Float32Array, culled: boolean) {
  const verts = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const indices = geos.reduce((n, g) => n + g.index!.count, 0);
  return buckets(d, () => 0).map(({ ids, material }) => {
    const bm = new THREE.BatchedMesh(ids.length, verts, indices, mats[material]);
    bm.sortObjects = false;
    bm.frustumCulled = bm.perObjectFrustumCulled = culled;
    bm.castShadow = bm.receiveShadow = d.shadows;
    const geoIds = geos.map((g) => bm.addGeometry(g));
    for (const i of ids) bm.setMatrixAt(bm.addInstance(geoIds[d.geom[i]]), _m.fromArray(world, i * 16));
    scene.add(bm);
    return { bm, ids };
  });
}

/** Slots grouped by material and by `key(slot)`. */
function buckets(d: FieldScene, key: (i: number) => number) {
  const map = new Map<number, { ids: number[]; material: number; geom: number }>();
  for (let i = 0; i < d.count; i++) {
    const k = d.material[i] * 256 + key(i);
    let b = map.get(k);
    if (!b) map.set(k, (b = { ids: [], material: d.material[i], geom: d.geom[i] }));
    b.ids.push(i);
  }
  return [...map.values()];
}

/** K2: the hierarchy is flattened on the CPU, then drawn instanced. `opt`: instanced | batched. */
function dynamicFast(scene: THREE.Scene, d: FieldScene, geos: THREE.BufferGeometry[], mats: THREE.Material[], opt: string): Objects {
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const flat = d.groups ? 'hierarchy flattened on the CPU, ' : '';
  if (opt === 'batched') {
    const batches = batched(scene, d, geos, mats, world, false);
    return {
      path: `${flat}BatchedMesh per material`,
      update() {
        fieldWorldMatrices(d, world);
        for (const { bm, ids } of batches) for (let k = 0; k < ids.length; k++) bm.setMatrixAt(k, _m.fromArray(world, ids[k] * 16));
      },
    };
  }
  if (opt !== 'instanced') throw new Error(`three field: unknown optimized path "${opt}" (instanced, batched)`);
  const groups = buckets(d, (i) => d.geom[i]).map(({ ids, material, geom }) => {
    const im = new THREE.InstancedMesh(geos[geom], mats[material], ids.length);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = im.receiveShadow = d.shadows;
    scene.add(im);
    return { a: im.instanceMatrix.array, attr: im.instanceMatrix, ids };
  });
  const update = () => {
    fieldWorldMatrices(d, world);
    for (const { a, attr, ids } of groups) {
      for (let k = 0; k < ids.length; k++) {
        const o = ids[k] * 16, t = k * 16;
        for (let j = 0; j < 16; j++) a[t + j] = world[o + j];
      }
      attr.needsUpdate = true;
    }
  };
  update();
  return { path: `${flat}InstancedMesh per geometry and material`, update };
}

/** K5: nothing moves but the camera. `opt`: batched | static. */
function staticFast(scene: THREE.Scene, d: FieldScene, geos: THREE.BufferGeometry[], mats: THREE.Material[], opt: string): Objects {
  if (opt === 'batched') {
    const world = new Float32Array(d.count * 16);
    fieldWorldMatrices(d, world);
    batched(scene, d, geos, mats, world, true);
    return { path: 'BatchedMesh per material (perObjectFrustumCulled, sortObjects=false)' };
  }
  if (opt !== 'static') throw new Error(`three field: unknown optimized path "${opt}" (batched, static)`);
  const { meshes } = naive(scene, d, geos, mats);
  for (const m of meshes!) {
    m.updateMatrix();
    m.matrixAutoUpdate = false;
  }
  return { path: 'Mesh per object, matrixAutoUpdate=false', meshes };
}
