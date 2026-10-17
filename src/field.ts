/* ---------- field — live physics simulation card ----------------------
 * `> [!field] title` + `mode: wave|em|quantum`
 *
 * Three arXiv-standard FD schemes on a shared 2D grid, stepped by the
 * vendored Rust WASM kernel (ui/vendor/laido_kernel.wasm) with a JS
 * typed-array fallback:
 *   wave    — damped 2D wave eq (sound/vibration): u"=c²∇²u−γu', leapfrog
 *   em      — 2D FDTD TE mode (radio waves): Yee Ez/Hx/Hy + sinusoidal
 *             antenna source
 *   quantum — Schrödinger via Visscher staggered R/I leapfrog, Gaussian
 *             packet + double-slit barrier (ħ=1, m=½)
 *
 * CFL stability is encoded in the step sizes below. The card owns its
 * state in JS arrays and copies in/out of the kernel's flat buffers per
 * step — kernel buffers are shared scratch, not per-card storage. */
import { loadKernel, type Kernel } from "./kernel.js";
import { perfMark } from "./perf.js";
import type { GpuField, GpuMode } from "./fieldgpu.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };
const esc = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Mode = "wave" | "em" | "quantum";
const MODES: Mode[] = ["wave", "em", "quantum"];
const N = 120; // grid cells per side — 14400 cells ≈ 0.15ms/step in wasm

const parseMode = (block: string[]): { title: string; mode: Mode } => {
  const head = S(block[0]).replace(/^\[!\w+\]\s*/, "").trim();
  const ml = block.map(S).find((l) => /^mode\s*:/.test(l));
  const m = DS(ml?.split(":")[1]?.trim());
  return {
    title: head || "field",
    mode: (MODES as string[]).includes(m) ? (m as Mode) : "wave",
  };
};

const toolsHtml = (mode: Mode) =>
  `<span class="field-tools">` +
  MODES.map(
    (m) =>
      `<button class="f-t${m === mode ? " on" : ""}" data-m="${m}" title="${{
        wave: "damped wave equation — sound & vibration (∂²u/∂t² = c²∇²u)",
        em: "Maxwell FDTD — radio waves from an antenna (∂Ez/∂t = ∂Hy/∂x − ∂Hx/∂y)",
        quantum: "Schrödinger — wave packet vs double slit (iħ∂ψ/∂t = −∇²ψ + Vψ)",
      }[m]}">${{ wave: "wave", em: "em", quantum: "quantum" }[m]}</button>`,
  ).join("") +
  `</span>`;

export function fieldCallout(block: string[]): string {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const { title, mode } = parseMode(block);
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout field-card" data-kind="field" data-title="${esc(title)}" data-mode="${mode}" data-md="${esc(raw)}">` +
    `<div class="callout-head"><span class="callout-title">∿ ${esc(title)}</span>${toolsHtml(mode)}</div>` +
    `<div class="callout-body"><canvas class="field-cv"></canvas><div class="field-hint"></div></div>` +
    `</div>`
  );
}

export function fieldToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const mode = DS(card.dataset.mode) || "wave";
  return `> [!field] ${DS(card.dataset.title) || "field"}\n> mode: ${mode}`;
}

export function buildFieldCard(title: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout field-card";
  card.dataset.kind = "field";
  card.dataset.title = title || "field";
  card.dataset.mode = "wave";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">∿ ${esc(title || "field")}</span>${toolsHtml("wave")}</div>` +
    `<div class="callout-body"><canvas class="field-cv"></canvas><div class="field-hint"></div></div>`;
  return card;
}

