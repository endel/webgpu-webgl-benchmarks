import { Assets, BitmapFont, BitmapText, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import type { HudSpec } from '../../harness/types';
import type { Ctx } from './common';

const BAR_BG = 0x000000, BAR_BG_ALPHA = 0.6;
const BAR_FILL: [number, number, number] = [0.2, 0.9, 0.3];

/** K9: plain pixi 2D on the stage above the View3D, so it is never tone-mapped or bloomed. */
export async function buildHud({ app }: Ctx, h: HudSpec) {
  await Assets.load({ src: h.font.url, data: { family: h.font.family } });
  // one glyph atlas per size at 1:1, so labels are not minified
  const font = (size: number) => {
    const name = `${h.font.family}-${size}`;
    BitmapFont.install({ name, style: { fontFamily: h.font.family, fontSize: size, fill: 0xffffff }, chars: [[' ', '~']] });
    return { fontFamily: name, fontSize: size };
  };
  const hud = new Container();
  app.stage.addChild(hud);

  const panels = new Graphics();
  for (const p of h.panels) panels.rect(p.x, p.y, p.w, p.h).fill({ color: [p.color[0], p.color[1], p.color[2]], alpha: p.color[3] });
  hud.addChild(panels);

  const { cols, cell } = h.atlas;
  const atlas = Texture.from(h.atlas.canvas);
  const cells = Array.from({ length: cols * h.atlas.rows }, (_, i) => new Texture({ source: atlas.source, frame: new Rectangle((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell) }));
  const icon = (c: number, size: number, x: number, y: number) => {
    const s = new Sprite(cells[c]);
    s.setSize(size, size);
    s.position.set(x, y);
    return s;
  };
  for (let i = 0; i < h.icons.count; i++) hud.addChild(icon(h.icons.cell[i], h.icons.size, h.icons.x[i], h.icons.y[i]));

  const n = h.nameplates;
  const labelStyle = font(n.fontSize);
  const barY = n.fontSize + 2;
  const plates = Array.from({ length: n.count }, (_, i) => {
    const plate = new Container();
    const bg = new Sprite(Texture.WHITE);
    bg.tint = BAR_BG;
    bg.alpha = BAR_BG_ALPHA;
    bg.setSize(n.barWidth, n.barHeight);
    bg.position.set(-n.barWidth / 2, barY);
    const fill = new Sprite(Texture.WHITE);
    fill.tint = BAR_FILL;
    fill.setSize(n.barWidth * n.health[i], n.barHeight);
    fill.position.set(-n.barWidth / 2, barY);
    const label = new BitmapText({ text: n.label[i], style: labelStyle, anchor: { x: 0.5, y: 0 } });
    plate.addChild(bg, fill, icon(n.cell[i], n.iconSize, -n.barWidth / 2 - n.iconSize - 2, barY), label);
    plate.position.set(n.x[i], n.y[i]);
    hud.addChild(plate);
    return { plate, fill };
  });

  const dt = h.dynamicText;
  const dynStyle = font(dt.fontSize);
  // a BitmapText whose string changes rebuilds its render group's whole batch: keep that to these 30
  const dynLayer = new Container({ isRenderGroup: true });
  hud.addChild(dynLayer);
  const dynamic = Array.from({ length: dt.count }, (_, i) => {
    const text = new BitmapText({ text: dt.text[i], style: dynStyle });
    text.position.set(dt.x[i], dt.y[i]);
    dynLayer.addChild(text);
    return text;
  });

  return {
    path: 'pixi 2D HUD on the stage (Graphics panels, atlas Sprites, Container per nameplate, BitmapText labels; dynamic BitmapText in its own render group)',
    update() {
      for (let i = 0; i < n.count; i++) {
        const p = plates[i];
        p.plate.position.set(n.x[i], n.y[i]);
        p.fill.width = n.barWidth * n.health[i];
      }
      for (let i = 0; i < dt.count; i++) dynamic[i].text = dt.text[i];
    },
  };
}
