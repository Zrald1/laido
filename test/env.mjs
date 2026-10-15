/* Shared simulation environment — jsdom drives the real compiled ui/*.js
 * modules. Imported by sim.mjs-style scenario suites. Run after `npx tsc`. */

import { JSDOM } from "jsdom";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const U = (m) => import("file://" + path.join(root, "ui", m).replace(/\\/g, "/"));

/* ---------- DOM environment ---------- */
const indexHtml = readFileSync(path.join(root, "ui", "index.html"), "utf8");
const dom = new JSDOM(indexHtml, { pretendToBeVisual: true, url: "http://localhost/" });
export const w = dom.window;

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
export const spoken = [];
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
export const calls = [];
export const arglog = [];
const tauriHandlers = {};
export const emitTauri = (name, payload) => tauriHandlers[name]?.forEach((cb) => cb({ payload }));
export let VAULT_MD = "";
export const setVaultMd = (s) => { VAULT_MD = s; };
export const VAULT_FILES = {};
export const EMPTY_AI = { text: "hi", commands: [], laido: [], web: [], notes: [], send: [], assign: [], spawn: [], sheet: [], slides: [], todo: [], browser: [], chart: [], cards: [], maps: [], vault: [] };
export let TERM_AI = () => ({ ...EMPTY_AI });
export const setTermAi = (f) => { TERM_AI = f; };
export const CANNED = {
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
export let pass = 0, fail = 0;
export const failures = [];
export const ok = (cond, msg) => { if (cond) pass++; else { fail++; failures.push(msg); console.log(`  ✕ ${msg}`); } };
export const eq = (a, b, msg) => ok(a === b, `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
export const section = (s) => console.log(`\n== ${s}`);
export const tick = () => new Promise((r) => setTimeout(r, 0));
export const summary = () => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" -", f); }
  process.exit(fail ? 1 : 0);
};

export const fire = (el, type, init = {}) => {
  const Ctor = type.startsWith("pointer") ? w.PointerEvent : type.startsWith("key") ? w.KeyboardEvent : w.MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
};
export const click = (el) => { fire(el, "pointerdown"); fire(el, "mousedown"); fire(el, "mouseup"); fire(el, "click"); };
export const type = (el, text) => { el.textContent = text; fire(el, "input"); };
export const key = (el, k, init = {}) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
export const put = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; };

/* ---------- imports (after globals exist) ---------- */
export const sheet = await U("sheet.js");
export const slides = await U("slides.js");
export const canvas = await U("canvas.js");
export const todo = await U("todo.js");
export const browser = await U("browser.js");
export const chart = await U("chart.js");
export const cards = await U("cards.js");
export const map = await U("map.js");
export const agenda = await U("agenda.js");
export const graph = await U("graph.js");
export const base = await U("base.js");
export const editable = await U("editable.js");
export const render = await U("render.js");
export const term = await U("term.js");
export const editor = await U("editor.js");
export const agent = await U("agent.js");

export const { cardToMd, serialize } = editable;
export const { renderCalloutMd, renderMarkdown } = render;
export const navlog = [];
document.addEventListener("nav:open", (e) => navlog.push(e.detail));
export const exportlog = [];
document.addEventListener("base:export", (e) => exportlog.push(e.detail));

/* card markdown → fresh DOM card, rewired with the right widget driver */
const WIRES = [
  ["deck", (c) => slides.wireDeck(c)],
  ["sheet", (c) => sheet.wireSheet(c)],
  ["canvas", (c) => canvas.wireCanvas(c)],
  ["todo", (c) => todo.wireTodo(c)],
  ["browser", (c) => browser.wireBrowser(c)],
  ["chart", (c) => chart.wireChart(c)],
  ["cards", (c) => cards.wireCards(c)],
  ["map", (c) => map.wireMap(c)],
  ["agenda", (c) => agenda.wireAgenda(c)],
  ["graph", (c) => graph.wireGraph(c)],
  ["base", (c) => base.wireBase(c)],
];
export const rewire = async (card) => {
  const kind = card.dataset.kind ?? "";
  for (const [k, fn] of WIRES) if (kind.includes(k)) { fn(card); break; }
  return card;
};
/** card → md → render → rewire → new card (one full save/load cycle) */
export const roundTrip = async (card) => {
  const md = cardToMd(card);
  const html = renderCalloutMd(md);
  const el = put(html);
  el && (await rewire(el));
  return { md, el };
};
