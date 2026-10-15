/* ---------- canvas — freeform drawing card ------------------------------
 * `[!canvas] title` + a `> {"v":1,"elements":[…]}` line persists an
 * Excalidraw-lite scene: elements carry id/type/geometry, the JSON travels
 * inside the callout so the file stays plain markdown. Tools: select,
 * rect, ellipse, arrow, freehand, text. Click-drag draws; select moves;
 * Delete removes; dbl-click a text to edit it. */

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface CEl {
  id: string;
  t: "rect" | "ellipse" | "line" | "draw" | "text";
  x: number;
  y: number;
  w: number;
  h: number;
  pts?: [number, number][];
  text?: string;
  c?: string; // stroke: ink | accent | ok | warn | dim
  r?: number; // rotation, degrees — R / Shift+R on a selection
}

interface Scene { v: number; elements: CEl[] }

let uid = 0;
const nid = () => `e${Date.now().toString(36)}${(uid++).toString(36)}`;

/** cross-card clipboard — module scope so Ctrl+V in canvas B pastes
 *  what canvas A copied (Excalidraw's app-level clipboard) */
let clip: CEl[] = [];

/** re-base a draw element: pts become 0-origin, w/h = extents. Older
 *  scenes saved before the fix have degenerate boxes (w=h=0) and can
 *  drift negative — normalize makes them selectable/resizable. */
function normalizeDraw(el: CEl) {
  if (el.t !== "draw" || !el.pts?.length) return;
  const xs = el.pts.map((p) => p[0]), ys = el.pts.map((p) => p[1]);
  const mx = Math.min(0, ...xs), my = Math.min(0, ...ys);
  if (mx || my || !el.w || !el.h) {
    el.x += mx; el.y += my;
    el.pts = el.pts.map(([a, b]) => [a - mx, b - my]);
    el.w = Math.max(1, Math.max(...el.pts.map((p) => p[0])));
    el.h = Math.max(1, Math.max(...el.pts.map((p) => p[1])));
  }
}

function parseScene(raw: string): Scene {
  try {
    const s = JSON.parse(raw) as Scene;
    if (Array.isArray(s.elements)) {
      for (const el of s.elements) normalizeDraw(el);
      return { v: 1, elements: s.elements };
    }
  } catch { /* malformed scene → blank canvas */ }
  return { v: 1, elements: [] };
}

const TOOLS: [string, string, string][] = [
  ["sel", "⇱", "select / move (V)"],
  ["rect", "▭", "rectangle (R)"],
  ["ellipse", "◯", "ellipse (O)"],
  ["line", "↗", "line (L)"],
  ["draw", "✏", "freehand (D)"],
  ["text", "T", "text (X)"],
];

/** ink|accent|ok|warn|dim — the style bar's named palette (theme vars) */
const COLORS = ["ink", "accent", "ok", "warn", "dim"];

const toolsHtml = () =>
  `<span class="cv-tools" contenteditable="false">` +
  TOOLS.map(([k, g, tip]) => `<button class="cv-t" data-t="${k}" title="${tip}">${g}</button>`).join("") +
  `<button class="cv-t cv-del" title="delete selected (Del)">⌫</button>` +
  `<span class="cv-style hidden">` +
  COLORS.map((c) => `<button class="cv-c" data-c="${c}" title="stroke: ${c}"></button>`).join("") +
  `</span></span>`;

export function canvasCallout(block: string[]): string {
  if (!Array.isArray(block)) block = [];
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "canvas";
  const scene = block.slice(1).join("\n").trim();
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout canvas-card" data-kind="canvas" data-title="${esc(topic)}"` +
    ` data-scene="${esc(scene)}" data-md="${esc(raw)}">` +
    `<div class="callout-head"><span class="callout-title">✏ ${esc(topic)}</span>${toolsHtml()}</div>` +
    `<div class="callout-body"><canvas class="cv-cv"></canvas>` +
    `<input class="cv-text hidden" spellcheck="false"/></div>` +
    `</div>`
  );
}

