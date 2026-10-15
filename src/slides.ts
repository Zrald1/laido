/* ---------- Laido Decks — a PowerPoint-style slide widget on the note ----------
 * Storage: `> [!slides] title` callout; `[!slide <layout>]` separators; body
 * lines are markdown-ish (`# title`, `- bullet`, `img: path`, `~ note`).
 * Phase 1: 8 layouts, 8 themes, 5 transitions, slide CRUD/reorder, inline
 * editing, present mode, ` ```slides ` AI verbs via deckApi. See plan.md §8. */

import { invoke } from "./ipc.js";
import { paintChart, fromSheetRange } from "./chart.js";
import { addActivity } from "./log.js";
import { pickOpen, pickSave } from "./sheet.js";

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
}

export const emptySlide = (layout = "bullets"): Slide => ({
  layout,
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
});

export const DECK_LAYOUTS = [
  "title", "section", "bullets", "twocol", "image", "quote", "bigfact", "chart", "blank",
] as const;

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

const escCell = (s: string) => String(s ?? "").replace(/\|/g, "\\|");
const unesc = (s: string) => String(s ?? "").replace(/\\\|/g, "|");

/** `[!slide bullets bg=#fff]` → slide + attrs */
export function parseSlideHead(line: string): { layout: string; bg: string } {
  const m = String(line ?? "").match(/^\[!slide\s*([^\]\s]+)?\s*(?:bg=(\S+))?\s*\]/i);
  return { layout: (m?.[1] ?? "bullets").toLowerCase(), bg: m?.[2] ?? "" };
}

/** one body line inside a [!slide] block mutates the slide model */
export function parseSlideLine(slide: Slide, line: string) {
  const t = String(line ?? "").trim();
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
} {
  if (!Array.isArray(block)) block = [];
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim() || "deck";
  let theme = "dark";
  let transition = "fade";
  const slides: Slide[] = [];
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
  return { title, theme, transition, slides };
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
  if (s.body) out.push(escCell(s.body));
  if (s.note) out.push(`~ ${escCell(s.note)}`);
  return out;
}

export function deckToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const theme = card.dataset.theme ?? "dark";
  const trans = card.dataset.trans ?? "fade";
  const lines: string[] = [
    `> [!slides] ${card.dataset.topic ?? "deck"}`,
    `> [!theme ${theme}]`,
    `> [!transition ${trans}]`,
  ];
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
  return s;
}

/* ---------- slide markup (string HTML — used by render.ts AND thumbs) ---------- */

const escHtml = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ed = `contenteditable="true" spellcheck="false"`;

