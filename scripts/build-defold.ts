// Builds the Defold HTML5 bundle the `defold` adapter loads: exports the shared geometry into the
// Defold project, bundles it with bob (pinned version) and copies the result to public/defold.
//
//   npm run build-defold
//
// Needs Java 21+: JAVA_HOME, `java` on PATH or the JDK inside Defold.app. The bench bridge is a
// native extension, so bob compiles the engine on Defold's build server (DEFOLD_BUILD_SERVER).
import { execFileSync, spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fieldGeometries } from '../src/harness/geometry';
import type { Geometry } from '../src/harness/types';

export const DEFOLD_VERSION = '1.13.1';
const DEFOLD_SHA1 = '574678c7d44be490d874fbed2d0ae6211feec4d9';

const ROOT = join(import.meta.dirname, '..');
const PROJECT = join(ROOT, 'defold');
const GENERATED = join(PROJECT, 'generated');
const CACHE = join(ROOT, 'node_modules', '.cache', 'defold');
// bob refuses to bundle inside the project's build folder
const BUNDLE = join(CACHE, 'bundle');

/** Minimal glTF 2.0 binary with one mesh and one material named "default". */
function glb(g: Geometry) {
  const indices32 = g.indices instanceof Uint32Array;
  const parts = [g.positions, g.normals, g.uvs, g.indices];
  const views: { byteOffset: number; byteLength: number; target: number }[] = [];
  let length = 0;
  for (const [k, p] of parts.entries()) {
    views.push({ byteOffset: length, byteLength: p.byteLength, target: k === 3 ? 34963 : 34962 });
    length += Math.ceil(p.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(length);
  parts.forEach((p, k) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), views[k].byteOffset));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], g.positions[i + k]);
      max[k] = Math.max(max[k], g.positions[i + k]);
    }
  }
  const vertices = g.positions.length / 3;
  const json = {
    asset: { version: '2.0', generator: 'webgpu-webgl-benchmarks' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: g.name }],
    meshes: [{ name: g.name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'default', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: vertices, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: vertices, type: 'VEC2' },
      { bufferView: 3, componentType: indices32 ? 5125 : 5123, count: g.indices.length, type: 'SCALAR' },
    ],
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    buffers: [{ byteLength: length }],
  };
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonBytes = new TextEncoder().encode(text);
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const b = 20 + jsonBytes.length;
  dv.setUint32(b, bin.length, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out;
}

/** Solid RGBA PNG, for placeholders whose pixels are replaced at runtime. */
function png(width: number, height: number, rgba = [128, 128, 128, 255]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgba, y * (1 + width * 4) + 1 + x * 4);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  return Buffer.concat(parts);
}

/** The K9 icon atlas grid (src/harness/scenes.ts hudAtlas): 8×8 cells of 32 px. */
const HUD_ATLAS = { cols: 8, rows: 8, cell: 32 };

/** Text-format protobuf string literal. */
const q = (s: string) => JSON.stringify(s);

const vec4 = (v: number[]) => `{ x: ${v[0]} y: ${v[1]} z: ${v[2]} w: ${v[3]} }`;
const LIGHTS = ['sun_dir', 'sun_color', 'ambient', 'cam_pos'];

interface MaterialSpec {
  tag: string;
  program: string;
  /** Fragment program, when it differs from the vertex one. */
  fp?: string;
  /** Default constant values (default: white base colour, roughness 0.5). */
  defaults?: Record<string, number[]>;
  vertex: Record<string, string>;
  fragment: string[];
  /** Trilinear and repeating, unless `clamp` (linear, clamped) or `nearest` (clamped, for depth). */
  samplers?: (string | { name: string; nearest?: boolean; clamp?: boolean })[];
  /** CONSTANT_TYPE_USER_MATRIX4 fragment constants. */
  matrices?: string[];
  /** World vertex space: Defold transforms (and skins) the vertices on the CPU. */
  world?: boolean;
  /** Vector-array fragment constants, by length. */
  arrays?: Record<string, number>;
  /** Per-instance vec4 attributes. */
  instance?: string[];
}

