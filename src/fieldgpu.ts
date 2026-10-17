/* fieldgpu — WebGPU compute path for the field card.
 *
 * The FD stencils (wave leapfrog, Yee FDTD, Visscher R/I) are the canonical
 * GPU-compute workload: same stencil per cell, embarrassingly parallel.
 * Fields live in storage buffers and ping-pong; a single render pass
 * colormaps straight from the sim buffer — zero CPU per frame, zero
 * readback. Falls back to null on any failure → caller keeps WASM/JS.
 *
 * Click disturbances upload a one-shot impulse buffer that only the first
 * substep consumes — no readback, no in-place hazards. */

// minimal WebGPU typings (lib.dom lacks them in this toolchain)
type GPUDevice = {
  createBuffer(d: { size: number; usage: number }): GPUBuffer;
  createShaderModule(d: { code: string }): GPUShaderModule;
  createComputePipeline(d: unknown): GPUComputePipeline;
  createRenderPipeline(d: unknown): GPURenderPipeline;
  createBindGroup(d: unknown): GPUBindGroup;
  createCommandEncoder(): GPUCommandEncoder;
  queue: { submit(c: unknown[]): void; writeBuffer(b: GPUBuffer, o: number, d: Float32Array | Uint32Array): void };
  destroy(): void;
  lost?: Promise<{ reason: string; message: string }>;
  onuncapturederror?: ((e: { error: { message?: string } }) => void) | null;
  pushErrorScope?(s: string): void;
  popErrorScope?(): Promise<{ message?: string } | null>;
};
type GPUBuffer = { destroy(): void };
type GPUShaderModule = object;
type GPUComputePipeline = { getBindGroupLayout(i: number): unknown };
type GPURenderPipeline = { getBindGroupLayout(i: number): unknown };
type GPUBindGroup = object;
type GPUCommandEncoder = {
  beginComputePass(): GPUComputePass;
  beginRenderPass(d: unknown): GPURenderPass;
  finish(): unknown;
};
type GPUComputePass = {
  setPipeline(p: GPUComputePipeline): void;
  setBindGroup(i: number, g: GPUBindGroup): void;
  dispatchWorkgroups(x: number, y: number): void;
  end(): void;
};
type GPURenderPass = {
  setPipeline(p: GPURenderPipeline): void;
  setBindGroup(i: number, g: GPUBindGroup): void;
  draw(n: number): void;
  end(): void;
};
type GPUCanvasContext = {
  configure(d: { device: GPUDevice; format: string; alphaMode: string }): void;
  getCurrentTexture(): { createView(): unknown };
};
type GPUAdapter = { requestDevice(): Promise<GPUDevice> };
interface GpuNav { gpu?: { requestAdapter(): Promise<GPUAdapter | null>; getPreferredCanvasFormat(): string } }

export type GpuMode = "wave" | "em" | "quantum";
export interface GpuField {
  readonly mode: GpuMode;
  readonly lost: string | null;
  step(substeps: number): void;
  disturb(gx: number, gy: number, amp: number): void;
  seed(mode: GpuMode): void;
  render(): void;
  destroy(): void;
}

const N = 120;
const WG = 8;

const COMMON = /* wgsl */ `
struct Params {
  n: u32, dt: f32, t: f32, sx: u32,
  sy: u32, freq: f32, norm: f32, mode: u32,
  cw: f32, ch: f32,
};
fn lap(a: ptr<storage, array<f32>, read>, c: u32, n: u32) -> f32 {
  return a[c - n] + a[c + n] + a[c - 1u] + a[c + 1u] - 4.0 * a[c];
}`;

const SHADER_WAVE = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> u: array<f32>;
@group(0) @binding(2) var<storage, read> up: array<f32>;
@group(0) @binding(3) var<storage, read_write> un: array<f32>;
@group(0) @binding(4) var<storage, read> imp: array<f32>;
@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y; let j = g.x;
  if (i == 0u || j == 0u || i >= p.n - 1u || j >= p.n - 1u) { return; }
  let c = i * p.n + j;
  let v = 2.0 * u[c] - up[c] + p.dt * lap(&u, c, p.n);
  un[c] = u[c] + (v - u[c]) * (1.0 - 0.004) + imp[c];
}`;

const SHADER_EM = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> ezIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> hx: array<f32>;
@group(0) @binding(3) var<storage, read_write> hy: array<f32>;
@group(0) @binding(4) var<storage, read_write> ezOut: array<f32>;
@compute @workgroup_size(${WG}, ${WG})
fn hStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y; let j = g.x;
  if (i >= p.n - 1u || j >= p.n - 1u) { return; }
  let c = i * p.n + j;
  hx[c] -= p.dt * (ezIn[c + p.n] - ezIn[c]);
  hy[c] += p.dt * (ezIn[c + 1u] - ezIn[c]);
}
@compute @workgroup_size(${WG}, ${WG})
fn eStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y; let j = g.x;
  if (i == 0u || j == 0u || i >= p.n - 1u || j >= p.n - 1u) { return; }
  let c = i * p.n + j;
  var e = ezIn[c] + p.dt * (hy[c] - hy[c - 1u] - (hx[c] - hx[c - p.n]));
  if (i == p.sy && j == p.sx) { e += sin(p.t * p.freq * 6.28318); }
  ezOut[c] = e;
}`;

