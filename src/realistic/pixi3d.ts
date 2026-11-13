// A small "realistic" app (glTF + animation + shadows + bloom + ACES) — used only to measure the shipped bundle size.
import { DirectionalLight, Material3D, Mesh3D, Model3D, PlaneGeometry, View3D, type Scene3DSource } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { Application, Assets } from 'pixi.js';

const app = new Application();
await app.init({ canvas: document.querySelector('canvas')!, preference: 'webgpu', antialias: true, backgroundColor: 0x1a1a1a });
const view = new View3D({
  autoResize: true,
  toneMapping: 'aces',
  shadowQuality: 'high',
  environment: { skyColor: 0xdde8ff, groundColor: 0x443322 },
  passes: [new BloomEffect({ intensity: 0.3 })],
});
app.stage.addChild(view);
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
