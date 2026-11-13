// A small "realistic" app (glTF + animation + shadows + bloom + ACES) — used only to measure the shipped bundle size.
import {
  createGraphicsDevice, AppBase, AppOptions, RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem,
  ContainerHandler, TextureHandler, AnimClipHandler, CameraFrame, Entity, Color, DEVICETYPE_WEBGPU, TONEMAP_ACES2,
  type Asset, type AnimTrack, type ContainerResource,
} from 'playcanvas';

const canvas = document.querySelector('canvas')!;
const device = await createGraphicsDevice(canvas, { deviceTypes: [DEVICETYPE_WEBGPU], antialias: true });
const options = new AppOptions();
options.graphicsDevice = device;
options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem, AnimComponentSystem];
options.resourceHandlers = [ContainerHandler, TextureHandler, AnimClipHandler];
const app = new AppBase(canvas);
app.init(options);

const camera = new Entity();
camera.addComponent('camera', { clearColor: new Color(0.1, 0.1, 0.1) });
camera.setPosition(0, 60, 180);
camera.lookAt(0, 40, 0);
const frame = new CameraFrame(app, camera.camera!);
frame.rendering.samples = 4;
frame.rendering.toneMapping = TONEMAP_ACES2;
frame.bloom.intensity = 0.02;
frame.update();

const sun = new Entity();
sun.addComponent('light', { type: 'directional', castShadows: true, shadowDistance: 500, shadowResolution: 2048, shadowBias: 0.3, normalOffsetBias: 0.2 });
sun.setEulerAngles(45, 30, 0);
const ground = new Entity();
ground.addComponent('render', { type: 'plane' });
ground.setLocalScale(400, 1, 400);
app.root.addChild(camera);
app.root.addChild(sun);
app.root.addChild(ground);

app.assets.loadFromUrl('assets/Fox/Fox.glb', 'container', (err: string | null, asset?: Asset) => {
  if (err || !asset) throw new Error(String(err));
  const res = asset.resource as ContainerResource & { animations: Asset[] };
  const fox = res.instantiateRenderEntity();
  fox.addComponent('anim', { activate: true });
  fox.anim!.assignAnimation('walk', res.animations[1].resource as AnimTrack);
  app.root.addChild(fox);
});
app.start();