const SHADER_QM = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> other: array<f32>;
@group(0) @binding(3) var<storage, read> pot: array<f32>;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(${WG}, ${WG})
fn iStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y; let j = g.x;
  if (i == 0u || j == 0u || i >= p.n - 1u || j >= p.n - 1u) { return; }
  let c = i * p.n + j;
  // pi -= (∇²pr − V·pr)·dt   (src=pr, other=pi)
  var v = other[c] - (lap(&src, c, p.n) - pot[c] * src[c]) * p.dt;
  if (pot[c] > 1e5) { v = 0.0; }
  out[c] = v;
}
@compute @workgroup_size(${WG}, ${WG})
fn rStep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.y; let j = g.x;
  if (i == 0u || j == 0u || i >= p.n - 1u || j >= p.n - 1u) { return; }
  let c = i * p.n + j;
  // pr += (∇²pi − V·pi)·dt   (src=pi, other=pr)
  var v = other[c] + (lap(&src, c, p.n) - pot[c] * src[c]) * p.dt;
  if (pot[c] > 1e5) { v = 0.0; }
  out[c] = v;
}`;

const SHADER_DRAW = /* wgsl */ `
struct Params { n: u32, dt: f32, t: f32, sx: u32,
                sy: u32, freq: f32, norm: f32, mode: u32,
                cw: f32, ch: f32 };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read> pot: array<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  let q = pos[vi];
  return vec4(q, 0.0, 1.0);
}
fn signedMap(v: f32) -> vec3<f32> {
  let x = clamp(v, -1.0, 1.0);
  if (x >= 0.0) { return vec3(0.118 + 0.882 * x, 0.157 + 0.353 * x, 0.235); }
  return vec3(0.157, 0.235 - 0.471 * x, 0.314 - 0.686 * x);
}
fn probMap(v: f32) -> vec3<f32> {
  let x = clamp(v, 0.0, 1.0);
  return vec3(0.078 + 0.922 * x * x, 0.118 + 0.549 * x, 0.235 + 0.627 * sqrt(x));
}
@fragment fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let i = u32(fc.y / (p.ch / f32(p.n)));
  let j = u32(fc.x / (p.cw / f32(p.n)));
  if (i >= p.n || j >= p.n) { discard; }
  let c = i * p.n + j;
  if (p.mode == 2u && pot[c] > 0.0) { return vec4(0.235, 0.216, 0.196, 1.0); }
  if (p.mode == 2u) {
    return vec4(probMap((a[c] * a[c] + b[c] * b[c]) / p.norm), 1.0);
  }
  return vec4(signedMap(a[c] / p.norm), 1.0);
}`;

const SU = 0x0080 | 0x0008; // STORAGE | COPY_DST

/* One shared device for every card — requestDevice is the slow part
 * (and unbounded device-per-card is how you lose them); canvases and
 * pipelines stay per-card. */
let deviceP: Promise<GPUDevice | null> | null = null;
const getDevice = () => {
  if (!deviceP) {
    const nav = navigator as Navigator & GpuNav;
    deviceP = nav.gpu
      ? nav.gpu.requestAdapter()
          .then((a) => (a ? a.requestDevice() : null))
          .then((d) => {
            if (d) {
              d.lost?.then((info) => {
                console.warn("fieldgpu: device lost:", info.reason, info.message);
                deviceP = null; // allow re-request on next card
              });
              d.onuncapturederror = (e) => console.warn("fieldgpu:", e.error?.message);
            }
            return d;
          })
          .catch(() => null)
      : Promise.resolve(null);
    // retry next call after a failed boot-time attempt
    deviceP.then((d) => { if (!d) deviceP = null; });
  }
  return deviceP;
};

export async function createGpuField(mode0: GpuMode, cv: HTMLCanvasElement): Promise<GpuField | null> {
  try {
    const device = await getDevice();
    if (!device) return null;
    const nav = navigator as Navigator & GpuNav;
    const ctx = cv.getContext("webgpu" as unknown as "2d") as unknown as GPUCanvasContext | null;
    if (!ctx) return null;
    const fmt = nav.gpu!.getPreferredCanvasFormat();
    ctx.configure({ device, format: fmt, alphaMode: "opaque" });

    const cells = N * N * 4;
    const mk = (usage = SU) => device.createBuffer({ size: cells, usage });
    const params = device.createBuffer({ size: 40, usage: 0x0040 | 0x0008 }); // UNIFORM|COPY_DST
    const buf = {
      uA: mk(), uB: mk(), uN: mk(), imp: mk(), zeroBuf: mk(),
      ez0: mk(), ez1: mk(), hx: mk(), hy: mk(),
      pr0: mk(), pr1: mk(), pi0: mk(), pi1: mk(),
      pot: mk(),
    };
    const zero = new Float32Array(N * N);
    const pData = new Float32Array(10);
    const pU32 = new Uint32Array(pData.buffer);
    const setP = (t: number, sx: number, sy: number, freq: number, norm: number, mode: number, dt: number, cw = 0, ch = 0) => {
      pU32[0] = N; pData[1] = dt; pData[2] = t; pU32[3] = sx;
      pU32[4] = sy; pData[5] = freq; pData[6] = norm; pU32[7] = mode;
      pData[8] = cw; pData[9] = ch;
      device.queue.writeBuffer(params, 0, pData);
    };

    const pipes = new Map<string, GPUComputePipeline | GPURenderPipeline>();
    const cp = (key: string, code: string, ep: string) => {
      let p = pipes.get(key) as GPUComputePipeline | undefined;
      if (!p) {
        p = device.createComputePipeline({
          layout: "auto",
          compute: { module: device.createShaderModule({ code }), entryPoint: ep },
        });
        pipes.set(key, p);
      }
      return p;
    };
    const bg = (p: { getBindGroupLayout(i: number): unknown }, entries: [number, GPUBuffer][]) =>
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: entries.map(([binding, resource]) => ({ binding, resource: { buffer: resource } })),
      });

    let t = 0, srcX = (N / 2) | 0, srcY = (N / 2) | 0, norm = 1;
    let mode: GpuMode = mode0;
    let impPending = false;
    // ping-pong roles — arrays rotate, index 0 is always "current"
    let wR = [buf.uA, buf.uB, buf.uN];          // [u, up, un]
    let ezR = [buf.ez0, buf.ez1];              // [in, out]
    let prR = [buf.pr0, buf.pr1];
    let piR = [buf.pi0, buf.pi1];

    const seed = (m: GpuMode) => {
      mode = m; t = 0; norm = 1; impPending = false;
      for (const b of Object.values(buf)) device.queue.writeBuffer(b, 0, zero);
      if (m === "em") { srcX = (N * 0.2) | 0; srcY = (N / 2) | 0; }
      if (m === "quantum") {
        const pr = new Float32Array(N * N), pi = new Float32Array(N * N), pot = new Float32Array(N * N);
        const x0 = N * 0.25, y0 = N * 0.5, sig = N * 0.07, kx = 0.9;
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
          const c = i * N + j, dx = j - x0, dy = i - y0;
          const gg = Math.exp(-(dx * dx + dy * dy) / (sig * sig));
          pr[c] = gg * Math.cos(kx * dx); pi[c] = gg * Math.sin(kx * dx);
        }
        const bx = (N * 0.55) | 0;
        const wall = (lo: number, hi: number) => {
          for (let i = Math.max(0, lo); i <= Math.min(N - 1, hi); i++) pot[i * N + bx] = 1e6;
        };
        wall(0, (N * 0.40) | 0); wall((N * 0.47) | 0, (N * 0.53) | 0); wall((N * 0.60) | 0, N - 1);
        device.queue.writeBuffer(buf.pr0, 0, pr); device.queue.writeBuffer(buf.pr1, 0, pr);
        device.queue.writeBuffer(buf.pi0, 0, pi); device.queue.writeBuffer(buf.pi1, 0, pi);
        device.queue.writeBuffer(buf.pot, 0, pot);
      }
    };

    const disturb = (gx: number, gy: number, amp: number) => {
      if (mode === "wave") {
        const stamp = new Float32Array(N * N);
        for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
          const i = Math.max(1, Math.min(N - 2, gy + di)), j = Math.max(1, Math.min(N - 2, gx + dj));
          const d2 = di * di + dj * dj;
          if (d2 <= 6) stamp[i * N + j] = amp * Math.exp(-d2 / 2);
        }
        device.queue.writeBuffer(buf.imp, 0, stamp);
        impPending = true;
      } else if (mode === "em") {
        srcX = gx; srcY = gy;
      } else {
        seed("quantum");
      }
    };

    const groups = Math.ceil(N / WG);
    const step = (substeps: number) => {
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      if (mode === "wave") {
        const p = cp("wave", SHADER_WAVE, "main");
        pass.setPipeline(p);
        for (let s = 0; s < substeps; s++) {
          const [u, up, un] = wR;
          setP(t, 0, 0, 0, 0, 0, 0.25);
          pass.setBindGroup(0, bg(p, [
            [0, params], [1, u], [2, up], [3, un],
            [4, impPending ? buf.imp : buf.zeroBuf], // zeroBuf: true neutral
          ]));
          pass.dispatchWorkgroups(groups, groups);
          wR = [un, u, up];
          t++;
          impPending = false; // consumed by substep 0 only
        }
      } else if (mode === "em") {
        const ph = cp("emH", SHADER_EM, "hStep");
        const pe = cp("emE", SHADER_EM, "eStep");
        for (let s = 0; s < substeps; s++) {
          t++;
          setP(t, srcX, srcY, 0.03, 0, 1, 0.5);
          const [ezIn, ezOut] = ezR;
          pass.setPipeline(ph);
          pass.setBindGroup(0, bg(ph, [[0, params], [1, ezIn], [2, buf.hx], [3, buf.hy], [4, ezOut]]));
          pass.dispatchWorkgroups(groups, groups);
          pass.setPipeline(pe);
          pass.setBindGroup(0, bg(pe, [[0, params], [1, ezIn], [2, buf.hx], [3, buf.hy], [4, ezOut]]));
          pass.dispatchWorkgroups(groups, groups);
          ezR = [ezOut, ezIn];
        }
      } else {
        const pi = cp("qmI", SHADER_QM, "iStep");
        const pr = cp("qmR", SHADER_QM, "rStep");
        for (let s = 0; s < substeps; s++) {
          t++;
          setP(t, 0, 0, 0, 0, 2, 0.12);
          pass.setPipeline(pi);
          pass.setBindGroup(0, bg(pi, [[0, params], [1, prR[0]], [2, piR[0]], [3, buf.pot], [4, piR[1]]]));
          pass.dispatchWorkgroups(groups, groups);
          piR = [piR[1], piR[0]];
          pass.setPipeline(pr);
          pass.setBindGroup(0, bg(pr, [[0, params], [1, piR[0]], [2, prR[0]], [3, buf.pot], [4, prR[1]]]));
          pass.dispatchWorkgroups(groups, groups);
          prR = [prR[1], prR[0]];
        }
      }
      pass.end();
      device.queue.submit([enc.finish()]);
    };

    const render = () => {
      const p = pipes.get("draw") as GPURenderPipeline | undefined ?? device.createRenderPipeline({
        layout: "auto",
        vertex: { module: device.createShaderModule({ code: SHADER_DRAW }), entryPoint: "vs" },
        fragment: {
          module: device.createShaderModule({ code: SHADER_DRAW }),
          entryPoint: "fs",
          targets: [{ format: fmt }],
        },
        primitive: { topology: "triangle-list" },
      }) as GPURenderPipeline;
      pipes.set("draw", p);
      const modeNum = mode === "quantum" ? 2 : mode === "em" ? 1 : 0;
      norm = Math.max(norm * (mode === "em" ? 0.995 : 0.98), 0.5);
      // canvas buffer tracks CSS size × dpr — getCurrentTexture follows it
      const dpr = devicePixelRatio || 1;
      const bw = Math.max(8, Math.round(cv.clientWidth * dpr));
      const bh = Math.max(8, Math.round(cv.clientHeight * dpr));
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
      setP(t, srcX, srcY, 0.03, norm, modeNum, 0.5, bw, bh);
      const a = mode === "wave" ? wR[0] : mode === "em" ? ezR[0] : prR[0];
      const b = mode === "quantum" ? piR[0] : a;
      const enc = device.createCommandEncoder();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          loadOp: "clear", clearValue: { r: 0.043, g: 0.051, b: 0.07, a: 1 }, storeOp: "store",
        }],
      });
      rp.setPipeline(p);
      rp.setBindGroup(0, bg(p, [[0, params], [1, a], [2, b], [3, buf.pot]]));
      rp.draw(3);
      rp.end();
      device.queue.submit([enc.finish()]);
    };

    const self = { lost: null as string | null };
    device.lost?.then((info) => { self.lost = `${info.reason}: ${info.message}`; });
    seed(mode0);
    return {
      get mode() { return mode; },
      get lost() { return self.lost; },
      step, render, seed, disturb,
      destroy() {
        for (const b of Object.values(buf)) b.destroy();
        params.destroy();
        // device is shared across cards — never destroy it here
      },
    };
  } catch (e) {
    console.warn("fieldgpu init:", e);
    return null;
  }
}
