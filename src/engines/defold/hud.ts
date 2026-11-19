import { HEIGHT } from '../../harness/scenes';
import type { HudSpec, Variant } from '../../harness/types';
import type { Slots } from './slots';

/** Bytes per dynamic-text string in the per-frame text slot. */
const TEXT_BYTES = 32;

/**
 * K9 through Defold's GUI component (defold/hud). The atlas canvas becomes a runtime texture and
 * atlas; nameplates (x, y, health) and the dynamic strings are refreshed in the wasm heap every frame.
 */
export function describeHud(h: HudSpec, variant: Variant, slots: Slots) {
  const { canvas, cols, rows, cell } = h.atlas;
  if (cols !== 8 || rows !== 8 || cell !== 32) throw new Error('defold: the HUD tile source is generated for an 8×8 atlas of 32 px cells (scripts/build-defold.ts HUD_ATLAS)');
  // Defold texture rows run bottom-up, canvas rows top-down
  const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  const row = canvas.width * 4;
  const flipped = new Uint8Array(image.length);
  for (let y = 0; y < canvas.height; y++) flipped.set(image.subarray(y * row, (y + 1) * row), (canvas.height - 1 - y) * row);
  slots.u8('atlas', flipped);

  const n = h.nameplates;
  const plates = new Float32Array(n.count * 4);
  slots.f32('plates', () => {
    for (let i = 0; i < n.count; i++) {
      plates[i * 4] = n.x[i];
      plates[i * 4 + 1] = n.y[i];
      plates[i * 4 + 2] = n.health[i];
    }
    return plates;
  }, { live: true, count: plates.length });

  const dt = h.dynamicText;
  const text = new Uint8Array(dt.count * TEXT_BYTES);
  const encoder = new TextEncoder();
  slots.u8('hudText', () => {
    text.fill(10); // newline-separated, so the padding splits away
    encoder.encodeInto(dt.text.join('\n'), text);
    return text;
  }, { live: true, count: text.length });

  const optimized = variant === 'optimized';
  return {
    height: HEIGHT,
    optimized,
    atlas: { width: canvas.width, height: canvas.height, cols, rows, cell },
    panels: h.panels,
    icons: Array.from({ length: h.icons.count }, (_, i) => ({ x: h.icons.x[i], y: h.icons.y[i], cell: h.icons.cell[i] })),
    iconSize: h.icons.size,
    nameplates: { count: n.count, fontSize: n.fontSize, iconSize: n.iconSize, barWidth: n.barWidth, barHeight: n.barHeight, cells: Array.from(n.cell), labels: n.label },
    dynamic: { count: dt.count, fontSize: dt.fontSize, x: Array.from(dt.x), y: Array.from(dt.y) },
    path:
      'GUI components (one per 2,048 nameplates: a GUI holds at most 8,192 nodes): box and text nodes per element (gui.new_box_node / new_text_node), icons as flipbooks of a tile source whose texture gets the atlas pixels (resource.set_texture); gui.set_position / set_size / set_text every frame' +
      (optimized ? '; nodes assigned to quads, icons and text layers, so each layer batches' : ''),
  };
}
