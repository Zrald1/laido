/* ---------- Laido Decks — a PowerPoint-style slide widget on the note ----------
 * Storage: `> [!slides] title` callout; `[!slide <layout>]` separators; body
 * lines are markdown-ish (`# title`, `- bullet`, `img: path`, `~ note`).
 * Phase 1: 8 layouts, 8 themes, 5 transitions, slide CRUD/reorder, inline
 * editing, present mode, ` ```slides ` AI verbs via deckApi. See plan.md §8. */

import { invoke } from "./ipc.js";
import { paintChart, fromSheetRange } from "./chart.js";
import { addActivity } from "./log.js";
import { pickOpen, pickSave } from "./sheet.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };

const intIdx = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : -1;

/** a freeform object on a slide — text box, shape, or picture.
 *  x/y/w/h are % of the slide box; serialized as an `el:` line. */
export interface SlideEl {
  kind: string; // "text" | "shape" | "img"
  x: number; y: number; w: number; h: number;
  shape: string;  // kind=shape: DECK_SHAPES key
  text: string;   // text-box content / shape label / img caption
  fill: string;   // shape fill
  line: string;   // outline color
  color: string;  // text ink
  size: number;   // font px (0 = auto)
  src: string;    // img source (vault-relative or absolute)
  rot: number;    // degrees
  bold: boolean; ital: boolean;
  align: string;  // "l"|"c"|"r"
}

export const newEl = (kind: string, shape = ""): SlideEl => ({
  kind, shape,
  x: 30, y: 40, w: 40, h: 16,
  text: "", fill: "", line: "", color: "", size: 0,
  src: "", rot: 0, bold: false, ital: false, align: "",
});

export interface Slide {
  layout: string;
  title: string;
  sub: string;
  bullets: string[];
  body: string;
  img: string;
  note: string;
  bg: string;
  cols: [string[], string[]]; // two-col content
  quote: string;
  by: string;
  chart: string; // viz type for `chart` layout
  csrc: string;  // live "sheet A1:B9" source for `chart` layout
  els: SlideEl[]; // freeform insert objects (text boxes, shapes, pictures)
}

export const emptySlide = (layout = "bullets"): Slide => ({
  layout: typeof layout === "string" ? layout : "bullets",
  title: "",
  sub: "",
  bullets: [],
  body: "",
  img: "",
  note: "",
  bg: "",
  chart: "",
  csrc: "",
  cols: [[], []],
  quote: "",
  by: "",
  els: [],
});

export const DECK_LAYOUTS = [
  "title", "section", "bullets", "twocol", "image", "quote", "bigfact", "chart", "blank",
] as const;

/* shape gallery — PowerPoint's Insert → Shapes, kept to the everyday set.
 * `clip` is a clip-path polygon; `rad` a border-radius; `bar` renders the
 * fill as a centered bar (lines) instead of the full box. */
export const DECK_SHAPES: Record<string, { label: string; clip?: string; rad?: string; bar?: boolean }> = {
  rect:    { label: "rectangle" },
  round:   { label: "rounded rect", rad: "14%" },
  pill:    { label: "pill", rad: "999px" },
  ellipse: { label: "oval", rad: "50%" },
  line:    { label: "line", bar: true },
  tri:     { label: "triangle", clip: "polygon(50% 0,100% 100%,0 100%)" },
  rtri:    { label: "right triangle", clip: "polygon(0 0,100% 100%,0 100%)" },
  diamond: { label: "diamond", clip: "polygon(50% 0,100% 50%,50% 100%,0 50%)" },
  pent:    { label: "pentagon", clip: "polygon(50% 0,100% 38%,82% 100%,18% 100%,0 38%)" },
  hex:     { label: "hexagon", clip: "polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)" },
  star:    { label: "star", clip: "polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)" },
  arrow:   { label: "arrow →", clip: "polygon(0 35%,58% 35%,58% 0,100% 50%,58% 100%,58% 65%,0 65%)" },
  darrow:  { label: "arrow ↔", clip: "polygon(0 50%,15% 0,15% 35%,85% 35%,85% 0,100% 50%,85% 100%,85% 65%,15% 65%,15% 100%)" },
  uarrow:  { label: "arrow ↑", clip: "polygon(50% 0,100% 42%,66% 42%,66% 100%,34% 100%,34% 42%,0 42%)" },
  chevron: { label: "chevron", clip: "polygon(0 0,72% 0,100% 50%,72% 100%,0 100%,28% 50%)" },
  banner:  { label: "ribbon", clip: "polygon(0 0,100% 0,88% 50%,100% 100%,0 100%,12% 50%)" },
  callout: { label: "speech bubble", clip: "polygon(6% 0,94% 0,100% 8%,100% 68%,56% 68%,38% 100%,42% 68%,0 68%,0 8%)" },
};

/** a user-created toolbar tool — a named stamp of one or more elements.
 * Persisted per-deck as a `> [!tool] {json}` meta line; `els` positions are
 * percent of the tool box the user drags out on the slide. */
export interface DeckTool {
  name: string;
  icon: string;
  els: SlideEl[];
}

/** color whitelist for anything that lands in a style attribute — hex,
 * rgb()/hsl(), or a plain css name. Blocks `;`/`url()`/`expression()`
 * injections from hostile markdown `el:` lines and AI-generated tools. */
const COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.]{1,5}%?(?:\s*,\s*[\d.]{1,5}%?){2,3}\s*\)|hsla?\(\s*[\d.]{1,5}(?:deg)?(?:\s*,\s*[\d.]{1,5}%?){2,3}\s*\)|[a-z]{3,20})$/i;
const cssColor = (v: unknown): string => {
  const s = S(v).trim().slice(0, 40);
  return COLOR_RE.test(s) ? s : "";
};

const clampN = (v: unknown, lo: number, hi: number): number => {
  const n = num(v);
  return Math.min(hi, Math.max(lo, n));
};

/** sanitize one template element from an AI reply / stored tool — unknown
 * fields drop, numbers clamp, colors whitelist, unsafe srcs strip */
const sanitizeTplEl = (raw: unknown): SlideEl | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  let kind = S(o.kind).toLowerCase();
  if (kind === "shape" && !DECK_SHAPES[S(o.shape).toLowerCase()]) kind = "text";
  if (kind !== "text" && kind !== "shape" && kind !== "img") return null;
  const el = newEl(kind);
  el.shape = kind === "shape" ? S(o.shape).toLowerCase() : "";
  el.x = clampN(o.x, 0, 98); el.y = clampN(o.y, 0, 98);
  el.w = clampN(o.w, 2, 100); el.h = clampN(o.h, 1, 100);
  el.text = S(o.text).slice(0, 240);
  el.fill = cssColor(o.fill); el.line = cssColor(o.line); el.color = cssColor(o.color);
  el.size = clampN(o.size, 0, 120);
  el.rot = clampN(o.rot, -360, 360);
  const src = S(o.src).trim().slice(0, 400);
  el.src = kind === "img" && (/^https?:\/\//i.test(src) || (/^[\w .\/-]{1,300}$/.test(src) && !src.includes(".."))) ? src : "";
  if (kind === "img" && !el.src) return null; // a picture tool with no picture is dead weight
  el.bold = o.bold === true || o.bold === 1 || o.bold === "1";
  el.ital = o.ital === true || o.ital === 1 || o.ital === "1";
  el.align = { l: "l", c: "c", r: "r" }[S(o.align)] ?? "";
  return el;
};

/** parse + validate a tool spec — accepts the raw JSON string from a
 * `[!tool]` line or the model's reply (json may sit inside extra prose) */
