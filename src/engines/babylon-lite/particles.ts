import {
  addComputeDispatch, addRenderDraw, addTask, computeStorageBufferBinding, createComputeBindingSet, createComputeDispatch,
  createComputeShader, createComputeTask, createRenderBindingSet, createRenderDraw, createRenderDrawTask, createRenderShader,
  createRenderTarget, createRenderTask, createStorageBuffer, getViewMatrix, getViewProjectionMatrix, prepareComputeShader,
  prepareRenderShader, updateStorageBuffer,
} from '@babylonjs/lite';
import type { ParticlesScene } from '../../harness/types';
import type { Built, LiteCtx } from './index';

const WORKGROUP = 256;

const SIM = /* wgsl */ `
struct Params { t: f32, dt: f32, count: f32, bounds: f32, radius: f32, speed: f32, strength: f32, damping: f32 };
@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u32(params.count)) { return; }
  let a = params.t * params.speed;
  let attractor = vec3f(cos(a) * params.radius, sin(a * 1.3) * params.radius * 0.5, sin(a) * params.radius);
  var p = pos[i].xyz;
  var v = vel[i].xyz;
  let d = attractor - p;
  v += d * (params.strength / (dot(d, d) + 1.0)) * params.dt;
  v *= params.damping;
  p += v * params.dt;
  let out = abs(p) > vec3f(params.bounds);
  p = select(p, sign(p) * params.bounds, out);
  v = select(v, -v * 0.8, out);
  pos[i] = vec4f(p, 1.0);
  vel[i] = vec4f(v, 0.0);
}`;

// Unlit and outside the material system: encode linear → sRGB here.
const DRAW = /* wgsl */ `
struct Camera { viewProjection: mat4x4f, right: vec4f, up: vec4f };
@group(0) @binding(0) var<storage, read> camera: Camera;
struct Out { @builtin(position) position: vec4f, @location(0) color: vec3f };

@vertex
fn vertexMain(@builtin(vertex_index) vi: u32, @location(0) ppos: vec4f, @location(1) pvel: vec4f) -> Out {
  const corners = array<vec2f, 6>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5));
  let c = corners[vi];
  var out: Out;
  // right.w carries the quad size
  out.position = camera.viewProjection * vec4f(ppos.xyz + (camera.right.xyz * c.x + camera.up.xyz * c.y) * camera.right.w, 1.0);
  out.color = mix(vec3f(0.1, 0.3, 1.0), vec3f(1.0, 0.5, 0.1), clamp(length(pvel.xyz) / 6.0, 0.0, 1.0));
  return out;
}

@fragment
fn fragmentMain(in: Out) -> @location(0) vec4f {
  let c = in.color;
  return vec4f(select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)), 1.0);
}`;

/** Needs a scene created without its default render task: the particle pass owns the MSAA target. */
export async function buildParticles(ctx: LiteCtx, d: ParticlesScene): Promise<Built> {
  const { engine, scene, camera } = ctx;
  const n = d.count;
  const pos = createStorageBuffer(engine, d.initPosition, { writable: true, vertex: true, label: 'particlePos' });
  const vel = createStorageBuffer(engine, d.initVelocity, { writable: true, vertex: true, label: 'particleVel' });
  const { attractorRadius: radius, attractorSpeed: speed, strength, damping } = d.sim;
  const params = new Float32Array([0, 0, n, d.bounds, radius, speed, strength, damping]);
  // Storage rather than uniform: the same StorageBuffer API updates it with one call per frame.
  const paramsBuffer = createStorageBuffer(engine, params, { writable: true, label: 'particleParams' });
  const cam = new Float32Array(24);
  const camBuffer = createStorageBuffer(engine, cam, { writable: true, label: 'particleCamera' });

  const sim = createComputeShader(engine, {
    name: 'particleSim',
    computeSource: SIM,
    bindings: [
      computeStorageBufferBinding('params', { group: 0, binding: 0 }),
      computeStorageBufferBinding('pos', { group: 0, binding: 1, access: 'read-write' }),
      computeStorageBufferBinding('vel', { group: 0, binding: 2, access: 'read-write' }),
    ],
  });
  const simTask = createComputeTask(engine, 'particleSim');
  addComputeDispatch(simTask, createComputeDispatch(sim, createComputeBindingSet(sim, { params: paramsBuffer, pos, vel }), { size: { x: Math.ceil(n / WORKGROUP) } }));

  const instanced = (shaderLocation: number): GPUVertexBufferLayout => ({ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation, offset: 0, format: 'float32x4' }] });
  const shader = createRenderShader(engine, {
    name: 'particles',
    renderSource: DRAW,
    bindings: [computeStorageBufferBinding('camera', { group: 0, binding: 0 })],
    vertexBuffers: [instanced(0), instanced(1)],
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depth: { depthWriteEnabled: true },
  });
  const target = createRenderTarget({ lbl: 'particles', format: engine.format, dFormat: 'depth24plus-stencil8', samples: engine.msaaSamples, size: engine });
  const drawTask = createRenderDrawTask(engine, { name: 'particles', target, clear: true, clearColor: scene.clearColor });
  addRenderDraw(drawTask, createRenderDraw(shader, createRenderBindingSet(shader, { camera: camBuffer }), { vertexCount: 6, instanceCount: n, vertexBuffers: [pos, vel] }));

  addTask(scene, simTask);
  addTask(scene, drawTask);
  // A draw task has no resolve target: an empty scene pass over the same target resolves it into the swapchain.
  addTask(scene, createRenderTask({ name: 'resolve', rt: target, rst: engine.scRT, clr: false, depthClear: false, sharedRt: true }, engine, scene));

  const canvas = engine.canvas as HTMLCanvasElement;
  return {
    path: 'ComputeTask (WGSL) + StorageBuffers bound as instanced vertex buffers, RenderShader draw task',
    async afterReady() {
      await Promise.all([prepareComputeShader(sim), prepareRenderShader(shader, target)]);
    },
    update(t, dt) {
      params[0] = t;
      params[1] = dt;
      updateStorageBuffer(engine, paramsBuffer, params);
      const view = getViewMatrix(camera) as unknown as ArrayLike<number>;
      cam.set(getViewProjectionMatrix(camera, canvas.width / canvas.height) as unknown as ArrayLike<number>);
      cam.set([view[0], view[4], view[8], d.size, view[1], view[5], view[9], 0], 16);
      updateStorageBuffer(engine, camBuffer, cam);
    },
  };
}
