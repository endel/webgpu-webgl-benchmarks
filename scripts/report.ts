// Aggregates benchmark sessions into report/out/data.json and a self-contained report/out/index.html.
//   npm run report                              → latest non-smoke session per browser
//   npm run report -- --sessions <dir>,<dir>    → explicit sessions (folder names under results/)
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { K4_STEPS, SCENARIOS } from '../src/harness/matrix';

const ROOT = join(import.meta.dirname, '..');
const RESULTS = join(ROOT, 'results');
const OUT = join(ROOT, 'report', 'out');
const BUDGET_MS = 1000 / 60;

const { values: args } = parseArgs({ options: { sessions: { type: 'string' }, 'include-smoke': { type: 'boolean', default: false } } });

interface Stat { med: number; min: number; max: number; n: number }

const med = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
function stat(xs: (number | null | undefined)[]): Stat | null {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  return { med: r3(med(v))!, min: r3(Math.min(...v))!, max: r3(Math.max(...v))!, n: v.length };
}
const get = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function browserOf(ua: string) {
  let m = ua.match(/Firefox\/([\d.]+)/);
  if (m) return { name: 'Firefox', version: m[1], impl: 'wgpu' };
  m = ua.match(/(?:Chrome)\/([\d.]+)/);
  if (m) return { name: 'Chrome', version: m[1], impl: 'Dawn' };
  m = ua.match(/Version\/([\d.]+).*Safari/);
  if (m) return { name: 'Safari', version: m[1], impl: 'WebKit' };
  return { name: 'Unknown', version: '', impl: '' };
}

