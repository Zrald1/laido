import { sheetToMd } from "./sheet.js";
import { deckToMd } from "./slides.js";
import { todoToMd } from "./todo.js";
import { browserToMd } from "./browser.js";
import { chartToMd } from "./chart.js";
import { cardsToMd } from "./cards.js";
import { mapToMd } from "./map.js";
import { agendaToMd } from "./agenda.js";
import { graphToMd } from "./graph.js";
import { fieldToMd } from "./field.js";
import { canvasToMd } from "./canvas.js";
import { baseToMd } from "./base.js";

const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|\[object [^\]]*\])$/.test(s) ? "" : s; };

/** lines that would re-parse as structure (callout, quote, heading, list,
 *  hr, embed, tex) get a `\` prefix — render.ts strips it back to literal
 *  text so typed markers survive the round-trip instead of transmuting */
const BLOCK_MARKER =
  /^(?:>|#{1,3}\s|[-*]\s|\d+[.)]\s|-{3,}\s*$|\*{3,}\s*$|!\[\[.*\]\]\s*$|`{3,}|\\)/;
const escLine = (l: string) =>
  BLOCK_MARKER.test(l.trimStart()) ? l.replace(/^(\s*)/, "$1\\") : l;

export function serialize(root: HTMLElement): string {
  if (!root?.childNodes) return "";
  const blocks: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) {
      blocks.push(pending.join("\n"));
      pending = [];
    }
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(/\s+$/, "");
      if (t.trim() !== "") pending.push(t.split("\n").map(escLine).join("\n"));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    if (el.classList.contains("proposal")) continue;
    flush();
    const md = blockToMd(el);
    // frontmatter only parses at byte 0 — wherever the panel sits in the
    // DOM, its YAML goes first or it degrades to an <hr> + scattered text
    if (el.classList.contains("fm-props")) {
      if (md !== "") blocks.unshift(md);
      continue;
    }
    // live widgets (chat) serialize to nothing — never stored
    if (md !== "") blocks.push(md);
  }
  flush();
  const md = blocks.join("\n\n").replace(/\n{3,}/g, "\n\n");
  // trim only ASCII whitespace — nbsp padding carries layout information
  return md.replace(/^[ \t\n\r]+/, "").replace(/[ \t\n\r]+$/, "") + "\n";
}

function bodyLines(el: HTMLElement): string[] {
  const out: string[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const l of (node.textContent ?? "").split("\n")) out.push(l);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node as HTMLElement;
    if (e.tagName === "BR") {
      out.push("");
      continue;
    }
    for (const l of inlineToMd(e).split("\n")) out.push(l);
  }
  return out;
}

function blockToMd(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  if (el.classList.contains("callout")) return cardToMd(el);
  if (el.classList.contains("fm-props")) {
    // properties panel → YAML frontmatter; list rows emit `- item` lines
    const rows = Array.from(el.querySelectorAll<HTMLElement>(".fm-row"))
      .map((r) => {
        const vi = r.querySelector<HTMLInputElement>(".fm-v");
        // a checkbox row persists as bare `key: true|false`; date/datetime
        // inputs keep their ISO value; text/list rows read raw
        const v =
          vi?.type === "checkbox"
            ? vi.checked
              ? "true"
              : "false"
            : (vi?.value ?? "").trim();
        return {
          // keys must match the parser's [\w-]+ — anything else would flip
          // the whole block back to raw text on reload
          k: (r.querySelector<HTMLInputElement>(".fm-k")?.value ?? "")
            .trim()
            .replace(/[^\w-]/g, ""),
          v,
          list: r.dataset.list === "1",
        };
      })
      .filter((r) => r.k);
    if (!rows.length) return "";
    const lines = ["---"];
    for (const r of rows) {
      if (r.list) {
        lines.push(`${r.k}:`);
        for (const item of r.v.split(",").map((s) => s.trim()).filter(Boolean))
          lines.push(`  - ${item}`);
      } else {
        lines.push(`${r.k}: ${r.v}`);
      }
    }
    lines.push("---");
    return lines.join("\n");
  }
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    return `${"#".repeat(Number(tag[1]))} ${inlineToMd(el)}`.trimEnd();
  }
  if (tag === "ul" || tag === "ol") return listToMd(el);
  if (tag === "blockquote") {
    // every line keeps its > prefix; a body line that would re-parse as a
    // callout head gets the ZWSP sentinel like callout bodies do
    return inlineToMd(el)
      .split("\n")
      .map((l) => `> ${l.startsWith("[!") ? "​" + l : l}`)
      .join("\n");
  }
  if (tag === "hr") return "---";
  // fenced code — content is verbatim text; a fence longer than any
  // backtick run inside keeps embedded ``` from closing early
  if (tag === "pre") {
    const lang = (el.dataset.lang ?? "").replace(/[^\w-]/g, "");
    const code = (el.textContent ?? "").replace(/\n$/, "");
    const maxRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
    const fence = "`".repeat(Math.max(3, maxRun + 1));
    return `${fence}${lang}\n${code}\n${fence}`;
  }
  // `![[x.png]]` / sized image embeds render as top-level <img> blocks —
  // without this branch the inlineToMd fallback walks the img's (empty)
  // children and the line silently drops out of the file
  if (tag === "img") {
    const img = el as HTMLImageElement;
    const p = img.dataset.asset || img.getAttribute("src") || "";
    if (!p) return "";
    const w = img.getAttribute("width");
    const ht = img.getAttribute("height");
    const dims = w ? `|${w}${ht ? `x${ht}` : ""}` : "";
    return img.dataset.wiki
      ? `![[${p}${dims}]]`
      : `![${(img.alt ?? "") + dims}](${p})`;
  }
  // zero-width markers only belong on empty lines — strip them from lines
  // that carry real content so saved notes stay clean
  const txt = inlineToMd(el).replace(/\u200b/g, "").replace(/\n+$/, "");
  // an empty paragraph is a ruled line too — store it as an invisible
  // zero-width space so blank rows survive the markdown round-trip
  if (tag === "p" && txt.trim() === "") return "\u200b";
  return txt.split("\n").map(escLine).join("\n");
}

