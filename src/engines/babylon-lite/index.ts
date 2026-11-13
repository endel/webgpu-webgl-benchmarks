import {
  AcesToneMapping, addToScene, createDirectionalLight, createEngine, createFreeCamera, createHemisphericLight,
  createSceneContext, disposeEngine, disposeScene, enableErrorDecoding, registerScene, renderFrame, setEngineSize, setMaxLights, VERSION,
  type EngineContext, type FreeCamera, type SceneContext, type DirectionalLight,
} from '@babylonjs/lite';
import type { CameraSpec, EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant, Vec3 } from '../../harness/types';
import { deg, srgb3 } from '../common';
import { buildField } from './field';
import { buildGltf } from './gltf';
import { buildCharacters } from './characters';
import { buildParticles } from './particles';

// Spec light units → Lite units. Its PBR is Babylon.js's: punctual lights are Lambert /π, hemispheric is not.
export const LIGHT_SCALE = Math.PI;
// three.js's ACES pre-scales by 1/0.6; Lite's is the bare fit.
const EXPOSURE = 1 / 0.6;

/** Lite's ACES fit on the CPU: the clear colour is written to the target as is (tone mapping lives in the material shaders). */
export function toneMap(c: Vec3): Vec3 {
  const [r, g, b] = c.map((v) => v * EXPOSURE);
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const x = fit(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const y = fit(0.076 * r + 0.90834 * g + 0.01566 * b);
  const z = fit(0.0284 * r + 0.13383 * g + 0.83777 * b);
  const sat = (v: number) => Math.min(1, Math.max(0, v));
  return [sat(1.60475 * x - 0.53108 * y - 0.07367 * z), sat(-0.10208 * x + 1.10813 * y - 0.00605 * z), sat(-0.00327 * x - 0.07276 * y + 1.07602 * z)];
}

export interface LiteCtx {
  engine: EngineContext;
  scene: SceneContext;
  camera: FreeCamera;
  sun: DirectionalLight | null;
}

export interface Built {
  path: string;
  notes?: string[];
  /** Runs before renderFrame(). */
  update(t: number, dt: number): void;
  /** Replaces registerScene() for paths that need another registration call. */
  register?(): Promise<void>;
  /** Runs once the scene is registered. */
  afterReady?(): void | Promise<void>;
  pick?(x: number, y: number): number | Promise<number>;
  counters?(): Record<string, number>;
  dispose?(): void;
}

export function applyCamera(camera: FreeCamera, c: CameraSpec) {
  camera.position.set(...c.position);
  camera.target.set(...c.target);
}

export function createAdapter(): EngineAdapter {
  return new LiteAdapter();
}

class LiteAdapter implements EngineAdapter {
  readonly name = 'babylon-lite';
  readonly version = VERSION;
  private ctx!: LiteCtx;
  private built!: Built;
  private data!: SceneData;

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    if (opts.backend !== 'webgpu') throw new Error('N/A: Babylon Lite has no WebGL2 renderer');
    enableErrorDecoding(); // errors are bare numeric codes otherwise
    const engine = await createEngine(canvas, { msaaSamples: opts.msaa, alphaMode: 'opaque', maxDevicePixelRatio: 1 });
    // createEngine sizes the backing store from the CSS box × DPR.
    setEngineSize(engine, opts.width, opts.height);
    this.ctx = { engine, scene: null!, camera: null!, sun: null };
    return { backend: 'webgpu', msaa: engine.msaaSamples };
  }

  async load(data: SceneData, variant: Variant, opt?: string): Promise<LoadReport> {
    this.data = data;
    // A post chain replaces the scene's default render task, which only the scene factory can leave out.
    const post = ('post' in data && !!data.post) || data.kind === 'particles';
    // The scene-wide light cap (16) is baked into every pipeline and UBO.
    const pl = 'pointLights' in data && opt === 'forward' ? data.pointLights?.count ?? 0 : 0;
    const lights = 1 + (data.sun ? 1 : 0) + pl + (data.kind === 'field' ? data.spots?.length ?? 0 : 0);
    if (lights > 16) setMaxLights(lights);
    const scene = (this.ctx.scene = createSceneContext(this.ctx.engine, { defaultRenderTask: !post }));
    const c = data.camera;
    const camera = (this.ctx.camera = createFreeCamera({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }));
    scene.camera = camera;
    applyCamera(camera, c);
    camera.fov = deg(c.fovY);
    camera.nearPlane = c.near;
    camera.farPlane = c.far;
    // The clear is written straight to the swapchain; tone mapping lives in the material shaders.
    const [r, g, b] = srgb3(toneMap(data.clearColor));
    scene.clearColor = { r, g, b, a: 1 };
    scene.imageProcessing.toneMappingEnabled = true;
    scene.imageProcessing.toneMapping = AcesToneMapping;
    scene.imageProcessing.exposure = EXPOSURE;

    // Flat ambient: a hemispheric light with the same sky and ground colour, no specular.
    const a = data.ambient;
    const ambient = createHemisphericLight([0, 1, 0], a.intensity);
    ambient.diffuseColor = ambient.groundColor = [...a.color];
    ambient.specularColor = [0, 0, 0];
    addToScene(scene, ambient);
    if (data.sun) {
      const s = data.sun;
      const sun = createDirectionalLight([...s.direction], s.intensity * LIGHT_SCALE);
      sun.diffuse = sun.specular = [...s.color];
      addToScene(scene, sun);
      this.ctx.sun = sun;
    }

    switch (data.kind) {
      case 'field':
        this.built = await buildField(this.ctx, data, variant, opt);
        break;
      case 'gltf-scene':
        this.built = await buildGltf(this.ctx, data, opt);
        break;
      case 'characters':
        this.built = await buildCharacters(this.ctx, data, variant);
        break;
      case 'particles':
        this.built = await buildParticles(this.ctx, data);
        break;
      default:
        throw new Error(`N/A: the ${data.kind} scene is not part of the key tests and is not implemented for Babylon Lite`);
    }
    await (this.built.register ? this.built.register() : registerScene(scene));
    await this.built.afterReady?.();
    return { path: this.built.path, notes: this.built.notes };
  }

  frame(t: number, dt: number) {
    if (this.data.cameraLive) applyCamera(this.ctx.camera, this.data.camera);
    this.built.update(t, dt);
    renderFrame(this.ctx.engine, dt * 1000);
  }

  counters() {
    return { drawCalls: this.ctx.engine.drawCallCount, ...this.built.counters?.() };
  }

  pick(x: number, y: number) {
    if (!this.built.pick) throw new Error('N/A: no picker for this scene');
    return this.built.pick(x, y);
  }

  async dispose() {
    this.built?.dispose?.();
    if (this.ctx.scene) disposeScene(this.ctx.scene);
    disposeEngine(this.ctx.engine);
  }
}
