import { $, invoke } from "./ipc.js";
import { renderMarkdown, renderCalloutMd } from "./render.js";
import { addActivity } from "./log.js";
import { serialize, toggleMark, clearFormatting, cardToMd, focusBodyOnCardClick, normalizeCard, nbspWidth, insertTabIndent } from "./editable.js";
import { t } from "./i18n.js";

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
  if (card.classList.contains("floating")) return;
  const editor = body();
  const floating = Array.from(editor.querySelectorAll(".callout.floating")) as HTMLElement[];
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

function markEdited() {
  dirty = true;
  setState(t("ed.saving"));
  clearTimeout(timer);
  timer = window.setTimeout(() => void save(), 800);
  scheduleFlow();
}

/* ---------- text wraps beside floating cards ---------- */

const FLOW_TAGS = new Set(["P", "H1", "H2", "H3", "UL", "OL", "BLOCKQUOTE"]);

/** Cards have arbitrary heights — snap their bottom margin up to the next
 *  26px rule so every block after them starts back on the line grid. */
function snapCardsToGrid(kids: HTMLElement[]) {
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (
      !k.classList.contains("callout") ||
      k.classList.contains("floating") ||
      k.classList.contains("drag-gap")
    )
      continue;
    const m = (k.offsetTop + k.offsetHeight - 12) % 26;
    let mb = (26 - m) % 26;
    if (mb < 8) mb += 26; // keep a visible gap under the card
    // a heading's 26px margin-top collapses with ours — make ours win
    if (mb <= 26) {
      for (let j = i + 1; j < kids.length; j++) {
        const n = kids[j];
        if (n.classList.contains("floating") || n.classList.contains("drag-gap"))
          continue;
        if (/^H[123]$/.test(n.tagName)) mb += 26;
        break;
      }
    }
    k.style.marginBottom = `${mb}px`;
  }
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
  const floats = kids.filter(
    (k) => k.classList.contains("floating") && !k.classList.contains("dragging"),
  );
  const texts = kids.filter(
    (k) => FLOW_TAGS.has(k.tagName) && !k.classList.contains("drag-gap"),
  );
  for (const k of texts) {
    k.style.paddingLeft = "";
    k.style.paddingRight = "";
    if (k.dataset.fdrop) {
      k.style.marginTop = "";
      delete k.dataset.fdrop;
    }
  }
  if (!floats.length) return;
  const pageW = el.clientWidth;
  for (const k of texts) {
    const kt = k.offsetTop;
    const kb = kt + k.offsetHeight;
    const band = floats.filter(
      (f) => kb > f.offsetTop && kt < f.offsetTop + f.offsetHeight,
    );
    if (!band.length) continue;
    let padL = 0;
    let padR = 0;
    for (const f of band) {
      const left = f.offsetLeft;
      const right = left + f.offsetWidth;
      if ((left + right) / 2 < pageW / 2) {
        padL = Math.max(padL, right + 12 - k.offsetLeft);
      } else {
        padR = Math.max(padR, k.offsetLeft + k.offsetWidth - (left - 12));
      }
    }
    padL = Math.max(0, padL);
    padR = Math.max(0, padR);
    if (k.offsetWidth - padL - padR >= FLOW_MIN_TEXT) {
      if (padL > 0) k.style.paddingLeft = `${Math.round(padL)}px`;
      if (padR > 0) k.style.paddingRight = `${Math.round(padR)}px`;
      continue;
    }
    // no room beside the cards — drop the line below the lowest float,
    // snapped to the 26px rule grid so the text still sits on a line
    const bot = Math.max(...band.map((f) => f.offsetTop + f.offsetHeight));
    const drop = Math.ceil((bot - kt + 4) / 26) * 26;
    if (drop > 0) {
      k.style.marginTop = `${drop}px`;
      k.dataset.fdrop = "1";
    }
  }
}

