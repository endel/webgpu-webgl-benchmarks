// A small "realistic" app (glTF + animation + shadows + bloom + ACES) — used only to measure the shipped bundle size.
// Same renderer setup as the minimal entry, so no lazy backend or environment chunk is fetched at runtime.
// No Application either: the root import registers the glTF loaders and Model3D's player runs on Ticker.shared.
import { DirectionalLight, Material3D, Mesh3D, Model3D, PlaneGeometry, View3D, type Scene3DSource } from '@pixi/3d';
import '@pixi/3d/webgpu';
import { BloomEffect } from '@pixi/3d/extras';
import { Assets, Container, WebGPURenderer } from 'pixi.js';

const renderer = new WebGPURenderer();
await renderer.init({ canvas: document.querySelector('canvas')!, antialias: true, backgroundColor: 0x1a1a1a, skipExtensionImports: true });
const stage = new Container({ isRenderGroup: true });
const view = stage.addChild(
  new View3D({
    width: renderer.width,
    height: renderer.height,
    toneMapping: 'aces',
    shadowQuality: 'high',
    environment: { skyColor: 0xdde8ff, groundColor: 0x443322 },
    passes: [new BloomEffect({ intensity: 0.3 })],
  }),
);
view.camera.position.set(0, 60, 180);
view.camera.lookAt({ x: 0, y: 40, z: 0 });

const sun = new DirectionalLight({ intensity: 3, castShadow: true, position: { x: 100, y: 200, z: 100 } });
sun.lookAt({ x: 0, y: 0, z: 0 });
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 400, height: 400 }),
  material: new Material3D({ baseColor: 0x808080 }),
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  castShadow: false,
});
view.root.addChild(sun, ground);

const source = await Assets.load<Scene3DSource>('assets/Fox/Fox.glb');
view.root.addChild(new Model3D({ source, autoPlay: 'Walk' }));
requestAnimationFrame(function frame() {
  renderer.render(stage);
  requestAnimationFrame(frame);
});
