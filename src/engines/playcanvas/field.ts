import * as pc from 'playcanvas';
import { fieldWorldMatrices } from '../../harness/scenes';
import type { FieldScene, Geometry, PbrSpec, PointLightsSpec, PostSpec, SpotSpec, Variant, Vec3 } from '../../harness/types';
import { buildHud } from './hud';
import { color, downTo, lightColor, LIGHT_SCALE, PUNCTUAL_SCALE, SHADOW_BIAS, type Built, type PcCtx } from './index';

// PlayCanvas bloom adds an unthresholded sum of blur levels, so the spec's thresholded strength is scaled down.
const BLOOM_SCALE = 0.02;
/** K5 optimized: edge of the square cells that instances are grouped (and culled) by, metres. */
const CELL = 30;

export function toMesh(device: pc.GraphicsDevice, g: Geometry) {
  const m = new pc.Mesh(device);
  m.setPositions(g.positions);
  m.setNormals(g.normals);
  m.setUvs(0, g.uvs);
  m.setIndices(g.indices);
  m.update(pc.PRIMITIVE_TRIANGLES);
  return m;
}

export function toMaterial(m: PbrSpec, map?: pc.Texture) {
  const mat = new pc.StandardMaterial();
  mat.diffuse = color(m.color);
  if (map) mat.diffuseMap = map;
  mat.useMetalness = true;
  mat.metalness = m.metalness;
  mat.gloss = 1 - m.roughness;
  if (m.opacity !== undefined && m.opacity < 1) {
    mat.opacity = m.opacity;
    mat.blendType = pc.BLEND_NORMAL; // the world layer sorts blended draws back to front
    mat.depthWrite = false;
  }
  mat.update();
  return mat;
}

interface Objects {
  path: string;
  notes?: string[];
  update(): void;
  pick?(x: number, y: number): Promise<number>;
}
type ObjectPath = (ctx: PcCtx, d: FieldScene, meshes: pc.Mesh[], mats: pc.Material[]) => Objects;

const entities: ObjectPath = ({ app, device, camera }, d, meshes, mats) => {
  const g = d.groups;
  const groups: pc.Entity[] = [];
  if (g) {
    for (let k = 0; k < g.count; k++) {
      const e = new pc.Entity();
      e.setLocalPosition(g.position[k * 3], g.position[k * 3 + 1], g.position[k * 3 + 2]);
      e.setLocalRotation(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
      app.root.addChild(e);
      groups.push(e);
    }
  }
  const spawn = (i: number, material: pc.Material) => {
    const e = new pc.Entity();
    e.addComponent('render', {
      meshInstances: [new pc.MeshInstance(meshes[d.geom[i]], material)],
      castShadows: d.shadows,
      receiveShadows: d.shadows,
    });
    e.setLocalPosition(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
    e.setLocalScale(d.scale[i], d.scale[i], d.scale[i]);
    e.setLocalRotation(d.quat[i * 4], d.quat[i * 4 + 1], d.quat[i * 4 + 2], d.quat[i * 4 + 3]);
    (g ? groups[g.parent[i]] : app.root).addChild(e);
    return e;
  };
  const list: pc.Entity[] = new Array(d.count);
  for (let i = 0; i < d.count; i++) list[i] = spawn(i, mats[d.material[i]]);

  const notes: string[] = [];
  let path = g ? 'Entity + render component per object, parented to one Entity per group' : 'Entity + render component per object';
  let churn: (() => void) | undefined;
  const c = d.churn;
  if (c) {
    for (const m of meshes) m.incRefCount(); // destroying a geometry's last MeshInstance would free the shared mesh
    const owned: (pc.Material | undefined)[] = new Array(d.count);
    const textures: (pc.Texture | undefined)[] = [];
    path += '; Entity.destroy + Material.destroy + Texture.destroy, then new Texture/StandardMaterial/Entity';
    notes.push('churn textures: sRGB, mipmaps generated, trilinear (the Texture defaults)');
    churn = () => {
      if (!c.n) return;
      const old = textures[c.batch];
      const { size, pixels } = c.texture;
      // uploaded by this frame's render, before update(t) rewrites the pixels
      const tex = (textures[c.batch] = new pc.Texture(device, { width: size, height: size, format: pc.PIXELFORMAT_SRGBA8, levels: [pixels] }));
      for (let k = 0; k < c.n; k++) {
        const slot = c.slots[k];
        list[slot].destroy();
        owned[slot]?.destroy();
        list[slot] = spawn(slot, (owned[slot] = toMaterial(d.materials[d.material[slot]], tex)));
      }
      old?.destroy();
    };
  }

  let pick: Objects['pick'];
  if (d.pick) {
    const slots = new Map<pc.MeshInstance, number>();
    list.forEach((e, i) => slots.set(e.render!.meshInstances[0], i));
    const picker = new pc.Picker(app, device.width, device.height);
    path += '; Picker (GPU id buffer at canvas resolution, prepare + getSelectionAsync per pick)';
    pick = async (x, y) => {
      picker.prepare(camera.camera!, app.scene);
      const hit = await picker.getSelectionAsync(x, y);
      return hit.length ? slots.get(hit[0] as pc.MeshInstance) ?? -1 : -1;
    };
  }

  const q = d.quat;
  return {
    path,
    notes,
    pick,
    update() {
      churn?.();
      if (!d.animated) return;
      for (let i = 0; i < list.length; i++) list[i].setLocalRotation(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]);
      if (g) for (let k = 0; k < groups.length; k++) groups[k].setLocalRotation(g.quat[k * 4], g.quat[k * 4 + 1], g.quat[k * 4 + 2], g.quat[k * 4 + 3]);
    },
  };
};

/** One instanced MeshInstance per key; `world` holds every object's matrix, `write` regathers them. */
function instanceBuckets({ app, device }: PcCtx, d: FieldScene, meshes: pc.Mesh[], mats: pc.Material[], world: Float32Array, usage: number, cell?: (i: number) => number) {
  const nm = mats.length, ng = meshes.length;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < d.count; i++) {
    const k = ((cell ? cell(i) : 0) * ng + d.geom[i]) * nm + d.material[i];
    let ids = buckets.get(k);
    if (!ids) buckets.set(k, (ids = []));
    ids.push(i);
  }
  const format = pc.VertexFormat.getDefaultInstancingFormat(device);
  const groups = [...buckets].map(([k, ids]) => {
    const data = new Float32Array(ids.length * 16);
    const vb = new pc.VertexBuffer(device, format, ids.length, { usage, data });
    const mi = new pc.MeshInstance(meshes[Math.floor(k / nm) % ng], mats[k % nm]);
    mi.setInstancing(vb, !!cell);
    const e = new pc.Entity();
    e.addComponent('render', { meshInstances: [mi], castShadows: d.shadows, receiveShadows: d.shadows });
    app.root.addChild(e);
    return { ids, data, vb, e };
  });
  const write = () => {
    for (const { ids, data, vb } of groups) {
      for (let j = 0; j < ids.length; j++) {
        const s = ids[j] * 16, o = j * 16;
        for (let m = 0; m < 16; m++) data[o + m] = world[s + m];
      }
      vb.setData(data);
    }
  };
  write();
  return { groups, write };
}

