import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Bench API, mounted on both the dev and preview servers:
//   GET  /api/next?session=   → { url } of the next queued run, or { done: true }
//   POST /api/result          → append one JSON line to the session's results.jsonl
//   POST /api/screenshot?name=
//   POST /api/log
// The runner (scripts/run.ts) owns the session via globalThis.__benchSession; without one,
// results land in results/adhoc/ (manual runs via `npm run dev`).

export interface QueuedRun {
  runId: string;
  url: string;
  /** engine|backend|scenario|variant — early stop applies per ladder. */
  ladder: string;
  level: number;
  repeat: number;
  mode: string;
  tag?: string;
  /** Capacity ladder: stop climbing once a level is over the frame budget. */
  capacity?: boolean;
  /** Set on the single retry queued after a stall or watchdog timeout. */
  retryOf?: string;
}

/** Stalls and watchdog timeouts can be transient (occluded window, GPU hiccup), so they get one retry. */
const isTransient = (r: any) => r.status === 'stalled' || r.status === 'timeout';

const EARLY_STOP_MS = 100;
/** One level past the 16.7 ms budget is kept, so the report can interpolate the capacity. */
const CAPACITY_STOP_MS = 18;

/** p95 frame cost: the larger of CPU and GPU time, which is independent of vsync. */
const frameCost = (result: any) => Math.max(result.frames?.cpu?.p95 ?? 0, result.frames?.gpu?.p95 ?? 0);
const isSlow = (r: QueuedRun | undefined, result: any) =>
  Math.max(result.frames?.interval?.p50 ?? 0, result.frames?.cpu?.p50 ?? 0) > EARLY_STOP_MS || (!!r?.capacity && frameCost(result) > CAPACITY_STOP_MS);

export class BenchSession {
  next = 0;
  current: QueuedRun | null = null;
  /** Last phase the current run's page reported (see /api/progress). */
  phase = '';
  /** Bumped on every browser launch; requests carrying an older generation come from a zombie page. */
  generation = 0;
  /** Recycle the browser after this many runs (0 = never): long-lived instances accumulate memory. */
  restartEvery = 0;
  /** Set when /api/next held back a run so the runner can relaunch a fresh browser. */
  restartPending = false;
  private sinceLaunch = 0;

  nextGeneration() {
    this.sinceLaunch = 0;
    this.restartPending = false;
    return ++this.generation;
  }

  /** True when the browser is due for recycling — checked before handing out the next run. */
  dueForRestart() {
    if (!this.restartEvery || this.sinceLaunch < this.restartEvery) return false;
    this.restartPending = true;
    return true;
  }

  isCurrent(gen: string | null | undefined) {
    return String(gen) === String(this.generation);
  }
  lastActivity = Date.now();
  done = false;
  completed = 0;
  failed = 0;
  skipped = 0;
  readonly startedAt = Date.now();
  /** Too slow at this level: skip higher levels of the ladder in every repeat and mode. */
  private stopAbove = new Map<string, number>();
  /** Failed or hung at this level: skip it and everything above — failures repeat, and a hang costs a full watchdog period. */
  private stopFrom = new Map<string, number>();

  constructor(
    readonly id: string,
    readonly browser: string,
    readonly dir: string,
    readonly queue: QueuedRun[],
    readonly log: (msg: string) => void = console.log,
  ) {
    mkdirSync(join(dir, 'shots'), { recursive: true });
  }

  private isStopped(r: QueuedRun) {
    const above = this.stopAbove.get(r.ladder);
    const from = this.stopFrom.get(r.ladder);
    return (above !== undefined && r.level > above) || (from !== undefined && r.level >= from);
  }

  private lower(map: Map<string, number>, ladder: string, level: number) {
    map.set(ladder, Math.min(level, map.get(ladder) ?? Infinity));
  }

  /** Resume: runs that already have a result, and replay their early-stop effects. */
  restore(results: any[]) {
    // Queue retries for transient failures first, so recorded retry results match a queue entry below.
    for (const res of results) {
      const q = isTransient(res) && this.queue.find((x) => x.runId === res.runId);
      if (q && !q.tag && !q.retryOf) this.enqueueRetry(q);
    }
    for (const res of results) {
      // Skips are re-decided against the rebuilt stop state, so a flake no longer costs its ladder.
      if (!res.runId || res.status === 'skipped') continue;
      this.recorded.add(res.runId);
      if (res.status === 'ok') this.completed++;
      else this.failed++;
      this.applyStops(res);
    }
    return this.recorded.size;
  }

  private recorded = new Set<string>();

  private enqueueRetry(r: QueuedRun) {
    const runId = `${r.runId}r`;
    if (this.queue.some((q) => q.runId === runId)) return;
    this.queue.push({ ...r, runId, retryOf: r.runId, url: r.url.replace(/([?&]runId=)[^&]*/, `$1${runId}`) });
  }