let flowQueued = false;
function scheduleFlow() {
  if (flowQueued) return;
  flowQueued = true;
  requestAnimationFrame(() => {
    flowQueued = false;
    flowAroundCards();
    drawCardLinks();
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
  const caretX = rects[rects.length - 1]?.left;
  if (caretX == null || e.clientX <= caretX + 4) return;
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

/* ---------- command-line loader: 4 wandering dots + a pulsing center
   replace the line's text while a command runs (from loader.html) ------- */

const CL_SIZE = 34;
const CL_DOT = 5;

function startCmdLoader(block: HTMLElement) {
  stopCmdLoader(block);
  const inCard = !!block.closest(".callout");
  const stage = document.createElement("span");
  stage.className = "cmd-loader";
  stage.contentEditable = "false";
  const max = CL_SIZE - CL_DOT;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const eases = [
    "cubic-bezier(.68,-0.55,.27,1.55)",
    "cubic-bezier(.22,1,.36,1)",
    "cubic-bezier(.45,0,.55,1)",
    "cubic-bezier(.34,1.56,.64,1)",
    "ease-in-out",
    "ease-out",
  ];
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const timers: number[] = [];
  const wander = (d: HTMLElement) => {
    const dur = rand(0.5, 1.8);
    d.style.transition = `transform ${dur}s ${pick(eases)}`;
    d.style.transform = `translate(${rand(0, max)}px, ${rand(0, max)}px) scale(${rand(0.6, 1.5)})`;
    timers.push(window.setTimeout(() => wander(d), dur * 1000 * rand(0.7, 1)));
  };
  const pulse = (c: HTMLElement) => {
    const dur = rand(0.4, 1.4);
    c.style.transition = `transform ${dur}s ${pick(eases)}`;
    c.style.transform = `scale(${rand(0.2, 1.15)})`;
    timers.push(window.setTimeout(() => pulse(c), dur * 1000));
  };
  for (let i = 0; i < 4; i++) {
    const d = document.createElement("span");
    d.className = "cl-dot";
    const sx = i % 2 ? max : 0;
    const sy = i > 1 ? max : 0;
    d.style.transform = `translate(${sx}px, ${sy}px)`;
    stage.append(d);
    timers.push(window.setTimeout(() => wander(d), 50 + i * 120));
  }
  const c = document.createElement("span");
  c.className = "cl-center";
  stage.append(c);
  pulse(c);
  (stage as unknown as { _stop: () => void })._stop = () => timers.forEach(clearTimeout);
  if (inCard) {
    // a card anchor would go blank if we hid its text — the dots just overlay it
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
  if (!pencilBlock) return;
  stopCmdLoader(pencilBlock);
  const cmd = pencilBlock.querySelector(".cmd-word");
  const word = cmd?.textContent ?? "@research";
  pencilBlock.querySelector(".pencil")?.remove();
  if (cmd) cmd.replaceWith(document.createTextNode(word));
  pencilBlock.normalize();
  pencilBlock = null;
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
  if (s.w && s.h) {
    card.style.width = `${s.w}px`;
    card.style.height = `${s.h}px`;
    card.style.marginLeft = `${s.ml ?? 0}px`;
    card.style.marginTop = `${s.mt ?? 0}px`;
    card.classList.add("sized");
  }
  if (s.x !== undefined && s.y !== undefined) {
    card.classList.add("floating");
    card.style.left = `${s.x}px`;
    card.style.top = `${s.y}px`;
    card.style.marginTop = "0px";
    card.style.marginLeft = "0px";
  }
  // a generated card keeps its stacking slot across reloads — newest on top
  // until an even newer card is generated
  if (s.z) {
    card.style.zIndex = String(s.z);
    genZ = Math.max(genZ, s.z);
  }
  if (s.pinned) {
    card.classList.add("pinned");
    card.style.zIndex = "7";
    card.style.overflow = "visible";
    pinMark(card);
    applyPinColor(card, PIN_COLORS[s.pinc ?? 0] ?? "red");
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
    card.style.zIndex = "9";
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
        drawCardLinks();
      };
      const up = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("pointerup", up);
        saveCardBox(card);
        scheduleFlow();
      };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up);
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
    drawCardLinks();
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
    drawCardLinks();
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
    const immediate = !isSticky() && !!t.closest(".callout-head");
    sx = e.clientX;
    sy = e.clientY;
    const startDrag = () => {
      hold = undefined;
      card.classList.remove("holding");
      dragging = true;
      const r = card.getBoundingClientRect();
      const editor = body();
      const er = editor.getBoundingClientRect();
      fx = (r.left - er.left) / Z() + editor.scrollLeft;
      fy = (r.top - er.top) / Z() + editor.scrollTop;
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
  card.querySelectorAll(".card-del, .card-pin, .card-stick").forEach((b) => b.remove());
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
  const title = (card.dataset.title ?? card.querySelector(".callout-title")?.textContent ?? "").trim();
  const bodyEl = card.querySelector<HTMLElement>(".callout-body");
  const text = [title, bodyEl?.innerText ?? ""].join(". ").replace(/\s+/g, " ").trim();
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  u.onend = () => btn.classList.remove("speaking");
  u.onerror = () => btn.classList.remove("speaking");
  btn.classList.add("speaking");
  window.speechSynthesis.speak(u);
}

function enhanceCard(card: HTMLElement) {
  normalizeCard(card);
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
  makeResizable(card);
  makeDraggable(card);
  restoreCardState(card);
  focusBodyOnCardClick(card);
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
    drawCardLinks();
    markEdited();
  });
  card.append(del);
  if (!card.classList.contains("sticky") && !card.querySelector(".card-pin")) {
    const pinBtn = document.createElement("button");
    pinBtn.className = "card-pin";
    pinBtn.textContent = "⌖";
    pinBtn.title = "Pin this card in place";
    pinBtn.contentEditable = "false";
    pinBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(card);
    });
    card.append(pinBtn);
  }
  if (!card.querySelector(".card-tts")) {
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
    card.append(tts);
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
    card.append(st);
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
    card.append(mv);
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
    card.append(mn);
  }
  // widget chrome must never capture Tab from the text
  card.querySelectorAll("button").forEach((b) => (b.tabIndex = -1));
}

