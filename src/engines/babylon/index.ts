import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Engine } from '@babylonjs/core/Engines/engine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Scene } from '@babylonjs/core/scene';
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
// Side effect: the scene's default material (used by meshes before a material is assigned).
import '@babylonjs/core/Materials/standardMaterial';
import type { CameraSpec, EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant, Vec3 } from '../../harness/types';
import { deg, srgb3 } from '../common';
import { buildHud } from './hud';
import { buildField } from './field';
import { buildInstances } from './instances';
import { buildGltf } from './gltf';
import { buildCharacters } from './characters';
import { buildParticles } from './particles';

// Spec light units → Babylon units. PBR punctual lights use Lambert /π (like three); the
// ambient term doesn't, so it stays unscaled.
export const LIGHT_SCALE = Math.PI;
// three.js's ACES pre-scales by 1/0.6; Babylon's is the bare fit.
const EXPOSURE = 1 / 0.6;

/** Babylon's ACES fit on the CPU: the clear bypasses image processing unless a post pipeline runs. */
function toneMap(c: Vec3): Vec3 {
  const [r, g, b] = c.map((v) => v * EXPOSURE);
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const x = fit(0.59719 * r + 0.35458 * g + 0.04823 * b);
  const y = fit(0.076 * r + 0.90834 * g + 0.01566 * b);
  const z = fit(0.0284 * r + 0.13383 * g + 0.83777 * b);
  const sat = (v: number) => Math.min(1, Math.max(0, v));
  return [sat(1.60475 * x - 0.53108 * y - 0.07367 * z), sat(-0.10208 * x + 1.10813 * y - 0.00605 * z), sat(-0.00327 * x - 0.07276 * y + 1.07602 * z)];
}

export interface BabylonCtx {
  engine: AbstractEngine;
  scene: Scene;
  camera: TargetCamera;
  webgpu: boolean;
  sun: DirectionalLight | null;
}

export interface Built {
  path: string;
  notes?: string[];
  /** Runs inside the engine frame, before scene.render(). */
  update(t: number, dt: number): void;
  /** Runs once the scene is ready (freezes, snapshot recording). */
  afterReady?(): void;
  /** Let scene.render() run the animation step (weighted blends resolve there). */
  animate?: boolean;
  /** `render` draws one more frame, for pickers that resolve inside the render loop. */
  pick?(x: number, y: number, render: () => void): number | Promise<number>;
}

const target = new Vector3();

export function applyCamera(camera: TargetCamera, c: CameraSpec) {
  camera.position.set(...c.position);
  camera.setTarget(target.set(...c.target));
}

/** whenReadyAsync never settles when a shader fails to compile — surface the error instead. */
function whenReady(scene: Scene) {
  return new Promise<void>((resolve, reject) => {
    for (const m of scene.materials) m.onError = (_, errors) => reject(new Error(`babylon: material "${m.name}" failed to compile: ${errors.slice(0, 600)}`));
    scene.whenReadyAsync(true).then(resolve, reject);
  });
}

export function createAdapter(): EngineAdapter {
  return new BabylonAdapter();
}

class BabylonAdapter implements EngineAdapter {
  readonly name = 'babylon';
  readonly version = Engine.Version;
  private ctx!: BabylonCtx;
  private built!: Built;
  private data!: SceneData;
  private t = 0;

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    let engine: AbstractEngine;
    const webgpu = opts.backend === 'webgpu';
    if (webgpu) {
      const e = new WebGPUEngine(canvas, {
        antialias: opts.msaa === 4,
        premultipliedAlpha: false, // opaque canvas, like the other engines
        adaptToDeviceRatio: false,
        powerPreference: 'high-performance',
        audioEngine: false,
        // Request the adapter's limits instead of the spec minimums (e.g. 16 inter-stage variables
        // can't carry 5 shadowed lights' varyings).
        setMaximumLimits: true,
        useExactSrgbConversions: true,
      } as any);
      await e.initAsync();
      engine = e;
    } else {
      engine = new Engine(canvas, opts.msaa === 4, { adaptToDeviceRatio: false, audioEngine: false, powerPreference: 'high-performance', useExactSrgbConversions: true } as any, false);
    }
    engine.setSize(opts.width, opts.height);
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new TargetCamera('camera', new Vector3(0, 0, 10), scene);
    scene.activeCamera = camera;
    this.ctx = { engine, scene, camera, webgpu, sun: null };
    const msaa = webgpu ? ((engine as any)._mainPassSampleCount ?? 4) : (engine as Engine)._gl?.getContextAttributes()?.antialias ? 4 : 1;
    return { backend: engine.isWebGPU ? 'webgpu' : 'webgl2', msaa };
  }

  async load(data: SceneData, variant: Variant, opt?: string): Promise<LoadReport> {
    const { scene, camera } = this.ctx;
    this.data = data;
    const c = data.camera;
    applyCamera(camera, c);
    camera.fov = deg(c.fovY);
    camera.minZ = c.near;
    camera.maxZ = c.far;
    // Clear color is written straight to the (sRGB) swapchain, bypassing image processing.
    scene.clearColor = new Color4(...srgb3(toneMap(data.clearColor)), 1);
    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = EXPOSURE;

    // Flat ambient (PBR: scene.ambientColor × material.ambientColor × albedo), like the other engines'
    // ambient terms — a light would take one of WebGPU's per-stage uniform-buffer slots.
    scene.ambientColor = new Color3(...data.ambient.color).scale(data.ambient.intensity);
    if (data.sun) {
      const s = data.sun;
      const sun = new DirectionalLight('sun', new Vector3(...s.direction), scene);
      sun.diffuse = sun.specular = new Color3(...s.color);
      sun.intensity = s.intensity * LIGHT_SCALE;
      sun.position = new Vector3(-s.direction[0] * 50, -s.direction[1] * 50, -s.direction[2] * 50);
      this.ctx.sun = sun;
    }

    switch (data.kind) {
      case 'field':
        this.built = buildField(this.ctx, data, variant, opt);
        break;
      case 'instances':
        this.built = buildInstances(this.ctx, data);
        break;
      case 'gltf-scene':
        this.built = await buildGltf(this.ctx, data);
        break;
      case 'characters':
        this.built = await buildCharacters(this.ctx, data, variant);
        break;
      case 'particles':
        this.built = await buildParticles(this.ctx, data);
        break;
    }
    for (const m of scene.materials) if (m instanceof PBRMaterial) m.ambientColor = Color3.White();
    if (data.kind === 'field' && data.hud) {
      const hud = await buildHud(this.ctx, data.hud);
      const { built } = this;
      this.built = { ...built, path: `${built.path}; HUD: ${hud.path}`, update: (t, dt) => (built.update(t, dt), hud.update()) };
    }
    await whenReady(scene);
    this.built.afterReady?.();
    return { path: this.built.path, notes: this.built.notes };
  }

  frame(t: number, dt: number) {
    const { engine, scene } = this.ctx;
    this.t = t;
    engine.beginFrame();
    if (this.data.cameraLive) applyCamera(this.ctx.camera, this.data.camera);
    this.built.update(t, dt);
    scene.render(true, !this.built.animate);
    engine.endFrame();
  }

  pick(x: number, y: number) {
    if (!this.built.pick) throw new Error('N/A: this path has no picker');
    return this.built.pick(x, y, () => this.frame(this.t, 0));
  }

  counters() {
    const { scene } = this.ctx;
    return { activeMeshes: scene.getActiveMeshes().length };
  }

  async dispose() {
    this.ctx.scene.dispose();
    this.ctx.engine.dispose();
  }
}
