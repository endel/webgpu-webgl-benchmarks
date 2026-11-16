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

/** A buffer whose bytes live in memory, so copies and readbacks can be checked. */
interface FakeBuffer { usage: number; bytes: Uint8Array; mapAsync(): Promise<void>; getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void }
const fakeBuffer = (desc: { size: number; usage: number }): FakeBuffer => {
  const bytes = new Uint8Array(desc.size);
  return { usage: desc.usage, bytes, mapAsync: async () => {}, getMappedRange: () => bytes.buffer, unmap() {}, destroy() {} };
};
const CommandEncoder = stub(['beginComputePass'], {
  beginRenderPass: () => new RenderPass(),
  // Copies land at once, in the order they are recorded.
  copyBufferToBuffer: (src, srcOffset, dst, dstOffset, size) => {
    const [s, d] = [src as FakeBuffer, dst as FakeBuffer];
    d.bytes.set(s.bytes.subarray(srcOffset as number, (srcOffset as number) + (size as number)), dstOffset as number);
  },
  finish: () => ({}),
});
Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1, WRITE: 2 },
  GPUDevice: stub(['createTexture', 'createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync', 'createShaderModule', 'createBindGroup'], {
    createBuffer: (desc) => fakeBuffer(desc as { size: number; usage: number }),
    createCommandEncoder: () => new CommandEncoder(),
  }),
  GPUQueue: stub(['submit', 'writeBuffer', 'writeTexture', 'onSubmittedWorkDone']),
  GPUAdapter: stub(['requestDevice']),
  GPUCanvasContext: stub(['configure']),
  GPUCommandEncoder: CommandEncoder,
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

test('indirect draws are credited with the arguments they drew with, bundle replays included', async () => {
  const device = Object.assign(new (globalThis as any).GPUDevice(), { features: new Set(), addEventListener() {}, lost: new Promise(() => {}), queue: new (globalThis as any).GPUQueue() });
  gpu.attach(device, {} as GPUAdapter);
  const { INDIRECT, STORAGE, COPY_SRC } = (globalThis as any).GPUBufferUsage;
  const args = device.createBuffer({ size: 64, usage: INDIRECT | STORAGE }) as FakeBuffer;
  assert.ok(args.usage & COPY_SRC, 'counters runs make indirect buffers copyable');
  const words = new Uint32Array(args.bytes.buffer);
  words.set([6, 4, 0, 0], 0); // drawIndirect: 6 vertices × 4 instances
  words.set([36, 10, 0, 0, 0], 5); // drawIndexedIndirect at byte 20: 36 indices × 10 instances

  const rec = new BundleEncoder();
  rec.drawIndirect(args, 0);
  const bundle = rec.finish();
  gpu.takeFrame();

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({});
  pass.drawIndexedIndirect(args, 20);
  pass.executeBundles([bundle]);
  pass.executeBundles([bundle]);
  pass.end();
  words.set([0, 0, 0, 0, 0], 5); // a later pass rewrites the arguments; the copy kept what this pass drew
  device.queue.submit([enc.finish()]);
  gpu.endFrame(7);
  await gpu.flush();

  assert.deepEqual(gpu.indirectWork.get(7), { instances: 18, triangles: 136 });
  assert.equal(gpu.takeFrame().indirectDraws, 3);
});

test('an indirect buffer the probe could not make copyable is counted as unreadable', () => {
  const foreign = fakeBuffer({ size: 20, usage: 256 });
  const pass = new CommandEncoder().beginRenderPass({}) as Methods;
  gpu.takeFrame();
  pass.drawIndirect(foreign, 0);
  pass.end();
  assert.deepEqual(gpu.takeFrame(), { draws: 1, indirectDraws: 1, indirectUnreadable: 1 });
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
