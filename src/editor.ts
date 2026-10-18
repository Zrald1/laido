import { $, invoke } from "./ipc.js";
import { renderMarkdown, renderCalloutMd } from "./render.js";
import { addActivity } from "./log.js";
import { serialize, toggleMark, clearFormatting, cardToMd, focusBodyOnCardClick, normalizeCard, nbspWidth, insertTabIndent } from "./editable.js";
import { t } from "./i18n.js";
import { wireTerminal } from "./term.js";
import { buildSheetCard, wireSheet } from "./sheet.js";
import { buildDeckCard, wireDeck } from "./slides.js";
import { buildTodoCard, wireTodo } from "./todo.js";
import { buildBrowserCard, wireBrowser, browserApi, toUrl } from "./browser.js";
import { buildCardsCard, wireCards } from "./cards.js";
import { buildMapCard, wireMap } from "./map.js";
import { buildAgendaCard, wireAgenda, speakDigest } from "./agenda.js";
import { buildGraphCard, wireGraph } from "./graph.js";
import { buildCanvasCard, wireCanvas } from "./canvas.js";
import { buildBaseCard, wireBase } from "./base.js";
import { buildChartCard, wireChart } from "./chart.js";
import { armCardUndo } from "./cardundo.js";
import { sliceBlock, sliceSection, spliceSection, spliceBlock } from "./slices.js";
import { matchWikiCtx, splitWikiQuery } from "./wikictx.js";
import { refreshIndex, paintLinkStrip, initPalette, openToday, initOutline, refreshOutline, vaultIndex } from "./links.js";
import { initFind } from "./find.js";
import { stem } from "./match.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

let current = "";
/** the toolbar shows just the name — the extension lives in the file itself */
const titleName = (n: string) => n.replace(/\.(laido|md)$/, "");
let timer: number | undefined;
let snapTimer: number | undefined;
let dirty = false;
let pencilBlock: HTMLElement | null = null;
let pencilTimer: number | undefined;

export function currentNote(): string {
  return current;
}

export function isDirty(): boolean {
  return dirty;
}

function setState(s: string) {
  $("#save-state").textContent = s;
}

// zero-width spaces (the empty-line marker) survive trim() — strip them too,
// so a command typed on a previously-saved blank line still parses
const clean = (s: string) => s.replace(/[*=`>~]/g, "").replace(/[\u200b\ufeff]/g, "").trim();
const body = () => $<HTMLDivElement>("#note-body");

let paperZoom = Math.min(2.5, Math.max(0.4, parseFloat(localStorage.getItem("laido.zoom") ?? "1") || 1));
const Z = () => paperZoom;
function applyZoom(z: number) {
  paperZoom = Math.min(2.5, Math.max(0.4, z));
  const el = body();
  el.style.setProperty("zoom", String(paperZoom));
  localStorage.setItem("laido.zoom", String(paperZoom));
  el.dispatchEvent(new CustomEvent("laido:zoom", { detail: paperZoom }));
}

const HL_COLORS: Record<string, string> = {
  yellow: "#ffe58a",
  green: "#b8e6a3",
  blue: "#a8d3f0",
  pink: "#f5b8cf",
  orange: "#ffd0a3",
  purple: "#d9c2f0",
};
let hlColor = "yellow";

export const STICKY_COLORS: Record<string, string> = {
  yellow: "#f7e37b",
  green: "#cde6a5",
  blue: "#b9d9f2",
  pink: "#f6c6d8",
  orange: "#fbd9a8",
  purple: "#dcc8f0",
};
let stickyColor = localStorage.getItem("laido.stickycolor") ?? "yellow";
if (!STICKY_COLORS[stickyColor]) stickyColor = "yellow";

let onRenamedCb: ((oldName: string, next: string) => void) | null = null;
let onSaveAsCb: ((next: string) => void) | null = null;

export function setFileCallbacks(
  onRenamed: (oldName: string, next: string) => void,
  onSaveAs: (next: string) => void,
) {
  onRenamedCb = onRenamed;
  onSaveAsCb = onSaveAs;
}

function avoidOverlap(card: HTMLElement) {
  const editor = body();
  const floating = Array.from(editor.querySelectorAll(".callout.floating")) as HTMLElement[];
  if (card.classList.contains("floating")) {
    // spawned floaters land dead-center on top of each other — cascade the
    // newcomer down-right until it clears the pile; a browser card's webview
    // is a native surface, so stacked cards paint two pages in one rect
    let dx = parseFloat(card.style.left) || 0;
    let dy = parseFloat(card.style.top) || 0;
    const others = floating.filter((f) => f !== card);
    if (!others.length) return;
    for (let tries = 0; tries < 24; tries++) {
      const c = card.getBoundingClientRect();
      const blocked = others.some((f) => {
        const r = f.getBoundingClientRect();
        const ox = Math.min(c.right, r.right) - Math.max(c.left, r.left);
        const oy = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
        return ox > Math.min(c.width, r.width) * 0.5 && oy > Math.min(c.height, r.height) * 0.5;
      });
      if (!blocked) break;
      dx += 36;
      dy += 32;
      card.style.left = `${dx}px`;
      card.style.top = `${dy}px`;
    }
    writeState(card, { x: dx, y: dy });
    return;
  }
  if (floating.length === 0) return;
  const c = card.getBoundingClientRect();
  let shift = 0;
  for (const f of floating) {
    if (f === card) continue;
    const r = f.getBoundingClientRect();
    const xOverlap = c.left < r.right && r.left < c.right;
    if (!xOverlap) continue;
    const needed = r.bottom - c.top + 14;
    if (needed > 0) shift = Math.max(shift, needed);
  }
  if (shift > 0) {
    const cur = parseFloat(getComputedStyle(card).marginTop) || 0;
    card.style.marginTop = `${cur + shift}px`;
    card.classList.add("avoided");
  }
}

export function markEdited(flow = true) {
  dirty = true;
  setState(t("ed.saving"));
  clearTimeout(timer);
  timer = window.setTimeout(() => void save(), 800);
  /* flow=false skips the card-flow pass — callers that dirty the note
   * without moving text (typing inside a card's own fields) must not pay
   * a full-page reflow + link redraw per keystroke */
  if (flow) scheduleFlow();
}

/* ---------- card undo host — snapshot/restore widget cards ----------
 * restore = re-render the card's markdown in place and re-wire its
 * widget (each wire fn is flag-guarded, so the flag is cleared first).
 * Sheets keep their own finer undo; everything else rides this stack. */
const KIND_WIRE: Record<string, [string, (c: HTMLElement) => void]> = {
  sheet: ["sheetWired", (c) => wireSheet(c)],
  terminal: ["wired", wireTerminal],
  deck: ["deckWired", wireDeck],
  todo: ["todoWired", wireTodo],
  browser: ["browserWired", wireBrowser],
  cards: ["cardsWired", wireCards],
  map: ["mapWired", wireMap],
  agenda: ["agendaWired", wireAgenda],
  graph: ["graphWired", wireGraph],
  canvas: ["canvasWired", wireCanvas],
  base: ["baseWired", wireBase],
  chart: ["chartWired", wireChart],
};

function restoreCardMd(card: HTMLElement, md: string) {
  const tmp = document.createElement("div");
  tmp.innerHTML = renderMarkdown(md);
  const fresh = tmp.firstElementChild as HTMLElement | null;
  if (!fresh || !fresh.classList.contains("callout")) return;
  card.innerHTML = fresh.innerHTML;
  for (const k of Object.keys(fresh.dataset)) {
    if (["state", "enhanced", "undoWired", "slot"].includes(k)) continue;
    card.dataset[k] = fresh.dataset[k];
  }
  // inner elements may carry their own wired flags from the render
  const w = KIND_WIRE[card.dataset.kind ?? ""];
  if (w) {
    delete card.dataset[w[0]];
    w[1](card);
  }
  markEdited();
}

export function cardUndoHost() {
  return {
    serialize: (c: HTMLElement) => cardToMd(c),
    restore: restoreCardMd,
  };
}

/* ---------- text wraps beside floating cards ---------- */

const FLOW_TAGS = new Set(["P", "H1", "H2", "H3", "UL", "OL", "BLOCKQUOTE"]);

/** Cards have arbitrary heights — snap their bottom margin up to the next
 *  26px rule so every block after them starts back on the line grid.
 *  Read/compute/write phases: all geometry is measured BEFORE any style
 *  write, and the cumulative shift each new margin adds is tracked in
 *  plain math — no layout is ever forced inside the loop. */
function snapCardsToGrid(kids: HTMLElement[]) {
  /* phase 1 — reads */
  interface Snap { k: HTMLElement; i: number; top: number; h: number; old: number; }
  const snaps: Snap[] = [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (
      !k.classList.contains("callout") ||
      k.classList.contains("floating") ||
      k.classList.contains("drag-gap")
    )
      continue;
    snaps.push({
      k, i, top: k.offsetTop, h: k.offsetHeight,
      old: parseFloat(k.style.marginBottom) || 0,
    });
  }
  /* phase 2 — compute: effective top = measured top + shift from margins
   * we already changed above this card */
  const writes: [HTMLElement, number][] = [];
  let shift = 0;
  for (const s of snaps) {
    const effTop = s.top + shift;
    const m = (effTop + s.h - 12) % 26;
    let mb = (26 - m) % 26;
    if (mb < 8) mb += 26; // keep a visible gap under the card
    // a heading's 26px margin-top collapses with ours — make ours win
    if (mb <= 26) {
      for (let j = s.i + 1; j < kids.length; j++) {
        const n = kids[j];
        if (n.classList.contains("floating") || n.classList.contains("drag-gap"))
          continue;
        if (/^H[123]$/.test(n.tagName)) mb += 26;
        break;
      }
    }
    if (mb !== s.old) { writes.push([s.k, mb]); shift += mb - s.old; }
  }
  /* phase 3 — writes */
  for (const [k, mb] of writes) k.style.marginBottom = `${mb}px`;
}

/** Indent in-flow blocks that share a floating card's vertical band, so the
 *  space beside a widget is real editable text instead of hidden under it.
 *  When cards crowd a line from both sides the text is dropped below the
 *  floats — squeezing it to a one-character column is never acceptable. */
const FLOW_MIN_TEXT = 110; // px of readable width a line must keep

function flowAroundCards() {
  const el = body();
  const kids = Array.from(el.children) as HTMLElement[];
  snapCardsToGrid(kids);
  const floatEls = kids.filter(
    (k) => k.classList.contains("floating") && !k.classList.contains("dragging"),
  );
  const textEls = kids.filter(
    (k) => FLOW_TAGS.has(k.tagName) && !k.classList.contains("drag-gap"),
  );
  /* phase 1 — one layout pass: every geometry read happens before any
   * style write. Floats never receive writes here, so their rects stay
   * valid for the whole pass. */
  const pageW = el.clientWidth;
  const floats = floatEls.map((f) => ({
    top: f.offsetTop, bottom: f.offsetTop + f.offsetHeight,
    left: f.offsetLeft, right: f.offsetLeft + f.offsetWidth,
  }));
  const texts = textEls.map((k) => ({
    k, top: k.offsetTop, h: k.offsetHeight,
    left: k.offsetLeft, w: k.offsetWidth,
    padL: parseFloat(k.style.paddingLeft) || 0,
    padR: parseFloat(k.style.paddingRight) || 0,
    drop: k.dataset.fdrop ? parseFloat(k.style.marginTop) || 0 : 0,
    wasDrop: !!k.dataset.fdrop,
  }));
  /* phase 2 — pure math: effective top = measured + cumulative shift
   * from drops already assigned above this block */
  interface W { k: HTMLElement; padL: number; padR: number; drop: number; wasDrop: boolean; }
  const writes: W[] = [];
  let shift = 0;
  for (const t of texts) {
    const kt = t.top + shift;
    const kb = kt + t.h;
    let padL = 0, padR = 0, drop = 0;
    if (floats.length) {
      let bandBot = -Infinity;
      let hasBand = false;
      for (const f of floats) {
        if (kb <= f.top || kt >= f.bottom) continue;
        hasBand = true;
        if (f.bottom > bandBot) bandBot = f.bottom;
        if ((f.left + f.right) / 2 < pageW / 2) {
          padL = Math.max(padL, f.right + 12 - t.left);
        } else {
          padR = Math.max(padR, t.left + t.w - (f.left - 12));
        }
      }
      if (hasBand) {
        padL = Math.max(0, padL);
        padR = Math.max(0, padR);
        if (t.w - padL - padR < FLOW_MIN_TEXT) {
          // no room beside the cards — drop below the lowest float,
          // snapped to the 26px rule grid
          padL = padR = 0;
          drop = Math.max(0, Math.ceil((bandBot - kt + 4) / 26) * 26);
        }
      }
    }
    if (padL !== t.padL || padR !== t.padR || drop !== t.drop || (t.wasDrop && !drop)) {
      writes.push({ k: t.k, padL, padR, drop, wasDrop: t.wasDrop });
    }
    shift += drop - t.drop;
  }
  /* phase 3 — writes, all after every read */
  for (const w of writes) {
    w.k.style.paddingLeft = w.padL ? `${Math.round(w.padL)}px` : "";
    w.k.style.paddingRight = w.padR ? `${Math.round(w.padR)}px` : "";
    if (w.drop) { w.k.style.marginTop = `${w.drop}px`; w.k.dataset.fdrop = "1"; }
    else if (w.wasDrop) { w.k.style.marginTop = ""; delete w.k.dataset.fdrop; }
  }
}

let flowQueued = false;
function scheduleFlow() {
  if (flowQueued) return;
  flowQueued = true;
  requestAnimationFrame(() => {
    flowQueued = false;
    flowAroundCards();
    scheduleCardLinks();
  });
}

function placeCaretAtEnd(node: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  body().focus();
}

/* ---------- click-and-type ---------- */

function lastTextNode(root: HTMLElement): Text | null {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  let last: Text | null = null;
  while ((n = w.nextNode())) last = n as Text;
  return last;
}


// click-and-type: a plain click to the right of a block's text end pads the
// line with non-breaking spaces so the caret sits where the user pointed —
// like Word's Click and Type. Drag-selections and mid-text clicks are native.
function clickAndType(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const block = target.closest?.("p,li,h1,h2,h3,blockquote") as HTMLElement | null;
  const root = body();
  if (!block || !root.contains(block) || target.closest(".callout")) return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  // only pad when the browser's caret landed at the very end of the block —
  // clicks inside text or beside wrapped lines must stay native
  const last = lastTextNode(block);
  const atEnd =
    block.textContent === ""
      ? range.startContainer === block || range.startContainer === last
      : range.startContainer === last &&
        range.startOffset === (last?.textContent?.length ?? 0);
  if (!atEnd) return;
  // a blank ruled line carries a zero-width space from serialization — clear
  // it so the caret (and anything typed here) starts the line cleanly
  if ((block.textContent ?? "").replace(/[\u200b\ufeff\u00a0\s]/g, "") === "") {
    block.textContent = "";
    const r0 = document.createRange();
    r0.selectNodeContents(block);
    r0.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r0);
  }
  const cur = window.getSelection()?.getRangeAt(0) ?? range;
  const rects = cur.getClientRects();
  // an empty block's caret is element-anchored and reports no rect — measure
  // from the block's content-left edge so blank lines can still be padded
  // out to the clicked x
  let caretX = rects[rects.length - 1]?.left;
  if (caretX == null) {
    const cs = getComputedStyle(block);
    caretX =
      block.getBoundingClientRect().left +
      (parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)) * Z();
  }
  if (e.clientX <= caretX + 4) return;
  const dx = (e.clientX - caretX) / Z();
  const n = Math.max(1, Math.round(dx / nbspWidth(block)));
  const pad = document.createTextNode("\u00a0".repeat(n));
  cur.insertNode(pad);
  const r2 = document.createRange();
  r2.setStartAfter(pad);
  r2.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r2);
  markEdited();
}

/* ---------- pencil ---------- */

/* ---------- command-line loader: the red pencil looping and writing while
   a command runs (Red Pencil: Loop and Write) ---------------------------- */

let plSeq = 0;

type PlSeg = {
  k: "circle" | "write" | "travel";
  d: number;
  fn?: (u: number) => [number, number];
  sc?: [number, number, number];
  lean?: number;
};

/** the pencil svg — the sheen gradient id is suffixed per instance so
 *  several loaders on one page never share it */
const LOOP_SVG = (uid: number) => `<svg viewBox="0 0 400 400" aria-hidden="true">
  <defs>
    <linearGradient id="pl-sheen-${uid}" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
  </defs>
  <circle class="pl-ring" cx="200" cy="255" r="70" fill="none" stroke-width="2" stroke-dasharray="2 6" stroke-linecap="round"/>
  <path class="pl-trail" stroke-width="3"/>
  <path class="pl-ink" stroke-width="3.2"/>
  <g class="pl-pencil">
    <rect x="-9" y="-152" width="18" height="20" rx="6" fill="hsl(350,85%,82%)"/>
    <rect x="-9" y="-138" width="18" height="18" fill="hsl(220,8%,86%)"/>
    <rect x="-9" y="-138" width="18" height="18" fill="url(#pl-sheen-${uid})"/>
    <rect x="-9" y="-133" width="18" height="1.5" fill="rgba(0,0,0,.22)"/>
    <rect x="-9" y="-126" width="18" height="1.5" fill="rgba(0,0,0,.22)"/>
    <rect x="-9" y="-120" width="18" height="90" fill="hsl(352,88%,45%)"/>
    <rect x="-9" y="-120" width="6" height="90" fill="hsl(352,85%,30%)"/>
    <rect x="3" y="-120" width="4" height="90" fill="hsl(352,90%,62%)"/>
    <rect class="pl-spin" x="0" y="-120" width="2" height="90" fill="#fff" opacity=".28"/>
    <polygon points="0,0 -9,-30 9,-30" fill="hsl(34,85%,76%)"/>
    <polygon points="0,0 -9,-30 -3,-30" fill="hsl(30,80%,58%)"/>
    <polygon points="0,0 -3.4,-11 3.4,-11" fill="hsl(352,60%,12%)"/>
  </g>
</svg>`;

/** the loop-and-write engine — a 3d-tilted pencil draws a circle, travels,
 *  writes cursive loops, and repeats; returns a stop function */
function startPencilScene(stage: HTMLElement): () => void {
  const pencil = stage.querySelector<SVGGElement>(".pl-pencil");
  const spin = stage.querySelector<SVGRectElement>(".pl-spin");
  const inkEl = stage.querySelector<SVGPathElement>(".pl-ink");
  const trailEl = stage.querySelector<SVGPathElement>(".pl-trail");
  const ring = stage.querySelector<SVGCircleElement>(".pl-ring");
  if (!pencil || !spin || !inkEl || !trailEl || !ring) return () => {};
  const slow = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1;
  const PI2 = Math.PI * 2;
  const circle = (u: number): [number, number] => {
    const a = (-113 * Math.PI) / 180 + PI2 * 2 * u;
    return [200 + 70 * Math.cos(a), 255 + 70 * Math.sin(a)];
  };
  // cursive loops along a line from S to E
  const line = (S: [number, number], E: [number, number], n: number, r: number) => {
    const dx = E[0] - S[0];
    const dy = E[1] - S[1];
    const L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    return (u: number): [number, number] => {
      const th = PI2 * n * u;
      const al = L * u - r * Math.sin(th);
      const pe = r * (Math.cos(th) - 1);
      return [S[0] + ux * al + nx * pe, S[1] + uy * al + ny * pe];
    };
  };
  const segs: PlSeg[] = [
    { k: "circle", d: 3.2, fn: circle, sc: [24, -14, 0], lean: 28 },
    { k: "travel", d: 0.9 },
    { k: "write", d: 3.8, fn: line([90, 335], [310, 205], 5, 14), sc: [56, 6, -28], lean: 40 },
    { k: "travel", d: 0.9 },
    { k: "circle", d: 2.8, fn: circle, sc: [24, -14, 0], lean: 28 },
    { k: "travel", d: 0.9 },
    { k: "write", d: 3.8, fn: line([205, 180], [205, 350], 5, 14), sc: [16, 48, 8], lean: 20 },
    { k: "travel", d: 0.9 },
  ];
  const total = segs.reduce((s, g) => s + g.d, 0);
  const cur: [number, number, number] = [24, -14, 0];
  let lean = 28;
  let idx = -1;
  let pts: Array<[number, number]> = [];
  let trail: Array<[number, number, number]> = [];
  let inkFade = 1;
  let last = 0;
  let T = 0;
  let raf = 0;
  const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const pathOf = (a: Array<[number, number, number?]>) => {
    if (!a.length) return "";
    let d = `M${a[0][0].toFixed(1)} ${a[0][1].toFixed(1)}`;
    for (let i = 1; i < a.length; i++) d += `L${a[i][0].toFixed(1)} ${a[i][1].toFixed(1)}`;
    return d;
  };
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    T = (T + dt * slow) % total;
    let acc = 0;
    let i = 0;
    while (i < segs.length - 1 && T >= acc + segs[i].d) {
      acc += segs[i].d;
      i++;
    }
    const s = segs[i];
    const u = (T - acc) / s.d;
    const nextSolid = segs[(i + 1) % segs.length];
    const prev = segs[(i + segs.length - 1) % segs.length];
    if (i !== idx) {
      idx = i;
      if (s.k === "write") {
        pts = [];
        inkFade = 1;
      }
      if (s.k === "circle") trail = [];
    }
    let p: [number, number];
    let lift = 0;
    let target: [number, number, number];
    let tl: number;
    if (s.k === "travel") {
      // a travel segment always sits between two solid ones
      const A = prev.fn!(1);
      const B = nextSolid.fn!(0);
      const e = ease(u);
      p = [A[0] + (B[0] - A[0]) * e, A[1] + (B[1] - A[1]) * e];
      lift = Math.sin(Math.PI * u);
      target = nextSolid.sc!;
      tl = nextSolid.lean!;
      if (prev.k === "write") inkFade = 1 - e;
    } else {
      p = s.fn!(u);
      target = s.sc!;
      tl = s.lean!;
      if (s.k === "write") pts.push(p);
      else trail.push([p[0], p[1], T]);
    }
    const k = 1 - Math.exp(-dt * 4.5);
    for (let j = 0; j < 3; j++) cur[j] += (target[j] - cur[j]) * k;
    lean += (tl - lean) * k;
    stage.style.transform = `rotateX(${cur[0].toFixed(2)}deg) rotateY(${cur[1].toFixed(2)}deg) rotateZ(${cur[2].toFixed(2)}deg)`;
    const wob = s.k === "write" ? 2.2 * Math.sin(now / 70) : 0;
    pencil.setAttribute(
      "transform",
      `translate(${p[0].toFixed(1)} ${(p[1] - lift * 34).toFixed(1)}) rotate(${(lean + wob + lift * -8).toFixed(1)}) scale(${(1 + lift * 0.08).toFixed(3)})`,
    );
    spin.setAttribute("x", (5 * Math.cos(now / 260)).toFixed(2));
    // circle trail: keep only the last ~1.1 s of motion
    const keep = 1.1;
    trail = trail.filter((q) => {
      const age = (T - q[2] + total) % total;
      return age < keep;
    });
    trailEl.setAttribute("d", s.k === "write" ? "" : pathOf(trail));
    trailEl.style.opacity = s.k === "circle" ? "1" : String(Math.max(0, 1 - u * 1.6));
    inkEl.setAttribute("d", pathOf(pts));
    inkEl.style.opacity = s.k === "travel" && prev.k !== "write" ? "0" : String(inkFade);
    ring.style.opacity =
      s.k === "write"
        ? "0"
        : s.k === "travel"
          ? nextSolid.k === "circle"
            ? String(u)
            : String(1 - u)
          : "1";
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

function startCmdLoader(block: HTMLElement) {
  stopCmdLoader(block);
  const inCard = !!block.closest(".callout");
  const stage = document.createElement("span");
  stage.className = "cmd-loader";
  stage.contentEditable = "false";
  const scene = document.createElement("div");
  scene.className = "pl-scene";
  const inner = document.createElement("div");
  inner.className = "pl-stage";
  inner.innerHTML = LOOP_SVG(++plSeq);
  scene.append(inner);
  stage.append(scene);
  (stage as unknown as { _stop: () => void })._stop = startPencilScene(inner);
  if (inCard) {
    // a card anchor would go blank if we hid its text — the pencil just overlays it
    block.append(stage);
    return;
  }
  // on paper lines the loader replaces only the leading @token —
  // the file name and the question stay visible while it runs
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const t = w.nextNode() as Text | null;
  const m = t ? (t.textContent ?? "").match(/^(\s*)(@\S+)/) : null;
  if (t && m) {
    const lead = m[1].length;
    const tok = m[2];
    const span = document.createElement("span");
    span.className = "cmd-token";
    span.textContent = tok;
    span.contentEditable = "false";
    const rest = (t.textContent ?? "").slice(lead + tok.length);
    const frag = document.createDocumentFragment();
    if (lead) frag.append(document.createTextNode((t.textContent ?? "").slice(0, lead)));
    frag.append(span);
    if (rest) frag.append(document.createTextNode(rest));
    t.replaceWith(frag);
    span.append(stage);
    return;
  }
  block.classList.add("cmd-run");
  block.append(stage);
}

function stopCmdLoader(root?: HTMLElement | Document) {
  (root ?? document).querySelectorAll(".cmd-loader").forEach((el) => {
    (el as unknown as { _stop?: () => void })._stop?.();
    el.parentElement?.classList.remove("cmd-run");
    el.remove();
  });
  (root ?? document).querySelectorAll(".cmd-token").forEach((s) => {
    s.replaceWith(document.createTextNode(s.textContent ?? ""));
  });
}

export function showPencil(block: HTMLElement) {
  hidePencil();
  startCmdLoader(block);
  // track the block immediately — the loader must be stoppable even when no
  // command token is found to wrap (every @command, including the new ones)
  pencilBlock = block;
  pencilTimer = window.setTimeout(() => hidePencil(), 240000);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  let token = "@research";
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const m = (t.textContent ?? "").match(
      /@(research|skill|document|ask|schedule|recall|tasks|related|loop|summary)\b/,
    );
    if (m) {
      node = t;
      token = m[0];
      break;
    }
  }
  if (!node || !node.textContent) return;
  const idx = node.textContent.indexOf(token);
  const before = node.textContent.slice(0, idx);
  const after = node.textContent.slice(idx + token.length);
  const cmd = document.createElement("span");
  cmd.className = "cmd-word";
  cmd.textContent = token;
  cmd.contentEditable = "false";
  const p = document.createElement("span");
  p.className = "pencil";
  p.contentEditable = "false";
  p.innerHTML =
    '<span class="p-body"></span><span class="p-tip"></span><span class="p-lead"></span>';
  const frag = document.createDocumentFragment();
  if (before) frag.append(document.createTextNode(before));
  frag.append(p, cmd);
  if (after) frag.append(document.createTextNode(after));
  node.replaceWith(frag);
}

/** pin the working-pencil to any block — no command token needed
 *  (used by selection-popup asks; hidePencil() cleans it up) */
export function showPencilAt(block: HTMLElement) {
  hidePencil();
  startCmdLoader(block);
  const p = document.createElement("span");
  p.className = "pencil";
  p.contentEditable = "false";
  p.innerHTML =
    '<span class="p-body"></span><span class="p-tip"></span><span class="p-lead"></span>';
  block.append(p);
  pencilBlock = block;
  pencilTimer = window.setTimeout(() => hidePencil(), 240000);
}

export function hidePencil() {
  clearTimeout(pencilTimer);
  // document-wide sweep — the pencil must exit the moment any card lands,
  // even if the tracked block moved, was stripped, or a background job
  // (scheduled brief, loop) finished out of band
  stopCmdLoader();
  const block = pencilBlock;
  pencilBlock = null;
  if (!block) return;
  const cmd = block.querySelector(".cmd-word");
  const word = cmd?.textContent ?? "@research";
  block.querySelector(".pencil")?.remove();
  if (cmd) cmd.replaceWith(document.createTextNode(word));
  block.normalize();
}

/* ---------- card state ---------- */

const stateKey = (card: HTMLElement) =>
  `laido.card.${current}::${card.dataset.topic ?? "?"}::${card.dataset.slot ?? "0"}`;

function readState(card: HTMLElement): Record<string, number> {
  try {
    let raw = localStorage.getItem(stateKey(card));
    if (!raw && (card.dataset.slot ?? "0") === "0") {
      raw = localStorage.getItem(`laido.card.${current}::${card.dataset.topic ?? "?"}`);
    }
    if (!raw) {
      // legacy keys: rag cards saved before the topic prefix cleanup
      const legacy = `[!ai] rag: ${card.dataset.topic ?? "?"}`;
      raw =
        localStorage.getItem(`laido.card.${current}::${legacy}::${card.dataset.slot ?? "0"}`) ??
        ((card.dataset.slot ?? "0") === "0"
          ? localStorage.getItem(`laido.card.${current}::${legacy}`)
          : null);
    }
    return JSON.parse(raw ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function writeState(card: HTMLElement, patch: Record<string, number>) {
  const merged = { ...readState(card), ...patch };
  localStorage.setItem(stateKey(card), JSON.stringify(merged));
}

/** pop a card out of the text flow at a client point — the same math the
 *  titlebar-drag drop uses, so sheet tabs and other callers float cards
 *  exactly like a hand-dragged drop. Position persists via writeState. */
export function popCardFloating(card: HTMLElement, clientX: number, clientY: number) {
  const editor = body();
  const er = editor.getBoundingClientRect();
  const x = Math.round(Math.max(0, clientX - er.left + editor.scrollLeft - 40));
  const y = Math.round(Math.max(0, clientY - er.top + editor.scrollTop - 20));
  if (!card.classList.contains("sized")) {
    card.classList.add("sized");
    const r = card.getBoundingClientRect();
    writeState(card, { w: Math.round(r.width), h: Math.round(r.height) });
    card.style.width = `${Math.round(r.width)}px`;
    card.style.height = `${Math.round(r.height)}px`;
  }
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, z: genZ });
  scheduleFlow();
  scheduleCardLinks();
  markEdited();
}

function saveCardBox(card: HTMLElement) {
  const cs = getComputedStyle(card);
  writeState(card, {
    w: Math.round(parseFloat(cs.width)),
    h: Math.round(parseFloat(cs.height)),
    ml: Math.round(parseFloat(cs.marginLeft) || 0),
    mt: Math.round(parseFloat(cs.marginTop) || 0),
  });
}

function restoreCardState(card: HTMLElement) {
  const s = readState(card);
  /* geometry saved on a bigger screen (or before a sidebar/zoom change)
   * must never bury the current paper — clamp w/h to the editor and
   * x/y so at least an edge of the card stays reachable */
  const editor = body();
  const w = s.w ? Math.min(s.w, Math.max(280, editor.clientWidth - 24)) : 0;
  /* a floating card taller than the visible paper can't ever be seen in
   * full — its own body scrolls, so anything beyond the viewport is dead
   * weight that just buries the text under it */
  const h = s.h ? Math.min(s.h, Math.max(200, editor.clientHeight - 40)) : 0;
  if (w && h) {
    card.style.width = `${w}px`;
    card.style.height = `${h}px`;
    card.style.marginLeft = `${s.ml ?? 0}px`;
    card.style.marginTop = `${s.mt ?? 0}px`;
    card.classList.add("sized");
    if (w !== s.w || h !== s.h) writeState(card, { w, h });
  }
  if (s.x !== undefined && s.y !== undefined) {
    const cw = w || card.getBoundingClientRect().width || 300;
    const ch = h || card.getBoundingClientRect().height || 200;
    const x = Math.min(Math.max(s.x, 40 - cw), Math.max(40, editor.scrollWidth - 48));
    const y = Math.min(Math.max(s.y, 40 - ch), Math.max(40, editor.scrollHeight - 48));
    card.classList.add("floating");
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.marginTop = "0px";
    card.style.marginLeft = "0px";
    if (x !== s.x || y !== s.y) writeState(card, { x, y });
  }
  // a generated card keeps its stacking slot across reloads — newest on top
  // until an even newer card is generated
  if (s.z) {
    card.style.zIndex = String(s.z);
    genZ = Math.max(genZ, s.z);
  }
  if (s.pinned) {
    card.classList.add("pinned");
    card.style.zIndex = pinnedZ();
    card.style.overflow = "visible";
    pinMark(card);
    applyPinColor(card, PIN_COLORS[s.pinc ?? 0] ?? "red");
  }
  // a floating-pinned chat comes back floating-pinned (clamped to the screen)
  if (s.fixed) {
    card.classList.add("viewport-pin");
    card.style.left = `${Math.max(0, Math.min(s.x, window.innerWidth - 80))}px`;
    card.style.top = `${Math.max(0, Math.min(s.y, window.innerHeight - 40))}px`;
  }
}

function resolvePinnedOverlaps() {
  const pinned = Array.from(body().querySelectorAll(".callout.pinned")) as HTMLElement[];
  const editor = body();
  const er = editor.getBoundingClientRect();
  for (let i = 0; i < pinned.length; i++) {
    for (let j = i + 1; j < pinned.length; j++) {
      const a = pinned[i].getBoundingClientRect();
      const b = pinned[j].getBoundingClientRect();
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 40 && overlapY > 40) {
        const x = Math.round(Math.max(0, b.left - er.left + editor.scrollLeft));
        const y = Math.round(Math.max(0, b.top - er.top + editor.scrollTop + overlapY + 12));
        pinned[j].style.top = `${y}px`;
        writeState(pinned[j], { x, y });
        addActivity("📌 moved a pinned card that was covered");
      }
    }
  }
}

const PIN_COLORS = ["red", "blue", "green", "yellow", "purple", "pink"];
const PIN_LAST = "laido.pin.last";

/* random pin color, never the same as the previous one used */
function pickPinColor(): number {
  const last = Number(localStorage.getItem(PIN_LAST) ?? "-1");
  let idx = Math.floor(Math.random() * PIN_COLORS.length);
  if (PIN_COLORS.length > 1) {
    while (idx === last) idx = Math.floor(Math.random() * PIN_COLORS.length);
  }
  localStorage.setItem(PIN_LAST, String(idx));
  return idx;
}

function applyPinColor(card: HTMLElement, color: string) {
  const m = card.querySelector(".pin-mark");
  if (!m) return;
  for (const c of PIN_COLORS) m.classList.remove(`pin-${c}`);
  m.classList.add(`pin-${color}`);
  card.dataset.pinColor = color;
}

function openPinMenu(card: HTMLElement, mark: HTMLElement) {
  document.querySelector(".pin-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "pin-menu";
  const row = document.createElement("div");
  row.className = "pin-swatches";
  const current = card.dataset.pinColor ?? "red";
  for (const c of PIN_COLORS) {
    const sw = document.createElement("button");
    sw.className = `pin-sw pin-${c}` + (c === current ? " active" : "");
    sw.title = c;
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      applyPinColor(card, c);
      writeState(card, { pinc: PIN_COLORS.indexOf(c) });
      localStorage.setItem(PIN_LAST, String(PIN_COLORS.indexOf(c)));
      addActivity(`📌 pin color → ${c}`);
      menu.remove();
    });
    row.append(sw);
  }
  menu.append(row);
  const remove = document.createElement("button");
  remove.className = "pin-remove";
  remove.textContent = t("pin.remove");
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.remove();
    togglePin(card);
  });
  menu.append(remove);
  document.body.append(menu);
  const r = mark.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left - 62, window.innerWidth - 200))}px`;
  menu.style.top = `${r.bottom + 10}px`;
  const close = (ev: MouseEvent) => {
    if (!(ev.target as HTMLElement).closest(".pin-menu, .pin-mark")) {
      menu.remove();
      document.removeEventListener("click", close, true);
    }
  };
  window.setTimeout(() => document.addEventListener("click", close, true), 0);
}

function pinMark(card: HTMLElement) {
  if (card.querySelector(".pin-mark")) return;
  const m = document.createElement("button");
  m.className = "pin-mark";
  m.title = t("pin.options");
  m.contentEditable = "false";
  const wrap = document.createElement("span");
  wrap.className = "pushpin";
  const gid = `pg${Math.random().toString(36).slice(2, 9)}`;
  const bell = "M -50 -88 C -58 -45 -150 -22 -145 50 C -141 100 -80 116 0 116 C 80 116 141 100 145 50 C 150 -22 58 -45 50 -88 Z";
  const neck = "M -40 -160 L 40 -160 L 58 -68 C 40 -50 -40 -50 -58 -68 Z";
  wrap.innerHTML = `<svg class="pushpin-svg" viewBox="-197 -279 451 485" aria-hidden="true">
    <defs>
      <linearGradient id="nd-${gid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style="stop-color:#5a5f66"/>
        <stop offset=".45" style="stop-color:#e8eaee"/>
        <stop offset="1" style="stop-color:#6e747c"/>
      </linearGradient>
      <radialGradient id="dk-${gid}">
        <stop offset="0" style="stop-color:rgba(15,10,8,.5)"/>
        <stop offset=".6" style="stop-color:rgba(15,10,8,.22)"/>
        <stop offset="1" style="stop-color:rgba(15,10,8,0)"/>
      </radialGradient>
      <linearGradient id="bs-${gid}" x1="0" y1="0" x2="1" y2="0.35">
        <stop offset="0" style="stop-color:var(--pp-l)"/>
        <stop offset=".35" style="stop-color:var(--pp-m)"/>
        <stop offset=".75" style="stop-color:var(--pp-d)"/>
        <stop offset="1" style="stop-color:var(--pp-dd)"/>
      </linearGradient>
      <radialGradient id="bg-${gid}" cx=".3" cy=".25" r=".6">
        <stop offset="0" style="stop-color:var(--pp-hi)" stop-opacity=".75"/>
        <stop offset="1" style="stop-color:var(--pp-hi)" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="bb-${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--pp-dd)" stop-opacity="0"/>
        <stop offset="1" style="stop-color:var(--pp-dd)" stop-opacity=".55"/>
      </linearGradient>
      <linearGradient id="nk-${gid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style="stop-color:var(--pp-m)"/>
        <stop offset=".4" style="stop-color:var(--pp-d)"/>
        <stop offset="1" style="stop-color:var(--pp-dd)"/>
      </linearGradient>
      <linearGradient id="ns-${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--pp-dd)" stop-opacity=".45"/>
        <stop offset=".35" style="stop-color:var(--pp-dd)" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="ct-${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style="stop-color:var(--pp-l)"/>
        <stop offset=".55" style="stop-color:var(--pp-m)"/>
        <stop offset="1" style="stop-color:var(--pp-d)"/>
      </linearGradient>
      <linearGradient id="ce-${gid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" style="stop-color:var(--pp-m)"/>
        <stop offset=".5" style="stop-color:var(--pp-d)"/>
        <stop offset="1" style="stop-color:var(--pp-dd)"/>
      </linearGradient>
      <filter id="sh-${gid}" x="-30%" y="-30%" width="170%" height="170%">
        <feDropShadow dx="-8" dy="22" stdDeviation="16" flood-color="#23232e" flood-opacity=".22"/>
      </filter>
      <filter id="sf-${gid}"><feGaussianBlur stdDeviation="4"/></filter>
    </defs>
    <ellipse cx="-30" cy="95" rx="135" ry="85" fill="url(#dk-${gid})"/>
    <ellipse cx="-88" cy="141" rx="30" ry="8" fill="rgba(12,6,4,.55)" filter="url(#sf-${gid})"/>
    <g filter="url(#sh-${gid})">
      <g transform="rotate(33)">
        <path d="M -10 85 L 10 85 L 4.5 148 L 0 162 L -4 148 Z" fill="url(#nd-${gid})" style="stroke:#3f444b" stroke-width="3" opacity=".55"/>
        <path d="M -10 85 L 10 85 L 4.5 148 L 0 162 L -4 148 Z" fill="url(#nd-${gid})"/>
        <path d="${bell}" fill="url(#bs-${gid})"/>
        <path d="${bell}" fill="url(#bg-${gid})"/>
        <path d="${bell}" fill="url(#bb-${gid})"/>
        <path d="M -128 20 C -132 60 -100 98 -50 106" fill="none" style="stroke:var(--pp-rim)" stroke-width="6" stroke-linecap="round" opacity=".35" filter="url(#sf-${gid})"/>
        <path d="${neck}" fill="url(#nk-${gid})"/>
        <path d="${neck}" fill="url(#ns-${gid})"/>
        <path d="M -58 -68 C -40 -50 40 -50 58 -68" fill="none" style="stroke:var(--pp-line)" stroke-width="3" opacity=".35"/>
        <rect x="-102" y="-197" width="204" height="18" fill="url(#ce-${gid})"/>
        <ellipse cx="0" cy="-179" rx="102" ry="38" fill="url(#ce-${gid})"/>
        <ellipse cx="0" cy="-197" rx="102" ry="38" fill="url(#ct-${gid})"/>
        <ellipse cx="-18" cy="-206" rx="70" ry="20" fill="#ffffff" opacity=".12"/>
      </g>
    </g>
  </svg>`;
  m.append(wrap);
  m.addEventListener("pointerdown", (e) => e.stopPropagation());
  m.addEventListener("click", (e) => {
    e.stopPropagation();
    openPinMenu(card, m);
  });
  card.append(m);
}

function togglePin(card: HTMLElement) {
  const pinned = !card.classList.contains("pinned");
  if (pinned) {
    const editor = body();
    const er = editor.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const x = Math.round(Math.max(0, (cr.left - er.left) / Z() + editor.scrollLeft));
    const y = Math.round(Math.max(0, (cr.top - er.top) / Z() + editor.scrollTop));
    card.classList.add("floating", "pinned");
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.margin = "0";
    card.style.zIndex = pinnedZ();
    card.style.overflow = "visible";
    writeState(card, { x, y, pinned: 1 });
    pinMark(card);
    const pinc = pickPinColor();
    applyPinColor(card, PIN_COLORS[pinc]);
    writeState(card, { pinc });
    addActivity("📌 pinned in place — click the pin on top to release");
    scheduleFlow();
  } else {
    card.classList.remove("pinned");
    const z = readState(card).z;
    card.style.zIndex = z ? String(z) : "";
    card.style.overflow = "";
    card.querySelector(".pin-mark")?.remove();
    writeState(card, { pinned: 0 });
    addActivity("pin removed — the card can move again");
    scheduleFlow();
  }
  markEdited();
}

/* ---------- card interactions ---------- */

function makeResizable(card: HTMLElement) {
  const dirs: Array<[string, number, number]> = [
    ["n", 0, -1],
    ["s", 0, 1],
    ["w", -1, 0],
    ["e", 1, 0],
    ["nw", -1, -1],
    ["ne", 1, -1],
    ["sw", -1, 1],
    ["se", 1, 1],
  ];
  for (const [dir, dx, dy] of dirs) {
    const g = document.createElement("div");
    g.className = `grip grip-${dir}`;
    g.contentEditable = "false";
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.style.transform = "none";
      card.classList.add("gripping"); // browser cards freeze their engine sync while this is live
      g.setPointerCapture(e.pointerId);
      const r = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      const start = {
        x: e.clientX,
        y: e.clientY,
        w: r.width / Z(),
        h: r.height / Z(),
        ml: parseFloat(cs.marginLeft) || 0,
        mt: parseFloat(cs.marginTop) || 0,
      };
      const move = (ev: PointerEvent) => {
        if (dx !== 0) {
          const w = Math.max(240, start.w + ((ev.clientX - start.x) * dx) / Z());
          card.style.width = `${w}px`;
          if (dx < 0) card.style.marginLeft = `${start.ml - (w - start.w)}px`;
        }
        if (dy !== 0) {
          const h = Math.max(110, start.h + ((ev.clientY - start.y) * dy) / Z());
          card.style.height = `${h}px`;
          if (dy < 0) card.style.marginTop = `${start.mt - (h - start.h)}px`;
        }
        card.classList.add("sized");
        scheduleCardLinks();
      };
      const up = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        g.removeEventListener("pointercancel", up);
        card.classList.remove("gripping");
        saveCardBox(card);
        scheduleFlow();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
      g.addEventListener("pointercancel", up);
    });
    card.append(g);
  }
}

