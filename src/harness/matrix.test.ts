import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allCells, scenarioById } from './matrix';
import type { Variant } from './types';

const ladder = (id: string, variant: Variant) => {
  const s = scenarioById(id)!;
  return s.levelsFor?.[variant] ?? s.levels;
};

test('K2 and K6 ladders climb past the fastest engine', () => {
  assert.deepEqual([ladder('k2', 'naive')[0], ladder('k2', 'naive').at(-1)], [500, 256000]);
  assert.deepEqual([ladder('k2', 'optimized')[0], ladder('k2', 'optimized').at(-1)], [4000, 256000]);
  // PixiJS 3D's instanced crowd fit the budget at 3,200 in Safari.
  assert.deepEqual([ladder('k6', 'naive')[0], ladder('k6', 'naive').at(-1)], [25, 6400]);
  // Both Babylons already sat at the old 3,200 top, so a tie there hid how far ahead a baked crowd is.
  assert.deepEqual([ladder('k6', 'optimized')[0], ladder('k6', 'optimized').at(-1)], [200, 51200]);
});

test('K9 has an optimized HUD ladder without the no-HUD level', () => {
  assert.deepEqual(scenarioById('k9')!.variants, ['naive', 'optimized']);
  assert.deepEqual(ladder('k9', 'naive'), [0, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  assert.deepEqual(ladder('k9', 'optimized'), [250, 500, 1000, 2000, 4000, 8000, 16000]);
  const cells = allCells({ scenario: ['k9'], variant: ['optimized'] });
  assert.ok(cells.length > 0);
  assert.ok(cells.every((c) => c.level > 0 && c.variant === 'optimized'));
});
