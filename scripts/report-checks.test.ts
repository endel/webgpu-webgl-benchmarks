import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gpuSampling, heapGrowth, notApplicable, pickAgreement, pickMajority, renderGuard } from './report-checks';

const K2 = { objects: 4000, triangles: 995836 };

test('render guard passes a frame that draws every expected triangle', () => {
  assert.deepEqual(renderGuard('naive', { draws: 4000, triangles: 995836 }, K2), {});
  assert.deepEqual(renderGuard('naive', { draws: 4000, triangles: 995848 }, K2), {});
});

test('render guard fails a frame under 98% of the expected triangles', () => {
  const r = renderGuard('naive', { draws: 4000, triangles: 900000 }, K2);
  assert.match(r.error ?? '', /incomplete render: 90%/);
  assert.match(r.error ?? '', /900,000 of 995,836 per frame/);
  assert.equal(r.note, undefined);
});

test('render guard counts a missing triangle counter as nothing drawn', () => {
  assert.match(renderGuard('naive', { draws: 103 }, K2).error ?? '', /incomplete render: 0%/);
});

test('render guard notes automatic batching and skips indirect draws', () => {
  const r = renderGuard('naive', { draws: 130, triangles: 13, indirectDraws: 128 }, K2);
  assert.equal(r.note, 'batches automatically: 130 draw calls for 4,000 objects');
  assert.equal(r.error, undefined);
});

test('render guard notes batching on the naive path only', () => {
  assert.deepEqual(renderGuard('optimized', { draws: 16, triangles: 995836 }, K2), {});
});

test('render guard needs an expected workload and counters', () => {
  assert.deepEqual(renderGuard('naive', { draws: 1, triangles: 0 }, null), {});
  assert.deepEqual(renderGuard('naive', null, K2), {});
});

test('pick majority takes the most common id per point', () => {
  const a = [1250, -1, 149], b = [2139, 5648, 1245];
  const majority = pickMajority([a, a, a, b, b]);
  assert.deepEqual(majority, [1250, -1, 149]);
  assert.deepEqual(pickAgreement(a, majority), { agree: 3, of: 3 });
  assert.deepEqual(pickAgreement(b, majority), { agree: 0, of: 3 });
});

test('pick majority leaves a tied point out of the comparison', () => {
  const a = [7, 8], b = [7, 9];
  const majority = pickMajority([a, b]);
  assert.deepEqual(majority, [7, null]);
  assert.deepEqual(pickAgreement(a, majority), { agree: 1, of: 1 });
  assert.deepEqual(pickAgreement(b, majority), { agree: 1, of: 1 });
});

test('pick majority needs at least two voters', () => {
  const majority = pickMajority([[1, 2, 3]]);
  assert.deepEqual(majority, [null, null, null]);
  assert.deepEqual(pickAgreement([1, 2, 3], majority), { agree: 0, of: 0 });
});

test('pick agreement counts the points an engine differs on', () => {
  const ref = Array.from({ length: 64 }, (_, i) => i * 3);
  const differs = new Set([3, 11, 19, 27, 35, 43, 51]);
  const odd = ref.map((id, i) => (differs.has(i) ? -1 : id));
  const majority = pickMajority([ref, ref, odd]);
  assert.deepEqual(pickAgreement(ref, majority), { agree: 64, of: 64 });
  assert.deepEqual(pickAgreement(odd, majority), { agree: 57, of: 64 });
});

test('gpu sampling flags figures from few timed frames', () => {
  const summary = { n: 8, mean: 1, min: 1, max: 1, p50: 1, p95: 1, p99: 1 };
  assert.deepEqual(gpuSampling({ count: 3472, gpuTimed: 8, gpu: summary }), { timed: 8, frames: 3472, few: true });
  assert.deepEqual(gpuSampling({ count: 240, gpu: { ...summary, n: 240 } }), { timed: 240, frames: 240, few: false });
  assert.equal(gpuSampling({ count: 240, gpu: null }), null);
});

test('heap growth needs a forced collection before both snapshots', () => {
  assert.equal(heapGrowth({ before: { jsHeapUsed: 100, gcForced: true }, after: { jsHeapUsed: 160, gcForced: true } }), 60);
  assert.equal(heapGrowth({ before: { jsHeapUsed: 100, gcForced: false }, after: { jsHeapUsed: 160, gcForced: true } }), null);
  assert.equal(heapGrowth({ before: { jsHeapUsed: 100 }, after: { jsHeapUsed: 160 } }), null);
  assert.equal(heapGrowth({ before: { jsHeapUsed: null, gcForced: true }, after: { jsHeapUsed: 160, gcForced: true } }), null);
  assert.equal(heapGrowth(undefined), null);
});

test('a missing feature and a default path that already applies the optimization are told apart', () => {
  assert.deepEqual(notApplicable('N/A: no accelerated picker'), { asNaive: false, reason: 'no accelerated picker' });
  assert.deepEqual(notApplicable('N/A (as naive): the HUD is already batched'), { asNaive: true, reason: 'the HUD is already batched' });
  assert.equal(notApplicable('TypeError: x is not a function'), null);
  assert.equal(notApplicable(undefined), null);
});
