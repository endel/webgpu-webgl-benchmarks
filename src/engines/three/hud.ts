import * as THREE from 'three';
import { HEIGHT, WIDTH } from '../../harness/scenes';
import type { HudSpec } from '../../harness/types';

// three.js has no 2D/UI stack. This is the overlay its examples point to (an orthographic scene
// drawn after the 3D one, text through canvas textures), with the quads of each layer merged into
// one dynamic BufferGeometry instead of a Sprite per element.

type Rgba = [number, number, number, number];
const LINE = 1.3; // text cell height, in font sizes
const MAX_SHEET = 4096;

/** A layer of axis-aligned quads in one geometry: one draw call, positions rewritten on the CPU. */
function quads(scene: THREE.Scene, order: number, n: number, map: THREE.Texture | null, live: boolean) {
  const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), color = new Float32Array(n * 16).fill(1);
  const index = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 2, i * 4 + 3, i * 4 + 1], i * 6);
  const geo = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(pos, 3);
  if (live) position.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', position);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  // toneMapped only matters to WebGLRenderer; WebGPURenderer ignores it
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    position,
    rect(i: number, x: number, y: number, w: number, h: number) {
      const o = i * 12;
      pos[o] = pos[o + 6] = x;
      pos[o + 3] = pos[o + 9] = x + w;
      pos[o + 1] = pos[o + 4] = y;
      pos[o + 7] = pos[o + 10] = y + h;
    },
    /** Texture rectangle in pixels of a `tw`×`th` image, origin top-left. */
    tex(i: number, x: number, y: number, w: number, h: number, tw: number, th: number) {
      const u0 = x / tw, u1 = (x + w) / tw, v0 = 1 - y / th, v1 = 1 - (y + h) / th;
      uv.set([u0, v0, u1, v0, u0, v1, u1, v1], i * 8);
    },
    color(i: number, c: Rgba) {
      for (let k = 0; k < 4; k++) color.set(c, i * 16 + k * 4);
    },
  };
}

export async function buildHud(h: HudSpec, raw: boolean) {
  const scene = new THREE.Scene();
  // pixel coordinates, y down
  const camera = new THREE.OrthographicCamera(0, WIDTH, 0, HEIGHT, -1, 1);
  const space = raw ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  const rgba = (c: Rgba): Rgba => (raw ? c : [...new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).toArray(), c[3]] as Rgba);
  const sheet = (canvas: HTMLCanvasElement, mips: boolean) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = space;
    // text is drawn 1:1, so mipmaps would only cost an upload
    if (!mips) {
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
    }
    return t;
  };
  const font = new FontFace(h.font.family, `url(${h.font.url})`);
  document.fonts.add(await font.load());
  const pen = (w: number, hgt: number, size: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    const g = canvas.getContext('2d')!;
    g.font = `${size}px ${h.font.family}`;
    g.fillStyle = '#fff';
    g.textBaseline = 'top';
    return { canvas, g };
  };

  const { atlas: a, icons, nameplates: np, dynamicText: dt } = h;
  const atlas = sheet(a.canvas, true);
  const cell = (q: ReturnType<typeof quads>, i: number, c: number) =>
    q.tex(i, (c % a.cols) * a.cell, Math.floor(c / a.cols) * a.cell, a.cell, a.cell, a.canvas.width, a.canvas.height);

  const panels = quads(scene, 0, h.panels.length, null, false);
  h.panels.forEach((p, i) => {
    panels.rect(i, p.x, p.y, p.w, p.h);
    panels.color(i, rgba(p.color));
  });

  const fixed = quads(scene, 1, icons.count, atlas, false);
  for (let i = 0; i < icons.count; i++) {
    fixed.rect(i, icons.x[i], icons.y[i], icons.size, icons.size);
    cell(fixed, i, icons.cell[i]);
  }

  // every static label is rasterised once into one sheet
  const probe = pen(1, 1, np.fontSize).g;
  const lw = Math.ceil(Math.max(1, ...np.label.map((s) => probe.measureText(s).width))) + 2, lh = Math.ceil(np.fontSize * LINE);
  const cols = Math.floor(MAX_SHEET / lw), rows = Math.ceil(np.count / cols);
  if (rows * lh > MAX_SHEET) throw new Error(`N/A: ${np.count} labels do not fit one ${MAX_SHEET}px canvas texture`);
  const labelSheet = pen(cols * lw, rows * lh, np.fontSize);
  labelSheet.g.textAlign = 'center';
  const bars = quads(scene, 2, np.count * 2, null, true);
  const unitIcons = quads(scene, 3, np.count, atlas, true);
  const labels = quads(scene, 4, np.count, sheet(labelSheet.canvas, false), true);
  for (let i = 0; i < np.count; i++) {
    const x = (i % cols) * lw, y = Math.floor(i / cols) * lh;
    labelSheet.g.fillText(np.label[i], x + lw / 2, y);
    labels.tex(i, x, y, lw, lh, labelSheet.canvas.width, labelSheet.canvas.height);
    cell(unitIcons, i, np.cell[i]);
    bars.color(i * 2, rgba([0, 0, 0, 0.6]));
    bars.color(i * 2 + 1, rgba([0.2, 0.9, 0.3, 1]));
  }

  // dynamic strings are redrawn into a small canvas and re-uploaded every frame
  const dw = Math.ceil(dt.fontSize * 9), dh = Math.ceil(dt.fontSize * LINE), dcols = Math.max(1, Math.floor(MAX_SHEET / dw));
  const dyn = pen(Math.min(dt.count, dcols) * dw, Math.ceil(dt.count / dcols) * dh, dt.fontSize);
  const dynTex = sheet(dyn.canvas, false);
  const texts = quads(scene, 5, dt.count, dynTex, false);
  for (let i = 0; i < dt.count; i++) {
    const x = (i % dcols) * dw, y = Math.floor(i / dcols) * dh;
    texts.rect(i, dt.x[i], dt.y[i], dw, dh);
    texts.tex(i, x, y, dw, dh, dyn.canvas.width, dyn.canvas.height);
  }

  const update = () => {
    const top = np.fontSize + 2, half = np.barWidth / 2;
    for (let i = 0; i < np.count; i++) {
      const x = np.x[i], y = np.y[i];
      bars.rect(i * 2, x - half, y + top, np.barWidth, np.barHeight);
      bars.rect(i * 2 + 1, x - half, y + top, np.barWidth * np.health[i], np.barHeight);
      unitIcons.rect(i, x - half - np.iconSize - 2, y + top, np.iconSize, np.iconSize);
      labels.rect(i, x - lw / 2, y, lw, lh);
    }
    bars.position.needsUpdate = unitIcons.position.needsUpdate = labels.position.needsUpdate = true;
    dyn.g.clearRect(0, 0, dyn.canvas.width, dyn.canvas.height);
    for (let i = 0; i < dt.count; i++) dyn.g.fillText(dt.text[i], (i % dcols) * dw, Math.floor(i / dcols) * dh);
    dynTex.needsUpdate = true;
  };
  update();
  return {
    scene,
    camera,
    update,
    path: 'orthographic overlay scene, one quad-batch BufferGeometry per layer (6 draws), canvas-2D text in CanvasTextures (labels once, dynamic text re-uploaded per frame)',
  };
}
