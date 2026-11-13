// Shipped-size comparison: builds each engine's minimal lit-cube entry and its "realistic" entry
// (glTF + animation + shadows + bloom), tree-shaken and minified, plus the full benchmark adapters, and counts lines of code per scenario file.
//   npm run bundle-size   → results/bundle-size.json
import { build, defaultClientConditions } from 'vite';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-size');
const ENGINES = ['three', 'three-classic', 'playcanvas', 'babylon', 'babylon-lite', 'pixi3d'];

interface Size { raw: number; gzip: number; brotli: number; files: number }
type Manifest = Record<string, { file: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[]; src?: string }>;

const empty = (): Size => ({ raw: 0, gzip: 0, brotli: 0, files: 0 });
function add(s: Size, file: string) {
  const buf = readFileSync(file);
  s.raw += buf.length;
  s.gzip += gzipSync(buf, { level: 9 }).length;
  s.brotli += brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  s.files++;
}

/** Entry chunk + transitive static imports (what must download before first frame), and everything reachable. */
function measure(dir: string, manifest: Manifest, entryKey: string, exclude = new Set<string>()) {
  const initial = empty(), lazy = empty();
  const seenStatic = new Set<string>(), seenAll = new Set<string>();
  const walkStatic = (k: string) => {
    if (seenStatic.has(k) || exclude.has(k)) return;
    seenStatic.add(k);
    for (const i of manifest[k].imports ?? []) walkStatic(i);
  };
  const walkAll = (k: string) => {
    if (seenAll.has(k) || exclude.has(k)) return;
    seenAll.add(k);
    for (const i of [...(manifest[k].imports ?? []), ...(manifest[k].dynamicImports ?? [])]) walkAll(i);
  };
  walkStatic(entryKey);
  walkAll(entryKey);
  for (const k of seenAll) {
    const file = join(dir, manifest[k].file);
    if (!file.endsWith('.js')) continue;
    add(seenStatic.has(k) ? initial : lazy, file);
  }
  const total: Size = { raw: initial.raw + lazy.raw, gzip: initial.gzip + lazy.gzip, brotli: initial.brotli + lazy.brotli, files: initial.files + lazy.files };
  return { initial, lazy, total };
}

async function buildEntry(name: string, input: string) {
  const outDir = join(OUT, name);
  await build({
    root: ROOT,
    configFile: false,
    logLevel: 'warn',
    resolve: { conditions: [...defaultClientConditions, 'babylon-lite-rh'] },
    build: { outDir, emptyOutDir: true, target: 'es2022', manifest: true, modulePreload: false, assetsDir: '.', rolldownOptions: { input } },
  });
  return { outDir, manifest: JSON.parse(readFileSync(join(outDir, '.vite', 'manifest.json'), 'utf8')) as Manifest };
}

function loc(file: string) {
  let n = 0, block = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (block) {
      if (line.includes('*/')) block = false;
      continue;
    }
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      block = !line.includes('*/');
      continue;
    }
    n++;
  }
  return n;
}

mkdirSync(OUT, { recursive: true });
const result: Record<string, unknown> = { measuredAt: new Date().toISOString() };

for (const kind of ['minimal', 'realistic']) {
  const sizes: Record<string, unknown> = {};
  for (const engine of ENGINES) {
    const input = join(ROOT, 'src', kind, `${engine}.ts`);
    if (!existsSync(input)) continue;
    try {
      const { outDir, manifest } = await buildEntry(`${kind}-${engine}`, input);
      const key = Object.keys(manifest).find((k) => manifest[k].isEntry)!;
      sizes[engine] = measure(outDir, manifest, key);
      console.log(`${kind} ${engine}:`, JSON.stringify((sizes[engine] as any).total));
    } catch (e) {
      console.log(`${kind} ${engine}: build failed — ${String(e).split('\n')[0]}`);
    }
  }
  result[kind] = sizes;
}

// Full adapters: each engine's dynamic entry from the bench page, minus chunks shared with the harness.
{
  const { outDir, manifest } = await buildEntry('full', join(ROOT, 'bench.html'));
  const benchKey = Object.keys(manifest).find((k) => manifest[k].isEntry)!;
  const harness = new Set<string>();
  const walk = (k: string) => {
    if (harness.has(k)) return;
    harness.add(k);
    for (const i of manifest[k].imports ?? []) walk(i);
  };
  walk(benchKey);
  const full: Record<string, unknown> = {};
  for (const engine of ENGINES) {
    const key = Object.keys(manifest).find((k) => k === `src/engines/${engine}/index.ts`);
    if (key) full[engine] = measure(outDir, manifest, key, harness);
  }
  result.full = full;
}

const locs: Record<string, Record<string, number>> = {};
for (const engine of ENGINES) {
  const dir = join(ROOT, 'src', 'engines', engine);
  if (!existsSync(dir)) continue;
  locs[engine] = {};
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    if (f.endsWith('.ts')) locs[engine][relative(dir, join(dir, f))] = loc(join(dir, f));
  }
}
result.loc = locs;

mkdirSync(join(ROOT, 'results'), { recursive: true });
writeFileSync(join(ROOT, 'results', 'bundle-size.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
