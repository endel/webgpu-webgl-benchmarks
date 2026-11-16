// Checks the report applies to recorded runs and aggregated cells. Pure, so they can be tested without results.

export interface ExpectedWork { objects: number; triangles: number }
export interface RenderCounters { draws?: number; triangles?: number; indirectDraws?: number }

const num = (x: number) => Math.round(x).toLocaleString('en-US');

/**
 * With every object in view, a correct frame draws at least the scene's triangles. The probe can't
 * see how many triangles an indirect draw covers, so those runs are not judged.
 */
export function renderGuard(variant: string, counters: RenderCounters | null | undefined, expected: ExpectedWork | null | undefined): { note?: string; error?: string } {
  if (!expected || !counters) return {};
  const out: { note?: string; error?: string } = {};
  if (variant === 'naive' && counters.draws != null && counters.draws < expected.objects) out.note = `batches automatically: ${num(counters.draws)} draw calls for ${num(expected.objects)} objects`;
  const tris = counters.triangles ?? 0;
  if (!((counters.indirectDraws ?? 0) > 0) && !(tris >= 0.98 * expected.triangles)) {
    out.error = `incomplete render: ${Math.round((100 * tris) / expected.triangles)}% of the expected triangles (${num(tris)} of ${num(expected.triangles)} per frame)`;
  }
  return out;
}

/** Per pick point, the id most engines returned; null where the top vote is tied or fewer than two engines voted. */
export function pickMajority(ids: number[][]): (number | null)[] {
  const points = Math.max(0, ...ids.map((x) => x.length));
  return Array.from({ length: points }, (_, i) => {
    const votes = new Map<number, number>();
    for (const x of ids) if (i < x.length) votes.set(x[i], (votes.get(x[i]) ?? 0) + 1);
    if ([...votes.values()].reduce((a, b) => a + b, 0) < 2) return null;
    const top = Math.max(...votes.values());
    const leaders = [...votes].filter(([, n]) => n === top);
    return leaders.length === 1 ? leaders[0][0] : null;
  });
}

/** How many of the points that have a majority this engine agrees with. */
export function pickAgreement(ids: number[], majority: (number | null)[]): { agree: number; of: number } {
  let agree = 0, of = 0;
  majority.forEach((m, i) => {
    if (m == null) return;
    of++;
    if (ids[i] === m) agree++;
  });
  return { agree, of };
}

/** Below this many timed frames a GPU p95 is little more than the slowest frame. */
export const MIN_GPU_FRAMES = 30;

interface FrameSampling { count?: number; gpuTimed?: number; gpu?: { n?: number } | null }
export function gpuSampling(frames: FrameSampling | null | undefined): { timed: number; frames: number; few: boolean } | null {
  if (!frames?.gpu) return null;
  const timed = frames.gpuTimed ?? frames.gpu.n ?? 0;
  return { timed, frames: frames.count ?? 0, few: timed < MIN_GPU_FRAMES };
}

interface HeapSnapshot { jsHeapUsed?: number | null; gcForced?: boolean }
/** Heap growth only means something when a collection ran right before both snapshots. */
export function heapGrowth(memory: { before?: HeapSnapshot | null; after?: HeapSnapshot | null } | null | undefined): number | null {
  const a = memory?.before, b = memory?.after;
  if (a?.gcForced !== true || b?.gcForced !== true || typeof a.jsHeapUsed !== 'number' || typeof b.jsHeapUsed !== 'number') return null;
  return b.jsHeapUsed - a.jsHeapUsed;
}

/**
 * `N/A: reason` is a feature the engine does not have. `N/A (as naive): reason` is a path the engine
 * already takes by default, so its naive result stands for the optimized one.
 */
export function notApplicable(error: unknown): { asNaive: boolean; reason: string } | null {
  const m = /^N\/A( \(as naive\))?:\s*(.*)/.exec(String(error ?? ''));
  return m ? { asNaive: !!m[1], reason: m[2] } : null;
}
