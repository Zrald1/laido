import { $, invoke } from "./ipc.js";
import { renderMarkdown, renderCalloutMd } from "./render.js";
import { cardToMd, toggleMark, focusBodyOnCardClick, insertTabIndent } from "./editable.js";
import { STICKY_COLORS, guardFocusScroll } from "./editor.js";
import { wireTerminal } from "./term.js";

export async function initStickyWindow(spec: string) {
  const id = spec.replace(/^~/, "");
  if (!id) return;
  document.body.classList.add("sticky-mode");
  document.execCommand("defaultParagraphSeparator", false, "p");

  const md = await invoke<string>("sticky_read", { id });
  const holder = document.createElement("div");
  holder.innerHTML = renderMarkdown(md);
  const card = holder.querySelector<HTMLElement>(".callout");
  const el = $("#note-body");
  el.innerHTML = "";
  if (!card) return;
  card.classList.add("sticky-window-card");
  const bg = STICKY_COLORS[card.dataset.color ?? "yellow"] ?? STICKY_COLORS.yellow;
  document.body.style.background = bg;
  document.body.style.borderColor = bg;
  card.contentEditable = "true";
  card.dataset.title = (card.querySelector(".sticky-title")?.textContent ?? "").trim();
  card.querySelector(".callout-head")?.remove();
  focusBodyOnCardClick(card);
  el.append(card);
  guardFocusScroll(el);

  let timer: number | undefined;
  const save = () => {
    // the chat widget (a sibling card) rides along in the same sticky file
    const term = document.querySelector<HTMLElement>("#note-body > .term-card");
    const termMd = term ? cardToMd(term) : "";
    void invoke("sticky_save", { id, md: cardToMd(card) + (termMd ? `\n\n${termMd}` : "") });
  };
  const saveSoon = () => {
    clearTimeout(timer);
    timer = window.setTimeout(save, 700);
  };

  const bar = document.createElement("div");
  bar.className = "sticky-bar";
  bar.setAttribute("data-tauri-drag-region", "");
  const barTitle = document.createElement("span");
  barTitle.className = "sticky-bar-title";
  bar.append(barTitle);
  const toolsBox = document.createElement("div");
  toolsBox.className = "sticky-tools";
  const tools: Array<[string, string, () => void]> = [
    ["B", "Bold", () => document.execCommand("bold")],
    ["I", "Italic", () => document.execCommand("italic")],
    ["H", "Highlight", () => toggleMark()],
    ["C", "Cross out", () => document.execCommand("strikeThrough")],
    ["•", "Bullet list", () => document.execCommand("insertUnorderedList")],
  ];
  for (const [label, title, fn] of tools) {
    const b = document.createElement("button");
    b.className = "sticky-tool";
    b.tabIndex = -1;
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const bodyEl = card.querySelector<HTMLElement>(".callout-body");
      (bodyEl ?? card).focus();
      fn();
      saveSoon();
    });
    toolsBox.append(b);
  }
  bar.append(toolsBox);
  const exit = document.createElement("button");
  exit.className = "sticky-exit";
  exit.tabIndex = -1;
  exit.textContent = "✕";
  exit.title = "Store this sticky and close";
  exit.addEventListener("click", () => void window.__TAURI__.window.getCurrentWindow().close());
  bar.append(exit);
  document.body.prepend(bar);

  barTitle.textContent = card.dataset.title ?? "";
  barTitle.contentEditable = "true";
  barTitle.title = "Click to rename · hold to drag the window";
  let titleHold: number | undefined;
  barTitle.addEventListener("pointerdown", () => {
    titleHold = window.setTimeout(() => {
      void window.__TAURI__.window.getCurrentWindow().startDragging();
    }, 200);
  });
  const cancelTitleHold = () => clearTimeout(titleHold);
  barTitle.addEventListener("pointerup", cancelTitleHold);
  barTitle.addEventListener("pointermove", cancelTitleHold);
  barTitle.addEventListener("pointercancel", cancelTitleHold);
  barTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      // Tab/Enter commits the title and drops the caret at the end of the body
      const bodyEl = card.querySelector<HTMLElement>(".callout-body") ?? card;
      bodyEl.focus();
      const r = document.createRange();
      r.selectNodeContents(bodyEl);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  });
  barTitle.addEventListener("input", () => {
    card.dataset.title = (barTitle.textContent ?? "").trim();
    saveSoon();
  });
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
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
    insertTabIndent(range, block);
    saveSoon();
  });
  // typing chat / terminal alone on a line + Enter spawns the AI chat widget
  // inside the sticky — same widget, same history, same tools
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const node = sel.getRangeAt(0).startContainer;
    const start = node instanceof HTMLElement ? node : node.parentElement;
    const block = start?.closest("p, li, h1, h2, h3, blockquote") as HTMLElement | null;
    const text = (block?.textContent ?? "").trim().toLowerCase();
    if (text !== "chat" && text !== "terminal") return;
    e.preventDefault();
    block?.remove();
    const widget = document.createElement("div");
    widget.className = "callout term-card";
    widget.dataset.kind = "terminal";
    widget.dataset.topic = text === "chat" ? "chat" : "terminal";
    widget.innerHTML =
      `<div class="callout-head"><span class="callout-title">${widget.dataset.topic}</span></div>` +
      `<div class="term-log"></div>` +
      `<div class="term-input-row"><span class="term-prompt">›</span><textarea class="term-input" rows="1" placeholder="ask anything — or ! command" spellcheck="false" autocomplete="off"></textarea></div>`;
    // a sibling of the sticky card — its [!terminal] block then survives the
    // save/reload round-trip as its own card
    el.append(widget);
    wireTerminal(widget);
    const lg = widget.querySelector<HTMLElement>(".term-log");
    if (lg) lg.contentEditable = "false";
    widget.querySelector<HTMLTextAreaElement>(".term-input")?.focus();
    save();
  });
  // Laido commands fired from the sticky's chat land their cards right here
  void window.__TAURI__.event.listen("research:done", (e) => {
    const p = (e as unknown as { payload: { callout: string } }).payload;
    if (!p?.callout) return;
    const bodyEl = card.querySelector<HTMLElement>(".callout-body");
    if (!bodyEl) return;
    const holder = document.createElement("div");
    holder.innerHTML = renderCalloutMd(p.callout);
    const c = holder.firstElementChild as HTMLElement | null;
    if (!c) return;
    bodyEl.append(c);
    save();
  });
  el.addEventListener("input", saveSoon);
  window.addEventListener("blur", save);
}
