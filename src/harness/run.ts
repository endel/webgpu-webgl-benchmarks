// Bench page entry. Probes are installed before any engine module loads (engines are dynamic imports).
import { installWebGPUProbe } from './probe-webgpu';
import { installWebGLProbe } from './probe-webgl';
import { parseParams } from './params';
import { buildScene, needsAssets, WIDTH, HEIGHT, type AssetManifest } from './scenes';
import { summarize, stutterCount, longFrames, median, round3 } from './stats';
import type { EngineAdapter, EngineId, FrameCounters, SceneData } from './types';

const params = parseParams(location.search);
const wgpu = installWebGPUProbe(params.mode, params.gpuTiming);
const wgl = installWebGLProbe(params.mode);

const DT = 1 / 60;
const SHOT_FRAME = 60;
const STABLE_FRAMES = 30;
const WARMUP_CAP_MS = 20000;
/** No animation frame for this long means the window is occluded or the GPU is wedged. */
const STALL_MS = 10000;

/** Resolves undefined after `ms`, or rejects with `msg` when given. */
const withTimeout = <T,>(p: Promise<T> | undefined, ms: number, msg?: string) =>
  Promise.race([p, new Promise<undefined>((resolve, reject) => setTimeout(() => (msg ? reject(new Error(msg)) : resolve(undefined)), ms))]);
/** 2.5× the early-stop threshold: numbers are still recorded, just from 5 frames. */
const PATHOLOGICAL_MS = 250;

const ENGINES: Record<EngineId, () => Promise<{ createAdapter(): EngineAdapter }>> = {
  three: () => import('../engines/three/index'),
  'three-classic': () => import('../engines/three-classic/index'),
  playcanvas: () => import('../engines/playcanvas/index'),
  babylon: () => import('../engines/babylon/index'),
  'babylon-lite': () => import('../engines/babylon-lite/index'),
  pixi3d: () => import('../engines/pixi3d/index'),
};

const consoleErrors: string[] = [];
const consoleWarnings: string[] = [];
for (const [level, sink] of [['error', consoleErrors], ['warn', consoleWarnings]] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (sink.length < 30) sink.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ').slice(0, 400));
    orig(...args);
  };
}

const hud = document.getElementById('hud')!;
const status = (s: string) => {
  hud.textContent = `${params.engine} ${params.backend} ${params.scenario}/${params.variant}@${params.level} ${params.mode}\n${s}`;
  // Heartbeat: a watchdog timeout then records which phase stalled.
  if (params.session && !params.standalone) navigator.sendBeacon?.('/api/progress', JSON.stringify({ runId: params.runId, phase: s }));
};

let activeAdapter: EngineAdapter | null = null;

/** Safari can keep the previous page (and its GPU device) alive across navigations; release it explicitly. */
async function releaseGpu() {
  try {
    await Promise.race([activeAdapter?.dispose(), new Promise((r) => setTimeout(r, 2000))]);
  } catch {}
  try {
    wgpu?.device?.destroy();
  } catch {}
}

/** Browser-launch generation from the runner; the server ignores pages from older launches. */
const gen = new URLSearchParams(location.search).get('gen') ?? '';

async function post(path: string, body: unknown) {
  if (params.standalone) return;
  try {
    await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(body as object), gen }) });
  } catch {}
}

const log = (msg: string) => post('/api/log', { runId: params.runId, msg });

function setupCanvas() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  fixCss(canvas);
  return canvas;
}

/** 1920×1080 device pixels regardless of DPR; engines sometimes restyle the canvas during init. */
function fixCss(canvas: HTMLCanvasElement) {
  const dpr = devicePixelRatio || 1;
  canvas.style.width = `${WIDTH / dpr}px`;
  canvas.style.height = `${HEIGHT / dpr}px`;
}

function screenshot(canvas: HTMLCanvasElement) {
  // toBlob snapshots the bitmap synchronously — must run in the same task as the render.
  const name = `${params.engine}_${params.backend}_${params.scenario}_${params.variant}_${params.level}.png`;
  canvas.toBlob((blob) => {
    if (!blob || params.standalone) return;
    fetch(`/api/screenshot?session=${params.session ?? ''}&name=${encodeURIComponent(name)}`, { method: 'POST', body: blob }).catch(() => {});
  }, 'image/png');
}

interface FrameRec {
  i: number;
  ts: number;
  sim: number;
  cpu: number;
  counters?: FrameCounters;
}

async function gpuIdle() {
  if (params.backend === 'webgpu') await wgpu?.device?.queue.onSubmittedWorkDone();
  else if (wgl?.gl) wgl.gl.readPixels(0, 0, 1, 1, wgl.gl.RGBA, wgl.gl.UNSIGNED_BYTE, new Uint8Array(4));
}

