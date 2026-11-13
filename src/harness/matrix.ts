import type { Backend, EngineId, ScenarioId, Variant } from './types';

// Scenario registry + run matrix. Pure data: imported by both the bench page and the Node runner.

export interface ScenarioDef {
  id: ScenarioId;
  /** Key test this scenario belongs to (K7 has two scenarios). */
  key: string;
  title: string;
  levels: number[];
  levelLabel: string;
  variants: Variant[];
  backends: Backend[];
  /** Ladder per variant, where the optimized path's capacity is far above the naive one's. */
  levelsFor?: Partial<Record<Variant, number[]>>;
  /**
   * Capacity ladder: levels climb until the frame cost passes the 60 fps budget, and the report
   * interpolates the largest level that fits. Other scenarios run every level.
   */
  capacity?: boolean;
  /** Overrides of the profile's timing window (K3 needs many churn cycles). */
  run?: { measureFrames?: number; measureMs?: number; maxMeasureMs?: number };
}

const BOTH: Backend[] = ['webgpu', 'webgl2'];
const x2 = (from: number, steps: number) => Array.from({ length: steps }, (_, i) => from * 2 ** i);

export const ENGINES: EngineId[] = ['three', 'three-classic', 'playcanvas', 'babylon', 'babylon-lite', 'pixi3d'];

export const SCENARIOS: ScenarioDef[] = [
  { id: 'k1', key: 'K1', title: 'Startup: minimal lit cube', levels: [1], levelLabel: 'objects', variants: ['naive'], backends: BOTH },
  { id: 'k2', key: 'K2', title: 'Dynamic objects in a hierarchy', levels: x2(500, 8), levelsFor: { optimized: x2(4000, 7) }, levelLabel: 'meshes', variants: ['naive', 'optimized'], backends: BOTH, capacity: true },
  { id: 'k3', key: 'K3', title: 'Lifecycle churn: 1,200 spawns/s', levels: [2000], levelLabel: 'live meshes', variants: ['naive'], backends: BOTH, run: { measureFrames: 600, measureMs: 10000, maxMeasureMs: 20000 } },
  { id: 'k4', key: 'K4', title: 'Lit game frame (Sponza)', levels: [0, 1, 2, 3, 4], levelLabel: 'feature step', variants: ['naive'], backends: BOTH },
  { id: 'k5', key: 'K5', title: 'Large world, ~2k visible', levels: [20000, 100000], levelLabel: 'world meshes', variants: ['naive', 'optimized'], backends: BOTH },
  { id: 'k6', key: 'K6', title: 'Skinned characters (Fox, crossfade)', levels: x2(25, 6), levelsFor: { optimized: x2(200, 5) }, levelLabel: 'characters', variants: ['naive', 'optimized'], backends: BOTH, capacity: true },
  { id: 'k7', key: 'K7', title: 'Sorted transparency', levels: x2(500, 8), levelLabel: 'meshes', variants: ['naive'], backends: BOTH, capacity: true },
  { id: 'k7c', key: 'K7', title: 'Compute particles', levels: [1000000], levelLabel: 'particles', variants: ['naive'], backends: ['webgpu'] },
  { id: 'k8', key: 'K8', title: 'Picking', levels: [1, 10000], levelLabel: 'meshes', variants: ['naive', 'optimized'], backends: BOTH },
  { id: 'k9', key: 'K9', title: 'HUD over 3D', levels: [0, ...x2(250, 7)], levelLabel: 'nameplates', variants: ['naive'], backends: BOTH, capacity: true },
];

/** K4 feature steps, by level. */
export const K4_STEPS = ['base', '+ cascaded shadows', '+ 31 point lights', '+ bloom', '256 lights + shadows + bloom'];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

/**
 * three.js is measured as WebGPURenderer on WebGPU and the classic WebGLRenderer on WebGL2 (what
 * three.js apps ship). Babylon Lite has no WebGL2 renderer.
 */
export function engineSupports(engine: EngineId, backend: Backend) {
  if (engine === 'three-classic') return backend === 'webgl2';
  if (engine === 'three' || engine === 'babylon-lite') return backend === 'webgpu';
  return true;
}

export interface Cell {
  engine: EngineId;
  backend: Backend;
  scenario: ScenarioId;
  variant: Variant;
  level: number;
}

export const cellKey = (c: Cell) => `${c.engine}|${c.backend}|${c.scenario}|${c.variant}|${c.level}`;
/** A ladder is a cell without its level — early stop applies per ladder. */
export const ladderKey = (c: Omit<Cell, 'level'>) => `${c.engine}|${c.backend}|${c.scenario}|${c.variant}`;

export function allCells(filter?: Partial<Record<keyof Cell, string[]>>): Cell[] {
  const out: Cell[] = [];
  const ok = (k: keyof Cell, v: string | number) => !filter?.[k] || filter[k]!.includes(String(v));
  for (const s of SCENARIOS) {
    if (!ok('scenario', s.id)) continue;
    for (const variant of s.variants) {
      if (!ok('variant', variant)) continue;
      for (const level of s.levelsFor?.[variant] ?? s.levels) {
        if (!ok('level', level)) continue;
        for (const backend of s.backends) {
          if (!ok('backend', backend)) continue;
          for (const engine of ENGINES) {
            if (!ok('engine', engine) || !engineSupports(engine, backend)) continue;
            out.push({ engine, backend, scenario: s.id, variant, level });
          }
        }
      }
    }
  }
  return out;
}
