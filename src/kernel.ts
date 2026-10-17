/* kernel — the Rust compute kernel vendored as WASM.
 *
 * ui/vendor/laido_kernel.wasm is compiled from kernels/laido-kernel
 * (cargo build --release --target wasm32-unknown-unknown). Pure compute
 * only: physics + field FD stepping. No DOM, no wasm-bindgen — functions
 * take pointers into wasm linear memory, and the JS side holds typed
 * array views over `exports.memory` (zero per-frame marshalling).
 *
 * Field buffers are n² flat row-major f32 arrays, n ≤ fieldN (160).
 * Loading is lazy + shared: first widget fetches it, rest reuse the
 * instance; a failed fetch keeps callers on their JS fallbacks. */

interface KernelExports {
  memory: WebAssembly.Memory;
  pos_ptr(): number;
  vel_ptr(): number;
  edges_ptr(): number;
  scratch_ptr(): number;
  max_nodes(): number;
  max_edges(): number;
  graph_step(n: number, m: number, w: number, h: number, cool: number, center: number): number;
  field_n(): number;
  u_ptr(): number;
  u_prev_ptr(): number;
  ez_ptr(): number;
  hx_ptr(): number;
  hy_ptr(): number;
  psi_r_ptr(): number;
  psi_i_ptr(): number;
  pot_ptr(): number;
  wave_step(n: number, cfl2: number, damp: number): number;
  em_step(n: number, dt: number, t: number, sx: number, sy: number, freq: number): number;
  qm_step(n: number, dt: number): number;
  qm_seed(n: number, x0: number, y0: number, sigma: number, kx: number): void;
  qm_barrier(n: number, x: number, gapLo: number, gapHi: number, v: number): void;
}

export interface Kernel {
  pos: Float32Array;
  vel: Float32Array;
  edges: Int32Array;
  scratch: Float32Array;
  maxNodes: number;
  maxEdges: number;
  graphStep(n: number, m: number, w: number, h: number, cool: number, center: number): number;
  fieldN: number;
  u: Float32Array;
  uPrev: Float32Array;
  ez: Float32Array;
  hx: Float32Array;
  hy: Float32Array;
  psiR: Float32Array;
  psiI: Float32Array;
  pot: Float32Array;
  waveStep(n: number, cfl2: number, damp: number): number;
  emStep(n: number, dt: number, t: number, sx: number, sy: number, freq: number): number;
  qmStep(n: number, dt: number): number;
  qmSeed(n: number, x0: number, y0: number, sigma: number, kx: number): void;
  qmBarrier(n: number, x: number, gapLo: number, gapHi: number, v: number): void;
}

let kPromise: Promise<Kernel | null> | null = null;

export function loadKernel(): Promise<Kernel | null> {
  if (kPromise) return kPromise;
  kPromise = (async () => {
    try {
      const res = await fetch("vendor/laido_kernel.wasm");
      if (!res.ok) return null;
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      const e = instance.exports as unknown as KernelExports;
      const buf = e.memory.buffer;
      const maxNodes = e.max_nodes();
      const maxEdges = e.max_edges();
      const fieldN = e.field_n();
      const cells = fieldN * fieldN;
      const f32 = (p: number, len: number) => new Float32Array(buf, p, len);
      return {
        pos: f32(e.pos_ptr(), maxNodes * 2),
        vel: f32(e.vel_ptr(), maxNodes * 2),
        edges: new Int32Array(buf, e.edges_ptr(), maxEdges * 2),
        scratch: f32(e.scratch_ptr(), maxNodes),
        maxNodes,
        maxEdges,
        graphStep: (n, m, w, h, cool, center) => e.graph_step(n, m, w, h, cool, center),
        fieldN,
        u: f32(e.u_ptr(), cells),
        uPrev: f32(e.u_prev_ptr(), cells),
        ez: f32(e.ez_ptr(), cells),
        hx: f32(e.hx_ptr(), cells),
        hy: f32(e.hy_ptr(), cells),
        psiR: f32(e.psi_r_ptr(), cells),
        psiI: f32(e.psi_i_ptr(), cells),
        pot: f32(e.pot_ptr(), cells),
        waveStep: (n, cfl2, damp) => e.wave_step(n, cfl2, damp),
        emStep: (n, dt, t, sx, sy, freq) => e.em_step(n, dt, t, sx, sy, freq),
        qmStep: (n, dt) => e.qm_step(n, dt),
        qmSeed: (n, x0, y0, sigma, kx) => e.qm_seed(n, x0, y0, sigma, kx),
        qmBarrier: (n, x, gapLo, gapHi, v) => e.qm_barrier(n, x, gapLo, gapHi, v),
      };
    } catch {
      // don't cache a transient failure (e.g. fetch racing a reload) — the
      // next widget retries instead of being stuck on JS fallbacks forever
      kPromise = null;
      return null;
    }
  })();
  return kPromise;
}
