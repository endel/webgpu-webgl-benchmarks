import * as pc from 'playcanvas';
import type { HudSpec, Variant } from '../../harness/types';
import type { PcCtx } from './index';

/** CanvasFont glyph size. Its line metrics are tuned around 32 px: a 16 px atlas draws text ~4 px lower. */
const ATLAS_FONT_PX = 32;
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const TOP_LEFT = [0, 1, 0, 1];

export async function buildHud({ app, device }: PcCtx, h: HudSpec, variant: Variant) {
  // Registered only for K9, so the other tests don't pay for the UI systems.
  app.systems.add(new pc.ScreenComponentSystem(app));
  app.systems.add(new pc.ElementComponentSystem(app));

  // CanvasFont rasterizes glyphs with a 2D canvas, so the TTF has to be a loaded CSS font first.
  const face = new FontFace(h.font.family, `url(${h.font.url})`);
  await face.load();
  document.fonts.add(face);
  const font = new pc.CanvasFont(app, { fontName: h.font.family, fontSize: ATLAS_FONT_PX, width: 512, height: 512, color: pc.Color.WHITE });
  font.createTextures(ASCII);

  const { cols, rows } = h.atlas;
  const atlas = new pc.Texture(device, {
    format: pc.PIXELFORMAT_SRGBA8,
    mipmaps: false,
    minFilter: pc.FILTER_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  atlas.setSource(h.atlas.canvas);
  const rect = (cell: number) => new pc.Vec4((cell % cols) / cols, 1 - (Math.floor(cell / cols) + 1) / rows, 1 / cols, 1 / rows);

  // Dynamic because the nameplates move. Editing a batched element's text or image re-batches its
  // group, and the batch draws a copy of each element's mesh, so only elements whose mesh never
  // changes join one: the per-frame labels stay out and the bar fill changes length by scale.
  // The batcher keeps draw order, so an element can't join a batch across an overlapping element of
  // another style; one group per element kind leaves nothing to interleave.
  const optimized = variant === 'optimized';
  const group = (name: string) => (optimized ? { batchGroupId: app.batcher.addGroup(name, true, 1e6, undefined, [pc.LAYERID_UI]).id } : {});
  const [panelGroup, iconGroup, barGroup, fillGroup, plateIconGroup, labelGroup] = ['panels', 'icons', 'bars', 'fills', 'plate-icons', 'labels'].map(group);

  const screen = new pc.Entity('hud');
  screen.addComponent('screen', { screenSpace: true, scaleMode: pc.SCALEMODE_NONE, referenceResolution: new pc.Vec2(device.width, device.height) });
  app.root.addChild(screen);

  // Elements draw in hierarchy order. Positions are pixels from the parent's top-left, y down.
  const add = (parent: pc.Entity, x: number, y: number, data: object) => {
    const e = new pc.Entity();
    e.addComponent('element', { anchor: TOP_LEFT, pivot: [0, 1], ...data });
    e.setLocalPosition(x, -y, 0);
    parent.addChild(e);
    return e;
  };
  const image = (parent: pc.Entity, x: number, y: number, w: number, hgt: number, data: object) =>
    add(parent, x, y, { type: pc.ELEMENTTYPE_IMAGE, width: w, height: hgt, ...data });
  const sprite = (parent: pc.Entity, x: number, y: number, size: number, cell: number, data: object) =>
    image(parent, x, y, size, size, { texture: atlas, rect: rect(cell), ...data });
  const text = (parent: pc.Entity, x: number, y: number, fontSize: number, str: string, pivotX: number, data: object = {}) =>
    add(parent, x, y, { type: pc.ELEMENTTYPE_TEXT, pivot: [pivotX, 1], font, fontSize, lineHeight: fontSize, text: str, color: pc.Color.WHITE, ...data });

  for (const p of h.panels) image(screen, p.x, p.y, p.w, p.h, { color: new pc.Color(p.color[0], p.color[1], p.color[2]), opacity: p.color[3], ...panelGroup });
  const ic = h.icons;
  for (let i = 0; i < ic.count; i++) sprite(screen, ic.x[i], ic.y[i], ic.size, ic.cell[i], iconGroup);

  const n = h.nameplates;
  const barY = n.fontSize + 2;
  // the fill's pivot is its left edge, so scaling it keeps that edge in place
  const setFill = optimized ? (e: pc.Entity, f: number) => e.setLocalScale(f, 1, 1) : (e: pc.Entity, f: number) => (e.element!.width = n.barWidth * f);
  const plates: pc.Entity[] = [], fills: pc.Entity[] = [];
  for (let i = 0; i < n.count; i++) {
    const plate = add(screen, n.x[i], n.y[i], { type: pc.ELEMENTTYPE_GROUP, width: 0, height: 0 });
    image(plate, -n.barWidth / 2, barY, n.barWidth, n.barHeight, { color: pc.Color.BLACK, opacity: 0.6, ...barGroup });
    const fill = image(plate, -n.barWidth / 2, barY, n.barWidth, n.barHeight, { color: new pc.Color(0.2, 0.9, 0.3), ...fillGroup });
    setFill(fill, n.health[i]);
    fills.push(fill);
    sprite(plate, -n.barWidth / 2 - n.iconSize - 2, barY, n.iconSize, n.cell[i], plateIconGroup);
    text(plate, 0, 0, n.fontSize, n.label[i], 0.5, labelGroup);
    plates.push(plate);
  }

  const dt = h.dynamicText;
  const labels: pc.ElementComponent[] = [];
  for (let i = 0; i < dt.count; i++) labels.push(text(screen, dt.x[i], dt.y[i], dt.fontSize, dt.text[i], 0).element!);

  return {
    path: optimized
      ? 'screen-space ElementComponents in dynamic batch groups (app.batcher.addGroup + batchGroupId), one group per element kind, so nameplate parts draw kind by kind (bars, fills, icons, labels) as Babylon Lite\'s sprite and text layers do; bar fill scaled by transform, per-frame text left unbatched; text via CanvasFont from the TTF loaded with the FontFace API'
      : 'screen-space ScreenComponent + one ElementComponent per panel/icon/bar/label (unbatched, the default), text via CanvasFont from the TTF loaded with the FontFace API',
    update() {
      for (let i = 0; i < plates.length; i++) {
        plates[i].setLocalPosition(n.x[i], -n.y[i], 0);
        setFill(fills[i], n.health[i]);
      }
      for (let i = 0; i < labels.length; i++) labels[i].text = dt.text[i];
    },
  };
}
