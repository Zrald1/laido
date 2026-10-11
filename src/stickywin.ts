import { $, invoke } from "./ipc.js";
import { renderMarkdown } from "./render.js";
import { cardToMd, toggleMark, focusBodyOnCardClick, insertTabIndent } from "./editable.js";
import { STICKY_COLORS } from "./editor.js";

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

  let timer: number | undefined;
  const save = () => {
    void invoke("sticky_save", { id, md: cardToMd(card) });
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
  el.addEventListener("input", saveSoon);
  window.addEventListener("blur", save);
}
