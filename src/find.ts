/* ---------- find-in-note — Ctrl+F highlights every match in place ---------
 * Pattern from Obsidian's find-in-note plugins: search the RENDERED dom,
 * wrap matches in <mark class="find-hit"> spans — the note never unrenders,
 * widgets stay widgets. Text nodes inside callouts/cards and any
 * contenteditable=false surface are skipped (their text isn't note text).
 * Enter/Shift+Enter step through hits; Esc closes and clears. */

import { $ } from "./ipc.js";

let bar: HTMLElement | null = null;
let hits: HTMLElement[] = [];
let cur = -1;

const SKIP_SEL = ".callout, [contenteditable='false'], script, style";

/** editable note text nodes only — cards and widget surfaces excluded */
function* textNodes(root: HTMLElement): Generator<Text> {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = w.nextNode() as Text | null;
  while (n) {
    const el = n.parentElement;
    if (el && (n.textContent ?? "").trim() !== "" && !el.closest(SKIP_SEL)) yield n;
    n = w.nextNode() as Text | null;
  }
}

export function clearFind() {
  for (const m of hits) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  }
  hits = [];
  cur = -1;
  bar?.classList.remove("open");
}

function highlight(q: string) {
  for (const m of hits) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent ?? ""), m);
    parent.normalize();
  }
  hits = [];
  cur = -1;
  const body = $<HTMLDivElement>("#note-body");
  if (!q || !body) return;
  const lq = q.toLowerCase();
  /* collect every (node, ranges) first — the TreeWalker is live, so wrapping
   * while iterating re-yields the nodes that surroundContents splits and the
   * loop never terminates */
  const work: Array<{ ranges: Range[] }> = [];
  for (const t of textNodes(body)) {
    const text = t.textContent ?? "";
    let i = 0;
    const ranges: Range[] = [];
    while (true) {
      const at = text.toLowerCase().indexOf(lq, i);
      if (at < 0) break;
      const r = document.createRange();
      r.setStart(t, at);
      r.setEnd(t, at + q.length);
      ranges.push(r);
      i = at + q.length;
      if (ranges.length > 400) break; // safety ceiling for giant notes
    }
    if (ranges.length) work.push({ ranges });
  }
  /* wrap phase — ranges on distinct nodes never invalidate each other; within
   * a node, wrapping in reverse keeps earlier ranges stable as it splits */
  for (const { ranges } of work) {
    const wrapped: HTMLElement[] = [];
    for (const r of ranges.reverse()) {
      const m = document.createElement("mark");
      m.className = "find-hit";
      try {
        r.surroundContents(m);
        wrapped.push(m);
      } catch {
        /* range crossing a boundary — skip */
      }
    }
    hits.push(...wrapped.reverse());
  }
  step(1);
}

function step(d: number) {
  const body = $<HTMLDivElement>("#note-body");
  if (!hits.length) {
    updateCount();
    return;
  }
  hits[cur]?.classList.remove("cur");
  cur = ((cur + d) % hits.length + hits.length) % hits.length;
  const m = hits[cur];
  m.classList.add("cur");
  const r = m.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  if (r.top < br.top || r.bottom > br.bottom) m.scrollIntoView({ block: "center" });
  updateCount();
}

function updateCount() {
  const c = bar?.querySelector(".find-count");
  if (c) c.textContent = hits.length ? `${cur + 1}/${hits.length}` : "0";
}

export function openFind() {
  if (!bar) return;
  bar.classList.add("open");
  const inp = bar.querySelector<HTMLInputElement>(".find-in");
  inp?.focus();
  inp?.select();
}

export function initFind() {
  bar = document.createElement("div");
  bar.id = "findbar";
  bar.innerHTML =
    `<input class="find-in" placeholder="find in note" spellcheck="false"/>` +
    `<span class="find-count"></span>` +
    `<button class="find-b" data-a="prev" title="previous (Shift+Enter)">▲</button>` +
    `<button class="find-b" data-a="next" title="next (Enter)">▼</button>` +
    `<button class="find-b" data-a="x" title="close (Esc)">✕</button>`;
  document.body.appendChild(bar);
  const inp = bar.querySelector<HTMLInputElement>(".find-in")!;
  let deb = 0;
  inp.addEventListener("input", () => {
    window.clearTimeout(deb);
    deb = window.setTimeout(() => highlight(inp.value), 120);
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearFind();
      $<HTMLDivElement>("#note-body")?.focus();
    }
    e.stopPropagation();
  });
  bar.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    if (a === "prev") step(-1);
    else if (a === "next") step(1);
    else if (a === "x") clearFind();
  });
  // Ctrl+F — find inside the open note (Ctrl+Shift+F = vault search,
  // handled by the palette in links.ts)
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
    }
  });
}