const pipelinesCreated = () => (params.backend === 'webgpu' ? wgpu?.pipelinesCreated() ?? 0 : wgl?.pipelinesCreated() ?? 0);

async function main() {
  const marks: Record<string, number> = { scriptStart: performance.now() };
  const canvas = setupCanvas();

  if (params.scenario === 'cal') return calibrate(marks);
  if (params.engine === 'none') throw new Error('engine=none is only valid for scenario=cal');

  status('importing engine…');
  const mod = await ENGINES[params.engine]();
  marks.imported = performance.now();
  const adapter = mod.createAdapter();
  activeAdapter = adapter;

  status('init…');
  const initReport = await adapter.init(canvas, { backend: params.backend, width: WIDTH, height: HEIGHT, msaa: 4 });
  marks.initialized = performance.now();
  fixCss(canvas);
  if (initReport.backend !== params.backend) throw new Error(`backend fallback: requested ${params.backend}, engine is on ${initReport.backend}`);
  if (canvas.width !== WIDTH || canvas.height !== HEIGHT) throw new Error(`canvas resized by engine to ${canvas.width}x${canvas.height}`);

  let assets: AssetManifest | null = null;
  if (needsAssets(params.scenario)) assets = await (await fetch('assets/manifest.json')).json();
  const scene: SceneData = buildScene(params.scenario, params.level, assets, params.variant);
  marks.built = performance.now();

  status('load…');
  const loadReport = await adapter.load(scene, params.variant, params.opt);
  marks.loaded = performance.now();

  let frameIndex = 0;
  let lastCreateFrame = 0;
  let lastCreates = pipelinesCreated();
  wgpu?.takeFrame();
  wgl?.takeFrame();

  const renderOne = (): FrameRec => {
    const i = frameIndex++;
    const t = i * DT;
    const a = performance.now();
    scene.update(t);
    const b = performance.now();
    wgl?.beginFrame(i);
    adapter.frame(t, DT);
    wgl?.endFrame();
    const c = performance.now();
    wgpu?.endFrame(i);
    if (i === SHOT_FRAME && params.screenshot) screenshot(canvas);
    const creates = pipelinesCreated();
    if (creates !== lastCreates) {
      lastCreates = creates;
      lastCreateFrame = i;
    }
    const counters = params.mode === 'counters' ? { ...(wgpu?.takeFrame() ?? {}), ...(wgl?.takeFrame() ?? {}) } : undefined;
    if (params.mode !== 'counters') {
      wgpu?.takeFrame();
      wgl?.takeFrame();
    }
    return { i, ts: 0, sim: b - a, cpu: c - b, counters };
  };

  // First frame, synchronously after load: TTFF includes any first-draw pipeline compilation.
  status('first frame…');
  const first = renderOne();
  await withTimeout(gpuIdle(), 20000, 'stalled: the GPU did not finish the first frame within 20 s');
  marks.firstFrame = performance.now();

  const loop = (done: (n: number, elapsed: number, last: FrameRec) => boolean) =>
    new Promise<FrameRec[]>((resolve, reject) => {
      const recs: FrameRec[] = [];
      let start = -1;
      let lastTick = performance.now();
      const guard = setInterval(() => {
        if (performance.now() - lastTick < STALL_MS) return;
        clearInterval(guard);
        reject(new Error(`stalled: no animation frame for ${STALL_MS / 1000} s (window occluded or GPU hang)`));
      }, 1000);
      const tick = (ts: number) => {
        lastTick = performance.now();
        try {
          const rec = renderOne();
          rec.ts = ts;
          if (start < 0) start = ts;
          recs.push(rec);
          if (done(recs.length, ts - start, rec)) {
            clearInterval(guard);
            resolve(recs);
          } else requestAnimationFrame(tick);
        } catch (e) {
          clearInterval(guard);
          reject(e);
        }
      };
      requestAnimationFrame(tick);
    });

  if (params.standalone) return standalone(loop);

  status('warm-up…');
  let warmupCapped = false;
  const warm = await loop((n, elapsed, last) => {
    const stable = last.i - lastCreateFrame >= STABLE_FRAMES;
    const minDone = n >= params.warmupFrames && elapsed >= params.warmupMs && frameIndex > SHOT_FRAME + 1;
    if (minDone && stable) return true;
    // Far past any frame budget: stop early instead of burning the watchdog.
    if (elapsed >= WARMUP_CAP_MS || (n >= 5 && elapsed / n > PATHOLOGICAL_MS && frameIndex > SHOT_FRAME + 1)) return (warmupCapped = true);
    return false;
  });
  marks.warm = performance.now();
  const pipelinesBefore = pipelinesCreated();
  const memBefore = memorySnapshot();

  status('measuring…');
  const recs = await loop(
    (n, elapsed) =>
      (n >= params.measureFrames && elapsed >= params.measureMs) ||
      (elapsed >= params.maxMeasureMs && n >= 10) ||
      elapsed >= params.maxMeasureMs * 2 ||
      (n >= 5 && elapsed / n > PATHOLOGICAL_MS),
  );
  marks.measured = performance.now();
  const pipelinesDuringMeasure = pipelinesCreated() - pipelinesBefore;
  const memAfter = memorySnapshot();

  // K8: picks run after the timing phase, one at a time, so GPU pickers can read back.
  let pick: { ms: ReturnType<typeof summarize>; hits: number; ids: number[] } | null = null;
  if (scene.kind === 'field' && scene.pick) {
    if (!adapter.pick) throw new Error('N/A: adapter has no pick()');
    status('picking…');
    const pts = scene.pick.points;
    const ms: number[] = [], ids: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      for (let k = 0; k < pts.length / 2; k++) {
        const t0 = performance.now();
        const id = await adapter.pick(pts[k * 2], pts[k * 2 + 1]);
        ms.push(performance.now() - t0);
        if (rep === 0) ids.push(id);
      }
    }
    pick = { ms: summarize(ms), hits: ids.filter((i) => i >= 0).length, ids };
  }

  status('collecting…');
  // Late timestamp readbacks are dropped rather than waited on indefinitely.
  await withTimeout(Promise.all([wgpu?.flush(), wgl?.flush()]), 5000);

  const intervals = recs.slice(1).map((r, k) => r.ts - recs[k].ts);
  const gpuSpan: number[] = [], gpuSum: number[] = [], gpuPasses: number[] = [];
  for (const r of recs) {
    if (params.backend === 'webgpu') {
      const g = wgpu?.gpuTimes.get(r.i);
      if (g) {
        gpuSpan.push(g.span);
        gpuSum.push(g.sum);
        gpuPasses.push(g.passes);
      }
    } else {
      const g = wgl?.gpuTimes.get(r.i);
      if (g !== undefined) gpuSpan.push(g);
    }
  }

  let counters: Record<string, number> | null = null;
  if (params.mode === 'counters') {
    counters = {};
    const keys = new Set(recs.flatMap((r) => Object.keys(r.counters ?? {})));
    for (const k of keys) counters[k] = median(recs.map((r) => r.counters?.[k] ?? 0));
    const eng = adapter.counters?.();
    if (eng) for (const [k, v] of Object.entries(eng)) counters[`engine.${k}`] = v;
  }

  const mem = (performance as any).memory;
  // A lost device keeps "rendering" at absurd speed; validation errors mean frames aren't what we think.
  const gpuErrors = [...(wgpu?.errors ?? []), ...(wgl?.errors ?? [])];
  const lost = gpuErrors.some((e) => /device lost|context lost/.test(e));
  const result = {
    status: lost ? 'error' : gpuErrors.length ? 'invalid' : 'ok',
    error: gpuErrors.length ? gpuErrors.slice(0, 3).join(' | ') : undefined,
    runId: params.runId,
    session: params.session,
    params,
    ua: navigator.userAgent,
    engine: { name: adapter.name, version: adapter.version, init: initReport, load: loadReport },
    probe: params.backend === 'webgpu' ? wgpu?.report() : wgl?.report(),
    timings: {
      importMs: round3(marks.imported - marks.scriptStart),
      initMs: round3(marks.initialized - marks.imported),
      buildMs: round3(marks.built - marks.initialized),
      loadMs: round3(marks.loaded - marks.built),
      firstFrameMs: round3(marks.firstFrame - marks.loaded),
      firstFrameCpuMs: round3(first.cpu),
      ttffMs: round3(marks.firstFrame),
      warmupFrames: warm.length,
      warmupMs: round3(marks.warm - marks.firstFrame),
      warmupCapped,
      stableAtMs: round3(marks.firstFrame + (warm.find((r) => r.i === lastCreateFrame)?.ts ?? 0) - (warm[0]?.ts ?? 0)),
      measureMs: round3(marks.measured - marks.warm),
    },
    frames: {
      count: recs.length,
      interval: summarize(intervals),
      cpu: summarize(recs.map((r) => r.cpu)),
      sim: summarize(recs.map((r) => r.sim)),
      gpu: summarize(gpuSpan),
      gpuSum: summarize(gpuSum),
      gpuPasses: summarize(gpuPasses),
      gpuCoverage: round3(gpuSpan.length / recs.length),
      stutter: stutterCount(intervals),
      /** Frames over the 60 and 30 fps budgets. Interval only means something where the browser is uncapped. */
      long: { interval: longFrames(intervals), cpu: longFrames(recs.map((r) => r.cpu)) },
    },
    pick,
    raw: {
      interval: intervals.map(round3),
      cpu: recs.map((r) => round3(r.cpu)),
      gpu: recs.map((r) => {
        const g = params.backend === 'webgpu' ? wgpu?.gpuTimes.get(r.i)?.span : wgl?.gpuTimes.get(r.i);
        return g === undefined ? null : round3(g);
      }),
    },
    counters,
    memory: { jsHeapUsed: mem?.usedJSHeapSize ?? null, jsHeapTotal: mem?.totalJSHeapSize ?? null, before: memBefore, after: memAfter },
    pipelinesDuringMeasure,
    consoleErrors,
    consoleWarnings,
  };
  status(`done: interval p50 ${result.frames.interval?.p50}ms cpu p50 ${result.frames.cpu?.p50}ms gpu p50 ${result.frames.gpu?.p50 ?? '-'}ms`);
  await post('/api/result', result);
  await next();
}