// ---- pick sessions ----
function listSessions() {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS)
    .filter((d) => existsSync(join(RESULTS, d, 'session.json')))
    .map((d) => ({ dir: d, meta: JSON.parse(readFileSync(join(RESULTS, d, 'session.json'), 'utf8')) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}
let sessions = listSessions();
if (args.sessions) {
  const want = new Set(args.sessions.split(','));
  sessions = sessions.filter((s) => want.has(s.dir));
} else {
  const latest = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) {
    if (!args['include-smoke'] && s.meta.profile === 'smoke') continue;
    if (s.meta.only) continue; // partial reruns must be named explicitly
    latest.set(s.meta.browser, s);
  }
  sessions = [...latest.values()];
}
if (!sessions.length) throw new Error('no sessions found — run `npm run bench` first or pass --sessions');
console.log('sessions:', sessions.map((s) => s.dir).join(', '));

// ---- load runs ----
interface Cell {
  browser: string;
  engine: string;
  backend: string;
  scenario: string;
  variant: string;
  level: number;
  timing: any[];
  counters: any | null;
  failures: any[];
  skipped: number;
  session: string;
}
const cells = new Map<string, Cell>();
/** Browsers whose frame loop is vsync-capped (Safari): there, an interval past the cap is a real frame cost. */
const cappedBrowsers = new Set<string>();
const CAP_SLACK_MS = 20;
const browsers: any[] = [];
const engineVersions: Record<string, string> = {};

for (const s of sessions) {
  const lines = readFileSync(join(RESULTS, s.dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const byRun = new Map<string, any>();
  for (const r of lines) if (r.runId) byRun.set(r.runId, r);
  const ua = lines.find((r) => r.ua)?.ua ?? '';
  const b = browserOf(ua);
  const cal = lines.find((r) => r.params?.scenario === 'cal' && r.status === 'ok');
  if ((cal?.frames?.interval?.p50 ?? 0) > 5) cappedBrowsers.add(b.name);
  const canary = lines.filter((r) => r.params?.tag === 'canary' && r.status === 'ok').map((r) => r.frames?.cpu?.p50);
  // Spread, not max/min: one outlier shouldn't read as thermal drift.
  const cs = [...canary].sort((a, b) => a - b);
  const pct = (p: number) => cs[Math.round(p * (cs.length - 1))];
  const canarySpread = cs.length > 4 ? r3((pct(0.9) - pct(0.1)) / (2 * pct(0.5))) : null;
  // A partial rerun of a browser adds its cells, but the first (full) session describes the browser.
  const counts = {
    ok: lines.filter((r) => r.status === 'ok').length,
    invalid: lines.filter((r) => r.status === 'invalid').length,
    error: lines.filter((r) => (r.status === 'error' && !/^N\/A:/.test(String(r.error ?? ''))) || r.status === 'timeout').length,
    na: lines.filter((r) => r.status === 'error' && /^N\/A:/.test(String(r.error ?? ''))).length,
    skipped: lines.filter((r) => r.status === 'skipped').length,
  };
  const known = browsers.find((x) => x.name === b.name);
  if (known) {
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) known.counts[k] += counts[k];
    known.session += `, ${s.dir}`;
  } else browsers.push({
    ...b,
    ua,
    session: s.dir,
    profile: s.meta.profile,
    startedAt: s.meta.startedAt,
    calibration: cal ? { intervalP50: cal.frames?.interval?.p50, adapter: cal.probe?.adapter, timestampQuery: cal.probe?.timestampQuery, features: cal.probe?.features } : null,
    canary: { values: canary, spread: canarySpread },
    gpuTiming: lines.some((r) => r.params?.gpuTiming !== false && r.probe?.timestamps),
    counts,
  });
  for (const r of lines) {
    const p = r.params;
    // Skips and watchdog timeouts carry the ladder instead of params.
    if (r.status === 'skipped' || (r.status === 'timeout' && r.ladder && !r.tag)) {
      const [engine, backend, scenario, variant] = String(r.ladder).split('|');
      const k = [b.name, engine, backend, scenario, variant, r.level].join('|');
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { browser: b.name, engine, backend, scenario, variant, level: r.level, timing: [], counters: null, failures: [], skipped: 0, session: s.dir }));
      if (r.status === 'skipped') c.skipped++;
      else c.failures.push({ ...r, error: `timed out: ${r.error}` });
      continue;
    }
    if (!p || p.tag || p.scenario === 'cal') continue;
    if (r.engine?.version) engineVersions[p.engine] = r.engine.version;
    const k = [b.name, p.engine, p.backend, p.scenario, p.variant, p.level].join('|');
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { browser: b.name, engine: p.engine, backend: p.backend, scenario: p.scenario, variant: p.variant, level: p.level, timing: [], counters: null, failures: [], skipped: 0, session: s.dir }));
    if (r.status === 'ok' || r.status === 'invalid') {
      if (p.mode === 'counters') c.counters = r;
      else c.timing.push(r);
      if (r.status === 'invalid') c.failures.push(r);
    } else c.failures.push(r);
  }
}