/* ---------- card links: a "nylon" thread drawn pin-to-pin from a source
   card to each follow-up card it spawned. The canvas lives inside
   #note-body so it scrolls with the content automatically --------------- */

let linksCv: HTMLCanvasElement | null = null;

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

const CMD_TOKEN = /(^|\s)@(document|ask|skill|research|recall|tasks|related|loop|summary)\b/;

/** the typed @command line is a receipt for the run — once its answer card
 *  exists the line is redundant: cut from the @ token to end-of-line and
 *  return whatever text precedes it ("" means the block held only the
 *  command and should be dropped entirely) */
function stripCommandText(block: HTMLElement): string {
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
  const base = name.trim();
  if (!base) return;
  const file = /\.(laido|md)$/.test(base) ? base : `${base}.laido`;
  try {
    const list = await invoke<Array<{ name: string }>>("vault_list");
    if (!list.some((n) => n.name === file)) {
      await invoke("vault_write", { name: file, content: "" });
      addActivity(`📄 created ${file}`);
    }
    await loadNote(file);
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
  }
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
  let target: HTMLElement | null = null;
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (clean(child.textContent ?? "") === needle) {
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
      : stripCommandText(target).trim();
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
  card.style.zIndex = String(++genZ);
  writeState(card, { x, y, pinned: 0, z: genZ });
  avoidOverlap(card);
  scheduleFlow();
  requestAnimationFrame(drawCardLinks);
  dirty = true;
  setState(t("ed.saving"));
  void save();
  return card;
}

/** pin a card in place without the toggle semantics — used for research-loop
 *  cards so every successful loop stays put (cascade keeps them readable) */
export function pinCard(card: HTMLElement, cascade = 0) {
  if (card.classList.contains("pinned")) return;
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
  card.style.zIndex = "9";
  card.style.overflow = "visible";
  writeState(card, { x, y, pinned: 1 });
  pinMark(card);
  const pinc = pickPinColor();
  applyPinColor(card, PIN_COLORS[pinc]);
  writeState(card, { pinc });
  scheduleFlow();
  markEdited();
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
    card.style.zIndex = "9";
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
  current = "";
  $("#note-title").textContent = "—";
  body().innerHTML = "";
  dirty = false;
  setState("");
}

export async function loadNote(name: string) {
  hidePencil();
  current = name;
  const md = await invoke<string>("vault_read", { name });
  $("#note-title").textContent = titleName(name);
  const el = body();
  el.innerHTML = renderMarkdown(md);
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
    drawCardLinks();
  });
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
}

