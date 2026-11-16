// Frame cost of one run: what a level charges against the 60 fps budget, shared by the runner's
// capacity stop and the report. It is the largest of CPU p95, GPU busy p95 and the median time between frames.
//
// CPU p95 is charged in full: the frame loop keeps at most one frame in flight on both backends, so the
// tail holds engine work (and its hitches), not the page waiting on a full GPU queue.
//
// Some time is in neither the page's JavaScript nor the GPU's passes, such as work the browser's GPU process
// does for the page. It shows only in the time between frames, so that is charged too: in full where the
// browser is uncapped and the interval is real throughput, and only past CAP_SLACK_MS where it is capped.

export const BUDGET_MS = 1000 / 60;
/** A capped browser's interval never drops below the display period, so there it counts only past this. */
export const CAP_SLACK_MS = 20;

type Quantiles = { p50?: number | null; p95?: number | null } | null | undefined;
export interface FrameSummaries { cpu?: Quantiles; gpu?: Quantiles; gpuSum?: Quantiles; gpuBusy?: Quantiles; interval?: Quantiles }

/**
 * GPU busy time: the union of the frame's pass intervals. Older results lack it and fall back to min(span, sum), an
 * upper bound: the span counts idle gaps between an engine's submits, the sum double-counts passes that overlap on a
 * tile-based GPU.
 */
export function gpuBusy(frames: FrameSummaries | null | undefined, q: 'p50' | 'p95'): number | null {
  const union = frames?.gpuBusy?.[q];
  if (union != null) return union;
  const span = frames?.gpu?.[q];
  if (span == null) return null;
  const sum = frames?.gpuSum?.[q];
  return sum == null ? span : Math.min(span, sum);
}

export interface FrameCost {
  /** Charged cost: max(CPU p95, GPU busy p95, interval p50; capped browsers' interval only past CAP_SLACK_MS). */
  ms: number;
  cpu: number;
  gpu: number;
}

export function frameCost(frames: FrameSummaries | null | undefined, opts?: { capped?: boolean }): FrameCost {
  const cpu = frames?.cpu?.p95 ?? 0;
  const gpu = gpuBusy(frames, 'p95') ?? 0;
  const intervalP50 = frames?.interval?.p50 ?? 0;
  const interval = !opts?.capped || intervalP50 > CAP_SLACK_MS ? intervalP50 : 0;
  return { ms: Math.max(cpu, gpu, interval), cpu, gpu };
}
