import { WebGLRenderer, ACESFilmicToneMapping, SRGBColorSpace, Scene, PerspectiveCamera, REVISION } from 'three';
import type { EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant } from '../../harness/types';
import { precompile, type Built } from '../three/common';
import { buildScene } from '../three/scene';
import { webglFeatures } from './features';

// Classic WebGLRenderer: the mature WebGL2 path most three.js apps still ship. Scenario builders
// are shared with the WebGPU adapter through three's core classes.

export interface ClassicCtx {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
}

export function createAdapter(): EngineAdapter {
  return new ThreeClassicAdapter();
}

class ThreeClassicAdapter implements EngineAdapter {
  readonly name = 'three-classic';
  readonly version = `r${REVISION}`;
  private ctx!: ClassicCtx;
  private built!: Built;

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    if (opts.backend !== 'webgl2') throw new Error('three-classic only supports webgl2');
    const r = new WebGLRenderer({ canvas, antialias: opts.msaa === 4, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(1);
    r.setSize(opts.width, opts.height, false);
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.outputColorSpace = SRGBColorSpace;
    r.info.autoReset = false;
    this.ctx = { renderer: r, scene: new Scene(), camera: new PerspectiveCamera() };
    return { backend: 'webgl2', msaa: r.getContext().getContextAttributes()?.antialias ? 4 : 1 };
  }

  async load(data: SceneData, variant: Variant, opt?: string): Promise<LoadReport> {
    const ctx = this.ctx;
    const { scene, camera, renderer } = ctx;
    camera.aspect = renderer.domElement.width / renderer.domElement.height;
    this.built = await buildScene(ctx, data, variant, opt, webglFeatures(ctx));
    const compileNotes = await precompile(renderer, scene, camera);
    return { path: this.built.path, notes: [...(this.built.notes ?? []), ...compileNotes] };
  }

  frame(t: number, dt: number) {
    const { renderer, scene, camera } = this.ctx;
    renderer.info.reset();
    this.built.update(t, dt);
    if (this.built.render) this.built.render();
    else renderer.render(scene, camera);
  }

  pick(x: number, y: number) {
    return this.built.pick ? this.built.pick(x, y) : -1;
  }

  counters() {
    const i = this.ctx.renderer.info;
    return { drawCalls: i.render.calls, triangles: i.render.triangles };
  }

  async dispose() {
    this.ctx.renderer.dispose();
  }
}