async function maybeSkillPicker() {
  const pop = $("#skill-pop");
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
    pop.classList.add("hidden");
    return;
  }
  const node = sel.anchorNode;
  if (!node || !body().contains(node)) {
    pop.classList.add("hidden");
    return;
  }
  const text = node.textContent ?? "";
  const before = text.slice(0, sel.anchorOffset);
  const m = before.match(/@(skill|document)\s*$/);
  if (!m) {
    pop.classList.add("hidden");
    return;
  }
  await showCommandPicker(m[1] as "skill" | "document");
}

/** picker for bare @document (library files) / @skill (saved skills only) */
async function showCommandPicker(mode: "skill" | "document") {
  const pop = $("#skill-pop");
  if (!pop.classList.contains("hidden")) return;
  const list = mode === "skill" ? await invoke<SkillRow[]>("skills_list") : [];
  pop.innerHTML = "";
  if (mode === "skill" && list.length === 0) {
    const e = document.createElement("div");
    e.className = "menu-sub";
    e.textContent = "no skills yet";
    pop.append(e);
  }
  interface RagRow {
    slug: string;
    name: string;
    chunks: number;
  }
  // @skill is for saved routines — library files only belong to @document
  let files: RagRow[] = [];
  if (mode === "document") {
    try {
      files = await invoke<RagRow[]>("rag_list");
    } catch {
      files = [];
    }
  }
  if (files.length > 0) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = "Files";
    pop.append(label);
    const addFile = (slug: string, label2: string) => {
      const b = document.createElement("button");
      b.className = "skill-item";
      const n = document.createElement("span");
      n.className = "skill-name";
      n.textContent = slug;
      const d = document.createElement("span");
      d.className = "skill-desc";
      d.textContent = label2;
      b.append(n, d);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => insertCmdName(mode, `${slug} `));
      pop.append(b);
    };
    addFile("my-notes", "your own notes — ask everything you wrote");
    addFile("everything", "library files + your notes");
    addFile("all-files", `every document · ${files.length} files`);
    for (const f of files) addFile(f.slug, `${f.name} · ${f.chunks} chunks`);
  }
  for (const s of list) {
    const b = document.createElement("button");
    b.className = "skill-item";
    const n = document.createElement("span");
    n.className = "skill-name";
    n.textContent = s.name;
    const d = document.createElement("span");
    d.className = "skill-desc";
    d.textContent = s.description || `${s.steps.length} steps`;
    b.append(n, d);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => insertCmdName("skill", s.name));
    pop.append(b);
  }
  pop.classList.remove("hidden");
  placeAtCaret(pop);
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

/* ---------- @-mention popup: tools + library files while typing ---------- */

interface MentionItem {
  label: string;
  desc: string;
  insert: string;
}

interface Mention {
  node: Text;
  start: number;
  end: number;
  partial: string;
}

/** the live "@<partial>" immediately before a collapsed caret, if any */
function currentMention(): Mention | null {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const host = (node as Text).parentElement;
  if (!host?.closest("#note-body") || host.closest(".callout")) return null;
  const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
  const m = before.match(/@([\w-]*)$/);
  if (!m) return null;
  return {
    node: node as Text,
    start: sel.anchorOffset - m[0].length,
    end: sel.anchorOffset,
    partial: m[1],
  };
}

const MENTION_TOOLS: MentionItem[] = [
  { label: "@research", desc: "deep research — your files + the web", insert: "@research " },
  { label: "@document", desc: "ask a question to your library files", insert: "@document " },
  { label: "@skill", desc: "run a saved skill", insert: "@skill " },
];

let mentionFiles: Array<{ slug: string; name: string; chunks: number }> = [];
let mentionItems: MentionItem[] = [];
let mentionActive = 0;
let mentionOpen = false;

const mentionPop = () => $("#mention-pop") as HTMLDivElement;

