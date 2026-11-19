import { parseParams } from '../../harness/params';
import type { Backend, EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant } from '../../harness/types';
import { describeCharacters } from './characters';
import { describeField } from './field';
import { describeGltf } from './gltf';
import { Slots, type Emscripten } from './slots';

// Defold runs as its HTML5 bundle (scripts/build-defold.ts → public/defold): an Emscripten engine
// with its own main loop, and Lua scripts that build the scene (defold/main/*.lua).
//
// The loop schedules itself with requestAnimationFrame(MainLoop_runner). The adapter keeps that
// callback instead and runs it inside frame(), so one harness frame is exactly one engine frame:
// Lua update, render script and GL submit all land inside the harness's CPU timer.
//
// Scene data crosses through slots in the wasm heap (./slots.ts), which Lua reads through the
// bench bridge native extension (defold/bench_bridge).

const EXE = 'bench';
/**
 * One bundle per backend (the WebGPU one is built with the editor's WebGPU app manifest), and Sponza
 * (K4) in its own, since Defold downloads its whole archive at boot. init() runs before the scene is
 * known, so the bundle is picked from the run's URL.
 */
const RUN = parseParams(location.search); // the runner's URLs leave out defaults, such as backend=webgpu
const BASE = `defold${RUN.scenario === 'k4' ? '-sponza' : ''}${RUN.backend === 'webgpu' ? '-webgpu' : ''}/`;
const VERSION = '1.13.1';
const CMD_BUILD = 1;
const CMD_UPLOAD = 2;
const BOOT_MS = 30000;

declare global {
  interface Window {
    __defoldBench?: Bridge;
    CUSTOM_PARAMETERS?: Record<string, unknown>;
    EngineLoader?: { load(canvasId: string, exeName: string): void };
    Module?: Emscripten;
  }
}

/** What the bridge extension (EM_ASM) and the Lua scripts (html5.run) call back into. */
interface Bridge {
  onControl(ptr: number): void;
  describe(): string;
  signal(e: { name: string; arg: string }): void;
}

/** A scene prepared for Lua: its JSON description and the slots it reads. */
export interface Described {
  json: Record<string, unknown>;
  notes?: string[];
}

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`defold: could not load ${src} (run npm run build-defold)`));
    document.head.append(s);
  });

const nextTask = () => new Promise<void>((r) => setTimeout(r, 0));

export function createAdapter(): EngineAdapter {
  return new DefoldAdapter();
}

class DefoldAdapter implements EngineAdapter {
  readonly name = 'defold';
  readonly version = VERSION;
  private runner: (() => void) | null = null;
  private control = 0;
  private slots!: Slots;
  private described: Described | null = null;
  private events: { name: string; arg: string }[] = [];
  private backend: Backend = 'webgl2';

