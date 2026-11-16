import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET_MS, frameCost, gpuBusy, type FrameSummaries } from './frame-cost';

const q = (p50: number, p95: number) => ({ p50, p95 });
const at = (cpu: [number, number], gpuP95: number): FrameSummaries => ({ cpu: q(...cpu), gpu: { p95: gpuP95 } });

test('the CPU tail is charged in full, so hitches count against the budget', () => {
  // With one frame in flight the tail is engine work: a 67 ms hitch over an 8 ms median is a level over budget.
  const hitch = frameCost(at([8.055, 67.547], 3.415));
  assert.equal(hitch.ms, 67.547);
  assert.ok(hitch.ms > BUDGET_MS);
  assert.equal(frameCost(at([24.925, 27.495], 3)).ms, 27.495);
  assert.equal(frameCost(at([10.995, 16.485], 2)).ms, 16.485);
});

test('a GPU-bound level is charged its GPU time', () => {
  assert.equal(frameCost({ cpu: q(0.64, 0.9), gpu: q(1.543, 1.584), gpuSum: q(1.543, 1.584) }).ms, 1.584);
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
});

test('an interval that matches the CPU or GPU time changes nothing', () => {
  // PlayCanvas, K2 at 8,000 meshes: frames arrive as fast as the work allows.
  assert.equal(frameCost({ cpu: q(8.6, 10.1), gpu: { p95: 6 }, interval: { p50: 9.4 } }).ms, 10.1);
});

test('missing summaries cost nothing', () => {
  for (const frames of [null, undefined]) assert.deepEqual(frameCost(frames), { ms: 0, cpu: 0, gpu: 0 });
  assert.equal(frameCost({ cpu: { p95: 12 } }).ms, 12);
});
