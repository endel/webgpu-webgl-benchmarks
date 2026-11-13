import { View3D } from '@pixi/3d';
import { Application, VERSION } from 'pixi.js';
import type { EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant } from '../../harness/types';
import { setupCommon, type Built, type Ctx } from './common';
import { buildField } from './field';
import { buildGltf } from './gltf';
import { buildCharacters } from './characters';

const PIXI3D_VERSION = '0.1.0';

export function createAdapter(): EngineAdapter {
  return new Pixi3DAdapter();
}

class Pixi3DAdapter implements EngineAdapter {
  readonly name = 'pixi3d';
  readonly version = `@pixi/3d ${PIXI3D_VERSION} (pixi.js ${VERSION})`;
  private app!: Application;
  private built!: Built;
  private size = { width: 0, height: 0 };

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    const app = (this.app = new Application());
    await app.init({
      canvas,
      width: opts.width,
      height: opts.height,
      resolution: 1,
      autoDensity: false,
      antialias: opts.msaa === 4,
      preference: opts.backend === 'webgpu' ? 'webgpu' : 'webgl',
      powerPreference: 'high-performance',
      backgroundColor: 0x000000,
      backgroundAlpha: 1,
      // the harness owns the frame loop: frame() calls app.render()
      autoStart: false,
      sharedTicker: false,
    });
    this.size = { width: opts.width, height: opts.height };
    const r = app.renderer as any;
    const webgpu = r.name === 'webgpu';
    // WebGPU MSAA is pixi's fixed 4×; on WebGL2 the browser picks the canvas sample count
    const msaa = opts.msaa !== 4 ? 1 : webgpu ? 4 : (r.gl as WebGL2RenderingContext).getParameter(r.gl.SAMPLES) || 1;
    return { backend: webgpu ? 'webgpu' : 'webgl2', msaa };
  }

  async load(data: SceneData, variant: Variant): Promise<LoadReport> {
    const { app } = this;
    const view = new View3D({ width: this.size.width, height: this.size.height, toneMapping: 'aces' });
    app.stage.addChild(view);
    const ctx: Ctx = { app, view };
    const { sun } = setupCommon(view, data);
    switch (data.kind) {
      case 'field':
        this.built = await buildField(ctx, data, variant);
        break;
      case 'gltf-scene':
        this.built = await buildGltf(ctx, sun, data);
        break;
      case 'characters':
        this.built = await buildCharacters(ctx, data, variant);
        break;
      case 'particles':
        throw new Error('N/A: @pixi/3d 0.1.0 has no public compute API (its ComputeSystemGpu is @internal and only runs the GPU-culling kernel; ParticleSystem3D and ParticleContainer3D are simulated on the CPU)');
      default:
        throw new Error(`pixi3d: scene kind "${data.kind}" is not part of the key tests`);
    }
    return { path: this.built.path, notes: [...(this.built.notes ?? []), 'no precompile API: pipelines compile on first draw'] };
  }

  frame(t: number, dt: number) {
    this.built.update(t, dt);
    this.app.render();
  }

  pick(x: number, y: number) {
    if (!this.built.pick) throw new Error('N/A: scene has no pick path');
    return this.built.pick(x, y);
  }

  async dispose() {
    this.app.destroy({ removeView: false }, { children: true });
  }
}