export function normalizeCard(card: HTMLElement) {
  const bodyEl = card?.querySelector?.<HTMLElement>(".callout-body");
  if (!bodyEl) return;
  for (const node of Array.from(card.childNodes)) {
    if (node === bodyEl) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const skip =
        el.classList.contains("callout-head") ||
        el.classList.contains("callout-src") ||
        el.classList.contains("grip") ||
        el.classList.contains("card-del") ||
        el.classList.contains("card-menu") ||
        el.classList.contains("card-move") ||
        el.tagName === "BUTTON";
      if (skip) continue;
    }
    bodyEl.append(node);
  }
}

export function focusBodyOnCardClick(card: HTMLElement) {
  card.addEventListener("click", (e) => {
    if (e.target !== card) return;
    const bodyEl = card.querySelector<HTMLElement>(".callout-body");
    if (!bodyEl) return;
    bodyEl.focus();
    const r = document.createRange();
    r.selectNodeContents(bodyEl);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  });
}

export function cardToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  // the sheet widget persists as a markdown table inside [!sheet]
  if (DS(card.dataset.kind) === "sheet" || card.classList.contains("sheet-card"))
    return sheetToMd(card);
  // the deck widget persists as [!slides] + [!slide] blocks
  if (DS(card.dataset.kind) === "deck" || card.classList.contains("deck-card"))
    return deckToMd(card);
  // the todo card persists as [!todo] + "- [ ] task @when" lines
  if (DS(card.dataset.kind) === "todo" || card.classList.contains("todo-card"))
    return todoToMd(card);
  // the browser card persists as [!browser] + url:
  if (DS(card.dataset.kind) === "browser" || card.classList.contains("browser-card"))
    return browserToMd(card);
  // the chart card persists as [!chart] + type:/data:/inline rows
  if (DS(card.dataset.kind) === "chart" || card.classList.contains("chart-card"))
    return chartToMd(card);
  // the flashcards card persists as [!cards] + front::back rows + sched: state
  if (DS(card.dataset.kind) === "cards" || card.classList.contains("cards-card"))
    return cardsToMd(card);
  // the mind-map card persists as [!map] + indented bullets
  if (DS(card.dataset.kind) === "map" || card.classList.contains("map-card"))
    return mapToMd(card);
  // the agenda card persists as just [!agenda] title — content is computed
  if (DS(card.dataset.kind) === "agenda" || card.classList.contains("agenda-card"))
    return agendaToMd(card);
  if (DS(card.dataset.kind) === "graph" || card.classList.contains("graph-card"))
    return graphToMd(card);
  if (DS(card.dataset.kind) === "field" || card.classList.contains("field-card"))
    return fieldToMd(card);
  if (DS(card.dataset.kind) === "canvas" || card.classList.contains("canvas-card"))
    return canvasToMd(card);
  if (DS(card.dataset.kind) === "base" || card.classList.contains("base-card"))
    return baseToMd(card);
  // a note embed persists as the `![[note#heading]]` line it was written as
  if (DS(card.dataset.kind) === "embed" || card.classList.contains("note-embed")) {
    const s = DS(card.dataset.src) ?? "";
    const h = DS(card.dataset.head);
    return `![[${s}${h ? `#${h}` : ""}]]`;
  }
  // the terminal/chat widget persists: the session log as note lines, its
  // chat id in the title, its chosen model as a trailing |token
  if (card.classList.contains("term-card")) {
    const id = DS(card.dataset.chatId) ? ` ${DS(card.dataset.chatId)}` : "";
    const model =
      DS(card.dataset.model) || DS(card.dataset.persona)
        ? `|${DS(card.dataset.model) ?? ""}${DS(card.dataset.persona) ? `@${DS(card.dataset.persona)}` : ""}`
        : "";
    const lines = Array.from(card.querySelectorAll<HTMLElement>(".term-line"))
      .filter((l) => !l.classList.contains("pending") && !l.classList.contains("confirm"))
      .map((l) => {
        const raw = DS(l.dataset.raw) ?? l.textContent ?? "";
        const t = DS(l.dataset.t) ?? "out";
        if (t === "ask") return `› ${raw}`;
        if (t === "cmd") return `! ${raw}`;
        if (t === "err") return `✕ ${raw}`;
        // ai/laido keep their roles across reloads — bare text re-parses as
        // "out" and the session history would mislabel replies as user output
        if (t === "ai") return `≡ ${raw}`;
        if (t === "laido") return `◆ ${raw}`;
        // an out line starting with a type marker would re-parse as that
        // type; a leading [! would end the callout — ZWSP sentinel both
        return raw.replace(/^(\s*)([›!✕≡◆]|\[!)/, "$1​$2");
      });
    return `> [!terminal] ${DS(card.dataset.topic) ?? "terminal"}${id}${model}\n${lines
      .map((l) => `> ${l}`)
      .join("\n")}`;
  }
  normalizeCard(card);
  const kind = DS(card.dataset.kind) ?? "ai";
  const id = DS(card.dataset.topic) ?? "";
  const color = DS(card.dataset.color) ?? "yellow";
  // the editable .sticky-title span is the source of truth — a converted
  // card carries dataset.title from its old head and must not let it
  // override the user's edit
  const title = (card.querySelector(".sticky-title")?.textContent ?? DS(card.dataset.title) ?? "").trim();
  const head =
    kind === "sticky"
      ? `> [!sticky]${id ? " " + id : ""}${color !== "yellow" ? ` color=${color}` : ""}${title ? " " + title : ""}`
      : kind === "ai"
        ? `> [!ai] research: ${id}`
        // any other marker ([!note], [!warning], a future widget kind, a
        // hand-typed callout) keeps its real marker + title — rewriting it
        // to [!ai] silently mutates the note on every save
        : `> [!${kind.replace(/\W+/g, "") || "ai"}]${id ? " " + id : ""}`;
  const lines: string[] = [];
  const bodyEl = card.querySelector<HTMLElement>(".callout-body");
  if (bodyEl) {
    for (const line of bodyLines(bodyEl)) {
      if (line.trim() !== "")
        // a body line starting `[!` would end this callout on reload — the
        // zero-width prefix keeps it inside the block, invisible to the user
        lines.push(`> ${line.replace(/^(\s*)\[!/, "$1​[!")}`);
    }
  }
  const srcEl = card.querySelector(".callout-src");
  if (srcEl) {
    const chips = Array.from(srcEl.querySelectorAll(".src")) as HTMLElement[];
    if (chips.length > 0) {
      const sources = chips
        .map((c) => {
          const title = c.querySelector(".src-title")?.textContent ?? "";
          return `[${title}](${DS(c.dataset.url) ?? ""})`;
        })
        .join(" · ");
      lines.push(`> Sources: ${sources}`);
    }
  }
  return `${head}\n${lines.join("\n")}`;
}