  private get module() {
    return window.Module!;
  }

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      if (cb.name !== 'MainLoop_runner') return raf(cb);
      this.runner = cb as () => void;
      return 0;
    };

    window.__defoldBench = {
      onControl: (ptr) => (this.control = ptr),
      describe: () => JSON.stringify({ ...this.described!.json, slots: this.slots.table() }),
      signal: (e) => this.events.push(e),
    };

    // Emscripten's WebGPU surface finds the canvas by Defold's selector, #canvas
    canvas.id = 'canvas';
    await loadScript(`${BASE}dmloader.js`);
    const P = window.CUSTOM_PARAMETERS!;
    const failed = new Promise<never>((_, reject) => {
      P.start_error = (e: unknown) => reject(new Error(`defold: start failed: ${(e as Error)?.message ?? e}`));
      P.can_not_download_file_callback = (e: unknown) => reject(new Error(`defold: download failed: ${e}`));
    });
    // The loader assumes its own page: archive at /archive, canvas #canvas, a resizable container.
    P.archive_location_filter = (path: string) => `${BASE}archive${path}`;
    P.resize_window_callback = () => {};
    P.disable_context_menu = false;
    this.module.onRuntimeInitialized = () => this.module.runApp(canvas.id);
    window.EngineLoader!.load(canvas.id, `${BASE}${EXE}`);

    await Promise.race([failed, this.until(() => this.events.some((e) => e.name === 'booted'), BOOT_MS, 'engine boot', true)]);
    // dmloader also routes every later window error to start_error; the harness reports those itself
    failed.catch(() => {});
    if (!this.control) throw new Error('defold: the bench bridge extension did not register (stale public/defold build?)');
    this.slots = new Slots(this.module);
    // getContext returns the context the engine already made, and null for the other kind
    const backend = (this.backend = canvas.getContext('webgpu') ? 'webgpu' : 'webgl2');
    return { backend, msaa: opts.msaa, notes: ['main loop driven by the harness: its requestAnimationFrame callback runs inside frame()', `bundle ${BASE}`] };
  }

  async load(data: SceneData, variant: Variant, opt?: string): Promise<LoadReport> {
    switch (data.kind) {
      case 'field':
        this.described = describeField(data, variant, this.slots, this.backend, opt);
        break;
      case 'characters':
        this.described = describeCharacters(data, variant, this.slots, this.backend);
        break;
      case 'gltf-scene': {
        const g = (this.described = await describeGltf(data, this.slots, this.backend));
        for (let i = 0; i < g.images; i++) {
          this.slots.set('upload', g.mips(i));
          this.command(CMD_UPLOAD, i);
          // main.script uploads within the frame, so no yield is needed between textures
          this.step();
          this.failOnError();
          if (!this.events.some((e) => e.name === 'uploaded' && e.arg === String(i))) throw new Error(`defold: texture ${i} was not uploaded`);
        }
        break;
      }
      case 'particles':
        throw new Error('N/A: Defold has no compute shaders on the web (compute is a technical preview for Vulkan, Metal and desktop/ES OpenGL only)');
      default:
        throw new Error(`defold: ${data.kind} scenes are not ported yet`);
    }
    this.command(CMD_BUILD, 0);
    await this.until(() => this.events.some((e) => e.name === 'built' || e.name === 'error'), 120000, 'scene build', true);
    this.failOnError();
    return {
      path: this.events.find((e) => e.name === 'built')!.arg,
      notes: ['live scene data is copied into the wasm heap every frame (counted as engine time)', ...(this.described.notes ?? [])],
    };
  }

  frame(t: number, dt: number) {
    const f64 = this.module.HEAPF64;
    f64[this.control >> 3] = t;
    f64[(this.control >> 3) + 1] = dt;
    this.slots.refresh();
    this.step();
  }

  pick(x: number, y: number) {
    return this.module._bench_pick(x, y);
  }

  async dispose() {
    this.module?.pauseMainLoop();
  }

  private command(cmd: number, arg: number) {
    const f64 = this.module.HEAPF64;
    f64[(this.control >> 3) + 3] = arg;
    f64[(this.control >> 3) + 2] = cmd;
  }

  private failOnError() {
    const err = this.events.find((e) => e.name === 'error');
    if (err) throw new Error(`defold: ${err.arg}`);
  }

  /** Runs one engine frame synchronously; the engine re-arms `runner` before it returns. */
  private step() {
    const run = this.runner;
    if (!run) throw new Error('defold: the main loop is not scheduled');
    this.runner = null;
    run();
    if (!this.runner) throw new Error('defold: the main loop stopped scheduling frames');
  }

  /** Waits for `ok`, stepping engine frames once the loop is running when `pump` is set. */
  private async until(ok: () => boolean, ms: number, what: string, pump = false) {
    const end = performance.now() + ms;
    while (!ok()) {
      if (performance.now() > end) throw new Error(`defold: ${what} timed out after ${ms / 1000} s`);
      if (pump && this.runner) this.step();
      await nextTask();
    }
  }
}