/** Field materials; all share the PBR include and the render script's light constants. */
const SPONZA: MaterialSpec = {
  tag: 'model',
  program: 'sponza',
  vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' },
  fragment: ['base_color', 'pbr', ...LIGHTS, 'shadow_splits', 'shadow_info', 'cam_fwd', 'point_info'],
  matrices: ['shadow_mtx0', 'shadow_mtx1', 'shadow_mtx2', 'shadow_mtx3'],
  arrays: { point_pos: 32, point_color: 32 },
  samplers: ['tex0', 'tex1', 'tex2', { name: 'shadow_map', nearest: true }],
};

const post = (fp: string): MaterialSpec => ({ tag: 'post', program: 'post', fp, vertex: {}, fragment: ['bloom_texel', 'bloom'], samplers: [{ name: 'tex0', clamp: true }] });

const MATERIALS: Record<string, MaterialSpec> = {
  pbr: { tag: 'model', program: 'pbr', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS] },
  pbr_blend: { tag: 'model_blend', program: 'pbr', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS] },
  pbr_tex: { tag: 'model', program: 'pbr_tex', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS], samplers: ['tex0'] },
  pbr_inst: { tag: 'model', program: 'pbr_inst', vertex: { mtx_viewproj: 'VIEWPROJ' }, fragment: LIGHTS, instance: ['instance_color', 'instance_pbr'] },
  // instanced, colour and PBR as constants: instances batch where their constants are equal
  pbr_instc: { tag: 'model', program: 'pbr_instc', vertex: { mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS] },
  // K6: GPU skinning (the engine binds the bone texture and animation_data), with the Fox's texture
  pbr_skinned: { tag: 'model', program: 'pbr_skinned', fp: 'pbr_tex_flat', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS], samplers: ['tex0'] },
  pbr_skinned_inst: { tag: 'model', program: 'pbr_skinned_inst', fp: 'pbr_tex_flat', vertex: { mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS], samplers: ['tex0'] },
  pbr_skinned_world: { tag: 'model', program: 'pbr_skinned_world', fp: 'pbr_tex_flat', vertex: { mtx_viewproj: 'VIEWPROJ' }, fragment: ['base_color', 'pbr', ...LIGHTS], samplers: ['tex0'], world: true },
  // K4: Sponza's glTF materials (double-sided ones are drawn without culling), and the passes the
  // render script hand-writes: shadow depth (override material) and bloom (full-screen quad)
  sponza: { ...SPONZA, tag: 'model' },
  sponza_double: { ...SPONZA, tag: 'model_double' },
  shadow: { tag: 'shadow', program: 'shadow', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: [] },
  shadow_tiled: { tag: 'shadow', program: 'shadow_tiled', vertex: { mtx_world: 'WORLD', mtx_viewproj: 'VIEWPROJ' }, fragment: [] },
  post: { ...post('bloom_down'), tag: 'postfx' },
  bloom_bright: post('bloom_bright'),
  bloom_down: post('bloom_down'),
  bloom_up: post('bloom_up'),
  composite: { ...post('composite'), samplers: [{ name: 'tex0', clamp: true }, { name: 'tex1', clamp: true }] },
};

/** Override materials the render script enables by name (render.enable_material). */
const RENDER_MATERIALS = ['shadow', 'shadow_tiled', 'bloom_bright', 'bloom_down', 'bloom_up', 'composite'];

/**
 * K4: Sponza split into one glTF per material, so each Defold model component has one material
 * whose constants and textures the scene sets. Textures are placeholders: the page uploads the real
 * images at load (an archive would hold them as uncompressed RGBA, ~385 MB with mips).
 */
