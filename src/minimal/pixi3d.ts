// Smallest lit PBR cube on WebGPU — used only to measure the shipped bundle size.
import { AmbientLight, CubeGeometry, DirectionalLight, Material3D, Mesh3D, View3D } from '@pixi/3d';
import { Application } from 'pixi.js';

const app = new Application();
await app.init({ canvas: document.querySelector('canvas')!, preference: 'webgpu', antialias: true });
const view = new View3D({ autoResize: true, toneMapping: 'aces' });
app.stage.addChild(view);
view.camera.fov = 50;
view.camera.position.set(0, 1.2, 3);
view.camera.lookAt({ x: 0, y: 0, z: 0 });
const cube = new Mesh3D({ geometry: new CubeGeometry(), material: new Material3D({ baseColor: 0xcc5522, roughness: 0.4 }) });
const sun = new DirectionalLight({ intensity: 3, position: { x: 2, y: 4, z: 3 } });
sun.lookAt({ x: 0, y: 0, z: 0 });
view.root.addChild(cube, sun, new AmbientLight({ intensity: 0.5 }));
app.ticker.add((ticker) => {
  cube.rotation.y = ticker.lastTime / 1000;
});
