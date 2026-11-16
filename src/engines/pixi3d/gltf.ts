import { MAX_LIGHTS, Model3D, type DirectionalLight, type Scene3DSource } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Assets } from 'pixi.js';
import type { GltfScene } from '../../harness/types';
import { aimCamera, pointLights, type Built, type Ctx } from './common';

/** A view shades up to `MAX_LIGHTS` directional, point and spot lights and ignores the rest; WebGL2 stops at 32. */
export async function buildGltf({ app, view }: Ctx, sun: DirectionalLight | null, d: GltfScene): Promise<Built> {
  const maxLights = app.renderer.name === 'webgpu' ? MAX_LIGHTS : Math.min(MAX_LIGHTS, 32);
  const wanted = (d.pointLights?.count ?? 0) + (sun ? 1 : 0);
  if (d.manyLights && wanted > maxLights) {
    throw new Error(`N/A: @pixi/3d has no clustered / many-light path past ${maxLights} lights on this backend: "a view shades up to ${maxLights} directional, point and spot lights (ambient doesn't count) and ignores the rest" (scene-and-lighting.md); this step needs ${wanted}`);
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
    path += ` + ${d.pointLights.count} PointLight (tiled light masks, up to ${maxLights})`;
    if (wanted > maxLights) notes.push(`the view shades ${maxLights} lights: the sun and ${maxLights - 1} of the ${d.pointLights.count} point lights (the last ${wanted - maxLights} added is ignored by the engine)`);
  }
  if (d.post) {
    const b = d.post.bloom;
    view.passes = [new BloomEffect({ intensity: b.strength, threshold: b.threshold, radius: b.radius })];
    path += ' + BloomEffect (@pixi/3d/extras)';
  }
  return { path, notes, update: () => updates.forEach((u) => u()) };
}
