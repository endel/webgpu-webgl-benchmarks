export interface Summary {
  n: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function summarize(values: number[]): Summary | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  let sum = 0;
  for (const x of s) sum += x;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    mean: r(sum / s.length),
    min: r(s[0]),
    max: r(s[s.length - 1]),
    p50: r(percentile(s, 0.5)),
    p95: r(percentile(s, 0.95)),
    p99: r(percentile(s, 0.99)),
  };
}

export function median(values: number[]) {
  const s = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? percentile(s, 0.5) : NaN;
}

/** Frames longer than 2× the median interval. */
export function stutterCount(intervals: number[]) {
  const m = median(intervals);
  return intervals.filter((x) => x > 2 * m).length;
}

/** Frames over the 60 fps (16.7 ms) and 30 fps (33.3 ms) budgets, and the worst one. */
export function longFrames(values: number[]) {
  let over16 = 0, over33 = 0, max = 0;
  for (const v of values) {
    if (v > 16.7) over16++;
    if (v > 33.3) over33++;
    if (v > max) max = v;
  }
  return { over16, over33, max: Math.round(max * 1000) / 1000 };
}

export const round3 = (x: number) => Math.round(x * 1000) / 1000;