/* diverging blue→black→red for signed fields; inferno-ish for |ψ|² */
function cmapSigned(img: Uint8ClampedArray, f: Float32Array, n: number, norm: number) {
  const s = 1 / Math.max(1e-6, norm);
  for (let i = 0; i < n * n; i++) {
    const v = Math.max(-1, Math.min(1, f[i] * s));
    const o = i * 4;
    if (v >= 0) {
      img[o] = 30 + 225 * v;
      img[o + 1] = 40 + 90 * v;
      img[o + 2] = 60;
    } else {
      img[o] = 40;
      img[o + 1] = 60 + 120 * -v;
      img[o + 2] = 80 + 175 * -v;
    }
    img[o + 3] = 255;
  }
}
function cmapProb(img: Uint8ClampedArray, r: Float32Array, i2: Float32Array, pot: Float32Array, n: number, norm: number) {
  const s = 1 / Math.max(1e-6, norm);
  for (let i = 0; i < n * n; i++) {
    const pr = (r[i] * r[i] + i2[i] * i2[i]) * s;
    const p = pr >= 0 ? Math.min(1, pr) : 0;
    const o = i * 4;
    if (pot[i] > 0) {
      img[o] = 60; img[o + 1] = 55; img[o + 2] = 50;
    } else {
      img[o] = 20 + 235 * p * p;
      img[o + 1] = 30 + 140 * p;
      img[o + 2] = 60 + 160 * Math.sqrt(p);
    }
    img[o + 3] = 255;
  }
}