export function toolFromJson(raw: string): DeckTool | null {
  const s = S(raw).trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o: unknown;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const name = S(r.name).replace(/[\[\]<>|&"']/g, "").trim().slice(0, 28);
  if (!name) return null;
  const icon = Array.from(S(r.icon).trim()).slice(0, 2).join("") || "✦";
  const els = (Array.isArray(r.els) ? r.els : [])
    .slice(0, 8)
    .map(sanitizeTplEl)
    .filter((e): e is SlideEl => !!e);
  return els.length ? { name, icon, els } : null;
}

/** the deck's custom tools — stored as JSON in data-tools on the card */
const deckTools = (card: HTMLElement): DeckTool[] => {
  try {
    const raw = JSON.parse(DS(card.dataset.tools) || "[]");
    return (Array.isArray(raw) ? raw : [])
      .map((t) => toolFromJson(JSON.stringify(t)))
      .filter((t): t is DeckTool => !!t)
      .slice(0, 24);
  } catch { return []; }
};

const setDeckTools = (card: HTMLElement, tools: DeckTool[]) => {
  card.dataset.tools = JSON.stringify(tools.slice(0, 24));
};

export interface DeckTheme {
  bg: string;
  fg: string;
  sub: string;
  accent: string;
  card: string;
}

export const DECK_THEMES: Record<string, DeckTheme> = {
  light: { bg: "#f7f5f0", fg: "#26241f", sub: "#6b675e", accent: "#b07d3a", card: "#ffffff" },
  dark: { bg: "#1c1a17", fg: "#ece7dd", sub: "#9d968a", accent: "#e0a458", card: "#26231f" },
  navy: { bg: "#101c2e", fg: "#e8edf5", sub: "#8fa3bf", accent: "#5aa9e6", card: "#1a2a42" },
  forest: { bg: "#15241c", fg: "#e5efe8", sub: "#93b5a1", accent: "#7bc98f", card: "#1e3227" },
  sunset: { bg: "#2b1a1e", fg: "#f5e8e6", sub: "#c79a9a", accent: "#ff8f6b", card: "#3a2328" },
  mono: { bg: "#0f0f0f", fg: "#f0f0f0", sub: "#8a8a8a", accent: "#ffffff", card: "#1c1c1c" },
  paper: { bg: "#f3ead8", fg: "#3a3226", sub: "#8a7d63", accent: "#a4553c", card: "#faf5ea" },
  coral: { bg: "#fff3ef", fg: "#33211d", sub: "#96736b", accent: "#e2604c", card: "#ffffff" },
};

export const DECK_TRANSITIONS = ["none", "fade", "push", "wipe", "zoom"] as const;

/* ---------- markdown <-> model ---------- */

const escCell = (s: string) =>
  S(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
const unesc = (s: string) => {
  let o = "";
  let e = false;
  for (const ch of S(s)) {
    if (e) {
      o += ch === "n" ? "\n" : ch === "|" || ch === "\\" ? ch : "\\" + ch;
      e = false;
    } else if (ch === "\\") e = true;
    else o += ch;
  }
  return e ? o + "\\" : o;
};

/** `[!slide bullets bg=#fff]` → slide + attrs */
export function parseSlideHead(line: string): { layout: string; bg: string } {
  const m = S(line).match(/^\[!slide\s*([^\]\s]+)?\s*(?:bg=(\S+))?\s*\]/i);
  return { layout: (m?.[1] ?? "bullets").toLowerCase(), bg: m?.[2] ?? "" };
}

/** split `a \| b | c` on unescaped pipes — el: line value separator */
const splitPipes = (s: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let e = false;
  for (const ch of S(s)) {
    if (e) { cur += "\\" + ch; e = false; }
    else if (ch === "\\") e = true;
    else if (ch === "|") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(e ? cur + "\\" : cur);
  return out;
};

const num = (v: unknown): number => {
  const n = Number(S(v));
  return Number.isFinite(n) ? n : 0;
};

/** `el: kind[.shape] x,y,w,h | k=v | …` — one freeform object on the slide */
export function parseElLine(slide: Slide, t: string) {
  const head = t.slice(3).trim();
  const kv = splitPipes(head);
  const m = kv[0].trim().match(/^(\w+)(?:\.(\w+))?\s+(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/);
  if (!m) return;
  const el = newEl(m[1].toLowerCase(), m[2]?.toLowerCase() ?? "");
  el.x = num(m[3]); el.y = num(m[4]); el.w = num(m[5]); el.h = num(m[6]);
  for (const part of kv.slice(1)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = unesc(part.slice(i + 1).trim());
    if (k === "t") el.text = v;
    else if (k === "f") el.fill = v;
    else if (k === "l") el.line = v;
    else if (k === "c") el.color = v;
    else if (k === "z") el.size = num(v);
    else if (k === "r") el.rot = num(v);
    else if (k === "s") el.src = v;
    else if (k === "b") el.bold = v !== "" && v !== "0";
    else if (k === "i") el.ital = v !== "" && v !== "0";
    else if (k === "a") el.align = v.slice(0, 1);
  }
  slide.els.push(el);
}

/** one body line inside a [!slide] block mutates the slide model */
export function parseSlideLine(slide: Slide, line: string) {
  if (!slide || typeof slide !== "object") return;
  const t = S(line).trim();
  if (t.startsWith("## ")) slide.sub = unesc(t.slice(3));
  else if (t.startsWith("# ")) slide.title = unesc(t.slice(2));
  else if (/^\d+\.\s/.test(t)) slide.bullets.push(unesc(t.replace(/^\d+\.\s*/, "· ")));
  else if (t.startsWith("- ") || t.startsWith("* ")) slide.bullets.push(unesc(t.slice(2)));
  else if (t.startsWith("~")) slide.note = unesc(t.slice(1).trim());
  else if (t.startsWith("img:")) {
    const v = t.slice(4).trim();
    const cap = v.indexOf(" | ");
    if (cap >= 0) {
      slide.img = unesc(v.slice(0, cap).trim());
      slide.sub = unesc(v.slice(cap + 3).trim());
    } else slide.img = unesc(v);
  } else if (t.startsWith("bg:")) slide.bg = t.slice(3).trim();
  else if (t.startsWith("col:")) {
    // "col: a ; b ;; c ; d" — ';;' splits left/right columns
    const v = t.slice(4);
    const [l, r] = v.split(";;");
    slide.cols = [
      l.split(";").map((x) => unesc(x.trim())).filter(Boolean),
      (r ?? "").split(";").map((x) => unesc(x.trim())).filter(Boolean),
    ];
  } else if (t.startsWith("chart:")) slide.chart = unesc(t.slice(6).trim());
  else if (t.startsWith("data:")) slide.csrc = unesc(t.slice(5).trim());
  else if (t.startsWith("el:")) parseElLine(slide, t);
  else if (t.startsWith(">")) slide.quote = unesc(t.slice(1).trim());
  else if (t.startsWith("by:")) slide.by = unesc(t.slice(3).trim());
  else if (t !== "") slide.body = unesc(t);
}

/** callout block lines (post-`>` strip) → deck model */
export function parseDeck(block: string[]): {
  title: string;
  theme: string;
  transition: string;
  slides: Slide[];
  tools: DeckTool[];
} {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim() || "deck";
  let theme = "dark";
  let transition = "fade";
  const slides: Slide[] = [];
  const tools: DeckTool[] = [];
  let cur: Slide | null = null;
  for (const raw of block.slice(1)) {
    const t = raw.trim();
    const tm = t.match(/^\[!theme\s+(\w+)\]/i);
    if (tm) {
      theme = tm[1].toLowerCase();
      continue;
    }
    const trm = t.match(/^\[!transition\s+(\w+)\]/i);
    if (trm) {
      transition = trm[1].toLowerCase();
      continue;
    }
    const tjm = t.match(/^\[!tool\]\s*(.+)$/i);
    if (tjm) {
      // deck-level meta — a user/AI-created tool spec as inline JSON
      const tool = toolFromJson(tjm[1]);
      if (tool) tools.push(tool);
      continue;
    }
    if (/^\[!slide/i.test(t)) {
      const h = parseSlideHead(t);
      cur = emptySlide(h.layout);
      cur.bg = h.bg;
      slides.push(cur);
      continue;
    }
    if (cur) parseSlideLine(cur, t);
  }
  if (!slides.length) slides.push(emptySlide("title"));
  return { title, theme, transition, slides, tools };
}

/** slide model → body lines (without the [!slide] head) */
function slideLines(s: Slide): string[] {
  const out: string[] = [];
  if (s.title) out.push(`# ${escCell(s.title)}`);
  if (s.sub && !(s.layout === "image" && s.img)) out.push(`## ${escCell(s.sub)}`);
  for (const b of s.bullets) out.push(`- ${escCell(b)}`);
  if (s.cols[0].length || s.cols[1].length)
    out.push(`col: ${s.cols[0].map(escCell).join(" ; ")} ;; ${s.cols[1].map(escCell).join(" ; ")}`);
  if (s.img) out.push(`img: ${s.img}${s.sub ? ` | ${escCell(s.sub)}` : ""}`);
  if (s.quote) out.push(`> ${escCell(s.quote)}`);
  if (s.chart) out.push(`chart: ${s.chart}`);
  if (s.csrc) out.push(`data: ${escCell(s.csrc)}`);
  if (s.by) out.push(`by: ${escCell(s.by)}`);
  if (s.body) {
    const b = escCell(s.body);
    // a bare `[!` line would end the callout block on reload — ZWSP-guard it
    out.push(b.startsWith("[!") ? "​" + b : b);
  }
  for (const el of s.els ?? []) {
    const head = `el: ${el.kind}${el.shape ? "." + el.shape : ""} ${rnd(el.x)},${rnd(el.y)},${rnd(el.w)},${rnd(el.h)}`;
    const kv: string[] = [];
    if (el.text) kv.push(`t=${escCell(el.text)}`);
    if (el.fill) kv.push(`f=${escCell(el.fill)}`);
    if (el.line) kv.push(`l=${escCell(el.line)}`);
    if (el.color) kv.push(`c=${escCell(el.color)}`);
    if (el.size) kv.push(`z=${Math.round(el.size)}`);
    if (el.rot) kv.push(`r=${rnd(el.rot)}`);
    if (el.src) kv.push(`s=${escCell(el.src)}`);
    if (el.bold) kv.push("b=1");
    if (el.ital) kv.push("i=1");
    if (el.align) kv.push(`a=${el.align.slice(0, 1)}`);
    out.push(kv.length ? `${head} | ${kv.join(" | ")}` : head);
  }
  if (s.note) out.push(`~ ${escCell(s.note)}`);
  return out;
}

const rnd = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;

export function deckToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const theme = DS(card.dataset.theme) ?? "dark";
  const trans = DS(card.dataset.trans) ?? "fade";
  const lines: string[] = [
    `> [!slides] ${DS(card.dataset.topic) ?? "deck"}`,
    `> [!theme ${theme}]`,
    `> [!transition ${trans}]`,
  ];
  for (const tl of deckTools(card)) lines.push(`> [!tool] ${JSON.stringify(tl)}`);
  card.querySelectorAll<HTMLElement>(".dslide").forEach((sl) => {
    const s = slideFromDom(sl);
    lines.push(">");
    lines.push(`> [!slide ${s.layout}${s.bg ? ` bg=${s.bg}` : ""}]`);
    for (const l of slideLines(s)) lines.push(`> ${l}`);
  });
  return lines.join("\n");
}

/** read the live DOM slide back into a model — contentEditable state wins */
export function slideFromDom(sl: HTMLElement): Slide {
  if (!sl?.dataset) return emptySlide();
  // data-layout first; the layout-* class is the fallback — markup emitted
  // before the attr existed (and any hand-built DOM) still reads back right
  const layout =
    sl.dataset.layout ??
    (sl.className.match(/\blayout-(\w+)/)?.[1] || "bullets");
  const s = emptySlide(layout);
  s.bg = sl.dataset.bg ?? "";
  s.title = sl.querySelector(".d-title")?.textContent?.trim() ?? "";
  s.sub = sl.querySelector(".d-sub")?.textContent?.trim() ?? "";
  s.bullets = Array.from(sl.querySelectorAll(".d-bullets > li"))
    .map((li) => (li.textContent ?? "").trim())
    .filter(Boolean);
  const cols = sl.querySelectorAll(".d-col");
  if (cols.length >= 2)
    s.cols = [
      Array.from(cols[0].querySelectorAll("li"))
        .map((li) => (li.textContent ?? "").trim())
        .filter(Boolean),
      Array.from(cols[1].querySelectorAll("li"))
        .map((li) => (li.textContent ?? "").trim())
        .filter(Boolean),
    ];
  s.img = sl.querySelector<HTMLElement>(".d-img")?.dataset.src ?? "";
  s.quote = sl.querySelector(".d-quote")?.textContent?.trim() ?? "";
  s.by = sl.querySelector(".d-by")?.textContent?.trim() ?? "";
  s.body = sl.querySelector(".d-body")?.textContent?.trim() ?? "";
  s.chart = sl.querySelector<HTMLElement>(".d-chart-cv")?.dataset.ctype ?? "";
  s.csrc = sl.querySelector<HTMLElement>(".d-chart-cv")?.dataset.csrc ?? "";
  s.note = sl.dataset.note ?? "";
  // freeform objects — position/format live in data-* so drag edits serialize
  s.els = Array.from(sl.querySelectorAll<HTMLElement>(":scope > .d-els > .d-el"))
    .map(elFromNode)
    .filter((el) => el.w > 0 && el.h > 0);
  return s;
}

/** .d-el node → element model — data-* attrs carry geometry + format */
const elFromNode = (n: HTMLElement): SlideEl => {
  const el = newEl(n.dataset.kind ?? "text", n.dataset.shape ?? "");
  el.x = num(n.dataset.x); el.y = num(n.dataset.y);
  el.w = num(n.dataset.w); el.h = num(n.dataset.h);
  el.fill = n.dataset.fill ?? ""; el.line = n.dataset.line ?? "";
  el.color = n.dataset.color ?? ""; el.size = num(n.dataset.size);
  el.src = n.dataset.src ?? ""; el.rot = num(n.dataset.rot);
  el.bold = n.dataset.bold === "1"; el.ital = n.dataset.ital === "1";
  el.align = n.dataset.align ?? "";
  el.text = elText(n.querySelector<HTMLElement>(".d-el-tx"));
  return el;
};

/** contenteditable text incl. <br>/<div> newlines — textContent flattens them */
const elText = (n: HTMLElement | null): string => {
  if (!n) return "";
  const walk = (c: Node): string => {
    if (c.nodeType === 3) return c.textContent ?? "";
    if (c.nodeName === "BR") return "\n";
    const inner = Array.from(c.childNodes).map(walk).join("");
    return /^(DIV|P)$/.test(c.nodeName) ? inner + "\n" : inner;
  };
  return Array.from(n.childNodes).map(walk).join("").replace(/\n+$/, "");
};

/* ---------- slide markup (string HTML — used by render.ts AND thumbs) ---------- */

const escHtml = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ed = `contenteditable="true" spellcheck="false"`;

/** freeform object → markup. Position/format live in data-* attrs so
 *  drags update them cheaply and slideFromDom serializes straight back. */
export function elHtml(el: SlideEl): string {
  const d = DECK_SHAPES[el.shape] ?? {};
  const fill = cssColor(el.fill), ln = cssColor(el.line), ink = cssColor(el.color);
  const rot = clampN(el.rot, -360, 360);
  const st =
    `left:${el.x}%;top:${el.y}%;width:${el.w}%;height:${el.h}%;` +
    (rot ? `transform:rotate(${rot}deg);` : "");
  const data =
    `data-kind="${escHtml(el.kind)}"` +
    (el.shape ? ` data-shape="${escHtml(el.shape)}"` : "") +
    ` data-x="${el.x}" data-y="${el.y}" data-w="${el.w}" data-h="${el.h}"` +
    (fill ? ` data-fill="${escHtml(fill)}"` : "") +
    (ln ? ` data-line="${escHtml(ln)}"` : "") +
    (ink ? ` data-color="${escHtml(ink)}"` : "") +
    (el.size ? ` data-size="${clampN(el.size, 0, 200)}"` : "") +
    (el.src ? ` data-src="${escHtml(el.src)}"` : "") +
    (rot ? ` data-rot="${rot}"` : "") +
    (el.bold ? ` data-bold="1"` : "") +
    (el.ital ? ` data-ital="1"` : "") +
    (el.align ? ` data-align="${escHtml(el.align.slice(0, 1))}"` : "");
  const txStyle =
    `text-align:${el.align === "l" ? "left" : el.align === "r" ? "right" : "center"};` +
    (ink ? `color:${ink};` : "") +
    (el.size ? `font-size:${clampN(el.size, 0, 200)}px;` : "") +
    (el.bold ? "font-weight:700;" : "") +
    (el.ital ? "font-style:italic;" : "");
  const text = escHtml(el.text).replace(/\n/g, "<br>");
  if (el.kind === "img") {
    // vault-relative paths hydrate via asset_data_url (same as note images);
    // absolute/data:/blob: sources render directly
    const isAbs = /^(?:[a-z]+:|\/|[A-Za-z]:[\\/])/i.test(el.src);
    const img = el.src
      ? `<img class="d-el-img" ${isAbs ? `src="${escHtml(el.src)}"` : `data-asset="${escHtml(el.src)}"`} alt="" draggable="false"/>`
      : `<span class="d-el-ph">image</span>`;
    return `<div class="d-el kind-img" ${data} style="${st}" contenteditable="false">${img}<div class="d-el-tx d-el-cap" ${ed} data-ph="caption" style="${txStyle}">${text}</div></div>`;
  }
  const sh = el.kind === "shape"
    ? `<div class="d-sh${d.bar ? " d-sh-bar" : ""}" style="` +
      `background:${escHtml(fill || "var(--dk-ac)")};` +
      (d.clip ? `clip-path:${d.clip};` : "") +
      (d.rad ? `border-radius:${d.rad};` : "") +
      (ln ? `box-shadow:0 0 0 2px ${ln} inset;` : "") +
      `"></div>`
    : "";
  const cls = el.kind === "shape" ? "d-el kind-shape" : "d-el kind-text";
  return `<div class="${cls}" ${data} style="${st}" contenteditable="false">${sh}<div class="d-el-tx" ${ed} data-ph="text" style="${txStyle}">${text}</div></div>`;
}

/** render one slide model to markup — layout decides which parts show */
export function slideHtml(s: Slide, i: number): string {
  if (!s || typeof s !== "object") s = emptySlide("blank");
  i = intIdx(i) < 0 ? 0 : intIdx(i);
  if (!Array.isArray(s.bullets)) s.bullets = [];
  if (!Array.isArray(s.cols)) s.cols = [[], []];
  const bg = s.bg ? ` data-bg="${escHtml(s.bg)}" style="background:${escHtml(s.bg)}"` : "";
  const title = `<h1 class="d-title" ${ed} data-ph="Slide title">${escHtml(s.title)}</h1>`;
  const sub = `<h2 class="d-sub" ${ed} data-ph="Subtitle">${escHtml(s.sub)}</h2>`;
  const bullets = `<ul class="d-bullets">${s.bullets
    .map((b) => `<li ${ed} data-ph="bullet">${escHtml(b)}</li>`)
    .join("")}<li ${ed} data-ph="bullet"></li></ul>`;
  const body = `<p class="d-body" ${ed} data-ph="Text">${escHtml(s.body)}</p>`;
  const note = ` data-note="${escHtml(s.note)}"`;
  const img = `<div class="d-img" data-src="${escHtml(s.img)}">${
    s.img ? `<img src="${escHtml(s.img)}" alt=""/>` : `<span class="d-img-ph">drop an image file here, or img: path</span>`
  }</div>`;
  const quote = `<blockquote class="d-quote" ${ed} data-ph="Quote">${escHtml(s.quote)}</blockquote><div class="d-by" ${ed} data-ph="— attribution">${escHtml(s.by)}</div>`;
  const cols = `<div class="d-cols">${s.cols
    .map(
      (col) =>
        `<ul class="d-col">${(Array.isArray(col) ? col : []).map((b) => `<li ${ed}>${escHtml(b)}</li>`).join("")}<li ${ed}></li></ul>`,
    )
    .join("")}</div>`;
  let inner = "";
  switch (s.layout) {
    case "title":
      inner = `<div class="d-center">${title}${sub}</div>`;
      break;
    case "section":
      inner = `<div class="d-center">${title}</div>`;
      break;
    case "twocol":
      inner = `${title}${cols}`;
      break;
    case "image":
      inner = `${s.title ? title : ""}${img}${s.sub ? sub : ""}`;
      break;
    case "quote":
      inner = `<div class="d-center">${quote}</div>`;
      break;
    case "bigfact":
      inner = `<div class="d-center"><div class="d-big" ${ed} data-ph="42">${escHtml(
        s.title,
      )}</div>${sub}</div>`;
      break;
    case "chart": {
      const spec =
        `<canvas class="d-chart-cv" data-ctype="${escHtml(s.chart || "bar")}"` +
        ` data-csrc="${escHtml(s.csrc)}"` +
        ` data-clabels="${escHtml(s.bullets.map((b) => b.split("|")[0].trim()).join(""))}"` +
        ` data-cseries="${escHtml(JSON.stringify(toChartSeries(s.bullets)))}"></canvas>`;
      inner = `${s.title ? title : ""}<div class="d-chart">${spec}</div>`;
      break;
    }
    case "blank":
      inner = body;
      break;
    case "bullets":
    default:
      inner = `${title}${bullets}`;
      break;
  }
  const els = (s.els ?? []).length
    ? `<div class="d-els" contenteditable="false">${s.els.map(elHtml).join("")}</div>`
    : "";
  return `<div class="dslide layout-${escHtml(s.layout)}" data-layout="${escHtml(s.layout)}" data-i="${i}"${bg}${note}>${inner}${els}</div>`;
}

/** `label | v | v` bullets → numeric series columns for the chart canvas */
export function toChartSeries(bullets: string[]): number[][] {
  const series: number[][] = [];
  for (const b of bullets) {
    const parts = b.split("|").map((x) => x.trim());
    for (let i = 1; i < parts.length; i++) {
      while (series.length < parts.length - 1) series.push([]);
      series[i - 1].push(Number(parts[i]) || 0);
    }
  }
  return series;
}

/** paint any chart canvases inside a slide element — after mount + on refresh */
export function paintSlideCharts(sl: HTMLElement) {
  sl.querySelectorAll<HTMLCanvasElement>(".d-chart-cv").forEach((cv) => {
    const labels = (cv.dataset.clabels ?? "").split("").filter((x) => x !== "");
    let series: number[][] = [];
    try {
      series = JSON.parse(cv.dataset.cseries ?? "[]") as number[][];
    } catch { series = []; }
    const src = cv.dataset.csrc ?? "";
    if (src) {
      const live = fromSheetRange(src);
      if (live && live.labels.length) {
        labels.length = 0;
        labels.push(...live.labels);
        series = live.series;
      }
    }
    paintChart(cv, {
      title: "",
      type: cv.dataset.ctype ?? "bar",
      labels,
      series,
      source: src,
      colors: [],
    });
  });
}

/** whole deck card markup — render.ts wraps this in the callout div */
export function deckInnerHtml(d: {
  title: string;
  theme: string;
  transition: string;
  slides: Slide[];
}): string {
  return (
    `<div class="deck-body" data-theme="${escHtml(d.theme)}">` +
    `<div class="deck-strip"></div>` +
    `<div class="deck-stage">` +
    d.slides.map((s, i) => slideHtml(s, i)).join("") +
    `</div></div>`
  );
}

/* ---------- the live deck ---------- */

export interface DeckApi {
  title(): string;
  count(): number;
  read(): string;
  addSlide(layout: string, at?: number): number;
  delSlide(i: number): void;
  moveSlide(from: number, to: number): void;
  setLayout(i: number, layout: string): void;
  setSlide(i: number, s: Partial<Slide>): void;
  appendBullet(i: number, text: string): void;
  setTheme(name: string): void;
  setTransition(fx: string): void;
  setBg(i: number, color: string): void;
  setNote(i: number, text: string): void;
  duplicate(i: number): number;
  /* the insert layer — freeform elements + user-created stamp tools.
   * Everything the ribbon can do is reachable here so the AI can too */
  listEls(i: number): SlideEl[];
  addEl(i: number, el: Partial<SlideEl>): number;
  setEl(i: number, n: number, patch: Partial<SlideEl>): void;
  delEl(i: number, n: number): void;
  listTools(): DeckTool[];
  addTool(spec: unknown): string;
  delTool(name: string): boolean;
  stamp(i: number, name: string, x?: number, y?: number, w?: number, h?: number): string;
  /* file interchange — .pptx out/in, .md export; no path → file dialog */
  exportFile?(path?: string): Promise<string>;
  importFile?(path?: string): Promise<string>;
  load?(title: string, slides: Slide[], theme?: string): void;
  json?(): { title: string; theme: string; transition: string; slides: Slide[] };
}

const decks = new WeakMap<HTMLElement, DeckApi>();
export function deckApi(card: HTMLElement): DeckApi | undefined {
  return decks.get(card);
}

/* per-stage state for freeform elements — WeakMap-keyed so a rewired card
 * (undo/restore keeps or rebuilds the stage element) always resolves one
 * selection + place-tool state */
interface ElCtl {
  sel: HTMLElement | null;
  placing: { kind: string; shape: string; src: string; tool?: DeckTool } | null;
}
const elCtls = new WeakMap<HTMLElement, ElCtl>();

const applyThemeVars = (body: HTMLElement, theme: string) => {
  const t = DECK_THEMES[theme] ?? DECK_THEMES.dark;
  body.dataset.theme = theme;
  body.style.setProperty("--dk-bg", t.bg);
  body.style.setProperty("--dk-fg", t.fg);
  body.style.setProperty("--dk-sub", t.sub);
  body.style.setProperty("--dk-ac", t.accent);
  body.style.setProperty("--dk-card", t.card);
};

const LAYOUT_ICON: Record<string, string> = {
  title: "◼", section: "◧", bullets: "☰", twocol: "◫", image: "🖼",
  quote: "❝", bigfact: "№", chart: "◔", blank: "▢",
};

export function wireDeck(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.deckWired) return;
  card.dataset.deckWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("deck:changed", { bubbles: true }));
  const body = card.querySelector<HTMLElement>(".deck-body");
  const stage = card.querySelector<HTMLElement>(".deck-stage");
  const strip = card.querySelector<HTMLElement>(".deck-strip");
  if (!body || !stage || !strip) return;
  applyThemeVars(body, card.dataset.theme ?? "dark");
  const ctl = (() => {
    let c = elCtls.get(stage);
    if (!c) { c = { sel: null, placing: null }; elCtls.set(stage, c); }
    return c;
  })();

  const slides = () => Array.from(stage.querySelectorAll<HTMLElement>(".dslide"));
  const active = () => {
    let i = Number(stage.dataset.active ?? 0);
    const n = slides().length;
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    return i;
  };

  const paintThumbs = () => {
    strip.innerHTML = "";
    slides().forEach((sl, i) => {
      const b = document.createElement("button");
      b.className = "deck-thumb" + (i === active() ? " on" : "");
      b.dataset.i = String(i);
      b.contentEditable = "false";
      const t = sl.querySelector(".d-title")?.textContent?.trim() ?? "";
      const bullets = sl.querySelectorAll(".d-bullets > li, .d-col > li").length;
      b.innerHTML =
        `<span class="dt-i">${i + 1}</span>` +
        `<span class="dt-ic">${LAYOUT_ICON[sl.dataset.layout ?? "bullets"] ?? "▢"}</span>` +
        `<span class="dt-t">${t ? escHtml(t).slice(0, 22) : `<i>${escHtml(sl.dataset.layout ?? "")}</i>`}</span>` +
        (bullets ? `<span class="dt-n">${bullets}•</span>` : "");
      b.title = `slide ${i + 1} — ${sl.dataset.layout} — drag to reorder`;
      b.draggable = true;
      b.addEventListener("click", () => show(i));
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/x-laido-slide", String(i));
        e.dataTransfer!.effectAllowed = "move";
      });
      b.addEventListener("dragover", (e) => e.preventDefault());
      b.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/x-laido-slide") ?? -1);
        if (from >= 0) move(from, i);
      });
      strip.append(b);
    });
  };

  const show = (i: number) => {
    const n = slides().length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    stage.dataset.active = String(i);
    deselectEl();
    slides().forEach((sl, k) => sl.classList.toggle("live", k === i));
    slides().forEach(paintSlideCharts);
    paintThumbs();
    refreshBar();
  };

  /* enabled-state refresh — rebound by the toolbar block once wired;
   * keeps ↑/↓/✕ honest when the deck changes */
  let refreshBar: () => void = () => {};
  /* custom-tools strip refresh — rebound by the toolbar block; the api's
   * addTool/delTool go through it so AI-created tools appear instantly */
  let rebuildCtools: () => void = () => {};

  const touch = () => {
    paintThumbs();
    onChange();
  };

  const rebuildSlide = (i: number, s: Slide) => {
    const cur = slides()[i];
    if (!cur) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = slideHtml(s, i);
    const fresh = tmp.firstElementChild as HTMLElement;
    cur.replaceWith(fresh);
    wireSlide(fresh);
    show(i);
    touch();
  };

  const addSlide = (layout = "bullets", at?: number): number => {
    layout = S(layout) || "bullets";
    at = at === undefined ? undefined : intIdx(at);
    const s = emptySlide(layout);
    const tmp = document.createElement("div");
    tmp.innerHTML = slideHtml(s, -1);
    const el = tmp.firstElementChild as HTMLElement;
    const list = slides();
    const idx = at === undefined ? list.length : Math.max(0, Math.min(list.length, at));
    stage.insertBefore(el, list[idx] ?? null);
    wireSlide(el);
    renumber();
    show(idx);
    touch();
    return idx;
  };

  const delSlide = (i: number) => {
    i = intIdx(i);
    const list = slides();
    if (list.length <= 1) return; // a deck keeps at least one slide
    list[i]?.remove();
    renumber();
    show(Math.min(i, slides().length - 1));
    touch();
  };

  const move = (from: number, to: number) => {
    from = intIdx(from);
    to = intIdx(to);
    const list = slides();
    if (from === to || !list[from]) return;
    const el = list[from];
    stage.removeChild(el);
    const list2 = slides();
    stage.insertBefore(el, list2[to] ?? null);
    renumber();
    show(to);
    touch();
  };

  const renumber = () => slides().forEach((sl, i) => (sl.dataset.i = String(i)));

  /* -- inline editing: bullets behave like a list, Enter/Tab navigate -- */
  const wireSlide = (sl: HTMLElement) => {
    sl.querySelectorAll<HTMLElement>("[contenteditable]").forEach((el) => {
      if (el.dataset.wired) return;
      el.dataset.wired = "1";
      el.addEventListener("blur", () => {
        // drop trailing empty bullets (the spare editing row) but keep one
        if (el.tagName === "LI") {
          const ul = el.parentElement!;
          ul.querySelectorAll("li").forEach((li, i, all) => {
            if (i < all.length - 1 && !(li.textContent ?? "").trim()) li.remove();
          });
          const last = ul.querySelector("li:last-child") as HTMLElement | null;
          if (last && (last.textContent ?? "").trim()) {
            const li = document.createElement("li");
            li.contentEditable = "true";
            li.dataset.ph = "bullet";
            ul.append(li);
            wireSlide(sl);
          }
        }
        touch();
      });
      el.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (el.classList.contains("d-el-tx")) {
          // text boxes/shape labels: Enter inserts a newline; only Escape exits
          if (e.key === "Escape") el.blur();
          return;
        }
        if (e.key === "Enter" && el.tagName === "LI") {
          e.preventDefault();
          const li = el;
          const next = document.createElement("li");
          next.contentEditable = "true";
          next.dataset.ph = "bullet";
          li.after(next);
          wireSlide(sl);
          next.focus();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          el.blur();
        } else if (e.key === "Escape") {
          el.blur();
        }
      });
      el.addEventListener("paste", (e) => {
        e.preventDefault();
        const t = e.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, t.replace(/\n/g, " "));
      });
    });
    // image drop → sets the slide's img:
    sl.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    sl.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      const path = (f as File & { path?: string }).path ?? f.name;
      const s = slideFromDom(sl);
      s.img = path;
      rebuildSlide(Number(sl.dataset.i), s);
    });
    sl.querySelectorAll<HTMLElement>(":scope > .d-els > .d-el").forEach(wireEl);
  };

  /* ---------- freeform elements: text boxes, shapes, pictures ----------
   * PowerPoint-style: insert tool arms a place gesture on the slide;
   * click an object to select it — drag moves, corner handles resize,
   * typing goes straight into the text. A floating mini-bar carries the
   * Shape Format essentials (fill/outline/ink/size/rotate/layer/delete).
   * The shared state lives in a per-stage ctl so card rewires (undo)
   * rebind listeners to the same selection/place state. */

  const clampPct = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  /** re-derive an element's style from its data-* (source of truth) */
  const applyEl = (n: HTMLElement) => {
    n.style.left = `${num(n.dataset.x)}%`;
    n.style.top = `${num(n.dataset.y)}%`;
    n.style.width = `${num(n.dataset.w)}%`;
    n.style.height = `${num(n.dataset.h)}%`;
    const r = num(n.dataset.rot);
    n.style.transform = r ? `rotate(${r}deg)` : "";
    const sh = n.querySelector<HTMLElement>(".d-sh");
    if (sh) {
      sh.style.background = n.dataset.fill || "var(--dk-ac)";
      sh.style.boxShadow = n.dataset.line ? `0 0 0 2px ${n.dataset.line} inset` : "";
    }
    const tx = n.querySelector<HTMLElement>(".d-el-tx");
    if (tx) {
      const a = n.dataset.align ?? "";
      tx.style.textAlign = a === "l" ? "left" : a === "r" ? "right" : "center";
      tx.style.color = n.dataset.color ?? "";
      tx.style.fontSize = n.dataset.size ? `${n.dataset.size}px` : "";
      tx.style.fontWeight = n.dataset.bold === "1" ? "700" : "";
      tx.style.fontStyle = n.dataset.ital === "1" ? "italic" : "";
    }
  };

  /** swatch row — theme tokens + the usual Office palette; "" = auto */
  const EL_SWATCHES = ["", "#ffffff", "#111111", "#e2604c", "#e0a458", "#f0c44c", "#7bc98f", "#5aa9e6", "#a58ae6"];
  const EL_AUTOS: Record<string, string> = { fill: "var(--dk-ac)", line: "transparent", color: "var(--dk-fg)" };

  const buildElBar = (n: HTMLElement): HTMLElement => {
    const bar2 = document.createElement("div");
    bar2.className = "d-el-bar" + (num(n.dataset.y) < 14 ? " below" : "");
    bar2.contentEditable = "false";
    const kind = n.dataset.kind ?? "text";
    const btn = (label: string, tip: string, fn: () => void, on = false) => {
      const b = document.createElement("button");
      b.className = "d-el-btn" + (on ? " on" : "");
      b.innerHTML = label;
      b.title = tip;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      bar2.append(b);
      return b;
    };
    const swatches = (attr: "fill" | "line" | "color") => {
      bar2.querySelector(".d-el-sws")?.remove();
      const row = document.createElement("div");
      row.className = "d-el-sws";
      for (const c of EL_SWATCHES) {
        const sw = document.createElement("button");
        sw.className = "d-el-sw";
        sw.style.background = c || EL_AUTOS[attr];
        sw.title = c || `auto (${EL_AUTOS[attr]})`;
        sw.addEventListener("mousedown", (e) => e.preventDefault());
        sw.addEventListener("click", (e) => {
          e.stopPropagation();
          n.dataset[attr] = c;
          applyEl(n);
          row.remove();
          touch();
        });
        row.append(sw);
      }
      bar2.append(row);
    };
    if (kind === "shape") {
      btn("■", "shape fill", () => swatches("fill"));
      btn("◱", "outline color", () => swatches("line"));
    }
    if (kind !== "img") {
      btn("A", "text color", () => swatches("color"));
      btn("<b>B</b>", "bold", () => { n.dataset.bold = n.dataset.bold === "1" ? "0" : "1"; applyEl(n); touch(); }, n.dataset.bold === "1");
      btn("<i>I</i>", "italic", () => { n.dataset.ital = n.dataset.ital === "1" ? "0" : "1"; applyEl(n); touch(); }, n.dataset.ital === "1");
      btn("−", "smaller text", () => { const s = Math.max(8, (num(n.dataset.size) || 14) - 2); n.dataset.size = String(s); applyEl(n); touch(); });
      btn("+", "bigger text", () => { const s = (num(n.dataset.size) || 14) + 2; n.dataset.size = String(s); applyEl(n); touch(); });
      btn("≡", "align — left / center / right", () => {
        const order = ["", "l", "c", "r"];
        const next = order[(order.indexOf(n.dataset.align ?? "") + 1) % order.length];
        n.dataset.align = next;
        applyEl(n); touch();
      });
    }
    btn("⟳", "rotate 90°", () => { n.dataset.rot = String((num(n.dataset.rot) + 90) % 360); applyEl(n); touch(); });
    btn("⤒", "bring to front", () => { n.parentElement?.append(n); touch(); });
    btn("⤓", "send to back", () => { n.parentElement?.prepend(n); touch(); });
    btn("✕", "delete object (Delete)", () => { n.remove(); deselectEl(); touch(); });
    return bar2;
  };

  const deselectEl = () => {
    ctl.sel?.classList.remove("on");
    ctl.sel?.querySelectorAll(".d-el-h,.d-el-bar").forEach((x) => x.remove());
    ctl.sel = null;
  };

  const selectEl = (n: HTMLElement | null) => {
    if (ctl.sel === n) return;
    deselectEl();
    if (!n || !n.isConnected) return;
    ctl.sel = n;
    n.classList.add("on");
    for (const c of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("i");
      h.className = `d-el-h ${c}`;
      h.dataset.c = c;
      n.append(h);
    }
    n.append(buildElBar(n));
  };

  function wireEl(n: HTMLElement) {
    if (n.dataset.elwired) return;
    n.dataset.elwired = "1";
    const img = n.querySelector<HTMLImageElement>("img[data-asset]");
    if (img && !img.dataset.hydrated) {
      img.dataset.hydrated = "1";
      void invoke<string>("asset_data_url", { path: img.dataset.asset })
        .then((u) => { img.src = u; })
        .catch(() => img.classList.add("img-missing"));
    }
    n.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || ctl.placing) return;
      e.stopPropagation();
      const sl = n.closest<HTMLElement>(".dslide");
      if (!sl) return;
      const h = (e.target as HTMLElement).closest<HTMLElement>(".d-el-h");
      const tx = (e.target as HTMLElement).closest<HTMLElement>(".d-el-tx");
      const wasSel = ctl.sel === n;
      selectEl(n);
      if (tx && wasSel) {
        // second click into the text — let the caret land for editing
        return;
      }
      e.preventDefault();
      const pw = sl.clientWidth || 1, ph = sl.clientHeight || 1;
      const sx = e.clientX, sy = e.clientY;
      const x0 = num(n.dataset.x), y0 = num(n.dataset.y);
      const w0 = num(n.dataset.w), h0 = num(n.dataset.h);
      const corner = h?.dataset.c ?? "";
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        const dx = ((ev.clientX - sx) / pw) * 100;
        const dy = ((ev.clientY - sy) / ph) * 100;
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
        moved = true;
        if (corner) {
          let x = x0, y = y0, w = w0, hh = h0;
          if (corner.includes("e")) w = Math.max(3, w0 + dx);
          if (corner.includes("s")) hh = Math.max(3, h0 + dy);
          if (corner.includes("w")) { w = Math.max(3, w0 - dx); x = x0 + w0 - w; }
          if (corner.includes("n")) { hh = Math.max(3, h0 - dy); y = y0 + h0 - hh; }
          n.dataset.x = String(x); n.dataset.y = String(y);
          n.dataset.w = String(w); n.dataset.h = String(hh);
        } else {
          n.dataset.x = String(clampPct(x0 + dx, -30, 115));
          n.dataset.y = String(clampPct(y0 + dy, -30, 115));
        }
        applyEl(n);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (moved) touch();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /** stamp a custom tool — every template element scales from its 0–100
   * tool-box coords into the dragged rect; each lands as a normal .d-el
   * (individually selectable/movable afterwards, like pasted objects) */
  const insertTool = (sl: HTMLElement, tool: DeckTool, x: number, y: number, w: number, h: number) => {
    let layer = sl.querySelector<HTMLElement>(":scope > .d-els");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "d-els";
      layer.contentEditable = "false";
      sl.append(layer);
    }
    let last: HTMLElement | null = null;
    for (const t of tool.els) {
      const el = newEl(t.kind, t.shape);
      el.x = x + (t.x * w) / 100;
      el.y = y + (t.y * h) / 100;
      el.w = (t.w * w) / 100;
      el.h = (t.h * h) / 100;
      el.text = t.text; el.fill = t.fill; el.line = t.line; el.color = t.color;
      el.size = t.size; el.rot = t.rot; el.src = t.src;
      el.bold = t.bold; el.ital = t.ital; el.align = t.align;
      const tmp = document.createElement("div");
      tmp.innerHTML = elHtml(el);
      const n = tmp.firstElementChild as HTMLElement;
      layer.append(n);
      wireEl(n);
      last = n;
    }
    wireSlide(sl);
    if (last) selectEl(last);
    touch();
  };

  /** create + mount an element on a slide — used by the insert tools */
  const insertEl = (sl: HTMLElement, spec: { kind: string; shape: string; src: string }, x: number, y: number, w: number, h: number): HTMLElement => {
    const el = newEl(spec.kind, spec.shape);
    el.x = x; el.y = y; el.w = w; el.h = h;
    el.src = spec.src;
    const tmp = document.createElement("div");
    tmp.innerHTML = elHtml(el);
    const n = tmp.firstElementChild as HTMLElement;
    let layer = sl.querySelector<HTMLElement>(":scope > .d-els");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "d-els";
      layer.contentEditable = "false";
      sl.append(layer);
    }
    layer.append(n);
    wireEl(n);
    wireSlide(sl); // wires the new .d-el-tx editable (guarded per-node)
    selectEl(n);
    if (spec.kind !== "img") n.querySelector<HTMLElement>(".d-el-tx")?.focus();
    touch();
    return n;
  };

  /* stage-level gestures bind once — the dataset guard keeps card
   * rewires (undo, duplication) from stacking duplicate handlers */
  if (!stage.dataset.elwire) {
    stage.dataset.elwire = "1";

    /* place gesture — armed by an insert tool; click drops a default-size
     * object, drag draws the box first (PowerPoint's draw-to-place) */
    stage.addEventListener("mousedown", (e) => {
      if (!ctl.placing || e.button !== 0) return;
      const sl = slides()[active()];
      if (!sl) { ctl.placing = null; stage.classList.remove("placing"); return; }
      e.preventDefault();
      e.stopPropagation();
      deselectEl();
      const box = sl.getBoundingClientRect();
      const pw = box.width || 1, ph = box.height || 1;
      const sx = ((e.clientX - box.left) / pw) * 100;
      const sy = ((e.clientY - box.top) / ph) * 100;
      const ghost = document.createElement("div");
      ghost.className = "d-place";
      sl.append(ghost);
      let x = sx, y = sy, w = 0, h = 0, moved = false;
      const mv = (ev: MouseEvent) => {
        const ex = ((ev.clientX - box.left) / pw) * 100;
        const ey = ((ev.clientY - box.top) / ph) * 100;
        x = Math.min(sx, ex); y = Math.min(sy, ey);
        w = Math.abs(ex - sx); h = Math.abs(ey - sy);
        if (w > 0.5 || h > 0.5) moved = true;
        ghost.style.cssText = `left:${x}%;top:${y}%;width:${w}%;height:${h}%`;
      };
      const up = () => {
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        ghost.remove();
        stage.classList.remove("placing");
        card.querySelectorAll(".deck-btn.armed").forEach((x) => x.classList.remove("armed"));
        const spec = ctl.placing!;
        ctl.placing = null;
        if (!moved) {
          w = spec.tool ? 46 : spec.kind === "img" ? 32 : spec.shape === "line" ? 26 : 34;
          h = spec.tool ? 30 : spec.kind === "img" ? 30 : spec.shape === "line" ? 4 : 16;
          x = clampPct(sx - w / 2, 0, 100 - w);
          y = clampPct(sy - h / 2, 0, 100 - h);
        }
        w = Math.max(4, w); h = Math.max(2, h);
        if (spec.tool) insertTool(sl, spec.tool, x, y, w, h);
        else insertEl(sl, spec, x, y, w, h);
      };
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    }, true);

    // clicking bare slide space drops the selection
    stage.addEventListener("mousedown", (e) => {
      if (ctl.placing) return;
      if (!(e.target as HTMLElement).closest(".d-el")) deselectEl();
    });

    /* an armed insert tool disarms on any mousedown outside the stage and
     * the deck bar — matches PowerPoint (click-away cancels placement) */
    document.addEventListener("mousedown", (e) => {
      if (!card.isConnected) return;
      if (!ctl.placing) return;
      const t = e.target as Node;
      if (stage.contains(t) || bar?.contains(t)) return;
      ctl.placing = null;
      stage.classList.remove("placing");
      card.querySelectorAll(".deck-btn.armed").forEach((x) => x.classList.remove("armed"));
    });

    /* Delete/Backspace removes the selected object when not editing text;
     * Escape clears selection / cancels an armed insert tool. Self-removes
     * when the card leaves the DOM so rewires don't leak listeners. */
    const onElKey = (e: KeyboardEvent) => {
      if (!card.isConnected) {
        document.removeEventListener("keydown", onElKey);
        delete card.dataset.elKeys;
        return;
      }
      const inText = document.activeElement?.classList.contains("d-el-tx");
      if (e.key === "Escape") {
        if (ctl.placing) {
          ctl.placing = null;
          stage.classList.remove("placing");
          card.querySelectorAll(".deck-btn.armed").forEach((x) => x.classList.remove("armed"));
        } else if (ctl.sel && !inText) deselectEl();
        return;
      }
      if (!ctl.sel || inText || !ctl.sel.isConnected) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        ctl.sel.remove();
        deselectEl();
        touch();
      }
    };
    document.addEventListener("keydown", onElKey);
    card.dataset.elKeys = "1";
  }

  /* -- toolbar: a ribbon row of its own under the head — the head keeps
   *  the title + card chrome; eleven widget controls need real estate -- */
  let bar = card.querySelector<HTMLElement>(".deck-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "deck-bar";
    bar.contentEditable = "false";
    body.before(bar); // between head and the strip/stage row
  }
  if (!bar.dataset.wired) {
    bar.dataset.wired = "1";
    const mk = (label: string, tip: string, fn: (b: HTMLButtonElement) => void) => {
      const b = document.createElement("button");
      b.className = "deck-btn";
      b.innerHTML = label;
      b.title = tip;
      // mousedown-preventDefault keeps the editor caret — pointerdown would
      // suppress mousedown entirely, so document-level dismiss handlers
      // (popover close, menus) never see presses on deck buttons
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn(b);
      });
      bar!.append(b);
      return b;
    };
    const sep = () => {
      const s = document.createElement("span");
      s.className = "deck-sep";
      bar!.append(s);
    };
    /* shared popover scaffold — one open at a time, closes on outside
     * mousedown, anchors under the button that opened it */
    const pop = (b: HTMLElement, cls = ""): HTMLElement => {
      bar!.querySelector(".deck-layoutpop")?.remove();
      const p = document.createElement("div");
      p.className = ("deck-layoutpop " + cls).trim();
      p.contentEditable = "false";
      const x = Math.max(0, Math.min(b.offsetLeft, Math.max(0, bar!.clientWidth - 160)));
      p.style.left = x + "px";
      bar!.append(p);
      const off = (e: MouseEvent) => {
        if (!p.contains(e.target as Node)) {
          p.remove();
          document.removeEventListener("mousedown", off);
        }
      };
      setTimeout(() => document.addEventListener("mousedown", off), 0);
      return p;
    };

    // layout picker for "+ slide"
    mk("+ slide", "add a slide — choose a layout", (b) => {
      const p = pop(b);
      for (const l of DECK_LAYOUTS) {
        const it = document.createElement("button");
        it.className = "deck-lp-item";
        it.innerHTML = `${LAYOUT_ICON[l] ?? "▢"} ${l}`;
        it.addEventListener("click", () => {
          addSlide(l, active() + 1);
          p.remove();
        });
        p.append(it);
      }
    });
    sep();
    const bDup = mk("⧉", "duplicate this slide", () => {
      const s = slideFromDom(slides()[active()]);
      const idx = addSlide(s.layout, active() + 1);
      rebuildSlide(idx, s);
    });
    const bDel = mk("✕", "delete this slide", () => delSlide(active()));
    const bUp = mk("↑", "move slide earlier", () => move(active(), Math.max(0, active() - 1)));
    const bDn = mk("↓", "move slide later", () => move(active(), Math.min(slides().length - 1, active() + 1)));
    sep();
    /* -- insert group (PowerPoint Insert): text box, shapes, picture --
     * each arms a place gesture on the slide — click drops a default-size
     * object, drag draws the box; Esc cancels. */
    const arm = (spec: { kind: string; shape: string; src: string; tool?: DeckTool }, btn?: HTMLButtonElement) => {
      // clicking the armed tool itself disarms; arming another tool replaces
      const was = !!btn?.classList.contains("armed");
      bar!.querySelectorAll(".deck-btn.armed").forEach((x) => x.classList.remove("armed"));
      if (was) {
        ctl.placing = null;
        stage.classList.remove("placing");
        return;
      }
      ctl.placing = spec;
      stage.classList.add("placing");
      btn?.classList.add("armed");
    };
    mk("T", "insert a text box — then click/drag on the slide (Esc cancels)", (b) =>
      arm({ kind: "text", shape: "", src: "" }, b));
    mk("▢", "insert a shape — pick one, then click/drag on the slide", (b) => {
      const p = pop(b, "deck-shapepop");
      for (const [key, def] of Object.entries(DECK_SHAPES)) {
        const it = document.createElement("button");
        it.className = "deck-lp-item d-shape-item";
        it.title = def.label;
        const style = def.clip
          ? `clip-path:${def.clip};`
          : def.rad ? `border-radius:${def.rad};` : "";
        const inner = def.bar
          ? `<i class="dsh-line"></i>`
          : `<i class="dsh-fill" style="${style}"></i>`;
        it.innerHTML = `<span class="dsh">${inner}</span>`;
        it.addEventListener("click", () => {
          p.remove();
          arm({ kind: "shape", shape: key, src: "" }, b);
        });
        p.append(it);
      }
    });
    mk("🖼", "insert a picture — pick a file, then click/drag on the slide", () => {
      void pickOpen([{ name: "images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }])
        .then(async (p) => {
          if (!p) return;
          const rel = await invoke<string>("asset_save", { src: p }).catch(() => p);
          arm({ kind: "img", shape: "", src: rel });
        });
    });
    /* -- custom tools (PowerPoint "building blocks", user-authored): each
     * deck keeps its own tool set in `[!tool]` meta lines. AI drafts them
     * from a description, or the selected object becomes a stamp -- either
     * way they sit in the ribbon and place like any other insert. */
    const ctools = document.createElement("span");
    ctools.className = "deck-ctools";
    bar!.append(ctools);
    const renderCtools = () => {
      ctools.querySelectorAll(".deck-btn").forEach((x) => x.remove());
      for (const tl of deckTools(card)) {
        const tb = document.createElement("button");
        tb.className = "deck-btn deck-ctool";
        tb.textContent = tl.icon;
        tb.title = `${tl.name} — your tool: click, then click/drag on the slide`;
        tb.addEventListener("mousedown", (e) => e.preventDefault());
        tb.addEventListener("click", (e) => {
          e.stopPropagation();
          arm({ kind: "tool", shape: "", src: "", tool: tl }, tb);
        });
        ctools.append(tb);
      }
    };
    renderCtools();
    rebuildCtools = renderCtools;
    mk("✦", "create your own slide tool — describe it and AI drafts it, or capture the selected object", (b) => {
      const p = pop(b, "deck-toolpop");
      const head = document.createElement("div");
      head.className = "dt-title";
      head.textContent = "new slide tool";
      const inp = document.createElement("input");
      inp.className = "dt-in";
      inp.placeholder = "describe it — “warning stamp”, “3-step timeline”…";
      const go = document.createElement("button");
      go.className = "dt-go";
      go.textContent = "generate";
      const stat = document.createElement("div");
      stat.className = "dt-status";
      const say = (m: string) => { stat.textContent = m; };
      const row = document.createElement("div");
      row.className = "dt-row";
      row.append(inp, go);
      const cap = document.createElement("button");
      cap.className = "dt-cap";
      const list = document.createElement("div");
      list.className = "dt-list";
      const renderList = () => {
        list.innerHTML = "";
        const tools = deckTools(card);
        if (!tools.length) {
          list.innerHTML = `<div class="dt-empty">no custom tools yet — generate one or capture a selected object</div>`;
          return;
        }
        for (const tl of tools) {
          const r = document.createElement("div");
          r.className = "dt-item";
          const lb = document.createElement("span");
          lb.className = "dt-item-name";
          lb.textContent = `${tl.icon} ${tl.name}`;
          const del = document.createElement("button");
          del.className = "dt-item-x";
          del.textContent = "✕";
          del.title = `remove “${tl.name}”`;
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            // names are unique (same-name generate refreshes) — filter by it,
            // not identity: deckTools() re-parses so object refs never match
            setDeckTools(card, deckTools(card).filter((t) => t.name !== tl.name));
            renderCtools();
            renderList();
            touch();
          });
          r.append(lb, del);
          list.append(r);
        }
      };
      const addTool = (tl: DeckTool | null) => {
        if (!tl) { say("couldn't shape a tool — try a clearer description"); return; }
        const tools = deckTools(card);
        if (tools.some((t) => t.name === tl.name)) {
          say(`“${tl.name}” already exists — it got refreshed`);
          setDeckTools(card, tools.map((t) => (t.name === tl.name ? tl : t)));
        } else {
          tools.push(tl);
          setDeckTools(card, tools);
          say(`added “${tl.name}” — it's in the toolbar now`);
        }
        renderCtools();
        renderList();
        touch();
        inp.value = "";
      };
      const gen = () => {
        const q = inp.value.trim();
        if (!q || go.disabled) return;
        go.disabled = true;
        inp.disabled = true;
        say("drafting…");
        invoke<string>("deck_tool_gen", { prompt: q })
          .then((raw) => addTool(toolFromJson(raw)))
          .catch((e) => say(String(e).slice(0, 120)))
          .finally(() => {
            go.disabled = false;
            inp.disabled = false;
            inp.focus();
          });
      };
      go.addEventListener("click", gen);
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") gen();
      });
      const sel = ctl.sel?.isConnected ? ctl.sel : null;
      if (sel) {
        cap.textContent = "capture selected object as a tool";
        cap.title = "the selected object becomes a reusable stamp (uses the text above as its name)";
        cap.addEventListener("click", () => {
          const el = elFromNode(sel);
          const tpl = { ...el, x: 0, y: 0, w: 100, h: 100 };
          const tool = toolFromJson(JSON.stringify({
            name: inp.value.trim() || `${el.shape || el.kind} stamp`,
            icon: el.kind === "img" ? "🖼" : el.kind === "shape" ? "▢" : "T",
            els: [tpl],
          }));
          addTool(tool);
        });
      } else {
        cap.textContent = "select an object on the slide to capture it as a tool";
        cap.disabled = true;
      }
      renderList();
      p.append(head, row, cap, stat, list);
      inp.focus();
    });
    sep();
    mk("⇪", "export this deck — .pptx or .md", () => { void doExport().then((m) => addActivity(`deck: ${m}`)); });
    mk("⇩", "import a .pptx into this deck", () => { void doImport().then((m) => addActivity(`deck: ${m}`)); });
    sep();
    // theme swatch picker
    mk("🎨", "deck theme", (b) => {
      const p = pop(b, "deck-themepop");
      for (const name of Object.keys(DECK_THEMES)) {
        const t2 = DECK_THEMES[name];
        const it = document.createElement("button");
        it.className = "deck-lp-item";
        it.innerHTML = `<span class="dt-sw" style="background:${t2.bg};color:${t2.accent}">Aa</span> ${name}`;
        it.addEventListener("click", () => {
          card.dataset.theme = name;
          applyThemeVars(body, name);
          p.remove();
          touch();
        });
        p.append(it);
      }
    });
    // transition picker
    mk("⇢", "slide transition", (b) => {
      const p = pop(b);
      for (const fx of DECK_TRANSITIONS) {
        const it = document.createElement("button");
        it.className = "deck-lp-item" + (fx === (card.dataset.trans ?? "fade") ? " on" : "");
        it.textContent = fx;
        it.addEventListener("click", () => {
          card.dataset.trans = fx;
          p.remove();
          touch();
        });
        p.append(it);
      }
    });
    sep();
    mk("⊞", "slide sorter — thumbnails, drag to reorder, Ctrl+←→ moves", () => openSorter());
    mk("▶", "present (Esc to exit, N for notes)", () => present(active()));
    /* ↑/↓/✕ disable rather than no-op — clicked-and-nothing is how a
     * working deck feels broken */
    refreshBar = () => {
      const n = slides().length;
      const i = active();
      bDel.disabled = n <= 1;
      bUp.disabled = i <= 0;
      bDn.disabled = i >= n - 1;
      bDup.disabled = n < 1;
    };
    refreshBar();
  }

  /* -- slide sorter: a thumbnail grid over the stage (PowerPoint's
   *  Slide Sorter view). Click selects; Ctrl multi; Shift ranges; drag
   *  reorders; Ctrl+←/→ nudges, Ctrl+Shift+←/→ to the ends; Delete
   *  removes; dblclick/Esc exits to that slide. Writes back through
   *  move()/delSlide — the stage DOM is the data. */
  let sorterOv: HTMLElement | null = null;
  const openSorter = () => {
    if (sorterOv) { closeSorter(); return; }
    sorterOv = document.createElement("div");
    sorterOv.className = "deck-sorter";
    sorterOv.contentEditable = "false";
    sorterOv.tabIndex = 0;
    const sel = new Set<number>([active()]);
    let anchor = active();
    let dropAt = -1;

    const paint = () => {
      if (!sorterOv) return;
      sorterOv.innerHTML = `<div class="ds-hint">drag to reorder · Ctrl+←→ move · Ctrl+Shift to ends · Del removes · dblclick/Esc exits</div>`;
      const grid = document.createElement("div");
      grid.className = "ds-grid";
      slides().forEach((sl, i) => {
        const th = document.createElement("div");
        th.className = "ds-thumb" + (sel.has(i) ? " on" : "");
        th.draggable = true;
        const s = slideFromDom(sl);
        const mini = document.createElement("div");
        mini.className = "ds-mini";
        mini.innerHTML = slideHtml(s, i);
        mini.querySelectorAll("[contenteditable]").forEach((x) => (x as HTMLElement).contentEditable = "false");
        th.append(mini);
        const cap = document.createElement("div");
        cap.className = "ds-cap";
        cap.textContent = `${i + 1} · ${s.layout}`;
        th.append(cap);

        th.addEventListener("click", (e) => {
          if (e.shiftKey) {
            sel.clear();
            const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
            for (let k = a; k <= b; k++) sel.add(k);
          } else if (e.ctrlKey || e.metaKey) {
            if (sel.has(i)) sel.delete(i); else sel.add(i);
            anchor = i;
          } else {
            sel.clear();
            sel.add(i);
            anchor = i;
          }
          paint();
        });
        th.addEventListener("dblclick", () => { closeSorter(); show(i); });
        th.addEventListener("dragstart", (e) => {
          if (!sel.has(i)) { sel.clear(); sel.add(i); anchor = i; paint(); }
          e.dataTransfer?.setData("text/x-laido-sorter", "1");
          e.dataTransfer!.effectAllowed = "move";
        });
        th.addEventListener("dragover", (e) => {
          e.preventDefault();
          const r = th.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          dropAt = before ? i : i + 1;
          sorterOv!.querySelectorAll(".ds-thumb").forEach((x) => x.classList.remove("ds-gap"));
          th.classList.add("ds-gap");
          th.dataset.gapBefore = before ? "1" : "0";
        });
        th.addEventListener("dragleave", () => th.classList.remove("ds-gap"));
        th.addEventListener("drop", (e) => {
          e.preventDefault();
          if (dropAt < 0) return;
          moveMany([...sel].sort((a, b) => a - b), dropAt);
          paint();
        });
        grid.append(th);
      });
      sorterOv.append(grid);
    };

    /** move the sorted selection so its first item lands at `at` —
     *  remove them all (indices stay valid in ascending order), then
     *  insert before the element now sitting at the adjusted target */
    const moveMany = (idxs: number[], at: number) => {
      const list = slides();
      const picked = idxs.map((i) => list[i]).filter(Boolean) as HTMLElement[];
      if (!picked.length) return;
      const before = idxs.filter((i) => i < at).length;
      const dest = at - before;
      for (const el of picked) el.remove();
      const anchorEl = slides()[dest] ?? null;
      for (const el of picked) stage.insertBefore(el, anchorEl);
      renumber();
      show(dest);
      touch();
      sel.clear();
      picked.forEach((_, k) => sel.add(dest + k));
      anchor = dest;
    };

    sorterOv.addEventListener("keydown", (e) => {
      const pick = [...sel].sort((a, b) => a - b);
      const i = pick[0] ?? 0;
      const n = slides().length;
      if (e.key === "Escape") { e.preventDefault(); closeSorter(); show(i); }
      else if (e.key === "Enter") { e.preventDefault(); closeSorter(); show(i); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        for (const k of pick.reverse()) delSlide(k);
        sel.clear(); sel.add(Math.min(i, n - 2)); anchor = i;
        paint();
      } else if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
        e.preventDefault();
        moveMany(pick, e.shiftKey ? 0 : Math.max(0, i - 1));
        paint();
      } else if (e.ctrlKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
        e.preventDefault();
        moveMany(pick, e.shiftKey ? n : Math.min(n, i + pick.length + 1));
        paint();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault(); sel.clear(); sel.add(Math.max(0, i - 1)); anchor = Math.max(0, i - 1); paint();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault(); sel.clear(); sel.add(Math.min(n - 1, i + 1)); anchor = Math.min(n - 1, i + 1); paint();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault(); slides().forEach((_, k) => sel.add(k)); paint();
      }
    });
    paint();
    body.append(sorterOv);
    sorterOv.focus();
  };
  const closeSorter = () => { sorterOv?.remove(); sorterOv = null; };

  /* -- present mode: fullscreen overlay, arrow-key nav, transitions -- */
  const present = (start: number) => {
    const ov = document.createElement("div");
    ov.className = "deck-present";
    ov.contentEditable = "false";
    const theme = card.dataset.theme ?? "dark";
    const trans = card.dataset.trans ?? "fade";
    let i = start;
    const frame = document.createElement("div");
    frame.className = "dp-frame";
    const counter = document.createElement("div");
    counter.className = "dp-count";
    const notes = document.createElement("div");
    notes.className = "dp-notes";
    ov.append(frame, counter, notes);
    const render = (dir: number) => {
      const s = slides()[i];
      if (!s) return;
      const clone = s.cloneNode(true) as HTMLElement;
      clone.classList.remove("live");
      clone.querySelectorAll("[contenteditable]").forEach((el) =>
        el.removeAttribute("contenteditable"),
      );
      // editing chrome never shows in present mode
      clone.querySelectorAll(".d-el-h,.d-el-bar,.d-place").forEach((x) => x.remove());
      clone.querySelectorAll(".d-el.on").forEach((x) => x.classList.remove("on"));
      // keep the layout-* class — .dp-slide.layout-* carries the per-layout
      // present styling; wiping className flattens every slide to default
      const layout = s.className.match(/\blayout-\w+/)?.[0] ?? "";
      clone.className = `dslide ${layout} dp-slide fx-${trans}`.replace(/\s+/g, " ").trim();
      if (dir < 0) clone.classList.add("fx-back");
      frame.innerHTML = "";
      frame.append(clone);
      counter.textContent = `${i + 1} / ${slides().length}`;
      notes.textContent = s.dataset.note ?? "";
    };
    const step = (d: number) => {
      const n = slides().length;
      const next = i + d;
      if (next >= n) {
        ov.remove();
        document.removeEventListener("keydown", onKey, true);
        return;
      }
      if (next < 0) return;
      i = next;
      render(d);
    };
    const onKey = (e: KeyboardEvent) => {
      // the overlay hangs on <body>, so a note switch (or card deletion)
      // orphans it — self-destruct instead of eating every keypress forever
      if (!card.isConnected || !ov.isConnected) {
        ov.remove();
        document.removeEventListener("keydown", onKey, true);
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      if (e.key === "Escape") {
        ov.remove();
        document.removeEventListener("keydown", onKey, true);
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown" || e.key === "ArrowDown")
        step(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp" || e.key === "ArrowUp") step(-1);
      else if (e.key === "n" || e.key === "N") notes.classList.toggle("show");
      else if (e.key === "Home") {
        i = 0;
        render(0);
      } else if (e.key === "End") {
        i = slides().length - 1;
        render(0);
      }
    };
    frame.addEventListener("click", () => step(1));
    document.addEventListener("keydown", onKey, true);
    document.body.append(ov);
    applyThemeVars(ov, theme);
    render(0);
  };

  // right-click → deck context menu (layout, bg, notes)
  let ctx: HTMLElement | null = null;
  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    ctx?.remove();
    const sl = (e.target as HTMLElement).closest<HTMLElement>(".dslide");
    if (!sl) return;
    const i = Number(sl.dataset.i ?? 0);
    ctx = document.createElement("div");
    ctx.className = "sheet-ctx";
    ctx.contentEditable = "false";
    const item = (label: string, fn: () => void, dim = false) => {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item" + (dim ? " dim" : "");
      b.innerHTML = label;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ctx?.remove();
        ctx = null;
        fn();
      });
      ctx!.append(b);
    };
    // layout submenu
    const lsub = document.createElement("div");
    lsub.className = "sheet-ctx-sub";
    for (const l of DECK_LAYOUTS) {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item";
      b.textContent = l;
      b.addEventListener("click", () => {
        const s = slideFromDom(sl);
        s.layout = l;
        rebuildSlide(i, s);
      });
      lsub.append(b);
    }
    const lh = document.createElement("div");
    lh.className = "sheet-ctx-item sub";
    lh.innerHTML = "◫&ensp;Change layout <span class='arr'>▸</span>";
    lh.append(lsub);
    ctx.append(lh);
    item("⧉&ensp;Duplicate slide", () => {
      const s = slideFromDom(sl);
      const idx = addSlide(s.layout, i + 1);
      rebuildSlide(idx, s);
    });
    item("✕&ensp;Delete slide", () => delSlide(i));
    item("⤒&ensp;New slide before", () => addSlide("bullets", i));
    item("⤓&ensp;New slide after", () => addSlide("bullets", i + 1));
    item("🎨&ensp;Background…", () => {
      const c = prompt("slide background — #hex or css color (blank clears)", sl.dataset.bg ?? "");
      if (c === null) return;
      sl.dataset.bg = c.trim();
      sl.style.background = c.trim() || "";
      touch();
    });
    item("~&ensp;Speaker notes…", () => {
      const c = prompt("speaker notes for this slide", sl.dataset.note ?? "");
      if (c === null) return;
      sl.dataset.note = c;
      touch();
    });
    item("▶&ensp;Present from here", () => present(i));
    document.body.append(ctx);
    ctx.style.left = `${Math.min(e.clientX, window.innerWidth - 230)}px`;
    ctx.style.top = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
  });
  const onDocDown = (e: Event) => {
    if (!card.isConnected) {
      document.removeEventListener("mousedown", onDocDown);
      return;
    }
    if (ctx && !(e.target as HTMLElement).closest(".sheet-ctx")) {
      ctx.remove();
      ctx = null;
    }
  };
  document.addEventListener("mousedown", onDocDown);

  // upgrade the static markup render.ts emitted
  slides().forEach(wireSlide);
  show(Math.max(0, Math.min(slides().length - 1, Number(stage.dataset.active ?? 0))));

  /* ---- file interchange — .pptx via Rust OOXML, .md via deckToMd ---- */
  const deckPayload = () => ({
    title: card.dataset.topic ?? "deck",
    slides: slides().map((sl) => {
      const s = slideFromDom(sl);
      return { ...s, cols: [s.cols[0], s.cols[1]] };
    }),
  });
  const doExport = async (path?: string): Promise<string> => {
    let p: string | null | undefined = path;
    if (!p) {
      p = await pickSave(
        [
          { name: "PowerPoint", extensions: ["pptx"] },
          { name: "Markdown", extensions: ["md"] },
        ],
        `${card.dataset.topic || "deck"}.pptx`,
      );
      if (!p) return "export cancelled";
    }
    const ext = p.split(".").pop()?.toLowerCase() ?? "pptx";
    try {
      if (ext === "md" || ext === "txt") {
        return await invoke<string>("file_write_text", { path: p, content: deckToMd(card) });
      }
      const theme = DECK_THEMES[card.dataset.theme ?? "dark"];
      return await invoke<string>("deck_pptx_export", { path: p, deck: deckPayload(), theme });
    } catch (e) {
      return `export failed: ${String(e)}`;
    }
  };
  const load = (title: string, arr: Slide[], theme?: string) => {
    stage.querySelectorAll(".dslide").forEach((el) => el.remove());
    for (const s of arr) {
      const tmp = document.createElement("div");
      tmp.innerHTML = slideHtml(s, -1);
      const el = tmp.firstElementChild as HTMLElement;
      stage.append(el);
      wireSlide(el);
    }
    if (!stage.querySelector(".dslide")) addSlide("title");
    if (title) {
      card.dataset.topic = title;
      const t = card.querySelector(".callout-title");
      if (t) t.textContent = title;
    }
    if (theme && DECK_THEMES[theme]) {
      card.dataset.theme = theme;
      applyThemeVars(body, theme);
    }
    renumber();
    show(0);
    touch();
  };
  // chart slides bound to a sheet repaint when that sheet changes; the
  // listener outlives a deleted deck card unless it removes itself once the
  // card leaves the document
  const onSheetChanged = (e: Event) => {
    if (!card.isConnected) {
      (e.currentTarget as Element | null)?.removeEventListener("sheet:changed", onSheetChanged);
      return;
    }
    slides().forEach(paintSlideCharts);
  };
  card.closest(".note-body, body")?.addEventListener("sheet:changed", onSheetChanged);
  const doImport = async (path?: string): Promise<string> => {
    let p: string | null | undefined = path;
    if (!p) {
      p = await pickOpen([{ name: "PowerPoint", extensions: ["pptx"] }]);
      if (!p) return "import cancelled";
    }
    try {
      const deck = await invoke<{ title: string; slides: Slide[] }>("deck_pptx_import", { path: p });
      load(
        deck.title || card.dataset.topic || "deck",
        deck.slides.map((s) => ({
          ...emptySlide(s.layout || "bullets"),
          ...s,
          cols: [s.cols?.[0] ?? [], s.cols?.[1] ?? []],
        })),
      );
      return `${deck.slides.length} slides imported from ${p.split(/[\\/]/).pop()}`;
    } catch (e) {
      return `import failed: ${String(e)}`;
    }
  };

  /* ---- the external api — the ```slides``` fence drives this ---- */
  decks.set(card, {
    title: () => card.dataset.topic ?? "deck",
    count: () => slides().length,
    read: () => {
      const body = slides()
        .map((sl, i) => {
          const s = slideFromDom(sl);
          const parts: string[] = [`[${i + 1}] ${s.layout}`];
          if (s.title) parts.push(`title: ${s.title}`);
          if (s.sub) parts.push(`sub: ${s.sub}`);
          if (s.bullets.length) parts.push(`bullets: ${s.bullets.join(" | ")}`);
          if (s.cols[0].length || s.cols[1].length)
            parts.push(`cols: ${s.cols[0].join(";")} // ${s.cols[1].join(";")}`);
          if (s.img) parts.push(`img: ${s.img}`);
          if (s.quote) parts.push(`quote: ${s.quote}${s.by ? ` — ${s.by}` : ""}`);
          if (s.body) parts.push(`body: ${s.body}`);
          if (s.note) parts.push(`note: ${s.note}`);
          if (s.bg) parts.push(`bg: ${s.bg}`);
          if (s.els.length)
            parts.push(
              `els: ${s.els
                .map(
                  (el, n) =>
                    `{${n + 1}} ${el.kind}${el.shape ? "." + el.shape : ""}@${rnd(el.x)},${rnd(el.y)} ${rnd(el.w)}x${rnd(el.h)}` +
                    (el.text ? ` "${el.text.replace(/\n/g, " ").slice(0, 40)}"` : ""),
                )
                .join(" | ")}`,
            );
          return parts.join("\n  ");
        })
        .join("\n");
      const tl = deckTools(card);
      return tl.length ? `${body}\ntools: ${tl.map((t) => `${t.icon} ${t.name} (${t.els.length} el)`).join(" · ")}` : body;
    },
    addSlide: (layout, at) => addSlide(layout, at),
    delSlide: (i) => delSlide(intIdx(i)),
    moveSlide: (from, to) => move(intIdx(from), intIdx(to)),
    setLayout: (i, layout) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      s.layout = layout;
      rebuildSlide(i, s);
    },
    setSlide: (i, patch) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl || !patch || typeof patch !== "object") return;
      const s = slideFromDom(sl);
      Object.assign(s, patch);
      rebuildSlide(i, s);
    },
    appendBullet: (i, text) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      s.bullets = s.bullets.filter(Boolean);
      s.bullets.push(S(text));
      rebuildSlide(i, s);
    },
    setTheme: (name) => {
      if (!DECK_THEMES[name]) return;
      card.dataset.theme = name;
      applyThemeVars(body, name);
      touch();
    },
    setTransition: (fx) => {
      if (!DECK_TRANSITIONS.includes(fx as never)) return;
      card.dataset.trans = fx;
      touch();
    },
    setBg: (i, color) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return;
      color = S(color);
      sl.dataset.bg = color;
      sl.style.background = color || "";
      touch();
    },
    setNote: (i, text) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return;
      sl.dataset.note = S(text);
      touch();
    },
    duplicate: (i) => {
      i = intIdx(i);
      const s = slideFromDom(slides()[i]);
      const idx = addSlide(s.layout, i + 1);
      rebuildSlide(idx, s);
      return idx;
    },
    listEls: (i) => {
      const sl = slides()[intIdx(i)];
      return sl ? slideFromDom(sl).els : [];
    },
    addEl: (i, patch) => {
      i = intIdx(i);
      const sl = slides()[i];
      const el = sanitizeTplEl(patch);
      if (!sl || !el) return -1;
      const s = slideFromDom(sl);
      s.els.push(el);
      rebuildSlide(i, s);
      return s.els.length - 1;
    },
    setEl: (i, n, patch) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl || !patch || typeof patch !== "object") return;
      const s = slideFromDom(sl);
      n = intIdx(n);
      const cur = s.els[n];
      if (!cur) return;
      const merged = sanitizeTplEl({ ...cur, ...patch });
      if (!merged) return;
      // keep live text when the patch doesn't carry one
      if (!("text" in patch)) merged.text = cur.text;
      s.els[n] = merged;
      rebuildSlide(i, s);
    },
    delEl: (i, n) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      n = intIdx(n);
      if (!s.els[n]) return;
      s.els.splice(n, 1);
      rebuildSlide(i, s);
    },
    listTools: () => deckTools(card),
    addTool: (spec) => {
      const tl = toolFromJson(typeof spec === "string" ? spec : JSON.stringify(spec));
      if (!tl) return "✕ tool spec needs {name, icon, els:[…]} — at least one valid element";
      const tools = deckTools(card).filter((t) => t.name !== tl.name);
      tools.push(tl);
      setDeckTools(card, tools);
      rebuildCtools();
      touch();
      return `tool "${tl.name}" saved to "${card.dataset.topic ?? "deck"}"`;
    },
    delTool: (name) => {
      name = S(name).trim();
      const tools = deckTools(card);
      const keep = tools.filter((t) => t.name !== name);
      if (keep.length === tools.length) return false;
      setDeckTools(card, keep);
      rebuildCtools();
      touch();
      return true;
    },
    stamp: (i, name, x, y, w, h) => {
      i = intIdx(i);
      const sl = slides()[i];
      if (!sl) return "✕ no such slide";
      const tl = deckTools(card).find((t) => t.name === S(name).trim());
      if (!tl) return `✕ no tool named "${name}"`;
      insertTool(
        sl, tl,
        clampN(x ?? 28, -20, 96), clampN(y ?? 32, -20, 96),
        clampN(w ?? 44, 4, 140), clampN(h ?? 30, 2, 140),
      );
      return `stamped "${tl.name}" onto slide ${i + 1}`;
    },
    exportFile: (path) => doExport(path),
    importFile: (path) => doImport(path),
    load: (title, arr, theme) => load(title, arr, theme),
    json: () => ({
      title: card.dataset.topic ?? "deck",
      theme: card.dataset.theme ?? "dark",
      transition: card.dataset.trans ?? "fade",
      slides: slides().map(slideFromDom),
    }),
  });
}

/** spawn-time card builder — an empty deck with a title slide */
export function buildDeckCard(title: string): HTMLElement {
  title = typeof title === "string" ? title : "";
  const card = document.createElement("div");
  card.className = "callout deck-card";
  card.dataset.kind = "deck";
  card.dataset.topic = title || "deck";
  card.dataset.theme = "dark";
  card.dataset.trans = "fade";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${escHtml(title || "deck")}</span></div>` +
    deckInnerHtml({ title, theme: "dark", transition: "fade", slides: [emptySlide("title")] });
  return card;
}
