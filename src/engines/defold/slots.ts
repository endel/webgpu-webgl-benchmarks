// Scene arrays in the wasm heap. Each slot is allocated once with the engine's malloc and filled;
// live slots are refilled from their source before every frame. Lua binds them by id
// (bench.bind) and reads them with bench.get / vec3 / quat / fill4 / bytes.

export interface Emscripten {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  _malloc(bytes: number): number;
  _bench_pick(x: number, y: number): number;
  pauseMainLoop(): void;
  runApp(canvasId: string): void;
  onRuntimeInitialized?: () => void;
}

type Source = ArrayLike<number> | (() => ArrayLike<number>);

interface Slot {
  id: number;
  ptr: number;
  bytes: number;
  kind: 'f32' | 'u8';
  src: Source;
  live: boolean;
}

export class Slots {
  private list: Slot[] = [];
  private byName = new Map<string, Slot>();

  constructor(private readonly module: Emscripten) {}

  /** Float slot of `count` floats (the source's length by default). */
  f32(name: string, src: Source, opts: { live?: boolean; count?: number } = {}) {
    return this.add(name, src, 'f32', opts.count ?? read(src).length, opts.live ?? false);
  }

  /** Byte slot (textures, UTF-8 text). */
  u8(name: string, src: Source, opts: { live?: boolean; count?: number } = {}) {
    return this.add(name, src, 'u8', opts.count ?? read(src).length, opts.live ?? false);
  }

  /** `{ name: { id, ptr, bytes } }`, as bridge.describe() binds them. */
  table() {
    const out: Record<string, { id: number; ptr: number; bytes: number }> = {};
    for (const [name, s] of this.byName) out[name] = { id: s.id, ptr: s.ptr, bytes: s.bytes };
    return out;
  }

  /** Rewrites a slot from new data (at most the slot's size). */
  set(name: string, data: ArrayLike<number>) {
    const s = this.byName.get(name);
    if (!s) throw new Error(`defold: no slot ${name}`);
    if (data.length * (s.kind === 'f32' ? 4 : 1) > s.bytes) throw new Error(`defold: ${data.length} values overflow slot ${name}`);
    s.src = data;
    this.write(s);
  }

  refresh() {
    for (const s of this.list) if (s.live) this.write(s);
  }

  private add(name: string, src: Source, kind: Slot['kind'], count: number, live: boolean) {
    if (this.byName.has(name)) throw new Error(`defold: slot ${name} defined twice`);
    if (read(src).length > count) throw new Error(`defold: slot ${name} holds ${count} values, its source has ${read(src).length}`);
    const bytes = count * (kind === 'f32' ? 4 : 1);
    // 16-byte aligned, so float views start on an element boundary
    const ptr = this.module._malloc(Math.max(16, bytes + 16));
    const s: Slot = { id: this.list.length, ptr: (ptr + 15) & ~15, bytes, kind, src, live };
    this.list.push(s);
    this.byName.set(name, s);
    this.write(s);
    return s;
  }

  private write(s: Slot) {
    // HEAP views are replaced when the wasm memory grows, so they are read fresh every time
    if (s.kind === 'f32') this.module.HEAPF32.set(read(s.src), s.ptr >> 2);
    else this.module.HEAPU8.set(read(s.src), s.ptr);
  }
}

const read = (src: Source) => (typeof src === 'function' ? src() : src);