/** JS heap (Chrome only), live GPU bytes (WebGPU) or live GL object counts (WebGL2), pipelines so far. */
function memorySnapshot() {
  const mem = (performance as any).memory;
  const live = (params.backend === 'webgpu' ? wgpu?.report() : wgl?.report()) as any;
  return {
    jsHeapUsed: (mem?.usedJSHeapSize as number | undefined) ?? null,
    gpuBufferBytes: (live?.mem?.buffer as number | undefined) ?? null,
    gpuTextureBytes: (live?.mem?.texture as number | undefined) ?? null,
    glObjects: (live?.live as Record<string, number> | undefined) ?? null,
    pipelines: pipelinesCreated(),
  };
}

async function standalone(loop: (done: (n: number, e: number, r: FrameRec) => boolean) => Promise<FrameRec[]>) {
  for (;;) {
    const recs = await loop((n) => n >= 60);
    const iv = recs.slice(1).map((r, k) => r.ts - recs[k].ts);
    const gpu = recs.map((r) => wgpu?.gpuTimes.get(r.i)?.span ?? wgl?.gpuTimes.get(r.i)).filter((x): x is number => x !== undefined);
    status(`fps ${(1000 / median(iv)).toFixed(1)}  cpu ${median(recs.map((r) => r.cpu)).toFixed(2)}ms  sim ${median(recs.map((r) => r.sim)).toFixed(2)}ms  gpu ${gpu.length ? median(gpu).toFixed(2) : '-'}ms  pipelines ${pipelinesCreated()}  errors ${[...(wgpu?.errors ?? []), ...consoleErrors].length}`);
  }
}