function makeDraggable(card: HTMLElement) {
  let hold: number | undefined;
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let fx = 0;
  let fy = 0;
  let gap: HTMLElement | null = null;

  const isSticky = () => card.classList.contains("sticky");

  const onMove = (e: PointerEvent) => {
    if (!dragging) {
      if (hold !== undefined && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) {
        clearTimeout(hold);
        hold = undefined;
        card.classList.remove("holding");
      }
      return;
    }
    const w = parseFloat(card.style.width) || 240;
    const h = parseFloat(card.style.height) || 150;
    const nx = Math.max(-(w - 60), fx + (e.clientX - sx) / Z());
    const ny = Math.max(-(h - 60), fy + (e.clientY - sy) / Z());
    card.style.left = `${nx}px`;
    card.style.top = `${ny}px`;
    scheduleCardLinks();
    if (isSticky()) {
      const outside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      if (outside && !card.classList.contains("leaving")) {
        card.classList.add("leaving");
        addActivity("release outside to float this sticky on your desktop");
      } else if (!outside) {
        card.classList.remove("leaving");
      }
    }
  };

  const onUp = (e: PointerEvent) => {
    if (hold !== undefined) {
      clearTimeout(hold);
      hold = undefined;
    }
    card.classList.remove("holding");
    if (!dragging) return;
    dragging = false;
    card.classList.remove("dragging");
    card.classList.remove("leaving");
    card.dataset.justdragged = "1";
    window.setTimeout(() => delete card.dataset.justdragged, 120);

    const outside =
      e.type === "pointerup" &&
      (e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight);
    if (outside && isSticky()) {
      popOutSticky(card, e.clientX, e.clientY);
    }

    gap?.remove();
    gap = null;
    // a viewport-pinned card stays fixed after the drag — clamp to the
    // screen, never reflow back onto the sheet
    if (card.classList.contains("viewport-pin")) {
      const x = Math.round(
        Math.max(0, Math.min(parseFloat(card.style.left) || 0, window.innerWidth - 80)),
      );
      const y = Math.round(
        Math.max(0, Math.min(parseFloat(card.style.top) || 0, window.innerHeight - 40)),
      );
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      writeState(card, { fixed: 1, x, y, pinned: 0 });
      return;
    }
    const editor = body();
    let x = parseFloat(card.style.left) || 0;
    let y = parseFloat(card.style.top) || 0;
    x = Math.round(Math.max(0, Math.min(x, Math.max(0, editor.scrollWidth - 60))));
    y = Math.round(Math.max(0, y));

    card.style.position = "";
    // the drag raised the card to 999 — put it back in its own stacking slot
    // instead of dropping it to the .floating default below every newer card
    const z = readState(card).z;
    card.style.zIndex = z ? String(z) : "";
    if (!card.classList.contains("sized")) {
      card.style.width = "";
      card.style.height = "";
    }
    card.classList.add("floating");
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    writeState(card, { x, y });
    scheduleFlow();
    scheduleCardLinks();
  };

  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", onUp);

  card.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (card.classList.contains("pinned")) return;
    if (t.closest(".grip, .card-del, .card-menu, .card-move, .card-pin, .card-stick, .pin-mark")) return;
    // editable text is for selecting, not dragging — the hold timer would
    // otherwise fire mid-selection and wipe it
    if (t.closest(".callout-body, .callout-src, .sticky-title")) return;
    // controls never start a drag — setPointerCapture would swallow their
    // click. Head-mounted widget tools (canvas/base/graph toolbars, map
    // add, agenda buttons, the chat model select) live here
    if (t.closest("button, input, select, textarea, a")) return;
    const immediate = !isSticky() && !!t.closest(".callout-head");
    // outside the head, non-editable widget surfaces (map canvas, browser
    // chrome, sheet/deck/todo/chart bodies, the terminal log) belong to
    // the widget — a long gesture there is widget work, not a card drag
    if (!immediate && t.closest('[contenteditable="false"]')) return;
    sx = e.clientX;
    sy = e.clientY;
    const startDrag = () => {
      hold = undefined;
      card.classList.remove("holding");
      dragging = true;
      const r = card.getBoundingClientRect();
      const editor = body();
      const er = editor.getBoundingClientRect();
      if (card.classList.contains("viewport-pin")) {
        // a viewport-fixed card's left/top live in screen units (zoom-divided)
        fx = r.left / Z();
        fy = r.top / Z();
      } else {
        fx = (r.left - er.left) / Z() + editor.scrollLeft;
        fy = (r.top - er.top) / Z() + editor.scrollTop;
      }
      if (!card.classList.contains("floating") && !gap) {
        gap = document.createElement("div");
        gap.className = "drag-gap";
        gap.contentEditable = "false";
        const cs = getComputedStyle(card);
        gap.style.height = `${r.height / Z()}px`;
        gap.style.marginTop = cs.marginTop;
        gap.style.marginBottom = cs.marginBottom;
        card.before(gap);
      }
      card.classList.add("floating", "dragging");
      card.style.transform = "none";
      card.style.margin = "0";
      card.style.position = "absolute";
      card.style.zIndex = "999";
      card.style.width = `${r.width / Z()}px`;
      card.style.height = `${r.height / Z()}px`;
      card.style.left = `${fx}px`;
      card.style.top = `${fy}px`;
      // never wipe the user's text selection — only a click outside the
      // widget may dismiss it
      card.setPointerCapture(e.pointerId);
    };
    if (immediate) startDrag();
    else {
      hold = window.setTimeout(startDrag, 260);
      window.setTimeout(() => {
        if (hold !== undefined) card.classList.add("holding");
      }, 130);
    }
  });
}

/** Convert an AI/research card into a sticky note: same body, sticky chrome,
 *  so it can live in the sheet or be dragged out to its own window. */
function stickifyCard(card: HTMLElement) {
  const title = (card.dataset.title ?? card.querySelector(".callout-title")?.textContent ?? "").trim();
  card.dataset.kind = "sticky";
  card.dataset.topic = `s${Math.random().toString(36).slice(2, 8)}`;
  card.dataset.color = card.dataset.color || "yellow";
  card.dataset.title = title;
  const head = card.querySelector<HTMLElement>(".callout-title");
  if (head) head.className = "sticky-title";
  card.classList.add("sticky");
  card.classList.remove("pinned");
  // a converted card keeps the AI card's fixed height → dead space at the
  // bottom of the sticky; drop it so the sticky hugs its content again
  card.style.height = "";
  card.classList.remove("sized");
  // drop AI-card chrome and re-enhance so sticky controls are added
  card.querySelectorAll(".card-tools, .card-del, .card-pin, .card-stick").forEach((b) => b.remove());
  delete card.dataset.enhanced;
  enhanceCard(card);
  markEdited();
  flowAroundCards();
  addActivity(`“${title || "note"}” is now a sticky — drag it out to your desktop anytime`);
}

/** ♪ — read the card aloud with the OS voices; click again to stop */
function toggleCardSpeech(card: HTMLElement, btn: HTMLElement) {
  if (btn.classList.contains("speaking")) {
    window.speechSynthesis.cancel();
    btn.classList.remove("speaking");
    return;
  }
  window.speechSynthesis.cancel();
  document.querySelectorAll(".card-tts.speaking").forEach((b) => b.classList.remove("speaking"));
  // a live selection inside the card wins — speak just the highlighted
  // range (macOS-style speak-selection), else the whole card
  const sel = window.getSelection();
  const selText =
    sel && !sel.isCollapsed && card.contains(sel.anchorNode) && card.contains(sel.focusNode)
      ? sel.toString().replace(/\s+/g, " ").trim()
      : "";
  const title = (card.dataset.title ?? card.querySelector(".callout-title")?.textContent ?? "").trim();
  const bodyEl = card.querySelector<HTMLElement>(".callout-body");
  const text =
    selText || [title, bodyEl?.innerText ?? ""].join(". ").replace(/\s+/g, " ").trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  u.onend = () => btn.classList.remove("speaking");
  u.onerror = () => btn.classList.remove("speaking");
  btn.classList.add("speaking");
  window.speechSynthesis.speak(u);
}

