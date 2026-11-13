// Benchmark runner: builds the app, serves it with the bench API, launches a real browser on a
// self-navigating queue of runs, and restarts the browser if a run hangs.
//
//   npm run bench -- --browser chrome --profile quick
//   npm run bench -- --browser chrome,firefox,safari --profile full
//   npm run bench -- --browser chrome --profile smoke --only "engine=three,babylon;scenario=s1"
import { build, preview } from 'vite';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BenchSession, type QueuedRun } from '../server/api';
import { allCells, ladderKey, scenarioById, type Cell } from '../src/harness/matrix';
import { toSearch } from '../src/harness/params';
import { rng } from '../src/harness/rng';
import type { RunParams } from '../src/harness/types';

const ROOT = join(import.meta.dirname, '..');

interface Profile {
  repeats: number;
  timing: boolean;
  counters: boolean;
  prime: boolean;
  canaryEvery: number;
  run: Partial<RunParams>;
}

const PROFILES: Record<string, Profile> = {
  smoke: { repeats: 1, timing: false, counters: true, prime: false, canaryEvery: 0, run: { warmupFrames: 62, warmupMs: 0, measureFrames: 30, measureMs: 0, maxMeasureMs: 6000 } },
  quick: { repeats: 1, timing: true, counters: true, prime: true, canaryEvery: 20, run: { warmupFrames: 90, warmupMs: 1500, measureFrames: 240, measureMs: 3000 } },
  full: { repeats: 3, timing: true, counters: true, prime: true, canaryEvery: 20, run: { warmupFrames: 90, warmupMs: 1500, measureFrames: 240, measureMs: 3000 } },
};

// Counters runs only need per-frame call medians, not timing precision.
const COUNTERS_RUN: Partial<RunParams> = { measureFrames: 60, measureMs: 1000 };

const CANARY: Cell = { engine: 'three', backend: 'webgpu', scenario: 'k2', variant: 'naive', level: 2000 };

const { values: args } = parseArgs({
  options: {
    browser: { type: 'string' },
    /** Continue a stopped session (folder name under results/) using its saved queue; runs after it use --browser. */
    resume: { type: 'string' },
    profile: { type: 'string', default: 'quick' },
    only: { type: 'string' },
    repeats: { type: 'string' },
    port: { type: 'string', default: '5173' },
    'no-build': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '150' },
    /** Force an optimized-path candidate on every run (adapter-specific name). */
    opt: { type: 'string' },
    /** Relaunch the browser after this many runs (0 = never); long sessions otherwise accumulate memory. */
    'restart-every': { type: 'string', default: '50' },
    /** Skip timestamp-query injection (for browsers whose implementation is unstable). */
    'no-gpu-timing': { type: 'boolean', default: false },
  },
});

function parseOnly(s?: string) {
  if (!s) return undefined;
  const f: Record<string, string[]> = {};
  for (const part of s.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) f[k.trim()] = v.split(',').map((x) => x.trim());
  }
  return f as Partial<Record<keyof Cell, string[]>>;
}

// Firefox 150 (wgpu/Metal) invalidates the device when passes carry timestampWrites, so GPU time
// is reported as unavailable there rather than destabilizing every run.
const gpuTimingFor = (browser: string) => !args['no-gpu-timing'] && browser !== 'firefox';

