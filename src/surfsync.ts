/* surfsync — the one clock every native surface syncs on.
 *
 * Before: each browser card and wv mount ran its own 140ms interval —
 * N surfaces meant N×7/s getBoundingClientRect + elementFromPoint
 * hit-tests, N capture-phase scroll listeners fanning out per scroll
 * event, and up to 2N invoke calls per movement. With a note holding
 * many widgets the DOM thread drowned — the "everything is lag" feel.
 *
 * Now: ONE interval drives every registered sync fn, ONE capture
 * listener feeds scroll frames to the same pump (plus a trailing
 * settle for inertial tail-off), and all geometry/visibility posts
 * ride a single pv_sync IPC flushed once per tick. */
import { invoke } from "./ipc.js";

interface SurfOp {
  id: string;
  box?: [number, number, number, number];
  vis?: boolean;
  /** runs when the engine skipped this op (mid-attach/foreign) — the
   * caller re-dirties its dedup key so the next tick reposts */
  fail?: () => void;
}

const fns = new Set<() => void>();
const opsQ: SurfOp[] = [];
let timer = 0;
let raf = 0;
let settle = 0;

const flush = () => {
  if (!opsQ.length) return;
  const ops = opsQ.splice(0, opsQ.length);
  void invoke<string[]>("pv_sync", { ops })
    .then((failed) => {
      if (!failed?.length) return;
      const bad = new Set(failed);
      for (const o of ops) if (bad.has(o.id)) o.fail?.();
    })
    .catch(() => {
      /* whole call dead — re-dirty everything so nothing strands */
      for (const o of ops) o.fail?.();
    });
};

const pump = () => {
  for (const f of [...fns]) {
    try {
      f();
    } catch (e) {
      /* one card's sync must never stall the fleet — but a per-tick
       * throw must be diagnosable, not invisible */
      (window as unknown as { __surfErr?: string[] }).__surfErr ??= [];
      const errs = (window as unknown as { __surfErr: string[] }).__surfErr;
      errs.push(String(e));
      if (errs.length > 8) errs.shift();
    }
  }
  flush();
};

const onMove = () => {
  if (!raf) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      pump();
    });
  }
  /* trailing settle — the last frame of a scroll lands after the stream
   * of events; without it surfaces park a half-frame off */
  window.clearTimeout(settle);
  settle = window.setTimeout(pump, 100);
};

const ensureRunning = () => {
  if (timer) return;
  timer = window.setInterval(pump, 150);
  document.addEventListener("scroll", onMove, true);
  window.addEventListener("resize", onMove);
};

export function surfTick(fn: () => void): () => void {
  fns.add(fn);
  ensureRunning();
  return () => {
    fns.delete(fn);
  };
}

/** immediate extra pump — callers that just changed geometry call it
 * instead of waiting for the interval */
export const surfKick = () => onMove();

/** queue a bounds post for the next flush — replaces a bare pv_bounds
 * invoke so a whole fleet's movement rides one IPC */
export function surfBounds(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fail?: () => void,
) {
  opsQ.push({ id, box: [x, y, w, h], fail });
}

/** queue a visibility post for the next flush — same batching as above */
export function surfVis(id: string, on: boolean, fail?: () => void) {
  opsQ.push({ id, vis: on, fail });
}