export function enhanceCard(card: HTMLElement) {
  normalizeCard(card);
  /* the note that owns this card — browser engines parked on a switch
   * report back to this tab (🔊 indicator) long after the DOM is gone */
  card.dataset.note = current;
  if (!card.dataset.cid) card.dataset.cid = `c${Math.random().toString(36).slice(2, 9)}`;
  card.contentEditable = "true";
  const head = card.querySelector<HTMLElement>(".callout-head");
  const src = card.querySelector<HTMLElement>(".callout-src");
  if (src) src.contentEditable = "false";
  if (card.classList.contains("sticky")) {
    if (head) {
      head.contentEditable = "true";
      head.title = "Optional title";
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          head.blur();
        }
      });
    }
  } else if (head) {
    head.contentEditable = "false";
  }
  if (card.dataset.enhanced) return;
  card.dataset.enhanced = "1";
  const topic = card.dataset.topic ?? "?";
  const sameTopic = Array.from(body().querySelectorAll(".callout")).filter(
    (c) => (c as HTMLElement).dataset.topic === topic,
  );
  card.dataset.slot = String(sameTopic.indexOf(card));
  // card chrome mounts into one tool strip inside the head — a flex row at
  // the right edge, so card actions can never collide with widget controls.
  // stickies keep loose corner buttons: their head is editable text.
  let chrome: HTMLElement = card;
  if (!card.classList.contains("sticky") && head) {
    const tools = document.createElement("span");
    tools.className = "card-tools";
    tools.contentEditable = "false";
    tools.addEventListener("pointerdown", (e) => e.stopPropagation());
    head.append(tools);
    chrome = tools;
  }
  makeResizable(card);
  makeDraggable(card);
  restoreCardState(card);
  focusBodyOnCardClick(card);
  if (card.dataset.kind === "terminal") {
    // the terminal log is output, not editable text — the input row owns typing
    const lg = card.querySelector<HTMLElement>(".term-log");
    if (lg) lg.contentEditable = "false";
    // a reloaded chat keeps its id — seed the sequence so new spawns never collide
    const cid0 = card.dataset.chatId;
    if (cid0 && /^\d+$/.test(cid0)) termSeq = Math.max(termSeq, parseInt(cid0));
    wireTerminal(card);
    if (!card.querySelector(".card-dup")) {
      const dup = document.createElement("button");
      dup.className = "card-dup";
      dup.textContent = "⧉";
      dup.title = "Duplicate this chat — same history, a fresh copy";
      dup.contentEditable = "false";
      dup.addEventListener("pointerdown", (e) => e.stopPropagation());
      dup.addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateTerminalCard(card);
      });
      chrome.append(dup);
    }
  }
  if (card.dataset.kind === "sheet") {
    // the grid handles its own editing — only the cells are editable
    const wrap = card.querySelector<HTMLElement>(".sheet-wrap");
    if (wrap) wrap.contentEditable = "false";
    wireSheet(card); // no-op when spawn already wired it at a custom size
    card.addEventListener("sheet:changed", () => {
      dirty = true;
      void save();
    });
    if (!card.querySelector(".card-dup")) {
      const dup = document.createElement("button");
      dup.className = "card-dup";
      dup.textContent = "⧉";
      dup.title = "Duplicate this sheet — copies all cells";
      dup.contentEditable = "false";
      dup.addEventListener("pointerdown", (e) => e.stopPropagation());
      dup.addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateSheetCard(card);
      });
      chrome.append(dup);
    }
  }
  if (card.dataset.kind === "deck") {
    // slides handle their own editing — the card surface stays static
    const wrap = card.querySelector<HTMLElement>(".deck-body");
    if (wrap) wrap.contentEditable = "false";
    wireDeck(card); // no-op when spawn already wired it
    card.addEventListener("deck:changed", () => {
      dirty = true;
      void save();
    });
    if (!card.querySelector(".card-dup")) {
      const dup = document.createElement("button");
      dup.className = "card-dup";
      dup.textContent = "⧉";
      dup.title = "Duplicate this deck — copies all slides";
      dup.contentEditable = "false";
      dup.addEventListener("pointerdown", (e) => e.stopPropagation());
      dup.addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateDeckCard(card);
      });
      chrome.append(dup);
    }
  }
  if (card.dataset.kind === "todo") {
    // the todo card edits its own rows — the card surface stays static
    const wrap = card.querySelector<HTMLElement>(".todo-body");
    if (wrap) wrap.contentEditable = "false";
    wireTodo(card); // no-op when spawn already wired it
    card.addEventListener("todo:changed", () => {
      dirty = true;
      void save();
    });
    if (!card.querySelector(".card-dup")) {
      const dup = document.createElement("button");
      dup.className = "card-dup";
      dup.textContent = "⧉";
      dup.title = "Duplicate this task list — copies every task";
      dup.contentEditable = "false";
      dup.addEventListener("pointerdown", (e) => e.stopPropagation());
      dup.addEventListener("click", (e) => {
        e.stopPropagation();
        duplicateTodoCard(card);
      });
      chrome.append(dup);
    }
  }
  if (card.dataset.kind === "browser") {
    const wrap = card.querySelector<HTMLElement>(".browser-view");
    if (wrap) wrap.contentEditable = "false";
    wireBrowser(card);
    card.addEventListener("browser:changed", () => {
      dirty = true;
      void save();
    });
  }
  if (card.dataset.kind === "cards") {
    const wrap = card.querySelector<HTMLElement>(".fc-list");
    if (wrap) wrap.contentEditable = "false";
    for (const w of card.querySelectorAll<HTMLElement>(".fc-tools, .fc-addrow, .fc-status, .fc-review"))
      w.contentEditable = "false";
    wireCards(card);
    card.addEventListener("cards:changed", () => {
      dirty = true;
      void save();
    });
  }
  if (card.dataset.kind === "map") {
    const wrap = card.querySelector<HTMLElement>(".map-canvas");
    if (wrap) wrap.contentEditable = "false";
    wireMap(card);
    card.addEventListener("map:changed", () => {
      dirty = true;
      void save();
    });
  }
  if (card.dataset.kind === "agenda") {
    const wrap = card.querySelector<HTMLElement>(".ag-body");
    if (wrap) wrap.contentEditable = "false";
    wireAgenda(card);
  }
  if (card.dataset.kind === "graph") {
    const wrap = card.querySelector<HTMLElement>(".callout-body");
    if (wrap) wrap.contentEditable = "false";
    wireGraph(card);
  }
  if (card.dataset.kind === "canvas") {
    const wrap = card.querySelector<HTMLElement>(".callout-body");
    if (wrap) wrap.contentEditable = "false";
    wireCanvas(card);
    card.addEventListener("canvas:changed", () => {
      dirty = true;
      void save();
    });
  }
  if (card.dataset.kind === "base") {
    const wrap = card.querySelector<HTMLElement>(".callout-body");
    if (wrap) wrap.contentEditable = "false";
    wireBase(card);
    card.addEventListener("base:changed", () => {
      dirty = true;
      void save();
    });
  }
  if (card.dataset.kind === "chart") {
    const wrap = card.querySelector<HTMLElement>(".chart-wrap");
    if (wrap) wrap.contentEditable = "false";
    wireChart(card);
    card.addEventListener("chart:changed", () => {
      dirty = true;
      void save();
    });
  }
  const del = document.createElement("button");
  del.className = "card-del";
  del.textContent = "×";
  del.title = "Delete this research card";
  del.contentEditable = "false";
  del.addEventListener("pointerdown", (e) => e.stopPropagation());
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    localStorage.removeItem(stateKey(card));
    card.remove();
    addActivity("card deleted — the topic can be researched again");
    scheduleCardLinks();
    markEdited();
  });
  chrome.append(del);
  if (!card.classList.contains("sticky") && !card.querySelector(".card-pin")) {
    // term chats and sheets both get the viewport pin — floating widgets the
    // user wants on screen while they scroll the note
    const isTerm = card.classList.contains("term-card") || card.classList.contains("sheet-card") || card.classList.contains("deck-card") || card.classList.contains("todo-card");
    const pinBtn = document.createElement("button");
    pinBtn.className = "card-pin";
    pinBtn.textContent = "⌖";
    pinBtn.title = "Pin this card in place";
    pinBtn.contentEditable = "false";
    pinBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      // leaving floating-pin mode first, then pinning to the sheet
      if (isTerm && card.classList.contains("viewport-pin")) toggleFloatPin(card);
      togglePin(card);
    });
    chrome.append(pinBtn);
    if (isTerm && !card.querySelector(".card-floatpin")) {
      // the second pin: viewport-fixed — the chat stays on screen while the
      // user scrolls anywhere on the sheet
      const fp = document.createElement("button");
      fp.className = "card-floatpin";
      fp.textContent = "📌";
      fp.title = "Floating pin — the chat stays on screen while you scroll";
      fp.contentEditable = "false";
      fp.addEventListener("pointerdown", (e) => e.stopPropagation());
      fp.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFloatPin(card);
      });
      chrome.append(fp);
    }
  }
  if (!card.classList.contains("term-card") && !card.classList.contains("sheet-card") && !card.classList.contains("deck-card") && !card.classList.contains("todo-card") && !card.querySelector(".card-tts")) {
    const tts = document.createElement("button");
    tts.className = "card-tts";
    tts.textContent = "♪";
    tts.title = "Read this card aloud";
    tts.contentEditable = "false";
    tts.addEventListener("pointerdown", (e) => e.stopPropagation());
    tts.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCardSpeech(card, tts);
    });
    chrome.append(tts);
  }
  if (!card.classList.contains("sticky") && !card.querySelector(".card-stick")) {
    const st = document.createElement("button");
    st.className = "card-stick";
    st.textContent = "▤";
    st.title = "Turn into a sticky note — drag it onto your desktop";
    st.contentEditable = "false";
    st.addEventListener("pointerdown", (e) => e.stopPropagation());
    st.addEventListener("click", (e) => {
      e.stopPropagation();
      stickifyCard(card);
    });
    chrome.append(st);
  }
  if (card.classList.contains("sticky") && !card.querySelector(".card-move")) {
    const mv = document.createElement("button");
    mv.className = "card-move";
    mv.textContent = "⠿";
    mv.title = "Drag to move (or drag outside to float on your desktop)";
    mv.contentEditable = "false";
    mv.draggable = true;
    mv.addEventListener("dragstart", (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      const r = card.getBoundingClientRect();
      dt.setDragImage(card, e.clientX - r.left, e.clientY - r.top);
      dt.effectAllowed = "move";
      dt.setData("text/plain", card.dataset.topic ?? "");
      card.classList.add("native-dragging");
    });
    mv.addEventListener("dragend", (e) => {
      card.classList.remove("native-dragging");
      const outside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight ||
        (e.clientX === 0 && e.clientY === 0) ||
        e.dataTransfer?.dropEffect === "none";
      if (outside) {
        popOutSticky(card, e.clientX || undefined, e.clientY || undefined);
        return;
      }
      const editor = body();
      const er = editor.getBoundingClientRect();
      const x = Math.round(Math.max(0, e.clientX - er.left + editor.scrollLeft - 40));
      const y = Math.round(Math.max(0, e.clientY - er.top + editor.scrollTop - 20));
      card.classList.add("floating");
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      writeState(card, { x, y });
      markEdited();
    });
    chrome.append(mv);
    const mn = document.createElement("button");
    mn.className = "card-menu";
    mn.textContent = "⋯";
    mn.title = "Sticky options — colors & history";
    mn.contentEditable = "false";
    mn.addEventListener("pointerdown", (e) => e.stopPropagation());
    mn.addEventListener("click", (e) => {
      e.stopPropagation();
      void openStickyMenu(mn);
    });
    chrome.append(mn);
  }
  // widget chrome must never capture Tab from the text
  card.querySelectorAll("button").forEach((b) => (b.tabIndex = -1));
  // generic snapshot undo — every widget kind rides it; sheets' finer
  // cell undo eats Ctrl+Z first, the card stack catches what it can't
  if (card.dataset.kind && KIND_WIRE[card.dataset.kind]) {
    armCardUndo(card, cardUndoHost());
  }
}

/* ---------- card links: a "nylon" thread drawn pin-to-pin from a source
   card to each follow-up card it spawned. The canvas lives inside
   #note-body so it scrolls with the content automatically --------------- */

let linksCv: HTMLCanvasElement | null = null;
let linksRaf = 0;

/* card ops call this in clusters (spawn → enhance → place → flow) — one
 * rAF coalesces them into a single rect-reading repaint instead of N
 * full-page passes per gesture */
export function scheduleCardLinks() {
  if (!linksRaf)
    linksRaf = requestAnimationFrame(() => {
      linksRaf = 0;
      drawCardLinks();
    });
}

export function drawCardLinks() {
  const el = body();
  if (!linksCv) {
    linksCv = document.createElement("canvas");
    linksCv.className = "card-links";
    el.prepend(linksCv);
  }
  const cv = linksCv;
  const d = window.devicePixelRatio || 1;
  const w = el.scrollWidth;
  const h = el.scrollHeight;
  const bw = Math.max(1, Math.round(w * d));
  const bh = Math.max(1, Math.round(h * d));
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const byCid = new Map<string, HTMLElement>();
  el.querySelectorAll<HTMLElement>(".callout").forEach((c) => {
    if (c.dataset.cid) byCid.set(c.dataset.cid, c);
  });
  const er = el.getBoundingClientRect();
  const z = Z();
  // anchor point = the pin point — the pin mark itself when the card is
  // pinned, otherwise the card's top-center where the pin would sit
  const pointOf = (card: HTMLElement) => {
    const pin = card.querySelector<HTMLElement>(".pin-mark");
    const r = (pin ?? card).getBoundingClientRect();
    return {
      x: (r.left - er.left + r.width / 2) / z + el.scrollLeft,
      y: (r.top - er.top + (pin ? r.height / 2 : 0)) / z + el.scrollTop,
    };
  };
  ctx.strokeStyle = "rgba(122, 90, 45, .55)";
  ctx.fillStyle = "rgba(122, 90, 45, .8)";
  ctx.lineWidth = 1.3;
  for (const c of Array.from(el.querySelectorAll<HTMLElement>(".callout"))) {
    const pid = c.dataset.parent;
    if (!pid) continue;
    const p = byCid.get(pid);
    if (!p) continue;
    const a = pointOf(p);
    const b = pointOf(c);
    const sag = Math.min(80, 16 + Math.abs(b.x - a.x) * 0.16 + Math.abs(b.y - a.y) * 0.06);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo((a.x + b.x) / 2, Math.max(a.y, b.y) + sag, b.x, b.y);
    ctx.stroke();
    for (const pt of [a, b]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

let genZ = 10; // each generated card tops the last — newest always on top
/* z bands: floating cards live at 10..79, pinned at 80..89 (always on top
 * of the paper stack), viewport-pinned widgets at 90 (!important css),
 * overlays/modals 96+. nextZ keeps generated cards inside their band —
 * past 79 it renumbers the live stack instead of overrunning pinned. */
const PIN_Z = 80;
let pinSeq = 0;
const pinnedZ = () => String(Math.min(89, PIN_Z + ++pinSeq));
const nextZ = () => {
  if (++genZ >= PIN_Z) {
    let n = 10;
    for (const c of body().querySelectorAll<HTMLElement>(
      ".callout.floating:not(.pinned):not(.viewport-pin)",
    ))
      c.style.zIndex = String(n++);
    genZ = n;
  }
  return genZ;
};

const CMD_TOKEN = /(^|\s)@(document|ask|skill|research|recall|tasks|related|loop|summary)\b/;

/** command words that open the no-@ picker when followed by a space */
const CMD_WORDS = [
  "document",
  "ask",
  "skill",
  "research",
  "recall",
  "tasks",
  "related",
  "loop",
  "summary",
  "schedule",
  "terminal",
  "chat",
  "sheet",
  "table",
  "slides",
  "deck",
  "powerpoint",
  "ppt",
  "todo",
  "browser",
  "browse",
  "chart",
  "cards",
  "flashcards",
  "review",
  "today",
  "map",
  "mindmap",
  "mind",
  "tpl",
  "template",
  "agenda",
  "due",
  "week",
  "graph",
  "canvas",
  "draw",
  "persona",
  "base",
  "view",
] as const;
type CmdWord = (typeof CMD_WORDS)[number];

/** input types that count as hand-typed text — paste and drop never arm
 *  commands. insertCompositionText is the IME commit, insertReplacementText
 *  is an autocorrect/spell-suggestion swap (Input Events Level 2) */
const TYPED_INPUTS = new Set(["insertText", "insertCompositionText", "insertReplacementText"]);

function makeCmdChip(word: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "cmd-chip";
  s.dataset.cmd = word;
  s.contentEditable = "false";
  s.textContent = word;
  return s;
}

function makeArgChip(slug: string, label: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "cmd-chip arg";
  s.dataset.arg = slug;
  s.contentEditable = "false";
  s.textContent = label;
  return s;
}

/** the command a chipped line carries — "@cmd [arg] rest" — so chipped
 *  lines dispatch through the exact branches legacy @ lines use */
function chipCommand(block: HTMLElement): { cmd: string; arg: string | null; rest: string } | null {
  const chip = block.querySelector<HTMLElement>(".cmd-chip[data-cmd]");
  if (!chip) return null;
  let arg: HTMLElement | null = null;
  for (let n = chip.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() === "") continue;
    if (n instanceof HTMLElement && n.classList.contains("cmd-chip") && n.dataset.arg) arg = n;
    break;
  }
  const last: Node = arg ?? chip;
  let rest = "";
  for (let n = last.nextSibling; n; n = n.nextSibling) rest += n.textContent ?? "";
  return { cmd: chip.dataset.cmd ?? "", arg: arg?.dataset.arg ?? null, rest: rest.trim() };
}

/** legacy @commands load as chips — the @ disappears from the UI while the
 *  saved markdown keeps it (storage stays plain, WYSIWYG rule extended) */
function decorateCommandChips(root: HTMLElement) {
  const re = new RegExp(`(^|[\\s\\u200b\\ufeff])@(${CMD_WORDS.join("|")})\\b`);
  for (const block of Array.from(root.children) as HTMLElement[]) {
    if (block.classList.contains("callout") || block.classList.contains("proposal")) continue;
    const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    let hit: Text | null = null;
    let m: RegExpExecArray | null = null;
    while ((node = tw.nextNode() as Text | null)) {
      const mm = re.exec(node.textContent ?? "");
      if (mm) {
        hit = node;
        m = mm;
        break;
      }
    }
    if (!hit || !m) continue;
    const at = m.index + m[1].length;
    const word = m[2];
    const range = document.createRange();
    range.setStart(hit, at);
    range.setEnd(hit, at + 1 + word.length);
    range.deleteContents();
    const chip = makeCmdChip(word);
    range.insertNode(chip);
    // an optional target follows — "@document @slug q" or "@document slug q";
    // only known slugs/pseudo targets chip, anything else is the question
    const after = chip.nextSibling;
    if (after?.nodeType === Node.TEXT_NODE) {
      const t = after as Text;
      const tm = (t.textContent ?? "").match(/^\s*@?([\w-]+)\s/);
      if (tm && /^(my-notes|everything|all-files)$/.test(tm[1])) {
        // keep the leading whitespace — it is the gap between the two chips
        const leadSp = tm[0].length - tm[0].replace(/^\s+/, "").length;
        const ar = document.createRange();
        ar.setStart(t, leadSp);
        ar.setEnd(t, tm[0].length);
        ar.deleteContents();
        const arg = makeArgChip(tm[1], tm[1]);
        ar.insertNode(arg);
        arg.after(document.createTextNode(" "));
      } else if (tm) {
        // file slugs upgrade asynchronously once rag_list answers
        argChipCandidates.push({ block, chip, slug: tm[1], len: tm[0].length });
      }
    }
  }
}

/** file slugs found while decorating — upgraded to arg chips when rag_list
 *  answers, so note open stays instant on big libraries */
let argChipCandidates: Array<{ block: HTMLElement; chip: HTMLElement; slug: string; len: number }> = [];

function upgradeArgChips() {
  const pending = argChipCandidates;
  argChipCandidates = [];
  if (!pending.length) return;
  void invoke<Array<{ slug: string; name: string }>>("rag_list")
    .then((list) => {
      const slugs = new Map(list.map((f) => [f.slug, f.name]));
      for (const c of pending) {
        if (!c.chip.isConnected) continue;
        const name = slugs.get(c.slug);
        if (!name) continue;
        const t = c.chip.nextSibling;
        if (t?.nodeType !== Node.TEXT_NODE) continue;
        const tm = (t.textContent ?? "").match(/^\s*@?([\w-]+)\s/);
        if (!tm || tm[1] !== c.slug) continue;
        const leadSp = tm[0].length - tm[0].replace(/^\s+/, "").length;
        const ar = document.createRange();
        ar.setStart(t, leadSp);
        ar.setEnd(t, c.len);
        ar.deleteContents();
        const arg = makeArgChip(c.slug, name);
        ar.insertNode(arg);
        arg.after(document.createTextNode(" "));
      }
    })
    .catch(() => {});
}

/** the typed @command line is a receipt for the run — once its answer card
 *  exists the line is redundant: cut from the @ token to end-of-line and
 *  return whatever text precedes it ("" means the block held only the
 *  command and should be dropped entirely). Chipped lines cut from the
 *  first chip instead. */
function stripCommandText(block: HTMLElement): string {
  const chip = block.querySelector<HTMLElement>(".cmd-chip");
  if (chip) {
    const range = document.createRange();
    range.setStartBefore(chip);
    range.setEnd(block, block.childNodes.length);
    range.deleteContents();
    return block.textContent ?? "";
  }
  const text = block.textContent ?? "";
  const m = CMD_TOKEN.exec(text);
  if (!m) return text;
  const cut = m.index + m[1].length;
  const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let node: Text | null;
  while ((node = tw.nextNode() as Text | null)) {
    if (acc + node.length > cut) {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setStart(node, cut - acc);
      range.deleteContents();
      break;
    }
    acc += node.length;
  }
  return block.textContent ?? "";
}

/** dictation lands at the caret when it sits on the paper, else at the end */
function insertDictation(text: string) {
  const el = body();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
    const node = sel.anchorNode;
    const host = node instanceof HTMLElement ? node : node?.parentElement;
    if (host && el.contains(host) && !host.closest(".callout")) {
      const r = sel.getRangeAt(0);
      const t = document.createTextNode(`${text} `);
      r.insertNode(t);
      r.setStartAfter(t);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      markEdited();
      return;
    }
  }
  const p = document.createElement("p");
  p.textContent = text;
  el.append(p);
  markEdited();
}

/** [[note]] links: open the target, creating it when it doesn't exist yet */
async function openWikiNote(name: string) {
  const [base0, frag] = name.trim().split("#", 2);
  const base = base0.trim();
  if (!base) {
    if (frag) scrollToFrag(frag); // [[#heading]] / [[#^id]] — same note
    return;
  }
  const file = /\.(laido|md)$/.test(base) ? base : `${base}.laido`;
  try {
    const list = await invoke<Array<{ name: string }>>("vault_list");
    if (!list.some((n) => n.name === file)) {
      await invoke("vault_write", { name: file, content: "" });
      addActivity(`📄 created ${file}`);
    }
    await loadNote(file);
    if (frag) scrollToFrag(frag);
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
  }
}

/** scroll the open note to `#Heading` or a `^blockid` anchor */
function scrollToFrag(frag: string) {
  const host = body();
  if (!host) return;
  let el: HTMLElement | null = null;
  if (frag.startsWith("^")) {
    const want = `^${frag.slice(1)}`;
    const badge = Array.from(host.querySelectorAll<HTMLElement>(".blkid")).find(
      (b) => b.textContent?.trim() === want,
    );
    el = (badge?.closest("p, li, h1, h2, h3, .callout") as HTMLElement | null) ?? null;
  } else {
    const want = frag.trim().toLowerCase();
    el =
      Array.from(host.querySelectorAll<HTMLElement>("h1, h2, h3")).find(
        (h) => !h.closest(".callout, .note-embed") && h.textContent?.trim().toLowerCase() === want,
      ) ?? null;
  }
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("or-flash");
  void el.offsetWidth;
  el.classList.add("or-flash");
}

/* ---------- hover preview — Ctrl+hover a wikilink previews the note
 * (Obsidian Page Preview: in an editing surface the modifier is required).
 * ~350ms dwell, Esc / mouse-leave / Ctrl-release dismisses. */
let ctrlHeld = false;
let peekEl: HTMLElement | null = null;
let peekTimer = 0;
function hidePeek(force = false) {
  if (!force && peekEl?.dataset.pinned === "1") return;
  clearTimeout(peekTimer);
  peekEl?.remove();
  peekEl = null;
}
async function showPeek(link: HTMLElement) {
  const [base0, frag] = (link.dataset.note ?? "").split("#", 2);
  const base = base0.trim();
  if (!base) return;
  const file = /\.(laido|md)$/.test(base) ? base : `${base}.laido`;
  let md: string;
  try {
    md = await invoke<string>("vault_read", { name: file });
  } catch {
    return;
  }
  hidePeek(true);
  const pop = document.createElement("div");
  pop.className = "peek-pop";
  pop.contentEditable = "false";
  const slice = (m: string) =>
    !frag ? m : frag.startsWith("^") ? sliceBlock(m, frag.slice(1)) : sliceSection(m, frag);
  const sliced = slice(md);
  pop.innerHTML =
    `<div class="peek-head"><span class="peek-title">${stem(file)}${frag ? ` <span class="ne-sec">#${frag.replace(/</g, "&lt;")}</span>` : ""}</span>` +
    `<button class="peek-btn" data-a="edit" title="edit this slice (Ctrl+Enter saves)">✎</button>` +
    `<button class="peek-btn" data-a="pin" title="pin open">📌</button>` +
    `<button class="peek-btn" data-a="x" title="close">✕</button></div>` +
    `<div class="peek-body">${renderMarkdown(sliced.trim() === "" ? "*(empty)*" : sliced, 1)}</div>`;
  const r = link.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, innerWidth - 400)}px`;
  pop.style.top = `${r.bottom + 6}px`;
  document.body.append(pop);
  peekEl = pop;
  void hydrateAssets(pop);
  pop.addEventListener("mouseenter", () => clearTimeout(peekTimer));
  pop.addEventListener("mouseleave", () => {
    if (pop.dataset.pinned !== "1") peekTimer = window.setTimeout(hidePeek, 120);
  });
  const head = pop.querySelector<HTMLElement>(".peek-head")!;
  const bodyEl = pop.querySelector<HTMLElement>(".peek-body")!;
  // ✎ — the popover becomes a tiny editor (Hover-Editor pattern): the
  // slice's raw markdown in a textarea, Ctrl+Enter/click ✓ writes it
  // back through vault_write (which snapshots the file first, so a
  // peek-edit is one `> history` away from undone). Esc cancels.
  const toggleEdit = () => {
    const ta = bodyEl.querySelector<HTMLTextAreaElement>(".peek-edit");
    if (ta) return; // already editing
    const prev = bodyEl.innerHTML;
    bodyEl.innerHTML =
      `<textarea class="peek-edit" spellcheck="false"></textarea>` +
      `<div class="peek-editbar"><button class="peek-save">✓ save</button><button class="peek-cancel">esc</button><span class="peek-hint">Ctrl+Enter saves</span></div>`;
    const ed = bodyEl.querySelector<HTMLTextAreaElement>(".peek-edit")!;
    ed.value = slice(md); // fresh — a prior save may have changed md
    ed.focus();
    const done = () => {
      bodyEl.innerHTML = prev;
      void hydrateAssets(bodyEl);
    };
    bodyEl.querySelector(".peek-cancel")!.addEventListener("click", done);
    const save = async () => {
      const next = ed.value;
      const whole = !frag
        ? next
        : frag.startsWith("^")
          ? spliceBlock(md, frag.slice(1), next)
          : spliceSection(md, frag, next);
      if (whole === null) {
        document.dispatchEvent(new CustomEvent("laido:toast", { detail: `no ${frag} in ${stem(file)}` }));
        return;
      }
      await invoke("vault_write", { name: file, content: whole });
      md = whole;
      document.dispatchEvent(new CustomEvent("laido:toast", { detail: `${stem(file)} updated from peek` }));
      void refreshIndex(true).then(paintLinkStrip);
      const re = slice(md);
      bodyEl.innerHTML = renderMarkdown(re.trim() === "" ? "*(empty)*" : re, 1);
      void hydrateAssets(bodyEl);
    };
    bodyEl.querySelector(".peek-save")!.addEventListener("click", () => void save());
    ed.addEventListener("keydown", (ke) => {
      if (ke.key === "Escape") { ke.stopPropagation(); done(); }
      if (ke.key === "Enter" && ke.ctrlKey) { ke.preventDefault(); void save(); }
      ke.stopPropagation(); // keep typing out of global shortcuts
    });
  };
  pop.querySelector('[data-a="edit"]')!.addEventListener("click", toggleEdit);
  pop.querySelector('[data-a="pin"]')!.addEventListener("click", (e) => {
    const on = pop.dataset.pinned === "1";
    pop.dataset.pinned = on ? "" : "1";
    (e.target as HTMLElement).classList.toggle("on", !on);
  });
  pop.querySelector('[data-a="x"]')!.addEventListener("click", () => {
    delete pop.dataset.pinned;
    hidePeek(true);
  });
  // dragging the head moves the popover and auto-pins it
  head.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".peek-btn")) return;
    e.preventDefault();
    pop.dataset.pinned = "1";
    pop.querySelector('[data-a="pin"]')?.classList.add("on");
    const ox = e.clientX - pop.offsetLeft;
    const oy = e.clientY - pop.offsetTop;
    const mv = (ev: MouseEvent) => {
      pop.style.left = `${Math.max(0, Math.min(ev.clientX - ox, innerWidth - 120))}px`;
      pop.style.top = `${Math.max(0, ev.clientY - oy)}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  });
}
function armPeek() {
  // Ctrl+hover on a wikilink → preview after a short dwell
  document.addEventListener("keydown", (e) => {
    if (e.key === "Control") ctrlHeld = true;
    if (e.key === "Escape") hidePeek(true);
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Control") { ctrlHeld = false; hidePeek(); }
  });
  document.addEventListener("mouseover", (e) => {
    const w = (e.target as HTMLElement).closest?.(".wikilink") as HTMLElement | null;
    if (!w || !e.ctrlKey) return;
    if (peekEl?.dataset.pinned === "1") return; // a pinned popover stays
    clearTimeout(peekTimer);
    peekTimer = window.setTimeout(() => { if (ctrlHeld) void showPeek(w); }, 350);
  });
  document.addEventListener("mouseout", (e) => {
    const w = (e.target as HTMLElement).closest?.(".wikilink");
    if (!w) return;
    const to = e.relatedTarget as Node | null;
    if (to && peekEl?.contains(to)) return; // slid onto the popover
    peekTimer = window.setTimeout(() => hidePeek(), 120);
  });
}

