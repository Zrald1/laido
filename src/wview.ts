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
    const mid =
      iw > 0 && ih > 0 ? document.elementFromPoint(ix + iw / 2, iy + ih / 2) : null;
    const covered = !mid || (!el.contains(mid) && mid !== el);
    const vis = !covered && iw > 8 && ih > 8;
    const d = dpr();
    const boxKey = `${Math.round(ix)},${Math.round(iy)},${Math.round(iw)},${Math.round(ih)},${d}`;
    if (boxKey !== lastBox) {
      lastBox = boxKey;
      /* a failed post (engine still mid-attach in the env-churn gap)
       * re-dirties the key — otherwise the surface sits at its creation
       * rect forever because the dedup thinks it already landed */
      void invoke("pv_bounds", {
        id,
        x: Math.round(ix * d), y: Math.round(iy * d),
        w: Math.round(Math.max(1, iw) * d), h: Math.round(Math.max(1, ih) * d),
      }).catch(() => { lastBox = ""; });
    }
    const visKey = `${vis}`;
    if (visKey !== lastVis) {
      lastVis = visKey;
      void invoke("pv_visible", { id, on: vis }).catch(() => { lastVis = ""; });
    }
    /* self-heal, same as pvSync: a stray hide from any out-of-band path
     * (sweep tick between unmount/remount, reclaim teardown) bypasses
     * the dedup — re-affirm on a slow cadence so it can never stick */
    if (vis && ++ticks % 14 === 0)
      void invoke("pv_visible", { id, on: true }).catch(() => {});
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
  const onScroll = () => requestAnimationFrame(sync);
  document.addEventListener("scroll", onScroll, true);
  const timer = window.setInterval(sync, 140);

  const unlisten = window.__TAURI__.event
    .listen<{ id: string; url: string }>("wv:nav", (e) => {
      if (e.payload.id === id) linkFn?.(e.payload.url);
    })
    .catch(() => () => {});

  const self: WvHandle = {
    id,
    setDoc(html: string) {
      if (!dead) {
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
      window.clearInterval(timer);
      ro.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      void unlisten.then((f) => f()).catch(() => {});
      void invoke("pv_close", { id }).catch(() => {});
      onDispose?.();
    },
  };
  return self;
}
