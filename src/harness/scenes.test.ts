import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poseTime } from './camera-path';
import { buildScene, CAMERA_POSES, expectedWork, type AssetManifest } from './scenes';
import type { ScenarioId, SceneData, Variant } from './types';

const assets: AssetManifest = {
  Sponza: { url: 'sponza.gltf', bounds: { min: [-20, 0, -10], max: [20, 20, 10] }, worldBounds: null, animations: [] },
  Fox: { url: 'fox.gltf', bounds: { min: [-10, 0, -30], max: [10, 80, 30] }, worldBounds: null, animations: ['Survey', 'Walk', 'Run'] },
};

const work = (id: ScenarioId, level: number) => expectedWork(id, buildScene(id, level, assets));

test('expected work matches the scene data of every all-in-view scenario', () => {
  assert.deepEqual(work('k1', 1), { objects: 1, triangles: 12 });
  assert.deepEqual(work('k2', 4000), { objects: 4000, triangles: 995836 });
  assert.deepEqual(work('k7', 4000), { objects: 4000, triangles: 1084024 });
  assert.deepEqual(work('k8', 10000), { objects: 10000, triangles: 2497644 });
  assert.deepEqual(work('k8', 1), { objects: 1, triangles: 1046528 });
  // k9 level 0 has no HUD, so the scene builds without a document.
  assert.deepEqual(work('k9', 0), { objects: 1000, triangles: 245728 });
});

test('scenarios that cull or respawn have no expected work', () => {
  assert.equal(work('k3', 2000), undefined);
  assert.equal(work('k4', 0), undefined);
  assert.equal(work('k5', 200), undefined);
});

/** Camera position and target at each pose of one lap, plus the first pose of the next. */
function lap(scene: SceneData) {
  const path = scene.cameraPath!;
  return Array.from({ length: path.poses + 1 }, (_, frame) => {
    scene.update(poseTime(path, frame));
    return { position: [...scene.camera.position], target: [...scene.camera.target] };
  });
}

for (const [id, level] of [['k4', 0], ['k5', 200]] as const) {
  test(`${id} renders ${CAMERA_POSES} distinct camera poses per lap`, () => {
    const scene = buildScene(id, level, assets);
    assert.equal(scene.cameraLive, true);
    assert.equal(scene.cameraPath?.poses, 60);
    const poses = lap(scene);
    assert.equal(new Set(poses.slice(0, 60).map((p) => JSON.stringify(p))).size, 60);
    assert.deepEqual(poses[60], poses[0]);
  });
}

test('the K4 lap reaches both ends of the nave', () => {
  const poses = lap(buildScene('k4', 0, assets));
  const len = 40;
  assert.ok(Math.abs(poses[15].position[0] - 0.35 * len) < 1e-9);
  assert.ok(Math.abs(poses[45].position[0] + 0.35 * len) < 1e-9);
});

test('the K5 lap is one full turn in 6 degree steps', () => {
  const poses = lap(buildScene('k5', 200, assets));
  for (let k = 1; k <= 60; k++) {
    const a = Math.atan2(poses[k - 1].target[2], poses[k - 1].target[0]);
    const b = Math.atan2(poses[k].target[2], poses[k].target[0]);
    const step = ((((b - a) * 180) / Math.PI + 540) % 360) - 180;
    assert.ok(Math.abs(step - 6) < 1e-9, `step ${k} is ${step} degrees`);
  }
});

test('only K4 and K5 carry a camera path', () => {
  const others: [ScenarioId, number, Variant?][] = [['k1', 1], ['k2', 500], ['k3', 2000], ['k6', 25], ['k6', 200, 'optimized'], ['k7', 500], ['k7c', 1000], ['k8', 10000], ['k9', 0]];
  for (const [id, level, variant] of others) assert.equal(buildScene(id, level, assets, variant).cameraPath, undefined, `${id}@${level}`);
  for (const level of [0, 1, 2, 3, 4]) assert.equal(buildScene('k4', level, assets).cameraPath?.poses, 60);
  for (const level of [20000, 100000]) assert.equal(buildScene('k5', level, assets).cameraPath?.poses, 60);
});