function sponza(webgpu: boolean) {
  const src = join(ROOT, 'public', 'assets', 'Sponza');
  if (!existsSync(join(src, 'Sponza.gltf'))) throw new Error(`${src}/Sponza.gltf missing: run npm run fetch-assets first`);
  const gltf = JSON.parse(readFileSync(join(src, 'Sponza.gltf'), 'utf8'));
  const dir = join(GENERATED, 'sponza');
  mkdirSync(dir, { recursive: true });
  const bin = readFileSync(join(src, gltf.buffers[0].uri));
  cpSync(join(src, gltf.buffers[0].uri), join(dir, 'Sponza.bin'));
  // Defold 1.13.1's WebGPU backend uploads index buffers as they are, and WebGPU rejects writes that
  // are not a multiple of 4 bytes: give each odd-length 16-bit index list one degenerate triangle.
  const padded: Uint16Array[] = [];
  if (webgpu) {
    for (const p of gltf.meshes[0].primitives) {
      const a = gltf.accessors[p.indices];
      if (a.componentType !== 5123 || a.count % 2 === 0) continue;
      const v = gltf.bufferViews[a.bufferView];
      const src16 = new Uint16Array(bin.buffer.slice(bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0) + a.count * 2));
      const out = new Uint16Array(a.count + 3);
      out.set(src16);
      out.fill(src16[a.count - 1], a.count);
      const offset = padded.reduce((n, x) => n + x.byteLength, 0);
      padded.push(out);
      gltf.bufferViews.push({ buffer: 1, byteOffset: offset, byteLength: out.byteLength, target: 34963 });
      gltf.accessors.push({ ...a, bufferView: gltf.bufferViews.length - 1, byteOffset: 0, count: out.length });
      p.indices = gltf.accessors.length - 1;
    }
    writeFileSync(join(dir, 'pad.bin'), Buffer.concat(padded.map((x) => Buffer.from(x.buffer))));
  }
  let go = '';
  gltf.materials.forEach((m: any, k: number) => {
    const part = {
      ...gltf,
      buffers: [{ ...gltf.buffers[0], uri: 'Sponza.bin' }, ...(padded.length ? [{ uri: 'pad.bin', byteLength: padded.reduce((n, x) => n + x.byteLength, 0) }] : [])],
      meshes: [{ ...gltf.meshes[0], primitives: gltf.meshes[0].primitives.filter((p: any) => p.material === k).map((p: any) => ({ ...p, material: 0 })) }],
      materials: [{ name: 'default' }],
      images: undefined,
      textures: undefined,
      samplers: undefined,
    };
    writeFileSync(join(dir, `part${k}.gltf`), JSON.stringify(part));
    const textures = [['tex0', 'white'], ['tex1', 'normal'], ['tex2', 'white']].map(([s, t]) => `  textures {\n    sampler: "${s}"\n    texture: "/generated/textures/${t}.png"\n  }\n`).join('');
    const model = `mesh: "/generated/sponza/part${k}.gltf"\nname: "{{NAME}}"\nmaterials {\n  name: "default"\n  material: "/generated/materials/${m.doubleSided ? 'sponza_double' : 'sponza'}.material"\n${textures}}\n`;
    go += embedded(`m${k}`, 'model', model);
  });
  writeFileSync(join(GENERATED, 'objects', 'sponza.go'), go);
}

/** K6: Fox.glb's texture as a file (Defold binds model textures from files) and its clip durations. */
function fox() {
  const src = join(ROOT, 'public', 'assets', 'Fox', 'Fox.glb');
  if (!existsSync(src)) throw new Error(`${src} missing: run npm run fetch-assets first`);
  const b = readFileSync(src);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const bin = b.subarray(20 + b.readUInt32LE(12) + 8);
  const view = (i: number) => json.bufferViews[i];
  const dir = join(GENERATED, 'fox');
  mkdirSync(dir, { recursive: true });
  cpSync(src, join(dir, 'Fox.glb'));
  const image = view(json.images[0].bufferView);
  writeFileSync(join(dir, 'fox.png'), bin.subarray(image.byteOffset ?? 0, (image.byteOffset ?? 0) + image.byteLength));
  const clips = json.animations.map((a: any) => `    { name = "${a.name}", duration = ${Math.max(...a.samplers.map((s: any) => json.accessors[s.input].max[0]))} },`);
  writeFileSync(join(GENERATED, 'fox_clips.lua'), `-- Fox.glb clip durations in seconds (scripts/build-defold.ts)\nreturn {\n${clips.join('\n')}\n}\n`);
  const m = json.materials[0];
  return { material: m.name as string, pbr: [m.pbrMetallicRoughness.roughnessFactor ?? 1, m.pbrMetallicRoughness.metallicFactor ?? 1, 0, 0] };
}

