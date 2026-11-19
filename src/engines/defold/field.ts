import { HEIGHT, WIDTH } from '../../harness/scenes';
import type { Backend, FieldScene, SceneData, Variant } from '../../harness/types';
import { srgb3 } from '../common';
import { describeHud } from './hud';
import type { Described } from './index';
import { boxMips, mipBytes } from './mips';
import type { Slots } from './slots';

/** Clear colour, lights and camera every scene kind shares. Spec light units are used 1:1 (see pbr.glsl). */
/** Defold 1.13.1's WebGPU backend asserts on instanced models ("Unable to deduce type from dmGraphics::Type"). */
export const WEBGPU_NO_INSTANCING = "Defold 1.13.1's WebGPU backend cannot draw instanced models: it aborts on the per-instance world matrix";

export function describeCommon(d: SceneData, slots: Slots, backend: Backend) {
  const ambient = d.ambient.color.map((c) => c * d.ambient.intensity);
  if (d.cameraLive) {
    const cam = new Float32Array(6);
    slots.f32('camera', () => (cam.set(d.camera.position), cam.set(d.camera.target, 3), cam), { live: true, count: 6 });
  }
  return {
    kind: d.kind,
    backend,
    width: WIDTH,
    height: HEIGHT,
    camera: d.camera,
    cameraLive: !!d.cameraLive,
    clear: srgb3(d.clearColor),
    clearLinear: d.clearColor,
    ambient,
    sun: d.sun ? { direction: d.sun.direction, color: d.sun.color.map((c) => c * d.sun!.intensity) } : null,
  };
}

/** K3's per-frame texture with its mip chain, rebuilt whenever this frame respawns. */
function mipChain(c: NonNullable<FieldScene['churn']>) {
  const size = c.texture.size;
  const out = new Uint8Array(mipBytes(size, size));
  return () => {
    if (!c.n) return out;
    out.set(c.texture.pixels);
    return boxMips(out, size, size);
  };
}

/**
 * Optimized field paths. Instancing with colour and PBR as per-component constants batches per
 * (geometry, material); as per-instance attributes it creates and deletes a GL buffer per instance
 * every frame past ~4k instances in Defold 1.13.1, so constants is the default.
 */
const INSTANCED: Record<string, string> = { constants: '_instc', attributes: '_inst' };

export function describeField(d: FieldScene, variant: Variant, slots: Slots, backend: Backend, opt?: string): Described {
  const unported = (['pointLights', 'spots', 'post', 'ground'] as const).filter((k) => d[k]);
  if (unported.length || d.shadows) throw new Error(`defold: field scenes with ${unported.join(', ') || 'shadows'} are not ported`);
  if (d.pick && d.count === 1) throw new Error('N/A: Defold picks through physics ray casts, and its collision shapes are box, sphere, capsule and convex hull only: no triangle mesh');
  if (d.pick && variant === 'optimized') throw new Error('N/A (as naive): Defold has one picking path, physics ray casts');


  const blend = d.materials.some((m) => (m.opacity ?? 1) < 1);
  if (opt && !INSTANCED[opt]) throw new Error(`defold: unknown optimized path ${opt} (${Object.keys(INSTANCED).join(', ')})`);
  const instanced = !d.pick && !blend && variant === 'optimized' && !d.hud;
  if (instanced && backend === 'webgpu') throw new Error(`N/A (as naive): ${WEBGPU_NO_INSTANCING}`);
  const proto = d.pick ? '_pick' : blend ? '_blend' : instanced ? INSTANCED[opt ?? 'constants'] : '';
  const churn = !!d.churn;
  slots.f32('position', d.position, { live: churn });
  slots.f32('scale', d.scale, { live: churn });
  slots.f32('geom', d.geom, { live: churn });
  slots.f32('material', d.material, { live: churn });
  slots.f32('quat', d.quat, { live: d.animated || churn });
  if (d.groups) {
    slots.f32('parent', d.groups.parent);
    slots.f32('groupPosition', d.groups.position);
    slots.f32('groupQuat', d.groups.quat, { live: d.animated });
  }
  if (d.churn) {
    const c = d.churn;
    const info = new Float32Array(2);
    slots.f32('churnSlots', c.slots, { live: true });
    slots.f32('churn', () => ((info[0] = c.n), (info[1] = c.batch), info), { live: true, count: 2 });
    slots.u8('texture', mipChain(c), { live: true, count: mipBytes(c.texture.size, c.texture.size) });
  }

  return {
    json: {
      ...describeCommon(d, slots, backend),
      count: d.count,
      geometries: d.geometries.map((g) => g.name),
      materials: d.materials.map((m) => ({ color: m.color, opacity: m.opacity ?? 1, roughness: m.roughness, metalness: m.metalness })),
      groups: d.groups?.count ?? 0,
      animated: d.animated,
      proto,
      blend,
      churn: d.churn ? { size: d.churn.texture.size } : null,
      pick: !!d.pick,
      hud: d.hud ? describeHud(d.hud, variant, slots) : null,
    },
  };
}
