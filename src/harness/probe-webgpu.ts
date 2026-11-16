import type { FrameCounters, Mode } from './types';

// Engine-agnostic WebGPU instrumentation, installed by patching GPU* prototypes before any
// engine code runs. Timing mode only touches rare calls (device/pipeline/buffer creation,
// pass begin, submit) so per-draw overhead is zero; counters mode also wraps the hot calls.

const QUERIES_PER_FRAME = 256;
const RING = 8;

type Slot = { qs: GPUQuerySet; resolve: GPUBuffer; readback: GPUBuffer; used: number; frame: number; busy: boolean };

export interface GpuFrameTime {
  /** First pass begin → last pass end (primary: TBDR passes overlap, so sums overcount). */
  span: number;
  /** Sum of individual pass durations. */
  sum: number;
  /** Union of the pass intervals: time the GPU was running any of the frame's passes, counting overlaps once and gaps never. */
  busy: number;
  passes: number;
}

const TEXEL_BYTES: Record<string, number> = {
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1,
  rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2, r16float: 2, r16uint: 2, r16sint: 2, depth16unorm: 2,
  rgba8unorm: 4, 'rgba8unorm-srgb': 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
  rgb10a2unorm: 4, rgb10a2uint: 4, rg11b10ufloat: 4, rgb9e5ufloat: 4, r32float: 4, r32uint: 4, r32sint: 4,
  rg16float: 4, rg16uint: 4, rg16sint: 4, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4,
  'depth32float-stencil8': 8, rgba16float: 8, rgba16uint: 8, rgba16sint: 8, rg32float: 8, rg32uint: 8, rg32sint: 8,
  rgba32float: 16, rgba32uint: 16, rgba32sint: 16,
};

function texelBytes(format: string) {
  if (format in TEXEL_BYTES) return TEXEL_BYTES[format];
  if (/^(bc1|bc4|etc2-rgb8|eac-r11)/.test(format)) return 0.5;
  if (/^(bc|astc|etc2|eac)/.test(format)) return 1;
  return 4;
}

function textureBytes(desc: GPUTextureDescriptor) {
  const s = desc.size as any;
  const seq = typeof s[Symbol.iterator] === 'function' ? [...s] : null;
  const w = seq ? seq[0] : s.width;
  const h = (seq ? seq[1] : s.height) ?? 1;
  const d = (seq ? seq[2] : s.depthOrArrayLayers) ?? 1;
  const mips = desc.mipLevelCount ?? 1;
  const is3d = desc.dimension === '3d';
  let texels = 0;
  for (let l = 0; l < mips; l++) texels += Math.max(1, w >> l) * Math.max(1, h >> l) * (is3d ? Math.max(1, d >> l) : d);
  return texels * texelBytes(desc.format) * (desc.sampleCount ?? 1);
}

export class WebGPUProbe {
  adapter: GPUAdapter | null = null;
  device: GPUDevice | null = null;
  timestamps = false;
  canvasConfig: Record<string, unknown> | null = null;
  errors: string[] = [];
  gpuTimes = new Map<number, GpuFrameTime>();
  totals = { renderPipelines: 0, computePipelines: 0, shaderModules: 0, bindGroups: 0, buffers: 0, textures: 0, bundles: 0 };
  mem = { buffer: 0, texture: 0, peakBuffer: 0, peakTexture: 0 };
  frame: FrameCounters = {};
  readonly counting: boolean;

  private slots: Slot[] = [];
  private cur: Slot | null = null;
  private encoders = new WeakSet<GPUCommandEncoder>();
  private orig: { createCommandEncoder?: GPUDevice['createCommandEncoder']; submit?: GPUQueue['submit']; createBuffer?: GPUDevice['createBuffer'] } = {};

  constructor(
    readonly mode: Mode,
    readonly timing = true,
  ) {
    this.counting = mode === 'counters';
  }

  inc(key: string, by = 1) {
    this.frame[key] = (this.frame[key] ?? 0) + by;
  }

  takeFrame(): FrameCounters {
    const f = this.frame;
    this.frame = {};
    return f;
  }

  pipelinesCreated() {
    return this.totals.renderPipelines + this.totals.computePipelines;
  }

  error(msg: string) {
    if (this.errors.length < 20) this.errors.push(msg.slice(0, 500));
  }

