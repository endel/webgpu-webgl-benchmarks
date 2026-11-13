import { AdvancedDynamicTexture } from '@babylonjs/gui/2D/advancedDynamicTexture';
import { Control } from '@babylonjs/gui/2D/controls/control';
import { Rectangle } from '@babylonjs/gui/2D/controls/rectangle';
import { Image } from '@babylonjs/gui/2D/controls/image';
import { TextBlock } from '@babylonjs/gui/2D/controls/textBlock';
import type { HudSpec } from '../../harness/types';
import type { BabylonCtx } from './index';

const LABEL_WIDTH = 160;

/** K9: Babylon GUI — every control is drawn with Canvas2D into one fullscreen texture, shown by a foreground layer. */
export async function buildHud(ctx: BabylonCtx, h: HudSpec) {
  const face = new FontFace(h.font.family, `url(${h.font.url})`);
  document.fonts.add(await face.load());

  const ui = AdvancedDynamicTexture.CreateFullscreenUI('hud', true, ctx.scene);
  const add = <T extends Control>(c: T, x: number, y: number, w: number, hgt: number) => {
    c.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    c.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    c.leftInPixels = x;
    c.topInPixels = y;
    c.widthInPixels = w;
    c.heightInPixels = hgt;
    ui.addControl(c);
    return c;
  };
  const rect = (x: number, y: number, w: number, hgt: number, css: string) => {
    const r = new Rectangle();
    r.thickness = 0;
    r.background = css;
    return add(r, x, y, w, hgt);
  };
  const atlasUrl = h.atlas.canvas.toDataURL();
  const { cell, cols } = h.atlas;
  let lastImage!: Image;
  const sprite = (id: number, x: number, y: number, size: number) => {
    const img = (lastImage = new Image(undefined, atlasUrl));
    img.sourceLeft = (id % cols) * cell;
    img.sourceTop = Math.floor(id / cols) * cell;
    img.sourceWidth = img.sourceHeight = cell;
    return add(img, x, y, size, size);
  };
  const text = (str: string, x: number, y: number, w: number, size: number, align: number) => {
    const t = new TextBlock(undefined, str);
    t.color = 'white';
    t.fontFamily = h.font.family;
    t.fontSizeInPixels = size;
    t.textHorizontalAlignment = align;
    t.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    return add(t, x, y, w, Math.ceil(size * 1.5));
  };

  for (const p of h.panels) rect(p.x, p.y, p.w, p.h, `rgba(${p.color.slice(0, 3).map((c) => Math.round(c * 255)).join()},${p.color[3]})`);
  for (let i = 0; i < h.icons.count; i++) sprite(h.icons.cell[i], h.icons.x[i], h.icons.y[i], h.icons.size);
  const n = h.nameplates;
  const units = Array.from({ length: n.count }, (_, i) => ({
    back: rect(0, 0, n.barWidth, n.barHeight, 'rgba(0,0,0,0.6)'),
    fill: rect(0, 0, n.barWidth, n.barHeight, 'rgb(51,230,77)'),
    icon: sprite(n.cell[i], 0, 0, n.iconSize),
    label: text(n.label[i], 0, 0, LABEL_WIDTH, n.fontSize, Control.HORIZONTAL_ALIGNMENT_CENTER),
  }));
  const dt = h.dynamicText;
  const dynamic = Array.from({ length: dt.count }, (_, i) => text(dt.text[i], dt.x[i], dt.y[i], 136, dt.fontSize, Control.HORIZONTAL_ALIGNMENT_LEFT));

  // Every Image shares one cached DOM image per source URL.
  if (!lastImage.isLoaded) await new Promise<void>((r) => lastImage.onImageLoadedObservable.addOnce(() => r()));

  return {
    path: '@babylonjs/gui fullscreen AdvancedDynamicTexture (Rectangle, Image, TextBlock per element; Canvas2D redraw + texture upload per frame)',
    update() {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const x = n.x[i], y = n.y[i];
        const left = x - n.barWidth / 2, top = y + n.fontSize + 2;
        u.back.leftInPixels = u.fill.leftInPixels = left;
        u.back.topInPixels = u.fill.topInPixels = u.icon.topInPixels = top;
        u.fill.widthInPixels = n.barWidth * n.health[i];
        u.icon.leftInPixels = left - n.iconSize - 2;
        u.label.leftInPixels = x - LABEL_WIDTH / 2;
        u.label.topInPixels = y;
      }
      for (let i = 0; i < dynamic.length; i++) dynamic[i].text = dt.text[i];
    },
  };
}
