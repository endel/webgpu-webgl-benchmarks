import type { Backend, GltfScene } from '../../harness/types';
import { describeCommon } from './field';
import type { Described } from './index';
import { boxMips, mipBytes, mipLevels } from './mips';
import type { Slots } from './slots';

export interface DescribedGltf extends Described {
  /** Image i's RGBA mip chain, rows bottom-up as Defold textures expect. */
  mips(i: number): Uint8Array;
  images: number;
}

/**
 * K4: Sponza's model ships in the defold-sponza bundle; its images are fetched and decoded here, like
 * every other engine's glTF loader does in the page, with a CPU mip chain (./mips.ts). main.script
 * uploads them one by one.
 */
export async function describeGltf(d: GltfScene, slots: Slots, backend: Backend): Promise<DescribedGltf> {
  if (d.manyLights) throw new Error('N/A: Defold has no clustered or many-light path');
  const gltf = await (await fetch(d.url)).json();
  const base = d.url.slice(0, d.url.lastIndexOf('/') + 1);
  const bitmaps: ImageBitmap[] = await Promise.all(
    gltf.images.map(async (im: { uri: string }) =>
      createImageBitmap(await (await fetch(base + im.uri)).blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }),
    ),
  );
  const images = bitmaps.map((b) => ({ width: b.width, height: b.height, levels: mipLevels(b.width, b.height) }));
  slots.u8('upload', new Uint8Array(0), { count: Math.max(...bitmaps.map((b) => mipBytes(b.width, b.height))) });

  const source = (t?: { index: number }) => (t ? gltf.textures[t.index].source : -1);
  const materials = gltf.materials.map((m: any) => {
    const pm = m.pbrMetallicRoughness ?? {};
    return {
      color: pm.baseColorFactor ?? [1, 1, 1, 1],
      roughness: pm.roughnessFactor ?? 1,
      metalness: pm.metallicFactor ?? 1,
      cutoff: m.alphaMode === 'MASK' ? m.alphaCutoff ?? 0.5 : 0,
      base: source(pm.baseColorTexture),
      normal: source(m.normalTexture),
      mr: source(pm.metallicRoughnessTexture),
    };
  });

  const pl = d.pointLights;
  if (pl) {
    const pos = new Float32Array(pl.count * 4);
    slots.f32('pointPos', () => {
      for (let i = 0; i < pl.count; i++) pos.set(pl.position.subarray(i * 3, i * 3 + 3), i * 4);
      return pos;
    }, { live: true, count: pos.length });
  }

  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return {
    json: {
      ...describeCommon(d, slots, backend),
      images,
      materials,
      shadow: d.sun?.shadow ? { maxDistance: d.sun.shadow.maxDistance } : null,
      points: pl ? { count: pl.count, range: pl.range, color: Array.from({ length: pl.count }, (_, i) => [0, 1, 2].map((k) => pl.color[i * 3 + k] * pl.intensity)) } : null,
      bloom: d.post ? d.post.bloom : null,
    },
    images: bitmaps.length,
    mips(i) {
      const b = bitmaps[i];
      canvas.width = b.width;
      canvas.height = b.height;
      ctx.drawImage(b, 0, 0);
      const out = new Uint8Array(mipBytes(b.width, b.height));
      out.set(ctx.getImageData(0, 0, b.width, b.height).data);
      return boxMips(out, b.width, b.height);
    },
  };
}