  attach(device: GPUDevice, adapter: GPUAdapter) {
    this.device = device;
    this.adapter = adapter;
    this.timestamps = this.timing && device.features.has('timestamp-query');
    device.addEventListener('uncapturederror', (e: Event) => this.error(`uncaptured: ${(e as GPUUncapturedErrorEvent).error?.message}`));
    device.lost.then((info) => this.error(`device lost (${info.reason}): ${info.message}`));
    this.slots = [];
    if (this.timestamps) {
      const createBuffer = this.orig.createBuffer!;
      for (let i = 0; i < RING; i++) {
        this.slots.push({
          qs: device.createQuerySet({ type: 'timestamp', count: QUERIES_PER_FRAME }),
          resolve: createBuffer.call(device, { size: QUERIES_PER_FRAME * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          readback: createBuffer.call(device, { size: QUERIES_PER_FRAME * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          used: 0,
          frame: -1,
          busy: false,
        });
      }
    }
    this.cur = this.slots[0] ?? null;
  }

  tagEncoder(device: GPUDevice, enc: GPUCommandEncoder) {
    if (device === this.device) this.encoders.add(enc);
  }

  /** Returns a descriptor copy with our timestampWrites, never mutating the engine's (often cached) object. */
  inject<T extends GPURenderPassDescriptor | GPUComputePassDescriptor>(enc: GPUCommandEncoder, desc: T | undefined): T | undefined {
    const s = this.cur;
    if (!s || (desc && desc.timestampWrites) || s.used + 2 > QUERIES_PER_FRAME || !this.encoders.has(enc)) return desc;
    const i = s.used;
    s.used += 2;
    return { ...(desc as object), timestampWrites: { querySet: s.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } } as T;
  }

  /** Call after the frame's work has been submitted: resolves this frame's queries asynchronously. */
  endFrame(frameIndex: number) {
    const s = this.cur;
    const device = this.device;
    if (!device) return;
    const used = s?.used ?? 0;
    if (s && used > 0) {
      const enc = this.orig.createCommandEncoder!.call(device);
      enc.resolveQuerySet(s.qs, 0, used, s.resolve, 0);
      enc.copyBufferToBuffer(s.resolve, 0, s.readback, 0, used * 8);
      this.orig.submit!.call(device.queue, [enc.finish()]);
      s.busy = true;
      s.frame = frameIndex;
      s.readback
        .mapAsync(GPUMapMode.READ, 0, used * 8)
        .then(() => {
          const t = new BigInt64Array(s.readback.getMappedRange(0, used * 8));
          const spans: [bigint, bigint][] = [];
          let sum = 0;
          for (let i = 0; i < used; i += 2) {
            const b = t[i], e = t[i + 1];
            if (b === 0n || e === 0n || e < b) continue;
            spans.push([b, e]);
            sum += Number(e - b);
          }
          s.readback.unmap();
          if (!spans.length) return;
          spans.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
          let busy = 0n, [runB, runE] = spans[0];
          for (const [b, e] of spans) {
            if (b > runE) {
              busy += runE - runB;
              runB = b;
              runE = e;
            } else if (e > runE) runE = e;
          }
          busy += runE - runB;
          this.gpuTimes.set(s.frame, { span: Number(runE - spans[0][0]) / 1e6, sum: sum / 1e6, busy: Number(busy) / 1e6, passes: spans.length });
        })
        .catch(() => {})
        .finally(() => {
          s.busy = false;
          s.used = 0;
        });
    }
    // Next frame records into a free slot; if every slot is still mapping, that frame goes untimed.
    this.cur = this.slots.find((x) => !x.busy && x !== s) ?? (s && !s.busy ? s : null);
  }

  /** Wait for outstanding timestamp readbacks. */
  async flush() {
    if (!this.device) return;
    await this.device.queue.onSubmittedWorkDone();
    for (let i = 0; i < 20 && this.slots.some((s) => s.busy); i++) await new Promise((r) => setTimeout(r, 25));
  }

  report() {
    const info = this.adapter?.info;
    return {
      timestamps: this.timestamps,
      adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
      canvas: this.canvasConfig,
      features: this.device ? [...this.device.features].sort() : [],
      totals: { ...this.totals },
      mem: { ...this.mem },
      errors: this.errors,
    };
  }

  install() {
    const p = this;
    type Fn = (...args: any[]) => any;
    const wrap = (proto: any, name: string, make: (orig: Fn) => Fn) => {
      const orig = proto?.[name];
      if (typeof orig !== 'function') return;
      proto[name] = make(orig);
    };

    this.orig.createCommandEncoder = GPUDevice.prototype.createCommandEncoder;
    this.orig.submit = GPUQueue.prototype.submit;
    this.orig.createBuffer = GPUDevice.prototype.createBuffer;

    wrap(GPUAdapter.prototype, 'requestDevice', (orig) => async function (this: GPUAdapter, desc?: GPUDeviceDescriptor) {
      const d: GPUDeviceDescriptor = { ...(desc ?? {}) };
      if (p.timing && this.features.has('timestamp-query')) {
        const f = new Set<GPUFeatureName>([...(d.requiredFeatures ?? [])]);
        f.add('timestamp-query');
        d.requiredFeatures = [...f];
      }
      const device: GPUDevice = await orig.call(this, d);
      p.attach(device, this);
      return device;
    });

    wrap(GPUCanvasContext.prototype, 'configure', (orig) => function (this: GPUCanvasContext, cfg: GPUCanvasConfiguration) {
      p.canvasConfig = { format: cfg.format, alphaMode: cfg.alphaMode ?? 'opaque', toneMapping: (cfg as any).toneMapping?.mode ?? 'standard', colorSpace: cfg.colorSpace ?? 'srgb', sameDevice: cfg.device === p.device };
      return orig.call(this, cfg);
    });

    wrap(GPUDevice.prototype, 'createCommandEncoder', (orig) => function (this: GPUDevice, desc?: GPUCommandEncoderDescriptor) {
      const enc = orig.call(this, desc);
      p.tagEncoder(this, enc);
      if (p.counting) p.inc('commandEncoders');
      return enc;
    });

    wrap(GPUCommandEncoder.prototype, 'beginRenderPass', (orig) => function (this: GPUCommandEncoder, desc: GPURenderPassDescriptor) {
      p.inc('renderPasses');
      return orig.call(this, p.inject(this, desc));
    });
    wrap(GPUCommandEncoder.prototype, 'beginComputePass', (orig) => function (this: GPUCommandEncoder, desc?: GPUComputePassDescriptor) {
      p.inc('computePasses');
      return orig.call(this, p.inject(this, desc));
    });

    wrap(GPUQueue.prototype, 'submit', (orig) => function (this: GPUQueue, cbs: GPUCommandBuffer[]) {
      p.inc('submits');
      return orig.call(this, cbs);
    });

    // Creation counters + GPU memory estimate (explicitly destroyed resources only).
    const bufSize = new WeakMap<GPUBuffer, number>();
    const texSize = new WeakMap<GPUTexture, number>();
    wrap(GPUDevice.prototype, 'createBuffer', (orig) => function (this: GPUDevice, desc: GPUBufferDescriptor) {
      const b = orig.call(this, desc);
      if (this === p.device) {
        bufSize.set(b, desc.size);
        p.mem.buffer += desc.size;
        p.mem.peakBuffer = Math.max(p.mem.peakBuffer, p.mem.buffer);
        p.totals.buffers++;
        p.inc('buffersCreated');
      }
      return b;
    });
    wrap(GPUBuffer.prototype, 'destroy', (orig) => function (this: GPUBuffer) {
      const s = bufSize.get(this);
      if (s !== undefined) {
        p.mem.buffer -= s;
        bufSize.delete(this);
      }
      return orig.call(this);
    });
    wrap(GPUDevice.prototype, 'createTexture', (orig) => function (this: GPUDevice, desc: GPUTextureDescriptor) {
      const t = orig.call(this, desc);
      if (this === p.device) {
        const bytes = textureBytes(desc);
        texSize.set(t, bytes);
        p.mem.texture += bytes;
        p.mem.peakTexture = Math.max(p.mem.peakTexture, p.mem.texture);
        p.totals.textures++;
        p.inc('texturesCreated');
      }
      return t;
    });
    wrap(GPUTexture.prototype, 'destroy', (orig) => function (this: GPUTexture) {
      const s = texSize.get(this);
      if (s !== undefined) {
        p.mem.texture -= s;
        texSize.delete(this);
      }
      return orig.call(this);
    });
    const creation = (name: string, total: keyof WebGPUProbe['totals']) =>
      wrap(GPUDevice.prototype, name, (orig) => function (this: GPUDevice, ...args: any[]) {
        p.totals[total]++;
        p.inc(name);
        return orig.apply(this, args);
      });
    creation('createRenderPipeline', 'renderPipelines');
    creation('createRenderPipelineAsync', 'renderPipelines');
    creation('createComputePipeline', 'computePipelines');
    creation('createComputePipelineAsync', 'computePipelines');
    creation('createShaderModule', 'shaderModules');
    creation('createBindGroup', 'bindGroups');

    if (!this.counting) return;

    // --- Hot-path counters (counters mode only) ---
    const count = (proto: any, name: string, key: string, extra?: (args: any[]) => void) =>
      wrap(proto, name, (orig) => function (this: any, ...args: any[]) {
        p.frame[key] = (p.frame[key] ?? 0) + 1;
        if (extra) extra(args);
        return orig.apply(this, args);
      });
    const RP = GPURenderPassEncoder.prototype;
    count(RP, 'draw', 'draws', (a) => {
      const inst = a[1] ?? 1;
      p.inc('instances', inst);
      p.inc('triangles', Math.floor(a[0] / 3) * inst);
    });
    count(RP, 'drawIndexed', 'draws', (a) => {
      const inst = a[1] ?? 1;
      p.inc('instances', inst);
      p.inc('triangles', Math.floor(a[0] / 3) * inst);
    });
    count(RP, 'drawIndirect', 'draws', () => p.inc('indirectDraws'));
    count(RP, 'drawIndexedIndirect', 'draws', () => p.inc('indirectDraws'));
    count(RP, 'setPipeline', 'setPipeline');
    count(RP, 'setBindGroup', 'setBindGroup');
    count(RP, 'setVertexBuffer', 'setVertexBuffer');
    count(RP, 'setIndexBuffer', 'setIndexBuffer');

    // A bundle's draws are recorded once and replayed by executeBundles, so the work is credited on every replay.
    type BundleWork = { draws: number; instances: number; triangles: number; indirect: number };
    const bundleWork = new WeakMap<GPURenderBundle, BundleWork>();
    const recording = new WeakMap<GPURenderBundleEncoder, BundleWork>();
    const recorded = (enc: GPURenderBundleEncoder) => {
      let w = recording.get(enc);
      if (!w) recording.set(enc, (w = { draws: 0, instances: 0, triangles: 0, indirect: 0 }));
      w.draws++;
      return w;
    };
    const RB = GPURenderBundleEncoder.prototype;
    for (const name of ['draw', 'drawIndexed']) {
      wrap(RB, name, (orig) => function (this: GPURenderBundleEncoder, ...args: any[]) {
        const w = recorded(this);
        const inst = args[1] ?? 1;
        w.instances += inst;
        w.triangles += Math.floor(args[0] / 3) * inst;
        return orig.apply(this, args);
      });
    }
    for (const name of ['drawIndirect', 'drawIndexedIndirect']) {
      wrap(RB, name, (orig) => function (this: GPURenderBundleEncoder, ...args: any[]) {
        recorded(this).indirect++;
        return orig.apply(this, args);
      });
    }
    wrap(RB, 'finish', (orig) => function (this: GPURenderBundleEncoder, desc?: GPURenderBundleDescriptor) {
      const b = orig.call(this, desc);
      const w = recording.get(this);
      if (w) bundleWork.set(b, w);
      p.totals.bundles++;
      p.inc('bundlesCreated');
      return b;
    });
    wrap(RP, 'executeBundles', (orig) => function (this: GPURenderPassEncoder, bundles: Iterable<GPURenderBundle>) {
      const list = [...bundles];
      p.inc('executeBundles');
      for (const b of list) {
        const w = bundleWork.get(b);
        if (!w) continue;
        p.inc('bundleDraws', w.draws);
        p.inc('draws', w.draws);
        p.inc('instances', w.instances);
        p.inc('triangles', w.triangles);
        if (w.indirect) p.inc('indirectDraws', w.indirect);
      }
      return orig.call(this, list);
    });

    const CP = GPUComputePassEncoder.prototype;
    count(CP, 'dispatchWorkgroups', 'dispatches');
    count(CP, 'dispatchWorkgroupsIndirect', 'dispatches');
    count(CP, 'setPipeline', 'computeSetPipeline');
    count(CP, 'setBindGroup', 'computeSetBindGroup');

    const Q = GPUQueue.prototype;
    count(Q, 'writeBuffer', 'writeBuffer', (a) => {
      const data = a[2];
      const bpe = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data ? (data as any).BYTES_PER_ELEMENT : 1;
      const bytes = a[4] !== undefined ? a[4] * bpe : data.byteLength - (a[3] ?? 0) * bpe;
      p.inc('writeBufferBytes', bytes);
    });
    count(Q, 'writeTexture', 'writeTexture');
  }
}

export function installWebGPUProbe(mode: Mode, timing = true): WebGPUProbe | null {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || typeof GPUDevice === 'undefined') return null;
  const p = new WebGPUProbe(mode, timing);
  p.install();
  return p;
}