export function wireField(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.fieldWired) return;
  card.dataset.fieldWired = "1";
  const cvQ = card.querySelector<HTMLCanvasElement>(".field-cv");
  if (!cvQ) return;
  const cv = cvQ;
  const hint = card.querySelector<HTMLElement>(".field-hint");

  let kernel: Kernel | null = null;
  let kTries = 0;
  const tryKernel = () => {
    kTries++;
    void loadKernel().then((k) => {
      kernel = k;
      if (!k && kTries < 4) setTimeout(tryKernel, 1500);
    });
  };
  tryKernel();

  /* GPU tier first — claiming the 2d context would lock the canvas forever.
   * Async init: the tick waits on `gpuReady` before touching either path. */
  let gpu: GpuField | null = null;
  let gpuReady = false;
  const wgpuOk =
    (window as unknown as { __gpuInfo?: { tier?: string } }).__gpuInfo?.tier === "webgpu";
  if (wgpuOk) {
    const ready = () => { gpuReady = true; kick(); };
    // GPU init can orphan (boot-time reload races) — never wait on it forever;
    // but a late-resolved GPU is still adopted: it already owns the canvas ctx
    // and renders better than the JS path, so swap it in whenever it lands
    const attempt = import("./fieldgpu.js").then((m) => m.createGpuField(mode as GpuMode, cv));
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000));
    void Promise.race([attempt, timeout]).then(() => ready());
    attempt
      .then((g) => { if (g) { gpu = g; ready(); } })
      .catch((e) => { console.warn("fieldgpu init failed, JS fallback:", e); ready(); });
  } else {
    gpuReady = true;
  }

  // per-card JS state — kernel buffers are shared scratch
  const u = new Float32Array(N * N);
  const uPrev = new Float32Array(N * N);
  const ez = new Float32Array(N * N);
  const hx = new Float32Array(N * N);
  const hy = new Float32Array(N * N);
  const psiR = new Float32Array(N * N);
  const psiI = new Float32Array(N * N);
  const pot = new Float32Array(N * N);

  const off = document.createElement("canvas");
  off.width = off.height = N;
  const offCtx = off.getContext("2d")!;
  const img = offCtx.createImageData(N, N);
  // lazy — claiming 2d before the webgpu attempt would lock the canvas
  let ctx2: CanvasRenderingContext2D | null = null;

  let mode: Mode = (DS(card.dataset.mode) as Mode) || "wave";
  let t = 0;
  let srcX = (N / 2) | 0, srcY = (N / 2) | 0;
  let raf = 0;
  let seen = true;
  let norm = 1;

  const seedQuantum = () => {
    psiR.fill(0); psiI.fill(0); pot.fill(0);
    const x0 = N * 0.25, y0 = N * 0.5, sig = N * 0.07, kx = 0.9;
    if (kernel) {
      // qmSeed/qmBarrier write the kernel buffers — copy back into the card's
      kernel.qmSeed(N, x0, y0, sig, kx);
      psiR.set(kernel.psiR.subarray(0, N * N));
      psiI.set(kernel.psiI.subarray(0, N * N));
      kernel.pot.fill(0);
      // double slit: three wall segments leave two ~5% openings at 0.41-0.46 + 0.54-0.59
      const bx = (N * 0.55) | 0;
      kernel.qmBarrier(N, bx, 0, (N * 0.40) | 0, 1e6);
      kernel.qmBarrier(N, bx, (N * 0.47) | 0, (N * 0.53) | 0, 1e6);
      kernel.qmBarrier(N, bx, (N * 0.60) | 0, N - 1, 1e6);
      pot.set(kernel.pot.subarray(0, N * N));
    } else {
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const c = i * N + j, dx = j - x0, dy = i - y0;
        const g = Math.exp(-(dx * dx + dy * dy) / (sig * sig));
        psiR[c] = g * Math.cos(kx * dx); psiI[c] = g * Math.sin(kx * dx);
      }
      const bx = (N * 0.55) | 0, g1l = (N * 0.41) | 0, g1h = (N * 0.46) | 0,
        g2l = (N * 0.54) | 0, g2h = (N * 0.59) | 0;
      for (let i = 0; i < N; i++)
        pot[i * N + bx] = (i >= g1l && i <= g1h) || (i >= g2l && i <= g2h) ? 0 : 1e6;
    }
  };

  const setMode = (m: Mode) => {
    mode = m;
    card.dataset.mode = m;
    t = 0; norm = 1;
    u.fill(0); uPrev.fill(0); ez.fill(0); hx.fill(0); hy.fill(0);
    if (gpu) gpu.seed(m as GpuMode);
    else if (m === "quantum") seedQuantum();
    if (m === "em") { srcX = (N * 0.2) | 0; srcY = (N / 2) | 0; }
    card.querySelectorAll(".f-t").forEach((b) =>
      b.classList.toggle("on", (b as HTMLElement).dataset.m === m));
    if (hint)
      hint.textContent = {
        wave: "click / drag to disturb the membrane",
        em: "click to move the antenna",
        quantum: "click to re-launch the packet",
      }[m];
    card.dispatchEvent(new CustomEvent("field:changed", { bubbles: true }));
  };
  card.querySelectorAll<HTMLElement>(".f-t").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); setMode(b.dataset.m as Mode); }));

  /* ---- stepping: kernel when loaded, JS otherwise (same math) ---- */
  const lap = (a: Float32Array, i: number, j: number) => {
    const c = i * N + j;
    return a[c - N] + a[c + N] + a[c - 1] + a[c + 1] - 4 * a[c];
  };
  const stepWave = () => {
    if (kernel) {
      kernel.u.set(u); kernel.uPrev.set(uPrev);
      const mx = kernel.waveStep(N, 0.25, 0.004); // cfl²=0.25 → cfl=0.5 < 1/√2
      u.set(kernel.u.subarray(0, N * N)); uPrev.set(kernel.uPrev.subarray(0, N * N));
      return mx;
    }
    let mx = 0;
    const un = new Float32Array(N * N);
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const c = i * N + j;
      const v = 2 * u[c] - uPrev[c] + 0.25 * lap(u, i, j);
      un[c] = u[c] + (v - u[c]) * 0.996;
      mx = Math.max(mx, Math.abs(un[c]));
    }
    uPrev.set(u); u.set(un);
    return mx;
  };
  const stepEm = () => {
    t++;
    if (kernel) {
      kernel.ez.set(ez); kernel.hx.set(hx); kernel.hy.set(hy);
      kernel.emStep(N, 0.5, t, srcX, srcY, 0.03);
      ez.set(kernel.ez.subarray(0, N * N)); hx.set(kernel.hx.subarray(0, N * N)); hy.set(kernel.hy.subarray(0, N * N));
      return;
    }
    const dt = 0.5;
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) {
      const c = i * N + j;
      hx[c] -= dt * (ez[c + N] - ez[c]);
      hy[c] += dt * (ez[c + 1] - ez[c]);
    }
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const c = i * N + j;
      ez[c] += dt * (hy[c] - hy[c - 1] - (hx[c] - hx[c - N]));
    }
    ez[srcY * N + srcX] += Math.sin(t * 0.03 * Math.PI * 2);
  };
  const stepQm = () => {
    if (kernel) {
      kernel.psiR.set(psiR); kernel.psiI.set(psiI); kernel.pot.set(pot);
      kernel.qmStep(N, 0.12);
      psiR.set(kernel.psiR.subarray(0, N * N)); psiI.set(kernel.psiI.subarray(0, N * N));
      return;
    }
    const dt = 0.12;
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const c = i * N + j;
      psiI[c] -= (lap(psiR, i, j) - pot[c] * psiR[c]) * dt;
    }
    for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) {
      const c = i * N + j;
      psiR[c] += (lap(psiI, i, j) - pot[c] * psiI[c]) * dt;
    }
    // hard wall: ψ = 0 inside the barrier — an opaque screen. A finite-V
    // barrier needs dt ≲ 2/V; V=1e6 explodes the leapfrog to NaN.
    for (let i = 0; i < N * N; i++) if (pot[i] > 0) { psiR[i] = 0; psiI[i] = 0; }
  };

  const disturb = (gx: number, gy: number, amp = 3) => {
    if (gpu) { gpu.disturb(gx, gy, amp); return; }
    if (mode === "wave") {
      for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
        const i = Math.max(1, Math.min(N - 2, gy + di)), j = Math.max(1, Math.min(N - 2, gx + dj));
        const d2 = di * di + dj * dj;
        if (d2 <= 6) u[i * N + j] += amp * Math.exp(-d2 / 2);
      }
    } else if (mode === "em") {
      srcX = gx; srcY = gy;
    } else {
      // re-launch the packet from the click point
      const x0 = gx, y0 = gy, sig = N * 0.07, kx = 0.9;
      psiR.fill(0); psiI.fill(0);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const c = i * N + j, dx = j - x0, dy = i - y0;
        const g = Math.exp(-(dx * dx + dy * dy) / (sig * sig));
        psiR[c] = g * Math.cos(kx * dx); psiI[c] = g * Math.sin(kx * dx);
      }
    }
  };

  const toGrid = (e: MouseEvent | PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return [
      Math.max(0, Math.min(N - 1, Math.round(((e.clientX - r.left) / r.width) * N))),
      Math.max(0, Math.min(N - 1, Math.round(((e.clientY - r.top) / r.height) * N))),
    ] as const;
  };
  let pressing = false;
  cv.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    pressing = true;
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const [x, y] = toGrid(e);
    disturb(x, y);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!pressing) return;
    const [x, y] = toGrid(e);
    disturb(x, y, 1.2);
  });
  const release = () => { pressing = false; };
  cv.addEventListener("pointerup", release);
  cv.addEventListener("pointercancel", release);

  function paint() {
    if (!ctx2) ctx2 = cv.getContext("2d");
    if (!ctx2) return;
    const d = img.data;
    if (mode === "wave") { norm = Math.max(norm * 0.98, 0.5); cmapSigned(d, u, N, norm); }
    else if (mode === "em") { norm = Math.max(norm * 0.995, 0.5); cmapSigned(d, ez, N, norm); }
    else cmapProb(d, psiR, psiI, pot, N, Math.max(0.5, norm));
    offCtx.putImageData(img, 0, 0);
    const w = cv.clientWidth, h = cv.clientHeight;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx2.imageSmoothingEnabled = true;
    ctx2.drawImage(off, 0, 0, cv.width, cv.height);
  }

  let running = false;
  let simThrows = 0;

  /* CFL-for-frames: the wave schemes derive dt ≤ dx/c — the app version
   * derives substeps ≤ budget/stepCost. EMA of measured per-frame sim
   * cost scales the substep count down on slow machines instead of
   * blowing the frame; slow cards degrade gracefully, fast ones get
   * the full rate. LTS (arXiv 2005.13350) supplies the second half:
   * edge-visible cards step at 1/3 rate — local dt per element. */
  const BUDGET_MS = 1.6;
  const BASE_SUB: Record<Mode, number> = { wave: 4, em: 3, quantum: 2 };
  let frameCost = 0.5; // EMA of measured sim+paint ms (debug only)
  let stepCost = 0.1;  // EMA of measured per-substep ms — drives the count
  let rate = 1;        // 1 = full rate, 3 = every 3rd frame (edge-visible)
  let tickN = 0;
  const substeps = (m: Mode) =>
    Math.max(1, Math.min(BASE_SUB[m], Math.floor(BUDGET_MS / Math.max(0.05, stepCost))));

  const kick = () => {
    if (seen && gpuReady && !running && card.isConnected) {
      running = true;
      raf = requestAnimationFrame(tick);
    }
  };
  const tick = () => {
    if (!seen || !card.isConnected || !gpuReady) { running = false; raf = 0; return; }
    // LTS: edge-visible cards still schedule but only simulate every Nth
    if (rate > 1 && tickN++ % rate !== 0) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const t0 = performance.now();
    try {
      perfMark("field", () => {
        const sub = substeps(mode);
        const s0 = performance.now();
        if (gpu) {
          gpu.step(sub);
          gpu.render();
        } else {
          for (let s = 0; s < sub; s++) {
            if (mode === "wave") stepWave();
            else if (mode === "em") stepEm();
            else stepQm();
          }
          paint();
        }
        stepCost = stepCost * 0.85 + ((performance.now() - s0) / sub) * 0.15;
      });
      simThrows = 0;
      frameCost = frameCost * 0.85 + (performance.now() - t0) * 0.15;
    } catch (e) {
      if (++simThrows > 5) {
        running = false; raf = 0;
        console.warn("field sim crashed:", e);
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  };

  /* only burn cycles while the card is actually on screen — IO re-fires
   * whenever the card re-enters the viewport, restarting the loop */
  new IntersectionObserver((en) => {
    const e = en[0];
    seen = e?.isIntersecting ?? true;
    if (e && e.isIntersecting) rate = e.intersectionRatio > 0.5 ? 1 : 3;
    kick();
  }, { threshold: [0.02, 0.5] }).observe(card);

  // IO has proven flaky inside WebView2 (visible cards report non-intersecting)
  // — a 1Hz rect check is the source of truth, and it also resurrects the
  // loop after any kill (IO lies, thrown frame, init ordering)
  const onScreen = () => {
    const r = card.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / (r.width * r.height || 1);
  };
  const visGuard = window.setInterval(() => {
    if (!card.isConnected) { window.clearInterval(visGuard); return; }
    const v = onScreen();
    seen = v > 0.02;
    // LTS rate: fully visible = every frame, clipped edge = every 3rd
    rate = v > 0.5 ? 1 : 3;
    kick();
  }, 1000);

  // free GPU buffers only after a sustained detach — re-renders reparent
  // the card briefly and must not kill the sim
  let detachT = 0;
  const guard = window.setInterval(() => {
    if (card.isConnected) { detachT = 0; return; }
    if (++detachT >= 3) { window.clearInterval(guard); gpu?.destroy(); gpu = null; }
  }, 900);

  // debug/test surface — lets probes inspect + revive the loop
  (card as unknown as { __fd: unknown }).__fd = {
    get seen() { return seen; },
    get raf() { return raf; },
    get kernel() { return !!kernel; },
    get t() { return t; },
    get uMax() { return u.reduce((a, b) => Math.max(a, Math.abs(b)), 0); },
    get ezMax() { return ez.reduce((a, b) => Math.max(a, Math.abs(b)), 0); },
    get psiSum() { let s = 0; for (let i = 0; i < N * N; i++) s += psiR[i] * psiR[i] + psiI[i] * psiI[i]; return s; },
    get potSum() { return pot.reduce((a, b) => a + b, 0); },
    get rate() { return rate; },
    get frameCost() { return frameCost; },
    get stepCost() { return stepCost; },
    get sub() { return substeps(mode); },
    get gpu() { return gpu ? `ok:${gpu.lost ?? "alive"}` : (gpuReady ? "null" : "init"); },
    kick() { seen = true; if (!raf) raf = requestAnimationFrame(tick); },
  };

  setMode(mode);
  if (mode === "wave") disturb((N / 2) | 0, (N / 2) | 0, 4); // visible on open
}