async function updateMentionPop() {
  const pop = mentionPop();
  const m = currentMention();
  if (!m) {
    pop.classList.add("hidden");
    mentionOpen = false;
    return;
  }
  if (!mentionOpen) {
    mentionOpen = true; // fresh file list each time the pop opens
    mentionFiles = await invoke<Array<{ slug: string; name: string; chunks: number }>>(
      "rag_list",
    ).catch(() => []);
  }
  const p = m.partial.toLowerCase();
  // library files belong to @document/@ask only — a bare @ lists the tools,
  // and the file list appears once the line is already inside a document ask
  const before = (m.node.textContent ?? "").slice(0, m.start);
  const docMode = /(^|\s)@(document|ask)\s+$/.test(before);
  mentionItems = docMode
    ? [
        ...(p === "" || "my-notes".startsWith(p)
          ? [
              {
                label: "@my-notes",
                desc: "your own notes — ask everything you wrote",
                insert: "@my-notes ",
              },
            ]
          : []),
        ...(p === "" || "everything".startsWith(p)
          ? [
              {
                label: "@everything",
                desc: "library files + your notes",
                insert: "@everything ",
              },
            ]
          : []),
        ...(p === "" || "all-files".startsWith(p)
          ? [
              {
                label: "@all-files",
                desc: `every document · ${mentionFiles.length} files`,
                insert: "@all-files ",
              },
            ]
          : []),
        ...mentionFiles
          .filter((f) => f.slug.toLowerCase().includes(p) || f.name.toLowerCase().includes(p))
          .map((f) => ({
            label: `@${f.slug}`,
            desc: `${f.name} · ${f.chunks} chunks`,
            insert: `@${f.slug} `,
          })),
      ]
    : MENTION_TOOLS.filter((t) => !p || t.label.slice(1).startsWith(p));
  if (!mentionItems.length) {
    pop.classList.add("hidden");
    return;
  }
  mentionActive = Math.min(mentionActive, mentionItems.length - 1);
  pop.innerHTML = "";
  const lbl = document.createElement("div");
  lbl.className = "menu-label";
  lbl.textContent = docMode ? "Library files" : "Tools";
  pop.append(lbl);
  mentionItems.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "skill-item" + (i === mentionActive ? " active" : "");
    const n = document.createElement("span");
    n.className = "skill-name";
    n.textContent = it.label;
    const d = document.createElement("span");
    d.className = "skill-desc";
    d.textContent = it.desc;
    b.append(n, d);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => acceptMention(it));
    pop.append(b);
  });
  pop.classList.remove("hidden");
  placeAtCaret(pop);
}

function acceptMention(it: MentionItem) {
  const m = currentMention();
  if (!m) return;
  const range = document.createRange();
  range.setStart(m.node, m.start);
  range.setEnd(m.node, m.end);
  range.deleteContents();
  const t = document.createTextNode(it.insert);
  range.insertNode(t);
  const after = document.createRange();
  after.setStartAfter(t);
  after.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(after);
  mentionPop().classList.add("hidden");
  mentionActive = 0;
  markEdited();
  // picking @document flows straight into the library file list
  if (it.insert.trim() === "@document") void showCommandPicker("document");
}

/** keyboard nav for the open mention pop — returns true when the key was eaten */
function mentionKey(e: KeyboardEvent): boolean {
  const pop = mentionPop();
  if (pop.classList.contains("hidden")) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    mentionActive = (mentionActive + 1) % mentionItems.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    mentionActive = (mentionActive - 1 + mentionItems.length) % mentionItems.length;
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const it = mentionItems[mentionActive];
    if (it) acceptMention(it);
    return true;
  } else if (e.key === "Escape") {
    e.preventDefault();
    pop.classList.add("hidden");
    return true;
  } else {
    return false;
  }
  pop.querySelectorAll(".skill-item").forEach((b, i) =>
    b.classList.toggle("active", i === mentionActive),
  );
  return true;
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

