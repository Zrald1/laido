/* wview — bind a DOM element to a native wv-* surface (rust-rendered).
 * The widget supplies an HTML doc; the engine paints it, handles
 * scroll/selection natively, and reports link clicks as wv:nav so the
 * caller can open real browser cards. The DOM element becomes a pure
 * mount point — bounds/visibility track it like pvSync does for bv-*.
 *
 *   const wv = mountWv(el, "wv-"+id)
 *   wv.setDoc(html)      — swap the whole document
 *   wv.eval(js)          — patch it incrementally (cheaper than a doc swap)
 *   wv.onLink(fn)        — http link clicked inside the doc
 *   wv.dispose()         — close the engine + stop syncing
 */
import { invoke } from "./ipc.js";
import { surfTick, surfBounds, surfVis } from "./surfsync.js";
import { sleepEngine, wakeEngine, suspendedPv, visiblePv } from "./browser.js";

const dpr = () => window.devicePixelRatio || 1;

/* browser.ts runs an orphan sweep over pv_list and hides any engine no
 * card claims — wv surfaces live in the same map, so every live mount
 * registers here (synchronously, before wv_open lands) and the sweep
 * leaves it alone. Crash leftovers stay unclaimed → still swept. */
declare global {
  interface Window {
    __WV_CLAIMS__?: Set<string>;
  }
}
const claims = (window.__WV_CLAIMS__ ??= new Set<string>());

export interface WvHandle {
  setDoc(html: string): void;
  eval(js: string): Promise<string>;
  onLink(fn: (url: string) => void): void;
  dispose(): void;
  id: string;
}

export function mountWv(
  el: HTMLElement,
  id: string,
  initialDoc = "",
  onDispose?: () => void,
): WvHandle {
  let dead = false;
  let lastBox = "";
  let lastVis = "";
  let linkFn: ((url: string) => void) | null = null;
  let ticks = 0;
  let coverSample = 0;
  let coverTicks = 0; // consecutive covered hit-tests
  let offTicks = 0;
  claims.add(id);

  let parked = false;
  /* a wv_doc posted while the engine is still mid-attach is dropped —
   * hold the last doc and replay it until a post actually lands */
  let pendingDoc: string | null = null;
  const sync = () => {
    if (dead) return;
    if (pendingDoc !== null) {
      const html = pendingDoc;
      pendingDoc = null;
      void invoke("wv_doc", { id, html }).catch(() => { pendingDoc = html; });
    }
    /* DOM detach: a note switch marks the card data-park — keep the
     * engine alive (hidden) so reopening the note re-glues it; a real
     * delete closes it. Mirrors the browser engine's park semantics */
    if (!el.isConnected) {
      const card = el.closest<HTMLElement>(".callout");
      if (card?.dataset.park) {
        if (!parked) {
          parked = true;
          void invoke("pv_visible", { id, on: false }).catch(() => {});
        }
      } else {
        self.dispose();
      }
      return;
    }
    if (parked) parked = false;
    const r = el.getBoundingClientRect();
    /* clip to the scroll container — the surface can only cover the
     * visible slice, same as the browser engine */
    const clipEl = el.closest<HTMLElement>("#note-body") ?? document.body;
    const clip = clipEl.getBoundingClientRect();
    const ix = Math.max(r.left, clip.left);
    const iy = Math.max(r.top, clip.top);
    const iw = Math.min(r.right, clip.right) - ix;
    const ih = Math.min(r.bottom, clip.bottom) - iy;
    const d = dpr();
    const boxKey = `${Math.round(ix)},${Math.round(iy)},${Math.round(iw)},${Math.round(ih)},${d}`;
    /* elementFromPoint = layout+paint-order hit-test — the expensive
     * call. Sample on box-change or every ~3rd tick, not every tick */
    let covered = coverTicks > 0;
    if (boxKey !== lastBox || ++coverSample >= 3) {
      coverSample = 0;
      const mid =
        iw > 0 && ih > 0 ? document.elementFromPoint(ix + iw / 2, iy + ih / 2) : null;
      coverTicks = !mid || (!el.contains(mid) && mid !== el) ? coverTicks + 1 : 0;
      covered = coverTicks > 0;
    }
    const vis = !covered && iw > 8 && ih > 8;
    /* a hidden wv surface is a pure renderer — safe to freeze after the
     * same ~3s grace the browser engines get */
    offTicks = vis ? 0 : offTicks + 1;
    /* retry on a slow cadence, not once: an engine still mid-attach at
     * tick 20 eats the single shot and stays awake-forever */
    if (offTicks >= 20 && offTicks % 10 === 0 && !suspendedPv.has(id)) {
      sleepEngine(id, () => lastVis !== "true");
    }
    if (boxKey !== lastBox) {
      lastBox = boxKey;
      /* a failed post (engine still mid-attach in the env-churn gap)
       * re-dirties the key — otherwise the surface sits at its creation
       * rect forever because the dedup thinks it already landed */
      surfBounds(
        id,
        Math.round(ix * d), Math.round(iy * d),
        Math.round(Math.max(1, iw) * d), Math.round(Math.max(1, ih) * d),
        () => { lastBox = ""; });
    }
    const visKey = `${vis}`;
    if (visKey !== lastVis) {
      lastVis = visKey;
      if (vis) {
        wakeEngine(id);
        visiblePv.add(id);
      } else {
        visiblePv.delete(id);
      }
      surfVis(id, vis, () => { lastVis = ""; });
    }
    /* self-heal BOTH directions: a stray hide OR a stray show (wv_open's
     * old force-show, sweep, reclaim) bypasses the dedup — re-affirm the
     * wanted state on a slow cadence so neither can stick */
    if (++ticks % 14 === 0)
      surfVis(id, vis);
  };

  const r = el.getBoundingClientRect();
  const d = dpr();
  void invoke("wv_open", {
    id,
    html: initialDoc || "<html><body style='background:transparent'></body></html>",
    x: Math.round(r.left * d), y: Math.round(r.top * d),
    w: Math.round(Math.max(1, r.width) * d), h: Math.round(Math.max(1, r.height) * d),
  }).catch(() => {});

  const ro = new ResizeObserver(sync);
  ro.observe(el);
  /* shared pump — interval + scroll/resize fan-in live in surfsync so a
   * note full of surfaces isn't N loops × N listeners */
  const offTick = surfTick(sync);

  const unlisten = window.__TAURI__.event
    .listen<{ id: string; url: string }>("wv:nav", (e) => {
      if (e.payload.id === id) linkFn?.(e.payload.url);
    })
    .catch(() => () => {});

  const self: WvHandle = {
    id,
    setDoc(html: string) {
      if (!dead) {
        /* a suspended engine freezes script timers — wake before posting
         * the nav or the doc stalls behind a dead renderer */
        if (suspendedPv.has(id)) wakeEngine(id);
        pendingDoc = html;
        sync();
      }
    },
    eval(js: string) {
      return invoke<string>("pv_eval", { id, js }).catch(() => "");
    },
    onLink(fn: (url: string) => void) {
      linkFn = fn;
    },
    dispose() {
      dead = true;
      claims.delete(id);
      visiblePv.delete(id);
      suspendedPv.delete(id);
      offTick();
      ro.disconnect();
      void unlisten.then((f) => f()).catch(() => {});
      void invoke("pv_close", { id }).catch(() => {});
      onDispose?.();
    },
  };
  return self;
}