export function buildCanvasCard(title: string): HTMLElement {
  title = String(title ?? "");
  const card = document.createElement("div");
  card.className = "callout canvas-card";
  card.dataset.kind = "canvas";
  card.dataset.title = title || "canvas";
  card.dataset.scene = "";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">✏ ${esc(title || "canvas")}</span>${toolsHtml()}</div>` +
    `<div class="callout-body"><canvas class="cv-cv"></canvas>` +
    `<input class="cv-text hidden" spellcheck="false"/></div>`;
  return card;
}

/** scene → the two-line `[!canvas]` callout that round-trips it */
export function canvasToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const scene = card.dataset.scene?.trim();
  return `> [!canvas] ${card.dataset.title ?? "canvas"}` + (scene ? `\n> ${scene}` : "");
}

export function wireCanvas(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.canvasWired) return;
  card.dataset.canvasWired = "1";
  const cv = card.querySelector<HTMLCanvasElement>(".cv-cv")!;
  if (!cv) return;
  const ctx = cv.getContext("2d")!;
  if (!ctx) return;
  const textIn = card.querySelector<HTMLInputElement>(".cv-text")!;

  let scene = parseScene(card.dataset.scene ?? "");
  let tool: string = "sel";
  let selIds = new Set<string>();
  let draft: CEl | null = null;
  // drag-move: start positions of every selected element + the anchor
  let moving: { start: Map<string, { x: number; y: number }>; ax: number; ay: number } | null = null;
  // snap guide lines — x/y are world-axis (move, unrotated resize);
  // fx/fy are frame-space with a (cx,cy,rad) frame for rotated resize
  let guides: {
    x?: number; y?: number;
    fx?: number; fy?: number; cx?: number; cy?: number; rad?: number;
  } | null = null;
  /** nearest edge/center target within 6px — shared by move + resize */
  const snap6 = (mv: number[], targets: number[]) => {
    let best: number | null = null, win = 0;
    for (const m of mv)
      for (const t of targets) {
        const d = t - m;
        if (Math.abs(d) <= 6 && (best === null || Math.abs(d) < Math.abs(best))) {
          best = d; win = t;
        }
      }
    return best === null ? null : { d: best, g: win };
  };
  // rubber-band select — drag on empty space in sel mode
  let band: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let textAt: { x: number; y: number; edit?: string } | null = null;
  // corner-resize drag — anchored at the opposite corner; pts scaled
  // for draw elements. Single selection only (text has no handles —
  // its box derives from content).
  let resizing: {
    id: string;
    ax: number; ay: number;          // anchor corner (canvas px)
    ox: number; oy: number;          // origin (element x/y at start)
    ow: number; oh: number;          // orig w/h
    r: number;                       // element rotation (deg) at start
    cx: number; cy: number;          // bbox center at start
    pts?: [number, number][];
  } | null = null;
  const HANDLE = 7;
  /** tight extents — bbox() pads +4 for hit slop, resize wants exact */
  const rawBox = (el: CEl) => ({
    x0: Math.min(el.x, el.x + el.w),
    y0: Math.min(el.y, el.y + el.h),
    x1: Math.max(el.x, el.x + el.w),
    y1: Math.max(el.y, el.y + el.h),
  });
  /** world-space corners — rotated elements put handles on the rotated
   *  box so you grab what you see */
  const corners = (el: CEl) => {
    const b = rawBox(el);
    const pts = [
      { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
      { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
    ];
    if (!el.r) return pts;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const a = (el.r * Math.PI) / 180;
    return pts.map((p) => ({
      x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a),
      y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a),
    }));
  };

  const cssVar = (n: string, fb: string) =>
    getComputedStyle(card).getPropertyValue(n).trim() || fb;
  const ink = () => cssVar("--ink", "#e8e4da");
  const accent = () => cssVar("--accent", "#a05a2c");
  /** named palette → resolved css color (ink default) */
  const colorFor = (c?: string) =>
    c === "accent" ? accent()
    : c === "ok" ? cssVar("--ok", "#7fb069")
    : c === "warn" ? cssVar("--warn", "#c96a5a")
    : c === "dim" ? cssVar("--dim", "#94897a")
    : ink();

  /** scene → dataset + dirty+save via the card's changed event */
  function sync() {
    card.dataset.scene = JSON.stringify({ v: 1, elements: scene.elements });
    card.dispatchEvent(new CustomEvent("canvas:changed", { bubbles: true }));
  }

  const pos = (e: MouseEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const bbox = (el: CEl) => ({
    x0: Math.min(el.x, el.x + el.w) - 4,
    y0: Math.min(el.y, el.y + el.h) - 4,
    x1: Math.max(el.x, el.x + el.w) + 4,
    y1: Math.max(el.y, el.y + el.h) + 4,
  });

  function hit(p: { x: number; y: number }): string | null {
    for (let i = scene.elements.length - 1; i >= 0; i--) {
      const el = scene.elements[i];
      let pp = p;
      if (el.r) {
        // counter-rotate the pointer into the element's frame
        const b0 = rawBox(el);
        const cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2;
        const a = (-el.r * Math.PI) / 180;
        pp = {
          x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a),
          y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a),
        };
      }
      const b = bbox(el);
      if (pp.x >= b.x0 && pp.x <= b.x1 && pp.y >= b.y0 && pp.y <= b.y1)
        return el.id;
    }
    return null;
  }

  function draw(el: CEl, ghost = false) {
    if (el.r) {
      const b = rawBox(el);
      ctx.save();
      ctx.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      ctx.rotate((el.r * Math.PI) / 180);
      ctx.translate(-(b.x0 + b.x1) / 2, -(b.y0 + b.y1) / 2);
    }
    ctx.strokeStyle = ghost ? accent() : colorFor(el.c);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    if (el.t === "rect") ctx.rect(el.x, el.y, el.w, el.h);
    else if (el.t === "ellipse")
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
    else if (el.t === "line") {
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x + el.w, el.y + el.h);
      // arrowhead
      const a = Math.atan2(el.h, el.w);
      const hx = el.x + el.w, hy = el.y + el.h;
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - 11 * Math.cos(a - 0.45), hy - 11 * Math.sin(a - 0.45));
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - 11 * Math.cos(a + 0.45), hy - 11 * Math.sin(a + 0.45));
    } else if (el.t === "draw" && el.pts?.length) {
      ctx.moveTo(el.x + el.pts[0][0], el.y + el.pts[0][1]);
      for (const [dx, dy] of el.pts.slice(1)) ctx.lineTo(el.x + dx, el.y + dy);
    }
    ctx.stroke();
    if (el.t === "text") {
      ctx.font = "15px system-ui";
      ctx.textBaseline = "top";
      (el.text ?? "").split("\n").forEach((l, i) => ctx.fillText(l, el.x, el.y + i * 19));
    }
    if (el.r) ctx.restore();
  }

  function paint() {
    const dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const el of scene.elements) draw(el);
    if (draft) draw(draft, true);
    ctx.strokeStyle = accent();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    for (const el of scene.elements) {
      if (!selIds.has(el.id)) continue;
      const b = bbox(el);
      ctx.strokeRect(b.x0 - 1, b.y0 - 1, b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
    }
    // resize handles on a lone non-text selection — rotated too: the
    // handles sit on the rotated corners
    if (selIds.size === 1) {
      const el = scene.elements.find((x) => selIds.has(x.id));
      if (el && el.t !== "text") {
        ctx.setLineDash([]);
        ctx.fillStyle = accent();
        for (const c of corners(el)) {
          ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
          ctx.strokeRect(c.x - 3, c.y - 3, 6, 6);
        }
        ctx.setLineDash([4, 3]);
      }
    }
    // snap guides — accent hairlines at the winning edge/center;
    // frame-space guides rotate with the element's axes
    if (guides) {
      ctx.strokeStyle = accent();
      ctx.lineWidth = 1;
      if (guides.x !== undefined) {
        ctx.beginPath();
        ctx.moveTo(guides.x + 0.5, 0); ctx.lineTo(guides.x + 0.5, cv.height);
        ctx.stroke();
      }
      if (guides.y !== undefined) {
        ctx.beginPath();
        ctx.moveTo(0, guides.y + 0.5); ctx.lineTo(cv.width, guides.y + 0.5);
        ctx.stroke();
      }
      if (guides.fx !== undefined || guides.fy !== undefined) {
        ctx.save();
        ctx.translate(guides.cx ?? 0, guides.cy ?? 0);
        ctx.rotate(guides.rad ?? 0);
        const far = cv.width + cv.height;
        if (guides.fx !== undefined) {
          ctx.beginPath();
          ctx.moveTo(guides.fx + 0.5, -far); ctx.lineTo(guides.fx + 0.5, far);
          ctx.stroke();
        }
        if (guides.fy !== undefined) {
          ctx.beginPath();
          ctx.moveTo(-far, guides.fy + 0.5); ctx.lineTo(far, guides.fy + 0.5);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (band) {
      ctx.strokeRect(
        Math.min(band.x0, band.x1), Math.min(band.y0, band.y1),
        Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
    }
    ctx.setLineDash([]);
    card.querySelector(".cv-style")?.classList.toggle("hidden", selIds.size === 0);
  }

  function commitText() {
    if (!textAt) return;
    const v = textIn.value.trim();
    if (textAt.edit) {
      const el = scene.elements.find((e) => e.id === textAt!.edit);
      if (el) {
        if (v) el.text = v;
        else scene.elements = scene.elements.filter((e) => e.id !== el.id);
        el.w = Math.max(30, v.length * 8);
        el.h = Math.max(19, v.split("\n").length * 19);
      }
    } else if (v) {
      scene.elements.push({
        id: nid(), t: "text", x: textAt.x, y: textAt.y,
        w: Math.max(30, v.length * 8), h: Math.max(19, v.split("\n").length * 19), text: v,
      });
    }
    textAt = null;
    textIn.classList.add("hidden");
    sync();
    paint();
  }

  cv.addEventListener("mousedown", (e) => {
    const p = pos(e);
    if (tool === "sel") {
      // a lone non-text selection gets corner handles — grab one first
      if (selIds.size === 1 && !e.shiftKey) {
        const sel = scene.elements.find((x) => selIds.has(x.id));
        if (sel && sel.t !== "text") {
          const ci = corners(sel).findIndex(
            (c) => Math.abs(p.x - c.x) <= HANDLE && Math.abs(p.y - c.y) <= HANDLE);
          if (ci >= 0) {
            // anchor = opposite corner *in unrotated space* (rawBox) —
            // for r=0 that is also its world position
            const b = rawBox(sel);
            const boxCorners = [
              { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
              { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
            ];
            const anchor = boxCorners[(ci + 2) % 4];
            resizing = {
              id: sel.id, ax: anchor.x, ay: anchor.y,
              ox: b.x0, oy: b.y0, ow: b.x1 - b.x0, oh: b.y1 - b.y0,
              r: sel.r ?? 0, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2,
              pts: sel.pts?.map((pt) => [...pt] as [number, number]),
            };
            e.preventDefault();
            return;
          }
        }
      }
      const id = hit(p);
      if (e.shiftKey) {
        // shift-click toggles membership without starting a move
        if (id) { selIds.has(id) ? selIds.delete(id) : selIds.add(id); }
        paint();
        return;
      }
      if (id) {
        if (!selIds.has(id)) selIds = new Set([id]);
        // move carries the whole selection — record every start position
        moving = {
          ax: p.x, ay: p.y,
          start: new Map(
            scene.elements.filter((x) => selIds.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }]),
          ),
        };
      } else {
        selIds = new Set();
        band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      }
      paint();
      return;
    }
    if (tool === "text") {
      commitText();
      const r = cv.getBoundingClientRect();
      textAt = { x: p.x, y: p.y };
      textIn.value = "";
      textIn.style.left = `${p.x}px`;
      textIn.style.top = `${p.y}px`;
      textIn.style.width = `${Math.max(60, r.width - p.x - 8)}px`;
      textIn.classList.remove("hidden");
      textIn.focus();
      return;
    }
    // shape tools — start a draft element
    draft = { id: nid(), t: tool as CEl["t"], x: p.x, y: p.y, w: 0, h: 0 };
    if (tool === "draw") draft.pts = [[0, 0]];
    selIds = new Set();
    e.preventDefault();
  });

  cv.addEventListener("mousemove", (e) => {
    const p = pos(e);
    if (resizing) {
      const el = scene.elements.find((x) => x.id === resizing!.id);
      if (el) {
        // work in the element's unrotated frame: map the pointer back
        // around the drag-start center, resize the box, then rotate the
        // new center forward — the anchor corner stays put in the world
        const rad = (resizing.r * Math.PI) / 180;
        const cosA = Math.cos(rad), sinA = Math.sin(rad);
        const toFrame = (wx: number, wy: number) => ({
          x: resizing!.cx + (wx - resizing!.cx) * cosA + (wy - resizing!.cy) * sinA,
          y: resizing!.cy - (wx - resizing!.cx) * sinA + (wy - resizing!.cy) * cosA,
        });
        const pu = toFrame(p.x, p.y);
        let px = pu.x, py = pu.y;
        guides = null;
        if (!resizing.r) {
          const xs2: number[] = [], ys2: number[] = [];
          for (const o of scene.elements) {
            if (o.id === resizing.id) continue;
            const b2 = rawBox(o);
            xs2.push(b2.x0, (b2.x0 + b2.x1) / 2, b2.x1);
            ys2.push(b2.y0, (b2.y0 + b2.y1) / 2, b2.y1);
          }
          const sxN = snap6([pu.x], xs2), syN = snap6([pu.y], ys2);
          px = pu.x + (sxN?.d ?? 0); py = pu.y + (syN?.d ?? 0);
          guides = { x: sxN?.g, y: syN?.g };
        } else {
          // frame-space guides — other elements' corners mapped into the
          // frame; the winning guide draws rotated along the frame axis
          const xs2: number[] = [], ys2: number[] = [];
          for (const o of scene.elements) {
            if (o.id === resizing.id) continue;
            const b2 = rawBox(o);
            for (const wx of [b2.x0, (b2.x0 + b2.x1) / 2, b2.x1])
              for (const wy of [b2.y0, (b2.y0 + b2.y1) / 2, b2.y1]) {
                const f = toFrame(wx, wy);
                xs2.push(f.x);
                ys2.push(f.y);
              }
          }
          const sxN = snap6([pu.x], xs2), syN = snap6([pu.y], ys2);
          px = pu.x + (sxN?.d ?? 0); py = pu.y + (syN?.d ?? 0);
          if (sxN || syN)
            guides = { fx: sxN?.g, fy: syN?.g, cx: resizing.cx, cy: resizing.cy, rad };
        }
        const nx0 = Math.min(resizing.ax, px), ny0 = Math.min(resizing.ay, py);
        const nx1 = Math.max(resizing.ax, px), ny1 = Math.max(resizing.ay, py);
        const w2 = nx1 - nx0, h2 = ny1 - ny0;
        // new box center (frame) → world; keeps the anchor fixed
        const cwx = resizing.cx + (((nx0 + nx1) / 2) - resizing.cx) * cosA -
          (((ny0 + ny1) / 2) - resizing.cy) * sinA;
        const cwy = resizing.cy + (((nx0 + nx1) / 2) - resizing.cx) * sinA +
          (((ny0 + ny1) / 2) - resizing.cy) * cosA;
        el.x = cwx - w2 / 2; el.y = cwy - h2 / 2; el.w = w2; el.h = h2;
        if (el.t === "draw" && el.pts && resizing.pts) {
          // scale each stroke point from the old box into the new one
          const sx = resizing.ow ? (nx1 - nx0) / resizing.ow : 1;
          const sy = resizing.oh ? (ny1 - ny0) / resizing.oh : 1;
          el.pts = resizing.pts.map(([px, py]) => [
            px * sx, py * sy,
          ] as [number, number]);
        }
        paint();
      }
      return;
    }
    if (moving) {
      let dx = p.x - moving.ax, dy = p.y - moving.ay;
      // snap the moving set's bbox to other elements' edges/centers —
      // show the guide line that won
      guides = null;
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
      for (const [id, s0] of moving.start) {
        const el = scene.elements.find((x) => x.id === id);
        if (!el) continue;
        const b = rawBox({ ...el, x: s0.x + dx, y: s0.y + dy });
        bx0 = Math.min(bx0, b.x0); by0 = Math.min(by0, b.y0);
        bx1 = Math.max(bx1, b.x1); by1 = Math.max(by1, b.y1);
      }
      if (bx0 < 1e8) {
        const xs: number[] = [], ys: number[] = [];
        for (const el of scene.elements) {
          if (moving.start.has(el.id)) continue;
          const b = rawBox(el);
          xs.push(b.x0, (b.x0 + b.x1) / 2, b.x1);
          ys.push(b.y0, (b.y0 + b.y1) / 2, b.y1);
        }
        const sx = snap6([bx0, (bx0 + bx1) / 2, bx1], xs);
        const sy = snap6([by0, (by0 + by1) / 2, by1], ys);
        if (sx) dx += sx.d;
        if (sy) dy += sy.d;
        guides = { x: sx?.g, y: sy?.g };
      }
      for (const [id, s0] of moving.start) {
        const el = scene.elements.find((x) => x.id === id);
        if (el) { el.x = s0.x + dx; el.y = s0.y + dy; }
      }
      paint();
      return;
    }
    if (band) {
      band.x1 = p.x; band.y1 = p.y;
      const bx0 = Math.min(band.x0, band.x1), by0 = Math.min(band.y0, band.y1);
      const bx1 = Math.max(band.x0, band.x1), by1 = Math.max(band.y0, band.y1);
      selIds = new Set(
        scene.elements.filter((el) => {
          const b = bbox(el);
          return b.x0 < bx1 && b.x1 > bx0 && b.y0 < by1 && b.y1 > by0;
        }).map((el) => el.id),
      );
      paint();
      return;
    }
    if (!draft) return;
    if (draft.t === "draw") draft.pts!.push([p.x - draft.x, p.y - draft.y]);
    else { draft.w = p.x - draft.x; draft.h = p.y - draft.y; }
    paint();
  });

  cv.addEventListener("mouseup", () => {
    if (resizing) { resizing = null; guides = null; sync(); return; }
    if (moving) { moving = null; guides = null; sync(); return; }
    if (band) { band = null; paint(); return; }
    if (!draft) return;
    const tiny = Math.abs(draft.w) < 3 && Math.abs(draft.h) < 3 && (draft.pts?.length ?? 2) < 3;
    if (!tiny) {
      normalizeDraw(draft); // stroke → real bbox before it lands
      scene.elements.push(draft);
    }
    draft = null;
    sync();
    paint();
  });

  cv.addEventListener("mouseleave", () => {
    if (draft && draft.t === "draw") {
      normalizeDraw(draft);
      scene.elements.push(draft);
      draft = null;
      sync();
      paint();
    }
    if (band) { band = null; paint(); }
    if (resizing) { resizing = null; guides = null; sync(); }
  });

  cv.addEventListener("dblclick", (e) => {
    const id = hit(pos(e));
    const el = scene.elements.find((x) => x.id === id);
    if (el?.t !== "text") return;
    textAt = { x: el.x, y: el.y, edit: el.id };
    textIn.value = el.text ?? "";
    textIn.style.left = `${el.x}px`;
    textIn.style.top = `${el.y}px`;
    textIn.classList.remove("hidden");
    textIn.focus();
  });

  textIn.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commitText();
    if (e.key === "Escape") { textAt = null; textIn.classList.add("hidden"); }
  });
  textIn.addEventListener("blur", commitText);

  const delSel = () => {
    if (!selIds.size) return;
    scene.elements = scene.elements.filter((x) => !selIds.has(x.id));
    selIds = new Set();
    sync();
    paint();
  };

  // Ctrl+C/V/D on a selection — Excalidraw convention: paste lands
  // +12/+12 offset and selects the clones (clipboard is module-level,
  // so copies carry across canvases and even across notes)
  const cloneSel = (into: CEl[]) =>
    scene.elements.filter((x) => selIds.has(x.id))
      .forEach((x) => into.push(JSON.parse(JSON.stringify(x))));
  const paste = (from: CEl[]) => {
    if (!from.length) return;
    selIds = new Set();
    for (const src of from) {
      const el: CEl = JSON.parse(JSON.stringify(src));
      el.id = nid();
      el.x += 12;
      el.y += 12;
      scene.elements.push(el);
      selIds.add(el.id);
    }
    sync();
    paint();
  };

  card.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if ((e.key === "Delete" || e.key === "Backspace") && selIds.size) {
      delSel();
      e.preventDefault();
    }
    if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      selIds = new Set(scene.elements.map((x) => x.id));
      paint();
      e.preventDefault();
      return;
    }
    // z-order — `[` sinks, `]` raises (array order = paint order)
    if ((e.key === "[" || e.key === "]") && selIds.size) {
      const fwd = e.key === "]";
      for (const id of selIds) {
        const i = scene.elements.findIndex((x) => x.id === id);
        if (i < 0) continue;
        const j = fwd ? Math.min(i + 1, scene.elements.length - 1)
                      : Math.max(i - 1, 0);
        if (j === i) continue;
        const [el] = scene.elements.splice(i, 1);
        scene.elements.splice(j, 0, el);
      }
      sync();
      paint();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && selIds.size) {
      const k = e.key.toLowerCase();
      if (k === "c") { clip = []; cloneSel(clip); e.preventDefault(); return; }
      if (k === "v") { paste(clip); e.preventDefault(); return; }
      if (k === "d") { const b: CEl[] = []; cloneSel(b); paste(b); e.preventDefault(); return; }
      if (k === "x") { clip = []; cloneSel(clip); delSel(); e.preventDefault(); return; }
    }
    // R rotates the selection ±15° (Shift goes back); bare R with
    // nothing selected is still the rect tool
    if (e.key.toLowerCase() === "r" && selIds.size) {
      for (const el of scene.elements)
        if (selIds.has(el.id))
          el.r = ((el.r ?? 0) + (e.shiftKey ? -15 : 15) + 360) % 360;
      sync();
      paint();
      e.preventDefault();
      return;
    }
    const key = { v: "sel", r: "rect", o: "ellipse", l: "line", d: "draw", x: "text" }[e.key.toLowerCase()];
    if (key) setTool(key);
  });

  const setTool = (t: string) => {
    tool = t;
    card.querySelectorAll(".cv-t[data-t]").forEach((b) =>
      b.classList.toggle("on", (b as HTMLElement).dataset.t === t));
    cv.style.cursor = t === "sel" ? "default" : "crosshair";
  };
  card.querySelectorAll<HTMLElement>(".cv-t[data-t]").forEach((b) =>
    b.addEventListener("click", () => setTool(b.dataset.t!)));
  card.querySelector(".cv-del")!.addEventListener("click", delSel);
  // the style bar — one named stroke color applied to every selection
  card.querySelectorAll<HTMLElement>(".cv-c").forEach((b) =>
    b.addEventListener("click", () => {
      if (!selIds.size) return;
      for (const el of scene.elements)
        if (selIds.has(el.id)) el.c = b.dataset.c === "ink" ? undefined : b.dataset.c;
      sync();
      paint();
    }));

  // the canvas is a drag surface — the head stays the card's drag handle
  cv.setAttribute("draggable", "false");
  new ResizeObserver(() => paint()).observe(cv);
  setTool("sel");
  paint();
}
