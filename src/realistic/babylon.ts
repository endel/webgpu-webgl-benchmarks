// "Realistic feature set" app — bundled to measure shipped size, never run.
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import '@babylonjs/loaders/glTF/2.0';

const canvas = document.querySelector('canvas')!;
const engine = new WebGPUEngine(canvas, { antialias: true });
await engine.initAsync();
const scene = new Scene(engine);
scene.ambientColor = new Color3(0.3, 0.3, 0.3);
scene.imageProcessingConfiguration.toneMappingEnabled = true;
scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
const camera = new ArcRotateCamera('camera', Math.PI / 4, Math.PI / 3, 250, new Vector3(0, 40, 0), scene);

const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene);
sun.position = new Vector3(80, 200, 60);
sun.intensity = 3;
const shadows = new ShadowGenerator(2048, sun);
shadows.usePercentageCloserFiltering = true;

const ground = CreateGround('ground', { width: 600, height: 600 }, scene);
ground.material = new PBRMaterial('ground', scene);
ground.receiveShadows = true;

const fox = await LoadAssetContainerAsync('assets/Fox/Fox.glb', scene);
fox.addAllToScene();
for (const m of fox.meshes) shadows.addShadowCaster(m);
fox.animationGroups[0].start(true);

const post = new DefaultRenderingPipeline('post', true, scene, [camera]);
post.samples = 4;
post.bloomEnabled = true;

engine.runRenderLoop(() => scene.render());