function material(name: string, m: MaterialSpec) {
  const out = [
    `name: ${q(name)}`,
    `tags: ${q(m.tag)}`,
    `vertex_program: "/materials/${m.program}.vp"`,
    `fragment_program: "/materials/${m.fp ?? m.program}.fp"`,
    m.world ? 'vertex_space: VERTEX_SPACE_WORLD' : 'vertex_space: VERTEX_SPACE_LOCAL',
    ...Object.entries(m.vertex).map(([n, t]) => `vertex_constants {\n  name: ${q(n)}\n  type: CONSTANT_TYPE_${t}\n}`),
    ...m.fragment.map((n) => `fragment_constants {\n  name: ${q(n)}\n  type: CONSTANT_TYPE_USER\n  value ${vec4(m.defaults?.[n] ?? (n === 'base_color' ? [1, 1, 1, 1] : n === 'pbr' ? [0.5, 0, 0, 0] : [0, 0, 0, 0]))}\n}`),
    ...(m.instance ?? []).map((n) => `attributes {\n  name: ${q(n)}\n  semantic_type: SEMANTIC_TYPE_NONE\n  data_type: TYPE_FLOAT\n  vector_type: VECTOR_TYPE_VEC4\n  step_function: VERTEX_STEP_FUNCTION_INSTANCE\n  double_values {\n    v: 1.0\n    v: 1.0\n    v: 1.0\n    v: 1.0\n  }\n}`),
  ];
  out.push(...(m.matrices ?? []).map((n) => `fragment_constants {\n  name: ${q(n)}\n  type: CONSTANT_TYPE_USER_MATRIX4\n}`));
  out.push(...Object.entries(m.arrays ?? {}).map(([n, len]) => `fragment_constants {\n  name: ${q(n)}\n  type: CONSTANT_TYPE_USER\n${`  value ${vec4([0, 0, 0, 0])}\n`.repeat(len)}}`));
  for (const sm of m.samplers ?? []) {
    const { name, nearest, clamp } = typeof sm === 'string' ? { name: sm, nearest: false, clamp: false } : sm;
    const wrap = nearest || clamp ? 'WRAP_MODE_CLAMP_TO_EDGE' : 'WRAP_MODE_REPEAT';
    const [min, mag] = nearest ? ['FILTER_MODE_MIN_NEAREST', 'FILTER_MODE_MAG_NEAREST'] : clamp ? ['FILTER_MODE_MIN_LINEAR', 'FILTER_MODE_MAG_LINEAR'] : ['FILTER_MODE_MIN_LINEAR_MIPMAP_LINEAR', 'FILTER_MODE_MAG_LINEAR'];
    out.push(`samplers {\n  name: ${q(name)}\n  wrap_u: ${wrap}\n  wrap_v: ${wrap}\n  filter_min: ${min}\n  filter_mag: ${mag}\n  max_anisotropy: 1.0\n}`);
  }
  out.push('max_page_count: 0', '');
  return out.join('\n');
}

/** Field prototypes per geometry, by factory suffix: the material, and a collider for picking. */
const PROTOTYPES: Record<string, { material: string; collider?: boolean }> = {
  '': { material: 'pbr' },
  _blend: { material: 'pbr_blend' },
  _inst: { material: 'pbr_inst' },
  _instc: { material: 'pbr_instc' },
  _tex: { material: 'pbr_tex' },
  _pick: { material: 'pbr', collider: true },
};

/**
 * Collision shape per geometry: the exact primitive where Defold has one (Bullet keeps a box's margin
 * inside it, and a sphere's margin is its radius), otherwise the convex hull of the vertices, which
 * Bullet grows by its 0.04-unit collision margin.
 */
function shape(g: Geometry) {
  if (g.name === 'box') return 'shape_type: TYPE_BOX\ndata: 0.5\ndata: 0.5\ndata: 0.5\n';
  if (g.name === 'sphere24x16') return 'shape_type: TYPE_SPHERE\ndata: 0.5\n';
  return hull(g);
}

function hull(g: Geometry) {
  const seen = new Set<string>();
  const data: string[] = [];
  for (let i = 0; i < g.positions.length; i += 3) {
    const p = [g.positions[i], g.positions[i + 1], g.positions[i + 2]].map((v) => +v.toFixed(5));
    const k = p.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    data.push(...p.map((v) => `data: ${v}`));
  }
  return `shape_type: TYPE_HULL\n${data.join('\n')}\n`;
}

/** Collection proxies for fields past one collection's instance cap; main/field.lua's WORLDS. */
const WORLDS = 10;

const embedded = (id: string, type: string, data: string) => `embedded_components {\n  id: ${q(id)}\n  type: ${q(type)}\n  data: ${q(data)}\n}\n`;

