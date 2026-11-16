import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET_MS, frameCost, gpuBusy, type FrameSummaries } from './frame-cost';

const q = (p50: number, p95: number) => ({ p50, p95 });
const at = (cpu: [number, number], gpuP95: number): FrameSummaries => ({ cpu: q(...cpu), gpu: { p95: gpuP95 } });

test('a CPU tail from waiting on the GPU is charged at most twice the median', () => {
  const tiny = frameCost({ cpu: q(0.64, 7.008), gpu: q(1.543, 1.584), gpuSum: q(1.543, 1.584) });
  assert.deepEqual([tiny.ms, tiny.raw, tiny.stallAdjusted], [1.584, 7.008, true]);
  const small = frameCost(at([1.255, 7.28], 2.632));
  assert.deepEqual([small.ms, small.stallAdjusted], [2.632, true]);
  const steady = frameCost(at([2.807, 4.626], 4.337));
  assert.deepEqual([steady.ms, steady.raw, steady.stallAdjusted], [4.626, 4.626, false]);
});

test('a 60 Hz stall in the tail cannot put a light level over the budget', () => {
  for (const cpu of [[0.64, 11], [0.64, 20], [1.26, 20]] as [number, number][]) {
    const cost = frameCost(at(cpu, 1.6));
    assert.ok(cost.ms < BUDGET_MS && cost.ms < 18, `cpu ${cpu}: ${cost.ms} ms`);
    assert.ok(cost.stallAdjusted);
  }
});

test('a level near or over the budget is charged its full p95', () => {
  const over = frameCost(at([24.925, 27.495], 3));
  assert.equal(over.ms, 27.495);
  assert.ok(over.ms > BUDGET_MS);
  assert.equal(over.stallAdjusted, false);
  assert.equal(frameCost(at([10.995, 16.485], 2)).ms, 16.485);
});

test('a stall far past the median is cut to twice the median', () => {
  const cost = frameCost(at([8.055, 67.547], 3.415));
  assert.deepEqual([cost.ms, cost.raw, cost.stallAdjusted], [16.11, 67.547, true]);
});

test('GPU busy time is the smaller of span and pass sum', () => {
  assert.equal(gpuBusy({ gpu: { p95: 10 }, gpuSum: { p95: 6 } }, 'p95'), 6);
  assert.equal(gpuBusy({ gpu: { p95: 10 } }, 'p95'), 10);
  assert.equal(gpuBusy({ gpuSum: { p95: 6 } }, 'p95'), null);
  assert.equal(gpuBusy({ gpu: { p95: 10 }, gpuSum: { p95: 6 }, gpuBusy: { p95: 4 } }, 'p95'), 4);
  assert.equal(frameCost({ cpu: q(1, 2), gpu: { p95: 10 }, gpuSum: { p95: 6 } }).gpu, 6);
});

test('the time between frames is charged in full uncapped, and past the cap slack when capped', () => {
  const frames: FrameSummaries = { cpu: q(2, 3), gpu: { p95: 4 }, interval: { p50: 33 } };
  assert.equal(frameCost(frames).ms, 33);
  assert.equal(frameCost(frames, { capped: true }).ms, 33);
  // Capped at the display rate, an 18 ms interval is the display period, not the page's cost.
  assert.equal(frameCost({ ...frames, interval: { p50: 18 } }, { capped: true }).ms, 4);
  assert.equal(frameCost({ ...frames, interval: { p50: 18 } }).ms, 18);
});

test('time spent outside the page and the GPU passes puts a level over the budget', () => {
  // Babylon Lite, K9 at 8,000 nameplates in Chrome 157 on WebGPU: about 13 ms of CPU and GPU time, a frame every 52 ms.
  const cost = frameCost({ cpu: q(10.9, 13), gpu: { p95: 12.4 }, interval: { p50: 52.1 } });
  assert.equal(cost.ms, 52.1);
  assert.ok(cost.ms > BUDGET_MS);
  assert.equal(cost.stallAdjusted, false);
});

test('an interval that matches the CPU or GPU time changes nothing', () => {
  // PlayCanvas, K2 at 8,000 meshes: frames arrive as fast as the work allows.
  assert.equal(frameCost({ cpu: q(8.6, 10.1), gpu: { p95: 6 }, interval: { p50: 9.4 } }).ms, 10.1);
});

test('missing summaries cost nothing, and a missing CPU median charges the p95 in full', () => {
  for (const frames of [null, undefined]) assert.deepEqual(frameCost(frames), { ms: 0, cpu: 0, gpu: 0, raw: 0, stallAdjusted: false });
  const cost = frameCost({ cpu: { p95: 12 } });
  assert.deepEqual([cost.ms, cost.stallAdjusted], [12, false]);
});
