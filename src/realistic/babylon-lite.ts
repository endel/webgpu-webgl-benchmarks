// "Realistic feature set" app — bundled to measure shipped size, never run.
import {
  AcesToneMapping, addTask, addTaskAtStart, addToScene, createArcRotateCamera, createBloomPostProcessTask, createDirectionalLight,
  createGround, createHemisphericLight, createPbrMaterial, createPcfDirectionalShadowGenerator, createRenderTarget, createRenderTask,
  createSceneContext, createEngine, enableSkeletonShadows, getContainerMeshes, loadGltf, playAnimation, registerSceneWithShadowSupport,
  setShadowTaskCasterMeshes, startEngine,
} from '@babylonjs/lite';

const engine = await createEngine(document.querySelector('canvas')!);
// The bloom chain replaces the scene's default render task.
const scene = createSceneContext(engine, { defaultRenderTask: false });
scene.imageProcessing.toneMappingEnabled = true;
scene.imageProcessing.toneMapping = AcesToneMapping;
scene.camera = createArcRotateCamera(Math.PI / 4, Math.PI / 3, 250, { x: 0, y: 40, z: 0 });
addToScene(scene, createHemisphericLight([0, 1, 0], 0.3));

const sun = createDirectionalLight([-0.4, -1, -0.3], 3);
addToScene(scene, sun);
sun.shadowGenerator = createPcfDirectionalShadowGenerator(engine, sun, { mapSize: 2048 });

const ground = createGround(engine, { width: 600, height: 600 });
ground.material = createPbrMaterial();
ground.receiveShadows = true;
addToScene(scene, ground);

const fox = await loadGltf(engine, 'assets/Fox/Fox.glb');
addToScene(scene, fox);
enableSkeletonShadows(sun.shadowGenerator);
setShadowTaskCasterMeshes(sun.shadowGenerator, getContainerMeshes(fox));
playAnimation(fox.animationGroups![0]);

const color = createRenderTarget({ format: engine.format, dFormat: 'depth24plus-stencil8', samples: 4, size: engine });
const resolved = createRenderTarget({ format: engine.format, samples: 1, size: engine });
addTaskAtStart(scene, createRenderTask({ name: 'scene', rt: color, rst: resolved, clrColor: scene.clearColor, clr: true }, engine, scene));
addTask(scene, createBloomPostProcessTask({ sourceTexture: resolved, targetTexture: engine.scRT }, engine, scene));

await registerSceneWithShadowSupport(scene);
await startEngine(engine);