/**
 * Raw-WebGPU clear per frame: records the browser's effective frame cap and the no-engine floor.
 * (An rAF loop that draws nothing stays vsync-paced in Chrome even with the uncap flags.)
 */
async function calibrate(marks: Record<string, number>) {
  const ts: number[] = [];
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu?.getPreferredCanvasFormat();
  if (device && ctx && format) ctx.configure({ device, format, alphaMode: 'opaque' });
  await new Promise<void>((resolve) => {
    const tick = (t: number) => {
      if (device && ctx) {
        const enc = device.createCommandEncoder();
        enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.1, 0.1, 0.1, 1] }] }).end();
        device.queue.submit([enc.finish()]);
        wgpu?.endFrame(ts.length);
      }
      ts.push(t);
      if (t - ts[0] < 3000) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const intervals = ts.slice(1).map((t, k) => t - ts[k]);
  await post('/api/result', {
    status: 'ok',
    runId: params.runId,
    session: params.session,
    params,
    ua: navigator.userAgent,
    frames: { count: intervals.length, interval: summarize(intervals) },
    probe: { adapter: adapter?.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null, timestampQuery: adapter?.features.has('timestamp-query') ?? false, features: adapter ? [...adapter.features].sort() : [] },
    timings: { scriptStartMs: marks.scriptStart },
    dpr: devicePixelRatio,
  });
  await next();
}

async function next() {
  if (params.standalone || !params.session) return;
  await releaseGpu();
  try {
    const res = await fetch(`/api/next?session=${encodeURIComponent(params.session)}&gen=${encodeURIComponent(gen)}`);
    const j = await res.json();
    if (j.url) location.replace(j.url);
    else status('session complete');
  } catch (e) {
    status(`next failed: ${e}`);
  }
}

async function fail(e: unknown) {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  status(`ERROR ${msg}`);
  await log(`ERROR ${msg}`);
  await post('/api/result', {
    // Stalls are transient (occlusion, GPU hiccup): the server retries them once.
    status: msg.startsWith('stalled:') ? 'stalled' : 'error',
    error: msg.slice(0, 2000),
    runId: params.runId,
    session: params.session,
    params,
    ua: navigator.userAgent,
    probe: params.backend === 'webgpu' ? wgpu?.report() : wgl?.report(),
    consoleErrors,
  });
  await next();
}

let failed = false;
const once = (e: unknown) => {
  if (failed) return;
  failed = true;
  fail(e);
};
window.addEventListener('error', (e) => once(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => once(e.reason));
main().catch(once);
