/* ---------- vault graph — force-directed note map card ---------------
 * `[!graph] title` persists as just the title — the picture is computed
 * live from vault_index's link pairs. Springs (Hooke) pull linked notes,
 * Coulomb-ish repel spreads the rest, a weak center force keeps it
 * bounded. Drag nodes to arrange; click opens the note; `local` mode
 * centers the open note and shows its neighborhood (Obsidian's local
 * graph, depth 1…2). */

import { invoke } from "./ipc.js";
import { stem } from "./match.js";
import { baseMatch, buildPropMaps, type IndexLike } from "./base.js";
import { loadKernel, type Kernel } from "./kernel.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };

interface GNode { note: string; x: number; y: number; vx: number; vy: number; deg: number; }
interface GEdge { a: number; b: number; }

const esc = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function graphCallout(block: string[]): string {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "vault map";
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout graph-card" data-kind="graph" data-title="${esc(topic)}" data-md="${esc(raw)}">` +
    `<div class="callout-head"><span class="callout-title">◈ ${esc(topic)}</span>` +
    `<span class="graph-tools hidden"><input class="g-filter" placeholder="filter…" spellcheck="false"/>` +
    `<button class="g-t" data-a="local" title="center the open note — depth 1→2">local</button>` +
    `<button class="g-t on" data-a="all" title="whole vault">all</button></span></div>` +
    `<div class="callout-body"><canvas class="graph-cv"></canvas><div class="g-empty hidden">no links yet — write [[note]] links</div></div>` +
    `</div>`
  );
}

export function graphToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  return `> [!graph] ${DS(card.dataset.title) ?? "vault map"}`;
}

export function buildGraphCard(title: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout graph-card";
  card.dataset.kind = "graph";
  card.dataset.title = title || "vault map";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">◈ ${esc(title || "vault map")}</span>` +
    `<span class="graph-tools hidden"><input class="g-filter" placeholder="filter…" spellcheck="false"/>` +
    `<button class="g-t" data-a="local" title="center the open note — depth 1→2">local</button>` +
    `<button class="g-t on" data-a="all" title="whole vault">all</button></span></div>` +
    `<div class="callout-body"><canvas class="graph-cv"></canvas><div class="g-empty hidden">no links yet — write [[note]] links</div></div>`;
  return card;
}

