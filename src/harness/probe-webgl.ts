import type { FrameCounters, Mode } from './types';

// WebGL2 counterpart of probe-webgpu: captures the engine's context, times each frame with
// EXT_disjoint_timer_query_webgl2 where the browser exposes it, and counts calls in counters mode.

export class WebGLProbe {
  gl: WebGL2RenderingContext | null = null;
  timer: any = null;
  contextAttributes: WebGLContextAttributes | null = null;
  frame: FrameCounters = {};
  totals = { programsLinked: 0, shadersCompiled: 0 };
  /** Live object counts: WebGL exposes no sizes, so leaks show up as counts that keep growing. */
  live = { buffers: 0, textures: 0, programs: 0 };
  gpuTimes = new Map<number, number>();
  errors: string[] = [];
  readonly counting: boolean;
  private active: { q: WebGLQuery; frame: number } | null = null;
  private pending: { q: WebGLQuery; frame: number }[] = [];

  constructor(readonly mode: Mode) {
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
    return this.totals.programsLinked;
  }

  beginFrame(frameIndex: number) {
    const gl = this.gl, ext = this.timer;
    if (!gl || !ext || this.active) return;
    const q = gl.createQuery();
    if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = { q, frame: frameIndex };
  }

  endFrame() {
    const gl = this.gl, ext = this.timer;
    if (!gl || !ext || !this.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  poll() {
    const gl = this.gl, ext = this.timer;
    if (!gl || !ext || this.pending.length === 0) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (let i = 0; i < this.pending.length; ) {
      const { q, frame } = this.pending[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!disjoint) this.gpuTimes.set(frame, gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q);
        this.pending.splice(i, 1);
      } else i++;
    }
  }

  async flush() {
    for (let i = 0; i < 20 && this.pending.length; i++) {
      await new Promise((r) => setTimeout(r, 25));
      this.poll();
    }
  }

  report() {
    const gl = this.gl;
    let renderer: string | null = null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
    return {
      timer: !!this.timer,
      renderer,
      contextAttributes: this.contextAttributes,
      totals: { ...this.totals },
      live: { ...this.live },
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

    wrap(HTMLCanvasElement.prototype, 'getContext', (orig) => function (this: HTMLCanvasElement, type: string, attrs?: any) {
      const ctx = orig.call(this, type, attrs);
      if (type === 'webgl2' && ctx && !p.gl) {
        p.gl = ctx;
        p.timer = ctx.getExtension('EXT_disjoint_timer_query_webgl2');
        p.contextAttributes = ctx.getContextAttributes();
        this.addEventListener('webglcontextlost', () => p.errors.push('webgl context lost'));
      }
      return ctx;
    });

    const GL = WebGL2RenderingContext.prototype;
    wrap(GL, 'linkProgram', (orig) => function (this: WebGL2RenderingContext, prog: WebGLProgram) {
      p.totals.programsLinked++;
      p.inc('linkProgram');
      return orig.call(this, prog);
    });
    wrap(GL, 'compileShader', (orig) => function (this: WebGL2RenderingContext, sh: WebGLShader) {
      p.totals.shadersCompiled++;
      return orig.call(this, sh);
    });

    for (const [kind, key] of [['Buffer', 'buffers'], ['Texture', 'textures'], ['Program', 'programs']] as const) {
      wrap(GL, `create${kind}`, (orig) => function (this: any) {
        p.live[key]++;
        return orig.call(this);
      });
      wrap(GL, `delete${kind}`, (orig) => function (this: any, o: unknown) {
        if (o) p.live[key]--;
        return orig.call(this, o);
      });
    }

    if (!this.counting) return;

    const count = (name: string, key: string, extra?: (args: any[]) => void) =>
      wrap(GL, name, (orig) => function (this: any, ...args: any[]) {
        p.frame[key] = (p.frame[key] ?? 0) + 1;
        if (extra) extra(args);
        return orig.apply(this, args);
      });
    const tris = (n: number, inst = 1) => {
      p.inc('instances', inst);
      p.inc('triangles', Math.floor(n / 3) * inst);
    };
    count('drawArrays', 'draws', (a) => tris(a[2]));
    count('drawElements', 'draws', (a) => tris(a[1]));
    count('drawRangeElements', 'draws', (a) => tris(a[3]));
    count('drawArraysInstanced', 'draws', (a) => tris(a[2], a[3]));
    count('drawElementsInstanced', 'draws', (a) => tris(a[1], a[4]));
    count('useProgram', 'useProgram');
    count('bindVertexArray', 'bindVertexArray');
    count('bindBuffer', 'bindBuffer');
    count('bindBufferBase', 'bindBufferRange');
    count('bindBufferRange', 'bindBufferRange');
    count('bindTexture', 'bindTexture');
    count('bindFramebuffer', 'bindFramebuffer');
    const bytesOf = (d: any) => (d && typeof d.byteLength === 'number' ? d.byteLength : typeof d === 'number' ? d : 0);
    count('bufferData', 'bufferData', (a) => p.inc('uploadBytes', bytesOf(a[1])));
    count('bufferSubData', 'bufferSubData', (a) => p.inc('uploadBytes', bytesOf(a[2])));
    count('texSubImage2D', 'texUploads');
    count('texImage2D', 'texUploads');
    for (const name of Object.getOwnPropertyNames(GL)) {
      if (/^uniform(Matrix)?[1-4]/.test(name)) count(name, 'uniformCalls');
    }
  }
}

export function installWebGLProbe(mode: Mode): WebGLProbe | null {
  if (typeof WebGL2RenderingContext === 'undefined') return null;
  const p = new WebGLProbe(mode);
  p.install();
  return p;
}
