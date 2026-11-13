// A small "realistic" app on the classic WebGLRenderer (glTF, animation, shadows, bloom + ACES) — used only to measure the shipped bundle size.
import { WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, AmbientLight, AnimationMixer, Mesh, PlaneGeometry, MeshStandardMaterial, ACESFilmicToneMapping, Vector2 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const canvas = document.querySelector('canvas')!;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.toneMapping = ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
const scene = new Scene();
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(0, 1.2, 3);
camera.lookAt(0, 0.5, 0);

const sun = new DirectionalLight(0xffffff, 3);
sun.position.set(2, 4, 3);
sun.castShadow = true;
const ground = new Mesh(new PlaneGeometry(20, 20), new MeshStandardMaterial({ color: 0x808080 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(sun, ground, new AmbientLight(0xffffff, 0.5));

const gltf = await new GLTFLoader().loadAsync('assets/Fox/Fox.glb');
gltf.scene.scale.setScalar(0.01);
gltf.scene.traverse((o) => {
  o.castShadow = true;
});
scene.add(gltf.scene);
const mixer = new AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations[0]).play();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new Vector2(canvas.width, canvas.height), 0.6, 0.5, 0.85));
composer.addPass(new OutputPass());

let last = 0;
renderer.setAnimationLoop((t) => {
  mixer.update((t - last) / 1000);
  last = t;
  composer.render();
});
