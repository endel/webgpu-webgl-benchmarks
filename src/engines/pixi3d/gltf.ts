import { Model3D, type DirectionalLight, type Scene3DSource } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Assets } from 'pixi.js';
import type { GltfScene } from '../../harness/types';
import { aimCamera, pointLights, type Built, type Ctx } from './common';

/** Documented: a view shades up to 32 directional, point and spot lights and ignores the rest. */
const MAX_LIGHTS = 32;

export async function buildGltf({ view }: Ctx, sun: DirectionalLight | null, d: GltfScene): Promise<Built> {
  if (d.manyLights) {
    throw new Error(`N/A: @pixi/3d 0.1.0 has no clustered / many-light path: "a view shades up to ${MAX_LIGHTS} directional, point and spot lights (ambient doesn't count) and ignores the rest" (scene-and-lighting.md); this step needs ${(d.pointLights?.count ?? 0) + 1}`);
  }
  const notes: string[] = [];
  let path = 'Assets.load glTF → Model3D';
  if (d.sun?.shadow) {
    // map size is a view setting ('high' = 2048), not a light one
    view.shadowQuality = d.sun.shadow.mapSize >= 4096 ? 'ultra' : d.sun.shadow.mapSize >= 2048 ? 'high' : 'medium';
    path += ` + ${d.sun.shadow.cascades} shadow cascades (shadowQuality '${view.shadowQuality}', pcf)`;
  }
  const source = await Assets.load<Scene3DSource>(d.url);
  view.root.addChild(new Model3D({ source, castShadow: !!d.sun?.shadow, receiveShadow: !!d.sun?.shadow }));

  const updates = [() => aimCamera(view, d)];
  if (d.pointLights) {
    updates.push(pointLights(view, d.pointLights));
    path += ` + ${d.pointLights.count} PointLight`;
    const total = d.pointLights.count + (sun ? 1 : 0);
    if (total > MAX_LIGHTS) notes.push(`the view shades ${MAX_LIGHTS} lights: the sun and ${MAX_LIGHTS - 1} of the ${d.pointLights.count} point lights (the last ${total - MAX_LIGHTS} added is ignored by the engine)`);
  }
  if (d.post) {
    const b = d.post.bloom;
    view.passes = [new BloomEffect({ intensity: b.strength, threshold: b.threshold, radius: b.radius })];
    path += ' + BloomEffect (@pixi/3d/extras)';
  }
  return { path, notes, update: () => updates.forEach((u) => u()) };
}
