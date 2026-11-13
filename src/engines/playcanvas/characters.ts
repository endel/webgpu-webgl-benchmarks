import * as pc from 'playcanvas';
import type { CharactersScene, Variant } from '../../harness/types';
import { loadContainer, type Built, type PcCtx } from './index';

// 1D blend tree over two clips; unsynced, so each clip keeps its own duration.
const blendGraph = {
  layers: [{
    name: 'base',
    states: [
      { name: 'START' },
      {
        name: 'move', speed: 1, loop: true,
        blendTree: { type: pc.ANIM_BLEND_1D, parameter: 'w', syncAnimations: false, children: [{ name: 'a', point: 0 }, { name: 'b', point: 1 }] },
      },
    ],
    transitions: [{ from: 'START', to: 'move' }],
  }],
  parameters: { w: { name: 'w', type: pc.ANIM_PARAMETER_FLOAT, value: 0 } },
};

export async function buildCharacters({ app }: PcCtx, d: CharactersScene, variant: Variant): Promise<Built> {
  if (variant === 'optimized') throw new Error('N/A: PlayCanvas has no instanced or baked (vertex-animation-texture) skinning path, and its BatchManager skips skinned meshes');
  const res = await loadContainer(app, d.url);
  const track = res.animations[d.clip].resource as pc.AnimTrack;
  const blend = d.blend;
  const anims: pc.AnimComponent[] = [];
  const layers: pc.AnimComponentLayer[] = [];
  for (let i = 0; i < d.count; i++) {
    const root = new pc.Entity();
    root.setLocalPosition(d.position[i * 3], d.position[i * 3 + 1], d.position[i * 3 + 2]);
    root.setLocalEulerAngles(0, d.yaw[i] * pc.math.RAD_TO_DEG, 0);
    root.setLocalScale(d.scale, d.scale, d.scale);
    const model = res.instantiateRenderEntity();
    // speed 0: app.update(dt) must not advance the clip, its time is set from t in update()
    model.addComponent('anim', { activate: true, speed: 0 });
    const anim = model.anim!;
    if (blend) {
      anim.loadStateGraph(blendGraph);
      anim.assignAnimation('move.a', track);
      anim.assignAnimation('move.b', res.animations[blend.clip].resource as pc.AnimTrack);
    } else {
      anim.assignAnimation('move', track);
    }
    const layer = anim.baseLayer!;
    layer.play('move'); // leave START now, so frame 0 already honours the phase
    anims.push(anim);
    layers.push(layer);
    root.addChild(model);
    app.root.addChild(root);
  }
  const duration = track.duration;
  if (!blend) {
    return {
      path: 'instantiateRenderEntity per character + anim component',
      notes: ['clip time = (t + phase) mod duration via AnimComponentLayer.activeStateCurrentTime; anim speed 0'],
      update(t) {
        for (let i = 0; i < layers.length; i++) layers[i].activeStateCurrentTime = (t + d.phase[i]) % duration;
      },
    };
  }
  return {
    path: 'instantiateRenderEntity per character + anim component, 1D blend tree of two clips',
    notes: ['clip time = t + phase via AnimComponentLayer.activeStateCurrentTime (each looping clip wraps to its own duration); weight via anim.setFloat; anim speed 0'],
    update(t) {
      for (let i = 0; i < layers.length; i++) {
        anims[i].setFloat('w', blend.weight[i]);
        layers[i].activeStateCurrentTime = t + d.phase[i]; // unwrapped: the two clips differ in duration
      }
    },
  };
}