/** <ul>/<ol> → markdown list lines. Nested child lists recurse with a
 *  two-space indent; task items keep `- [ ] text @when`. A clone carries the
 *  item's own text so the live DOM keeps its checkbox and child lists. */
function listToMd(list: HTMLElement, depth = 0): string {
  const pad = "  ".repeat(depth);
  const ord = list.tagName === "OL";
  return Array.from(list.children)
    .filter((li) => li.tagName === "LI")
    .map((li, i) => {
      const l = li as HTMLElement;
      const own = l.cloneNode(true) as HTMLElement;
      own
        .querySelectorAll(":scope > ul, :scope > ol, :scope > .todo-box")
        .forEach((n) => n.remove());
      let text = inlineToMd(own).replace(/^\s+/, "");
      let head = "";
      if (l.classList.contains("todo")) {
        head = l.classList.contains("done") ? "[x] " : "[ ] ";
        if (l.dataset.when) text += ` @${l.dataset.when}`;
      }
      let s = pad + (ord ? `${i + 1}. ` : "- ") + head + text;
      for (const kid of Array.from(l.children))
        if (/^(ul|ol)$/i.test(kid.tagName))
          s += "\n" + listToMd(kid as HTMLElement, depth + 1);
      return s;
    })
    .join("\n");
}