/** render one slide model to markup — layout decides which parts show */
export function slideHtml(s: Slide, i: number): string {
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
        `<ul class="d-col">${col.map((b) => `<li ${ed}>${escHtml(b)}</li>`).join("")}<li ${ed}></li></ul>`,
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
  return `<div class="dslide layout-${escHtml(s.layout)}" data-layout="${escHtml(s.layout)}" data-i="${i}"${bg}${note}>${inner}</div>`;
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
    slides().forEach((sl, k) => sl.classList.toggle("live", k === i));
    slides().forEach(paintSlideCharts);
    paintThumbs();
  };

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
    const list = slides();
    if (list.length <= 1) return; // a deck keeps at least one slide
    list[i]?.remove();
    renumber();
    show(Math.min(i, slides().length - 1));
    touch();
  };

  const move = (from: number, to: number) => {
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
  };

  /* -- toolbar -- */
  const head = card.querySelector<HTMLElement>(".callout-head");
  let bar = head?.querySelector<HTMLElement>(".deck-bar") ?? null;
  if (!bar && head) {
    bar = document.createElement("div");
    bar.className = "deck-bar";
    bar.contentEditable = "false";
    head.append(bar);
  }
  if (bar && !bar.dataset.wired) {
    bar.dataset.wired = "1";
    const mk = (label: string, tip: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "deck-btn";
      b.innerHTML = label;
      b.title = tip;
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      bar!.append(b);
      return b;
    };
   

    // layout picker for "+ slide"
    mk("+ slide", "add a slide — choose a layout", () => {
      bar!.querySelector(".deck-layoutpop")?.remove();
      const pop = document.createElement("div");
      pop.className = "deck-layoutpop";
      pop.contentEditable = "false";
      for (const l of DECK_LAYOUTS) {
        const b = document.createElement("button");
        b.className = "deck-lp-item";
        b.innerHTML = `${LAYOUT_ICON[l] ?? "▢"} ${l}`;
        b.addEventListener("click", () => {
          addSlide(l, active() + 1);
          pop.remove();
        });
        pop.append(b);
      }
      bar!.append(pop);
      const off = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          document.removeEventListener("mousedown", off);
        }
      };
      setTimeout(() => document.addEventListener("mousedown", off), 0);
    });
    mk("⧉", "duplicate this slide", () => {
      const s = slideFromDom(slides()[active()]);
      const idx = addSlide(s.layout, active() + 1);
      rebuildSlide(idx, s);
    });
    mk("✕", "delete this slide", () => delSlide(active()));
    mk("↑", "move slide earlier", () => move(active(), Math.max(0, active() - 1)));
    mk("↓", "move slide later", () => move(active(), Math.min(slides().length - 1, active() + 1)));
    mk("⇪", "export this deck — .pptx or .md", () => { void doExport().then((m) => addActivity(`deck: ${m}`)); });
    mk("⇩", "import a .pptx into this deck", () => { void doImport().then((m) => addActivity(`deck: ${m}`)); });
    // theme swatch picker
    mk("🎨", "deck theme", () => {
      bar!.querySelector(".deck-layoutpop")?.remove();
      const pop = document.createElement("div");
      pop.className = "deck-layoutpop deck-themepop";
      pop.contentEditable = "false";
      for (const name of Object.keys(DECK_THEMES)) {
        const t2 = DECK_THEMES[name];
        const b = document.createElement("button");
        b.className = "deck-lp-item";
        b.innerHTML = `<span class="dt-sw" style="background:${t2.bg};color:${t2.accent}">Aa</span> ${name}`;
        b.addEventListener("click", () => {
          card.dataset.theme = name;
          applyThemeVars(body, name);
          pop.remove();
          touch();
        });
        pop.append(b);
      }
      bar!.append(pop);
      const off = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          document.removeEventListener("mousedown", off);
        }
      };
      setTimeout(() => document.addEventListener("mousedown", off), 0);
    });
    // transition picker
    mk("⇢", "slide transition", () => {
      bar!.querySelector(".deck-layoutpop")?.remove();
      const pop = document.createElement("div");
      pop.className = "deck-layoutpop";
      pop.contentEditable = "false";
      for (const fx of DECK_TRANSITIONS) {
        const b = document.createElement("button");
        b.className = "deck-lp-item" + (fx === (card.dataset.trans ?? "fade") ? " on" : "");
        b.textContent = fx;
        b.addEventListener("click", () => {
          card.dataset.trans = fx;
          pop.remove();
          touch();
        });
        pop.append(b);
      }
      bar!.append(pop);
      const off = (e: MouseEvent) => {
        if (!pop.contains(e.target as Node)) {
          pop.remove();
          document.removeEventListener("mousedown", off);
        }
      };
      setTimeout(() => document.addEventListener("mousedown", off), 0);
    });
    mk("⊞", "slide sorter — thumbnails, drag to reorder, Ctrl+←→ moves", () => openSorter());
    mk("▶", "present (Esc to exit, N for notes)", () => present(active()));
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
  document.addEventListener("mousedown", (e) => {
    if (!card.isConnected) return;
    if (ctx && !(e.target as HTMLElement).closest(".sheet-ctx")) {
      ctx.remove();
      ctx = null;
    }
  });

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
  // chart slides bound to a sheet repaint when that sheet changes
  card.closest(".note-body, body")?.addEventListener("sheet:changed", () => {
    slides().forEach(paintSlideCharts);
  });
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
    read: () =>
      slides()
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
          return parts.join("\n  ");
        })
        .join("\n"),
    addSlide: (layout, at) => addSlide(layout, at),
    delSlide: (i) => delSlide(i),
    moveSlide: (from, to) => move(from, to),
    setLayout: (i, layout) => {
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      s.layout = layout;
      rebuildSlide(i, s);
    },
    setSlide: (i, patch) => {
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      Object.assign(s, patch);
      rebuildSlide(i, s);
    },
    appendBullet: (i, text) => {
      const sl = slides()[i];
      if (!sl) return;
      const s = slideFromDom(sl);
      s.bullets = s.bullets.filter(Boolean);
      s.bullets.push(text);
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
      const sl = slides()[i];
      if (!sl) return;
      sl.dataset.bg = color;
      sl.style.background = color || "";
      touch();
    },
    setNote: (i, text) => {
      const sl = slides()[i];
      if (!sl) return;
      sl.dataset.note = text;
      touch();
    },
    duplicate: (i) => {
      const s = slideFromDom(slides()[i]);
      const idx = addSlide(s.layout, i + 1);
      rebuildSlide(idx, s);
      return idx;
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
  title = String(title ?? "");
  const card = document.createElement("div");
  card.className = "callout deck-card";
  card.dataset.kind = "deck";
  card.dataset.topic = title || "deck";
  card.dataset.theme = "dark";
  card.dataset.trans = "fade";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${title || "deck"}</span></div>` +
    deckInnerHtml({ title, theme: "dark", transition: "fade", slides: [emptySlide("title")] });
  return card;
}