const instanced: ObjectPath = (ctx, d, meshes, mats) => {
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const { write } = instanceBuckets(ctx, d, meshes, mats, world, pc.BUFFER_DYNAMIC);
  return {
    path: `hardware instancing per geometry × material${d.groups ? ', hierarchy flattened on the CPU' : ''} (matrices uploaded per frame)`,
    update() {
      if (!d.animated) return;
      fieldWorldMatrices(d, world);
      write();
    },
  };
};

/** Static world: instancing has no per-instance culling, so instances are split into cells that are culled whole. */
const cells: ObjectPath = (ctx, d, meshes, mats) => {
  const world = new Float32Array(d.count * 16);
  fieldWorldMatrices(d, world);
  const p = d.position;
  const cell = (i: number) => (Math.floor(p[i * 3] / CELL) + 512) * 1024 + Math.floor(p[i * 3 + 2] / CELL) + 512;
  const { groups } = instanceBuckets(ctx, d, meshes, mats, world, pc.BUFFER_STATIC, cell);
  const radius = d.geometries.map((g) => {
    let r = 0;
    for (let v = 0; v < g.positions.length; v += 3) r = Math.max(r, Math.hypot(g.positions[v], g.positions[v + 1], g.positions[v + 2]));
    return r;
  });
  for (const { ids, e } of groups) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const i of ids) {
      const r = radius[d.geom[i]] * d.scale[i];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[i * 3 + a] - r);
        max[a] = Math.max(max[a], p[i * 3 + a] + r);
      }
    }
    const box = new pc.BoundingBox();
    box.setMinMax(new pc.Vec3(min), new pc.Vec3(max));
    e.render!.customAabb = box; // what the culled instancing draw is tested against
  }
  return {
    path: `hardware instancing per ${CELL} m cell × geometry × material, static buffers, frustum-culled per cell (setInstancing cull + customAabb)`,
    notes: [`${groups.length} instanced draws for ${d.count} objects`],
    update() {},
  };
};