function inlineToMd(node: Node): string {
  let out = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.textContent ?? "";
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains("tex")) {
      const tex = el.dataset.tex ?? "";
      out += el.dataset.disp ? `\\[${tex}\\]` : `\\(${tex}\\)`;
    }
    else if (tag === "br") out += "\n";
    else if (tag === "strong" || tag === "b") out += `**${inlineToMd(el)}**`;
    else if (tag === "em" || tag === "i") out += `*${inlineToMd(el)}*`;
    else if (tag === "mark") {
      const c = (el.className.match(/mk-(\w+)/) ?? [])[1];
      out += `==${c ? c + ":" : ""}${inlineToMd(el)}==`;
    }
    else if (tag === "del" || tag === "s" || tag === "strike") out += `~~${inlineToMd(el)}~~`;
    else if (tag === "sub" || tag === "sup" || tag === "u")
      out += `<${tag}>${inlineToMd(el)}</${tag}>`;
    else if (tag === "code") {
      // a code span whose text contains backticks needs a longer fence;
      // edge-backtick content pads with a space the parser strips
      const t = el.textContent ?? "";
      const maxRun = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
      const f = "`".repeat(maxRun + 1);
      out += /^`|`$/.test(t) ? `${f} ${t} ${f}` : `${f}${t}${f}`;
    }
    else if (tag === "a") {
      if (el.classList.contains("wikilink")) {
        const note = (el.dataset.note ?? "").replace(/[\[\]|]/g, "");
        const label = (el.textContent ?? "").replace(/[\[\]]/g, "");
        // keep the alias — [[note|display]] not just [[note]]
        out += `[[${note}${label && label !== note ? `|${label}` : ""}]]`;
      } else {
        out += `[${el.textContent ?? ""}](${el.dataset.url ?? ""})`;
      }
    }
    // pasted/dropped images persist as `![alt](attachments/x.png)` — the
    // vault-relative path lives on data-asset, remote ones keep src
    else if (tag === "img") {
      const img = el as HTMLImageElement;
      const p = img.dataset.asset || img.getAttribute("src") || "";
      const w = img.getAttribute("width");
      const ht = img.getAttribute("height");
      const dims = w ? `|${w}${ht ? `x${ht}` : ""}` : "";
      if (p) {
        // wiki-embed form survives as ![[x.png|300]]; md form as ![alt|300](p)
        out += img.dataset.wiki
          ? `![[${p}${dims}]]`
          : `![${(img.alt ?? "") + dims}](${p})`;
      }
    }
    // command chips are the visible form of stored @commands — the disk keeps
    // the @ so the legacy parsers (scheduler, agent) still read the file
    else if (el.classList.contains("cmd-chip"))
      out += `@${el.dataset.cmd ?? el.dataset.arg ?? el.textContent ?? ""}`;
    else out += inlineToMd(el);
  });
  return out;
}

function markAround(node: Node | null): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (el) {
    if (el.tagName === "MARK") return el;
    el = el.parentElement;
  }
  return null;
}

/* ---------- tab indent ---------- */

let nbspCtx: CanvasRenderingContext2D | null = null;
const nbspWCache = new Map<string, number>();

export function nbspWidth(block: HTMLElement): number {
  const cs = getComputedStyle(block);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const hit = nbspWCache.get(font);
  if (hit) return hit;
  nbspCtx ??= document.createElement("canvas").getContext("2d");
  const w = nbspCtx
    ? ((nbspCtx.font = font), nbspCtx.measureText("\u00a0").width)
    : 0;
  const width = w > 0 ? w : 8;
  nbspWCache.set(font, width);
  return width;
}

