/* kernel — the Rust compute kernel vendored as WASM.
 *
 * ui/vendor/laido_kernel.wasm is compiled from kernels/laido-kernel
 * (cargo build --release --target wasm32-unknown-unknown). Pure compute
 * only: physics, later formula eval / fuzzy scoring. No DOM, no
 * wasm-bindgen — functions take pointers into wasm linear memory, and
 * the JS side holds typed-array views over `exports.memory`, so a step
 * mutates the same buffers the renderer reads (zero per-frame copy).
 *
 * Loading is lazy + shared: the first widget to need it fetches 4KB;
 * everyone else gets the cached instance. If the fetch or instantiate
 * fails (old runtime, stripped asset) callers keep their JS fallback. */

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
      return {
        pos: new Float32Array(buf, e.pos_ptr(), maxNodes * 2),
        vel: new Float32Array(buf, e.vel_ptr(), maxNodes * 2),
        edges: new Int32Array(buf, e.edges_ptr(), maxEdges * 2),
        scratch: new Float32Array(buf, e.scratch_ptr(), maxNodes),
        maxNodes,
        maxEdges,
        graphStep: (n, m, w, h, cool, center) => e.graph_step(n, m, w, h, cool, center),
      };
    } catch {
      return null;
    }
  })();
  return kPromise;
}
