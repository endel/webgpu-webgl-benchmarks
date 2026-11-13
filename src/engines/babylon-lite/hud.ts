import {
  addSprite2DIndex, createDefaultTextData, createGlyphStorage, createGridSpriteAtlas, createSolidTexture2D, createSprite2DLayer,
  createSpriteRenderer, createTextData, createTextLayer, createTextRenderer, createTexture2DFromExternalImage, disposeSpriteRenderer,
  disposeTextRenderer, extractGlyphCurves, loadFont, registerSpriteRenderer, registerTextRenderer, setTextLayerPosition,
  updateDefaultTextData, updateGlyphStorage, updateSprite2DIndex,
  type DefaultTextData, type GlyphCurves, type TextLayer,
} from '@babylonjs/lite';
import type { HudSpec } from '../../harness/types';
import type { LiteCtx } from './index';

// Layer positions are text baselines; the spec anchors the top of the line box (Roboto's ascent ≈ 0.93 em).
const ASCENT = 0.93;
const WHITE = [1, 1, 1, 1] as const;

export async function buildHud(ctx: LiteCtx, hud: HudSpec) {
  const { engine } = ctx;
  const np = hud.nameplates, dt = hud.dynamicText;

  // --- sprites: four layers in draw order, the rectangles tinting a 1×1 white atlas ---
  const white = createGridSpriteAtlas(createSolidTexture2D(engine, 1, 1, 1, 1), { cellWidthPx: 1, cellHeightPx: 1, columns: 1, rows: 1 });
  const a = hud.atlas;
  const iconTexture = await createTexture2DFromExternalImage(engine, a.canvas, { invertY: false, mipMaps: false, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const icons = createGridSpriteAtlas(iconTexture, { cellWidthPx: a.cell, cellHeightPx: a.cell, columns: a.cols, rows: a.rows });
  const topLeft: [number, number] = [0, 0];
  const panels = createSprite2DLayer(white, { capacity: hud.panels.length, order: 0, pivot: topLeft });
  const fixed = createSprite2DLayer(icons, { capacity: hud.icons.count, order: 1, pivot: topLeft });
  const bars = createSprite2DLayer(white, { capacity: np.count * 2, order: 2, pivot: topLeft });
  const unitIcons = createSprite2DLayer(icons, { capacity: np.count, order: 3, pivot: topLeft });
  for (const p of hud.panels) addSprite2DIndex(panels, { positionPx: [p.x, p.y], sizePx: [p.w, p.h], color: [...p.color] });
  for (let i = 0; i < hud.icons.count; i++) {
    addSprite2DIndex(fixed, { positionPx: [hud.icons.x[i], hud.icons.y[i]], sizePx: [hud.icons.size, hud.icons.size], frame: hud.icons.cell[i] });
  }
  const top = np.fontSize + 2;
  for (let i = 0; i < np.count; i++) {
    const x = np.x[i] - np.barWidth / 2, y = np.y[i] + top;
    addSprite2DIndex(bars, { positionPx: [x, y], sizePx: [np.barWidth, np.barHeight], color: [0, 0, 0, 0.6] });
    addSprite2DIndex(bars, { positionPx: [x, y], sizePx: [np.barWidth * np.health[i], np.barHeight], color: [0.2, 0.9, 0.3, 1] });
    addSprite2DIndex(unitIcons, { positionPx: [x - np.iconSize - 2, y], sizePx: [np.iconSize, np.iconSize], frame: np.cell[i] });
  }
  const sprites = createSpriteRenderer(engine, { layers: [panels, fixed, bars, unitIcons], clear: false });

  // --- text: one TextData + TextLayer per label, all borrowing one GlyphStorage ---
  const font = await loadFont(hud.font.url);
  const family = hud.font.family;
  const storage = createGlyphStorage();
  const known = new Set<number>();
  // The default layout helper is the only public shaper; its run is re-homed into the shared storage.
  const shaper = createDefaultTextData(font, np.fontSize, '', WHITE);
  const labels: TextLayer[] = [];
  const half = new Float32Array(np.count);
  for (let i = 0; i < np.count; i++) {
    updateDefaultTextData(shaper, np.label[i]);
    const run = shaper.runs[0];
    const fresh = new Set<number>();
    for (const g of run.glyphs) if (!known.has(g.glyphId)) fresh.add(g.glyphId);
    if (fresh.size) {
      const curves = new Map<number, GlyphCurves>();
      extractGlyphCurves(font, fresh, curves);
      updateGlyphStorage(storage, family, curves);
      for (const id of fresh) known.add(id);
    }
    half[i] = shaper.width / 2;
    const data = createTextData(storage, [{ curveSet: family, glyphs: run.glyphs, pixelsPerFontUnit: run.pixelsPerFontUnit, defaultColor: WHITE }]);
    labels.push(createTextLayer(data, { positionPx: { x: np.x[i] - half[i], y: np.y[i] + np.fontSize * ASCENT }, order: 0 }));
  }
  // Strings that change every frame go through the documented re-shape path.
  const dynamic: DefaultTextData[] = [];
  const dynamicLayers: TextLayer[] = [];
  for (let i = 0; i < dt.count; i++) {
    const data = createDefaultTextData(font, dt.fontSize, dt.text[i], WHITE);
    dynamic.push(data);
    dynamicLayers.push(createTextLayer(data, { positionPx: { x: dt.x[i], y: dt.y[i] + dt.fontSize * ASCENT }, order: 1 }));
  }
  const text = createTextRenderer(engine, { layers: [...labels, ...dynamicLayers], clear: false });

  return {
    path: 'SpriteRenderer (4 Sprite2D layers, 2 atlases) + TextRenderer (TextLayer per label, shared GlyphStorage) over the scene',
    notes: ['sprites and text are separate passes: every label draws after every sprite'],
    /** After registerScene: rendering contexts draw in registration order. */
    register() {
      registerSpriteRenderer(sprites);
      registerTextRenderer(text);
    },
    update() {
      for (let i = 0; i < np.count; i++) {
        const x = np.x[i] - np.barWidth / 2, y = np.y[i] + top;
        updateSprite2DIndex(bars, i * 2, { positionPx: [x, y] });
        updateSprite2DIndex(bars, i * 2 + 1, { positionPx: [x, y], sizePx: [np.barWidth * np.health[i], np.barHeight] });
        updateSprite2DIndex(unitIcons, i, { positionPx: [x - np.iconSize - 2, y] });
        setTextLayerPosition(labels[i], np.x[i] - half[i], np.y[i] + np.fontSize * ASCENT);
      }
      for (let i = 0; i < dt.count; i++) updateDefaultTextData(dynamic[i], dt.text[i]);
    },
    dispose() {
      disposeSpriteRenderer(sprites);
      disposeTextRenderer(text);
    },
  };
}