/** Insert an nbsp tab at the given (usually caret) range, sized to the next
 *  8-space tab stop measured from the caret's real x position. */
export function insertTabIndent(
  range: Range,
  block: HTMLElement | null,
  zoom = 1,
) {
  const chW = block ? nbspWidth(block) : 8;
  const tabStop = 8 * chW;
  let n = 8;
  if (block) {
    const rects = range.getClientRects();
    const caretX = rects[rects.length - 1]?.left;
    if (caretX != null) {
      const br = block.getBoundingClientRect();
      const padL = parseFloat(getComputedStyle(block).paddingLeft) * zoom;
      const local = (caretX - br.left - padL) / zoom;
      const over = ((local % tabStop) + tabStop) % tabStop;
      n = Math.max(1, Math.round((tabStop - over) / chW));
    }
  }
  if (!range.collapsed) range.deleteContents();
  const pad = document.createTextNode("\u00a0".repeat(n));
  range.insertNode(pad);
  const r2 = document.createRange();
  r2.setStartAfter(pad);
  r2.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r2);
}

export function toggleMark(color?: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const cls = color && color !== "yellow" ? `mk-${color}` : "";
  // is the selection deliberately inside a card body? if the range's common
  // ancestor lives inside .callout-body, the whole range is provably within
  // it — then card text may be marked; a selection crossing a card still skips
  const root = range.commonAncestorContainer;
  const rootEl = root.nodeType === Node.ELEMENT_NODE ? (root as HTMLElement) : root.parentElement;
  const selInBody = !!rootEl?.closest(".callout-body");
  // only real editable text may be marked — never widget chrome or other non-editable islands
  const editableText = (n: Node) => {
    const p = n.parentElement;
    if (!p || p.closest("[contenteditable=false]")) return false;
    if (!p.closest(".callout")) return true;
    return selInBody && !!p.closest(".callout-body");
  };
  // collect the editable text nodes in the range — including marked ones, so
  // we can tell "unwrap this" from "mark this": a selection that is entirely
  // marked unwraps; anything else gets its unmarked spans marked
  const sc = range.startContainer, so = range.startOffset;
  const ec = range.endContainer, eo = range.endOffset;
  // TreeWalker never yields its own root — a selection inside ONE text node
  // (the common case for word/phrase highlights) has the text node AS root,
  // so walk from its parent instead or the node list comes back empty
  const walkRoot = root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root;
  const tw = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
      if (!n.textContent?.trim() || !editableText(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let nx: Node | null;
  while ((nx = tw.nextNode())) nodes.push(nx as Text);
  const unmarked = nodes.filter((t) => !markAround(t));
  if (!unmarked.length) {
    // everything selected is already marked → unwrap the marks the range touches
    const hits: HTMLElement[] = [];
    const anchorMark = markAround(sel.anchorNode);
    if (anchorMark) hits.push(anchorMark);
    rootEl?.querySelectorAll("mark").forEach((m) => {
      const h = m as HTMLElement;
      if (!hits.includes(h) && range.intersectsNode(h)) hits.push(h);
    });
    for (const m of hits) m.replaceWith(...Array.from(m.childNodes));
    return;
  }
  // wrap the unmarked text nodes individually so widgets inside the range stay untouched
  const made: HTMLElement[] = [];
  for (const t of unmarked) {
    const r = document.createRange();
    r.selectNodeContents(t);
    if (t === sc) r.setStart(t, so);
    if (t === ec) r.setEnd(t, eo);
    const mark = document.createElement("mark");
    if (cls) mark.className = cls;
    try {
      r.surroundContents(mark);
      made.push(mark);
    } catch { /* leave this node unmarked */ }
  }
  if (!made.length) return;
  sel.removeAllRanges();
  const r2 = document.createRange();
  r2.setStartBefore(made[0]);
  r2.setEndAfter(made[made.length - 1]);
  sel.addRange(r2);
}

export function clearFormatting() {
  document.execCommand("removeFormat");
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const anc = range.commonAncestorContainer;
  const root = anc instanceof HTMLElement ? anc : anc.parentElement;
  if (!root) return;
  const targets: HTMLElement[] = [];
  for (const el of Array.from(root.querySelectorAll("mark, del, s, strike")) as HTMLElement[]) {
    if (range.intersectsNode(el)) targets.push(el);
  }
  const markEl = markAround(sel.anchorNode);
  if (markEl && !targets.includes(markEl)) targets.push(markEl);
  for (const el of targets) el.replaceWith(...Array.from(el.childNodes));
}
