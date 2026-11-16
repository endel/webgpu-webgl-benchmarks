import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BenchSession, type QueuedRun } from './api';

const sessionRoot = mkdtempSync(join(tmpdir(), 'bench-session-'));
after(() => rmSync(sessionRoot, { recursive: true, force: true }));

const queued = (runId: string, ladder: string, more: Partial<QueuedRun> = {}): QueuedRun => ({ runId, url: `/bench.html?runId=${runId}&engine=x`, ladder, level: 1, repeat: 0, mode: 'timing', ...more });
const newSession = (queue: QueuedRun[]) => new BenchSession('test', 'chrome', mkdtempSync(join(sessionRoot, 's')), queue, () => {});
const ids = (runs: QueuedRun[]) => runs.map((r) => r.runId);

/** One browser launch: take and record runs until the session wants a relaunch or ends; `hang` times out like the watchdog in `phase`. */
function launch(session: BenchSession, hang?: string, phase = 'measuring…') {
  session.nextGeneration();
  const served: QueuedRun[] = [];
  while (!session.dueForRestart()) {
    const r = session.take();
    if (!r) break;
    served.push(r);
    if (r.runId === hang) {
      session.phase = phase;
      session.timeoutCurrent('hung');
      break;
    }
    session.record({ status: 'ok', runId: r.runId });
  }
  return served;
}

test('every browser launch serves the prime runs before the next queued run', () => {
  const session = newSession([
    queued('0000', 'calibration', { tag: 'calibration' }),
    queued('0001', 'prime|three', { tag: 'prime' }),
    queued('0002', 'prime|babylon', { tag: 'prime' }),
    queued('0003', 'three|webgpu|k1|naive'),
    queued('0004', 'babylon|webgpu|k1|naive'),
    queued('0005', 'three|webgpu|k2|naive'),
  ]);
  session.restartEvery = 2;
  const first = launch(session);
  assert.deepEqual(ids(first), ['0001g1', '0002g1', '0000', '0003'], 'Primes do not count towards --restart-every');
  assert.equal(first[0].url, '/bench.html?runId=0001g1&engine=x');
  assert.deepEqual(ids(launch(session, '0004')), ['0001g2', '0002g2', '0004'], 'Periodic restart');
  assert.deepEqual(ids(launch(session)), ['0001g3', '0002g3', '0005', '0004r'], 'Watchdog restart');
});

test('a resumed session continues the generation count and drops a prime that hangs', () => {
  const session = newSession([
    queued('0001', 'prime|three', { tag: 'prime' }),
    queued('0002', 'prime|babylon', { tag: 'prime' }),
    queued('0003', 'three|webgpu|k1|naive'),
    queued('0004', 'babylon|webgpu|k1|naive'),
  ]);
  session.restore([{ status: 'ok', runId: '0001g3', gen: '3' }, { status: 'ok', runId: '0003', gen: '3' }]);
  assert.deepEqual(ids(launch(session, '0002g4')), ['0001g4', '0002g4']);
  assert.deepEqual(ids(launch(session)), ['0001g5', '0004']);
});

test('a prime whose page never loaded stays in the replay', () => {
  const session = newSession([queued('0001', 'prime|three', { tag: 'prime' }), queued('0002', 'three|webgpu|k1|naive')]);
  assert.deepEqual(ids(launch(session, '0001g1', 'navigating')), ['0001g1']);
  assert.deepEqual(ids(launch(session)), ['0001g2', '0002']);
});

test('a prime whose page never loads on two launches in a row is dropped', () => {
  const session = newSession([queued('0001', 'prime|three', { tag: 'prime' }), queued('0002', 'three|webgpu|k1|naive')]);
  assert.deepEqual(ids(launch(session, '0001g1', 'navigating')), ['0001g1']);
  assert.deepEqual(ids(launch(session, '0001g2', 'navigating')), ['0001g2']);
  assert.deepEqual(ids(launch(session)), ['0002']);
});

test('the browser is not relaunched once no queued run is left to serve', () => {
  const session = newSession([
    queued('0001', 'prime|three', { tag: 'prime' }),
    queued('0002', 'three|webgpu|k3|naive'),
    ...[8000, 16000].map((level, i) => queued(`001${i}`, 'three|webgpu|k2|naive', { level, capacity: true })),
  ]);
  session.restartEvery = 1;
  assert.deepEqual(ids(launch(session)), ['0001g1', '0002']);
  session.nextGeneration();
  assert.equal(session.take()?.runId, '0001g2');
  session.record({ status: 'ok', runId: '0001g2' });
  assert.equal(session.take()?.runId, '0010');
  session.record({ status: 'ok', runId: '0010', frames: { cpu: { p50: 24.9, p95: 27.5 }, interval: { p50: 25 } } });
  assert.equal(session.dueForRestart(), false, 'the rest of the ladder is past its capacity stop');
  assert.equal(session.take(), null);
  assert.ok(session.done);
});

test('a capacity ladder stops one level past the budget, on the frame cost the report charges', () => {
  const session = newSession([8000, 16000, 32000].map((level, i) => queued(`000${i}`, 'three|webgpu|k2|naive', { level, capacity: true })));
  session.nextGeneration();
  assert.equal(session.take()?.level, 8000);
  session.record({ status: 'ok', runId: '0000', frames: { cpu: { p50: 6.4, p95: 9 }, gpu: { p50: 1.5, p95: 1.6 }, interval: { p50: 7 } } });
  assert.equal(session.take()?.level, 16000);
  session.record({ status: 'ok', runId: '0001', frames: { cpu: { p50: 24.9, p95: 27.5 }, interval: { p50: 25 } } });
  assert.equal(session.take(), null);
  const lines = readFileSync(join(session.dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.status === 'skipped').map((l) => l.level), [32000]);
});

test('a ladder without a capacity stop is not stopped by a frame over the budget', () => {
  const session = newSession([2000, 4000].map((level, i) => queued(`000${i}`, 'three|webgpu|k3|naive', { level })));
  session.nextGeneration();
  session.take();
  session.record({ status: 'ok', runId: '0000', frames: { cpu: { p50: 24.9, p95: 27.5 }, interval: { p50: 25 } } });
  assert.equal(session.take()?.level, 4000);
});