export function insertCallout(
  topic: string,
  calloutMd: string,
  anchor?: string,
  parent?: string,
  question?: string,
): HTMLElement | null {
  hidePencil();
  const root = body();
  const needle = clean(anchor ?? `@research ${topic}`);
  // chipped lines show the command without the @ — match either form so
  // cards always anchor to the line that started them
  const alt = needle.replace(/^@/, "");
  let target: HTMLElement | null = null;
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const t = clean(child.textContent ?? "");
    if (t === needle || t === alt) {
      target = child;
      break;
    }
  }
  const holder = document.createElement("div");
  holder.innerHTML = renderCalloutMd(calloutMd);
  const card = holder.firstElementChild as HTMLElement | null;
  if (!card) return null;
  if (parent) card.dataset.parent = parent;
  if (question) {
    card.dataset.question = question;
    const title = card.querySelector(".callout-title");
    if (title) {
      const q = document.createElement("span");
      q.className = "card-q";
      q.textContent = `“${question}”`;
      q.title = question;
      title.after(q);
    }
  }
  enhanceCard(card);
  card.classList.add("reveal");
  window.setTimeout(() => card.classList.remove("reveal"), 1400);
  if (target) {
    // failure cards keep the command line so the user can fix and re-run it
    const ref = target.nextSibling;
    const left = calloutMd.startsWith("> [!ai] rag failed")
      ? "x"
      : stripCommandText(target).replace(/[\u200b\ufeff]/g, "").trim();
    if (left) target.after(card);
    else {
      target.remove();
      root.insertBefore(card, ref);
    }
  } else {
    root.append(card);
  }
  // a freshly generated widget lands centered in the user's current view,
  // floating above pinned cards so it is always immediately visible
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  // a stale pinned state can be restored from an older card with the same
  // topic+slot key — a fresh answer is never pinned and always sits above
  // the pin layer so the user sees it immediately
  card.classList.remove("pinned");
  card.querySelector(".pin-mark")?.remove();
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  return card;
}

/** pin a card in place without the toggle semantics — used for research-loop
 *  cards so every successful loop stays put (cascade keeps them readable) */
export function pinCard(card: HTMLElement, cascade = 0) {
  if (!card?.classList || card.classList.contains("pinned")) return;
  const editor = body();
  const er = editor.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const x =
    Math.round(Math.max(0, (cr.left - er.left) / Z() + editor.scrollLeft)) + cascade * 34;
  const y = Math.round(Math.max(0, (cr.top - er.top) / Z() + editor.scrollTop)) + cascade * 34;
  card.classList.add("floating", "pinned");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  card.style.zIndex = pinnedZ();
  card.style.overflow = "visible";
  writeState(card, { x, y, pinned: 1 });
  pinMark(card);
  const pinc = pickPinColor();
  applyPinColor(card, PIN_COLORS[pinc]);
  writeState(card, { pinc });
  scheduleFlow();
  markEdited();
}

/** the capture pipe's landing zone — a browser clip appends quote lines
 *  (one <blockquote> per line, so the `> ` round-trip stays clean) plus a
 *  `— [title](url)` source link. Serializes back as `> quote` + `> — [..](..)`. */
export function insertClip(title: string, url: string, text: string): void {
  const b = body();
  if (!b) return;
  title = S(title);
  url = S(url);
  text = S(text);
  // a `tpl-clip` / `clip-template` note takes over the clip's landing
  // format — same {{var}} grammar as @tpl, plus {{content}} and {{url}}
  void (async () => {
    const ix = await refreshIndex().catch(() => null);
    const tpl = ix?.notes.find((n) => {
      const s = stem(n).toLowerCase();
      return s === "tpl-clip" || s === "clip-template" || s === "clip" || s === "web-clip";
    });
    if (tpl && current) {
      let md: string;
      try {
        md = await invoke<string>("vault_read", { name: tpl });
      } catch {
        md = "";
      }
      if (md.trim()) {
        md = fillTemplateVars(md, title || titleName(current))
          .replace(/\{\{\s*url\s*\}\}/g, url)
          .replace(/\{\{\s*content\s*\}\}/g, text.trim());
        const prompts = [...md.matchAll(/\{\{\s*prompt:([^}]+)\}\}/g)];
        for (const p of prompts) {
          const q = p[1].trim();
          let ans = `(${q})`;
          try {
            const r = await invoke<{ text: string }>("term_ai", {
              prompt: `Answer briefly for a clipped-webpage template slot — the page is "${title}" (${url}); clipped text follows.\n\n${text.slice(0, 3000)}\n\nQuestion: ${q}`,
              history: [],
              others: "",
              model: null,
              persona: null,
            });
            if (r.text.trim()) ans = r.text.trim();
          } catch { /* keep placeholder */ }
          md = md.replace(p[0], ans);
        }
        const frag2 = document.createElement("div");
        frag2.innerHTML = renderMarkdown(md);
        const kids = Array.from(frag2.children);
        for (const el2 of kids) {
          b.appendChild(el2);
          if (el2.classList?.contains("callout")) enhanceCard(el2 as HTMLElement);
        }
        kids[0]?.scrollIntoView({ block: "nearest" });
        markEdited();
        return;
      }
    }
    // default — blockquote lines + a source link
    const frag = document.createDocumentFragment();
    for (const ln of text.split("\n")) {
      const q = document.createElement("blockquote");
      q.textContent = ln.trimEnd() || " ";
      frag.appendChild(q);
    }
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.className = "lnk";
    a.dataset.url = url;
    a.textContent = `— ${title}`;
    p.appendChild(a);
    frag.appendChild(p);
    b.appendChild(frag);
    p.scrollIntoView({ block: "nearest" });
    markEdited();
  })().catch(() => {});
}

/** arrange one research-loop run into a clean two-column grid on the sheet:
 *  uniform width, natural height, each new card goes to the shorter column */
export function layoutLoopRun(run: string) {
  const root = body();
  const cards = Array.from(
    root.querySelectorAll<HTMLElement>(`.callout[data-loop-run="${run}"]`),
  ).sort((a, b) => Number(a.dataset.loopIndex ?? 0) - Number(b.dataset.loopIndex ?? 0));
  if (!cards.length) return;
  const GAP = 22;
  const avail = Math.max(320, root.clientWidth - 44);
  const W = Math.min(380, Math.floor((avail - GAP) / 2));
  const startX = Math.max(10, Math.round((root.clientWidth - (W * 2 + GAP)) / 2));
  const startY = Math.max(14, root.scrollTop + 14);
  const bottoms = [startY, startY];
  for (const card of cards) {
    card.classList.add("floating", "pinned", "sized");
    card.style.width = `${W}px`;
    card.style.height = "auto";
    card.style.margin = "0";
    card.style.overflow = "visible";
    card.style.zIndex = pinnedZ();
    const h = card.offsetHeight;
    const col = bottoms[0] <= bottoms[1] ? 0 : 1;
    const x = startX + col * (W + GAP);
    const y = bottoms[col];
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    bottoms[col] = y + h + GAP;
    writeState(card, { x, y, w: W, h, pinned: 1 });
    if (!card.querySelector(".pin-mark")) {
      pinMark(card);
      const pinc = pickPinColor();
      applyPinColor(card, PIN_COLORS[pinc]);
      writeState(card, { pinc });
    }
  }
  scheduleFlow();
  markEdited();
}

export function clearNote() {
  loadGen++; // kill any in-flight loadNote — its read must not repaint
  current = "";
  $("#note-title").textContent = "—";
  body().innerHTML = "";
  dirty = false;
  setState("");
}

// each loadNote bumps this; a read that resolves after a newer load
// started is stale — it must not repaint or become `current`, or the
// next save writes this note's DOM into the newer note's file
let loadGen = 0;
/* each note keeps its own scroll spot — switching away and back lands
 * where you left off, and a fresh note always opens at the top. Without
 * this the shared #note-body carried the old scrollTop over: clicks in a
 * short note computed a content-y thousands of px deep → the "pad down"
 * path overflowed its cap → the caret fell back to the first block,
 * i.e. "the cursor is stuck at the top" */
const noteScroll = new Map<string, { t: number; l: number }>();

export async function loadNote(name: string) {
  hidePencil();
  const gen = ++loadGen;
  const md = await invoke<string>("vault_read", { name });
  if (gen !== loadGen) return;
  /* the same #note-body scrolls every note — park the outgoing note's
   * scroll and restore this one's (new notes start at the top) */
  const el = body();
  if (current) noteScroll.set(current, { t: el.scrollTop, l: el.scrollLeft });
  current = name;
  $("#note-title").textContent = titleName(name);
  /* note switch ≠ card delete: flag browser cards so their webviews park
   * (hidden, still playing) instead of closing — the bv: line lets the
   * re-rendered card re-attach to the same engine */
  el.querySelectorAll<HTMLElement>(".browser-card").forEach((c) => {
    c.dataset.park = "1";
  });
  el.innerHTML = renderMarkdown(md);
  const sv = noteScroll.get(name);
  el.scrollTop = sv?.t ?? 0;
  el.scrollLeft = sv?.l ?? 0;
  hydrateAssets(el);
  void hydrateEmbeds(el);
  decorateCommandChips(el);
  upgradeArgChips();
  const cards = Array.from(el.querySelectorAll(".callout")) as HTMLElement[];
  for (const card of cards) {
    enhanceCard(card);
  }
  for (const card of cards) {
    avoidOverlap(card);
  }
  dirty = false;
  setState(t("ed.saved"));
  requestAnimationFrame(() => {
    // positions are restored exactly as saved — nothing here may move a
    // widget the user placed. (Explicit re-layout lives on the align button.)
    flowAroundCards();
    scheduleCardLinks();
    el.scrollTop = sv?.t ?? 0; // re-apply after the card layout settles
    el.scrollLeft = sv?.l ?? 0;
  });
  void refreshIndex().then(paintLinkStrip);
  refreshOutline();
}

/** vault-relative `![](attachments/x.png)` renders as data-asset imgs —
 *  this pass swaps in the real bytes via asset_data_url */
export function hydrateAssets(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>("img[data-asset]").forEach((img) => {
    const p = img.dataset.asset ?? "";
    void invoke<string>("asset_data_url", { path: p })
      .then((u) => {
        img.src = u;
      })
      .catch(() => img.classList.add("img-missing"));
  });
}

/** `![[note]]` / `![[note#Heading]]` placeholders → live rendered content.
 *  A `#heading` slices just that section (to the next same-or-higher
 *  heading). Embedded content renders at depth 1 — nested embeds inside
 *  it collapse to ordinary wikilinks. */
export async function hydrateEmbeds(root: HTMLElement) {
  const embeds = Array.from(
    root.querySelectorAll<HTMLElement>(".note-embed[data-src]"),
  );
  for (const em of embeds) {
    const src = em.dataset.src ?? "";
    const head = em.dataset.head;
    em.querySelector<HTMLElement>(".ne-open")?.addEventListener("click", () =>
      void loadNote(src.endsWith(".laido") ? src : `${src}.laido`),
    );
    const body = em.querySelector<HTMLElement>(".ne-body");
    if (!body) continue;
    try {
      let md = await invoke<string>("vault_read", {
        name: src.endsWith(".laido") ? src : `${src}.laido`,
      });
      if (head) md = head.startsWith("^") ? sliceBlock(md, head.slice(1)) : sliceSection(md, head);
      body.innerHTML = renderMarkdown(md.trim() === "" ? "*(empty)*" : md, 1);
      hydrateAssets(body);
      body.querySelectorAll<HTMLElement>(".callout").forEach((c) => enhanceCard(c));
    } catch {
      body.innerHTML = `<span class="ne-miss">note not found — [[${src}]]</span>`;
    }
  }
}
export { sliceBlock };

/** `{{date:fmt}}`/`{{time:fmt}}` — tiny token formatter (YYYY YY MM DD
 *  HH mm ss + MMM) — Obsidian Templates-compatible for the common cases */
export function fillTemplateVars(md: string, title: string, now = new Date()): string {
  md = typeof md === "string" ? md : "";
  title = typeof title === "string" ? title : "";
  if (!(now instanceof Date) || !Number.isFinite(+now)) now = new Date();
  const fmtDate = (fmt: string) =>
    fmt
      .replace(/YYYY/g, String(now.getFullYear()))
      .replace(/YY/g, String(now.getFullYear()).slice(-2))
      .replace(/MM/g, String(now.getMonth() + 1).padStart(2, "0"))
      .replace(/DD/g, String(now.getDate()).padStart(2, "0"))
      .replace(/HH/g, String(now.getHours()).padStart(2, "0"))
      .replace(/mm/g, String(now.getMinutes()).padStart(2, "0"))
      .replace(/ss/g, String(now.getSeconds()).padStart(2, "0"))
      .replace(/MMM/g, now.toLocaleDateString(undefined, { month: "short" }));
  return md
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_m, f) => fmtDate(f ?? "YYYY-MM-DD"))
    .replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_m, f) => fmtDate(f ?? "HH:mm"));
}

/** `@tpl <name>` → find the template note (tpl-x / template-x /
 *  x-template / tpl_x), fill `{{title}}/{{date}}/{{time}}`, then ask the
 *  model each `{{prompt:…}}` and drop the result in — the clipper
 *  Interpreter pattern. Inserts rendered content where the command ran. */
export async function insertTemplate(name: string, block?: HTMLElement) {
  if (!current) return;
  const ix = await refreshIndex().catch(() => null);
  const want = name.toLowerCase();
  const match = ix?.notes.find((n) => {
    const s = stem(n).toLowerCase();
    return (
      s === `tpl-${want}` || s === `template-${want}` || s === `${want}-template` ||
      s === `tpl_${want}` || s === `template_${want}` ||
      (!name && (s.startsWith("tpl-") || s.startsWith("template-")))
    );
  }) ?? ix?.notes.find((n) => stem(n).toLowerCase().includes(`tpl`));
  if (!match) {
    addActivity(`no template note found for "${name || "(any)"}" — make a note named tpl-<name>`);
    return;
  }
  let md: string;
  try {
    md = await invoke<string>("vault_read", { name: match });
  } catch {
    addActivity(`template "${match}" unreadable`);
    return;
  }
  md = fillTemplateVars(md, titleName(current));
  // {{prompt:q}} slots — each asks the model, answer replaces the slot
  const prompts = [...md.matchAll(/\{\{\s*prompt:([^}]+)\}\}/g)];
  for (const p of prompts) {
    const q = p[1].trim();
    let ans = `(${q})`;
    try {
      const r = await invoke<{ text: string }>("term_ai", {
        prompt: `Answer briefly and factually for a note template slot — plain text, no preamble: ${q}`,
        history: [],
        others: "",
        model: null,
      });
      if (r.text.trim()) ans = r.text.trim();
    } catch { /* keep the placeholder */ }
    md = md.replace(p[0], ans);
  }
  // {{cursor}} — leave a sentinel in the text; after insertion the caret
  // lands on it and the sentinel is stripped (Templater's jump-spot)
  const CURSOR = "\u0001CURSOR\u0001";
  md = md.replace(/\{\{\s*cursor(?::\d+)?\s*\}\}/g, CURSOR);
  // render + insert where the command line was (or append at end)
  const frag = document.createElement("div");
  frag.innerHTML = renderMarkdown(md);
  const host = body();
  const kids = Array.from(frag.children);
  for (const el2 of kids) {
    if (block && block.parentElement === host) block.after(el2);
    else host.append(el2);
  }
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  for (const el2 of kids) {
    if (el2.classList?.contains("callout")) enhanceCard(el2 as HTMLElement);
  }
  // cursor jump-spot — find the sentinel text node, place the caret there
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let tn: Text | null;
  while ((tn = w.nextNode() as Text | null)) {
    const at = tn.data.indexOf(CURSOR);
    if (at < 0) continue;
    tn.data = tn.data.replace(CURSOR, "");
    const r = document.createRange();
    r.setStart(tn, at);
    r.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    break; // first {{cursor}} wins
  }
  hydrateAssets(host);
  void hydrateEmbeds(host);
  addActivity(`template "${match.replace(/\.laido$/, "")}" inserted (${kids.length} blocks)`);
  dirty = true;
  void save();
}

/** paste/drop landing: save to vault attachments, insert `![](rel)` img */
export function insertImageAsset(relPath: string, anchor?: HTMLElement | null) {
  const b = body();
  if (!b) return;
  const p = document.createElement("p");
  const img = document.createElement("img");
  img.className = "note-img";
  img.dataset.asset = relPath;
  p.appendChild(img);
  if (anchor) anchor.after(p);
  else b.appendChild(p);
  hydrateAssets(p);
  markEdited();
}

export async function save() {
  if (!current || !dirty) return;
  setState(t("ed.saving"));
  try {
    await invoke("vault_write", { name: current, content: serialize(body()) });
    dirty = false;
    setState(t("ed.saved"));
  } catch (e) {
    setState(t("ed.failed"));
    console.error(e);
  }
}

interface SkillRow {
  name: string;
  description: string;
  runs: number;
  steps: string[];
  triggers?: string[];
  body?: string;
}

/** Position a floating pop under the caret (flips above when near the bottom). */
function placeAtCaret(pop: HTMLElement) {
  let rect: DOMRect | null = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    const rects = range.getClientRects();
    rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const node = sel.anchorNode;
      const host = node instanceof HTMLElement ? node : node?.parentElement;
      rect = host?.getBoundingClientRect() ?? null;
    }
  }
  const h = pop.offsetHeight;
  const w = pop.offsetWidth;
  const anchorTop = rect && rect.height > 0 ? rect.bottom + 6 : 140;
  const anchorLeft = rect && rect.width > 0 ? rect.left : 120;
  const top =
    anchorTop + h > window.innerHeight - 12
      ? Math.max(12, (rect?.top ?? 120) - h - 6)
      : anchorTop;
  pop.style.left = `${Math.max(8, Math.min(anchorLeft, window.innerWidth - w - 12))}px`;
  pop.style.top = `${top}px`;
}

/** the floating pop element — the no-@ command picker owns it */
const mentionPop = () => $("#mention-pop") as HTMLDivElement;

/* ---------- no-@ command picker: type a word, press space, pick ---------- */

interface CmdPickRow {
  label: string;
  desc: string;
  /** prefix mode: what this row becomes when accepted */
  kind?: "cmd" | "skill";
  /** target mode: accepting inserts a target chip carrying this slug */
  arg?: { slug: string; label: string };
  /** target mode: accepting inserts this text after the chip (schedule/loop templates) */
  template?: string;
}

interface CmdPickState {
  /** target: picking an argument for an armed chip · prefix: completing a typed word */
  mode: "target" | "prefix";
  /** target mode: the armed command word · prefix mode: the typed partial */
  word: string;
  /** the text node holding the typed word (word starts at `start`) */
  node: Text;
  start: number;
  end: number;
  /** bare-chip mode: insert after this node instead of replacing a range */
  after?: ChildNode;
}

let cmdPick: CmdPickState | null = null;
let cmdRows: CmdPickRow[] = [];
let cmdRowsAll: CmdPickRow[] = [];
let cmdRowsWord: string | null = null;
let cmdActive = 0;

function closeCmdPick() {
  if (!cmdPick) return;
  cmdPick = null;
  cmdRows = [];
  cmdRowsWord = null;
  cmdActive = 0;
  mentionPop().classList.add("hidden");
}

/** the top-level row an element sits in — the note body itself for bare rows */
function rowOf(el: HTMLElement): HTMLElement {
  let top = el;
  while (top.parentElement && top.parentElement.id !== "note-body" && top.id !== "note-body") {
    top = top.parentElement;
  }
  return top;
}

/** the top-level row a text node belongs to — the note body itself when the
 *  node sits directly on the paper (a bare line) */
function lineRow(node: Text): HTMLElement | null {
  const host = node.parentElement;
  return host ? rowOf(host) : null;
}

/** the "word " a collapsed caret sits right after, when word is a command */
function currentCmdWord(): CmdPickState | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const host = (node as Text).parentElement;
  if (!host?.closest("#note-body") || host.closest(".callout")) return null;
  // one command per line — a line that already carries a chip never reopens
  // the picker, so the message after a command is never hijacked
  const top = lineRow(node as Text);
  if (top && top !== body() && top.querySelector(".cmd-chip")) return null;
  const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
  // a blank ruled line can carry a zero-width space (U+200B) that trim and
  // \s both ignore — accept it as a word boundary so typing on those lines
  // still arms the command
  const m = before.match(/(?:^|[\s\u200b\ufeff])@?([a-z]+) $/);
  if (!m || !(CMD_WORDS as readonly string[]).includes(m[1])) return null;
  // a typed @ right before the word is muscle memory — consume it into the chip
  const at = sel.anchorOffset - m[1].length - 1;
  const hasAt = at > 0 && (node.textContent ?? "")[at - 1] === "@";
  return {
    mode: "target",
    word: m[1],
    node: node as Text,
    start: hasAt ? at - 1 : at,
    end: sel.anchorOffset,
  };
}

/** the in-progress command word under a collapsed caret, when it starts the
 *  row — "r", "rese", "ask" … feed the live suggestion list */
function currentCmdPrefix(): CmdPickState | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const host = (node as Text).parentElement;
  if (!host?.closest("#note-body") || host.closest(".callout")) return null;
  const top = lineRow(node as Text);
  if (top && top !== body() && top.querySelector(".cmd-chip")) return null;
  const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
  const m = before.match(/(?:^|[\s\u200b\ufeff])@?([a-z]+)$/);
  if (!m) return null;
  const st: CmdPickState = {
    mode: "prefix",
    word: m[1],
    node: node as Text,
    start: sel.anchorOffset - m[1].length,
    end: sel.anchorOffset,
  };
  if (!wordAtLineStart(st)) return null;
  return st;
}

/** true when only whitespace (or invisible zero-width markers) precedes the
 *  word inside its row */
function wordAtLineStart(p: CmdPickState): boolean {
  const top = lineRow(p.node);
  if (!top) return false;
  const strip = (s: string) => s.replace(/[\u200b\ufeff]/g, "");
  if (top === body()) return strip((p.node.textContent ?? "").slice(0, p.start)).trim() === "";
  const r = document.createRange();
  r.setStart(top, 0);
  r.setEnd(p.node, p.start);
  const lead = strip(r.toString());
  // a word that directly follows a click-and-type nbsp pad was placed in
  // empty space — the row's left edge isn't the command's start. Typed
  // prose never contains nbsp, so the pad itself is the intent signal.
  return lead.trim() === "" || lead.endsWith(" ");
}

/** a hand-typed word at line start arms immediately — the word becomes a
 *  chip and the picker stays open for an optional target */
function chipifyTypedWord(p: CmdPickState): CmdPickState | null {
  const row = lineRow(p.node);
  // one command per line — a stale trigger never adds a second chip
  if (!row || row !== body() && row.querySelector(".cmd-chip")) return null;
  const sel = window.getSelection();
  const caret = sel?.anchorNode === p.node ? sel.anchorOffset : p.end;
  // swallow a zero-width prefix so the chip starts the line cleanly
  const prefix = (p.node.textContent ?? "").slice(0, p.start);
  const start = /^[\u200b\ufeff]*$/.test(prefix) ? 0 : p.start;
  const range = document.createRange();
  range.setStart(p.node, start);
  range.setEnd(p.node, Math.max(p.end, caret));
  range.deleteContents();
  const chip = makeCmdChip(p.word);
  range.insertNode(chip);
  const sp = document.createTextNode(" ");
  chip.after(sp);
  const r2 = document.createRange();
  r2.setStart(sp, 1);
  r2.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(r2);
  markEdited();
  return { mode: "target", word: p.word, node: sp, start: 1, end: 1 };
}

/** short descriptions for the suggestion list */
const CMD_DESC: Record<string, string> = {
  document: "ask a library file (or all files)",
  ask: "notes + library + web, one cited answer",
  skill: "run a saved skill",
  research: "deep research — files + web",
  recall: "quiz yourself from your notes",
  tasks: "pull action items out of notes",
  related: "the notes closest to this one",
  loop: "iterative research with simulations",
  summary: "summarize this note",
  schedule: "recurring work while you sleep",
  terminal: "an AI terminal on this note — run commands",
  chat: "chat with the AI right on the note",
  sheet: "a spreadsheet on this note — Excel-style formulas",
  table: "a spreadsheet on this note — Excel-style formulas",
  slides: "a slide deck on this note — presentable, PowerPoint-style",
  deck: "a slide deck on this note — presentable, PowerPoint-style",
  powerpoint: "a slide deck on this note — presentable, PowerPoint-style",
  ppt: "a slide deck on this note — presentable, PowerPoint-style",
  todo: "a task list on this note — checkboxes, due dates, AI-managed",
};

/** commands + skills whose name starts with the typed partial */
async function prefixRowsFor(partial: string): Promise<CmdPickRow[]> {
  const p = partial.toLowerCase();
  const rows: CmdPickRow[] = CMD_WORDS.filter((w) => w.startsWith(p)).map((w) => ({
    label: w,
    desc: CMD_DESC[w] ?? "",
    kind: "cmd" as const,
  }));
  if (rows.length) {
    const skills = await invoke<SkillRow[]>("skills_list").catch(() => []);
    for (const s of skills) {
      if (s.name.toLowerCase().startsWith(p))
        rows.push({ label: s.name, desc: s.description || "saved skill", kind: "skill" });
    }
  }
  return rows;
}