  private applyStops(result: any) {
    const r = this.queue.find((q) => q.runId === result.runId);
    if (!r || r.tag) return;
    if (isTransient(result) && !r.retryOf) return; // its retry decides
    const broken = result.status === 'error' || isTransient(result);
    const slow = isSlow(r, result);
    if (broken) this.lower(this.stopFrom, r.ladder, r.level);
    else if (slow || result.status !== 'ok') this.lower(this.stopAbove, r.ladder, r.level);
  }

  take(): QueuedRun | null {
    this.lastActivity = Date.now();
    while (this.next < this.queue.length) {
      const r = this.queue[this.next++];
      if (this.recorded.has(r.runId)) continue;
      if (r.tag !== 'canary' && this.isStopped(r)) {
        this.skipped++;
        this.append({ status: 'skipped', runId: r.runId, session: this.id, reason: 'early-stop', ladder: r.ladder, level: r.level, repeat: r.repeat, mode: r.mode });
        continue;
      }
      this.current = r;
      this.phase = 'navigating';
      return r;
    }
    this.current = null;
    this.done = true;
    return null;
  }

  append(obj: unknown) {
    appendFileSync(join(this.dir, 'results.jsonl'), JSON.stringify(obj) + '\n');
  }

  record(result: any) {
    this.lastActivity = Date.now();
    this.sinceLaunch++;
    // The run is finished: a later watchdog relaunch must not blame it.
    if (this.current?.runId === result.runId) this.current = null;
    result.browser = this.browser;
    result.receivedAt = new Date().toISOString();
    this.append(result);
    const r = this.queue.find((q) => q.runId === result.runId);
    const bad = result.status !== 'ok';
    const slow = isSlow(r, result);
    if (bad) this.failed++;
    else this.completed++;
    this.applyStops(result);
    if (r && isTransient(result) && !r.tag && !r.retryOf) this.enqueueRetry(r);
    const f = result.frames;
    const label = r ? `${r.ladder}@${r.level} r${r.repeat} ${r.mode}` : result.runId;
    this.log(
      bad
        ? `✗ ${label}: ${String(result.error ?? result.status).split('\n')[0]}`
        : `✓ ${label}: interval ${f?.interval?.p50 ?? '-'}ms cpu ${f?.cpu?.p50 ?? '-'}ms gpu ${f?.gpu?.p50 ?? '-'}ms${slow ? ' (early stop)' : ''}`,
    );
  }

  /** Watchdog: the current run never reported. */
  timeoutCurrent(reason: string) {
    if (!this.current) return;
    const { runId, ladder, level, repeat, mode, tag } = this.current;
    this.record({ status: 'timeout', error: `${reason} (stalled at: ${this.phase || 'unknown'})`, runId, session: this.id, ladder, level, repeat, mode, tag });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __benchSession: BenchSession | undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, body: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

export function benchApi(root = process.cwd()): Plugin {
  const adhocDir = join(root, 'results', 'adhoc');
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return next();
    const session = globalThis.__benchSession;
    try {
      switch (url.pathname) {
        case '/api/next': {
          if (!session || session.id !== url.searchParams.get('session')) return json(res, { done: true });
          if (!session.isCurrent(url.searchParams.get('gen'))) {
            session.log(`  refused /api/next from stale browser generation ${url.searchParams.get('gen')}`);
            return json(res, { done: true, stale: true });
          }
          if (session.dueForRestart()) return json(res, { done: true, restart: true });
          const r = session.take();
          return json(res, r ? { url: `${r.url}&gen=${session.generation}` } : { done: true });
        }
        case '/api/result': {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          if (session && body.session === session.id && !session.isCurrent(body.gen)) {
            session.log(`  ignored late result for run ${body.runId} from stale browser generation ${body.gen}`);
          } else if (session && body.session === session.id) session.record(body);
          else {
            mkdirSync(adhocDir, { recursive: true });
            appendFileSync(join(adhocDir, 'results.jsonl'), JSON.stringify(body) + '\n');
            const f = body.frames;
            console.log(`[adhoc] ${body.status} ${body.params?.engine} ${body.params?.scenario}@${body.params?.level}: interval ${f?.interval?.p50}ms cpu ${f?.cpu?.p50}ms gpu ${f?.gpu?.p50}ms ${body.error ?? ''}`);
          }
          return json(res, { ok: true });
        }
        case '/api/screenshot': {
          const name = (url.searchParams.get('name') ?? 'shot.png').replace(/[^\w.-]/g, '_');
          const dir = session && url.searchParams.get('session') === session.id ? join(session.dir, 'shots') : join(adhocDir, 'shots');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), await readBody(req));
          return json(res, { ok: true });
        }
        case '/api/progress': {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          if (session && session.current?.runId === body.runId) session.phase = String(body.phase).split('\n')[0].slice(0, 80);
          return json(res, { ok: true });
        }
        case '/api/log': {
          const body = JSON.parse((await readBody(req)).toString('utf8'));
          (session?.log ?? console.log)(`  [${body.runId ?? 'adhoc'}] ${String(body.msg).split('\n').slice(0, 6).join('\n    ')}`);
          return json(res, { ok: true });
        }
      }
      res.statusCode = 404;
      res.end();
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  };
  return {
    name: 'bench-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
