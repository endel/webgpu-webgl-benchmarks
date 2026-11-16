import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as cameraPath from './camera-path';
import { parseParams } from './params';
import * as scenes from './scenes';
import * as stats from './stats';
import type { EngineAdapter, SceneData } from './types';

interface Snapshot {
  gcForced: boolean;
  jsHeapUsed: number | null;
}
interface Result {
  status: string;
  error?: string;
  frames?: { count: number; gpuTimed: number; gpuCoverage: number; path: { poses: number; laps: number } | null };
  expected?: scenes.ExpectedWork | null;
  memory?: { before: Snapshot; after: Snapshot };
}
interface Sample {
  phase: string;
  time: number;
  position: number[];
  target: number[];
}

const assets: scenes.AssetManifest = {
  Sponza: { url: 'sponza.gltf', bounds: { min: [-20, 0, -10], max: [20, 20, 10] }, worldBounds: null, animations: [] },
};
const source = stripTypeScriptTypes(readFileSync(new URL('./run.ts', import.meta.url), 'utf8'));
const BASE = 'scenario=k5&level=200&engine=three&warmupFrames=62&warmupMs=500&measureFrames=60&measureMs=250';

/**
 * Run the real page entry with a virtual browser clock and a renderer that records its inputs.
 * `frameMs` is the time each animation frame takes, or a function of the phase and the frames
 * rendered in it so far. With `gc`, the page sees it as the browser's exposed collector.
 */
async function run(frameMs: number | ((phase: string, k: number) => number), overrides = '', gc?: () => void) {
  const query = new URLSearchParams(BASE);
  for (const [key, value] of new URLSearchParams(overrides)) query.set(key, value);
  const params = parseParams(query);
  const samples: Sample[] = [];
  const frameIds: number[] = [];
  const heapReads: string[] = [];
  const gpuTimes = new Map<number, { span: number; sum: number; passes: number }>();
  let now = 0;
  let phase = '';
  let scene: SceneData;
  let finish!: (value: Result) => void;
  const result = new Promise<Result>((resolve) => (finish = resolve));
  const inPhase = () => samples.filter((s) => s.phase === phase).length;
  const adapter: EngineAdapter = {
    name: 'test',
    version: 'test',
    async init() {
      return { backend: 'webgpu', msaa: 4 };
    },
    async load(data) {
      scene = data;
      return { path: 'record inputs' };
    },
    frame(time) {
      samples.push({ phase, time, position: [...scene.camera.position], target: [...scene.camera.target] });
    },
    async dispose() {},
  };
  const canvas = { width: 0, height: 0, style: {} };
  const hud = {
    set textContent(value: string) {
      phase = value.slice(value.lastIndexOf('\n') + 1);
    },
  };
  const context = createContext({
    console: { error() {}, warn() {} },
    location: { search: '' },
    URLSearchParams,
    navigator: { userAgent: 'test' },
    devicePixelRatio: 1,
    document: { getElementById: (id: string) => (id === 'c' ? canvas : hud) },
    window: { addEventListener() {} },
    performance: {
      now: () => now,
      get memory() {
        heapReads.push('heap');
        return { usedJSHeapSize: 1000, totalJSHeapSize: 2000 };
      },
    },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    requestAnimationFrame(callback: (time: number) => void) {
      queueMicrotask(() => {
        now += typeof frameMs === 'number' ? frameMs : frameMs(phase, inPhase());
        callback(now);
      });
    },
    async fetch(url: string, init?: { body: string }) {
      if (url === '/api/result') finish(JSON.parse(init!.body));
      return { json: async () => assets };
    },
    ...(gc && { gc: () => (heapReads.push('gc'), gc()) }),
  });
  async function module(exports: Record<string, unknown>) {
    const mod = new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
    await mod.link(() => {
      throw new Error('Unexpected import');
    });
    await mod.evaluate();
    return mod;
  }
  const imports = new Map([
    ['./params', await module({ parseParams: () => params })],
    ['./scenes', await module({ ...scenes })],
    ['./stats', await module({ ...stats })],
    ['./camera-path', await module({ ...cameraPath })],
    ['./probe-webgl', await module({ installWebGLProbe: () => null })],
    ['./probe-webgpu', await module({
      installWebGPUProbe: () => ({
        takeFrame: () => ({}),
        // Every other frame gets a GPU time, like a browser whose readbacks lag behind.
        endFrame: (i: number) => (frameIds.push(i), i % 2 || gpuTimes.set(i, { span: 1, sum: 1, passes: 1 })),
        pipelinesCreated: () => 0,
        gpuTimes,
        errors: [],
        flush: async () => {},
        report: () => ({}),
      }),
    })],
  ]);
  const engine = await module({ createAdapter: () => adapter });
  const entry = new SourceTextModule(source, { context, importModuleDynamically: async () => engine });
  await entry.link((name) => {
    const mod = imports.get(name);
    if (!mod) throw new Error(`Unexpected import: ${name}`);
    return mod;
  });
  await entry.evaluate();
  const done = await result;
  const of = (p: string) => samples.filter((s) => s.phase === p);
  return { result: done, measured: of('measuring…'), warm: of('warm-up…'), frameIds, heapReads };
}