// ---- aggregate ----
function growth(r: any, f: (m: any) => number | null) {
  const a = r?.memory?.before && f(r.memory.before), b = r?.memory?.after && f(r.memory.after);
  return typeof a === 'number' && typeof b === 'number' ? b - a : null;
}
const errText = (r: any) => String(r.error ?? r.status).split('\n')[0].slice(0, 300);
const out: any[] = [];
for (const c of cells.values()) {
  const t = c.timing.length ? c.timing : c.counters ? [c.counters] : [];
  const pick = (path: string) => stat(t.map((r) => get(r, path)));
  const na = c.failures.find((r) => /^N\/A:/.test(String(r.error ?? '')));
  const status = c.timing.some((r) => r.status === 'ok') ? 'ok' : c.timing.length ? 'invalid' : na ? 'na' : c.failures.length ? 'error' : c.skipped ? 'skipped' : c.counters ? 'ok' : 'missing';
  const ref = c.counters ?? c.timing[0];
  // GPU busy time ≤ min(span, sum): the span counts idle gaps between an engine's submits,
  // the sum double-counts passes that overlap on a tile-based GPU.
  const busy = (r: any, q: 'p50' | 'p95') => {
    const span = get(r, `frames.gpu.${q}`), sum = get(r, `frames.gpuSum.${q}`);
    return span == null ? null : sum == null ? span : Math.min(span, sum);
  };
  out.push({
    browser: c.browser,
    engine: c.engine,
    backend: c.backend,
    scenario: c.scenario,
    variant: c.variant,
    level: c.level,
    status,
    repeats: c.timing.length,
    error: c.failures[0] ? errText(c.failures[0]) : null,
    // Measured, but another run of the same cell crashed or timed out.
    // A timeout while still navigating is the previous run's wedged browser, not this cell.
    unstable: status === 'ok' && c.failures.some((r) => (r.status === 'error' || r.status === 'timeout') && !/stalled at: navigating/.test(String(r.error ?? ''))),
    interval: { p50: pick('frames.interval.p50'), p95: pick('frames.interval.p95') },
    cpu: { p50: pick('frames.cpu.p50'), p95: pick('frames.cpu.p95') },
    gpu: {
      p50: stat(t.map((r) => busy(r, 'p50'))),
      p95: stat(t.map((r) => busy(r, 'p95'))),
      spanP50: pick('frames.gpu.p50'),
      sumP50: pick('frames.gpuSum.p50'),
      passes: pick('frames.gpuPasses.p50'),
      coverage: pick('frames.gpuCoverage'),
    },
    sim: pick('frames.sim.p50'),
    stutter: pick('frames.stutter'),
    // In a capped browser a frame interval past the cap is the real cost: it also covers GPU work
    // that has no timer (WebGL2 in Safari) and presentation the pass timestamps miss.
    frameCost: stat(t.map((r) => {
      const interval = get(r, 'frames.interval.p50') ?? 0;
      return Math.max(get(r, 'frames.cpu.p95') ?? 0, busy(r, 'p95') ?? 0, cappedBrowsers.has(c.browser) && interval > CAP_SLACK_MS ? interval : 0);
    })),
    timings: {
      ttff: pick('timings.ttffMs'),
      import: pick('timings.importMs'),
      init: pick('timings.initMs'),
      load: pick('timings.loadMs'),
      firstFrame: pick('timings.firstFrameMs'),
      stableAt: pick('timings.stableAtMs'),
      warmupFrames: pick('timings.warmupFrames'),
    },
    jsHeap: pick('memory.jsHeapUsed'),
    // Pacing: frames over budget and the worst one, per run (median across repeats).
    long: {
      frames: pick('frames.count'),
      cpuOver16: pick('frames.long.cpu.over16'),
      cpuOver33: pick('frames.long.cpu.over33'),
      cpuMax: pick('frames.long.cpu.max'),
      intervalOver16: pick('frames.long.interval.over16'),
      intervalOver33: pick('frames.long.interval.over33'),
      intervalMax: pick('frames.long.interval.max'),
    },
    // Growth across the measurement window: heap from timing runs, GPU resources from the counters run.
    growth: {
      jsHeap: stat(t.map((r) => (r.memory?.after?.jsHeapUsed != null && r.memory?.before?.jsHeapUsed != null ? r.memory.after.jsHeapUsed - r.memory.before.jsHeapUsed : null))),
      gpuBytes: growth(ref, (m) => (m.gpuBufferBytes == null ? null : m.gpuBufferBytes + (m.gpuTextureBytes ?? 0))),
      glTextures: growth(ref, (m) => m.glObjects?.textures ?? null),
      glBuffers: growth(ref, (m) => m.glObjects?.buffers ?? null),
      pipelines: growth(ref, (m) => m.pipelines ?? null),
    },
    pick: ref?.pick ? { p50: pick('pick.ms.p50'), p95: pick('pick.ms.p95'), hits: ref.pick.hits, points: ref.pick.ids?.length ?? 0, ids: ref.pick.ids } : null,
    pipelinesDuringMeasure: pick('pipelinesDuringMeasure'),
    counters: c.counters?.counters ?? null,
    gpuMem: c.counters?.probe?.mem ?? ref?.probe?.mem ?? null,
    gpuTotals: c.counters?.probe?.totals ?? ref?.probe?.totals ?? null,
    canvas: ref?.probe?.canvas ?? null,
    msaa: ref?.engine?.init?.msaa ?? null,
    path: ref?.engine?.load?.path ?? null,
    notes: [...(ref?.engine?.init?.notes ?? []), ...(ref?.engine?.load?.notes ?? [])],
    warnings: (ref?.consoleWarnings ?? []).slice(0, 5),
    consoleError: (c.counters ?? c.timing[0])?.consoleErrors?.[0]?.slice(0, 240) ?? null,
    shot: `${c.session}/shots/${c.engine}_${c.backend}_${c.scenario}_${c.variant}_${c.level}.png`,
  });
}