export function wireGraph(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.graphWired) return;
  card.dataset.graphWired = "1";
  const cv = card.querySelector<HTMLCanvasElement>(".graph-cv")!;
  if (!cv) return;
  /* CPU-only rendering: plain Canvas2D everywhere, identical on every
   * machine — GPU scenes were dropped so no-GPU users get the same app */
  const ctx = cv.getContext("2d");

  let nodes: GNode[] = [];
  let edges: GEdge[] = [];
  let raf = 0;
  let drag: { i: number; moved: boolean } | null = null;
  let hover = -1;
  let center: string | null = null;
  let mode: "all" | "local" = "all";
  let modeVisible: Set<number> | null = null; // local mode's ≤2-hop set
  let filter = "";
  let visible: Set<number> | null = null; // mode ∩ filter — what paint/hit see

  /** mode neighborhood ∩ filter text → the final visibility set */
  function applyVis() {
    const f = filter.trim().toLowerCase();
    let v: Set<number> | null = null;
    if (f) {
      // bare text → stem substring; `is:`/`prop:`/`#` tokens → the same
      // grammar bases use, over each note's prop map
      const isQuery = /(?:^|\s)-?(?:is:|prop:|#)/.test(f);
      v = new Set<number>();
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i].note;
        const ok = isQuery
          ? baseMatch(f, stem(n), propMaps.get(n) ?? new Map())
          : stem(n).toLowerCase().includes(f);
        if (ok) v.add(i);
      }
    }
    visible =
      modeVisible && v
        ? new Set([...modeVisible].filter((i) => v!.has(i)))
        : modeVisible ?? v;
    card.querySelector(".g-empty")?.classList.toggle(
      "hidden",
      !f || (visible?.size ?? 0) > 0,
    );
    if (f && visible && !visible.size)
      card.querySelector(".g-empty")!.textContent = `no notes match “${filter}”`;
    else card.querySelector(".g-empty")!.textContent = "no links yet — write [[note]] links";
    paint();
  }

  const accent = () => getComputedStyle(card).getPropertyValue("--accent").trim() || "#a05a2c";

  let propMaps = new Map<string, Map<string, string>>();

  async function load() {
    const ix = await invoke<IndexLike & { links: [string, string][] }>("vault_index").catch(() => null);
    if (!ix) return;
    propMaps = buildPropMaps(ix);
    const stemOf = new Map<string, number>();
    nodes = ix.notes.map((n, i) => {
      const s = stem(n);
      if (!stemOf.has(s)) stemOf.set(s, i);
      const ang = (i * 2.39996) % (Math.PI * 2); // golden-angle scatter
      return { note: n, x: Math.cos(ang) * (8 + i % 5 * 14), y: Math.sin(ang) * (8 + i % 5 * 14), vx: 0, vy: 0, deg: 0 };
    });
    edges = [];
    for (const [from, toStem] of ix.links) {
      const a = ix.notes.indexOf(from);
      const b = stemOf.get(toStem.replace(/[#|].*$/, "").trim());
      if (a >= 0 && b !== undefined && a !== b) edges.push({ a, b });
    }
    for (const e of edges) { nodes[e.a].deg++; nodes[e.b].deg++; }
    card.querySelector(".g-empty")?.classList.toggle("hidden", edges.length > 0);
    card.querySelector(".graph-tools")?.classList.toggle("hidden", !edges.length);
    kick();
  }

  function kick() {
    cancelAnimationFrame(raf);
    let cool = 1;
    const step = () => {
      cool *= 0.985;
      sim(cool);
      paint();
      if (cool > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  /* WASM kernel — positions/velocities/edges copy into linear memory,
   * one graph_step call, copy back. O(n) marshalling vs O(n²) compute.
   * Falls back to the JS sim below when the kernel isn't loaded yet or
   * the graph exceeds its fixed buffers. */
  let kernel: Kernel | null = null;
  void loadKernel().then((k) => { kernel = k; });

  function sim(cool: number) {
    /* scene coords are CSS px in both renderers (2d scales via setTransform,
     * Pixi via autoDensity) — clientWidth is correct under either owner */
    const w = cv.clientWidth || 500;
    const h = cv.clientHeight || 380;
    const cx = w / 2, cy = h / 2;
    const LINK = 90;
    const n = nodes.length;
    if (kernel && n <= kernel.maxNodes && edges.length <= kernel.maxEdges) {
      const ci = center ? nodes.findIndex((nd) => nd.note === center) : -1;
      for (let i = 0; i < n; i++) {
        kernel.pos[i * 2] = nodes[i].x;
        kernel.pos[i * 2 + 1] = nodes[i].y;
        kernel.vel[i * 2] = nodes[i].vx;
        kernel.vel[i * 2 + 1] = nodes[i].vy;
      }
      for (let e = 0; e < edges.length; e++) {
        kernel.edges[e * 2] = edges[e].a;
        kernel.edges[e * 2 + 1] = edges[e].b;
      }
      kernel.graphStep(n, edges.length, w, h, cool, ci);
      for (let i = 0; i < n; i++) {
        nodes[i].x = kernel.pos[i * 2];
        nodes[i].y = kernel.pos[i * 2 + 1];
        nodes[i].vx = kernel.vel[i * 2];
        nodes[i].vy = kernel.vel[i * 2 + 1];
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const n = nodes[i];
      // repel (inverse-square-ish, capped)
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j];
        let dx = n.x - m.x, dy = n.y - m.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 4; }
        const f = Math.min(1400 / d2, 8) * cool;
        const d = Math.sqrt(d2);
        n.vx += (dx / d) * f; n.vy += (dy / d) * f;
        m.vx -= (dx / d) * f; m.vy -= (dy / d) * f;
      }
      // center pull — local mode pulls the open note to the middle
      const pull = center && nodes[i].note === center ? 0.08 : 0.012;
      n.vx += (cx - n.x) * pull * cool;
      n.vy += (cy - n.y) * pull * cool;
    }
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(4, Math.hypot(dx, dy));
      const f = (d - LINK) * 0.004 * cool; // Hooke spring
      a.vx += (dx / d) * f * d * 0.01 + dx * f * 0.04;
      a.vy += (dy / d) * f * d * 0.01 + dy * f * 0.04;
      b.vx -= (dx / d) * f * d * 0.01 + dx * f * 0.04;
      b.vy -= (dy / d) * f * d * 0.01 + dy * f * 0.04;
    }
    for (const n of nodes) {
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
    }
  }

  function paint() {
    if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ac = accent();
    ctx.strokeStyle = "rgba(140,130,120,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const e of edges) {
      if (visible && (!visible.has(e.a) || !visible.has(e.b))) continue;
      ctx.moveTo(nodes[e.a].x, nodes[e.a].y);
      ctx.lineTo(nodes[e.b].x, nodes[e.b].y);
    }
    ctx.stroke();
    for (let i = 0; i < nodes.length; i++) {
      if (visible && !visible.has(i)) continue;
      const n = nodes[i];
      const r = 3 + Math.min(6, n.deg);
      const isCur = n.note === center;
      ctx.beginPath();
      ctx.arc(n.x, n.y, i === hover ? r + 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = isCur || i === hover ? ac : "rgba(180,170,155,.75)";
      ctx.fill();
      ctx.fillStyle = i === hover ? ac : "rgba(160,150,135,.9)";
      ctx.font = `${i === hover ? 11.5 : 10.5}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText(stem(n.note), n.x, n.y - r - 4);
    }
  }

  const at = (ev: MouseEvent) => {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (visible && !visible.has(i)) continue;
      const d = Math.hypot(nodes[i].x - x, nodes[i].y - y);
      const hit = Math.max(13, 7 + Math.min(6, nodes[i].deg));
      if (d < hit && d < bd) { best = i; bd = d; }
    }
    return best;
  };

  cv.addEventListener("mousedown", (e) => {
    const i = at(e);
    if (i < 0) return;
    drag = { i, moved: false };
    e.preventDefault();
  });
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    if (drag) {
      nodes[drag.i].x = e.clientX - r.left;
      nodes[drag.i].y = e.clientY - r.top;
      nodes[drag.i].vx = nodes[drag.i].vy = 0;
      drag.moved = true;
      paint();
      return;
    }
    const i = at(e);
    if (i !== hover) { hover = i; cv.style.cursor = i >= 0 ? "pointer" : "grab"; paint(); }
  });
  cv.addEventListener("mouseup", () => {
    if (!drag) return;
    const { i, moved } = drag;
    drag = null;
    if (!moved) {
      // click = open the note (Obsidian behavior); drag = arrange
      document.dispatchEvent(new CustomEvent("nav:open", { detail: nodes[i].note }));
    }
  });
  cv.addEventListener("mouseleave", () => { hover = -1; drag = null; paint(); });

  const localBtn = card.querySelector('[data-a="local"]')!;
  const allBtn = card.querySelector('[data-a="all"]')!;
  const setMode = (m: "all" | "local") => {
    mode = m;
    center = m === "local" ? currentNoteName() : null;
    localBtn.classList.toggle("on", m === "local");
    allBtn.classList.toggle("on", m === "all");
    // local = the open note + its ≤2-hop neighborhood (Obsidian's depth slider)
    modeVisible = null;
    if (m === "local" && center) {
      const adj = new Map<number, number[]>();
      for (const e of edges) {
        if (!adj.has(e.a)) adj.set(e.a, []);
        adj.get(e.a)!.push(e.b);
        if (!adj.has(e.b)) adj.set(e.b, []);
        adj.get(e.b)!.push(e.a);
      }
      const ci = nodes.findIndex((n) => n.note === center);
      if (ci >= 0) {
        modeVisible = new Set<number>([ci]);
        let frontier = [ci];
        for (let hop = 0; hop < 2; hop++) {
          const next: number[] = [];
          for (const f of frontier)
            for (const nb of adj.get(f) ?? [])
              if (!modeVisible.has(nb)) { modeVisible.add(nb); next.push(nb); }
          frontier = next;
        }
        nodes[ci].x = cv.clientWidth / 2;
        nodes[ci].y = cv.clientHeight / 2;
      }
    }
    applyVis();
    kick();
  };
  localBtn.addEventListener("click", () => setMode(mode === "local" ? "all" : "local"));
  allBtn.addEventListener("click", () => setMode("all"));
  const filterBox = card.querySelector<HTMLInputElement>(".g-filter")!;
  filterBox.addEventListener("input", () => {
    filter = filterBox.value;
    applyVis();
  });
  filterBox.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { filterBox.value = ""; filter = ""; applyVis(); }
    e.stopPropagation(); // card keys (undo etc.) stay out of the textbox
  });

  new ResizeObserver(() => paint()).observe(cv);
  void load();
}

/** the open note's filename — read from the persisted tab state so
 *  graph.ts never has to import the editor module graph */
function currentNoteName(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem("laido.tabs") ?? "null") as
      | { active?: string }
      | null;
    return saved?.active || null;
  } catch {
    return null;
  }
}