function generate(withSponza: boolean, webgpu = false) {
  rmSync(GENERATED, { recursive: true, force: true });
  for (const d of ['geometry', 'objects', 'materials', 'shapes', 'fonts']) mkdirSync(join(GENERATED, d), { recursive: true });
  // the HUD font every engine loads (npm run fetch-assets)
  const ttf = join(ROOT, 'public', 'assets', 'fonts', 'Roboto-Regular.ttf');
  if (!existsSync(ttf)) throw new Error(`${ttf} missing: run npm run fetch-assets first`);
  cpSync(ttf, join(GENERATED, 'fonts', 'Roboto-Regular.ttf'));
  const foxMaterial = fox();
  for (const name of ['pbr_skinned', 'pbr_skinned_inst', 'pbr_skinned_world']) MATERIALS[name].defaults = { pbr: foxMaterial.pbr };
  for (const [name, m] of Object.entries(MATERIALS)) writeFileSync(join(GENERATED, 'materials', `${name}.material`), material(name, m));

  const factories: string[] = [];
  const factory = (id: string, prototype: string) => factories.push(embedded(id, 'factory', `prototype: ${q(prototype)}\n`));
  for (const g of fieldGeometries()) {
    writeFileSync(join(GENERATED, 'geometry', `${g.name}.glb`), glb(g));
    writeFileSync(join(GENERATED, 'shapes', `${g.name}.convexshape`), shape(g));
    for (const [suffix, p] of Object.entries(PROTOTYPES)) {
      const model = `mesh: ${q(`/generated/geometry/${g.name}.glb`)}\nname: "{{NAME}}"\nmaterials {\n  name: "default"\n  material: "/generated/materials/${p.material}.material"\n}\n`;
      let go = embedded('model', 'model', model);
      if (p.collider) {
        go += embedded('collision', 'collisionobject', `collision_shape: "/generated/shapes/${g.name}.convexshape"\ntype: COLLISION_OBJECT_TYPE_STATIC\nmass: 0.0\nfriction: 0.1\nrestitution: 0.5\ngroup: "pick"\nmask: "pick"\n`);
      }
      writeFileSync(join(GENERATED, 'objects', `${g.name}${suffix}.go`), go);
      factory(`${g.name}${suffix}`, `/generated/objects/${g.name}${suffix}.go`);
    }
  }
  writeFileSync(join(GENERATED, 'objects', 'group.go'), '');
  factory('group', '/generated/objects/group.go');
  factory('hud', '/hud/hud.go');
  // placeholders for textures bound at runtime
  mkdirSync(join(GENERATED, 'textures'), { recursive: true });
  writeFileSync(join(GENERATED, 'textures', 'white.png'), png(1, 1, [255, 255, 255, 255]));
  writeFileSync(join(GENERATED, 'textures', 'normal.png'), png(1, 1, [128, 128, 255, 255]));
  // bloom: a clip-space quad the render script draws once per pass with an override material
  const quad: Geometry = { name: 'quad', positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]) };
  writeFileSync(join(GENERATED, 'geometry', 'quad.glb'), glb(quad));
  writeFileSync(join(GENERATED, 'objects', 'post.go'), embedded('model', 'model', `mesh: "/generated/geometry/quad.glb"\nname: "{{NAME}}"\nmaterials {\n  name: "default"\n  material: "/generated/materials/post.material"\n  textures {\n    sampler: "tex0"\n    texture: "/generated/textures/white.png"\n  }\n}\n`));
  factory('post', '/generated/objects/post.go');
  if (withSponza) {
    sponza(webgpu);
    factory('sponza', '/generated/objects/sponza.go');
  }
  writeFileSync(join(GENERATED, 'bench.render'), `script: "/render/bench.render_script"\n${RENDER_MATERIALS.map((n) => `materials {\n  name: ${q(n)}\n  material: "/generated/materials/${n}.material"\n}\n`).join('')}`);
  for (const [suffix, mat] of [['', 'pbr_skinned'], ['_inst', 'pbr_skinned_inst'], ['_cpu', 'pbr_skinned_world']]) {
    // create_go_bones off: a game object per bone would count 24 more per Fox against max_instances
    const model = `mesh: "/generated/fox/Fox.glb"\nname: "{{NAME}}"\nmaterials {\n  name: ${q(foxMaterial.material)}\n  material: "/generated/materials/${mat}.material"\n  textures {\n    sampler: "tex0"\n    texture: "/generated/fox/fox.png"\n  }\n}\nskeleton: "/generated/fox/Fox.glb"\nanimations: "/generated/fox/Fox.glb"\ndefault_animation: "Walk"\ncreate_go_bones: false\n`;
    writeFileSync(join(GENERATED, 'objects', `fox${suffix}.go`), embedded('model', 'model', model));
    factory(`fox${suffix}`, `/generated/objects/fox${suffix}.go`);
  }

  // K9: a tile source laid out exactly like the harness's atlas canvas, whose pixels the HUD overwrites
  mkdirSync(join(GENERATED, 'hud'), { recursive: true });
  const { cols, rows, cell } = HUD_ATLAS;
  writeFileSync(join(GENERATED, 'hud', 'atlas.png'), png(cols * cell, rows * cell));
  const animations = Array.from({ length: cols * rows }, (_, i) => `animations {\n  id: "cell${i}"\n  start_tile: ${i + 1}\n  end_tile: ${i + 1}\n  playback: PLAYBACK_NONE\n  fps: 30\n}`);
  writeFileSync(join(GENERATED, 'hud', 'atlas.tilesource'), [`image: "/generated/hud/atlas.png"`, `tile_width: ${cell}`, `tile_height: ${cell}`, 'tile_margin: 0', 'tile_spacing: 0', 'collision: ""', 'material_tag: "tile"', ...animations, 'extrude_borders: 0', 'inner_padding: 0', ''].join('\n'));
  writeFileSync(join(GENERATED, 'factories.go'), factories.join(''));

  // Fields past collection.max_instances spawn their shares in these (defold/main/field.lua).
  mkdirSync(join(GENERATED, 'worlds'), { recursive: true });
  const proxies: string[] = [];
  for (let k = 1; k <= WORLDS; k++) {
    writeFileSync(join(GENERATED, 'worlds', `world${k}.collection`), `name: "world${k}"\ninstances {\n  id: "factories"\n  prototype: "/generated/factories.go"\n}\ninstances {\n  id: "spawner"\n  prototype: "/main/world.go"\n}\nscale_along_z: 0\n`);
    proxies.push(embedded(`world${k}`, 'collectionproxy', `collection: "/generated/worlds/world${k}.collection"\nexclude: false\n`));
  }
  writeFileSync(join(GENERATED, 'worlds.go'), proxies.join(''));
}

