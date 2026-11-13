import * as pc from 'playcanvas';
import type { EngineAdapter, InitOptions, InitReport, LoadReport, SceneData, Variant, Vec3 } from '../../harness/types';
import { srgb3 } from '../common';
import { buildCharacters } from './characters';
import { buildField } from './field';
import { buildGltf } from './gltf';
import { buildInstances } from './instances';
import { buildParticles } from './particles';

// Spec light units → PlayCanvas units (calibrated against the other engines via screenshots).
export const LIGHT_SCALE = 1;
/** PlayCanvas' inverse-squared falloff is 16/(d²+1); spec punctual intensities assume 1/d². */
export const PUNCTUAL_SCALE = 1 / 16;
/** From PlayCanvas' shadow-cascades example: the component defaults (0.05 / 0) show acne. */
export const SHADOW_BIAS = { shadowBias: 0.3, normalOffsetBias: 0.2 };

export interface PcCtx {
  app: pc.AppBase;
  device: pc.GraphicsDevice;
  camera: pc.Entity;
}

export interface Built {
  path: string;
  notes?: string[];
  update(t: number, dt: number): void;
  pick?(x: number, y: number): number | Promise<number>;
}

/** PlayCanvas colors are gamma-space; spec colors are linear. */
export const color = (v: Vec3, scale = 1) => new pc.Color(...srgb3([v[0] * scale, v[1] * scale, v[2] * scale]));

/** Light color + intensity. PlayCanvas applies intensities below 1 in gamma space, so those are folded into the color. */
export const lightColor = (c: Vec3, k: number) => (k >= 1 ? { color: color(c), intensity: k } : { color: color(c, k), intensity: 1 });

/** Rotation taking the light's -Y axis (PlayCanvas light direction) onto the normalized `dir`. */
export function downTo(dir: Vec3) {
  const [x, y, z] = dir;
  return new pc.Quat(-z, 0, x, 1 - y).normalize();
}

/** `animations` exists on the glb container resource but is missing from the typings. */
type Container = pc.ContainerResource & { animations: pc.Asset[] };

export function loadContainer(app: pc.AppBase, url: string) {
  return new Promise<Container>((resolve, reject) =>
    app.assets.loadFromUrl(url, 'container', (err, asset) => (err ? reject(new Error(`${url}: ${err}`)) : resolve(asset!.resource as Container))),
  );
}

export function createAdapter(): EngineAdapter {
  return new PlayCanvasAdapter();
}

class PlayCanvasAdapter implements EngineAdapter {
  readonly name = 'playcanvas';
  readonly version = pc.version;
  private ctx!: PcCtx;
  private built!: Built;

  async init(canvas: HTMLCanvasElement, opts: InitOptions): Promise<InitReport> {
    const device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: [opts.backend === 'webgpu' ? pc.DEVICETYPE_WEBGPU : pc.DEVICETYPE_WEBGL2],
      antialias: opts.msaa === 4,
      alpha: false, // honoured by the device, missing from the createGraphicsDevice typings
      powerPreference: 'high-performance',
    } as any);
    device.maxPixelRatio = 1;
    const o = new pc.AppOptions();
    o.graphicsDevice = device;
    o.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem, pc.AnimComponentSystem];
    o.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler, pc.AnimClipHandler];
    o.batchManager = pc.BatchManager;
    const app = new pc.AppBase(canvas);
    app.init(o);
    app.setCanvasFillMode(pc.FILLMODE_NONE, opts.width, opts.height);
    app.setCanvasResolution(pc.RESOLUTION_FIXED, opts.width, opts.height);
    // The harness owns the frame loop: stub the scheduler before start() queues the first tick.
    (app as any).requestAnimationFrame = () => {};
    app.start();
    const camera = new pc.Entity('camera');
    camera.addComponent('camera', { toneMapping: pc.TONEMAP_ACES2, gammaCorrection: pc.GAMMA_SRGB });
    app.root.addChild(camera);
    this.ctx = { app, device, camera };
    return { backend: device.isWebGPU ? 'webgpu' : 'webgl2', msaa: (device as any).samples ?? (opts.msaa === 4 ? 4 : 1) };
  }

  async load(data: SceneData, variant: Variant, opt?: string): Promise<LoadReport> {
    const { app, camera } = this.ctx;
    const c = data.camera;
    const cam = camera.camera!;
    cam.fov = c.fovY;
    cam.nearClip = c.near;
    cam.farClip = c.far;
    cam.clearColor = new pc.Color(...srgb3(data.clearColor), 1);
    camera.setPosition(...c.position);
    camera.lookAt(...c.target);
    app.scene.ambientLight = color(data.ambient.color, data.ambient.intensity * LIGHT_SCALE);
    if (data.sun) {
      const s = data.sun;
      const sh = s.shadow;
      const sun = new pc.Entity('sun');
      sun.addComponent('light', {
        type: 'directional',
        ...lightColor(s.color, s.intensity * LIGHT_SCALE),
        castShadows: !!sh,
        ...(sh && { numCascades: sh.cascades, shadowResolution: sh.mapSize, shadowDistance: sh.maxDistance, ...SHADOW_BIAS }),
      });
      sun.setRotation(downTo(s.direction));
      app.root.addChild(sun);
    }

    switch (data.kind) {
      case 'field':
        this.built = await buildField(this.ctx, data, variant, opt);
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
        this.built = buildParticles(this.ctx, data);
        break;
    }
    return { path: this.built.path, notes: this.built.notes };
  }

  frame(t: number, dt: number) {
    const { app, device } = this.ctx;
    (device as any)._drawCallsPerFrame = 0; // normally reset by tick(), which the harness bypasses
    this.built.update(t, dt);
    app.update(dt);
    app.render();
    // PlayCanvas only logs shader compile/link failures and skips those draws: fail the run instead
    if (t === 0) {
      const bad = device.shaders.find((s) => s.failed);
      if (bad) throw new Error(`playcanvas: shader "${bad.name}" failed to compile/link, its draws were skipped (see consoleErrors)`);
    }
  }

  pick(x: number, y: number) {
    return this.built.pick!(x, y);
  }

  counters() {
    return { drawCalls: (this.ctx.device as any)._drawCallsPerFrame ?? NaN };
  }

  async dispose() {
    this.ctx.app.destroy();
  }
}
