import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lapState, poseTime } from './camera-path';

const path = { duration: 16, poses: 60 };
const limits = { measureFrames: 240, measureMs: 3000, maxMeasureMs: 15000 };

test('poseTime steps evenly through one lap and wraps', () => {
  assert.equal(poseTime(path, 0), 0);
  assert.equal(poseTime(path, 1), 16 / 60);
  assert.equal(poseTime(path, 59), (59 * 16) / 60);
  assert.equal(poseTime(path, 60), 0);
  assert.equal(poseTime(path, 61), poseTime(path, 1));
  assert.equal(poseTime(path, 185), poseTime(path, 5));
});

test('lapState only stops on a lap boundary', () => {
  assert.equal(lapState(59, 14000, 60, limits), 'continue', 'mid-lap under the hard limit');
  assert.equal(lapState(30, 29999, 60, limits), 'continue');
  assert.equal(lapState(240, 3000, 60, limits), 'done', 'frame and time minimums met');
  assert.equal(lapState(60, 7600, 60, limits), 'done', 'frames short, but a second lap would end past maxMeasureMs');
  assert.equal(lapState(60, 7000, 60, limits), 'continue', 'frames short with room for another lap');
  assert.equal(lapState(240, 2000, 60, limits), 'continue', 'time minimum not met');
  assert.equal(lapState(30, 30000, 60, limits), 'abort', 'mid-lap past twice maxMeasureMs');
  assert.equal(lapState(90, 31000, 60, limits), 'abort', 'a later lap past the hard limit aborts too');
});

test('lapState worked example', () => {
  assert.equal(lapState(60, 7400, 60, limits), 'continue');
  assert.equal(lapState(120, 14800, 60, limits), 'done');
  assert.equal(lapState(60, 100, 60, limits), 'continue');
  assert.equal(lapState(6000, 3000, 60, limits), 'done');
});
