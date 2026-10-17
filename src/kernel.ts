/* kernel — the Rust compute kernel vendored as WASM.
 *
 * ui/vendor/laido_kernel.wasm is compiled from kernels/laido-kernel
 * (cargo build --release --target wasm32-unknown-unknown). Pure compute
 * only: force-directed graph physics. No DOM, no wasm-bindgen — functions
 * take pointers into wasm linear memory, and the JS side holds typed
 * array views over `exports.memory` (zero per-frame marshalling).
 *
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
}

export interface Kernel {
  pos: Float32Array;
  vel: Float32Array;
  edges: Int32Array;
  scratch: Float32Array;
  maxNodes: number;
  maxEdges: number;
  graphStep(n: number, m: number, w: number, h: number, cool: number, center: number): number;
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
      const f32 = (p: number, len: number) => new Float32Array(buf, p, len);
      return {
        pos: f32(e.pos_ptr(), maxNodes * 2),
        vel: f32(e.vel_ptr(), maxNodes * 2),
        edges: new Int32Array(buf, e.edges_ptr(), maxEdges * 2),
        scratch: f32(e.scratch_ptr(), maxNodes),
        maxNodes,
        maxEdges,
        graphStep: (n, m, w, h, cool, center) => e.graph_step(n, m, w, h, cool, center),
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