function buildQueue(sessionId: string, profile: Profile, cells: Cell[], gpuTiming: boolean): QueuedRun[] {
  const runs: QueuedRun[] = [];
  let n = 0;
  const add = (p: Partial<RunParams>, meta: { ladder: string; level: number; repeat: number; mode: string; tag?: string; capacity?: boolean }) => {
    const runId = String(n++).padStart(4, '0');
    // Profile timing windows apply to timing runs; counters/prime runs bring their own.
    const params = {
      ...(p.mode === 'counters' || p.tag === 'prime' ? {} : profile.run),
      ...p,
      session: sessionId,
      runId,
      opt: p.variant === 'optimized' ? args.opt : undefined,
      gpuTiming: gpuTiming ? undefined : false,
    };
    runs.push({ runId, url: `/bench.html?${toSearch(params)}`, ...meta });
  };

  add({ engine: 'none', scenario: 'cal', tag: 'calibration' }, { ladder: 'calibration', level: 0, repeat: 0, mode: 'timing', tag: 'calibration' });

  const engines = [...new Set(cells.map((c) => c.engine))];
  if (profile.prime) {
    for (const engine of engines) {
      const backend = engine === 'three-classic' ? 'webgl2' : 'webgpu';
      add({ engine, backend, scenario: 'k1', tag: 'prime', warmupFrames: 62, warmupMs: 0, measureFrames: 30, measureMs: 0 }, { ladder: `prime|${engine}`, level: 1, repeat: 0, mode: 'timing', tag: 'prime' });
    }
  }

  // Blocks share (scenario, variant, backend, level); ladders keep ascending levels for early stop.
  const blocks = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.scenario}|${c.variant}|${c.backend}|${c.level}`;
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k)!.push(c);
  }

  let sinceCanary = 0;
  const emit = (c: Cell, repeat: number, mode: 'timing' | 'counters', shuffleSeed: number) => {
    const { level, ...ladder } = c;
    const def = scenarioById(c.scenario)!;
    // K3 keeps its long window in counters mode too: memory growth needs many churn cycles.
    const window = mode === 'counters' && !def.run ? COUNTERS_RUN : profile.timing ? def.run ?? {} : {};
    add({ ...window, ...c, repeat, mode, screenshot: mode === 'counters' }, { ladder: ladderKey(ladder), level, repeat, mode, capacity: def.capacity });
    if (profile.canaryEvery && ++sinceCanary >= profile.canaryEvery) {
      sinceCanary = 0;
      add({ ...CANARY, mode: 'timing', tag: 'canary', repeat: shuffleSeed }, { ladder: ladderKey(CANARY), level: CANARY.level, repeat: 0, mode: 'timing', tag: 'canary' });
    }
  };

  const passes: ('timing' | 'counters')[] = [];
  if (profile.timing) for (let r = 0; r < profile.repeats; r++) passes.push('timing');
  if (profile.counters) passes.push('counters');
  passes.forEach((mode, pass) => {
    const repeat = mode === 'timing' ? pass : 0;
    let b = 0;
    for (const block of blocks.values()) {
      const r = rng(pass * 100003 + b++);
      const shuffled = [...block].sort(() => r.next() - 0.5);
      for (const c of shuffled) emit(c, repeat, mode, pass);
    }
  });
  return runs;
}

interface Browser {
  kill(): Promise<void>;
}

const pgrepAlive = (pattern: string) =>
  new Promise<boolean>((resolve) => execFile('pgrep', ['-f', pattern], (err) => resolve(!err)));

const PORT = Number(args.port);
const origin = `http://localhost:${PORT}`;

