import * as THREE from 'three';
import type { Geometry, ParticlesScene, PbrSpec, PointLightsSpec, PostSpec, SceneData, SunSpec } from '../../harness/types';

// Core-only helpers (imported from 'three', not 'three/webgpu'), shared by the WebGPURenderer
// adapter and the classic WebGLRenderer adapter — both builds share three.core.js.

// Spec light units → three's physically-based units. three's Lambert term divides by π,
// PlayCanvas/Babylon don't, so punctual/ambient lights need ×π to match (calibrated via screenshots).
export const LIGHT_SCALE = Math.PI;

/** The parts of WebGLRenderer / WebGPURenderer that scene builders touch. */
export interface Ctx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: { sortObjects: boolean; shadowMap: { enabled: boolean } };
}

export interface Built {
  path: string;
  notes?: string[];
  update(t: number, dt: number): void;
  /** Override rendering (e.g. post-processing pipeline). */
  render?(): void;
  pick?(x: number, y: number): number;
}

/** Renderer-specific features; an adapter throws `N/A: …` from the ones its renderer lacks. */
export interface Features {
  /** How each feature is named in LoadReport.path. */
  label: { cascades: string; clustered: string; post: string; overlay: string };
  /** Cascaded sun shadows; may return a per-frame update. */
  cascades(sun: THREE.DirectionalLight, shadow: NonNullable<SunSpec['shadow']>): (() => void) | void;
  /** Swap in Forward+ clustered lighting. */
  clustered(): void;
  /** Builds the post chain; returns the call that replaces renderer.render. */
  post(p: PostSpec): () => void;
  /** The overlay is composited as-is, so its colours and textures must skip colour management. */
  rawOverlay: boolean;
  /** Draws a 2D scene over the 3D one, not tone-mapped; returns the call that replaces renderer.render. */
  overlay(hud: THREE.Scene, camera: THREE.Camera): () => void;
  particles(d: ParticlesScene): Promise<Built>;
}

/**
 * compileAsync, bounded: in Safari 26 it can fail to resolve for scenes with many separate meshes.
 * On timeout the remaining pipelines compile on first draw, which the harness warm-up absorbs.
 */
export async function precompile(
  renderer: { compileAsync(scene: THREE.Object3D, camera: THREE.Camera): Promise<unknown> },
  scene: THREE.Scene,
  camera: THREE.Camera,
  ms = 15000,
): Promise<string[]> {
  const done = await Promise.race([renderer.compileAsync(scene, camera).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);
  return done ? [] : [`compileAsync did not resolve within ${ms / 1000} s; remaining pipelines compiled on first draw`];
}

export const linear = (c: ArrayLike<number>) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);

export function toGeometry(g: Geometry) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function toMaterial(m: PbrSpec, map: THREE.Texture | null = null) {
  const blended = m.opacity !== undefined && m.opacity < 1;
  return new THREE.MeshStandardMaterial({
    color: linear(m.color), roughness: m.roughness, metalness: m.metalness, map,
    transparent: blended, opacity: m.opacity ?? 1, depthWrite: !blended,
  });
}

export function pointLights(scene: THREE.Scene, pl: PointLightsSpec) {
  const lights = Array.from({ length: pl.count }, (_, i) => {
    const l = new THREE.PointLight(linear(pl.color.subarray(i * 3)), pl.intensity * LIGHT_SCALE, pl.range);
    scene.add(l);
    return l;
  });
  const update = () => lights.forEach((l, i) => l.position.fromArray(pl.position, i * 3));
  update();
  return update;
}

export function applyCamera(camera: THREE.PerspectiveCamera, data: SceneData, aspect: number) {
  const c = data.camera;
  camera.fov = c.fovY;
  camera.aspect = aspect;
  camera.near = c.near;
  camera.far = c.far;
  camera.position.fromArray(c.position);
  camera.lookAt(c.target[0], c.target[1], c.target[2]);
  camera.updateProjectionMatrix();
}

/** Background, ambient and sun (without shadows — scenarios add shadow setup themselves). */
export function setupCommon(scene: THREE.Scene, camera: THREE.PerspectiveCamera, data: SceneData, aspect: number) {
  applyCamera(camera, data, aspect);
  scene.background = linear(data.clearColor);
  scene.add(new THREE.AmbientLight(linear(data.ambient.color), data.ambient.intensity * LIGHT_SCALE));
  let sun: THREE.DirectionalLight | null = null;
  if (data.sun) {
    const s = data.sun;
    sun = new THREE.DirectionalLight(linear(s.color), s.intensity * LIGHT_SCALE);
    sun.position.set(-s.direction[0] * 50, -s.direction[1] * 50, -s.direction[2] * 50);
    sun.target.position.set(0, 0, 0);
    scene.add(sun, sun.target);
  }
  return { sun };
}