/** rows the picker offers for a command word */
async function cmdRowsFor(word: CmdWord): Promise<CmdPickRow[]> {
  if (word === "skill") {
    const list = await invoke<SkillRow[]>("skills_list").catch(() => []);
    return list.map((s) => ({
      label: s.name,
      desc: s.description || "saved skill",
      arg: { slug: s.name, label: s.name },
    }));
  }
  if (word === "research")
    return [
      { label: "research", desc: "deep research — your files + the web — then type your topic" },
    ];
  if (word === "summary")
    return [{ label: "summary", desc: "summarize this note — optional instruction after" }];
  if (word === "related") return [{ label: "related", desc: "the notes closest to this one" }];
  if (word === "schedule")
    return [
      { label: "daily 08:00 brief", desc: "a morning brief, every day", template: "daily 08:00 brief" },
      { label: "every 6h summary", desc: "a summary every 6 hours", template: "every 6h summary" },
      { label: "mon-fri 09:00 tasks", desc: "weekday action items", template: "mon-fri 09:00 tasks" },
    ];
  // the browser picker — a url or a search phrase opens on the card
  if (word === "browser" || word === "browse")
    return [
      { label: "duckduckgo.com", desc: "a search page on the note", template: "duckduckgo.com" },
      { label: "wikipedia.org", desc: "an encyclopedia on the note", template: "wikipedia.org" },
      { label: "search…", desc: "type any phrase — it searches", template: "" },
    ];
  // the flashcards picker — a spaced-repetition deck
  if (word === "cards" || word === "flashcards" || word === "review")
    return [
      { label: "blank deck", desc: "add front :: back rows", template: "" },
      { label: "study deck", desc: "a starter set to review", template: "study" },
    ];
  // the mind-map picker — an outline that draws itself as a tree
  if (word === "map" || word === "mindmap" || word === "mind")
    return [
      { label: "blank map", desc: "＋ nodes grow the tree", template: "" },
      { label: "project plan", desc: "a starter outline", template: "project" },
    ];
  // the chart picker — a viz card; can bind live to a sheet range
  if (word === "chart")
    return [
      { label: "sales bar", desc: "a bar chart", template: "sales bar" },
      { label: "trend line", desc: "a line chart", template: "trend line" },
      { label: "budget pie", desc: "a pie chart", template: "budget pie" },
    ];
  // the todo picker — a named task list; dates parse inline (@tomorrow, +3d, fri)
  if (word === "todo")
    return [
      { label: "my day", desc: "today's tasks", template: "my day" },
      { label: "groceries", desc: "a shared list", template: "groceries" },
      { label: "this week", desc: "weekly plan", template: "this week" },
    ];
  // the deck picker — just a title; layouts live inside the card
  if (word === "slides" || word === "deck" || word === "powerpoint" || word === "ppt")
    return [
      { label: "new deck", desc: "title slide first — add more inside the card", template: "" },
      { label: "pitch deck", desc: "name it — the AI can outline the whole deck in chat", template: "pitch" },
      { label: "status update", desc: "name it — or let a chat write the slides", template: "status update" },
    ];
  // the sheet size picker — rows × columns at insert time; a name can follow
  if (word === "sheet" || word === "table")
    return [
      { label: "4 × 3", desc: "a small scratch sheet — add a name after", template: "4x3" },
      { label: "6 × 4", desc: "tracker-sized", template: "6x4" },
      { label: "8 × 5", desc: "budget-sized", template: "8x5" },
      { label: "10 × 6", desc: "a roomy sheet", template: "10x6" },
      { label: "12 × 8", desc: "ledger-sized", template: "12x8" },
      { label: "20 × 6", desc: "a long list", template: "20x6" },
    ];
  const files = await invoke<Array<{ slug: string; name: string; chunks: number }>>(
    "rag_list",
  ).catch(() => []);
  const rows: CmdPickRow[] = [];
  if (word === "loop") rows.push({ label: "stop", desc: "end the running loop early", template: "stop" });
  rows.push({
    label: "my-notes",
    desc: "your own notes — everything you wrote",
    arg: { slug: "my-notes", label: "my-notes" },
  });
  rows.push({
    label: "everything",
    desc: "library files + your notes",
    arg: { slug: "everything", label: "everything" },
  });
  rows.push({
    label: "all-files",
    desc: `every document · ${files.length} files`,
    arg: { slug: "all-files", label: "all-files" },
  });
  for (const f of files)
    rows.push({ label: f.name, desc: `${f.chunks} chunks`, arg: { slug: f.slug, label: f.name } });
  return rows;
}

async function renderCmdPick(filter: string) {
  const p = cmdPick;
  if (!p) return;
  if (p.mode === "prefix") {
    cmdRowsAll = await prefixRowsFor(filter);
    if (!cmdPick) return;
    cmdRows = cmdRowsAll;
  } else {
    if (cmdRowsWord !== p.word) {
      cmdRowsWord = p.word;
      cmdRowsAll = await cmdRowsFor(p.word as CmdWord);
      if (!cmdPick || cmdPick.word !== p.word) return;
    }
    const f = filter.trim().toLowerCase();
    cmdRows = cmdRowsAll.filter(
      (r) =>
        !f || r.label.toLowerCase().includes(f) || (r.arg?.slug ?? "").toLowerCase().includes(f),
    );
  }
  if (!cmdRows.length) {
    closeCmdPick();
    return;
  }
  cmdActive = Math.min(cmdActive, cmdRows.length - 1);
  const pop = mentionPop();
  pop.innerHTML = "";
  const lbl = document.createElement("div");
  lbl.className = "menu-label";
  lbl.textContent =
    p.mode === "prefix"
      ? "Commands & skills"
      : p.word === "skill"
        ? "Skills"
        : ["document", "ask", "recall", "tasks", "loop"].includes(p.word)
          ? "Targets"
          : "Commands";
  pop.append(lbl);
  cmdRows.forEach((r, i) => {
    const b = document.createElement("button");
    b.className = "skill-item" + (i === cmdActive ? " active" : "");
    const n = document.createElement("span");
    n.className = "skill-name";
    n.textContent = r.label;
    const d = document.createElement("span");
    d.className = "skill-desc";
    d.textContent = r.desc;
    b.append(n, d);
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => acceptCmdRow(r));
    pop.append(b);
  });
  pop.classList.remove("hidden");
  placeAtCaret(pop);
}

/** keep the open picker in step with the caret — filter by typed text, or
 *  close when the caret leaves the command's tail */
function refreshCmdPick() {
  if (!cmdPick) return;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return closeCmdPick();
  if (cmdPick.after) {
    // bare-chip target picker: close once the caret leaves the chip's row
    const anchor = sel.anchorNode;
    const hRow =
      anchor?.nodeType === Node.TEXT_NODE
        ? lineRow(anchor as Text)
        : anchor instanceof HTMLElement
          ? rowOf(anchor)
          : null;
    const cRow = rowOf(cmdPick.after as HTMLElement);
    if (!hRow || hRow !== cRow) return closeCmdPick();
    return;
  }
  if (cmdPick.mode === "prefix") {
    // still typing the word — rebuild the suggestion list from the live text.
    // typing can merge the word into a neighbouring text node (e.g. the
    // click-and-type nbsp pad), leaving the armed node stale — re-derive the
    // prefix from the live caret instead of closing on an identity mismatch
    if (sel.anchorNode !== cmdPick.node || sel.anchorOffset < cmdPick.start) {
      const re = currentCmdPrefix();
      if (re) {
        cmdPick = re;
        cmdActive = 0;
        void renderCmdPick(re.word);
        return;
      }
      return closeCmdPick();
    }
    const partial = (cmdPick.node.textContent ?? "").slice(cmdPick.start, sel.anchorOffset);
    if (!/^[a-z]+$/.test(partial)) return closeCmdPick();
    void renderCmdPick(partial);
    return;
  }
  if (sel.anchorNode !== cmdPick.node || sel.anchorOffset < cmdPick.end) return closeCmdPick();
  const typed = (cmdPick.node.textContent ?? "").slice(cmdPick.end, sel.anchorOffset);
  if (/[\n\r]/.test(typed)) return closeCmdPick();
  void renderCmdPick(typed);
}

/** accepting a row turns the typed word into a chip — the only way a no-@
 *  line can ever run; plain prose never executes */
function acceptCmdRow(row: CmdPickRow) {
  const p = cmdPick;
  if (!p) return;
  const sel = window.getSelection();
  const caret = sel?.anchorNode === p.node ? sel.anchorOffset : p.end;
  // a stale picker state must never insert — in prefix mode a row that
  // already carries a chip would duplicate it, so just close the list
  const line = lineRow(p.node);
  if (
    !p.node.isConnected ||
    (p.mode === "prefix" && line && line !== body() && line.querySelector(".cmd-chip"))
  ) {
    closeCmdPick();
    return;
  }
  if (p.mode === "prefix") {
    // completing a typed word: the partial becomes the chosen command chip
    const cur = (p.node.textContent ?? "").slice(p.start, Math.max(p.end, caret));
    if (!/^[a-z]+$/.test(cur)) {
      closeCmdPick();
      return;
    }
    const range = document.createRange();
    // a typed @ before the word is consumed with it — "@ask" arms one chip
    const s0 = p.start > 0 && (p.node.textContent ?? "")[p.start - 1] === "@" ? p.start - 1 : p.start;
    range.setStart(p.node, s0);
    range.setEnd(p.node, Math.max(p.end, caret));
    range.deleteContents();
    if (row.kind === "skill") {
      const chip = makeCmdChip("skill");
      range.insertNode(chip);
      const sp = document.createTextNode(" ");
      const arg = makeArgChip(row.label, row.label);
      const tail = document.createTextNode(" ");
      chip.after(sp, arg, tail);
      const r2 = document.createRange();
      r2.setStart(tail, 1);
      r2.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(r2);
      closeCmdPick();
    } else {
      const chip = makeCmdChip(row.label);
      range.insertNode(chip);
      const sp = document.createTextNode(" ");
      chip.after(sp);
      const r2 = document.createRange();
      r2.setStart(sp, 1);
      r2.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(r2);
      // target-taking commands flow straight into their target list
      if (["document", "ask", "skill", "loop", "recall", "tasks"].includes(row.label)) {
        cmdPick = { mode: "target", word: row.label, node: sp, start: 1, end: 1 };
        cmdRowsWord = null;
        cmdActive = 0;
        void renderCmdPick("");
      } else {
        closeCmdPick();
      }
    }
    markEdited();
    return;
  }
  const frag = document.createDocumentFragment();
  frag.append(document.createTextNode(" "));
  if (row.arg) frag.append(makeArgChip(row.arg.slug, row.arg.label), document.createTextNode(" "));
  else if (row.template) frag.append(document.createTextNode(`${row.template} `));
  // the caret lands after the fragment's trailing space so typed text keeps
  // its gap from the chip
  const last = frag.lastChild as Node;
  if (p.after) {
    p.after.after(frag);
  } else {
    const range = document.createRange();
    range.setStart(p.node, p.start);
    range.setEnd(p.node, Math.max(p.end, caret));
    range.deleteContents();
    // the armed flow already carries its command chip — only the target or
    // template fragment is missing; the mid-line flow still needs the chip
    const existing =
      line && line !== body() ? line.querySelector<HTMLElement>(".cmd-chip[data-cmd]") : null;
    const chip = existing ?? makeCmdChip(p.word);
    if (!existing) range.insertNode(chip);
    chip.after(frag);
  }
  const r2 = document.createRange();
  r2.setStartAfter(last);
  r2.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(r2);
  closeCmdPick();
  markEdited();
}

/** keyboard for the open picker — Tab moves the highlight, Enter or a click
 *  accepts (returns true when the key was eaten) */
function cmdPickKey(e: KeyboardEvent): boolean {
  if (!cmdPick) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (cmdRows.length) cmdActive = (cmdActive + 1) % cmdRows.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (cmdRows.length) cmdActive = (cmdActive - 1 + cmdRows.length) % cmdRows.length;
  } else if (e.key === "Tab") {
    e.preventDefault();
    if (cmdRows.length)
      cmdActive = (cmdActive + (e.shiftKey ? -1 : 1) + cmdRows.length) % cmdRows.length;
  } else if (e.key === " " && cmdPick.mode === "prefix") {
    // space completes the highlighted suggestion (shell-style)
    const r = cmdRows[cmdActive];
    if (!r) return false; // rows still loading — let the space type through
    e.preventDefault();
    acceptCmdRow(r);
    return true;
  } else if (e.key === "Enter") {
    const r = cmdRows[cmdActive];
    if (!r) return false; // rows still loading — plain newline instead
    e.preventDefault();
    acceptCmdRow(r);
    return true;
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCmdPick();
    return true;
  } else {
    return false;
  }
  mentionPop()
    .querySelectorAll(".skill-item")
    .forEach((b, i) => b.classList.toggle("active", i === cmdActive));
  return true;
}

/** Enter on a bare command chip reopens the picker for its target list */
function openCmdPickFromChip(block: HTMLElement, word?: CmdWord) {
  const chip = block.querySelector<HTMLElement>(".cmd-chip[data-cmd]");
  if (!chip) return;
  const w = (word ?? chip.dataset.cmd) as CmdWord;
  if (!(CMD_WORDS as readonly string[]).includes(w)) return;
  let t = chip.nextSibling;
  if (!(t instanceof Text)) {
    t = document.createTextNode(" ");
    chip.after(t);
  }
  const r = document.createRange();
  r.setStart(t, Math.min(1, (t as Text).length));
  r.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  cmdPick = { mode: "target", word: w, node: t as Text, start: 0, end: 0, after: chip };
  cmdRowsWord = null;
  cmdActive = 0;
  void renderCmdPick("");
}

/* ---------- `[[` wikilink autocomplete — Obsidian's link suggester ----
 * Typing `[[` inside note text opens the shared popover with vault
 * stems; `[[#` lists the open note's headings, `[[stem#` lists that
 * note's. Enter accepts → a real `.wikilink` span (serializes back to
 * `[[note]]`), Esc dismisses. */

let wikiPick: { node: Text; start: number; embed: boolean } | null = null;
let wikiRows: { note: string; label: string; sub?: string; kind?: string }[] = [];
let wikiActive = 0;
/** `attachments/…` paths — fetched once, the `![[` suggester's image pool */
let assetFiles: string[] | null = null;
function ensureAssetList() {
  if (assetFiles !== null) return;
  assetFiles = [];
  void invoke<string[]>("asset_list")
    .then((l) => {
      assetFiles = l;
      const ctx = wikiCtx();
      if (wikiPick && ctx?.embed) renderWikiPick(ctx.q, true);
    })
    .catch(() => {});
}

function closeWikiPick() {
  wikiPick = null;
  if (!cmdPick) mentionPop().classList.add("hidden");
}

/** the `[[…` / `![[…` context at the caret, or null. `embed` is armed only
 *  when the `![[` opens a bare paragraph — embeds are whole-block grammar. */
function wikiCtx(): { node: Text; start: number; q: string; embed: boolean } | null {
  const sel = window.getSelection();
  if (!sel?.isCollapsed || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!(node instanceof Text)) return null;
  const host = node.parentElement;
  if (!host?.closest("#note-body") || host.closest(".callout, code, .cmd-chip")) return null;
  const m = matchWikiCtx(node.data.slice(0, sel.anchorOffset));
  if (!m) return null;
  let embed = false;
  if (m.embed) {
    const block = host?.closest("p");
    const tail = node.data.slice(sel.anchorOffset);
    embed =
      !!block &&
      block.childNodes.length === 1 &&
      block.firstChild === node &&
      m.start === 0 &&
      (tail === "" || tail === "]]");
  }
  // a `![[` that can't become a block embed falls back to a plain link
  // pick — `start` must then point at the `[[`, not the `!`
  return { node, start: m.embed && !embed ? m.start + 1 : m.start, q: m.q, embed };
}

function renderWikiPick(q: string, embed = false) {
  const ix = vaultIndex();
  if (!ix) { closeWikiPick(); return; }
  const cur = current;
  wikiRows = [];
  const headMatch = splitWikiQuery(q);
  if (embed) {
    // `![[` embed mode — images from attachments/ + whole/section note
    // embeds. `![[#h` (current-note heading) isn't in the render grammar.
    ensureAssetList();
    if (headMatch) {
      const target = headMatch.stem.toLowerCase();
      const hq = headMatch.head;
      const owner = target
        ? ix.notes.find((n) => stem(n).toLowerCase() === target)
        : null;
      if (owner) {
        wikiRows = (ix.heads ?? [])
          .filter(([n]) => n === owner)
          .map(([, h]) => ({ note: `${stem(owner)}#${h}`, label: h, sub: `${stem(owner)} · embed`, kind: "embed" }))
          .filter((r) => !hq.trim() || r.label.toLowerCase().includes(hq.trim().toLowerCase()));
      }
    } else {
      const f = q.split("|")[0].trim().toLowerCase();
      const imgs = (assetFiles ?? [])
        .filter((p) => !f || p.toLowerCase().includes(f))
        .map((p) => ({
          note: p,
          label: `🖼 ${p.split("/").pop() ?? p}`,
          sub: "image",
          kind: "img",
        }));
      const notes = ix.notes
        .filter((n) => n !== cur)
        .map((n) => ({ note: stem(n), label: stem(n), sub: "note embed", kind: "embed" }))
        .filter((r) => !f || r.label.toLowerCase().includes(f));
      wikiRows = [...imgs, ...notes].slice(0, 12);
    }
  } else if (headMatch) {
    // `[[#x` → this note's headings; `[[stem#x` → that note's
    const target = headMatch.stem.toLowerCase();
    const hq = headMatch.head;
    const owner = !target
      ? cur
      : ix.notes.find((n) => stem(n).toLowerCase() === target);
    if (owner) {
      wikiRows = (ix.heads ?? [])
        .filter(([n]) => n === owner)
        .map(([, h]) => ({ note: `${stem(owner)}#${h}`, label: h, sub: stem(owner) }))
        .filter((r) => !hq.trim() || r.label.toLowerCase().includes(hq.trim().toLowerCase()));
    }
  } else {
    const f = q.split("|")[0].trim().toLowerCase(); // ignore a `|alias` tail
    wikiRows = ix.notes
      .filter((n) => n !== cur)
      .map((n) => ({ note: stem(n), label: stem(n) }))
      .filter((r) => !f || r.label.toLowerCase().includes(f))
      .slice(0, 12);
    // a query that matches nothing offers to create the note
    if (!wikiRows.length && f.length >= 2)
      wikiRows = [{ note: f, label: `create “${q.split("|")[0].trim()}”`, sub: "new note" }];
  }
  if (!wikiRows.length) { closeWikiPick(); return; }
  wikiActive = Math.min(wikiActive, wikiRows.length - 1);
  const pop = mentionPop();
  pop.innerHTML = `<div class="menu-label">${embed ? "Embed…" : "Link to…"}</div>`;
  wikiRows.forEach((r, i) => {
    const b = document.createElement("button");
    b.className = "skill-item" + (i === wikiActive ? " active" : "");
    b.innerHTML = `<span class="skill-name"></span>` + (r.sub ? `<span class="skill-desc"></span>` : "");
    b.querySelector(".skill-name")!.textContent = r.label;
    if (r.sub) b.querySelector(".skill-desc")!.textContent = r.sub;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.addEventListener("click", () => acceptWikiRow(r));
    pop.append(b);
  });
  pop.classList.remove("hidden");
  placeAtCaret(pop);
}

/** replace `[[query` / `![[query` → caret with the real link/embed DOM */
function acceptWikiRow(r: { note: string; label: string; kind?: string }) {
  const ctx = wikiCtx();
  if (!ctx || !wikiPick || ctx.start !== wikiPick.start) { closeWikiPick(); return; }
  const { node, start } = ctx;
  // embed acceptance replaces the whole `![[query` paragraph with the
  // embed block (img or note-embed) — the grammar is block-level
  if (wikiPick.embed) {
    const block = node.parentElement?.closest("p");
    if (!block) { closeWikiPick(); return; }
    let el: HTMLElement;
    if (r.kind === "img") {
      const img = document.createElement("img");
      img.className = "note-img";
      img.dataset.asset = r.note;
      img.dataset.wiki = "1";
      const dims = ctx.q.split("|")[1]?.trim().match(/^(\d+)(?:x(\d+))?$/);
      if (dims) {
        img.setAttribute("width", dims[1]);
        if (dims[2]) img.setAttribute("height", dims[2]);
      }
      el = img;
      block.replaceWith(el);
      hydrateAssets(body());
    } else {
      const [src, head] = r.note.split("#");
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const div = document.createElement("div");
      div.className = "callout note-embed";
      div.dataset.kind = "embed";
      div.dataset.src = src;
      if (head) div.dataset.head = head;
      div.dataset.md = `![[${src}${head ? `#${head}` : ""}]]`;
      div.innerHTML =
        `<div class="callout-head"><span class="callout-title">📄 ${esc(src)}` +
        (head ? ` <span class="ne-sec">#${esc(head)}</span>` : "") +
        `</span><button class="ne-open" title="open note" contenteditable="false">↗</button></div>` +
        `<div class="ne-body" contenteditable="false"><span class="ne-load">…</span></div>`;
      el = div;
      block.replaceWith(el);
      void hydrateEmbeds(body());
    }
    const blank = document.createElement("p");
    blank.textContent = "​";
    el.after(blank);
    const cr = document.createRange();
    cr.setStart(blank, 0);
    cr.collapse(true);
    const sel2 = window.getSelection();
    sel2?.removeAllRanges();
    sel2?.addRange(cr);
    closeWikiPick();
    markEdited();
    return;
  }
  // absorb a just-typed `]]` so we never leave `[[x]]]]` behind
  let end = window.getSelection()?.anchorOffset ?? start;
  if (node.data.slice(end, end + 2) === "]]") end += 2;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  range.deleteContents();
  const a = document.createElement("a");
  a.className = "wikilink";
  a.dataset.note = r.note;
  a.textContent = r.note.includes("#") ? r.note.split("#")[1] : r.note;
  const spacer = document.createTextNode(" ");
  range.insertNode(spacer);
  range.insertNode(a);
  const sel = window.getSelection();
  const cr = document.createRange();
  cr.setStart(spacer, 1);
  cr.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(cr);
  closeWikiPick();
  markEdited();
}

function wikiPickKey(e: KeyboardEvent): boolean {
  if (!wikiPick) return false;
  if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
    e.preventDefault();
    wikiActive = (wikiActive + 1) % wikiRows.length;
  } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
    e.preventDefault();
    wikiActive = (wikiActive - 1 + wikiRows.length) % wikiRows.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const r = wikiRows[wikiActive];
    if (r) acceptWikiRow(r);
    return true;
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeWikiPick();
    return true;
  } else {
    return false;
  }
  mentionPop().querySelectorAll(".skill-item").forEach((b, i) =>
    b.classList.toggle("active", i === wikiActive));
  return true;
}

/** called on each note-body input — arms/refreshes/closes the `[[` pick */
function refreshWikiPick(typed: boolean) {
  const ctx = wikiCtx();
  if (!ctx) {
    if (wikiPick) closeWikiPick();
    return;
  }
  // `]]` ahead of the caret means the link is complete already
  const trig = ctx.embed ? "![[" : "[[";
  if (ctx.node.data.slice(ctx.start, ctx.start + trig.length) === trig) {
    const closed = ctx.node.data.slice(ctx.start + trig.length).startsWith("]]") &&
      ctx.q.length === 0;
    if (closed) { closeWikiPick(); return; }
  }
  if (!wikiPick || wikiPick.node !== ctx.node || wikiPick.start !== ctx.start) {
    if (!typed) return; // only manual typing arms it
    wikiPick = { node: ctx.node, start: ctx.start, embed: ctx.embed };
    wikiActive = 0;
  }
  renderWikiPick(ctx.q, wikiPick.embed);
}

/** spawn the AI terminal widget — a draggable, resizable card whose session
 *  lives in the note like written text. Command-spawned chats number 1, 2, 3…;
 *  a delegated child numbers under its parent (1.1, 1.2…). Returns the card. */
let termSeq = 0;

