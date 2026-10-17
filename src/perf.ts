/* perf — a tiny always-available frame profiler, opt-in via
 * `?debug=perf` or `localStorage["laido.perf"]="1"`.
 *
 * Two jobs:
 *   1. FPS + frame-time HUD (cheap: one rAF, ~60 samples/s)
 *   2. Per-widget paint budgets — widgets wrap their paint with
 *      `perfMark("graph")` / `perfMark("sheet")`; slowest consumers
 *      surface in the HUD so optimization targets are measured, not
 *      guessed.
 *
 * When disabled the marks are no-ops — zero cost in normal runs. */
import { addActivity } from "./log.js";

export const PERF_ON =
  new URLSearchParams(location.search).get("debug") === "perf" ||
  localStorage.getItem("laido.perf") === "1";

interface Budget {
  calls: number;
  total: number;
  peak: number;
}
const budgets = new Map<string, Budget>();

/** time one paint/measure; no-op when perf is off */
export function perfMark(name: string, fn: () => void): void {
  if (!PERF_ON) return fn();
  const t0 = performance.now();
  fn();
  const d = performance.now() - t0;
  const b = budgets.get(name) ?? { calls: 0, total: 0, peak: 0 };
  b.calls++;
  b.total += d;
  if (d > b.peak) b.peak = d;
  budgets.set(name, b);
}

export function initPerf(): void {
  if (!PERF_ON) return;
  const hud = document.createElement("div");
  hud.id = "perf-hud";
  hud.innerHTML = `<span id="perf-fps"></span><span id="perf-hot"></span>`;
  document.body.append(hud);

  let frames = 0;
  let last = performance.now();
  let worst = 0;
  const frame = () => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (dt > worst) worst = dt;
    frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.setInterval(() => {
    const el = document.getElementById("perf-fps");
    const hot = document.getElementById("perf-hot");
    if (el) el.textContent = `${frames}fps · worst ${worst.toFixed(0)}ms`;
    if (hot) {
      const top = [...budgets.entries()]
        .map(([k, b]) => ({ k, avg: b.total / b.calls, peak: b.peak }))
        .sort((a, b) => b.peak - a.peak)
        .slice(0, 3)
        .map((t) => `${t.k} ${t.avg.toFixed(1)}/${t.peak.toFixed(0)}ms`)
        .join("  ");
      hot.textContent = top;
    }
    /* only real stalls earn an activity line — a per-second entry would
     * just flood the feed with noise */
    if (worst > 120) addActivity(`perf: ${frames}fps, worst frame ${worst.toFixed(0)}ms`);
    frames = 0;
    worst = 0;
  }, 1000);
}
