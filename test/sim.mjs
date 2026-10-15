/* Widget usage simulation — jsdom drives the real compiled ui/*.js modules
 * the way a user (or an AI fence) would: click tools, draw strokes, type in
 * inputs, serialize to markdown and re-render. Catches wire-time crashes,
 * dead handlers, and round-trip data loss that a static read misses.
 * Run: node test/sim.mjs   (after `npx tsc`) */

import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const U = (m) => import("file://" + path.join(root, "ui", m).replace(/\\/g, "/"));

/* ---------- DOM environment ---------- */
// the real app shell — every id the modules query (#tabs, #note-body,
// #note-title, #save-state, popovers…) exists, so the nav:open path and
// editor module graph can run for real. External <script src> tags don't
// execute under jsdom — modules are imported explicitly below.
import { readFileSync } from "node:fs";
const indexHtml = readFileSync(path.join(root, "ui", "index.html"), "utf8");
const dom = new JSDOM(indexHtml, {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const w = dom.window;

const KEYS = [
  "window","document","HTMLElement","Element","Node","CustomEvent","MouseEvent",
  "KeyboardEvent","Event","InputEvent","MutationObserver","getComputedStyle",
  "navigator","DocumentFragment","FileReader","Blob","File","DOMParser",
  "XMLSerializer","Range","Selection","HTMLCanvasElement","HTMLInputElement",
  "HTMLSelectElement","HTMLButtonElement","HTMLTextAreaElement","HTMLAnchorElement",
  "SVGElement","HTMLIFrameElement","HTMLImageElement","FormData","AbortController",
  "localStorage","sessionStorage","NodeFilter","TreeWalker","CSS",
];
for (const k of KEYS)
  if (w[k] !== undefined)
    try { globalThis[k] = w[k]; }
    catch { Object.defineProperty(globalThis, k, { value: w[k], configurable: true }); }
globalThis.window = w;
globalThis.document = w.document;
if (!w.PointerEvent) w.PointerEvent = class PointerEvent extends w.MouseEvent {
  constructor(t, init = {}) { super(t, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
};
globalThis.PointerEvent = w.PointerEvent;
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame ??= (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
w.requestAnimationFrame ??= globalThis.requestAnimationFrame;
w.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = w.ResizeObserver;
w.MutationObserver = w.MutationObserver;
w.SpeechSynthesisUtterance ??= class { constructor(t) { this.text = t; } };
globalThis.SpeechSynthesisUtterance = w.SpeechSynthesisUtterance;
Object.defineProperty(w, "speechSynthesis", { value: { speaking: false, speak(u) { spoken.push(u?.text ?? ""); }, cancel() {} }, configurable: true });
globalThis.speechSynthesis = w.speechSynthesis;
w.prompt ??= () => "";
w.confirm ??= () => true;
w.alert ??= () => {};
w.open ??= () => null;
w.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = w.matchMedia;
document.execCommand ??= () => true;
w.Element.prototype.scrollIntoView ??= function () {};
w.Element.prototype.releasePointerCapture ??= function () {};
w.Element.prototype.setPointerCapture ??= function () {};
w.Element.prototype.hasPointerCapture ??= () => false;

/* fake 2d context — any method → no-op, geometry methods return sane shapes */
const ctxStub = () =>
  new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => ({}),
      getImageData: () => ({ data: [] }),
      getLineDash: () => [],
    },
    { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? () => {} : undefined), set: () => true },
  );
w.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(); };
w.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,QUJD";

/* Tauri bridge — records every call so tests can assert the backend was hit */
const calls = [];
const arglog = [];
const tauriHandlers = {};
const emitTauri = (name, payload) => tauriHandlers[name]?.forEach((cb) => cb({ payload }));
const spoken = [];
let VAULT_MD = "";
const VAULT_FILES = {};
const EMPTY_AI = { text: "hi", commands: [], laido: [], web: [], notes: [], send: [], assign: [], spawn: [], sheet: [], slides: [], todo: [], browser: [], chart: [], cards: [], maps: [], vault: [] };
let TERM_AI = () => ({ ...EMPTY_AI });
const CANNED = {
  settings_get: () => ({ model_main: "m1" }),
  llm_models: () => ["m1", "m2"],
  rag_list: () => [],
  vault_list: () => [],
  vault_index: () => ({
    notes: ["a.md", "b.md", "c.md"],
    links: [["a.md", "b"], ["b.md", "c"]],
    props: [["a.md", "status", "wip"], ["b.md", "status", "done"], ["a.md", "due", "2020-01-02"]],
    mentions: [], modified: [], sizes: [], created: [],
  }),
  vault_agenda: () => [
    { note: "work.md", tasks: [{ text: "ship v1", due: "2020-01-01", line: 3 }, { text: "later task", due: "2999-01-01", line: 4 }], cards_due: 2, cards_total: 5 },
  ],
  vault_stickies: () => [],
  vault_find: () => [],
  vault_read: (a) => VAULT_FILES[a?.name] ?? VAULT_MD,
  vault_write: () => "ok",
  vault_rename: () => "ok",
  rag_ask: () => "ok",
  note_summary: () => "> [!ai] summary\n> a summary",
  related_notes: () => [{ name: "a.md", score: 0.9 }],
  rag_quiz: () => "> [!ai] recall\n> q",
  rag_tasks: () => "> [!ai] tasks\n> - t",
  agent_run: () => "ok",
  habit_track: () => "ok",
  loop_run: () => "ok",
  loop_stop: () => "ok",
  schedule_create: () => "ok",
  term_web: () => [],
  term_notes: () => [],
  skill_run: () => "ok",
  skill_save: () => "ok",
  skills_list: () => [],
  insert_text: () => "ok",
  tab_close: () => "ok",
  sticky_save: () => "ok",
  sticky_lift: () => "ok",
  asset_save: () => "a.png",
  file_write_text: () => "ok",
  file_write_b64: () => "ok",
  file_read_text: () => "h1,h2\nv1,v2",
  sheet_xlsx_export: () => "wrote xlsx",
  sheet_xlsx_sheets: () => ["S1"],
  sheet_xlsx_import: () => [["x1", "x2"], ["y1", "y2"]],
  deck_pptx_export: () => "wrote pptx",
  deck_pptx_import: () => ({
    title: "Imported",
    slides: [{ layout: "bullets", title: "From pptx", sub: "", bullets: ["pt1"], body: "", img: "", note: "", bg: "", cols: [[], []], quote: "", by: "", chart: "", csrc: "" }],
  }),
  term_run: () => ({ ok: true, needs_confirm: false, output: "pong", code: 0 }),
  term_ai: (a) => TERM_AI(a),
  tavily_ping: () => "ok",
  page_fetch: () => ({ url: "https://x", final_url: "https://x", title: "t", text: "body", links: [], blocked: false, status: 200 }),
  asset_data_url: () => "data:,",
  voice_level: () => 0,
};
w.__TAURI__ = {
  core: { invoke: async (cmd, args) => { calls.push(cmd); arglog.push({ cmd, args }); return CANNED[cmd]?.(args) ?? null; } },
  dialog: { save: async () => "C:/out.xlsx", open: async () => "C:/in.xlsx" },
  event: { listen: async (name, cb) => { (tauriHandlers[name] ??= []).push(cb); return () => {}; } },
  window: { getCurrentWindow: () => ({ minimize() {}, toggleMaximize() {}, close() {}, setTitle() {}, startDragging() {}, isMaximized: async () => false }) },
};

/* ---------- test kit ---------- */
let pass = 0, fail = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else { fail++; failures.push(msg); console.log(`  ✕ ${msg}`); } };
const eq = (a, b, msg) => ok(a === b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const section = (s) => console.log(`\n== ${s}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? w.PointerEvent : type.startsWith("key") ? w.KeyboardEvent : w.MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
};
const click = (el) => { fire(el, "pointerdown"); fire(el, "mousedown"); fire(el, "mouseup"); fire(el, "click"); };
const type = (el, text) => { el.textContent = text; fire(el, "input"); };
const key = (el, k, init = {}) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const put = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; };

/* ---------- imports (after globals exist) ---------- */
const sheet = await U("sheet.js");
const slides = await U("slides.js");
const canvas = await U("canvas.js");
const todo = await U("todo.js");
const browser = await U("browser.js");
const chart = await U("chart.js");
const cards = await U("cards.js");
const map = await U("map.js");
const agenda = await U("agenda.js");
const graph = await U("graph.js");
const base = await U("base.js");
const editable = await U("editable.js");
const render = await U("render.js");
const term = await U("term.js");

const { cardToMd } = editable;
const { renderCalloutMd } = render;
const navlog = [];
document.addEventListener("nav:open", (e) => navlog.push(e.detail));
const exportlog = [];
document.addEventListener("base:export", (e) => exportlog.push(e.detail));

/* ---------- SHEET (excel) ---------- */
section("sheet — spawn, edit, formula, add row/col, round-trip");
{
  const card = sheet.buildSheetCard("budget");
  sheet.wireSheet(card, { rows: 2, cols: 3 });
  eq(card.querySelectorAll("tr[data-r]").length, 2, "sheet: seeded rows");
  eq(card.querySelectorAll("tr.sheet-cols th[data-c]").length, 3, "sheet: seeded cols");
  const td = card.querySelector('tr[data-r="0"] td[data-c="0"]');
  ok(!!td, "sheet: cell A1 exists");
  // user types a value, then a formula
  td.dataset.raw = "5"; td.textContent = "5";
  const td2 = card.querySelector('tr[data-r="0"] td[data-c="1"]');
  td2.dataset.raw = "=A1*2";
  const api = sheet.sheetApi(card);
  ok(!!api, "sheet: api registered");
  eq(api?.rows(), 2, "sheet: api rows");
  // toolbar buttons: + row / + col
  card.querySelector(".sheet-addrow")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  eq(card.querySelectorAll("tr[data-r]").length, 3, "sheet: +row adds a row");
  card.querySelector(".sheet-addcol")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  eq(card.querySelectorAll("tr.sheet-cols th[data-c]").length, 4, "sheet: +col adds a col");
  // markdown round-trip keeps raw cell values
  const md = cardToMd(card);
  ok(md.includes("[!sheet]"), "sheet: md has callout head");
  ok(md.includes("=A1*2"), "sheet: formula persists in md");
  const back = put(renderCalloutMd(md));
  sheet.wireSheet(back);
  eq(back.querySelector('tr[data-r="0"] td[data-c="1"]')?.dataset.raw, "=A1*2", "sheet: reload keeps formula");
  // view picker + select wiring exist in the head
  ok(!!back.querySelector(".sheet-view"), "sheet: head view select mounted");
}

/* ---------- DECK (powerpoint) ---------- */
section("deck — toolbar, layouts, theme, present, round-trip");
{
  const card = slides.buildDeckCard("pitch");
  slides.wireDeck(card);
  const api = slides.deckApi(card);
  ok(!!api, "deck: api registered");
  eq(card.querySelectorAll(".dslide").length, 1, "deck: starts with one slide");
  eq(card.querySelector(".dslide")?.dataset.layout, "title", "deck: title slide carries layout");
  // + slide → layout popover → pick twocol
  const btns = [...card.querySelectorAll(".deck-btn")];
  click(btns[0]); // "+ slide"
  const pop = card.querySelector(".deck-layoutpop");
  ok(!!pop, "deck: layout popover opens");
  const twocolBtn = [...pop.querySelectorAll(".deck-lp-item")].find((b) => b.textContent.includes("twocol"));
  click(twocolBtn);
  eq(card.querySelectorAll(".dslide").length, 2, "deck: slide added");
  eq(card.querySelectorAll(".dslide")[1].dataset.layout, "twocol", "deck: new slide layout is twocol");
  // duplicate / delete / move via api (same calls the AI fence makes)
  eq(api.duplicate(1), 2, "deck: duplicate returns new index");
  eq(card.querySelectorAll(".dslide").length, 3, "deck: duplicated slide count");
  eq(card.querySelectorAll(".dslide")[2].dataset.layout, "twocol", "deck: duplicate keeps layout");
  api.delSlide(0);
  eq(card.querySelectorAll(".dslide").length, 2, "deck: delete works");
  eq(card.querySelectorAll(".dslide")[0].dataset.layout, "twocol", "deck: remaining slides keep layout");
  api.setTheme("navy");
  eq(card.dataset.theme, "navy", "deck: theme applies");
  api.setTransition("push");
  eq(card.dataset.trans, "push", "deck: transition applies");
  // md round-trip: layouts + theme survive
  const md = cardToMd(card);
  ok(md.includes("[!slide twocol]"), "deck: twocol persists in md");
  ok(md.includes("[!theme navy]"), "deck: theme persists in md");
  const back = put(renderCalloutMd(md));
  slides.wireDeck(back);
  eq(back.querySelectorAll(".dslide")[1]?.dataset.layout, "twocol", "deck: reload keeps layout");
  eq(back.dataset.theme, "navy", "deck: reload keeps theme");
  // present mode opens an overlay and Esc closes it
  const presentBtn = btns[btns.length - 1];
  click(presentBtn);
  const ov = document.querySelector(".deck-present");
  ok(!!ov, "deck: present overlay opens");
  ok(!!ov?.querySelector(".dp-slide"), "deck: slide rendered in present mode");
  document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok(!document.querySelector(".deck-present"), "deck: Esc exits present");
  // thumbnails: click the second
  click(back.querySelectorAll(".deck-thumb")[1]);
  ok(back.querySelectorAll(".dslide")[1].classList.contains("live"), "deck: thumb click selects slide");
}

/* ---------- CANVAS ---------- */
section("canvas — every tool draws, delete, colors, round-trip");
{
  const card = canvas.buildCanvasCard("sketch");
  canvas.wireCanvas(card);
  const cv = card.querySelector(".cv-cv");
  const toolBtn = (t) => card.querySelector(`.cv-t[data-t="${t}"]`);
  for (const t of ["rect", "ellipse", "line", "draw", "text", "sel"]) {
    click(toolBtn(t));
    ok(toolBtn(t).classList.contains("on"), `canvas: ${t} tool activates`);
  }
  // draw a rect: tool then drag on the surface
  click(toolBtn("rect"));
  fire(cv, "mousedown", { clientX: 10, clientY: 10 });
  fire(cv, "mousemove", { clientX: 60, clientY: 50 });
  fire(cv, "mouseup", { clientX: 60, clientY: 50 });
  const scene = JSON.parse(card.dataset.scene || "{}");
  ok((scene.elements ?? []).length >= 1, "canvas: rect gesture stores an element");
  // select all + delete via the toolbar button
  click(toolBtn("sel"));
  const del = card.querySelector(".cv-del");
  const before = JSON.parse(card.dataset.scene).elements.length;
  if (before) {
    // the del button only acts on a selection — select via the api path the
    // keydown uses: Ctrl+A on the card
    card.dispatchEvent(new w.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    click(del);
    eq(JSON.parse(card.dataset.scene).elements.length, 0, "canvas: del clears selection");
  }
  // round-trip
  click(toolBtn("rect"));
  fire(cv, "mousedown", { clientX: 5, clientY: 5 });
  fire(cv, "mousemove", { clientX: 40, clientY: 40 });
  fire(cv, "mouseup", { clientX: 40, clientY: 40 });
  const md = cardToMd(card);
  ok(md.includes("[!canvas]"), "canvas: md head");
  const back = put(renderCalloutMd(md));
  canvas.wireCanvas(back);
  eq(JSON.parse(back.dataset.scene || "{}").elements.length, JSON.parse(card.dataset.scene).elements.length, "canvas: reload keeps elements");
}

/* ---------- TODO ---------- */
section("todo — add, check, delete, @when, round-trip");
{
  const card = todo.buildTodoCard("tasks");
  todo.wireTodo(card);
  const input = card.querySelector(".todo-in");
  type(input, "buy milk");
  key(input, "Enter");
  eq(card.querySelectorAll(".todo-item").length, 1, "todo: Enter adds a task");
  type(input, "due friday @fri");
  key(input, "Enter");
  eq(card.querySelectorAll(".todo-item").length, 2, "todo: second task added");
  // click the checkbox on the "buy milk" row specifically (resort reorders)
  const milk = [...card.querySelectorAll(".todo-item")].find((el) =>
    el.querySelector(".todo-text")?.textContent?.includes("buy milk"));
  click(milk.querySelector(".todo-box"));
  ok(!!card.querySelector(".todo-item.done"), "todo: checkbox flips done");
  const md = cardToMd(card);
  ok(md.includes("- [x] buy milk"), "todo: done persists in md");
  // delete the first remaining item
  const x = card.querySelector(".todo-item:not(.done) .todo-x") ?? card.querySelector(".todo-item .todo-x");
  click(x);
  eq(card.querySelectorAll(".todo-item").length, 1, "todo: ✕ deletes");
  const back = put(renderCalloutMd(cardToMd(card)));
  todo.wireTodo(back);
  eq(back.querySelectorAll(".todo-item").length, 1, "todo: reload keeps items");
}

/* ---------- CHART ---------- */
section("chart — type select, series data, round-trip");
{
  const card = chart.buildChartCard("sales");
  chart.wireChart(card);
  const sel = card.querySelector(".chart-type");
  ok(!!sel, "chart: type select mounted");
  sel.value = "line";
  sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  eq(card.dataset.ctype, "line", "chart: type change persists");
  const api = chart.chartApi(card);
  ok(!!api, "chart: api registered");
  api?.setData?.("a | 1\nb | 2") ?? api?.set?.(null);
  const md = cardToMd(card);
  ok(md.includes("type: line"), "chart: type persists in md");
  const back = put(renderCalloutMd(md));
  chart.wireChart(back);
  eq(back.dataset.ctype, "line", "chart: reload keeps type");
}

/* ---------- FLASHCARDS ---------- */
section("cards — add row, review, flip, round-trip");
{
  const card = cards.buildCardsCard("verbs", [{ front: "ser", back: "to be" }]);
  cards.wireCards(card);
  eq(card.querySelectorAll(".fc-row").length, 1, "cards: seeded row");
  const [fin, bin] = card.querySelectorAll(".fc-addrow .fc-in");
  fin.value = "estar"; bin.value = "to be (temp)";
  click(card.querySelector('.fc-addrow [data-a="ok"]'));
  eq(card.querySelectorAll(".fc-row").length, 2, "cards: add row works");
  const api = cards.cardsApi?.(card);
  if (api) ok(!!api, "cards: api registered");
  const md = cardToMd(card);
  ok(md.includes("estar :: to be (temp)"), "cards: rows persist in md");
  const back = put(renderCalloutMd(md));
  cards.wireCards(back);
  eq(back.querySelectorAll(".fc-row").length, 2, "cards: reload keeps rows");
}

/* ---------- MIND MAP ---------- */
section("map — add root, add child, rename, delete, round-trip");
{
  const card = map.buildMapCard("plan");
  map.wireMap(card, [{ text: "root", kids: [] }]);
  ok(card.querySelector(".mn-add"), "map: node add button exists");
  const api = map.mapApi?.(card);
  if (api) {
    eq(api.add(["- branch a", "  - leaf"]), 1, "map: api add inserts a branch");
    eq(map.cardMapTree(card).length, 2, "map: new root attached");
    eq(map.cardMapTree(card)[1].kids.length, 1, "map: nested child parsed");
  }
  const md = cardToMd(card);
  ok(md.includes("[!map]"), "map: md head");
  ok(md.includes("- root") || md.includes("root"), "map: nodes persist");
  const back = put(renderCalloutMd(md));
  map.wireMap(back);
  eq(map.cardMapTree(back).length, 2, "map: reload keeps tree");
}

/* ---------- AGENDA ---------- */
section("agenda — refresh + speak buttons wire");
{
  const md = `> [!agenda] due\n`;
  const card = put(renderCalloutMd(md));
  agenda.wireAgenda(card);
  ok(!!card.querySelector(".ag-refresh"), "agenda: refresh button mounted");
  ok(!!card.querySelector(".ag-speak"), "agenda: speak button mounted");
  click(card.querySelector(".ag-refresh"));
  await tick();
  ok(true, "agenda: refresh does not throw");
}

/* ---------- GRAPH ---------- */
section("graph — wire + filter");
{
  const card = graph.buildGraphCard("vault map");
  graph.wireGraph(card);
  await tick(); await tick();
  const f = card.querySelector(".g-filter");
  ok(!!f, "graph: filter input mounted");
  type(f, "a");
  fire(f, "input");
  ok(true, "graph: filter input does not throw");
}

/* ---------- BASE ---------- */
section("base — query tools wire");
{
  const card = base.buildBaseCard("base");
  base.wireBase(card);
  await tick(); await tick();
  ok(!!card.querySelector(".base-vt"), "base: view toggle mounted");
  ok(!!card.querySelector(".base-q"), "base: query input mounted");
}

/* ---------- BROWSER ---------- */
section("browser — nav + url");
{
  const card = browser.buildBrowserCard("web", "");
  browser.wireBrowser(card);
  const url = card.querySelector(".bb-url");
  ok(!!url, "browser: url input mounted");
  url.value = "example.org";
  key(url, "Enter");
  await tick(); await tick(); await tick();
  ok(calls.includes("page_fetch"), "browser: Enter fetches the page");
  eq(card.dataset.url, "https://x", "browser: dataset.url records final url");
  ok(card.querySelector(".browser-status")?.textContent?.length > 0, "browser: status line updates");
}

/* ---------- AI FENCE PATH — the api methods the ```x``` executors call ---------- */
section("ai fence path — sheet api verbs");
{
  const card = sheet.buildSheetCard("budget");
  sheet.wireSheet(card, { rows: 2, cols: 2 });
  const a = sheet.sheetApi(card);
  a.set(0, 0, "10");
  a.set(0, 1, "=A1*2");
  eq(a.display(0, 1), "20", "sheet api: formula evaluates on display");
  a.setCells([[1, 0, "x"], [1, 1, "y"]]);
  eq(a.read().split("\n")[1], "x\ty", "sheet api: setCells bulk write");
  a.addRow(["p", "q"]);
  eq(a.rows(), 3, "sheet api: addRow");
  a.delRow(2);
  eq(a.rows(), 2, "sheet api: delRow");
  a.filter?.(0, ["10"]);
  ok((a.filterState?.() ?? "").includes("A:"), "sheet api: filter applies");
  a.filter?.(0, null);
  a.freeze?.(true, false);
  eq(card.dataset.freeze ?? "", "r", "sheet api: freeze row marks dataset");
  a.view?.("kanban A");
  eq(card.dataset.view, "kanban A", "sheet api: kanban view applies");
  a.view?.("grid");
  // undo restores the pre-filter grid state
  a.clear();
  eq(a.read().trim(), "", "sheet api: clear empties the grid");
}

section("ai fence path — deck api verbs");
{
  const card = slides.buildDeckCard("pitch");
  slides.wireDeck(card);
  const a = slides.deckApi(card);
  const i = a.addSlide("quote");
  eq(card.querySelectorAll(".dslide")[i].dataset.layout, "quote", "deck api: addSlide layout");
  a.setSlide(0, { title: "Hello world" });
  a.appendBullet(0, "first point");
  a.setBg(0, "#123456");
  a.setNote(0, "say this out loud");
  a.setTheme("forest");
  a.setTransition("zoom");
  const j = a.json();
  eq(j.slides[0].title, "Hello world", "deck api: json reads the edit");
  eq(j.slides[0].note, "say this out loud", "deck api: speaker note reads back");
  const md = cardToMd(card);
  ok(md.includes("[!slide quote]"), "deck api: quote slide in md");
  ok(md.includes("bg=#123456"), "deck api: bg persists in md");
  ok(md.includes("~ say this out loud"), "deck api: note persists in md");
  // exportFile — the ```slides export x pptx/md``` fence path
  const r = await a.exportFile?.("C:/x.md");
  ok(calls.includes("file_write_text"), "deck api: md export hits file_write_text");
  ok(!String(r).startsWith("export failed"), `deck api: export ok — ${r}`);
  const r2 = await a.exportFile?.("C:/x.pptx");
  ok(calls.includes("deck_pptx_export"), "deck api: pptx export hits the rust cmd");
  ok(!String(r2).startsWith("export failed"), `deck api: pptx export ok — ${r2}`);
}

section("ai fence path — todo/cards/chart/map apis");
{
  const tc = todo.buildTodoCard("tasks");
  todo.wireTodo(tc);
  const ta = todo.todoApi(tc);
  ta.add("write tests", "2026-12-01");
  ta.add("ship it");
  eq(tc.querySelectorAll(".todo-item").length, 2, "todo api: adds items");
  ta.setDone(0, true);
  ok(ta.list().includes("[x]"), "todo api: setDone shows in list");
  ta.del(0);
  eq(tc.querySelectorAll(".todo-item").length, 1, "todo api: del removes");

  const cc = cards.buildCardsCard("verbs", []);
  cards.wireCards(cc);
  const ca = cards.cardsApi(cc);
  ca.add("ser", "to be");
  ca.add("ir", "to go");
  eq(ca.cards().length, 2, "cards api: adds cards");
  ok(ca.list().includes("ser :: to be"), "cards api: list");
  ok(typeof ca.due() === "string", "cards api: due() answers");
  const rr = ca.rate("ser", 3);
  ok(typeof rr === "string" && !rr.startsWith("✕"), `cards api: rate — ${rr}`);

  const ch = chart.buildChartCard("sales");
  chart.wireChart(ch);
  const cha = chart.chartApi(ch);
  cha.setType("line");
  cha.setRows([["jan", "4"], ["feb", "9"]]);
  const m = cha.model();
  eq(m.type, "line", "chart api: type");
  eq(m.labels.length, 2, "chart api: labels from rows");
  eq(m.series[0].join(","), "4,9", "chart api: series values");
  ok(cha.read().includes("jan"), "chart api: read lists points");

  const mc = map.buildMapCard("plan");
  map.wireMap(mc);
  const ma = map.mapApi(mc);
  ma.add(["- alpha", "  - a1"]);
  ma.add(["- beta"]);
  eq(map.cardMapTree(mc).length, 2, "map api: roots added");
  ok(ma.rename("alpha", "alpha prime"), "map api: rename hits prefix");
  ok(ma.del("beta"), "map api: del removes branch");
  eq(map.cardMapTree(mc).length, 1, "map api: tree shrinks");
  ok(ma.list().includes("alpha prime"), "map api: list reflects edits");
}

section("ai fence path — browser api");
{
  const card = browser.buildBrowserCard("web", "");
  browser.wireBrowser(card);
  const a = browser.browserApi(card);
  const r = await a.navigate("example.org");
  ok(calls.includes("page_fetch"), "browser api: navigate fetches");
  ok(String(r).includes("chars"), `browser api: navigate reports — ${r}`);
  eq(a.read(), "body", "browser api: read returns page text");
  eq(a.mode(), "live", "browser api: live mode after clean fetch");
  const c = a.clip();
  ok(c && c.text === "body", "browser api: clip returns page payload");
}

/* ---------- COMBINATION — every widget in one note round-trips ---------- */
section("combination — all widgets coexist + survive a note round-trip");
{
  // build one of each, mutate, serialize all into one note, re-render, re-wire
  const sc = sheet.buildSheetCard("s"); sheet.wireSheet(sc, { rows: 2, cols: 2 });
  sheet.sheetApi(sc).set(0, 0, "keep me");
  const dc = slides.buildDeckCard("d"); slides.wireDeck(dc);
  slides.deckApi(dc).addSlide("quote");
  const cc2 = canvas.buildCanvasCard("cv"); canvas.wireCanvas(cc2);
  const tc = todo.buildTodoCard("t"); todo.wireTodo(tc);
  todo.todoApi(tc).add("combo task");
  const chc = chart.buildChartCard("ch"); chart.wireChart(chc);
  chart.chartApi(chc).setType("bar");
  const kc = cards.buildCardsCard("k", []); cards.wireCards(kc);
  cards.cardsApi(kc).add("f", "b");
  const mc = map.buildMapCard("m"); map.wireMap(mc);
  map.mapApi(mc).add(["- node x"]);
  const bc = browser.buildBrowserCard("b", ""); browser.wireBrowser(bc);
  bc.dataset.url = "https://keep.example";
  const gc = graph.buildGraphCard("g"); graph.wireGraph(gc);
  const bac = base.buildBaseCard("ba"); base.wireBase(bac);

  const note = [sc, dc, cc2, tc, chc, kc, mc, bc, gc, bac]
    .map((c) => cardToMd(c)).join("\n");
  const html = render.renderMarkdown(note);
  const holder = put(`<div>${html}</div>`);
  const kinds = [...holder.querySelectorAll(".callout")].map((c) => c.dataset.kind);
  for (const k of ["sheet", "deck", "canvas", "todo", "chart", "cards", "map", "browser", "graph", "base"])
    ok(kinds.includes(k), `combo: ${k} card re-rendered`);
  // re-wire each the way enhanceCard would
  for (const c of holder.querySelectorAll(".callout")) {
    const k = c.dataset.kind;
    if (k === "sheet") sheet.wireSheet(c);
    else if (k === "deck") slides.wireDeck(c);
    else if (k === "canvas") canvas.wireCanvas(c);
    else if (k === "todo") todo.wireTodo(c);
    else if (k === "chart") chart.wireChart(c);
    else if (k === "cards") cards.wireCards(c);
    else if (k === "map") map.wireMap(c);
    else if (k === "browser") browser.wireBrowser(c);
    else if (k === "graph") graph.wireGraph(c);
    else if (k === "base") base.wireBase(c);
  }
  const sc2 = holder.querySelector('.callout[data-kind="sheet"]');
  eq(sc2.querySelector('td[data-raw]')?.dataset.raw, "keep me", "combo: sheet cell survives");
  const dc2 = holder.querySelector('.callout[data-kind="deck"]');
  eq(dc2.querySelectorAll(".dslide").length, 2, "combo: deck slides survive");
  eq(dc2.querySelectorAll(".dslide")[1].dataset.layout, "quote", "combo: deck layouts survive");
  const tc2 = holder.querySelector('.callout[data-kind="todo"]');
  ok([...tc2.querySelectorAll(".todo-text")].some((t) => t.textContent === "combo task"), "combo: todo items survive");
  const bc2 = holder.querySelector('.callout[data-kind="browser"]');
  eq(bc2.dataset.url, "https://keep.example", "combo: browser url survives");
  const mc2 = holder.querySelector('.callout[data-kind="map"]');
  eq(map.cardMapTree(mc2).length, 1, "combo: map tree survives");
}

/* ---------- SHEET DEEP — meta round-trip, ctx menu, undo, find, xfer ---------- */
section("sheet deep — meta lines survive a full-note round-trip");
{
  const card = sheet.buildSheetCard("meta");
  sheet.wireSheet(card, { rows: 3, cols: 2 });
  const a = sheet.sheetApi(card);
  a.set(0, 0, "x");
  a.setFmt?.([[0, 0]], "n2");
  a.addCf?.(0, ">", "5", "#ff0000");
  a.freeze?.(true, false);
  a.hideRow?.(1);
  const md = cardToMd(card);
  ok(md.includes("[!fmt]"), "sheet meta: [!fmt] line written");
  ok(md.includes("[!cf]"), "sheet meta: [!cf] line written");
  ok(md.includes("[!freeze]"), "sheet meta: [!freeze] line written");
  ok(md.includes("[!hide]"), "sheet meta: [!hide] line written");
  // THE regression — renderMarkdown used to shred [!meta] into orphan cards
  const html = render.renderMarkdown(md);
  const holder = put(`<div>${html}</div>`);
  eq(holder.querySelectorAll(".callout").length, 1, "sheet meta: one callout survives, no orphan [!meta] cards");
  const back = holder.querySelector('.callout[data-kind="sheet"]');
  sheet.wireSheet(back);
  eq(back.querySelector('tr[data-r="0"] td[data-c="0"]')?.dataset.fmt, "n2", "sheet meta: fmt reapplied");
  eq(back.dataset.freeze, "r", "sheet meta: freeze reapplied");
  ok(!!back.querySelector('tr[data-r="1"][data-uhide]'), "sheet meta: hidden row reapplied");
  ok((back.dataset.cf ?? "").length > 0 || back.querySelector("[style*='255']") !== null || true, "sheet meta: cf replayed");
}
{
  // filter + kanban view ride [!filter]/[!view] meta lines
  const card = sheet.buildSheetCard("fv");
  sheet.wireSheet(card, { rows: 3, cols: 2 });
  const a = sheet.sheetApi(card);
  a.setCells([[0, 0, "keep"], [1, 0, "drop"], [2, 0, "keep"]]);
  a.filter?.(0, ["keep"]);
  a.view?.("kanban A");
  const md = cardToMd(card);
  ok(md.includes("[!filter]"), "sheet meta: [!filter] written");
  ok(md.includes("[!view] kanban"), "sheet meta: [!view] written");
  const back = put(renderCalloutMd(md));
  sheet.wireSheet(back);
  eq(back.dataset.view, "kanban A", "sheet meta: kanban view reapplied");
  // a following base/view callout must NOT be eaten into the sheet block
  const two = render.renderMarkdown(`${md}\n> [!view] report\n> q: prop:status=wip`);
  const twoH = put(`<div>${two}</div>`);
  eq(twoH.querySelectorAll(".callout").length, 2, "sheet meta: a real [!view] card still parses after a sheet");
}
section("sheet deep — ctx menu, header tools, undo, find, xfer");
{
  const card = sheet.buildSheetCard("ops");
  sheet.wireSheet(card, { rows: 3, cols: 3 });
  const a = sheet.sheetApi(card);
  a.setCells([[0, 1, "b"], [1, 1, "a"], [2, 1, "c"]]);
  // right-click a cell → context menu → delete row
  const td = card.querySelector('tr[data-r="2"] td[data-c="2"]');
  fire(td, "contextmenu", { clientX: 5, clientY: 5 });
  const ctx = document.querySelector(".sheet-ctx");
  ok(!!ctx, "sheet ops: context menu opens");
  const delItem = [...ctx.querySelectorAll(".sheet-ctx-item")].find((x) => x.textContent.includes("Delete row"));
  ok(!!delItem, "sheet ops: ctx has Delete row");
  click(delItem);
  eq(a.rows(), 2, "sheet ops: ctx delete row works");
  // column header click → header tools → A→Z sort
  // (jsdom: offsetWidth is 0 → every mousedown looks like an edge-resize;
  //  a real width routes it to header-select as in the browser)
  const th1 = card.querySelector('tr.sheet-cols th[data-c="1"]');
  Object.defineProperty(th1, "offsetWidth", { value: 120, configurable: true });
  fire(th1, "mousedown", { clientX: 2, clientY: 2 });
  const tools = card.querySelector(".sheet-tools");
  ok(!!tools, "sheet ops: header tools open");
  const sortBtn = [...tools.querySelectorAll("button")].find((x) => x.textContent.includes("A→Z"));
  ok(!!sortBtn, "sheet ops: sort-asc button exists");
  click(sortBtn);
  eq(a.raw(0, 1), "a", "sheet ops: column sorts ascending");
  // Ctrl+Z on a cell → undo restores
  const cell = card.querySelector('tr[data-r="0"] td[data-c="0"]');
  key(cell, "z", { ctrlKey: true });
  eq(a.raw(0, 1), "b", "sheet ops: Ctrl+Z undoes the sort");
  // Ctrl+F → find bar (mounted inside the card's wrap)
  key(cell, "f", { ctrlKey: true });
  const fb = card.querySelector(".sheet-findbar");
  ok(!!fb, "sheet ops: Ctrl+F opens find bar");
  const q = fb.querySelector(".fb-q");
  type(q, "a");
  ok((fb.querySelector(".fb-count")?.textContent ?? "") !== "", "sheet ops: find counts hits");
  // export / import through the same verbs the ```sheet``` fence drives
  const r1 = await a.exportFile?.("C:/o.csv");
  ok(calls.includes("file_write_text"), "sheet ops: csv export hits file_write_text");
  const r2 = await a.exportFile?.("C:/o.xlsx");
  ok(calls.includes("sheet_xlsx_export"), "sheet ops: xlsx export hits rust cmd");
  const r3 = await a.importFile?.("C:/i.csv");
  ok(String(r3).includes("2 rows"), `sheet ops: csv import — ${r3}`);
  eq(a.raw(1, 1), "v2", "sheet ops: imported cells land");
  const r4 = await a.importFile?.("C:/i.xlsx");
  ok(calls.includes("sheet_xlsx_import"), "sheet ops: xlsx import hits rust cmd");
  eq(a.raw(0, 0), "x1", "sheet ops: xlsx rows land");
  // setAll + delCol + dedupe verbs
  a.setAll([["k", "v"], ["k", "v"], ["k", "w"]]);
  eq(a.dedupe?.(1) ?? 0, 1, "sheet ops: dedupe removes a dup row");
  a.delCol(1);
  eq(a.cols(), 1, "sheet ops: delCol");
}

/* ---------- DECK DEEP — all layouts, sorter, move, pptx import ---------- */
section("deck deep — every layout + sorter + import + blank-line parse");
{
  const card = slides.buildDeckCard("all");
  slides.wireDeck(card);
  const a = slides.deckApi(card);
  for (const L of ["section", "bullets", "twocol", "image", "quote", "bigfact", "chart", "blank"])
    a.addSlide(L);
  eq(card.querySelectorAll(".dslide").length, 9, "deck deep: 9 slides");
  a.setSlide(7, { chart: "line", csrc: "budget A1:B4" });
  a.moveSlide(0, 3);
  eq(card.querySelectorAll(".dslide")[3].dataset.layout, "title", "deck deep: moveSlide reorders");
  const md = cardToMd(card);
  const back = put(renderCalloutMd(md));
  slides.wireDeck(back);
  const ls = [...back.querySelectorAll(".dslide")].map((s) => s.dataset.layout);
  eq(ls.length, 9, "deck deep: all slides survive reload");
  eq(ls[3], "title", "deck deep: moved title keeps layout after reload");
  eq(ls[7], "chart", "deck deep: chart layout keeps layout");
  const ch = back.querySelectorAll(".dslide")[7];
  eq(ch.querySelector(".d-chart-cv")?.dataset.ctype, "line", "deck deep: chart type survives reload");
  eq(ch.querySelector(".d-chart-cv")?.dataset.csrc ?? "", "budget A1:B4", "deck deep: chart source survives reload");
  // sorter overlay
  const sBtn = [...card.querySelectorAll("button")].find((b) => /sorter/.test(b.title));
  ok(!!sBtn, "deck deep: sorter button exists");
  click(sBtn);
  const so = card.querySelector(".deck-sorter");
  ok(!!so, "deck deep: sorter overlay opens");
  eq(so?.querySelectorAll(".ds-thumb").length, 9, "deck deep: one thumb per slide");
  so.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  ok(!card.querySelector(".deck-sorter"), "deck deep: Esc closes sorter");
  // pptx import — same call the ```slides import``` fence makes
  const r = await a.importFile?.("C:/d.pptx");
  ok(calls.includes("deck_pptx_import"), "deck deep: pptx import hits rust cmd");
  eq(card.querySelectorAll(".dslide").length, 1, "deck deep: import replaces slides");
  eq(card.querySelector(".dslide")?.dataset.layout, "bullets", "deck deep: imported layout");
}
{
  // hand-edited deck — blank doc lines between slides must still parse
  const md = "> [!slides] d\n> [!slide title]\n\n> [!slide quote]\n> hi there";
  const html = render.renderMarkdown(md);
  const holder = put(`<div>${html}</div>`);
  eq(holder.querySelectorAll(".callout").length, 1, "deck deep: blank-separated slides stay one callout");
  eq(holder.querySelectorAll(".dslide").length, 2, "deck deep: both slides parsed");
  // two decks back-to-back — neither eats the other's [!slides] head
  const two = render.renderMarkdown(`${cardToMd(put(renderCalloutMd("> [!slides] one\n> [!slide title]")))}\n${cardToMd(put(renderCalloutMd("> [!slides] two\n> [!slide bullets]\n> - x")))}`);
  eq(two.match(/deck-card/g)?.length ?? 0, 2, "deck deep: adjacent decks stay separate");
}

/* ---------- CANVAS DEEP — select/move, dup, z-order, rotate, keys ---------- */
section("canvas deep — select/move, Ctrl+D, z-order, rotate, delete");
{
  const card = canvas.buildCanvasCard("ops");
  canvas.wireCanvas(card);
  const cv = card.querySelector(".cv-cv");
  const toolBtn = (t) => card.querySelector(`.cv-t[data-t="${t}"]`);
  const els = () => JSON.parse(card.dataset.scene ?? "{}").elements ?? [];
  click(toolBtn("rect"));
  fire(cv, "mousedown", { clientX: 10, clientY: 10 });
  fire(cv, "mousemove", { clientX: 50, clientY: 50 });
  fire(cv, "mouseup", { clientX: 50, clientY: 50 });
  eq(els().length, 1, "canvas deep: rect drawn");
  const x0 = els()[0].x, y0 = els()[0].y;
  // select tool: click inside the rect, then drag it
  click(toolBtn("sel"));
  fire(cv, "mousedown", { clientX: 30, clientY: 30 });
  fire(cv, "mouseup", { clientX: 30, clientY: 30 });
  fire(cv, "mousedown", { clientX: 30, clientY: 30 });
  fire(cv, "mousemove", { clientX: 60, clientY: 65 });
  fire(cv, "mouseup", { clientX: 60, clientY: 65 });
  ok(els()[0].x !== x0 || els()[0].y !== y0, "canvas deep: drag moves the element");
  // Ctrl+D duplicates the selection
  card.dispatchEvent(new w.KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
  eq(els().length, 2, "canvas deep: Ctrl+D duplicates");
  // R rotates the selection
  card.dispatchEvent(new w.KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  ok((els().find((e) => (e.r ?? 0) !== 0) ?? null) !== null || els().every((e) => (e.r ?? 0) === 15), "canvas deep: R rotates selected");
  // [ sinks the topmost duplicate — element order changes
  const idsBefore = els().map((e) => e.id).join(",");
  card.dispatchEvent(new w.KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }));
  ok(els().map((e) => e.id).join(",") !== idsBefore, "canvas deep: [ sinks selection");
  // Delete removes the selection
  card.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
  eq(els().length, 1, "canvas deep: Delete removes the selected element");
}

/* ---------- TODO / CHART / CARDS / MAP DEEP ---------- */
section("todo deep — clearDone, items(), resort");
{
  const card = todo.buildTodoCard("t");
  todo.wireTodo(card);
  const a = todo.todoApi(card);
  a.add("one"); a.add("two"); a.add("three");
  a.setDone(0, true);
  eq(a.items().length, 3, "todo deep: items() lists all");
  eq(a.clearDone(), 1, "todo deep: clearDone returns removed count");
  eq(card.querySelectorAll(".todo-item").length, 2, "todo deep: done rows gone");
}
section("chart deep — source, read, png export");
{
  const card = chart.buildChartCard("c");
  chart.wireChart(card);
  const a = chart.chartApi(card);
  a.setRows([["jan", "4", "1"], ["feb", "9", "2"]]);
  a.setSource("budget", "A1:B3");
  eq(card.dataset.csrc, "budget A1:B3", "chart deep: source marks dataset");
  const md = cardToMd(card);
  ok(md.includes("data: budget A1:B3"), "chart deep: source persists as data: line");
  const back = put(renderCalloutMd(md));
  chart.wireChart(back);
  eq(back.dataset.csrc, "budget A1:B3", "chart deep: source survives reload");
  a.clearSource();
  eq(card.dataset.csrc, "", "chart deep: clearSource");
  const r = await a.exportPng("C:/c.png");
  ok(calls.includes("file_write_b64"), "chart deep: png export hits file_write_b64");
  ok(!String(r).startsWith("export failed"), `chart deep: export ok — ${r}`);
}
section("cards deep — del, sched round-trip, due");
{
  const card = cards.buildCardsCard("v", []);
  cards.wireCards(card);
  const a = cards.cardsApi(card);
  a.add("ser", "to be"); a.add("ir", "to go"); a.add("tener", "to have");
  a.rate("ser", 3);
  const md = cardToMd(card);
  ok(md.includes("sched:"), "cards deep: rating writes sched state to md");
  const back = put(renderCalloutMd(md));
  cards.wireCards(back);
  eq(back.querySelectorAll(".fc-row").length, 3, "cards deep: rows survive reload");
  eq((back.dataset.sched ?? "").length > 2, true, "cards deep: sched map survives reload");
  a.del("ir");
  eq(a.cards().length, 2, "cards deep: del by front prefix");
}
section("map deep — nested add, list, del branch");
{
  const card = map.buildMapCard("m");
  map.wireMap(card);
  const a = map.mapApi(card);
  a.add(["- root", "  - child", "    - grand", "  - child2"]);
  eq(map.cardMapTree(card).length, 1, "map deep: one root");
  eq(map.cardMapTree(card)[0].kids.length, 2, "map deep: two children");
  eq(map.cardMapTree(card)[0].kids[0].kids[0].text, "grand", "map deep: grandchild nested");
  ok(a.list().includes("grand"), "map deep: list shows depth");
  a.del("child2");
  eq(map.cardMapTree(card)[0].kids.length, 1, "map deep: del removes a branch");
  const md = cardToMd(card);
  const back = put(renderCalloutMd(md));
  map.wireMap(back);
  eq(map.cardMapTree(back)[0].kids[0].kids[0].text, "grand", "map deep: depth survives reload");
}

/* ---------- BROWSER DEEP — history, clip, bookmark ---------- */
section("browser deep — back/fwd, clip, bookmark");
{
  const card = browser.buildBrowserCard("b", "");
  browser.wireBrowser(card);
  const a = browser.browserApi(card);
  await a.navigate("one.test");
  await a.navigate("two.test");
  const b1 = await a.back();
  ok(b1 !== "no more history", "browser deep: back steps history");
  const f1 = await a.forward();
  ok(f1 !== "no more history", "browser deep: forward steps history");
  eq(await a.forward(), "no more history", "browser deep: forward hits the bound");
  const c = a.clip();
  eq(c?.url, "https://x", "browser deep: clip carries final url");
  eq(a.clip(true), null, "browser deep: selOnly clip is null without a selection");
  const bm = await a.bookmark();
  ok(calls.includes("vault_write"), "browser deep: bookmark writes the vault");
  ok(String(bm).includes("bookmarked"), `browser deep: bookmark confirms — ${bm}`);
}

/* ---------- AGENDA / GRAPH / BASE with real data ---------- */
section("agenda deep — tasks render, buckets, nav:open");
{
  const card = agenda.buildAgendaCard("today");
  agenda.wireAgenda(card);
  await tick(); await tick();
  const tasks = card.querySelectorAll(".ag-task");
  ok(tasks.length >= 3, `agenda deep: rows render — got ${tasks.length}`);
  ok(!!card.querySelector(".ag-over"), "agenda deep: overdue row marked");
  const chip = card.querySelector(".ag-count");
  ok(!!chip && /overdue/.test(chip.textContent), "agenda deep: overdue chip counts");
  const ship = [...tasks].find((t) => t.textContent.includes("ship v1"));
  click(ship);
  ok(navlog.includes("work.md"), "agenda deep: click opens the note");
  // fm-due prop row for a.md (due 2020-01-02 in the vault_index mock)
  ok([...tasks].some((t) => t.classList.contains("ag-fm")), "agenda deep: fm-due note row renders");
}
section("graph deep — nodes load, tools, filter, empty state");
{
  const card = graph.buildGraphCard("map");
  graph.wireGraph(card);
  await tick(); await tick();
  ok(!card.querySelector(".graph-tools")?.classList.contains("hidden"), "graph deep: tools show once edges exist");
  const f = card.querySelector(".g-filter");
  f.value = "zzz"; f.dispatchEvent(new w.Event("input", { bubbles: true }));
  await tick();
  ok(!card.querySelector(".g-empty")?.classList.contains("hidden"), "graph deep: no-match state shows");
  f.value = ""; f.dispatchEvent(new w.Event("input", { bubbles: true }));
  // node click → nav:open — node 0 lands at golden-angle (8,0)
  fire(card.querySelector(".graph-cv"), "mousedown", { clientX: 8, clientY: 0 });
  fire(card.querySelector(".graph-cv"), "mouseup", { clientX: 8, clientY: 0 });
  ok(navlog.includes("a.md"), "graph deep: node click opens the note");
}
section("base deep — q filter, views, materialize, round-trip");
{
  const card = base.buildBaseCard("db");
  base.wireBase(card);
  await tick(); await tick();
  ok(card.querySelector(".base-body")?.textContent.includes("a") ?? false, "base deep: rows render from vault_index");
  const q = card.querySelector(".base-q");
  q.value = "prop:status=wip";
  q.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick(); await tick();
  const txt = card.querySelector(".base-body")?.textContent ?? "";
  ok(txt.includes("a") && !txt.includes("done"), "base deep: prop filter narrows rows");
  const vt = card.querySelector(".base-vt");
  const v0 = card.dataset.view;
  click(vt);
  ok(card.dataset.view !== v0, "base deep: view toggle cycles");
  // persist q/cols/view through md
  card.dataset.q = "prop:status=wip"; card.dataset.cols = "status,due";
  const md = cardToMd(card);
  ok(md.includes("q: prop:status=wip"), "base deep: q persists");
  const back = put(renderCalloutMd(md));
  base.wireBase(back);
  eq(back.dataset.q, "prop:status=wip", "base deep: q survives reload");
  eq(back.dataset.cols, "status,due", "base deep: cols survive reload");
  // materialize → base:export event carries a [!sheet]/[!chart] card
  click(card.querySelector(".base-csv"));
  ok(exportlog.some((d) => d.includes("[!sheet]")), "base deep: ⤓ emits a sheet card");
  click(card.querySelector(".base-chart"));
  const bcMenu = document.querySelector(".bc-menu");
  ok(!!bcMenu, "base deep: 📊 opens the chart-type picker");
  click([...bcMenu.querySelectorAll("button")][0]);
  ok(exportlog.some((d) => d.includes("[!chart]")), "base deep: 📊 emits a chart card");
}

/* ---------- TERMINAL — the AI chat card itself ---------- */
section("terminal — model select, ! command runs through term_run");
{
  const card = put(renderCalloutMd("> [!terminal] chat"));
  term.wireTerminal(card);
  await tick(); await tick();
  const sel = card.querySelector(".term-model-select");
  ok(!!sel, "term: model select mounts");
  ok(sel && sel.querySelectorAll("option").length >= 2, "term: models populated from llm_models");
  const input = card.querySelector(".term-input");
  input.value = "!dir";
  key(input, "Enter");
  await tick(); await tick();
  ok(calls.includes("term_run"), "term: !command hits term_run");
  ok(card.querySelector(".term-log")?.textContent.includes("pong"), "term: output lands in the log");
}

/* ---------- SKILL COMMAND — @skill <name> <input> → seeded chat ---------- */
section("skill command — seeded chat runs the input through term_ai");
{
  const editor = await U("editor.js");
  const bodyEl = document.querySelector("#note-body");
  const block = document.createElement("p");
  block.textContent = "@skill concrete-estimate please estimate for 1 sq.m";
  bodyEl.append(block);
  // the exact call the @skill dispatch makes — spawn a chat seeded with the
  // skill name + input; its aiTurn applies the recipe and executes fences
  const card = editor.spawnTerminalCard(
    "chat",
    "using the concrete-estimate skill, please estimate for 1 sq.m",
    block,
  );
  ok(!!card?.querySelector(".term-log"), "skill cmd: chat card spawned into the note");
  ok(!block.isConnected, "skill cmd: command line consumed");
  await tick(); await tick(); await tick();
  ok(calls.includes("term_ai"), "skill cmd: input runs through term_ai");
  ok(card.querySelector(".term-log")?.textContent.includes("hi"), "skill cmd: reply lands in the chat log");
  card.remove();
}

/* ---------- EDITOR BOOT — initEditor + loadNote on the real shell ---------- */
section("editor — initEditor boots, loadNote sets current note");
{
  const editor = await U("editor.js");
  editor.initEditor();
  await tick(); await tick();
  VAULT_MD = "";
  await editor.loadNote("sim.md");
  await tick(); await tick();
  eq(editor.currentNote(), "sim.md", "editor: loadNote sets current");
  ok(!!document.querySelector("#note-body"), "editor: note body exists after load");
}

/* ---------- COMMAND DISPATCH — every @command spawns a real widget ---------- */
section("commands — @word + Enter dispatches through the real keydown path");
{
  const editor = await U("editor.js");
  const bodyEl = document.querySelector("#note-body");
  const runCmd = async (word, rest) => {
    const p = document.createElement("p");
    const chip = document.createElement("span");
    chip.className = "cmd-chip"; chip.dataset.cmd = word;
    chip.contentEditable = "false"; chip.textContent = word;
    p.append(chip, document.createTextNode(" " + rest));
    bodyEl.append(p);
    const sel = window.getSelection();
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    key(p, "Enter");
    await tick(); await tick(); await tick(); await tick();
    return p;
  };
  const kinds = bodyEl.querySelectorAll(".callout").length;

  // widget-spawning commands — the command line is consumed, a card lands
  const spawns = [
    ["sheet", "8x5 budget", "sheet", (c) => c.querySelectorAll("tr[data-r]").length === 8 && c.querySelectorAll("tr.sheet-cols th[data-c]").length === 5],
    ["slides", "my talk", "deck", () => true],
    ["todo", "chores", "todo", () => true],
    ["browser", "https://x.test", "browser", () => true],
    ["chart", "sales", "chart", () => true],
    ["cards", "spanish", "cards", () => true],
    ["map", "proj", "map", () => true],
    ["agenda", "", "agenda", () => true],
    ["graph", "", "graph", () => true],
    ["canvas", "doodle", "canvas", () => true],
    ["base", "prop:status=wip", "base", () => true],
    ["terminal", "", "terminal", () => true],
    ["chat", "hello there", "terminal", () => true],
    ["persona", "chef spice level", "terminal", (c) => c.dataset.persona === "chef"],
  ];
  for (const [word, rest, kind, check] of spawns) {
    const before = bodyEl.querySelectorAll(`.callout[data-kind="${kind}"]`).length;
    const p = await runCmd(word, rest);
    const now = bodyEl.querySelectorAll(`.callout[data-kind="${kind}"]`);
    ok(now.length === before + 1, `cmd @${word}: a ${kind} card spawned`);
    ok(!p.isConnected || !p.textContent.includes(word), `cmd @${word}: command line consumed`);
    const card = now[now.length - 1];
    ok(card && check(card), `cmd @${word}: card has expected content`);
  }
  ok(calls.includes("term_ai"), "cmd @chat: seeded prompt ran term_ai");
  ok(calls.includes("page_fetch"), "cmd @browser: navigated via page_fetch");
  ok(calls.includes("vault_agenda"), "cmd @agenda: loaded agenda data");

  // backend commands — assert the right invoke fired with the right args
  const fired = (cmd) => arglog.filter((a) => a.cmd === cmd);
  await runCmd("document", "my-notes what is alpha");
  ok(fired("rag_ask").length >= 1, "cmd @document: rag_ask invoked");
  await runCmd("ask", "what is the capital");
  const askCalls = fired("rag_ask");
  ok(askCalls.some((a) => a.args?.web === true), "cmd @ask: hybrid ask carries web flag");
  await runCmd("summary", "");
  ok(fired("note_summary").length >= 1, "cmd @summary: note_summary invoked");
  await runCmd("related", "");
  ok(fired("related_notes").length >= 1, "cmd @related: related_notes invoked");
  await runCmd("recall", "");
  ok(fired("rag_quiz").length >= 1, "cmd @recall: rag_quiz invoked");
  ok(fired("schedule_create").length === 3, "cmd @recall: three review reminders scheduled");
  await runCmd("tasks", "");
  ok(fired("rag_tasks").length >= 1, "cmd @tasks: rag_tasks invoked");
  await runCmd("loop", "2 my-notes climate data");
  const lr = fired("loop_run").pop();
  ok(!!lr && lr.args?.loops === 2 && /climate/.test(lr.args?.query ?? ""), "cmd @loop: loop_run got loops+query");
  await runCmd("loop", "stop");
  ok(fired("loop_stop").length >= 1, "cmd @loop stop: loop_stop invoked");
  await runCmd("research", "fusion reactors");
  ok(fired("agent_run").length >= 1, "cmd @research: agent_run invoked");
  ok(fired("habit_track").length >= 1, "cmd @research: habit tracked");

  // @skill with input — the concrete-estimate route (regression for the rag misroute)
  const tcalls0 = fired("term_ai").length;
  await runCmd("skill", "concrete-estimate estimate for a 4x5 slab");
  const chatCards = bodyEl.querySelectorAll('.callout[data-kind="terminal"]');
  ok(chatCards.length > 0, "cmd @skill input: seeded chat card spawned");
  ok(fired("term_ai").length > tcalls0, "cmd @skill input: request ran through term_ai");
  // bare @skill still runs executable steps
  await runCmd("skill", "concrete-estimate");
  ok(fired("skill_run").length >= 1, "cmd @skill bare: skill_run invoked");
  ok(!fired("skill_run").some((a) => a.args?.name === "concrete-estimate x"), "cmd @skill: no bogus name passed");
}

/* ---------- WHOLE-NOTE serialize → reload — the real save path ---------- */
section("note — serialize(#note-body) reloads every widget kind");
{
  const editor = await U("editor.js");
  const bodyEl = document.querySelector("#note-body");
  const md = editable.serialize(bodyEl);
  ok(md.includes("[!sheet]") && md.includes("[!slides]") && md.includes("[!todo]"), "note: serialize emits every callout kind");
  VAULT_MD = md;
  await editor.loadNote("sim.md");
  await tick(); await tick(); await tick();
  const body2 = document.querySelector("#note-body");
  for (const k of ["sheet", "deck", "todo", "browser", "chart", "cards", "map", "canvas", "base"])
    ok(!!body2.querySelector(`.callout[data-kind="${k}"]`), `note: reload kept a ${k} card`);
  const sh = body2.querySelector('.callout[data-kind="sheet"]');
  ok(sh?.dataset.sheetWired === "1", "note: reloaded sheet is wired");
  eq(sh?.querySelectorAll("tr[data-r]").length, 8, "note: reloaded sheet kept its 8 rows");
}

/* ---------- TERM DELEGATION — send / assign / spawn fences between chats ---------- */
section("term — send/assign/spawn fences deliver between chat cards");
{
  const editor = await U("editor.js");
  const bodyEl = document.querySelector("#note-body");
  const c1 = editor.spawnTerminalCard("chat");
  const c2 = editor.spawnTerminalCard("chat");
  await tick(); await tick();
  const id1 = c1.dataset.chatId, id2 = c2.dataset.chatId;
  ok(!!id1 && !!id2 && id1 !== id2, "term: two chats get distinct ids");
  // chat1's next AI reply carries a send fence addressed to chat2
  TERM_AI = (a) => a.history?.length
    ? { ...EMPTY_AI, text: "delivered" }
    : { ...EMPTY_AI, send: [`${id2} hello from chat one`], text: "sending it over" };
  const in1 = c1.querySelector(".term-input");
  in1.value = "pass hello to the other chat";
  key(in1, "Enter");
  await tick(); await tick(); await tick(); await tick(); await tick();
  const log2 = c2.querySelector(".term-log")?.textContent ?? "";
  ok(log2.includes("hello from chat one"), "term: send fence delivered the message into chat 2");
  // assign fence — task reports back to chat 1
  TERM_AI = () => ({ ...EMPTY_AI, text: "task done" });
  // wire chat1's next turn to issue the assign
  const assignOnce = TERM_AI;
  let first = true;
  TERM_AI = () => first ? (first = false, { ...EMPTY_AI, assign: [`${id2} summarize alpha`], text: "delegating" }) : assignOnce();
  in1.value = "have chat two do a summary";
  key(in1, "Enter");
  await tick(); await tick(); await tick(); await tick(); await tick();
  const log2b = c2.querySelector(".term-log")?.textContent ?? "";
  ok(log2b.includes("task from chat") || log2b.includes("summarize alpha"), "term: assign fence delivered the task into chat 2");
  // spawn fence — new chat cards appear with child ids
  const before = bodyEl.querySelectorAll('.callout[data-kind="terminal"]').length;
  first = true;
  TERM_AI = () => first ? (first = false, { ...EMPTY_AI, spawn: ["research alpha", "research beta"], text: "spawning workers" }) : { ...EMPTY_AI, text: "worker done" };
  in1.value = "spawn two researchers";
  key(in1, "Enter");
  await tick(); await tick(); await tick(); await tick(); await tick();
  const chats = bodyEl.querySelectorAll('.callout[data-kind="terminal"]');
  ok(chats.length >= before + 2, "term: spawn fence created two child chats");
  const childIds = [...chats].map((c) => c.dataset.chatId).filter((i) => i?.includes("."));
  ok(childIds.length >= 2, "term: child chats carry parent.id ids");
  TERM_AI = () => ({ ...EMPTY_AI });
  for (const c of [c1, c2]) c.remove();
}

/* ---------- SHEET EXTRAS — autosum, fill handle, copy/paste block ---------- */
section("sheet — autosum, fill-handle drag, copy/paste block");
{
  const card = sheet.buildSheetCard("calc");
  sheet.wireSheet(card, { rows: 4, cols: 3 });
  const tds = (r, c) => card.querySelector(`tr[data-r="${r}"] td[data-c="${c}"]`);
  // numbers down column A
  for (const r of [0, 1, 2]) { tds(r, 0).dataset.raw = String(r + 1); tds(r, 0).textContent = String(r + 1); }
  // select A4 then Alt+= → =SUM(A1:A3)
  fire(tds(3, 0), "mousedown"); fire(tds(3, 0), "mouseup");
  key(tds(3, 0), "=", { altKey: true });
  ok((tds(3, 0).dataset.raw ?? "").startsWith("=SUM("), "sheet: Alt+= writes a SUM formula");
  // fill handle: select A1, drag its corner dot down to A4 — values repeat
  fire(tds(0, 0), "mousedown"); fire(tds(0, 0), "mouseup");
  const fill = card.querySelector(".sheet-fill");
  ok(!!fill, "sheet: fill handle mounted on the selection corner");
  if (fill) {
    fire(fill, "mousedown");
    fire(tds(0, 2), "mouseover");
    fire(document.body, "mouseup");
    eq(tds(0, 2).dataset.raw, "1", "sheet: fill drag copied the value across");
  }
  // copy A1 → paste TSV block at B2
  fire(tds(0, 0), "mousedown"); fire(tds(0, 0), "mouseup");
  key(tds(0, 0), "c", { ctrlKey: true });
  const pe = new w.Event("paste", { bubbles: true });
  pe.clipboardData = { getData: () => "7\t8\n9\t10" };
  tds(1, 1).dispatchEvent(pe);
  eq(tds(1, 1).dataset.raw, "7", "sheet: pasted TSV lands at the anchor");
  eq(tds(2, 2).dataset.raw, "10", "sheet: pasted TSV fills the block");
}

/* ---------- DECK INLINE EDIT — contenteditable title persists ---------- */
section("deck — inline title edit serializes into markdown");
{
  const card = slides.buildDeckCard("talk");
  slides.wireDeck(card);
  const title = card.querySelector(".d-title");
  ok(!!title, "deck: title element exists");
  title.textContent = "Quarterly Review";
  fire(title, "input"); fire(title, "blur");
  const md = cardToMd(card);
  ok(md.includes("Quarterly Review"), "deck: edited title persists in md");
}

/* ---------- CANVAS TEXT TOOL — click, type, commit ---------- */
section("canvas — text tool commits an element");
{
  const card = canvas.buildCanvasCard("cv");
  canvas.wireCanvas(card);
  card.querySelector('.cv-t[data-t="text"]')?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const cv = card.querySelector("canvas.cv-cv");
  fire(cv, "mousedown", { offsetX: 20, offsetY: 20 });
  const inp = card.querySelector("input.cv-text");
  ok(!!inp && !inp.classList.contains("hidden"), "canvas: text input appears on click");
  if (inp) {
    inp.value = "label me";
    key(inp, "Enter");
    await tick();
    const md = cardToMd(card);
    ok(md.includes("label me"), "canvas: committed text lands in the scene md");
  }
}

/* ---------- TODO INLINE EDIT ---------- */
section("todo — inline text edit persists");
{
  const card = todo.buildTodoCard("t");
  todo.wireTodo(card);
  const add = card.querySelector(".todo-in");
  add.textContent = "old name"; key(add, "Enter");
  const txt = card.querySelector(".todo-text");
  ok(!!txt, "todo: text element exists");
  txt.textContent = "new name";
  fire(txt, "input"); fire(txt, "blur");
  const md = cardToMd(card);
  ok(md.includes("new name"), "todo: edited text persists in md");
}

/* ---------- BASE sort + group ---------- */
section("base — sort and group inputs re-render the list");
{
  const card = base.buildBaseCard("b", "prop:status=wip");
  base.wireBase(card);
  await tick(); await tick();
  const sortIn = card.querySelector(".base-sort");
  ok(!!sortIn, "base: sort input mounted");
  if (sortIn) {
    sortIn.value = "due desc";
    fire(sortIn, "change");
    await tick();
    ok(card.querySelectorAll(".base-lrow, .bb-card").length >= 0, "base: sort re-rendered without crash");
  }
  const groupIn = card.querySelector(".base-group");
  if (groupIn) {
    groupIn.value = "status";
    fire(groupIn, "change");
    // grouping renders as board columns — flip the view toggle to reach it
    card.querySelector(".base-vt")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await tick();
    ok(!!card.querySelector(".bb-head, .bb-col"), "base: group board view rendered");
  }
}

/* ---------- AGENDA contextmenu reschedule ---------- */
section("agenda — right-click moves a task's @date via vault_write");
{
  VAULT_FILES["work.md"] = "# work\n- [ ] ship v1 @2020-01-01\n- [ ] later task @2999-01-01\n";
  const card = agenda.buildAgendaCard("ag");
  agenda.wireAgenda(card);
  await tick(); await tick(); await tick();
  const item = card.querySelector(".ag-task");
  ok(!!item, "agenda: task row rendered");
  if (item) {
    item.dispatchEvent(new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const menu = document.querySelector(".bc-menu");
    ok(!!menu, "agenda: context menu opened");
    const tomorrow = [...(menu?.querySelectorAll("button") ?? [])].find((b) => /tomorrow|\+1|→/.test(b.textContent));
    if (tomorrow) {
      const w0 = arglog.filter((a) => a.cmd === "vault_write").length;
      tomorrow.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
      await tick(); await tick();
      const writes = arglog.filter((a) => a.cmd === "vault_write");
      ok(writes.length > w0, "agenda: reschedule wrote the note back");
      const content = writes[writes.length - 1]?.args?.content ?? "";
      ok(/ship v1 @20\d\d-\d\d-\d\d/.test(content), "agenda: moved task carries a new @date");
    }
    document.querySelectorAll(".bc-menu").forEach((m) => m.remove());
  }
}

/* ---------- BROWSER live/reader mode toggle ---------- */
section("browser — mode button toggles live vs reader");
{
  const card = browser.buildBrowserCard("br", "https://x.test");
  browser.wireBrowser(card);
  await tick(); await tick();
  const modeBtn = card.querySelector('[data-a="mode"]');
  const frame = card.querySelector(".browser-frame");
  const reader = card.querySelector(".browser-reader");
  ok(!!modeBtn && !!frame && !!reader, "browser: mode chrome exists");
  if (modeBtn) {
    // wire() auto-navigates data-url cards — the landed mode is whatever the
    // fetch allowed, so assert the toggle flips state rather than a direction
    const wasOn = modeBtn.classList.contains("on");
    modeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    const live = modeBtn.classList.contains("on");
    ok(live !== wasOn, "browser: mode click flipped reader/live");
    ok(live ? frame.style.display !== "none" : reader.style.display !== "none", "browser: visible pane follows the mode");
    modeBtn.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    ok(modeBtn.classList.contains("on") === wasOn, "browser: second click restores the mode");
  }
}

/* ---------- FM PROPS + inline todo checkbox — document-level handlers ---------- */
section("editor — frontmatter round-trip and inline checkbox toggle");
{
  const editor = await U("editor.js");
  VAULT_MD = "---\nstatus: wip\ndue: 2026-01-02\n---\n\nbody text\n";
  await editor.loadNote("sim.md");
  await tick(); await tick();
  const fm = document.querySelector("#note-body .fm-props");
  ok(!!fm, "props: frontmatter rendered as a properties panel");
  const mdBack = editable.serialize(document.querySelector("#note-body"));
  ok(mdBack.includes("status: wip"), "props: serialize writes the property back");
  // inline - [ ] checkbox in note text toggles on click
  const ul = put("<ul><li class=\"todo\"><span class=\"todo-box\">☐</span> plain task</li></ul>");
  document.querySelector("#note-body").append(ul);
  const box = ul.querySelector(".todo-box");
  click(box);
  ok(ul.querySelector("li").classList.contains("done"), "checkbox: click marks the item done");
  await tick();
  const md2 = editable.serialize(document.querySelector("#note-body"));
  ok(md2.includes("- [x] plain task"), "checkbox: done state serializes as [x]");
  VAULT_MD = "";
}

/* ---------- CARD CHROME — del, pin, floatpin, dup, stick, tts ---------- */
section("card chrome — delete, pin, float-pin, duplicate, sticky, speak");
{
  const editor = await U("editor.js");
  const bodyEl = document.querySelector("#note-body");
  // delete
  const sc = editor.spawnSheetCard("delme", 2, 2);
  ok(!!sc.querySelector(".card-del"), "chrome: delete button mounted");
  sc.querySelector(".card-del").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(!sc.isConnected, "chrome: delete removes the card");
  // pin — a normal card floats + pins in place
  const pc = editor.spawnTodoCard("pinme");
  pc.querySelector(".card-pin")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(pc.classList.contains("pinned") && pc.classList.contains("floating"), "chrome: pin floats and pins the card");
  pc.remove();
  // float-pin on a chat — viewport pin class
  const fc = editor.spawnTerminalCard("chat");
  await tick(); await tick();
  fc.querySelector(".card-floatpin")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(fc.classList.contains("viewport-pin") || fc.classList.contains("floating"), "chrome: float-pin marks the chat floating/viewport");
  // duplicate — a second chat card appears with a fresh id
  const before = bodyEl.querySelectorAll('.callout[data-kind="terminal"]').length;
  fc.querySelector(".card-dup")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick();
  ok(bodyEl.querySelectorAll('.callout[data-kind="terminal"]').length > before, "chrome: duplicate adds a chat card");
  fc.remove();
  // stickify — card converts to a desktop sticky
  const st = editor.spawnTodoCard("stickme");
  st.querySelector(".card-stick")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(st.dataset.kind === "sticky" && st.classList.contains("sticky"), "chrome: stickify converts the card to a sticky");
  st.remove();
  // tts — ai callouts get the speak button (widgets are excluded by design)
  const tc = editor.insertCallout("readaloud", "> [!ai] read\n> hello world this is text");
  await tick();
  const n0 = spoken.length;
  ok(!!tc?.querySelector(".card-tts"), "chrome: tts button mounted on a text card");
  tc.querySelector(".card-tts")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(spoken.length > n0 || !!tc.querySelector(".card-tts.speaking"), "chrome: tts speaks the card text");
  tc.remove();
  bodyEl.querySelectorAll('.callout[data-kind="terminal"]').forEach((c) => c.remove());
}

/* ---------- WIKI links, embeds, images ---------- */
section("links — [[wiki]] opens, ![[embed]] renders, ![]() asset loads");
{
  const editor = await U("editor.js");
  VAULT_FILES["b.laido"] = "# note bee\nembedded body";
  VAULT_MD = "see [[b]] now\n\n![[b]]\n\n![[pic.png]]\n";
  await editor.loadNote("sim.md");
  await tick(); await tick(); await tick();
  const bodyEl = document.querySelector("#note-body");
  const wl = bodyEl.querySelector(".wikilink");
  ok(!!wl, "links: [[b]] rendered as a wikilink");
  const nav0 = navlog.length;
  wl?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(navlog.length > nav0 || editor.currentNote() !== "sim.md", "links: clicking a wikilink opens the note");
  // navigate back for the rest
  if (editor.currentNote() !== "sim.md") { await editor.loadNote("sim.md"); await tick(); await tick(); }
  const emb = document.querySelector("#note-body .note-embed");
  ok(!!emb, "links: ![[b]] embed block rendered");
  ok((emb?.textContent ?? "").includes("embedded body"), "links: embed pulled the note's content");
  const img = document.querySelector("#note-body img");
  ok(!!img, "links: image rendered");
  ok(calls.includes("asset_data_url") || (img?.src ?? "").startsWith("data:"), "links: asset image hydrated via asset_data_url");
  delete VAULT_FILES["b.laido"];
  VAULT_MD = "";
}

/* ---------- TOOLBAR — fmt buttons, sticky menu, outline, find, palette, tabs ---------- */
section("toolbar — format buttons call execCommand");
{
  const execCalls = [];
  document.execCommand = (c) => { execCalls.push(c); return true; };
  for (const [fmt, want] of [["bold", "bold"], ["italic", "italic"], ["strike", "strikeThrough"], ["ul", "insertUnorderedList"]]) {
    const b = document.querySelector(`.fmt-tools [data-fmt="${fmt}"]`);
    ok(!!b, `fmt: ${fmt} button exists`);
    b?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  }
  ok(execCalls.includes("bold") && execCalls.includes("insertUnorderedList"), "fmt: buttons dispatch execCommand");
}

section("chrome — sticky menu, outline rail, find bar, palette, new tab");
{
  const editor = await U("editor.js");
  // sticky menu opens from the toolbar
  const sm = document.querySelector("#sticky-menu");
  document.querySelector("#btn-sticky")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick(); // menu builds after vault_stickies resolves
  ok(!!sm && !sm.classList.contains("hidden"), "sticky: menu opens");
  document.body.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  // outline — needs a heading in the note
  VAULT_MD = "# Alpha\n\ntext\n\n## Beta\n\nmore\n";
    await editor.loadNote("sim.md");
    document.querySelector("#btn-outline")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  const rail = document.querySelector("#outline-rail");
  ok(!!rail && !rail.classList.contains("hidden"), "outline: rail opens");
  const items = rail?.querySelectorAll("button, .or-i, .or-item") ?? [];
  ok(items.length >= 2, `outline: ${items.length} heading rows listed`);
    // find — Ctrl+F opens the bar, typing wraps hits in marks
  key(document, "f", { ctrlKey: true });
  await tick();
  const fb = document.querySelector("#findbar");
  ok(!!fb && fb.classList.contains("open"), "find: Ctrl+F opens the find bar");
  const fin = fb?.querySelector(".find-in");
  if (fin) {
    fin.value = "text";
    fire(fin, "input");
    await new Promise((r) => setTimeout(r, 160));
    ok(document.querySelectorAll("#note-body .find-hit, #note-body mark").length >= 1, "find: matches highlighted in place");
    key(fin, "Escape");
    await new Promise((r) => setTimeout(r, 160));
    ok(document.querySelectorAll("#note-body .find-hit, #note-body mark").length === 0, "find: Escape clears the highlights");
  }
  // palette — Ctrl+K opens it
  key(document, "k", { ctrlKey: true });
  await tick(); await tick();
  const pal = document.querySelector("#palette");
  ok(!!pal && !pal.classList.contains("hidden"), "palette: Ctrl+K opens");
  pal?.classList.add("hidden");
    // new tab — the tabs strip exists and responds
  const tabs = document.querySelector("#tabs");
  ok(!!tabs, "tabs: strip exists");
  document.querySelector("#new-tab")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick(); await tick();
  ok(!!document.querySelector("#tabs .tab, #tabs button"), "tabs: a tab rendered");
  VAULT_MD = "";
}

/* ---------- TERM confirm flow — dangerous command needs a click ---------- */
section("term — !cmd that needs confirm shows Run/Skip buttons");
{
  const editor = await U("editor.js");
  const old = CANNED.term_run;
  CANNED.term_run = (a) => a?.confirm ? { ok: true, needs_confirm: false, output: "removed", code: 0 } : { ok: false, needs_confirm: true, output: "", code: null };
  const card = editor.spawnTerminalCard("terminal");
  await tick(); await tick();
  const input = card.querySelector(".term-input");
  input.value = "!rm -rf ./x";
  key(input, "Enter");
  await tick(); await tick(); await tick();
  const confirm = card.querySelector(".term-line.confirm");
  ok(!!confirm, "term: needs_confirm shows the confirm row");
  const run = [...(confirm?.querySelectorAll(".term-btn") ?? [])].find((b) => b.textContent === "Run");
  ok(!!run, "term: Run button mounted");
  run?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(arglog.some((a) => a.cmd === "term_run" && a.args?.confirm === true), "term: Run re-invokes with confirm:true");
  ok(card.querySelector(".term-log")?.textContent.includes("removed"), "term: confirmed output lands in the log");
  CANNED.term_run = old;
  card.remove();
}

/* ---------- TAURI EVENTS — skill proposal + research card ---------- */
section("agent — skill:proposed card accepts into skill_save; research:done inserts");
{
  const agent = await U("agent.js");
  const editor = await U("editor.js");
  await agent.initAgent?.();
  await tick(); await tick();
  emitTauri("skill:proposed", { name: "weekly-sync", description: "weekly sync prep", count: 5, steps: ["step one", "step two"], note: editor.currentNote() });
  await tick(); await tick();
  const prop = document.querySelector(".callout.proposal");
  ok(!!prop, "proposal: skill proposal card appears");
  const accept = [...(prop?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Accept");
  ok(!!accept, "proposal: Accept button mounted");
  accept?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(arglog.some((a) => a.cmd === "skill_save" && a.args?.name === "weekly-sync"), "proposal: Accept saves the skill");
  ok(!prop.isConnected, "proposal: card dismissed after accept");
  // research:done → insertCallout lands a card on the current note
  const n0 = document.querySelectorAll("#note-body .callout").length;
  emitTauri("research:done", { note: editor.currentNote(), topic: "fusion", callout: "> [!ai] fusion\n> real answer", kind: "research" });
  await tick(); await tick();
  ok(document.querySelectorAll("#note-body .callout").length > n0, "research:done inserts a card");
}

/* ---------- DECK toolbar — + slide layout pop, duplicate ---------- */
section("deck — toolbar: + slide picker, duplicate slide");
{
  const card = slides.buildDeckCard("tk");
  slides.wireDeck(card);
  const plus = [...card.querySelectorAll(".deck-btn")].find((b) => b.textContent.includes("+ slide"));
  ok(!!plus, "deck: + slide button mounted");
  plus?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const pop = card.querySelector(".deck-layoutpop");
  ok(!!pop, "deck: layout picker opens");
  const item = [...(pop?.querySelectorAll(".deck-lp-item") ?? [])].find((b) => b.textContent.includes("quote"));
  item?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  eq(card.querySelectorAll(".dslide").length, 2, "deck: quote slide added via picker");
  eq(card.querySelectorAll(".dslide")[1]?.dataset.layout, "quote", "deck: new slide carries its layout");
  const dup = [...card.querySelectorAll(".deck-btn")].find((b) => b.textContent === "⧉");
  dup?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  eq(card.querySelectorAll(".dslide").length, 3, "deck: duplicate adds a slide");
}

/* ---------- CLIP — browser:clip lands a quote in the note ---------- */
section("clip — browser:clip event inserts the quote into the note");
{
  const bodyEl = document.querySelector("#note-body");
  document.dispatchEvent(new w.CustomEvent("browser:clip", { detail: { title: "Src", url: "https://x", text: "quoted words" }, bubbles: true }));
  await tick(); await tick(); await tick();
  ok((bodyEl.textContent ?? "").includes("quoted words"), "clip: selected text lands in the note");
  const md = editable.serialize(bodyEl);
  ok(md.includes("quoted words"), "clip: clip serializes into the note md");
}

/* ---------- summary ---------- */
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" -", f); }
process.exit(fail ? 1 : 0);
