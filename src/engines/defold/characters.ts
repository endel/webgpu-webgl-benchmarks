import type { Backend, CharactersScene, Variant } from '../../harness/types';
import { describeCommon, WEBGPU_NO_INSTANCING } from './field';
import type { Described } from './index';
import type { Slots } from './slots';

export function describeCharacters(d: CharactersScene, variant: Variant, slots: Slots, backend: Backend): Described {
  if (!d.url.endsWith('/Fox.glb')) throw new Error(`defold: only the Fox is bundled (${d.url})`);
  if (d.blend) throw new Error('N/A: a Defold model component plays one animation at a time: model.play_anim crossfades only during a transition (blend_duration), with no persistent per-character weight');
  slots.f32('position', d.position);
  slots.f32('yaw', d.yaw);
  slots.f32('phase', d.phase);
  // WebGPU in Defold 1.13.1 has neither instanced models nor working GPU skinning (its RGBA32F bone
  // texture is bound as filterable without float32-filterable), so the crowd skins on the CPU there
  const webgpu = backend === 'webgpu';
  return {
    json: { ...describeCommon(d, slots, backend), count: d.count, clip: d.clip, scale: d.scale, proto: webgpu ? '_cpu' : variant === 'optimized' ? '_inst' : '' },
    notes: [
      'clip time advances with the engine dt; the harness steps one frame per 1/60 s of scene time',
      ...(webgpu ? [`CPU skinning (world-space material): ${WEBGPU_NO_INSTANCING}, and its GPU skinning binds the RGBA32F bone texture as filterable, which WebGPU rejects without float32-filterable`] : []),
    ],
  };
}