function insertCmdName(cmd: "skill" | "document", name: string) {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const node = sel.anchorNode;
    const off = sel.anchorOffset;
    if (node && node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const m = text.slice(0, off).match(/@(skill|document)\s*$/);
      if (m) {
        const range = document.createRange();
        range.setStart(node, off - m[0].length);
        range.setEnd(node, off);
        range.deleteContents();
        const t = document.createTextNode(`@${cmd} ${name}`);
        range.insertNode(t);
        const after = document.createRange();
        after.setStartAfter(t);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
    }
  }
  $("#skill-pop").classList.add("hidden");
  markEdited();
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
  el.querySelectorAll(".grip, .card-del").forEach((n) => n.remove());
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
  if (!api?.WebviewWindow) {
    addActivity("✕ cannot open a new window in this build");
    return false;
  }
  const label = `sticky-${id}`;
  try {
    const existing = await api.WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return false;
    }
  } catch {
    /* older runtime: fall through and try to create */
  }
  try {
    new api.WebviewWindow(label, {
      url: `index.html?sticky=~${encodeURIComponent(id)}`,
      width: 270,
      height: 250,
      x,
      y,
      center: x === undefined || y === undefined,
      alwaysOnTop: true,
      decorations: false,
      resizable: true,
      title: "Laido sticky",
    });
    return true;
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
    return false;
  }
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

export function initEditor() {
  const el = body();
  document.execCommand("defaultParagraphSeparator", false, "p");

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
    drawCardLinks();
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
    drawCardLinks();
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

  el.addEventListener("input", () => {
    markEdited();
    void maybeSkillPicker();
    void updateMentionPop();
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
    const need = Math.max(1, clicked - lines + 1);
    if (need > 40) {
      if (last) placeCaretAtEnd(last);
      return;
    }
    for (let i = 0; i < need; i++) {
      const p = document.createElement("p");
      p.append(document.createElement("br"));
      el.append(p);
    }
    markEdited();
    const caret = el.lastElementChild as HTMLElement | null;
    if (caret) placeCaretAtEnd(caret);
  });

  // click to the right of a line's text end → pad with nbsp and type there
  el.addEventListener("mouseup", clickAndType);

  el.addEventListener("keydown", (e) => {
    // the open @-mention pop owns arrows/enter/tab/escape until it closes
    if (mentionKey(e)) return;
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
    // the @command may sit anywhere on the line — indented, click-padded, or
    // after other text — so run from the first known command token
    const tok = raw.match(
      /(^|\s)@(document|ask|skill|research|schedule|recall|tasks|related|loop|summary)\b/,
    );
    const command = tok ? raw.slice(tok.index).trimStart() : raw;
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
      void showCommandPicker("document");
      return;
    }
    const ragMatch = command.match(/^@skill\s+(@?\S+)\s+(.+)$/);
    if (ragMatch && current) {
      e.preventDefault();
      const target = ragMatch[1].replace(/^@/, "");
      const query = ragMatch[2];
      showPencil(block);
      addActivity(`🔎 asking ${target}…`);
      void invoke("rag_ask", { note: current, target, query, quiet: true, anchor: raw, question: query })
        .then(() => addActivity(`✓ answered from ${target}`))
        .catch((err) => {
          addActivity(`✕ ${String(err)}`);
          hidePencil();
          insertCallout(target, `> [!ai] rag failed: ${target}\n> ${String(err)}`, raw);
        });
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
      void showCommandPicker("skill");
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
    void updateMentionPop();
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
  window.addEventListener("resize", () => drawCardLinks());
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

  el.addEventListener("click", (e) => {
    const w = (e.target as HTMLElement).closest?.(".wikilink") as HTMLElement | null;
    if (w) {
      e.preventDefault();
      void openWikiNote(w.dataset.note ?? "");
      return;
    }
    const a = (e.target as HTMLElement).closest("[data-url]") as HTMLElement | null;
    if (!a) return;
    const card = a.closest(".callout") as HTMLElement | null;
    if (card?.dataset.justdragged) return;
    const inCard = !!card;
    if (inCard || e.ctrlKey) {
      e.preventDefault();
      void invoke("open_url", { url: a.dataset.url });
    }
  });

  window.addEventListener("resize", () => {
    clearTimeout(snapTimer);
    snapTimer = window.setTimeout(flowAroundCards, 150);
  });

  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  window.addEventListener("blur", () => void save());
  window.addEventListener("pagehide", () => {
    if (dirty) void save();
  });
  window.setInterval(() => {
    if (dirty) void save();
  }, 15000);
}
