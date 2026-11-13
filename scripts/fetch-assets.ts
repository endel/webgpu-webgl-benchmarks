// Downloads the Khronos glTF sample assets used by S7/S8 into public/assets (gitignored),
// and writes a manifest with each model's POSITION bounds so scenes can be framed identically.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const REPO = 'KhronosGroup/glTF-Sample-Assets';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const OUT = join(import.meta.dirname, '..', 'public', 'assets');

const MODELS = [
  { name: 'Sponza', dir: 'Models/Sponza/glTF', entry: 'Sponza.gltf' },
  { name: 'Fox', dir: 'Models/Fox/glTF-Binary', entry: 'Fox.glb' },
];

async function exists(p: string) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<{ name: string; path: string; type: string }[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${dir}`, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${dir}`);
  return res.json();
}

async function download(path: string, dest: string) {
  if (await exists(dest)) return false;
  const res = await fetch(`${RAW}/${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

/** Union of POSITION accessor min/max over all meshes, ignoring node transforms. */
function boundsFromJson(json: any) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (!acc?.min) continue;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], acc.min[k]);
        max[k] = Math.max(max[k], acc.max[k]);
      }
    }
  }
  return { min, max };
}

type Mat = number[]; // column-major 4x4

function nodeMatrix(n: any): Mat {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function mul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** World-space AABB of the default scene's static meshes (skinned meshes ignore their node transform). */
function worldBoundsFromJson(json: any) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const visit = (idx: number, parent: Mat) => {
    const n = json.nodes[idx];
    const m = mul(parent, nodeMatrix(n));
    if (n.mesh !== undefined && n.skin === undefined) {
      for (const prim of json.meshes[n.mesh].primitives ?? []) {
        const acc = json.accessors?.[prim.attributes?.POSITION];
        if (!acc?.min) continue;
        for (let i = 0; i < 8; i++) {
          const p = [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]];
          for (let k = 0; k < 3; k++) {
            const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k];
            min[k] = Math.min(min[k], v);
            max[k] = Math.max(max[k], v);
          }
        }
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, identity);
  return Number.isFinite(min[0]) ? { min, max } : null;
}

async function gltfJson(file: string) {
  const buf = await readFile(file);
  if (file.endsWith('.glb')) {
    const len = buf.readUInt32LE(12);
    return JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  }
  return JSON.parse(buf.toString('utf8'));
}

const manifest: Record<string, unknown> = {};
for (const m of MODELS) {
  const files = await listDir(m.dir);
  let fetched = 0;
  await Promise.all(
    files
      .filter((f) => f.type === 'file')
      .map(async (f) => {
        if (await download(f.path, join(OUT, m.name, f.name))) fetched++;
      }),
  );
  const json = await gltfJson(join(OUT, m.name, m.entry));
  manifest[m.name] = {
    url: `assets/${m.name}/${m.entry}`,
    bounds: boundsFromJson(json),
    worldBounds: worldBoundsFromJson(json),
    animations: (json.animations ?? []).map((a: any, i: number) => a.name ?? `anim${i}`),
    nodes: json.nodes?.length ?? 0,
    meshes: json.meshes?.length ?? 0,
    skins: json.skins?.length ?? 0,
    joints: json.skins?.[0]?.joints?.length ?? 0,
  };
  console.log(`${m.name}: ${files.length} files (${fetched} downloaded)`);
}
// K9's HUD text: one TTF every engine loads through its own text path.
{
  const dest = join(OUT, 'fonts', 'Roboto-Regular.ttf');
  if (!(await stat(dest).catch(() => null))) {
    const res = await fetch('https://raw.githubusercontent.com/googlefonts/roboto-2/main/src/hinted/Roboto-Regular.ttf');
    if (!res.ok) throw new Error(`font download failed: ${res.status}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  }
}
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