export function addPointLights(app: pc.AppBase, l: PointLightsSpec, clustered: boolean, notes: string[]) {
  app.scene.clusteredLightingEnabled = clustered;
  if (clustered) {
    app.scene.lighting.maxLights = Math.max(app.scene.lighting.maxLights, l.count); // default 255 drops the rest
    notes.push(`clustered lighting (engine default), lighting.maxLights = ${app.scene.lighting.maxLights}`);
  } else {
    notes.push('clustered lighting disabled (PlayCanvas default is clustered) to get a forward path comparable to the other engines');
  }
  const k = l.intensity * LIGHT_SCALE * PUNCTUAL_SCALE;
  const lights: pc.Entity[] = [];
  for (let i = 0; i < l.count; i++) {
    const e = new pc.Entity();
    e.addComponent('light', {
      type: 'omni',
      ...lightColor([l.color[i * 3], l.color[i * 3 + 1], l.color[i * 3 + 2]], k),
      range: l.range,
      falloffMode: pc.LIGHTFALLOFF_INVERSESQUARED,
      castShadows: false,
    });
    app.root.addChild(e);
    lights.push(e);
  }
  const p = l.position;
  return () => {
    for (let i = 0; i < lights.length; i++) lights[i].setPosition(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  };
}

function addSpots(app: pc.AppBase, spots: SpotSpec[]) {
  // Clustered spot shadows share one atlas: size it so each spot gets its shadowMapSize.
  app.scene.lighting.shadowAtlasResolution = Math.ceil(Math.sqrt(spots.length)) * Math.max(...spots.map((s) => s.shadowMapSize));
  for (const s of spots) {
    const dx = s.target[0] - s.position[0], dy = s.target[1] - s.position[1], dz = s.target[2] - s.position[2];
    const len = Math.hypot(dx, dy, dz);
    const e = new pc.Entity();
    e.addComponent('light', {
      type: 'spot',
      ...lightColor(s.color, s.intensity * LIGHT_SCALE * PUNCTUAL_SCALE),
      range: s.range,
      falloffMode: pc.LIGHTFALLOFF_INVERSESQUARED,
      outerConeAngle: s.angle,
      innerConeAngle: s.angle * (1 - s.penumbra),
      castShadows: true,
      shadowResolution: s.shadowMapSize,
      ...SHADOW_BIAS,
    });
    e.setPosition(...s.position);
    e.setRotation(downTo([dx / len, dy / len, dz / len]));
    app.root.addChild(e);
  }
}

export function addPost({ app, camera }: PcCtx, p: PostSpec, clear: Vec3, notes: string[]) {
  const cam = camera.camera!;
  cam.clearColor = new pc.Color(clear[0], clear[1], clear[2]); // the clear value lands raw in the linear HDR target
  const frame = new pc.CameraFrame(app, cam);
  frame.rendering.samples = 4;
  frame.rendering.toneMapping = pc.TONEMAP_ACES2;
  frame.bloom.intensity = p.bloom.strength * BLOOM_SCALE;
  frame.bloom.blurLevel = Math.max(1, Math.round(p.bloom.radius * 10));
  frame.update();
  notes.push(`CameraFrame: 4× MSAA HDR target, bloom intensity ${frame.bloom.intensity} (no threshold in PlayCanvas), blurLevel ${frame.bloom.blurLevel}, ACES2; no FXAA`);
}

export async function buildField(ctx: PcCtx, d: FieldScene, variant: Variant, opt?: string): Promise<Built> {
  const { app, device } = ctx;
  const notes: string[] = [];
  let make = entities;
  if (variant === 'optimized') {
    if (d.pick) throw new Error('N/A: the GPU Picker is the only first-party picker in PlayCanvas (measured as naive); there is no CPU ray-mesh pick without a physics add-on');
    make = d.animated ? instanced : cells;
  }
  const meshes = d.geometries.map((g) => toMesh(device, g));
  const mats = d.materials.map((m) => toMaterial(m));
  const objects = make(ctx, d, meshes, mats);
  let path = objects.path;
  notes.push(...(objects.notes ?? []));

  if (d.ground) {
    const g = new pc.Entity('ground');
    g.addComponent('render', { type: 'plane', material: toMaterial(d.ground.material), castShadows: false, receiveShadows: d.shadows });
    g.setLocalScale(d.ground.size, 1, d.ground.size);
    app.root.addChild(g);
  }
  let updateLights: (() => void) | undefined;
  if (d.pointLights) {
    updateLights = addPointLights(app, d.pointLights, true, notes);
    path += ', clustered lighting';
  }
  if (d.spots) addSpots(app, d.spots);
  if (d.post) addPost(ctx, d.post, d.clearColor, notes);
  let updateHud: (() => void) | undefined;
  if (d.hud) {
    const hud = await buildHud(ctx, d.hud);
    updateHud = hud.update;
    path += `; ${hud.path}`;
  }
  const c = d.camera; // rewritten by scene.update(t) when live

  return {
    path,
    notes,
    pick: objects.pick,
    update() {
      if (d.cameraLive) {
        ctx.camera.setPosition(...c.position);
        ctx.camera.lookAt(...c.target);
      }
      objects.update();
      updateLights?.();
      updateHud?.();
    },
  };
}