// ---- a level skipped because a lower one was N/A is N/A for the same reason, not "over budget"
for (const c of out) {
  if (c.status !== 'skipped') continue;
  const na = out.find((o) => o.status === 'na' && o.browser === c.browser && o.engine === c.engine && o.backend === c.backend && o.scenario === c.scenario && o.variant === c.variant);
  if (na) Object.assign(c, { status: 'na', error: na.error });
}

// ---- a WebGPU run whose timestamps were on but never resolved did not finish a frame on the GPU:
// the CPU kept submitting to a device that had stopped presenting.
for (const c of out) {
  const ref = cells.get([c.browser, c.engine, c.backend, c.scenario, c.variant, c.level].join('|'))!;
  const t = ref.timing[0];
  if (c.status !== 'ok' || c.backend !== 'webgpu' || !t?.probe?.timestamps || t.frames?.gpu) continue;
  c.status = 'error';
  c.error = 'the GPU never completed a measured frame (no timestamps resolved); CPU-side numbers discarded';
  console.log(`flagged ${c.browser} ${c.engine} ${c.scenario} ${c.variant}@${c.level}: ${c.error}`);
}

// ---- render cross-check: a run can report healthy timings while drawing nothing (e.g. a shader
// that fails to compile without a GPU error). Chrome's draw counts are the reference.
const chromeDraws = new Map(out.filter((c) => c.browser === 'Chrome' && c.counters?.draws != null).map((c) => [[c.engine, c.backend, c.scenario, c.variant, c.level].join('|'), c.counters.draws]));
for (const c of out) {
  // Moving cameras: culling (and draw count) depends on how much of the path a browser covered.
  if (c.scenario === 'k4' || c.scenario === 'k5') continue;
  const ref = chromeDraws.get([c.engine, c.backend, c.scenario, c.variant, c.level].join('|'));
  if (c.browser === 'Chrome' || c.status !== 'ok' || c.counters?.draws == null || !ref || ref < 10 || c.counters.draws >= 0.5 * ref) continue;
  c.status = 'error';
  c.error = `rendered nothing: ${Math.round(c.counters.draws)} draw calls per frame vs ${Math.round(ref)} in Chrome${c.consoleError ? ` — ${c.consoleError}` : ''}`;
  console.log(`flagged ${c.browser} ${c.engine} ${c.backend} ${c.scenario} ${c.variant}@${c.level}: ${c.error}`);
}

