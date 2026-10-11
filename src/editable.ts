export function serialize(root: HTMLElement): string {
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
      if (t.trim() !== "") pending.push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    if (el.classList.contains("proposal")) continue;
    flush();
    blocks.push(blockToMd(el));
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
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    return `${"#".repeat(Number(tag[1]))} ${inlineToMd(el)}`.trimEnd();
  }
  if (tag === "ul" || tag === "ol") {
    return Array.from(el.children)
      .map((li, i) => (tag === "ul" ? "- " : `${i + 1}. `) + inlineToMd(li))
      .join("\n");
  }
  if (tag === "blockquote") return `> ${inlineToMd(el)}`;
  if (tag === "hr") return "---";
  // zero-width markers only belong on empty lines — strip them from lines
  // that carry real content so saved notes stay clean
  const txt = inlineToMd(el).replace(/\u200b/g, "").replace(/\n+$/, "");
  // an empty paragraph is a ruled line too — store it as an invisible
  // zero-width space so blank rows survive the markdown round-trip
  if (tag === "p" && txt.trim() === "") return "\u200b";
  return txt;
}

export function normalizeCard(card: HTMLElement) {
  const bodyEl = card.querySelector<HTMLElement>(".callout-body");
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
  normalizeCard(card);
  const kind = card.dataset.kind ?? "ai";
  const id = card.dataset.topic ?? "";
  const color = card.dataset.color ?? "yellow";
  const title = (card.dataset.title ?? card.querySelector(".sticky-title")?.textContent ?? "").trim();
  const head =
    kind === "sticky"
      ? `> [!sticky]${id ? " " + id : ""}${color !== "yellow" ? ` color=${color}` : ""}${title ? " " + title : ""}`
      : `> [!ai] research: ${id}`;
  const lines: string[] = [];
  const bodyEl = card.querySelector<HTMLElement>(".callout-body");
  if (bodyEl) {
    for (const line of bodyLines(bodyEl)) {
      if (line.trim() !== "") lines.push(`> ${line}`);
    }
  }
  const srcEl = card.querySelector(".callout-src");
  if (srcEl) {
    const chips = Array.from(srcEl.querySelectorAll(".src")) as HTMLElement[];
    if (chips.length > 0) {
      const sources = chips
        .map((c) => {
          const title = c.querySelector(".src-title")?.textContent ?? "";
          return `[${title}](${c.dataset.url ?? ""})`;
        })
        .join(" · ");
      lines.push(`> Sources: ${sources}`);
    }
  }
  return `${head}\n${lines.join("\n")}`;
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
    else if (tag === "code") out += "`" + (el.textContent ?? "") + "`";
    else if (tag === "a")
      out += el.classList.contains("wikilink")
        ? `[[${el.dataset.note ?? el.textContent ?? ""}]]`
        : `[${el.textContent ?? ""}](${el.dataset.url ?? ""})`;
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
