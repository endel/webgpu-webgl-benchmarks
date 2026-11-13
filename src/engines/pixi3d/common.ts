import { AmbientLight, DirectionalLight, Geometry3D, Material3D, PointLight, type View3D } from '@pixi/3d';
import type { Application, Texture } from 'pixi.js';
import type { Geometry, PbrSpec, PointLightsSpec, SceneData } from '../../harness/types';
import { srgb3 } from '../common';

// Direct lights and AmbientLight are divided by π, as in three.js ("intensities port 1:1").
export const LIGHT_SCALE = Math.PI;

export interface Ctx {
  app: Application;
  view: View3D;
}

export interface Built {
  path: string;
  notes?: string[];
  update(t: number, dt: number): void;
  pick?(x: number, y: number): number;
}

/** Spec colours are linear; every pixi colour input is display (sRGB) space. */
export const color = (c: ArrayLike<number>) => srgb3([c[0], c[1], c[2]]);

export function toGeometry(g: Geometry) {
  return new Geometry3D({ positions: g.positions, normals: g.normals, uvs: g.uvs, indices: g.indices });
}

export function toMaterial(m: PbrSpec, baseColorTexture?: Texture) {
  const blend = m.opacity !== undefined && m.opacity < 1;
  return new Material3D({
    baseColor: color(m.color),
    roughness: m.roughness,
    metallic: m.metalness,
    baseColorTexture,
    // 'blend' is sorted back to front and writes no depth
    ...(blend ? { alphaMode: 'blend' as const, alpha: m.opacity } : {}),
  });
}

export function applyCamera(view: View3D, data: SceneData) {
  const c = data.camera, cam = view.camera;
  cam.fov = c.fovY;
  cam.near = c.near;
  cam.far = c.far;
  aimCamera(view, data);
}

const _target = { x: 0, y: 0, z: 0 };
export function aimCamera(view: View3D, data: SceneData) {
  const c = data.camera;
  view.camera.position.set(c.position[0], c.position[1], c.position[2]);
  _target.x = c.target[0];
  _target.y = c.target[1];
  _target.z = c.target[2];
  view.camera.lookAt(_target);
}

/** Background, ambient and sun (without shadows — scenarios add shadow setup themselves). */
export function setupCommon(view: View3D, data: SceneData) {
  applyCamera(view, data);
  // drawn inside the 3D pass, so it is linear light under the tone curve like the scene
  view.background = color(data.clearColor);
  view.root.addChild(new AmbientLight({ color: color(data.ambient.color), intensity: data.ambient.intensity * LIGHT_SCALE }));
  let sun: DirectionalLight | null = null;
  if (data.sun) {
    const s = data.sun;
    sun = new DirectionalLight({
      color: color(s.color),
      intensity: s.intensity * LIGHT_SCALE,
      castShadow: !!s.shadow,
      shadow: s.shadow ? { cascades: Math.min(4, s.shadow.cascades) as 1 | 2 | 3 | 4, maxDistance: s.shadow.maxDistance } : undefined,
    });
    // only the rotation counts: a light shines down its local -Z
    sun.position.set(-s.direction[0] * 50, -s.direction[1] * 50, -s.direction[2] * 50);
    sun.lookAt({ x: 0, y: 0, z: 0 });
    view.root.addChild(sun);
  }
  return { sun };
}

export function pointLights(view: View3D, pl: PointLightsSpec) {
  const lights = Array.from({ length: pl.count }, (_, i) => {
    const l = new PointLight({ color: color(pl.color.subarray(i * 3, i * 3 + 3)), intensity: pl.intensity * LIGHT_SCALE, range: pl.range });
    view.root.addChild(l);
    return l;
  });
  const update = () => lights.forEach((l, i) => l.position.set(pl.position[i * 3], pl.position[i * 3 + 1], pl.position[i * 3 + 2]));
  update();
  return update;
}
