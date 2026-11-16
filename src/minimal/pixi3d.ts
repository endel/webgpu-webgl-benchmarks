// Smallest lit PBR cube on WebGPU — used only to measure the shipped bundle size.
// WebGPURenderer is constructed directly with `skipExtensionImports`, so pixi fetches no backend or
// environment chunk at runtime and everything the page runs is statically bundled, like the other entries.
import { AmbientLight, CubeGeometry, DirectionalLight, Material3D, Mesh3D, View3D } from '@pixi/3d';
import '@pixi/3d/webgpu';
import { Container, WebGPURenderer } from 'pixi.js';

const renderer = new WebGPURenderer();
await renderer.init({ canvas: document.querySelector('canvas')!, antialias: true, skipExtensionImports: true });
const stage = new Container({ isRenderGroup: true });
const view = stage.addChild(new View3D({ width: renderer.width, height: renderer.height, toneMapping: 'aces' }));
view.camera.fov = 50;
view.camera.position.set(0, 1.2, 3);
view.camera.lookAt({ x: 0, y: 0, z: 0 });
const cube = new Mesh3D({ geometry: new CubeGeometry(), material: new Material3D({ baseColor: 0xcc5522, roughness: 0.4 }) });
const sun = new DirectionalLight({ intensity: 3, position: { x: 2, y: 4, z: 3 } });
sun.lookAt({ x: 0, y: 0, z: 0 });
view.root.addChild(cube, sun, new AmbientLight({ intensity: 0.5 }));
requestAnimationFrame(function frame(now: number) {
  cube.rotation.y = now / 1000;
  renderer.render(stage);
  requestAnimationFrame(frame);
});
