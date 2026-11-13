// Smallest lit PBR cube on WebGPU — used only to measure the shipped bundle size.
import {
  AcesToneMapping, addToScene, createBox, createDirectionalLight, createEngine, createFreeCamera, createHemisphericLight,
  createPbrMaterial, createSceneContext, onBeforeRender, registerScene, startEngine,
} from '@babylonjs/lite';

const engine = await createEngine(document.querySelector('canvas')!);
const scene = createSceneContext(engine);
scene.imageProcessing.toneMappingEnabled = true;
scene.imageProcessing.toneMapping = AcesToneMapping;
scene.camera = createFreeCamera({ x: 0, y: 1.2, z: 3 }, { x: 0, y: 0, z: 0 });
addToScene(scene, createHemisphericLight([0, 1, 0], 0.5));
addToScene(scene, createDirectionalLight([-0.5, -1, -0.5], 3));
const cube = createBox(engine);
cube.material = createPbrMaterial({ baseColorFactor: [0.8, 0.3, 0.1, 1], roughnessFactor: 0.4, metallicFactor: 0 });
addToScene(scene, cube);
onBeforeRender(scene, (deltaMs) => (cube.rotation.y += deltaMs / 1000));
await registerScene(scene);
await startEngine(engine);