/** the next child id of a chat — "1" yields 1.1, 1.2…; "1.1" yields 1.1.1 */
function nextChatId(parent: string): string {
  const re = new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
  let max = 0;
  document.querySelectorAll<HTMLElement>(".term-card").forEach((c) => {
    const m = (c.dataset.chatId ?? "").match(re);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return `${parent}.${max + 1}`;
}

export function spawnTerminalCard(
  kind: string,
  seed?: string,
  block?: HTMLElement,
  parentChatId?: string,
  persona?: string,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "callout term-card";
  card.dataset.kind = "terminal";
  card.dataset.topic = kind === "chat" ? "chat" : "terminal";
  if (persona) card.dataset.persona = persona;
  const chatId = parentChatId ? nextChatId(parentChatId) : String(++termSeq);
  card.dataset.chatId = chatId;
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${card.dataset.topic} ${chatId}${persona ? ` · ${persona}` : ""}</span></div>` +
    `<div class="term-log"></div>` +
    `<div class="term-input-row"><span class="term-prompt">›</span><textarea class="term-input" rows="1" placeholder="ask anything — or ! command" spellcheck="false" autocomplete="off"></textarea></div>`;
  enhanceCard(card);
  const log = card.querySelector<HTMLElement>(".term-log");
  if (log) log.contentEditable = "false";
  wireTerminal(card);
  // the command line was only the trigger — strip it once the widget exists
  if (block) {
    const left = stripCommandText(block).replace(/[\u200b\ufeff]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  // a fresh widget lands centered in the user's current view, floating
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  const input = card.querySelector<HTMLTextAreaElement>(".term-input");
  if (seed && input) {
    input.value = seed;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  } else if (block) {
    // only a user-typed command line earns autofocus — AI-spawned children
    // (spawn fence) and reloads must not yank the caret out of the note
    input?.focus();
  }
  return card;
}

/** spawn a sheet widget — a spreadsheet card living on the note. `rows`/`cols`
 *  come from the size picker (or the typed `RxC`); the title is the line's
 *  remaining text. Floating placement mirrors the chat widget. */
export function spawnSheetCard(
  title: string,
  rows: number,
  cols: number,
  block?: HTMLElement,
): HTMLElement {
  const card = buildSheetCard(title);
  // wire at the picked size BEFORE enhanceCard — its sheet branch calls
  // wireSheet too, and wiring is a one-time guard
  wireSheet(card, { rows, cols });
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[\u200b\ufeff]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  card.querySelector<HTMLElement>("td[data-raw]")?.focus();
  return card;
}

/** spawn a deck card — title slide first; `slides pitch deck` names it */
export function spawnDeckCard(title: string, block?: HTMLElement): HTMLElement {
  const card = buildDeckCard(title);
  wireDeck(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  card.querySelector<HTMLElement>(".d-title")?.focus();
  return card;
}

/** duplicate a deck: every slide copies across; wireDeck re-wires the clone */
function duplicateDeckCard(card: HTMLElement) {
  const clone = card.cloneNode(true) as HTMLElement;
  delete clone.dataset.cid;
  delete clone.dataset.wired;
  delete clone.dataset.enhanced;
  delete clone.dataset.deckWired;
  clone.classList.remove("pinned", "viewport-pin", "floating", "sized");
  clone
    .querySelectorAll(
      ".card-tools, .card-del, .card-pin, .card-tts, .card-stick, .card-dup, .card-floatpin, .deck-bar",
    )
    .forEach((b) => b.remove());
  clone.querySelectorAll<HTMLElement>("[data-wired]").forEach((el) => delete el.dataset.wired);
  enhanceCard(clone);
  const root = body();
  root.append(clone);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  clone.classList.add("floating", "sized");
  clone.style.margin = "0";
  clone.style.left = `${Math.min(card.offsetLeft + 24, Math.max(8, vw - clone.offsetWidth - 8))}px`;
  clone.style.top = `${Math.min(card.offsetTop + 24, Math.max(8, vh - clone.offsetHeight - 8))}px`;
  clone.style.zIndex = String(nextZ());
  writeState(clone, { x: clone.offsetLeft, y: clone.offsetTop, pinned: 0, z: genZ });
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  addActivity(`⧉ duplicated deck: ${card.dataset.topic ?? "deck"}`);
}

/** spawn a todo card — `todo` on a blank line; the rest is the list's name */
export function spawnTodoCard(title: string, block?: HTMLElement): HTMLElement {
  const card = buildTodoCard(title);
  wireTodo(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  card.querySelector<HTMLElement>(".todo-in")?.focus();
  return card;
}

/** spawn a chart card — `@chart <title>`; "type" word in title selects viz */
export function spawnChartCard(title: string, block?: HTMLElement): HTMLElement {
  const m = title.match(/^(.*?)\s*(bar|barh|line|area|pie|doughnut|scatter|stacked)$/i);
  const t = m ? m[1].trim() : title;
  const card = buildChartCard(t || "chart");
  if (m) card.dataset.ctype = m[2].toLowerCase();
  wireChart(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  card.style.left = Math.max(8, Math.round(vw * 0.32)) + "px";
  card.style.top = Math.max(8, Math.round(vh * 0.12)) + "px";
  card.style.width = "560px";
  dirty = true;
  void save();
  return card;
}

/** spawn a browser card — `browser <url>` navigates on spawn */
export function spawnCardsCard(title: string, block?: HTMLElement, cards?: { front: string; back: string }[]): HTMLElement {
  const card = buildCardsCard(title, cards ?? []);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}

const PROJECT_TREE = [
  { text: "project", kids: [
    { text: "goals", kids: [{ text: "outcome", kids: [] }] },
    { text: "plan", kids: [{ text: "phase 1", kids: [] }, { text: "phase 2", kids: [] }] },
    { text: "risks", kids: [] },
  ] },
];
export function spawnMapCard(title: string, block?: HTMLElement, seed?: typeof PROJECT_TREE): HTMLElement {
  const card = buildMapCard(title);
  if (seed) wireMap(card, seed); // pre-wire with the starter tree; enhanceCard's wireMap then no-ops
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}

export function spawnAgendaCard(title: string, block?: HTMLElement): HTMLElement {
  const card = buildAgendaCard(title);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}

export function spawnGraphCard(title: string, block?: HTMLElement): HTMLElement {
  const card = buildGraphCard(title);
  wireGraph(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}


export function spawnCanvasCard(title: string, block?: HTMLElement): HTMLElement {
  const card = buildCanvasCard(title);
  wireCanvas(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}

export function spawnBaseCard(title: string, block?: HTMLElement, q = ""): HTMLElement {
  const card = buildBaseCard(title);
  card.dataset.q = q;
  wireBase(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating");
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.margin = "0";
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  return card;
}

/** `> properties` — prepend an empty frontmatter panel (serializes back
 *  to a `---`/`---` block once rows exist) */
function insertPropsPanel() {
  const b = body();
  if (b.querySelector(".fm-props")) return;
  const div = document.createElement("div");
  div.className = "fm-props";
  div.contentEditable = "false";
  div.innerHTML =
    `<div class="fm-title">properties</div>` +
    `<div class="fm-row"><input class="fm-k" spellcheck="false" placeholder="key"/>` +
    `<input class="fm-v" spellcheck="false" placeholder="value"/>` +
    `<button class="fm-x" title="remove property" tabindex="-1">✕</button></div>` +
    `<button class="fm-add" title="add property">＋ property</button>`;
  b.prepend(div);
  markEdited();
  div.querySelector<HTMLInputElement>(".fm-k")?.focus();
}

export function spawnBrowserCard(title: string, url: string, block?: HTMLElement): HTMLElement {
  const card = buildBrowserCard(title, url);
  wireBrowser(card);
  enhanceCard(card);
  if (block) {
    const left = stripCommandText(block).replace(/[​﻿]/g, "").trim();
    if (!left) block.remove();
  }
  const root = body();
  root.append(card);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const x = Math.round(
    Math.max(root.scrollLeft + 8, Math.min(root.scrollLeft + (vw - cw) / 2, root.scrollLeft + vw - cw - 8)),
  );
  const y = Math.round(
    Math.max(root.scrollTop + 8, Math.min(root.scrollTop + (vh - ch) / 2, root.scrollTop + vh - ch - 8)),
  );
  card.classList.add("floating", "sized");
  card.style.margin = "0";
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.zIndex = String(nextZ());
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  card.querySelector<HTMLElement>(".bb-url")?.focus();
  return card;
}

/** duplicate a todo card: every task copies across; wireTodo re-wires */
function duplicateTodoCard(card: HTMLElement) {
  const clone = card.cloneNode(true) as HTMLElement;
  delete clone.dataset.cid;
  delete clone.dataset.wired;
  delete clone.dataset.enhanced;
  delete clone.dataset.todoWired;
  clone.classList.remove("pinned", "viewport-pin", "floating", "sized");
  clone
    .querySelectorAll(
      ".card-tools, .card-del, .card-pin, .card-tts, .card-stick, .card-dup, .card-floatpin",
    )
    .forEach((b) => b.remove());
  clone.querySelectorAll<HTMLElement>("[data-wired]").forEach((el) => delete el.dataset.wired);
  enhanceCard(clone);
  const root = body();
  root.append(clone);
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  clone.classList.add("floating", "sized");
  clone.style.margin = "0";
  clone.style.left = `${Math.min(card.offsetLeft + 24, Math.max(8, vw - clone.offsetWidth - 8))}px`;
  clone.style.top = `${Math.min(card.offsetTop + 24, Math.max(8, vh - clone.offsetHeight - 8))}px`;
  clone.style.zIndex = String(nextZ());
  writeState(clone, { x: clone.offsetLeft, y: clone.offsetTop, pinned: 0, z: genZ });
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  void save();
  addActivity(`⧉ duplicated todo: ${card.dataset.topic ?? "todo"}`);
}

/** duplicate a sheet: every cell (formulas included) copies across — the
 *  clone's static tds get re-upgraded by wireSheet */
function duplicateSheetCard(card: HTMLElement) {
  const clone = card.cloneNode(true) as HTMLElement;
  delete clone.dataset.cid;
  delete clone.dataset.wired;
  delete clone.dataset.enhanced;
  delete clone.dataset.sheetWired;
  clone.classList.remove("pinned", "viewport-pin", "floating", "sized");
  clone
    .querySelectorAll(
      ".card-tools, .card-del, .card-pin, .card-tts, .card-stick, .card-dup, .card-floatpin, .sheet-addcol, .sheet-addrow",
    )
    .forEach((b) => b.remove());
  clone.querySelectorAll<HTMLElement>("[data-wired]").forEach((el) => delete el.dataset.wired);
  enhanceCard(clone);
  const root = body();
  root.append(clone);
  const x = (parseFloat(card.style.left) || 0) + 28;
  const y = (parseFloat(card.style.top) || 0) + 28;
  clone.classList.add("floating", "sized");
  clone.style.margin = "0";
  clone.style.left = `${x}px`;
  clone.style.top = `${y}px`;
  clone.style.zIndex = String(nextZ());
  writeState(clone, { x, y, pinned: 0, z: genZ });
  avoidOverlap(clone);
  scheduleFlow();
  scheduleCardLinks();
  markEdited();
}

/** the chat widget's floating pin: viewport-fixed while pinned — the user
 *  can scroll anywhere on the sheet and the chat stays right where they put
 *  it on screen; unpinning returns it to the sheet at the same spot */
function toggleFloatPin(card: HTMLElement) {
  const root = body();
  const r = card.getBoundingClientRect();
  if (card.classList.contains("viewport-pin")) {
    // back to the sheet — screen coords → paper coords (zoom-aware)
    const rr = root.getBoundingClientRect();
    const z = Z();
    const x = Math.round((r.left - rr.left) / z + root.scrollLeft);
    const y = Math.round((r.top - rr.top) / z + root.scrollTop);
    card.classList.remove("viewport-pin");
    card.classList.add("floating", "sized");
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    writeState(card, { x, y, pinned: 0, fixed: 0 });
    addActivity("📌 floating pin off — the chat is back on the sheet");
  } else {
    card.classList.add("viewport-pin");
    card.classList.remove("pinned");
    card.style.margin = "0";
    // CSS zoom scales fixed descendants' coordinates — divide the screen
    // position by the paper zoom so the card stays exactly where it was
    const z = Z();
    card.style.left = `${Math.round(r.left / z)}px`;
    card.style.top = `${Math.round(r.top / z)}px`;
    writeState(card, { fixed: 1, x: Math.round(r.left / z), y: Math.round(r.top / z), pinned: 0 });
    addActivity("📌 floating pin on — the chat stays on screen while you scroll");
  }
  markEdited();
}

/** duplicate a terminal widget: a brand-new EMPTY chat — every widget is its
 *  own separate conversation; the AI can still see the other chats' threads
 *  in its context when they matter */
function duplicateTerminalCard(card: HTMLElement) {
  const clone = card.cloneNode(true) as HTMLElement;
  delete clone.dataset.cid;
  delete clone.dataset.wired;
  delete clone.dataset.enhanced;
  clone.classList.remove("pinned");
  // a fresh conversation: no copied log, no stale UI, no dead buttons
  clone.querySelectorAll(".term-line").forEach((l) => l.remove());
  clone
    .querySelectorAll(".card-tools, .card-del, .card-pin, .card-tts, .card-stick, .card-dup, .card-floatpin")
    .forEach((b) => b.remove());
  // numbered like the family tree: chat 1 duplicates to 1.1, 1.2…; a new
  // chat from the command is 2, and its first duplicate is 2.1
  const parentId = card.dataset.chatId ?? "1";
  const childId = nextChatId(parentId);
  clone.dataset.chatId = childId;
  const title = clone.querySelector(".callout-title");
  if (title) title.textContent = `${clone.dataset.topic ?? "chat"} ${childId}`;
  const input = clone.querySelector<HTMLTextAreaElement>(".term-input");
  if (input) input.value = "";
  enhanceCard(clone);
  const lg = clone.querySelector<HTMLElement>(".term-log");
  if (lg) lg.contentEditable = "false";
  const root = body();
  root.append(clone);
  const x = (parseFloat(card.style.left) || 0) + 28;
  const y = (parseFloat(card.style.top) || 0) + 28;
  clone.classList.add("floating", "sized");
  clone.style.margin = "0";
  clone.style.left = `${x}px`;
  clone.style.top = `${y}px`;
  clone.style.zIndex = String(nextZ());
  writeState(clone, { x, y, pinned: 0, z: genZ });
  avoidOverlap(clone);
  scheduleFlow();
  scheduleCardLinks();
  dirty = true;
  setState(t("ed.saving"));
  void save();
  clone.querySelector<HTMLTextAreaElement>(".term-input")?.focus();
}

/** resolve "@document/@ask <file?> <question>" — the file token is optional;
 *  @ask (hybrid) defaults to everything (library + notes), @document to the
 *  library alone */
async function resolveAskTarget(
  rest: string,
  hybrid = false,
): Promise<{ target: string; query: string }> {
  const files = await invoke<Array<{ slug: string }>>("rag_list").catch(() => []);
  const m = rest.match(/^@?([\w-]+)\s+(.+)$/);
  const pseudo = ["all-files", "my-notes", "everything"];
  if (m && (pseudo.includes(m[1]) || files.some((f) => f.slug === m[1]))) {
    return { target: m[1], query: m[2] };
  }
  return { target: hybrid ? "everything" : "all-files", query: rest };
}

export function appendToNote(node: HTMLElement) {
  body().append(node);
  markEdited();
}

export function saveNow() {
  dirty = true;
  void save();
}

function beginTitleEdit(mode: "rename" | "saveas") {
  const title = $("#note-title");
  if (!current || title.querySelector("input")) return;
  const old = current;
  const input = document.createElement("input");
  input.className = "title-edit";
  input.value = old.replace(/\.(laido|md)$/, "");
  input.spellcheck = false;
  title.textContent = "";
  title.append(input);
  input.focus();
  input.select();
  let done = false;
  const restore = () => {
    $("#note-title").textContent = titleName(old);
  };
  const commit = async () => {
    if (done) return;
    done = true;
    const raw = input.value.trim();
    input.remove();
    if (!raw) {
      restore();
      return;
    }
    try {
      if (mode === "rename") {
        const next = await invoke<string>("vault_rename", { old, next: raw });
        current = next;
        $("#note-title").textContent = titleName(next);
        onRenamedCb?.(old, next);
        // the vault-side rewrite fixed every [[old]] on disk — do the same
        // in the live DOM so open links/embeds don't point at the dead name
        const oStem = old.replace(/\.(laido|md)$/, "");
        const nStem = next.replace(/\.(laido|md)$/, "");
        const retarget = (tgt: string): string => {
          const h = tgt.indexOf("#");
          const tg = h < 0 ? tgt : tgt.slice(0, h);
          const frag = h < 0 ? "" : tgt.slice(h); // includes the '#'
          const named = tg === old || (!/\.(laido|md)$/.test(tg) && tg === oStem);
          if (!named) return tgt;
          const nt = /\.(laido|md)$/.test(tg) ? next : nStem;
          return nt + frag;
        };
        body().querySelectorAll<HTMLElement>(".wikilink[data-note]").forEach((w) => {
          const prev = w.dataset.note ?? "";
          const tgt = retarget(prev);
          if (tgt !== prev) {
            w.dataset.note = tgt;
            // bare [[old]] labels show the target — aliased labels keep theirs
            if (w.textContent === prev || w.textContent === prev.split("#", 1)[0]) {
              w.textContent = tgt.split("#", 1)[0];
            }
          }
        });
        body().querySelectorAll<HTMLElement>(".note-embed[data-src]").forEach((em) => {
          const tgt = retarget(em.dataset.src ?? "");
          if (tgt !== em.dataset.src) em.dataset.src = tgt;
        });
        // inbound [[links]] were rewritten vault-side — the index is stale
        void refreshIndex(true).then(paintLinkStrip);
      } else {
        const next = /\.(laido|md)$/.test(raw) ? raw : `${raw}.laido`;
        await invoke("vault_write", { name: next, content: serialize(body()) });
        $("#note-title").textContent = titleName(old);
        onSaveAsCb?.(next);
      }
    } catch (e) {
      addActivity(`✕ ${String(e)}`);
      restore();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
    if (e.key === "Escape") {
      done = true;
      input.remove();
      restore();
    }
  });
  input.addEventListener("blur", () => void commit());
}

export function startRename() {
  beginTitleEdit("rename");
}

export function startSaveAs() {
  beginTitleEdit("saveas");
}

export function printNote() {
  const el = body().cloneNode(true) as HTMLElement;
  el.querySelectorAll(
    ".grip, .pin-mark, .card-tools, .card-del, .card-menu, .card-move, .card-pin, .card-stick, .card-tts, .card-dup, .card-floatpin, .sheet-view, .deck-bar, .cv-tools, .base-tools, .map-root-add, .ag-refresh, .ag-speak, .term-model-select",
  ).forEach((n) => n.remove());
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 15px/1.6 Georgia, serif; color: #222; margin: 24px; }
    p { margin: 0 0 10px; }
    .callout { border-left: 3px solid #a05a2c; background: #f7efe0; border-radius: 8px; padding: 10px 14px; margin: 12px 0; }
    .callout-title { font-weight: 600; color: #a05a2c; margin-bottom: 6px; }
    .src { display: inline-block; margin: 2px 8px 2px 0; font-size: 12px; color: #555; }
    .fav { display: none; }
    mark { background: #ffe58a; }
    a { color: #a05a2c; }
  </style></head><body>${el.innerHTML}</body></html>`;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.append(frame);
  const fdoc = frame.contentDocument;
  if (!fdoc) return;
  fdoc.open();
  fdoc.write(doc);
  fdoc.close();
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  window.setTimeout(() => frame.remove(), 1500);
}

async function openStickyWindow(id: string, x?: number, y?: number): Promise<boolean> {
  const api = window.__TAURI__.webviewWindow;
  const label = `sticky-${id}`;
  try {
    const existing = await api?.WebviewWindow?.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return false;
    }
  } catch {
    /* older runtime: fall through and try to create */
  }
  /* Rust-side pop_window: the shared WebView2 env rejects JS-built
   * windows (env options mismatch). build() returning only means an
   * HWND exists — the card is removed only when the sticky window
   * emits pop:ready from its own booted init. The listener registers
   * BEFORE the spawn — the emit lands at the top of the child's init
   * and a late listener misses it */
  const ready = new Promise<boolean>((resolve) => {
    let un: (() => void) | undefined;
    const done = (ok: boolean) => {
      un?.();
      resolve(ok);
    };
    void window.__TAURI__.event
      .listen<string>("pop:ready", (e) => {
        if (e.payload === label) done(true);
      })
      .then((u) => (un = u));
    /* pop_window retries a dead attach up to 3 times + destroy-gap
     * waits — ~40s worst */
    setTimeout(() => done(false), 45000);
  });
  try {
    await invoke("pop_window", {
      label,
      url: "index.html",
      /* __POP_TOKEN__: pop_window can retry under a fresh label — the
       * ready match must track the token, not the window label */
      init: `window.__POP_STICKY__=${JSON.stringify(`~${id}`)};window.__POP_TOKEN__=${JSON.stringify(label)}`,
      x: x ?? 0,
      y: y ?? 0,
      w: 270,
      h: 250,
      centered: x === undefined || y === undefined,
      onTop: true,
      title: "Laido sticky",
    });
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
    return false;
  }
  const ok = await ready;
  if (!ok) {
    addActivity(`✕ the sticky window didn't finish loading`);
    try {
      const w = await window.__TAURI__.webviewWindow?.WebviewWindow.getByLabel(label);
      void w?.close();
    } catch {
      /* already gone */
    }
  }
  return ok;
}

export function popOutSticky(card: HTMLElement, x?: number, y?: number) {
  const id = card.dataset.topic ?? "";
  if (!id) return;
  const md = cardToMd(card);
  const title = (card.dataset.title ?? card.querySelector(".sticky-title")?.textContent ?? "").trim();
  void invoke("sticky_save", { id, md })
    .then(() => openStickyWindow(id, x, y))
    .then((ok) => {
      if (!ok) return;
      card.remove();
      markEdited();
      addActivity(`“${title || "untitled sticky"}” is now floating on your desktop`);
    })
    .catch((err) => addActivity(`✕ ${String(err)}`));
}

export function popOutStickyById(note: string, id: string) {
  if (!note) {
    void openStickyWindow(id);
    return;
  }
  void invoke("sticky_lift", { note, id })
    .then(() => {
      if (current === note) {
        const card = Array.from(body().querySelectorAll(".callout.sticky")).find(
          (c) => (c as HTMLElement).dataset.topic === id,
        ) as HTMLElement | undefined;
        if (card) {
          card.remove();
          markEdited();
        }
      }
      return openStickyWindow(id);
    })
    .catch((err) => addActivity(`✕ ${String(err)}`));
}

async function openStickyMenu(from?: HTMLElement) {  $("#mark-pop").classList.add("hidden");
  const menu = $("#sticky-menu");
  menu.innerHTML = "";
  if (from) {
    const r = from.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.left = `${Math.max(8, Math.min(r.left - 150, window.innerWidth - 220))}px`;
    menu.style.top = `${r.bottom + 6}px`;
  } else {
    menu.style.position = "";
    menu.style.left = "";
    menu.style.top = "";
  }
  const row = document.createElement("div");
  row.className = "sticky-colors";
  const swatches: HTMLButtonElement[] = [];
  let newBtn: HTMLButtonElement | null = null;
  for (const [c, hex] of Object.entries(STICKY_COLORS)) {
    const sw = document.createElement("button");
    sw.className = "sw" + (c === stickyColor ? " active" : "");
    sw.style.background = hex;
    sw.title = c;
    sw.addEventListener("click", () => {
      stickyColor = c;
      localStorage.setItem("laido.stickycolor", c);
      const card = from?.closest(".callout.sticky") as HTMLElement | null;
      if (card) {
        card.dataset.color = c;
        markEdited();
      }
      for (const s of swatches) s.classList.toggle("active", s === sw);
      if (newBtn) newBtn.textContent = `New sticky note (${stickyColor})`;
    });
    swatches.push(sw);
    row.append(sw);
  }
  menu.append(row);
  const add = (label: string, fn: () => void, keepOpen = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      if (!keepOpen) menu.classList.add("hidden");
      fn();
    });
    menu.append(b);
    return b;
  };
  newBtn = add(`${t("skills.newSticky")} (${stickyColor})`, () => insertSticky(), true);
  const all = await invoke<Array<{ note: string; id: string; title: string }>>("vault_stickies");
  const h = document.createElement("div");
  h.className = "menu-label";
  h.textContent = "History — all notes";
  menu.append(h);
  let lastNote = "";
  for (const s of all) {
    if (s.note !== lastNote) {
      lastNote = s.note;
      const n = document.createElement("div");
      n.className = "menu-sub";
      n.textContent = s.note ? s.note.replace(/\.(laido|md)$/, "") : "Floating";
      menu.append(n);
    }
    add(s.title || `Untitled (${s.id})`, () => popOutStickyById(s.note, s.id));
  }
  if (all.length === 0) {
    const e = document.createElement("div");
    e.className = "menu-sub";
    e.textContent = "no stickies yet";
    menu.append(e);
  }
  menu.classList.remove("hidden");
}

export function insertSticky() {
  if (!current) return;
  const id = `s${Math.random().toString(36).slice(2, 8)}`;
  const color = stickyColor === "yellow" ? "" : ` color=${stickyColor}`;
  const holder = document.createElement("div");
  holder.innerHTML = renderCalloutMd(`> [!sticky] ${id}${color}\n> `);
  const card = holder.firstElementChild as HTMLElement | null;
  if (!card) return;
  enhanceCard(card);
  body().append(card);
  markEdited();
  card.scrollIntoView({ block: "center" });
  const b = card.querySelector<HTMLElement>(".callout-body");
  if (b) {
    b.focus();
    const r = document.createRange();
    r.selectNodeContents(b);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }
}

/* ---------- focus-scroll guard ----------
 * Clicking a control inside any widget card (browser chat/url, sheet
 * cells, deck fields, todo inputs, map/canvas popups, card chrome…)
 * focuses it — and Chromium then scrolls the ancestor to "reveal" the
 * focused element. Its visibility math misfires under the zoomed
 * editor (it scrolled even when the control was fully in view), so a
 * plain click could fling the page to the middle. There's no API to
 * turn off click-focus scrolling, so: snapshot the scroller on a
 * pointerdown on a card control, and for the next beat snap it back —
 * the smooth focus-scroll animates over ~600ms, each frame gets
 * reverted. Arms only on real controls / non-editable widget surfaces —
 * the editable card body stays out so drag-selection auto-scroll still
 * works, and wheel scrolls can't realistically land inside the window. */
export function guardFocusScroll(scroller: HTMLElement): void {
  let guard: { st: number; sl: number; until: number } | null = null;
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as HTMLElement;
      guard =
        t.closest(".callout") &&
        t.closest('input, textarea, select, button, a, .grip, [contenteditable="false"]')
          ? { st: scroller.scrollTop, sl: scroller.scrollLeft, until: performance.now() + 900 }
          : null;
    },
    true,
  );
  scroller.addEventListener(
    "scroll",
    () => {
      if (!guard) return;
      if (performance.now() > guard.until) {
        guard = null;
        return;
      }
      scroller.scrollTop = guard.st;
      scroller.scrollLeft = guard.sl;
    },
    { passive: true },
  );
}