function launch(browser: string, url: string): Browser {
  const tmp = mkdtempSync(join(tmpdir(), `wgb-${browser}-`));
  let child: ChildProcess | null = null;
  switch (browser) {
    case 'chrome':
      child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        `--user-data-dir=${tmp}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--enable-webgpu-developer-features',
        '--enable-precise-memory-info',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--window-position=40,40',
        '--window-size=1100,720',
        url,
      ], { stdio: 'ignore' });
      break;
    case 'firefox':
      writeFileSync(join(tmp, 'user.js'), [
        ['layout.frame_rate', 0],
        ['privacy.reduceTimerPrecision', false],
        ['browser.shell.checkDefaultBrowser', false],
        ['browser.startup.homepage_override.mstone', '"ignore"'],
        ['browser.aboutwelcome.enabled', false],
        ['datareporting.policy.dataSubmissionEnabled', false],
        ['toolkit.telemetry.reportingpolicy.firstRun', false],
        ['browser.sessionstore.resume_from_crash', false],
        ['browser.tabs.warnOnClose', false],
        ['dom.max_script_run_time', 0],
        ['dom.webgpu.enabled', true],
      ].map(([k, v]) => `user_pref("${k}", ${v});`).join('\n'));
      child = spawn('/Applications/Firefox.app/Contents/MacOS/firefox', ['-profile', tmp, '-no-remote', '-new-instance', url], { stdio: 'ignore' });
      break;
    case 'safari':
      execFile('open', ['-a', 'Safari', url]);
      break;
    default:
      throw new Error(`unknown browser ${browser}`);
  }
  // Chrome/Firefox can re-exec on macOS, leaving the spawned pid stale: kill by the throwaway profile dir.
  const pattern = browser === 'chrome' ? `user-data-dir=${tmp}` : browser === 'firefox' ? `-profile ${tmp}` : null;
  return {
    async kill() {
      if (child) child.kill();
      if (pattern) {
        execFile('pkill', ['-f', pattern]);
        await sleep(1500);
        if (await pgrepAlive(pattern)) {
          execFile('pkill', ['-9', '-f', pattern]);
          await sleep(500);
        }
      }
      // Awaited: a late close would also close the tab the next launch opens.
      if (browser === 'safari') {
        await new Promise((resolve) => execFile('osascript', ['-e', `tell application "Safari" to close (every tab of every window whose URL contains "localhost:${PORT}")`], () => resolve(null)));
      }
      // The browser may still be flushing its profile; a leftover temp dir must not crash the session.
      setTimeout(() => {
        try {
          rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {}
      }, 3000);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newSession(browser: string, profileName: string) {
  const profile = { ...PROFILES[profileName] };
  if (!PROFILES[profileName]) throw new Error(`unknown profile ${profileName}`);
  if (args.repeats) profile.repeats = Number(args.repeats);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = `${stamp}-${browser}-${profileName}${PORT === 5173 ? '' : `-p${PORT}`}${args.opt ? `-${args.opt}` : ''}`;
  const dir = join(ROOT, 'results', id);
  mkdirSync(dir, { recursive: true });
  const cells = allCells(parseOnly(args.only));
  const queue = buildQueue(id, profile, cells, gpuTimingFor(browser));
  const session = new BenchSession(id, browser, dir, queue, (m) => console.log(`[${browser}] ${m}`));
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id, browser, profile: profileName, only: args.only ?? null, cells: cells.length, runs: queue.length, startedAt: new Date().toISOString() }, null, 2));
  // Timeout/watchdog records only carry a runId; the queue maps it back to a cell.
  writeFileSync(join(dir, 'queue.json'), JSON.stringify(queue, null, 1));
  console.log(`session ${id}: ${cells.length} cells, ${queue.length} runs → results/${id}`);
  return session;
}

function resumeSession(name: string) {
  const dir = join(ROOT, 'results', name);
  const meta = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  const queue: QueuedRun[] = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'));
  const session = new BenchSession(meta.id, meta.browser, dir, queue, (m) => console.log(`[${meta.browser}] ${m}`));
  const file = join(dir, 'results.jsonl');
  const prior = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const done = session.restore(prior);
  console.log(`resuming ${meta.id}: ${done} of ${queue.length} runs already recorded`);
  return session;
}

async function runSession(session: BenchSession) {
  const { id, browser } = session;
  globalThis.__benchSession = session;

  // Each launch gets a new generation: pages from a previous browser instance are refused runs and results.
  const start = () => `${origin}/index.html?session=${encodeURIComponent(id)}&gen=${session.nextGeneration()}`;
  session.restartEvery = Number(args['restart-every']);
  let handle = launch(browser, start());
  const timeoutMs = Number(args.timeout) * 1000;
  while (!session.done) {
    await sleep(1000);
    if (session.restartPending) {
      await handle.kill();
      session.lastActivity = Date.now();
      handle = launch(browser, start());
      continue;
    }
    if (Date.now() - session.lastActivity > timeoutMs) {
      console.log(`[${browser}] watchdog: run ${session.current?.runId} silent for ${args.timeout}s — restarting browser`);
      session.timeoutCurrent(`no result within ${args.timeout}s`);
      await handle.kill();
      session.lastActivity = Date.now();
      handle = launch(browser, start());
    }
  }
  await sleep(500);
  await handle.kill();
  const mins = ((Date.now() - session.startedAt) / 60000).toFixed(1);
  console.log(`[${browser}] done in ${mins} min: ${session.completed} ok, ${session.failed} failed, ${session.skipped} skipped → results/${id}`);
}

// Per-port build dir, so several runners (e.g. parallel development) never clobber each other.
const outDir = join(ROOT, PORT === 5173 ? 'dist' : `dist-${PORT}`);
if (!args['no-build']) {
  console.log('building…');
  await build({ root: ROOT, logLevel: 'warn', build: { outDir } });
}
const server = await preview({ root: ROOT, build: { outDir }, preview: { port: PORT, strictPort: true }, logLevel: 'warn' });
try {
  if (args.resume) await runSession(resumeSession(args.resume));
  const browsers = args.browser ?? (args.resume ? '' : 'chrome');
  for (const browser of browsers.split(',').filter(Boolean)) await runSession(newSession(browser.trim(), args.profile!));
} finally {
  await server.close();
}