type Run = Awaited<ReturnType<typeof run>>;

/** Both runs measure the same whole laps of camera poses, starting from pose 0. */
function assertSameLaps(fast: Run, slow: Run) {
  for (const { result, measured, frameIds } of [fast, slow]) {
    assert.equal(result.status, 'ok', result.error ?? 'run failed');
    const laps = measured.length / 60;
    assert.ok(Number.isInteger(laps) && laps >= 1, `measured ${measured.length} frames`);
    assert.deepEqual(result.frames!.path, { poses: 60, laps });
    assert.equal(result.frames!.count, measured.length);
    assert.equal(measured[0].time, 0, 'measurement starts at the first pose');
    measured.forEach((s, k) => assert.deepEqual(s, measured[k % 60], `frame ${k} repeats pose ${k % 60}`));
    assert.equal(new Set(frameIds).size, frameIds.length, 'GPU frame ids stay unique');
  }
  assert.equal(slow.measured.length, 60);
  assert.ok(fast.measured.length > 60, 'a fast engine measures more laps');
  assert.deepEqual(fast.measured.slice(0, 60), slow.measured);
  assert.equal(new Set(slow.measured.map((s) => JSON.stringify([s.position, s.target]))).size, 60, 'the camera moves through 60 poses');
}

test('K5 measures the same whole laps of camera poses at any frame rate', async () => {
  assertSameLaps(await run(1), await run(20));
});

test('K4 measures the same whole laps of camera poses at any frame rate', async () => {
  assertSameLaps(await run(1, 'scenario=k4&level=0'), await run(20, 'scenario=k4&level=0'));
});

test('warm-up renders every pose before measurement starts', async () => {
  for (const ms of [1, 20]) {
    const { warm, measured } = await run(ms);
    const warmed = new Set(warm.map((s) => s.time));
    assert.equal(warmed.size, 60);
    for (const s of measured) assert.ok(warmed.has(s.time));
  }
});

test('a run that cannot finish one lap fails instead of reporting part of it', async () => {
  const stopped = await run(300, 'maxMeasureMs=3000');
  assert.equal(stopped.result.status, 'error');
  assert.match(stopped.result.error!, /^camera path incomplete: warm-up/);
  assert.equal(stopped.result.frames, undefined);

  const slowed = await run((phase) => (phase === 'measuring…' ? 300 : 20), 'maxMeasureMs=3000');
  assert.equal(slowed.result.status, 'error');
  assert.match(slowed.result.error!, /^camera path incomplete: rendered 21 of 60 poses/);
  assert.equal(slowed.result.frames, undefined);
});

test('a partial lap after a whole one is dropped', async () => {
  const pace = (phase: string, k: number) => (phase === 'measuring…' && k >= 60 ? 300 : 20);
  const { result, measured } = await run(pace, 'maxMeasureMs=3000&measureFrames=600');
  assert.equal(result.status, 'ok', result.error ?? 'run failed');
  assert.deepEqual(result.frames!.path, { poses: 60, laps: 1 });
  assert.equal(result.frames!.count, 60);
  assert.ok(measured.length > 60, 'the second lap was started');
});

test('scenes without a camera path keep continuous time', async () => {
  const { result, measured } = await run(1, 'scenario=k2&level=500');
  assert.equal(result.status, 'ok', result.error ?? 'run failed');
  assert.ok(measured[0].time > 0);
  assert.ok(measured.length > 60);
  assert.equal(result.frames!.path, null);
  assert.equal(result.frames!.count, measured.length);
  assert.equal(result.expected?.objects, 500, 'results record the expected work for the render guard');
});

test('results count the frames that carry a GPU time', async () => {
  const { result, frameIds } = await run(20);
  const measuredIds = frameIds.slice(-60);
  assert.equal(result.frames!.gpuTimed, measuredIds.filter((i) => i % 2 === 0).length);
  assert.equal(result.frames!.gpuCoverage, 0.5);
  assert.equal(result.expected, null);
});

test('memory snapshots force a collection where the browser exposes gc()', async () => {
  let collections = 0;
  const forced = await run(20, '', () => collections++);
  assert.equal(collections, 2);
  assert.deepEqual(forced.heapReads.slice(0, 4), ['gc', 'heap', 'gc', 'heap'], 'each collection runs before the heap is read');
  assert.equal(forced.result.memory!.before.gcForced, true);
  assert.equal(forced.result.memory!.after.gcForced, true);
  assert.equal(forced.result.memory!.before.jsHeapUsed, 1000);

  const plain = await run(20);
  assert.equal(plain.result.memory!.before.gcForced, false);
  assert.equal(plain.result.memory!.after.gcForced, false);
});
