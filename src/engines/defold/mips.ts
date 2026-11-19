// Defold has no runtime mipmap generation: runtime textures get their mip chain from the adapter,
// box-filtered on the CPU (inside load() or frame(), so the cost is charged to Defold).

export const mipLevels = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h))) + 1;

export function mipBytes(w: number, h: number) {
  let n = 0;
  for (let l = 0; l < mipLevels(w, h); l++) n += Math.max(1, w >> l) * Math.max(1, h >> l) * 4;
  return n;
}

/** Fills levels 1.. of `out` from the RGBA level 0 already at its start; levels are packed back to back. */
export function boxMips(out: Uint8Array, w: number, h: number) {
  let src = 0;
  for (let l = 1; l < mipLevels(w, h); l++) {
    const sw = Math.max(1, w >> (l - 1)), sh = Math.max(1, h >> (l - 1));
    const dw = Math.max(1, w >> l), dh = Math.max(1, h >> l);
    const dst = src + sw * sh * 4;
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(2 * y, sh - 1), y1 = Math.min(2 * y + 1, sh - 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(2 * x, sw - 1), x1 = Math.min(2 * x + 1, sw - 1);
        const a = src + (y0 * sw + x0) * 4, b = src + (y0 * sw + x1) * 4, c = src + (y1 * sw + x0) * 4, d = src + (y1 * sw + x1) * 4;
        const o = dst + (y * dw + x) * 4;
        for (let k = 0; k < 4; k++) out[o + k] = (out[a + k] + out[b + k] + out[c + k] + out[d + k] + 2) >> 2;
      }
    }
    src = dst;
  }
  return out;
}