function works(java: string) {
  return spawnSync(java, ['-version'], { stdio: 'ignore' }).status === 0;
}

function findJava() {
  const candidates = [process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', 'java'), 'java'];
  const packages = '/Applications/Defold.app/Contents/Resources/packages';
  if (existsSync(packages)) {
    for (const d of readdirSync(packages).filter((d) => d.startsWith('jdk-')).sort().reverse()) candidates.push(join(packages, d, 'bin', 'java'));
  }
  const java = candidates.find((c): c is string => !!c && works(c));
  if (!java) throw new Error('Java 21+ not found: set JAVA_HOME, put java on PATH or install Defold.app');
  return java;
}

function findBob() {
  if (process.env.DEFOLD_BOB) return process.env.DEFOLD_BOB;
  const jar = join(CACHE, `bob-${DEFOLD_VERSION}.jar`);
  if (!existsSync(jar)) {
    mkdirSync(CACHE, { recursive: true });
    const url = `https://d.defold.com/archive/stable/${DEFOLD_SHA1}/bob/bob.jar`;
    console.log(`downloading bob ${DEFOLD_VERSION}…`);
    execFileSync('curl', ['-sSfL', '-o', jar, url], { stdio: 'inherit' });
  }
  return jar;
}

const java = findJava();
const bob = findBob();
const buildServer = process.env.DEFOLD_BUILD_SERVER ?? 'https://build.defold.com';

/**
 * Defold downloads its whole archive at boot, so K4's Sponza ships in its own bundle and every other
 * scene's startup only pays for what it uses. The adapter picks the bundle.
 */
/**
 * The app manifest Defold's editor writes for HTML5 graphics "WebGPU": the WebGPU adapter instead of
 * the OpenGL one, Emscripten's WebGPU bindings, and Asyncify for the adapter and device requests.
 */
const WEBGPU_MANIFEST = `platforms:
  wasm-web:
    context:
      excludeLibs: [graphics]
      excludeSymbols: [GraphicsAdapterOpenGL]
      symbols: [GraphicsAdapterWebGPU]
      libs: [graphics_webgpu]
      emscriptenLinkFlags: [USE_WEBGPU=1, GL_WORKAROUND_SAFARI_GETCONTEXT_BUG=0, ASYNCIFY=1, ASYNCIFY_IGNORE_INDIRECT=1, 'ASYNCIFY_ADD=["main","dmEngineCreate(*)","requestDeviceCallback(*)","WebGPUCreateSwapchain(*)","instanceRequestAdapterCallback(*)"]']
`;

/** game.project overrides for a WebGPU build (bob --settings), with the manifest written into `root`. */
function webgpuSettings(root: string) {
  writeFileSync(join(root, 'generated', 'webgpu.appmanifest'), WEBGPU_MANIFEST);
  const file = join(CACHE, 'webgpu.settings');
  writeFileSync(file, '[native_extension]\napp_manifest = /generated/webgpu.appmanifest\n');
  return file;
}

function bundle(root: string, out: string, server: boolean, settings?: string) {
  rmSync(out, { recursive: true, force: true });
  execFileSync(java, [
    '--enable-native-access=ALL-UNNAMED',
    '-jar', bob,
    '--root', root,
    '--platform', 'wasm-web',
    '--architectures', 'wasm-web',
    '--variant', 'release',
    '--archive',
    '--bundle-output', out,
    ...(server ? ['--build-server', buildServer] : []),
    ...(settings ? ['--settings', settings] : []),
    'build', 'bundle',
  ], { stdio: 'inherit' });
  const [dir] = readdirSync(out).filter((d) => existsSync(join(out, d, 'dmloader.js')));
  if (!dir) throw new Error(`no HTML5 bundle in ${out}`);
  return join(out, dir);
}

// `npm run build-defold -- webgpu` builds one backend only
const BACKENDS = (['webgl2', 'webgpu'] as const).filter((b) => !process.argv[2] || process.argv[2] === b);
const suffix = (backend: string) => (backend === 'webgpu' ? '-webgpu' : '');

for (const backend of BACKENDS) {
  for (const [name, withSponza] of [['defold', false], ['defold-sponza', true]] as const) {
    generate(withSponza, backend === 'webgpu');
    const target = name + suffix(backend);
    console.log(`bob ${DEFOLD_VERSION}: bundling ${target} for wasm-web (engine built on ${buildServer})…`);
    const built = bundle(PROJECT, BUNDLE, true, backend === 'webgpu' ? webgpuSettings(PROJECT) : undefined);
    const out = join(ROOT, 'public', target);
    rmSync(out, { recursive: true, force: true });
    cpSync(built, out, { recursive: true });
    writeFileSync(join(out, 'version.json'), JSON.stringify({ defold: DEFOLD_VERSION, sha1: DEFOLD_SHA1, backend }));
    console.log(`→ public/${target} (${readdirSync(out).join(', ')})`);
  }
}

// K1 bundle size (scripts/bundle-size.ts): the minimal and realistic apps (defold/apps) without the
// bench bridge extension: the stock engine on WebGL2, the editor's WebGPU manifest on WebGPU.
generate(false);
for (const backend of BACKENDS) {
  for (const app of ['minimal', 'realistic']) {
    const root = join(CACHE, 'apps', app);
    rmSync(root, { recursive: true, force: true });
    cpSync(PROJECT, root, { recursive: true, filter: (src) => !/[\\/](bench_bridge|build|\.internal)$/.test(src) });
    const settings = readFileSync(join(root, 'game.project'), 'utf8').replace(/^main_collection = .*$/m, `main_collection = /apps/${app}.collectionc`);
    writeFileSync(join(root, 'game.project'), settings);
    console.log(`bob ${DEFOLD_VERSION}: bundling the ${app} app for ${backend}…`);
    const webgpu = backend === 'webgpu';
    const built = bundle(root, join(CACHE, 'apps', `${app}${suffix(backend)}-bundle`), webgpu, webgpu ? webgpuSettings(root) : undefined);
    console.log(`→ ${relative(ROOT, built)}`);
  }
}
