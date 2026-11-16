import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebGLProbe } from './probe-webgl';
import { WebGPUProbe } from './probe-webgpu';

type Methods = Record<string, (...args: unknown[]) => unknown>;

/** Stand-in for a browser interface: a class whose prototype has a no-op per method name. */
function stub(names: string[], overrides: Methods = {}) {
  class Stub {}
  Object.assign(Stub.prototype, Object.fromEntries(names.map((n) => [n, () => undefined])), overrides);
  return Stub as unknown as new () => Methods;
}

const DRAWS = ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'];
const RenderPass = stub([...DRAWS, 'setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'executeBundles', 'end']);
const BundleEncoder = stub([...DRAWS, 'setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer'], { finish: () => ({}) });
Object.assign(globalThis, {
  GPUDevice: stub(['createCommandEncoder', 'createBuffer', 'createTexture', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync', 'createShaderModule', 'createBindGroup']),
  GPUQueue: stub(['submit', 'writeBuffer', 'writeTexture', 'onSubmittedWorkDone']),
  GPUAdapter: stub(['requestDevice']),
  GPUCanvasContext: stub(['configure']),
  GPUCommandEncoder: stub(['beginRenderPass', 'beginComputePass', 'finish']),
  GPUBuffer: stub(['destroy']),
  GPUTexture: stub(['destroy']),
  GPURenderPassEncoder: RenderPass,
  GPURenderBundleEncoder: BundleEncoder,
  GPUComputePassEncoder: stub(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'setPipeline', 'setBindGroup']),
});

const MULTI_DRAW = ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL'];
const multiDraw = new (stub(MULTI_DRAW))();
const GL = stub(
  ['linkProgram', 'compileShader', 'drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced', 'useProgram', 'bufferData', 'bufferSubData', 'deleteBuffer', 'deleteTexture', 'deleteProgram'],
  {
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createProgram: () => ({}),
    getExtension: (name) => (name === 'WEBGL_multi_draw' ? multiDraw : null),
  },
);
Object.assign(globalThis, { HTMLCanvasElement: stub(['getContext']), WebGL2RenderingContext: GL });

const gpu = new WebGPUProbe('counters');
gpu.install();
const gl = new WebGLProbe('counters');
gl.install();
const ctx = new GL();

test('render bundle work is credited on every executeBundles', () => {
  const enc = new BundleEncoder();
  enc.drawIndexed(36, 10);
  enc.drawIndexedIndirect({}, 0);
  const bundle = enc.finish();
  const pass = new RenderPass();
  gpu.takeFrame();

  pass.executeBundles([bundle]);
  const once = { executeBundles: 1, bundleDraws: 2, draws: 2, instances: 10, triangles: 120, indirectDraws: 1 };
  assert.deepEqual(gpu.takeFrame(), once);

  pass.executeBundles([bundle]);
  pass.executeBundles([bundle]);
  assert.deepEqual(gpu.takeFrame(), Object.fromEntries(Object.entries(once).map(([k, v]) => [k, v * 2])));
});

test('draws recorded in a pass are not double counted by bundles', () => {
  const pass = new RenderPass();
  const empty = new BundleEncoder().finish();
  gpu.takeFrame();
  pass.draw(3, 2);
  pass.executeBundles([empty]);
  assert.deepEqual(gpu.takeFrame(), { draws: 1, instances: 2, triangles: 2, executeBundles: 1 });
});

test('a WebGL multi-draw call is one draw with its items counted', () => {
  const ext = ctx.getExtension('WEBGL_multi_draw') as Methods;
  gl.takeFrame();
  ext.multiDrawElementsWEBGL(4, new Int32Array([6, 12]), 0, 5123, new Int32Array([0, 12]), 0, 2);
  assert.deepEqual(gl.takeFrame(), { draws: 1, multiDrawItems: 2, instances: 2, triangles: 6 });

  ext.multiDrawArraysInstancedWEBGL(4, new Int32Array([0, 0, 0]), 0, new Int32Array([99, 3, 6]), 1, new Int32Array([7, 4, 2]), 1, 2);
  assert.deepEqual(gl.takeFrame(), { draws: 1, multiDrawItems: 2, instances: 6, triangles: 8 });
});

test('WebGL upload bytes honour srcOffset and length in elements', () => {
  gl.takeFrame();
  ctx.bufferSubData(34962, 0, new Float32Array(100), 10, 20);
  assert.equal(gl.takeFrame().uploadBytes, 80);
  ctx.bufferSubData(34962, 0, new Float32Array(100), 10);
  assert.equal(gl.takeFrame().uploadBytes, 360);
  ctx.bufferData(34962, 1024, 35044);
  assert.equal(gl.takeFrame().uploadBytes, 1024);
  ctx.bufferData(34962, new Uint16Array(8), 35044);
  assert.equal(gl.takeFrame().uploadBytes, 16);
});

test('WebGL live object counts follow create and delete', () => {
  const before = { ...gl.live };
  const a = ctx.createBuffer(), b = ctx.createBuffer();
  ctx.createTexture();
  ctx.deleteBuffer(a);
  ctx.deleteBuffer(null);
  assert.deepEqual(gl.live, { buffers: before.buffers + 1, textures: before.textures + 1, programs: before.programs });
  ctx.deleteBuffer(b);
  assert.equal(gl.live.buffers, before.buffers);
});
