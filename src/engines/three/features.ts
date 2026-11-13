import { RenderPipeline, RenderTarget } from 'three/webgpu';
import { pass, renderOutput, texture, vec4 } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type { Features } from './common';
import type { ThreeCtx } from './index';
import { buildParticles } from './particles';

// WebGPURenderer-only features, kept out of the shared builders so three-classic doesn't bundle them.
export function webgpuFeatures(ctx: ThreeCtx): Features {
  const { renderer, scene, camera } = ctx;
  return {
    label: {
      cascades: 'CSMShadowNode (addon)',
      clustered: 'ClusteredLighting addon',
      post: 'RenderPipeline + BloomNode (addon)',
      overlay: 'composited after tone mapping in a RenderPipeline',
    },
    cascades(sun, s) {
      sun.castShadow = true;
      sun.shadow.mapSize.setScalar(s.mapSize);
      sun.shadow.shadowNode = new CSMShadowNode(sun, { cascades: s.cascades, maxFar: s.maxDistance });
    },
    clustered() {
      // on the WebGL2 backend it compiles but the point lights render unlit
      if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('N/A: ClusteredLighting needs the WebGPU backend (compute + storage buffers)');
      renderer.lighting = new ClusteredLighting();
    },
    post({ bloom: b }) {
      const pipeline = new RenderPipeline(renderer);
      const color = pass(scene, camera).getTextureNode('output');
      pipeline.outputColorTransform = false;
      pipeline.outputNode = renderOutput(color.add(bloom(color, b.strength, b.radius, b.threshold)));
      return () => pipeline.render();
    },
    rawOverlay: true,
    overlay(hud, hudCamera) {
      // WebGPURenderer tone-maps the whole frame in its output pass (material.toneMapped is
      // ignored), so the HUD gets its own target, blended over the tone-mapped image
      const target = new RenderTarget(renderer.domElement.width, renderer.domElement.height, { depthBuffer: false });
      const ui = texture(target.texture);
      const pipeline = new RenderPipeline(renderer);
      const base = renderOutput(pass(scene, camera));
      pipeline.outputColorTransform = false;
      // the HUD target holds premultiplied colour
      pipeline.outputNode = vec4(base.rgb.mul(ui.a.oneMinus()).add(ui.rgb), 1);
      return () => {
        // a transparent clear, which the 3D pass must not see (it would darken scene.background)
        renderer.setClearAlpha(0);
        renderer.setRenderTarget(target);
        renderer.render(hud, hudCamera);
        renderer.setRenderTarget(null);
        renderer.setClearAlpha(1);
        pipeline.render();
      };
    },
    particles: (d) => buildParticles(ctx, d),
  };
}