export function initEditor() {
  const el = body();
  document.execCommand("defaultParagraphSeparator", false, "p");

  // Ctrl+K/Ctrl+O palette + vault link index + the links strip
  initPalette();
  initOutline();
  initFind(); // Ctrl+F find-in-note — mark-spans, never unrenders widgets
  void refreshIndex(true);
  // palette `>` commands spawn widgets on the current note
  document.addEventListener("palette:cmd", (e) => {
    const kind = (e as CustomEvent<string>).detail;
    if (kind === "sheet") spawnSheetCard("sheet", 6, 4);
    else if (kind === "slides" || kind === "deck") spawnDeckCard("deck");
    else if (kind === "chart") spawnChartCard("chart");
    else if (kind === "todo") spawnTodoCard("tasks");
    else if (kind === "browser") spawnBrowserCard("browser", "");
    else if (kind === "cards" || kind === "review") spawnCardsCard("cards");
    else if (kind === "map" || kind === "mindmap") spawnMapCard("map");
    else if (kind === "agenda" || kind === "due") spawnAgendaCard("agenda");
    else if (kind === "graph") spawnGraphCard("vault map");
    else if (kind === "canvas" || kind === "draw") spawnCanvasCard("canvas");
    else if (kind === "base" || kind === "view" || kind === "db") spawnBaseCard("base");
    else if (kind === "props") insertPropsPanel();
    else if (kind === "digest") void speakDigest();
    else if (kind === "speak") {
      // read the live selection aloud; nothing selected → the note title +
      // body. Esc or any further speak toggles cancels via speechSynthesis.
      const sel = window.getSelection();
      const selText = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
      const b = body();
      const text =
        selText ||
        (current ? [titleName(current), b?.innerText ?? ""].join(". ").replace(/\s+/g, " ").trim() : "");
      if (text) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
        window.speechSynthesis.speak(u);
        addActivity(selText ? "reading selection aloud" : "reading note aloud");
      }
    }
    else if (kind === "research") {
      // drop `@research ` on a fresh line so the user types the topic
      const b = document.createElement("p");
      b.textContent = "@research ";
      el.append(b);
      b.focus();
    }
  });

  // a base card's ⤓ — materialize the filtered view as a live [!sheet]
  // card right after it: the base filters, the sheet computes
  document.addEventListener("base:export", (e) => {
    const md = (e as CustomEvent<string>).detail;
    if (typeof md === "string" && md.includes("[!sheet]")) insertCallout("sheet", md);
    else if (typeof md === "string" && md.includes("[!chart]")) insertCallout("chart", md);
    addActivity("base → sheet card materialized");
  });

  // capture pipe — a browser card's ⇲ lands its quote + source on the note
  document.addEventListener("browser:clip", (e) => {
    const d = (e as CustomEvent<{ title: string; url: string; text: string }>).detail;
    if (d?.text) insertClip(d.title, d.url, d.text);
  });

  // transient toast — one-liner notifications (history empty, restore done…)
  document.addEventListener("laido:toast", (e) => {
    const msg = (e as CustomEvent<string>).detail;
    if (!msg) return;
    document.querySelector(".laido-toast")?.remove();
    const t = document.createElement("div");
    t.className = "laido-toast";
    t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.classList.add("out"), 2400);
    setTimeout(() => t.remove(), 2800);
  });

  // reload the open note (history restore path)
  document.addEventListener("laido:reload", () => {
    if (current) void loadNote(current);
  });

  // audio digest — the transcript lands as a callout (visible trace)
  document.addEventListener("digest:insert", (e) => {
    const text = (e as CustomEvent<string>).detail;
    if (!text) return;
    const lines = text.split(/\n+/).map((l) => `> ${l}`).join("\n");
    insertCallout("digest", `> [!ai] digest — ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}\n${lines}`);
  });

  const SIZES = [14, 15, 16, 18, 20];
  let sizeIdx = Number(localStorage.getItem("laido.notesize") ?? 2);
  if (!Number.isFinite(sizeIdx) || sizeIdx < 0 || sizeIdx >= SIZES.length) sizeIdx = 2;
  const applyNoteSize = () => {
    document.documentElement.style.setProperty("--note-size", `${SIZES[sizeIdx]}px`);
    localStorage.setItem("laido.notesize", String(sizeIdx));
  };
  applyNoteSize();
  $("#btn-bigger").addEventListener("click", () => {
    sizeIdx = Math.min(SIZES.length - 1, sizeIdx + 1);
    applyNoteSize();
  });
  $("#btn-smaller").addEventListener("click", () => {
    sizeIdx = Math.max(0, sizeIdx - 1);
    applyNoteSize();
  });
  $("#btn-sticky").addEventListener("click", (e) => {
    e.stopPropagation();
    void openStickyMenu();
  });

  /* ---------- auto-align: lay the AI cards out in a uniform grid ---------- */

  const alignPop = document.createElement("div");
  alignPop.id = "align-pop";
  alignPop.className = "skill-pop hidden";
  document.body.append(alignPop);
  let alignCols = Number(localStorage.getItem("laido.align.cols") ?? "3") || 3;

  // alignment is the only thing allowed to move a pinned card — it moves
  // it and leaves it pinned; unpinned cards just become floating
  const placeCard = (c: HTMLElement, x: number, y: number, w: number, h: number) => {
    c.classList.add("floating", "sized");
    c.style.margin = "0";
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    writeState(c, { x, y, w, h });
  };

  const alignCards = (cols: number) => {
    const root = body();
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>(".callout:not(.sticky)"),
    ).filter((c) => !c.classList.contains("dragging"));
    if (!cards.length) {
      addActivity("no AI widgets to align yet");
      return;
    }
    const gap = 12;
    const pageW = root.clientWidth;
    const w = Math.max(200, Math.floor((pageW - gap * (cols - 1)) / cols));
    const h = Math.min(320, Math.max(180, Math.round(w * 0.72)));
    const top0 = Math.min(...cards.map((c) => c.offsetTop));
    cards.forEach((card, i) => {
      placeCard(card, (i % cols) * (w + gap), top0 + Math.floor(i / cols) * (h + gap), w, h);
    });
    flowAroundCards();
    resolvePinnedOverlaps();
    scheduleCardLinks();
    markEdited();
    addActivity(`✓ aligned ${cards.length} widget${cards.length === 1 ? "" : "s"} — ${cols} per row`);
  };

  /* web threads — every follow-up (the cards tied by a thread line) stacks in
   * a dedicated column directly under its parent, so all the web answers for
   * one query sit together; top-level cards keep the normal grid */
  const alignThreads = () => {
    const root = body();
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>(".callout:not(.sticky)"),
    ).filter((c) => !c.classList.contains("dragging"));
    if (!cards.length) {
      addActivity("no AI widgets to align yet");
      return;
    }
    const byCid = new Map<string, HTMLElement>();
    for (const c of cards) if (c.dataset.cid) byCid.set(c.dataset.cid, c);
    const kids = new Map<HTMLElement, HTMLElement[]>();
    const parents: HTMLElement[] = [];
    for (const c of cards) {
      const p = c.dataset.parent ? byCid.get(c.dataset.parent) : undefined;
      if (p) {
        const arr = kids.get(p) ?? [];
        arr.push(c);
        kids.set(p, arr);
      } else {
        parents.push(c);
      }
    }
    const gap = 12;
    const pageW = root.clientWidth;
    const cols = Math.max(1, alignCols);
    const pw = Math.max(200, Math.floor((pageW - gap * (cols - 1)) / cols));
    const ph = Math.min(320, Math.max(180, Math.round(pw * 0.72)));
    const kh = Math.max(130, Math.round(ph * 0.55));
    const top0 = Math.min(...cards.map((c) => c.offsetTop));
    let cursorY = top0;
    const rows = Math.ceil(parents.length / cols);
    for (let r = 0; r < rows; r++) {
      const rowParents = parents.slice(r * cols, r * cols + cols);
      let rowH = ph;
      for (const p of rowParents) {
        const kn = kids.get(p)?.length ?? 0;
        if (kn) rowH = Math.max(rowH, ph + 8 + kn * (kh + 8) - 8);
      }
      rowParents.forEach((p, cIdx) => {
        const x = cIdx * (pw + gap);
        placeCard(p, x, cursorY, pw, ph);
        kids.get(p)?.forEach((k, i) =>
          placeCard(k, x, cursorY + ph + 8 + i * (kh + 8), pw, kh),
        );
      });
      cursorY += rowH + gap;
    }
    flowAroundCards();
    resolvePinnedOverlaps();
    scheduleCardLinks();
    markEdited();
    const kc = cards.length - parents.length;
    addActivity(`✓ web threads — ${parents.length} card${parents.length === 1 ? "" : "s"} + ${kc} follow-up${kc === 1 ? "" : "s"} grouped`);
  };

  $("#btn-align").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!alignPop.classList.contains("hidden")) {
      alignPop.classList.add("hidden");
      return;
    }
    alignPop.innerHTML = "";
    const lbl = document.createElement("div");
    lbl.className = "menu-label";
    lbl.textContent = "Align AI widgets";
    alignPop.append(lbl);
    for (const n of [1, 2, 3, 4, 5]) {
      const b = document.createElement("button");
      b.className = "skill-item" + (n === alignCols ? " active" : "");
      const nm = document.createElement("span");
      nm.className = "skill-name";
      nm.textContent = n === 1 ? "single column" : `${n} per row`;
      const d = document.createElement("span");
      d.className = "skill-desc";
      d.textContent = n === alignCols ? "current" : "";
      b.append(nm, d);
      b.addEventListener("click", () => {
        alignCols = n;
        localStorage.setItem("laido.align.cols", String(n));
        alignPop.classList.add("hidden");
        alignCards(n);
      });
      alignPop.append(b);
    }
    const sep = document.createElement("div");
    sep.className = "menu-label";
    sep.textContent = "grouped";
    alignPop.append(sep);
    const tb = document.createElement("button");
    tb.className = "skill-item";
    const tnm = document.createElement("span");
    tnm.className = "skill-name";
    tnm.textContent = "web threads";
    const td = document.createElement("span");
    td.className = "skill-desc";
    td.textContent = "follow-ups stack under their parent";
    tb.append(tnm, td);
    tb.addEventListener("click", () => {
      alignPop.classList.add("hidden");
      alignThreads();
    });
    alignPop.append(tb);
    alignPop.classList.remove("hidden");
    const r = $("#btn-align").getBoundingClientRect();
    alignPop.style.left = `${Math.max(8, Math.min(r.left - 70, window.innerWidth - 200))}px`;
    alignPop.style.top = `${r.bottom + 8}px`;
  });
  document.addEventListener("pointerdown", (e) => {
    if (
      !alignPop.classList.contains("hidden") &&
      !(e.target as HTMLElement).closest("#align-pop, #btn-align")
    ) {
      alignPop.classList.add("hidden");
    }
  });

  el.addEventListener("input", (e) => {
    /* edits inside a card's own fields (browser chat, url bar, sheet
     * cells…) are widget state, not note text — they still mark the note
     * dirty (widget DOM is what serialize() persists) but skip the
     * card-flow pass: a forced whole-page reflow per keystroke is what
     * made card inputs lag. The command picker must stay off too — arming
     * it would read a stale document selection and let the next space/
     * enter run a command while the user is only typing in the card */
    const inCard = !!(e.target as HTMLElement | null)?.closest?.(".callout");
    markEdited(!inCard);
    const ie = e as InputEvent;
    if (!inCard && !ie.isComposing) {
      // typing a command word + space opens the no-@ picker anywhere on the
      // line; at line start a hand-typed word becomes a chip right away.
      // pasted or dropped text never chips or pops — only manual typing arms.
      // insertCompositionText covers IME/autocorrect commits (see Input
      // Events Level 2), insertReplacementText covers spell-suggest swaps
      const typed = TYPED_INPUTS.has(ie.inputType);
      const fresh = currentCmdWord();
      if (fresh && typed) {
        const st = wordAtLineStart(fresh) ? chipifyTypedWord(fresh) : null;
        cmdPick = st ?? fresh;
        cmdRowsWord = null;
        cmdActive = 0;
        void renderCmdPick("");
        return;
      }
      // while the word is still being typed at line start, suggest the
      // commands and skills it could become — "r" offers research/recall/…
      const part = typed ? currentCmdPrefix() : null;
      if (part) {
        cmdPick = part;
        cmdActive = 0;
        void renderCmdPick(part.word);
        return;
      }
      if (cmdPick) refreshCmdPick();
      // `[[` wikilink suggester — runs alongside the command picker
      // (a line can't hold both live contexts at once)
      refreshWikiPick(typed);
    }
  });

  /* ---------- paper ruling: device-snapped lines on a viewport canvas ---------- */
  if (!document.body.classList.contains("sticky-mode")) {
    const editor = $("#editor")!;
    const cv = document.createElement("canvas");
    cv.className = "paper-lines";
    editor.insertBefore(cv, el);
    let paintRaf = 0;
    const paint = () => {
      paintRaf = 0;
      const z = Z(), d = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect(), er = editor.getBoundingClientRect();
      cv.style.left = `${r.left - er.left}px`;
      cv.style.top = `${r.top - er.top}px`;
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      const bw = Math.max(1, Math.round(r.width * d)), bh = Math.max(1, Math.round(r.height * d));
      if (cv.width !== bw) cv.width = bw;
      if (cv.height !== bh) cv.height = bh;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const cs = getComputedStyle(el);
      ctx.fillStyle = cs.getPropertyValue("--editor-bg").trim() || "#fbf5e6";
      ctx.fillRect(0, 0, bw, bh);
      const sTop = el.scrollTop, sLeft = el.scrollLeft, h = r.height;
      const row = 26, ruleY = 32.2; // matches the old gradient: 7px offset + rule near row bottom
      const t = Math.max(1, Math.round(1.6 * z * d));
      ctx.fillStyle = cs.getPropertyValue("--rule").trim() || "#eadfc6";
      for (let n = Math.floor((sTop - ruleY) / row); ; n++) {
        const y = (ruleY + n * row - sTop) * z;
        if (y > h) break;
        if (y * d + t < 0) continue;
        ctx.fillRect(0, Math.round(y * d - t / 2), bw, t);
      }
      const mt = Math.max(1, Math.round(1.4 * z * d));
      const mx = (47.3 - sLeft) * z;
      if (mx * d + mt > 0 && mx < r.width) {
        ctx.fillStyle = cs.getPropertyValue("--margin-line").trim() || "#e3b7a4";
        ctx.fillRect(Math.round(mx * d - mt / 2), 0, mt, bh);
      }
    };
    const schedulePaint = () => { if (!paintRaf) paintRaf = requestAnimationFrame(paint); };
    el.addEventListener("scroll", schedulePaint);
    el.addEventListener("laido:zoom", schedulePaint);
    (el as any).__paperRO = new ResizeObserver(schedulePaint);
    (el as any).__paperRO.observe(el);
    paint();
  }

  /* ---------- zoom (Ctrl+wheel) + hover zoom bar + canvas growth ---------- */
  applyZoom(paperZoom);
  el.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    applyZoom(paperZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  el.addEventListener("scroll", () => {
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 900) {
      const cur = parseFloat(el.style.getPropertyValue("--padH")) || 4200;
      el.style.setProperty("--padH", `${cur + 4200}px`);
    }
    if (el.scrollLeft + el.clientWidth > el.scrollWidth - 500) {
      const cur = parseFloat(el.style.getPropertyValue("--padW")) || 240;
      el.style.setProperty("--padW", `${cur + 100}%`);
    }
  });

  if (!document.body.classList.contains("sticky-mode")) {
    const dock = document.createElement("div");
    dock.className = "zoomdock";
    const bar = document.createElement("div");
    bar.className = "zoombar";
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.title = "Zoom out";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "40";
    range.max = "250";
    range.step = "5";
    const plus = document.createElement("button");
    plus.textContent = "+";
    plus.title = "Zoom in";
    const pct = document.createElement("span");
    pct.className = "zoom-pct";
    pct.title = "Reset zoom to 100%";
    bar.append(minus, range, plus, pct);
    dock.append(bar);
    $("#editor")?.append(dock);
    let flashT = 0;
    const sync = (z: number) => {
      range.value = String(Math.round(z * 100));
      pct.textContent = `${Math.round(z * 100)}%`;
    };
    const flash = () => {
      bar.classList.add("show");
      window.clearTimeout(flashT);
      flashT = window.setTimeout(() => bar.classList.remove("show"), 1600);
    };
    sync(paperZoom);
    el.addEventListener("laido:zoom", (e) => { sync((e as CustomEvent<number>).detail); flash(); });
    minus.addEventListener("click", () => applyZoom(paperZoom / 1.12));
    plus.addEventListener("click", () => applyZoom(paperZoom * 1.12));
    range.addEventListener("input", () => applyZoom(Number(range.value) / 100));
    pct.addEventListener("click", () => applyZoom(1));
  }

  // drag-selections are zone-locked both ways: a drag that starts on the
  // paper never reaches a widget, and a drag that starts in a widget never
  // reaches the paper. the flags hold through the caret-collapse that
  // mousedown fires (a collapsed selectionchange must not strip them)
  let paperDrag = false;
  let cardDrag: HTMLElement | null = null;
  el.addEventListener("mousedown", (e) => {
    const card = (e.target as HTMLElement).closest?.(".callout") as HTMLElement | null;
    if (!card) {
      el.classList.add("paper-selectall");
      if (e.button === 0) paperDrag = true;
    } else if (e.button === 0) {
      cardDrag = card;
    }
    if (e.target !== el) return;
    const rect = el.getBoundingClientRect();
    const lineH = 26;
    const y = (e.clientY - rect.top) / Z() + el.scrollTop;
    const kids = Array.from(el.children) as HTMLElement[];
    const flow = kids.filter(
      (k) => !k.classList.contains("floating") && !k.classList.contains("drag-gap"),
    );
    // clicks inside a callout's row band park the caret just before/after the
    // card — browsers won't place a caret next to a contenteditable=false island
    for (const k of flow) {
      if (k.offsetTop > y) break;
      if (!k.classList.contains("callout")) continue;
      if (y <= k.offsetTop + k.offsetHeight) {
        e.preventDefault();
        const after = y > k.offsetTop + k.offsetHeight / 2;
        const r = document.createRange();
        r.setStart(el, kids.indexOf(k) + (after ? 1 : 0));
        r.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
        el.focus();
        return;
      }
    }
    // every other click inside content is native — caret lands on the clicked
    // line and drag-selection still works from the margins
    const last = flow[flow.length - 1] ?? null;
    if (last && y <= last.offsetTop + last.offsetHeight + 6) return;
    // below all content — pad with empty lines down to the clicked row
    e.preventDefault();
    const clicked = Math.floor((y - 12) / lineH);
    const lines = last ? Math.ceil((last.offsetTop + last.offsetHeight - 12) / lineH) : 0;
    /* the click came from inside the viewport, so the target row is at most
     * a screenful below the last line — pad all the way to it. The old 40-row
     * cap stranded the caret above the fold and scrollIntoView then yanked
     * the view up to meet it ("click at the bottom, caret at the top").
     * Keep a hard ceiling only as a safety net. */
    const need = Math.min(300, Math.max(1, clicked - lines + 1));
    for (let i = 0; i < need; i++) {
      const p = document.createElement("p");
      p.append(document.createElement("br"));
      el.append(p);
    }
    markEdited();
    const caret = el.lastElementChild as HTMLElement | null;
    if (caret) {
      // horizontal placement too: park at the line's content-left edge, then
      // pad nbsp out to the clicked x — the mouseup pad can't rely on the
      // hit test retargeting to a line that didn't exist at mousedown
      const cs = getComputedStyle(caret);
      const startX =
        caret.getBoundingClientRect().left +
        (parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)) * Z();
      const dx = (e.clientX - startX) / Z();
      if (dx > 4) {
        caret.textContent = "";
        const pad = document.createTextNode(
          " ".repeat(Math.max(1, Math.round(dx / nbspWidth(caret)))),
        );
        caret.append(pad);
        const r3 = document.createRange();
        r3.setStartAfter(pad);
        r3.collapse(true);
        const sel3 = window.getSelection();
        sel3?.removeAllRanges();
        sel3?.addRange(r3);
      } else {
        placeCaretAtEnd(caret);
      }
      caret.scrollIntoView({ block: "nearest" });
      el.focus();
    }
  });

  // click to the right of a line's text end → pad with nbsp and type there
  el.addEventListener("mouseup", clickAndType);

  guardFocusScroll(el);

  el.addEventListener("keydown", (e) => {
    /* keys typed into a widget control (chat/url inputs, cells, editable
     * card heads…) belong to the widget — every branch below reads the
     * document selection, which still points wherever the caret last was,
     * so handling them here would both eat the keystroke (preventDefault
     * cancels the field's own editing) and act on a stale note position */
    if ((e.target as HTMLElement | null)?.closest?.(".callout, input, textarea, select")) return;
    // the open pickers own arrows/tab/enter/escape until they close
    if (wikiPickKey(e)) return;
    if (cmdPickKey(e)) return;
    // Escape cancels a command: with the picker open it just closes the list;
    // on a chipped row it dissolves every chip back into plain text so the
    // line is inert — never a command
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
      const sel = window.getSelection();
      const node = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null;
      const host = node instanceof HTMLElement ? node : node?.parentElement;
      const top =
        host?.closest("#note-body") && !host.closest(".callout")
          ? node instanceof Text
            ? lineRow(node)
            : rowOf(host)
          : null;
      if (top && top !== body()) {
        const chips = top.querySelectorAll(".cmd-chip");
        if (chips.length > 0) {
          e.preventDefault();
          chips.forEach((c) => c.replaceWith(document.createTextNode(c.textContent ?? "")));
          top.normalize();
          markEdited();
          return;
        }
      }
    }
    // Backspace right after a command chip deletes the whole chip
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey) {
      const sel = window.getSelection();
      if (sel?.isCollapsed && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        let prev: Node | null = null;
        if (r.startContainer.nodeType === Node.TEXT_NODE) {
          const t = r.startContainer as Text;
          // caret at the start of the text, or right after the single space
          // that follows a chip — either way the chip is the target
          if (r.startOffset === 0 || (r.startOffset === 1 && t.length === 1 && !t.data.trim())) {
            prev = t.previousSibling;
          }
        } else if (r.startContainer.nodeType === Node.ELEMENT_NODE) {
          prev = r.startContainer.childNodes[r.startOffset - 1] ?? null;
        }
        if (prev instanceof HTMLElement && prev.classList.contains("cmd-chip")) {
          e.preventDefault();
          prev.remove();
          markEdited();
          return;
        }
      }
    }
    // Ctrl+A is zone-scoped: inside a widget it selects that widget only;
    // on the paper it selects every text block but never the widgets
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      const host = node instanceof HTMLElement ? node : node?.parentElement;
      const card = host?.closest?.(".callout") as HTMLElement | null;
      e.preventDefault();
      const r = document.createRange();
      if (card) {
        paperDrag = false;
        el.classList.remove("paper-selectall");
        r.selectNodeContents(card.querySelector(".callout-body") ?? card);
      } else {
        // a mask class marks "paper select-all" so CSS can un-selectable the
        // widgets inside the range — cleared on the next click/caret move
        el.classList.add("paper-selectall");
        r.selectNodeContents(el);
      }
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    // shift-extending a selection that lives on the paper keeps widgets out too
    if (e.shiftKey && /^(Arrow|Home|End|Page)/.test(e.key)) {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const host = node instanceof HTMLElement ? node : node?.parentElement;
      if (host && el.contains(host) && !host.closest(".callout")) {
        el.classList.add("paper-selectall");
      }
    }
    // Tab indents to the next tab stop instead of leaving the editor
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const startEl =
        range.startContainer instanceof HTMLElement
          ? range.startContainer
          : range.startContainer.parentElement;
      const block = startEl?.closest(
        "p, li, h1, h2, h3, blockquote",
      ) as HTMLElement | null;
      insertTabIndent(range, block, Z());
      markEdited();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      restoreLastSel();
      toggleMark(hlColor);
      markEdited();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.getRangeAt(0).startContainer;
    const start = node instanceof HTMLElement ? node : node.parentElement;
    let block = start?.closest("p, li, h1, h2, h3, blockquote") as HTMLElement | null;
    if (!block) {
      // caret on a bare line (plain <div> or text node) — take the top-level row
      let n: Node | null = node;
      while (n && n.parentNode !== el) n = n.parentNode;
      block = n instanceof HTMLElement ? n : null;
    }
    if (
      !block ||
      block === el ||
      block.closest(".callout") ||
      block.classList.contains("drag-gap")
    ) {
      return;
    }
    const raw = clean(block.textContent ?? "");
    // only chips run — a hand-typed word arms a chip, pasted or dropped text
    // never does; the chip carries the stored "@cmd [arg] rest" form so the
    // same dispatch branches serve every command
    const cc = chipCommand(block);
    if (!cc) return;
    const command = `@${cc.cmd}${cc.arg ? " " + cc.arg : ""}${cc.rest ? " " + cc.rest : ""}`;
    // "@document <file?> <question>" — scoped to a library file when the
    // first token matches a slug, else all-files. "@ask <question>" is the
    // hybrid: library + your notes + web research, fused into one answer.
    const docMatch = command.match(/^@(document|ask)\s+(.+)$/);
    if (docMatch && current) {
      e.preventDefault();
      const rest = docMatch[2].trim();
      const hybrid = docMatch[1] === "ask";
      showPencil(block);
      void save()
        .then(() => resolveAskTarget(rest, hybrid))
        .then(({ target, query }) => {
          addActivity(
            hybrid
              ? `🔎 asking everything — library + notes${target !== "everything" ? ` (scoped to ${target})` : ""} + web…`
              : `🔎 asking ${target}…`,
          );
          return invoke("rag_ask", {
            note: current,
            target,
            query,
            quiet: true,
            anchor: raw,
            question: query,
            web: hybrid,
          }).then(() => addActivity(`✓ answered from ${target}`));
        })
        .catch((err) => {
          addActivity(`✕ ${String(err)}`);
          hidePencil();
          insertCallout("ask", `> [!ai] rag failed: ask\n> ${String(err)}`, raw);
        });
      return;
    }
    if (/^@(document|ask)\s*$/.test(command)) {
      e.preventDefault();
      openCmdPickFromChip(block, cc.cmd as CmdWord);
      return;
    }
    // "@skill <name> <input>" — run the saved skill on the user's input:
    // a seeded chat card applies the skill's saved knowledge (skills_digest
    // rides in term_ai's system prompt) and its widget fences execute live —
    // concrete-estimate lands as a real formula sheet, not quoted text
    const skillInput = command.match(/^@skill\s+([\w-]+)\s+(.+)$/);
    if (skillInput) {
      e.preventDefault();
      if (!current) {
        addActivity("✕ open a note first — skills write their results into the current note");
        return;
      }
      const name = skillInput[1];
      const input = skillInput[2].trim();
      addActivity(`⚡ ${name} — applying to "${input.slice(0, 60)}"`);
      spawnTerminalCard("chat", `using the ${name} skill, ${input}`, block);
      return;
    }
    const skillMatch = command.match(/^@skill\s+([\w-]+)$/);
    if (skillMatch) {
      e.preventDefault();
      if (!current) {
        addActivity("✕ open a note first — skills write their results into the current note");
        return;
      }
      showPencil(block);
      void invoke("skill_run", { note: current, name: skillMatch[1], quiet: true }).catch((err) => {
        addActivity(`✕ ${String(err)}`);
        hidePencil();
      });
      return;
    }
    if (/^@skill\s*$/.test(command)) {
      e.preventDefault();
      openCmdPickFromChip(block, "skill");
      return;
    }
    // @summary — summarize the current note (optional extra instruction)
    const sumMatch = command.match(/^@summary(?:\s+(.+))?$/);
    if (sumMatch && current) {
      e.preventDefault();
      showPencil(block);
      void (async () => {
        // the summary reads the saved markdown — flush pending edits (and the
        // newest cards) to disk first so nothing is missed
        await save();
        const md = await invoke<string>("note_summary", {
          name: current,
          instruction: sumMatch[1] ?? null,
        });
        insertCallout(`summary: ${current}`, md, raw);
        addActivity("📝 note summarized");
      })().catch((err) => {
        addActivity(`✕ ${String(err)}`);
        hidePencil();
      });
      return;
    }
    // @loop — iterative research: refine → research → simulate → repeat
    if (/^@loop\s+stop$/i.test(command)) {
      e.preventDefault();
      void invoke("loop_stop")
        .then(() => addActivity("🔁 loop stop requested — wrapping up after this pass"))
        .catch((err) => addActivity(`✕ ${String(err)}`));
      return;
    }
    if (/^@loop\b/.test(command) && current) {
      e.preventDefault();
      showPencil(block);
      void (async () => {
        let rest = command.slice("@loop".length).trim();
        let loops = 3;
        const nm = rest.match(/^(\d{1,2})\s+/);
        if (nm) {
          loops = Math.max(1, Math.min(10, Number(nm[1])));
          rest = rest.slice(nm[0].length).trim();
        }
        let target: string | undefined;
        const tm = rest.match(/^(@?[\w-]+)\s+(.+)$/);
        if (tm) {
          const cand = tm[1].replace(/^@/, "");
          const pseudo = ["all-files", "my-notes", "everything"];
          const files = await invoke<Array<{ slug: string }>>("rag_list").catch(() => []);
          if (pseudo.includes(cand) || files.some((f) => f.slug === cand)) {
            target = cand;
            rest = tm[2].trim();
          }
        }
        if (!rest.trim()) throw new Error("give the loop a research query");
        await save();
        await invoke("loop_run", {
          note: current,
          query: rest.trim(),
          loops,
          target: target ?? null,
          anchor: raw,
        });
        addActivity(`🔁 research loop started — up to ${loops} loops · @loop stop to end early`);
      })().catch((err) => {
        addActivity(`✕ ${String(err)}`);
        hidePencil();
      });
      return;
    }
    // @related — the notes closest to this one, by embedding similarity
    if (/^@related\s*$/.test(command) && current) {
      e.preventDefault();
      showPencil(block);
      void save()
        .then(() => invoke<Array<{ name: string; score: number }>>("related_notes", { name: current }))
        .then((rows) => {
          const body = rows.length
            ? rows
                .map((r) => `- [[${r.name.replace(/\.(laido|md)$/, "")}]] · ${Math.round(r.score * 100)}%`)
                .join("\n")
            : "no related notes yet — keep writing and the connections appear";
          insertCallout(
            "related",
            `> [!ai] related: ${current}\n> ${body.split("\n").join("\n> ")}`,
            raw,
          );
        })
        .catch((err) => {
          addActivity(`✕ ${String(err)}`);
          hidePencil();
        });
      return;
    }
    // @recall — active recall: a quiz card + spaced reviews on the calendar
    const recallMatch = command.match(/^@recall(?:\s+(\S+))?(?:\s+(\d+))?$/);
    if (recallMatch && current) {
      e.preventDefault();
      let target = recallMatch[1] ?? "my-notes";
      let n = Number(recallMatch[2] ?? 6) || 6;
      if (/^\d+$/.test(target) && !recallMatch[2]) {
        n = Number(target);
        target = "my-notes";
      }
      showPencil(block);
      void save()
        .then(() => invoke<string>("rag_quiz", { target, n }))
        .then((md) => {
          insertCallout(`recall: ${target}`, md, raw);
          const now = new Date();
          for (const d of [1, 3, 7]) {
            const dt = new Date(now.getTime() + d * 86400000);
            const day = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
              dt.getDate(),
            ).padStart(2, "0")}`;
            void invoke("schedule_create", {
              note: current,
              spec: `once ${day} 09:00`,
              action: `remind: recall review — ${target} (day ${d})`,
            }).catch(() => {});
          }
          addActivity("🧠 recall card ready — reviews scheduled for day 1, 3 and 7");
        })
        .catch((err) => {
          addActivity(`✕ ${String(err)}`);
          hidePencil();
        });
      return;
    }
    // @tasks — action items extracted from a file or your notes
    const tasksMatch = command.match(/^@tasks(?:\s+(\S+))?(?:\s+(\d+))?$/);
    if (tasksMatch && current) {
      e.preventDefault();
      let target = tasksMatch[1] ?? "my-notes";
      let n = Number(tasksMatch[2] ?? 8) || 8;
      if (/^\d+$/.test(target) && !tasksMatch[2]) {
        n = Number(target);
        target = "my-notes";
      }
      showPencil(block);
      void save()
        .then(() => invoke<string>("rag_tasks", { target, n }))
        .then((md) => insertCallout(`tasks: ${target}`, md, raw))
        .catch((err) => {
          addActivity(`✕ ${String(err)}`);
          hidePencil();
        });
      return;
    }
    // persona chat — `@persona chef <q>` spawns a chat card whose system
    // prompt includes the persona-chef note's body
    const personaMatch = command.match(/^@(persona|as|agent)\s+([\w-]+)\s*(.*)$/);
    if (personaMatch && current) {
      e.preventDefault();
      const persona = personaMatch[2].toLowerCase();
      const card = spawnTerminalCard("chat", personaMatch[3].trim() || undefined, block, undefined, persona);
      const input = card.querySelector<HTMLTextAreaElement>(".term-input");
      if (input) input.placeholder = `as ${persona}…`;
      return;
    }
    // terminal/chat — spawn the AI terminal widget on the sheet; text after
    // the word seeds the first prompt
    const termMatch = command.match(/^@(terminal|chat)\s*(.*)$/);
    if (termMatch && current) {
      e.preventDefault();
      spawnTerminalCard(termMatch[1], termMatch[2].trim() || undefined, block);
      return;
    }
    // sheet/table — a spreadsheet card; `RxC` picks the size, the rest is the
    // title: `sheet 8x5 budget` or `sheet budget 8x5`
    const sheetMatch = command.match(/^@(sheet|table)\s*(.*)$/);
    if (sheetMatch && current) {
      e.preventDefault();
      const rest = sheetMatch[2].trim();
      const dim = rest.match(/(\d+)\s*[x×]\s*(\d+)/i);
      const rows = Math.min(100, Math.max(1, Number(dim?.[1] ?? 6)));
      const cols = Math.min(26, Math.max(1, Number(dim?.[2] ?? 4)));
      const title = (dim ? rest.replace(dim[0], " ") : rest).replace(/\s+/g, " ").trim();
      spawnSheetCard(title || "sheet", rows, cols, block);
      return;
    }
    // slides/deck/powerpoint/ppt — a presentation card; the rest is the title
    const deckMatch = command.match(/^@(slides|deck|powerpoint|ppt)\s*(.*)$/);
    if (deckMatch && current) {
      e.preventDefault();
      spawnDeckCard(deckMatch[2].trim() || "deck", block);
      return;
    }
    // todo — a task-list card; the rest is the list's name
    const todoMatch = command.match(/^@todo\s*(.*)$/);
    if (todoMatch && current) {
      e.preventDefault();
      spawnTodoCard(todoMatch[1].trim() || "tasks", block);
      return;
    }
    // browser/browse — a web card; the rest is a url or a search phrase
    const browMatch = command.match(/^@(browser|browse)\s*(.*)$/);
    if (browMatch && current) {
      e.preventDefault();
      const rest = browMatch[2].trim();
      const url = toUrl(rest);
      const stem = url ? (url.match(/^https?:\/\/([^/?#]+)/)?.[1] ?? rest) : rest;
      spawnBrowserCard(rest ? stem : "browser", url, block);
      return;
    }
    // chart — a viz card; "chart <name> <type>" picks the type word
    const chartMatch = command.match(/^@chart\s*(.*)$/);
    if (chartMatch && current) {
      e.preventDefault();
      spawnChartCard(chartMatch[1].trim() || "chart", block);
      return;
    }
    // flashcards — a spaced-repetition deck
    const cardsMatch = command.match(/^@(cards|flashcards|review)\s*(.*)$/);
    if (cardsMatch && current) {
      e.preventDefault();
      spawnCardsCard(cardsMatch[2].trim() || "cards", block);
      return;
    }
    // mind map — an outline that draws itself as a tree
    const mapMatch = command.match(/^@(map|mindmap|mind)\s*(.*)$/);
    if (mapMatch && current) {
      e.preventDefault();
      const arg = mapMatch[2].trim();
      spawnMapCard(arg === "project" ? "project" : arg || "map", block, arg === "project" ? PROJECT_TREE : undefined);
      return;
    }
    // agenda — the vault's due-work dashboard
    const agMatch = command.match(/^@(agenda|due|week)\s*(.*)$/);
    if (agMatch && current) {
      e.preventDefault();
      spawnAgendaCard(agMatch[2].trim() || "agenda", block);
      return;
    }
    // graph — force-directed map of the vault's [[links]]
    const gMatch = command.match(/^@(graph|network)\s*(.*)$/);
    if (gMatch && current) {
      e.preventDefault();
      spawnGraphCard(gMatch[2].trim() || "vault map", block);
      return;
    }
    // canvas — freeform drawing surface (rect/ellipse/line/freehand/text)
    const cvMatch = command.match(/^@(canvas|draw|sketch)\s*(.*)$/);
    if (cvMatch && current) {
      e.preventDefault();
      spawnCanvasCard(cvMatch[2].trim() || "canvas", block);
      return;
    }
    // base — property-driven table view; `@base prop:x=y` seeds the query
    const bMatch = command.match(/^@(base|view|db)\s*(.*)$/);
    if (bMatch && current) {
      e.preventDefault();
      const arg = bMatch[2].trim();
      const isQ = /(?:^|\s)(prop|tag|is):/i.test(arg);
      spawnBaseCard(isQ ? "base" : arg || "base", block, isQ ? arg : "");
      return;
    }
    // template — insert a tpl-*/template-* note with {{vars}} + {{prompt}} filled
    const tplMatch = command.match(/^@(tpl|template)\s*(.*)$/);
    if (tplMatch && current) {
      e.preventDefault();
      void insertTemplate(tplMatch[2].trim(), block);
      return;
    }
    // today — open-or-create the YYYY-MM-DD daily note
    if (/^@today\b/.test(command) && current) {
      e.preventDefault();
      void openToday();
      return;
    }
    if (!command.startsWith("@research ")) return;
    const topic = command.slice("@research ".length).trim();
    const hasCard = Array.from(el.querySelectorAll(".callout")).some(
      (c) => clean((c as HTMLElement).dataset.topic ?? "") === topic,
    );
    if (hasCard) {
      addActivity("already researched — delete the card to re-run");
      return;
    }
    showPencil(block);
    void invoke("habit_track", { note: current, signature: `@research ${topic}` });
    void invoke("agent_run", { name: current, text: command, anchor: raw });
  });

  // voice notes via AssemblyAI: clicking the mic asks for a mode — live
  // streaming (text appears as you speak) or record-then-transcribe. The
  // button turns red while active; clicking it again stops either mode.
  const micBtn = $("#btn-mic") as HTMLButtonElement | null;
  const voicePop = $("#voice-pop") as HTMLDivElement | null;
  const liveBubble = $("#voice-live") as HTMLDivElement | null;
  type VoiceMode = "live" | "record";
  let voiceMode: VoiceMode | null = null;

  const finishVoice = (text: string) => {
    if (text.trim()) {
      insertDictation(text.trim());
      addActivity(`🎙 transcribed ${text.trim().split(/\s+/).length} words`);
    } else {
      addActivity("🎙 nothing heard — try again closer to the mic");
    }
  };
  const stopVoiceUI = () => {
    voiceMode = null;
    micBtn?.classList.remove("rec");
    if (micBtn) micBtn.title = "Voice note — click to choose live or record";
    liveBubble?.classList.add("hidden");
  };
  const startVoice = async (mode: VoiceMode) => {
    voicePop?.classList.add("hidden");
    try {
      if (mode === "live") {
        await invoke("voice_live_start");
        if (liveBubble) {
          liveBubble.textContent = "listening…";
          liveBubble.classList.remove("hidden");
        }
        addActivity("🎙 live transcription — speak, then click the mic to stop");
      } else {
        await invoke("voice_start");
        addActivity("🎙 recording… click the mic again to stop and transcribe");
      }
      voiceMode = mode;
      micBtn?.classList.add("rec");
      if (micBtn) {
        micBtn.title =
          mode === "live" ? "Live — click to stop" : "Recording — click to stop and transcribe";
      }
    } catch (err) {
      addActivity(`✕ mic: ${String(err)}`);
      stopVoiceUI();
    }
  };
  const stopVoice = async () => {
    const mode = voiceMode;
    micBtn?.classList.remove("rec");
    addActivity(mode === "live" ? "🎙 finishing live transcription…" : "🎙 transcribing…");
    try {
      const text = await invoke<string>(mode === "live" ? "voice_live_stop" : "voice_stop");
      stopVoiceUI();
      finishVoice(text);
    } catch (err) {
      stopVoiceUI();
      addActivity(`✕ transcription failed: ${String(err)}`);
    }
  };
  micBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!voiceMode) {
      voicePop?.classList.toggle("hidden");
      return;
    }
    void stopVoice();
  });
  $("#voice-live-opt")?.addEventListener("click", () => void startVoice("live"));
  $("#voice-rec-opt")?.addEventListener("click", () => void startVoice("record"));
  document.addEventListener("pointerdown", (e) => {
    if (!voicePop || voicePop.classList.contains("hidden")) return;
    const t = e.target as HTMLElement;
    if (!t.closest("#voice-pop, #btn-mic")) voicePop.classList.add("hidden");
  });
  const vlisten = window.__TAURI__.event.listen;
  void vlisten<{ final: string; partial: string }>("voice:partial", (e) => {
    if (!liveBubble) return;
    liveBubble.textContent = `${e.payload.final}${e.payload.partial}`.trim() || "listening…";
    liveBubble.classList.remove("hidden");
  });
  void vlisten<{ error: string }>("voice:error", (e) => {
    addActivity(`✕ live transcription: ${e.payload.error}`);
    stopVoiceUI();
  });

  document.querySelectorAll<HTMLButtonElement>(".fmt-tools button").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const f = b.dataset.fmt;
      if (!f) return;
      if (f === "bold") document.execCommand("bold");
      else if (f === "italic") document.execCommand("italic");
      else if (f === "strike") document.execCommand("strikeThrough");
      else if (f === "ul") document.execCommand("insertUnorderedList");
      else if (f === "clear") clearFormatting();
      if (f !== "mark") markEdited();
      el.focus();
    });
  });

  const pop = $("#mark-pop");
  $("#btn-mark").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#sticky-menu").classList.add("hidden");
    pop.classList.toggle("hidden");
  });
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  pop.addEventListener("click", (e) => {
    const sw = (e.target as HTMLElement).closest("[data-color]") as HTMLElement | null;
    if (!sw) return;
    hlColor = sw.dataset.color ?? "yellow";
    $("#btn-mark .hl").setAttribute("style", `background:${HL_COLORS[hlColor] ?? HL_COLORS.yellow}`);
    pop.classList.add("hidden");
    restoreLastSel();
    toggleMark(hlColor);
    markEdited();
    el.focus();
  });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    // clicking a task checkbox in note text toggles it — `- [ ]` ↔ `- [x]`
    const box = t.closest<HTMLElement>("li.todo .todo-box");
    if (box && !box.closest(".todo-card")) {
      const li = box.closest<HTMLElement>("li.todo")!;
      const done = !li.classList.contains("done");
      li.classList.toggle("done", done);
      box.textContent = done ? "☑" : "☐";
      dirty = true;
      void save();
      return;
    }
    if (!pop.classList.contains("hidden") && !t.closest("#mark-pop, #btn-mark")) {
      pop.classList.add("hidden");
    }
    const sm = $("#sticky-menu");
    if (!sm.classList.contains("hidden") && !t.closest("#sticky-menu, #btn-sticky")) {
      sm.classList.add("hidden");
    }
  });

  /* ---------- selection popover: format tools + ask-ai on highlighted text ----------
   * appears above any non-collapsed selection in editable note text or card
   * bodies; buttons act on the live selection, the input sends a follow-up
   * RAG question anchored to the selected line/card */
  const selPop = document.createElement("div");
  selPop.id = "sel-pop";
  selPop.className = "sel-pop hidden";
  selPop.innerHTML =
    '<button data-f="bold" title="Bold"><b>B</b></button>' +
    '<button data-f="italic" title="Italic"><i>I</i></button>' +
    '<button data-f="mark" title="Highlight"><span class="hl">H</span></button>' +
    '<button data-f="strike" title="Cross out"><span class="st">C</span></button>' +
    '<button data-f="ul" title="Bullet list">&#x2022;</button>' +
    '<button data-f="clear" title="Clear formatting">&#x2715;</button>' +
    '<span class="sel-sep"></span>' +
    '<input class="sel-ask" type="text" placeholder="ask ai…" spellcheck="false">';
  document.body.append(selPop);
  const selAsk = selPop.querySelector<HTMLInputElement>(".sel-ask")!;
  let selCtx: { text: string; el: HTMLElement; card: HTMLElement | null; range: Range } | null =
    null;
  let selPopTimer: number | undefined;
  let lastRange: Range | null = null; // last valid text selection — survives stray collapses
  const hideSelPop = () => {
    selPop.classList.add("hidden");
    selCtx = null;
  };
  // resurrect the stashed range when the live selection is gone — buttons can
  // never silently no-op on a collapsed selection again
  const restoreLastSel = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // live selection wins
    if (!lastRange) return;
    sel?.removeAllRanges();
    sel?.addRange(lastRange);
  };

  const updateSelPop = () => {
    // the 60ms debounce keeps the pop away mid-drag; keep it while the
    // user is typing the ask-ai question
    if (document.activeElement === selAsk) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideSelPop();
    const range = sel.getRangeAt(0);
    const anc = range.commonAncestorContainer;
    const ancEl = anc.nodeType === Node.ELEMENT_NODE ? (anc as HTMLElement) : anc.parentElement;
    if (!ancEl || !ancEl.closest("#note-body")) return hideSelPop();
    const card = ancEl.closest<HTMLElement>(".callout");
    if (card && !ancEl.closest(".callout-body")) return hideSelPop();
    if (ancEl.closest("button, input, textarea, select, .card-del, .card-pin, .card-move, .card-menu")) {
      return hideSelPop();
    }
    const r = range.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return hideSelPop();
    selCtx = {
      text: sel.toString().trim(),
      el: (card ??
        (ancEl.closest("p, li, h1, h2, h3, blockquote") as HTMLElement | null) ??
        ancEl) as HTMLElement,
      card,
      range: range.cloneRange(),
    };
    lastRange = selCtx.range;
    selPop.classList.remove("hidden");
    const w = selPop.offsetWidth;
    const h = selPop.offsetHeight;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const y = r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8;
    selPop.style.left = `${x}px`;
    selPop.style.top = `${y}px`;
  };

  // commands run against the captured selection — if anything collapsed it
  // between select→click, restore it first so the tool can never silently no-op
  const restoreSel = () => {
    if (!selCtx) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(selCtx.range);
  };
  selPop.addEventListener("mousedown", (e) => {
    if (e.target !== selAsk) e.preventDefault(); // keep the text selection alive
  });
  selPop.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.addEventListener("click", () => {
      const f = b.dataset.f;
      restoreSel();
      if (f === "bold") document.execCommand("bold");
      else if (f === "italic") document.execCommand("italic");
      else if (f === "strike") document.execCommand("strikeThrough");
      else if (f === "ul") document.execCommand("insertUnorderedList");
      else if (f === "mark") toggleMark(hlColor);
      else if (f === "clear") clearFormatting();
      markEdited();
      updateSelPop();
    });
  });
  selAsk.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      selAsk.value = "";
      hideSelPop();
      el.focus();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return;
    const q = selAsk.value.trim();
    if (!q || !selCtx) return;
    selAsk.value = "";
    const { text, el: anchorEl, card } = selCtx;
    hideSelPop();
    const topic = card?.dataset.topic ?? "";
    const target = topic.startsWith("rag: ") ? topic.slice(5).trim() : "all-files";
    const query = text ? `${q}\ncontext: "${text.slice(0, 400)}"` : q;
    const anchor = clean(anchorEl.textContent ?? "");
    showPencilAt(anchorEl);
    addActivity(`🔎 asking follow-up…`);
    void invoke("rag_ask", {
      note: current,
      target,
      query,
      quiet: true,
      anchor,
      parent: card?.dataset.cid,
      question: q,
      web: true,
    })
      .then(() => addActivity("✓ follow-up answered"))
      .catch((err) => {
        addActivity(`✕ ${String(err)}`);
        hidePencil();
        insertCallout(target, `> [!ai] rag failed: ${target}\n> ${String(err)}`, anchor);
      });
  });
  document.addEventListener("pointerdown", (e) => {
    if (selPop.classList.contains("hidden")) return;
    const t = e.target as HTMLElement;
    if (t.closest("#sel-pop")) return;
    // clicks inside the widget that owns the selection keep it alive — only
    // clicking outside/beside a widget may dismiss the highlight
    if (selCtx?.card && t.closest(".callout") === selCtx.card) return;
    hideSelPop();
  });
  // while a paper drag is live, re-assert the mask on every move — nothing
  // may strip it before the range is formed
  document.addEventListener("pointermove", (e) => {
    if (paperDrag && (e.buttons & 1)) el.classList.add("paper-selectall");
  });
  // contenteditable islands can ignore user-select:none mid-drag, so the
  // range is also clamped by hand: any end that reaches into a card snaps
  // back to the nearest paper text on that side
  const paperTextNodes = () => {
    const out: Text[] = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Text | null;
    while ((n = tw.nextNode() as Text | null)) {
      if (!n.parentElement?.closest(".callout") && (n.textContent ?? "").trim() !== "") out.push(n);
    }
    return out;
  };
  const clampPaperRange = () => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return;
    const r = s.getRangeAt(0);
    const cardOf = (n: Node) =>
      (n instanceof HTMLElement ? n : n.parentElement)?.closest?.(".callout") as HTMLElement | null;
    const startCard = cardOf(r.startContainer);
    const endCard = cardOf(r.endContainer);
    if (!startCard && !endCard) return;
    const nodes = paperTextNodes();
    let startNode: Text | Node = r.startContainer;
    let startOff = r.startOffset;
    let endNode: Text | Node = r.endContainer;
    let endOff = r.endOffset;
    if (startCard) {
      const after = nodes.find((t) => t.compareDocumentPosition(startCard) & Node.DOCUMENT_POSITION_PRECEDING);
      if (!after) return;
      startNode = after;
      startOff = 0;
    }
    if (endCard) {
      let before: Text | null = null;
      for (const t of nodes) {
        if (t.compareDocumentPosition(endCard) & Node.DOCUMENT_POSITION_FOLLOWING) before = t;
        else break;
      }
      if (!before) return;
      endNode = before;
      endOff = before.length;
    }
    const nr = document.createRange();
    try {
      nr.setStart(startNode, startOff);
      nr.setEnd(endNode, endOff);
    } catch {
      return; // ends crossed — leave the selection alone this frame
    }
    s.removeAllRanges();
    s.addRange(nr);
  };
  // the mirror clamp: a drag anchored in a widget keeps its range inside
  // that widget — any end that escapes snaps back to the card's own text
  const cardTextNodes = (card: HTMLElement) => {
    const out: Text[] = [];
    const tw = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n: Text | null;
    while ((n = tw.nextNode() as Text | null)) {
      if (n.parentElement?.closest("button")) continue;
      if ((n.textContent ?? "").trim() !== "") out.push(n);
    }
    return out;
  };
  const clampCardRange = (card: HTMLElement) => {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return;
    const r = s.getRangeAt(0);
    if (card.contains(r.startContainer) && card.contains(r.endContainer)) return;
    const nodes = cardTextNodes(card);
    if (!nodes.length) return;
    let startNode: Node = r.startContainer;
    let startOff = r.startOffset;
    let endNode: Node = r.endContainer;
    let endOff = r.endOffset;
    if (!card.contains(startNode)) {
      startNode = nodes[0];
      startOff = 0;
    }
    if (!card.contains(endNode)) {
      const last = nodes[nodes.length - 1];
      endNode = last;
      endOff = last.length;
    }
    const nr = document.createRange();
    try {
      nr.setStart(startNode, startOff);
      nr.setEnd(endNode, endOff);
    } catch {
      return; // ends crossed — leave the selection alone this frame
    }
    s.removeAllRanges();
    s.addRange(nr);
  };
  const endDrag = () => {
    const card = cardDrag;
    paperDrag = false;
    cardDrag = null;
    if (card) clampCardRange(card);
    else clampPaperRange();
    window.setTimeout(() => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) el.classList.remove("paper-selectall");
    }, 0);
  };
  document.addEventListener("pointerup", () => {
    endDrag();
    window.setTimeout(updateSelPop, 30); // let the selection settle first
  });
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("selectionchange", () => {
    if (cardDrag) clampCardRange(cardDrag);
    else if (paperDrag || el.classList.contains("paper-selectall")) clampPaperRange();
    clearTimeout(selPopTimer);
    selPopTimer = window.setTimeout(updateSelPop, 60);
    if (cmdPick) refreshCmdPick();
    const s = window.getSelection();
    if ((!s || s.isCollapsed) && !paperDrag) el.classList.remove("paper-selectall");
  });
  // any fresh click is a new selection intent — drop the widget mask so
  // selecting inside a card works again
  document.addEventListener("pointerdown", () => {
    paperDrag = false;
    cardDrag = null;
    el.classList.remove("paper-selectall");
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift" || e.key.startsWith("Arrow")) updateSelPop(); // keyboard selections
  });
  window.addEventListener("resize", () => scheduleCardLinks());
  // right-click shows the tool popover instead of a browser menu; with a
  // collapsed caret it first selects the word under the cursor (Word-style)
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel?.isCollapsed) {
      const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (caret && caret.startContainer.parentElement?.closest("#note-body")) {
        sel?.setBaseAndExtent(
          caret.startContainer, caret.startOffset, caret.startContainer, caret.startOffset,
        );
        sel?.modify?.("move", "backward", "word");
        sel?.modify?.("extend", "forward", "word");
      }
    }
    updateSelPop();
    if (!selPop.classList.contains("hidden")) {
      const w = selPop.offsetWidth;
      const h = selPop.offsetHeight;
      selPop.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - w - 8))}px`;
      selPop.style.top = `${Math.min(e.clientY + 6, window.innerHeight - h - 8)}px`;
    }
  });

  $("#note-title").addEventListener("click", () => startRename());

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  });

  armPeek();
  // frontmatter properties panel — add/remove rows (value edits reach
  // markEdited via the bubbling `input` listener like any other edit)
  el.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).closest?.(".fm-props")) markEdited();
  });
  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const panel = t.closest(".fm-props");
    if (!panel) return;
    if (t.closest(".fm-add")) {
      const row = document.createElement("div");
      row.className = "fm-row";
      row.innerHTML =
        `<input class="fm-k" spellcheck="false" placeholder="key"/>` +
        `<input class="fm-v" spellcheck="false" placeholder="value"/>` +
        `<button class="fm-x" title="remove property" tabindex="-1">✕</button>`;
      panel.insertBefore(row, panel.querySelector(".fm-add"));
      markEdited();
      row.querySelector<HTMLInputElement>(".fm-k")?.focus();
    } else if (t.closest(".fm-x")) {
      t.closest(".fm-row")?.remove();
      markEdited();
    }
  });
  el.addEventListener("click", (e) => {
    const w = (e.target as HTMLElement).closest?.(".wikilink") as HTMLElement | null;
    if (w) {
      e.preventDefault();
      void openWikiNote(w.dataset.note ?? "");
      return;
    }
    const a = (e.target as HTMLElement).closest("[data-url]") as HTMLElement | null;
    /* a card's own data-url is its state (browser cards keep the live page
     * url on the element) — matching it here would navigate the card to
     * itself on every stray click inside it, i.e. a reload */
    if (!a || a.classList.contains("callout")) return;
    const card = a.closest(".callout") as HTMLElement | null;
    if (card?.dataset.justdragged) return;
    const inCard = !!card;
    if (inCard || e.ctrlKey) {
      e.preventDefault();
      const url = a.dataset.url ?? "";
      if (!/^https?:\/\//i.test(url)) return;
      // note links open in the app's real browser — never the OS browser
      const open = Array.from(document.querySelectorAll<HTMLElement>(".browser-card")).find(
        (c) => browserApi(c),
      );
      if (open) {
        void browserApi(open)!.navigate(url);
        open.scrollIntoView({ block: "nearest", behavior: "smooth" });
        open.style.zIndex = String(nextZ());
      } else {
        spawnBrowserCard(url.split("/")[2] ?? "browser", url);
      }
    }
  });

  window.addEventListener("resize", () => {
    clearTimeout(snapTimer);
    snapTimer = window.setTimeout(flowAroundCards, 150);
  });

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  // image paste — a screenshot on the clipboard becomes a vault
  // attachment + an ![](attachments/…) line, never inline base64
  el.addEventListener("paste", (e) => {
    if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgItem = Array.from(items).find((i) => i.type.startsWith("image/"));
    if (!imgItem) return;
    const f = imgItem.getAsFile();
    if (!f) return;
    e.preventDefault();
    const anchorBlock = (window.getSelection()?.anchorNode instanceof Element
      ? (window.getSelection()!.anchorNode as Element)
      : window.getSelection()?.anchorNode?.parentElement
    )?.closest("p, li, h1, h2, h3, blockquote") as HTMLElement | null;
    const fr = new FileReader();
    fr.onload = async () => {
      const b64 = S(fr.result);
      try {
        const rel = await invoke<string>("asset_save", { b64 });
        insertImageAsset(rel, anchorBlock);
        addActivity(`img → ${rel}`);
      } catch (err) {
        setState(`image save failed: ${String(err)}`);
      }
    };
    fr.readAsDataURL(f);
  });

  // dropping a file onto the note copies it into attachments/ and embeds it
  el.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const isImg = f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
    if (!isImg) return;
    e.preventDefault();
    e.stopPropagation();
    const srcPath = (f as File & { path?: string }).path;
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest("p, li, h1, h2, h3, blockquote") as HTMLElement | null;
    if (srcPath) {
      void invoke<string>("asset_save", { src: srcPath })
        .then((rel) => { insertImageAsset(rel, under); addActivity(`img → ${rel}`); })
        .catch((err) => setState(`image save failed: ${String(err)}`));
    } else {
      const fr = new FileReader();
      fr.onload = async () => {
        try {
          const rel = await invoke<string>("asset_save", { b64: S(fr.result) });
          insertImageAsset(rel, under);
          addActivity(`img → ${rel}`);
        } catch (err) {
          setState(`image save failed: ${String(err)}`);
        }
      };
      fr.readAsDataURL(f);
    }
  });

  window.addEventListener("blur", () => void save());
  window.addEventListener("pagehide", () => {
    if (dirty) void save();
  });
  window.setInterval(() => {
    if (dirty) void save();
  }, 15000);
}