// ---- ladders: "max N at 60 fps" from the vsync-independent frame cost (max of CPU p95, GPU p95) ----
const ladders: any[] = [];
const groups = new Map<string, any[]>();
for (const c of out) {
  const def = SCENARIOS.find((s) => s.id === c.scenario);
  if (!def?.capacity) continue;
  const k = [c.browser, c.engine, c.backend, c.scenario, c.variant].join('|');
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(c);
}
for (const [k, list] of groups) {
  const [browser, engine, backend, scenario, variant] = k.split('|');
  // Level 0 is K9's no-HUD baseline, not a point on the ladder.
  const pts = list.filter((c) => c.status === 'ok' && c.frameCost && c.level > 0).map((c) => ({ level: c.level, cost: c.frameCost.med })).sort((a, b) => a.level - b.level);
  let maxAt60: number | null = null, bound: 'below' | 'within' | 'beyond' | null = null;
  if (pts.length) {
    if (pts[0].cost > BUDGET_MS) bound = 'below';
    else {
      const i = pts.findIndex((p) => p.cost > BUDGET_MS);
      if (i < 0) {
        bound = 'beyond';
        maxAt60 = pts[pts.length - 1].level;
      } else {
        bound = 'within';
        const a = pts[i - 1], b = pts[i];
        // log-log interpolation between the bracketing levels
        const f = (Math.log(BUDGET_MS) - Math.log(a.cost)) / (Math.log(b.cost) - Math.log(a.cost));
        maxAt60 = Math.round(Math.exp(Math.log(a.level) + f * (Math.log(b.level) - Math.log(a.level))));
      }
    }
  }
  ladders.push({ browser, engine, backend, scenario, variant, points: pts, maxAt60, bound });
}

// ---- gallery thumbnails (JPEG via macOS sips, embedded as data URIs) ----
const GALLERY_LEVEL: Record<string, number> = { k2: 1000, k4: 3, k5: 20000, k6: 100, k7: 1000, k8: 10000, k9: 1000 };
const gallery: any[] = [];
const tmp = join(tmpdir(), 'wgb-thumbs');
mkdirSync(tmp, { recursive: true });
for (const c of out) {
  const def = SCENARIOS.find((s) => s.id === c.scenario)!;
  const level = GALLERY_LEVEL[c.scenario] ?? def.levels[0];
  // Only what the gallery shows: Chrome, the scenario's first path, WebGPU (WebGL2 for the classic three.js renderer).
  if (c.level !== level || c.browser !== 'Chrome' || c.backend !== (c.engine === 'three-classic' ? 'webgl2' : 'webgpu') || c.variant !== def.variants[0]) continue;
  const src = join(RESULTS, c.shot);
  if (!existsSync(src) || !statSync(src).size) continue;
  const dst = join(tmp, c.shot.replace(/[\/]/g, '_').replace(/\.png$/, '.jpg'));
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '-Z', '640', src, '--out', dst], { stdio: 'ignore' });
    gallery.push({ engine: c.engine, backend: c.backend, scenario: c.scenario, variant: c.variant, level, img: `data:image/jpeg;base64,${readFileSync(dst).toString('base64')}` });
  } catch {}
}

const bundlePath = join(RESULTS, 'bundle-size.json');
const findingsPath = join(ROOT, 'report', 'findings.json');
const data = {
  findings: existsSync(findingsPath) ? JSON.parse(readFileSync(findingsPath, 'utf8')) : [],
  generatedAt: new Date().toISOString(),
  budgetMs: BUDGET_MS,
  machine: browsers.find((b) => b.calibration?.adapter)?.calibration?.adapter ?? null,
  browsers,
  engines: engineVersions,
  scenarios: SCENARIOS,
  k4Steps: K4_STEPS,
  cells: out.map(({ shot, ...rest }) => rest),
  ladders,
  bundle: existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : null,
  gallery,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'data.json'), JSON.stringify(data));
const template = join(ROOT, 'report', 'template.html');
if (existsSync(template)) {
  // report.html is the bare page body (the artifact); index.html is a full document for local
  // viewing and GitHub Pages — with implicit <head>/<body>, the parser puts the template's
  // leading <title>, <meta>, <link> and <style> in the head.
  const html = readFileSync(template, 'utf8').replace('/*__DATA__*/null', () => JSON.stringify(data).replace(/</g, '\\u003c'));
  writeFileSync(join(OUT, 'report.html'), html);
  writeFileSync(join(OUT, 'index.html'), `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${html}\n</html>\n`);
  console.log(`wrote report/out/report.html + index.html (${(html.length / 1e6).toFixed(2)} MB)`);
}
console.log(`cells ${out.length}, ladders ${ladders.length}, gallery ${gallery.length}`);
