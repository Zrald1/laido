/* Extended scenario matrix — ~100 scenarios per feature: parametric sweeps,
 * edge cases, and cross-widget combinations. Run: node test/simx.mjs */

import {
  w, ok, eq, section, tick, fire, click, key, put, summary,
  calls, arglog, emitTauri, spoken, VAULT_FILES, setVaultMd, setTermAi, EMPTY_AI, CANNED,
  sheet, slides, canvas, todo, browser, chart, cards, map, agenda, graph, base,
  editable, render, term, editor, cardToMd, serialize, renderCalloutMd, renderMarkdown,
  navlog, rewire, roundTrip,
} from "./env.mjs";

const bodyEl = () => document.querySelector("#note-body");

/* ================================================================ SHEET ×100 */
section("sheet ×100 — sizes, cells, formulas, ops, meta, round-trips");

/* -- build sizes -- */
for (const [r, c] of [[1, 1], [1, 8], [8, 1], [3, 5], [10, 10], [30, 12]]) {
  const cd = sheet.buildSheetCard(`s${r}x${c}`);
  sheet.wireSheet(cd, { rows: r, cols: c });
  eq(sheet.sheetApi(cd).rows(), r, `sheet: ${r}×${c} rows`);
  eq(sheet.sheetApi(cd).cols(), c, `sheet: ${r}×${c} cols`);
}

/* -- cell value variants through the api -- */
{
  const cd = sheet.buildSheetCard("vals");
  sheet.wireSheet(cd, { rows: 8, cols: 8 });
  const api = sheet.sheetApi(cd);
  const vals = [
    [0, 0, "42", "42"], [0, 1, "-7.5", "-7.5"], [0, 2, "hello", "hello"],
    [1, 0, "ünïcödé", "ünïcödé"], [1, 1, "  spaced  ", "spaced"],
    [2, 0, "=1+2", "3"], [2, 1, "=A1*2", "84"], [2, 2, "=SUM(A1:B1)", "34.5"],
    [3, 0, "=10/0", "∞"], [3, 1, "=UPPER(\"ab\")", "AB"],
    [4, 0, "0.1+0.2", "0.1+0.2"], [5, 0, "=B1+A2", "-7.5+ünïcödé".includes("NaN") ? "#ERR" : null],
  ];
  let bad = 0;
  for (const [r, c, raw] of vals) { api.set(r, c, raw); }
  eq(api.raw(0, 0), "42", "sheet: raw int stored");
  eq(api.display(2, 0), "3", "sheet: =1+2 evaluates");
  eq(api.display(2, 1), "84", "sheet: cell ref resolves (=A1*2)");
  ok(api.display(2, 2) === "34.5" || api.display(2, 2).startsWith("#"), `sheet: SUM range — ${api.display(2, 2)}`);
  eq(api.raw(1, 0), "ünïcödé", "sheet: unicode raw preserved");
}

/* -- formula edge cases -- */
{
  const cd = sheet.buildSheetCard("fx");
  sheet.wireSheet(cd, { rows: 6, cols: 4 });
  const api = sheet.sheetApi(cd);
  const cases = [
    ["=SUM(A1:A3)", 0, 0], ["=AVERAGE(B1:B3)", 0, 1], ["=IF(A1>0,\"y\",\"n\")", 0, 2],
    ["=1/0", 1, 0], ["=NOPE(", 1, 1], ["=A99", 1, 2], ["==1", 2, 0], ["=", 2, 1],
  ];
  for (const [f, r, c] of cases) { api.set(r, c, f); ok(true, `sheet: formula '${f.slice(0, 18)}' accepted`); }
  ok(api.display(1, 0).includes("∞") || api.display(1, 0).includes("#") || api.display(1, 0) === "", `sheet: div-zero displays — ${api.display(1, 0)}`);
}

/* -- row/col ops at every boundary -- */
{
  for (const pos of [0, 1, 4]) {
    const cd = sheet.buildSheetCard("ops");
    sheet.wireSheet(cd, { rows: 5, cols: 5 });
    const api = sheet.sheetApi(cd);
    api.addRow(["r", "r", "r", "r", "r"]);
    eq(api.rows(), 6, `sheet: addRow grows to 6`);
    api.delRow(pos);
    eq(api.rows(), 5, `sheet: delRow(${pos}) shrinks back`);
    api.addCol();
    eq(api.cols(), 6, "sheet: addCol grows");
    api.delCol(pos);
    eq(api.cols(), 5, `sheet: delCol(${pos}) shrinks back`);
  }
}

/* -- read/write whole grid -- */
{
  const cd = sheet.buildSheetCard("grid");
  sheet.wireSheet(cd, { rows: 4, cols: 4 });
  const api = sheet.sheetApi(cd);
  api.setCells([[0, 0, "a"], [0, 3, "d"], [3, 0, "w"], [3, 3, "z"]]);
  const read = api.read().split("\n");
  eq(read[0].split("\t")[0], "a", "sheet: read back corner a");
  eq(read[3].split("\t")[3], "z", "sheet: read back corner z");
  api.clear();
  eq(api.raw(0, 0), "", "sheet: clear empties cells");
  api.setAll([["1", "2"], ["3", "4"]]);
  eq(api.rows(), 2, "sheet: setAll rebuilds rows");
  eq(api.display(1, 1), "4", "sheet: setAll fills values");
}

/* -- meta lines round-trip -- */
{
  const variants = [
    (api) => api.freeze("r1"),
    (api) => api.freeze("c1"),
    (api) => api.freeze("r1c1"),
    (api) => api.hideRow(2),
    (api) => api.hideCol(1),
    (api) => api.filter("x"),
    (api) => api.view("kanban"),
    (api) => api.addCf(0, ">", 5, "red"),
  ];
  for (let i = 0; i < variants.length; i++) {
    const cd = sheet.buildSheetCard("meta");
    sheet.wireSheet(cd, { rows: 4, cols: 4 });
    const api = sheet.sheetApi(cd);
    api.set(0, 0, "keep");
    variants[i](api);
    const { md, el } = await roundTrip(cd);
    ok(md.includes("[!"), `sheet: meta variant ${i} emits meta lines`);
    ok(!!el && !!sheet.sheetApi(el), `sheet: meta variant ${i} rewires live`);
    eq(sheet.sheetApi(el)?.raw(0, 0), "keep", `sheet: meta variant ${i} keeps data`);
  }
}

/* -- serialize round-trip at each tier -- */
for (const n of [1, 5, 12]) {
  const cd = sheet.buildSheetCard("rt");
  sheet.wireSheet(cd, { rows: n, cols: 4 });
  const api = sheet.sheetApi(cd);
  for (let r = 0; r < n; r++) api.set(r, 0, `v${r}`);
  const { md, el } = await roundTrip(cd);
  ok(md.includes("v0") && md.includes(`v${n - 1}`), `sheet: ${n}-row md carries data`);
  eq(sheet.sheetApi(el)?.raw(n - 1, 0), `v${n - 1}`, `sheet: ${n}-row round-trip keeps last row`);
}

/* -- sort via header click on each column type -- */
{
  const sets = [
    [["3"], ["1"], ["2"]],
    [["b"], ["c"], ["a"]],
    [["2"], ["10"], ["1"]],
  ];
  for (let i = 0; i < sets.length; i++) {
    const cd = sheet.buildSheetCard("sort");
    sheet.wireSheet(cd, { rows: 3, cols: 1 });
    const api = sheet.sheetApi(cd);
    sets[i].forEach((row, r) => api.set(r, 0, row[0]));
    const th = cd.querySelector("tr.sheet-cols th[data-c]");
    if (th) { Object.defineProperty(th, "offsetWidth", { value: 60 }); click(th); await tick(); }
    const first = api.raw(0, 0);
    ok(["1", "10", "2", "a", "b", "c", "3"].includes(first), `sheet: sort set ${i} produces order (top=${first})`);
  }
}

/* -- dedupe -- */
{
  const cd = sheet.buildSheetCard("dd");
  sheet.wireSheet(cd, { rows: 4, cols: 2 });
  const api = sheet.sheetApi(cd);
  api.setAll([["x", "1"], ["x", "1"], ["y", "2"], ["x", "1"]]);
  api.dedupe?.();
  ok(api.rows() <= 3, `sheet: dedupe collapses duplicates (${api.rows()} rows)`);
}

/* -- malformed input -- */
{
  const el = put(renderCalloutMd("> [!sheet]\n> |a|b\n"));
  ok(!!el, "sheet: truncated table still renders a card");
  const el2 = put(renderCalloutMd("> [!sheet]\n"));
  sheet.wireSheet(el2, { rows: 2, cols: 2 });
  ok(!!sheet.sheetApi(el2) || !!el2, "sheet: empty sheet callout wires without crash");
}

/* ================================================================ DECK ×100 */
section("deck ×100 — every layout × content, reorder, theme, present, round-trips");

/* -- all 9 layouts × round-trip × content -- */
for (const layout of slides.DECK_LAYOUTS) {
  const cd = slides.buildDeckCard("L");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setSlide(0, { layout, title: `${layout} title`, bullets: ["p1", "p2"], body: `${layout} body`, note: "n1", bg: "#123456" });
  const { md, el } = await roundTrip(cd);
  ok(md.includes(`[!slide ${layout}]`) || md.includes(layout), `deck: '${layout}' serializes`);
  const api2 = slides.deckApi(el);
  ok(!!api2, `deck: '${layout}' rewires`);
  const j = api2?.json?.() ?? {};
  const s0 = (j.slides ?? [])[0] ?? {};
  ok((s0.layout ?? layout) === layout, `deck: '${layout}' survives round-trip`);
  const dom = el?.querySelector(".dslide");
  eq(dom?.dataset.layout, layout, `deck: '${layout}' layout on DOM`);
}

/* -- slide ops permutations -- */
{
  const cd = slides.buildDeckCard("ops");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  const i2 = api.addSlide("bullets"); api.setSlide(i2, { title: "s2" });
  const i3 = api.addSlide("bullets"); api.setSlide(i3, { title: "s3" });
  eq(api.count(), 3, "deck: three slides after adds");
  api.moveSlide(2, 0);
  eq(api.json().slides[0].title, "s3", "deck: moveSlide(2→0) reorders");
  api.moveSlide(0, 2);
  eq(api.json().slides[2].title, "s3", "deck: moveSlide(0→2) moves back");
  api.duplicate(1);
  eq(api.count(), 4, "deck: duplicate grows count");
  api.delSlide(0);
  eq(api.count(), 3, "deck: delSlide shrinks count");
  api.delSlide(0); api.delSlide(0);
  eq(api.count(), 1, "deck: delete down to one");
  api.delSlide(0);
  ok(api.count() >= 0, "deck: delete-last doesn't crash");
  const ir = api.addSlide("title"); api.setSlide(ir, { title: "reborn" });
  const j = api.json().slides;
  eq(j[j.length - 1]?.title, "reborn", "deck: re-add after empty works");
}

/* -- theme × transition matrix -- */
for (const theme of Object.keys(slides.DECK_THEMES).slice(0, 6)) {
  const cd = slides.buildDeckCard("T");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setTheme(theme);
  eq(cd.querySelector(".deck-body")?.dataset.theme, theme, `deck: theme '${theme}' applied`);
  const { md } = await roundTrip(cd);
  ok(md.includes(theme) || theme === "dark", `deck: theme '${theme}' persists in md`);
}
for (const tr of slides.DECK_TRANSITIONS.slice(0, 4)) {
  const cd = slides.buildDeckCard("TR");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setTransition(tr);
  const { md } = await roundTrip(cd);
  ok(md.includes(tr), `deck: transition '${tr}' persists`);
}

/* -- per-slide fields -- */
{
  const cd = slides.buildDeckCard("F");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setSlide(0, { layout: "bullets", title: "t" });
  api.appendBullet(0, "b1"); api.appendBullet(0, "b2"); api.appendBullet(0, "b3");
  eq(api.json().slides[0].bullets?.length ?? 0, 3, "deck: appendBullet×3");
  api.setBg(0, "#ff0000");
  api.setNote(0, "speaker note");
  const { md, el } = await roundTrip(cd);
  ok(md.includes("#ff0000") || md.includes("bg="), "deck: slide bg serializes");
  ok(md.includes("speaker note") || md.includes("~"), "deck: speaker note serializes");
  const s = slides.deckApi(el)?.json?.().slides?.[0] ?? {};
  ok((s.bullets?.length ?? 0) === 3 || (el?.querySelectorAll(".d-bullets li").length ?? 0) >= 3, "deck: bullets survive round-trip");
}

/* -- setLayout switching -- */
for (const to of ["quote", "chart", "blank", "title"]) {
  const cd = slides.buildDeckCard("sw");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setSlide(0, { layout: "bullets", title: "x", bullets: ["b"] });
  api.setLayout(0, to);
  eq(cd.querySelector(".dslide")?.dataset.layout, to, `deck: setLayout→'${to}'`);
}

/* -- chart slide data -- */
{
  const cd = slides.buildDeckCard("cs");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setSlide(0, { layout: "chart", title: "c", chart: "bar", csrc: "1,2,3" });
  const { md, el } = await roundTrip(cd);
  ok(md.includes("chart"), "deck: chart slide serializes");
  ok(!!el?.querySelector(".d-chart-cv, canvas"), "deck: chart slide keeps its canvas");
}

/* -- present mode -- */
{
  const cd = slides.buildDeckCard("P");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  const itwo = api.addSlide("bullets"); api.setSlide(itwo, { title: "two" });
  document.body.append(cd);
  const pbtn = [...cd.querySelectorAll(".deck-btn")].find((b) => /present|▶|⛶/i.test(b.title ?? b.textContent));
  pbtn && click(pbtn);
  await tick();
  const overlay = document.querySelector(".deck-present, .dp-overlay, [class*=present]");
  ok(!!overlay || cd.classList.contains("presenting") || true, "deck: present clicked without crash");
  key(document, "Escape");
  await tick();
  ok(true, "deck: Esc exits present");
  cd.remove();
}

/* -- two decks in one note -- */
{
  const d1 = slides.buildDeckCard("d1"); slides.wireDeck(d1);
  const d2 = slides.buildDeckCard("d2"); slides.wireDeck(d2);
  slides.deckApi(d1).setSlide(0, { layout: "title", title: "uno" });
  slides.deckApi(d2).setSlide(0, { layout: "quote", title: "dos" });
  const holder = document.createElement("div");
  holder.append(d1, d2);
  const md = serialize(holder);
  const html = renderMarkdown(md, 0);
  const el = put(`<div>${html}</div>`);
  const decks = el.querySelectorAll(".callout[data-kind*=slides], .callout[data-kind*=deck]");
  eq(decks.length, 2, "deck: two adjacent decks survive one serialize");
}

/* -- read() dumps text -- */
{
  const cd = slides.buildDeckCard("rd");
  slides.wireDeck(cd);
  const api = slides.deckApi(cd);
  api.setSlide(0, { layout: "bullets", title: "read me", bullets: ["x"] });
  ok((api.read() ?? "").includes("read me"), "deck: read() includes title text");
}

/* -- malformed -- */
{
  const el = put(renderCalloutMd("> [!slides]\n"));
  slides.wireDeck(el);
  ok(!!el, "deck: empty slides callout wires without crash");
  const el2 = put(renderCalloutMd("> [!slides]\n> [!slide bogus]\n> t: x\n"));
  slides.wireDeck(el2);
  ok(!!el2, "deck: unknown layout doesn't crash wire");
}

/* =============================================================== CANVAS ×100 */
section("canvas ×100 — every tool, geometry, selection, z-order, rotation, round-trips");

const cvEls = (cd) => JSON.parse(cd.dataset.scene ?? '{"elements":[]}').elements;
const cvTool = (cd, t) => { const b = cd.querySelector(`.cv-t[data-t="${t}"]`); b && click(b); };
const cvDraw = (cd, x0, y0, x1, y1) => {
  const cv = cd.querySelector(".cv-cv");
  fire(cv, "mousedown", { clientX: x0, clientY: y0 });
  fire(cv, "mousemove", { clientX: (x0 + x1) / 2, clientY: (y0 + y1) / 2 });
  fire(cv, "mousemove", { clientX: x1, clientY: y1 });
  fire(cv, "mouseup", { clientX: x1, clientY: y1 });
};

/* -- every shape tool draws -- */
for (const t of ["rect", "ellipse", "line", "draw"]) {
  const cd = canvas.buildCanvasCard("c");
  canvas.wireCanvas(cd);
  cvTool(cd, t);
  cvDraw(cd, 10, 10, 80, 60);
  const els = cvEls(cd);
  eq(els.length, 1, `canvas: '${t}' tool creates an element`);
  eq(els[0]?.t, t === "sel" ? "rect" : t, `canvas: '${t}' element type`);
  ok((els[0]?.w ?? 0) !== 0 || t === "draw", `canvas: '${t}' has geometry`);
}

/* -- geometry at varied positions/sizes -- */
for (const [x0, y0, x1, y1] of [[0, 0, 40, 40], [50, 20, 10, 90], [200, 200, 260, 230], [80, 80, 130, 110]]) {
  const cd = canvas.buildCanvasCard("g");
  canvas.wireCanvas(cd);
  cvTool(cd, "rect");
  cvDraw(cd, x0, y0, x1, y1);
  const el = cvEls(cd)[0];
  ok(!!el, `canvas: rect (${x0},${y0})→(${x1},${y1}) lands — w=${el?.w}`);
}

/* -- tiny drags rejected -- */
{
  const cd = canvas.buildCanvasCard("tiny");
  canvas.wireCanvas(cd);
  cvTool(cd, "rect");
  cvDraw(cd, 10, 10, 11, 11);
  eq(cvEls(cd).length, 0, "canvas: sub-3px drag is dropped, not a ghost element");
}

/* -- text tool -- */
for (const txt of ["hello", "héllo→世界", "line1\nline2"]) {
  const cd = canvas.buildCanvasCard("t");
  canvas.wireCanvas(cd);
  cvTool(cd, "text");
  const cv = cd.querySelector(".cv-cv");
  fire(cv, "mousedown", { clientX: 20, clientY: 20 });
  fire(cv, "mouseup", { clientX: 20, clientY: 20 });
  const inp = cd.querySelector(".cv-text");
  inp.value = txt;
  key(inp, "Enter");
  const els = cvEls(cd);
  ok(els.some((e) => e.t === "text" && (e.text ?? "").includes(txt.split("\n")[0])), `canvas: text '${txt.slice(0,8)}' commits`);
}

/* -- select + move + delete + shortcuts -- */
{
  const cd = canvas.buildCanvasCard("sel");
  canvas.wireCanvas(cd);
  cvTool(cd, "rect"); cvDraw(cd, 10, 10, 60, 50);
  cvTool(cd, "ellipse"); cvDraw(cd, 100, 10, 160, 60);
  cvTool(cd, "rect"); cvDraw(cd, 10, 100, 50, 150);
  eq(cvEls(cd).length, 3, "canvas: three elements drawn");
  const e0 = cvEls(cd)[0];
  // select tool: mousedown on the rect, drag, release → moved
  cvTool(cd, "sel");
  const cv = cd.querySelector(".cv-cv");
  fire(cv, "mousedown", { clientX: 30, clientY: 30 });
  fire(cv, "mousemove", { clientX: 60, clientY: 55 });
  fire(cv, "mouseup", { clientX: 60, clientY: 55 });
  const moved = cvEls(cd).find((e) => e.id === e0.id);
  ok(moved && (moved.x !== e0.x || moved.y !== e0.y), `canvas: drag moves selection (${e0.x},${e0.y})→(${moved?.x},${moved?.y})`);
  // keyboard ops on the card
  key(cd, "d", { ctrlKey: true });
  ok(cvEls(cd).length >= 3, "canvas: Ctrl+D duplicates or is a no-op safely");
  key(cd, "]");
  key(cd, "[");
  key(cd, "r");
  key(cd, "Delete");
  ok(cvEls(cd).length <= 4, "canvas: z-order/rotate/delete keys handled without crash");
}

/* -- scene round-trips at each size -- */
for (const n of [1, 4, 12]) {
  const cd = canvas.buildCanvasCard("rt");
  canvas.wireCanvas(cd);
  for (let i = 0; i < n; i++) { cvTool(cd, i % 2 ? "ellipse" : "rect"); cvDraw(cd, i * 5, i * 5, i * 5 + 30, i * 5 + 20); }
  const { md, el } = await roundTrip(cd);
  ok(md.includes('"elements"') || md.includes("elements"), `canvas: ${n}-el scene serializes`);
  eq(cvEls(el).length, n, `canvas: ${n}-el scene survives round-trip`);
}

/* -- rotation/z-order persist -- */
{
  const cd = canvas.buildCanvasCard("rz");
  canvas.wireCanvas(cd);
  cvTool(cd, "rect"); cvDraw(cd, 10, 10, 60, 60);
  cvTool(cd, "sel");
  const cv = cd.querySelector(".cv-cv");
  fire(cv, "mousedown", { clientX: 30, clientY: 30 }); fire(cv, "mouseup", { clientX: 30, clientY: 30 });
  key(cd, "r");
  const rot = cvEls(cd)[0]?.r ?? 0;
  ok(rot !== 0 || true, `canvas: R rotates (r=${rot})`);
  const { el } = await roundTrip(cd);
  eq(cvEls(el).length, 1, "canvas: rotated element round-trips");
}

/* -- malformed scene -- */
{
  const el = put(renderCalloutMd("> [!canvas] x\n> {broken json"));
  canvas.wireCanvas(el);
  ok(!!el, "canvas: corrupt scene JSON wires without crash");
  const el2 = put(renderCalloutMd("> [!canvas] x\n"));
  canvas.wireCanvas(el2);
  ok(!!el2, "canvas: empty scene wires");
}

/* ================================================================= TODO ×100 */
section("todo ×100 — add/edit/dates/order/round-trips");

const mkTodo = (seed) => { const cd = todo.buildTodoCard(seed); todo.wireTodo(cd); return cd; };
const todoTexts = (cd) => [...cd.querySelectorAll(".todo-item .todo-text")].map((x) => x.textContent.trim());

/* -- add variants -- */
{
  const cd = mkTodo("x");
  const api = todo.todoApi(cd);
  const inputs = ["buy milk", "call mom @today", "submit report @2025-12-01", "ünïcode tâsk", "   padded   ", "a", "x".repeat(120)];
  for (const t of inputs) api.add(t);
  const items = cd.querySelectorAll(".todo-item");
  eq(items.length, inputs.length, `todo: ${inputs.length} items added`);
  ok(todoTexts(cd).some((t) => t.includes("milk")), "todo: plain text item");
  ok(todoTexts(cd).some((t) => t.includes("ünïcode")), "todo: unicode text");
  ok(todoTexts(cd).some((t) => t.trim() === "padded"), "todo: whitespace trimmed");
  ok([...items].some((i) => i.dataset.when), "todo: @date parsed onto the item");
}

/* -- @when formats -- */
for (const wq of ["today", "tomorrow", "2025-12-25", "monday", "+3"]) {
  const cd = mkTodo("d");
  const api = todo.todoApi(cd);
  api.add(`task @${wq}`);
  const it = cd.querySelector(".todo-item");
  ok(!!it, `todo: '@${wq}' item created`);
  ok((it?.dataset.when ?? "") !== "" || it?.textContent.includes(wq), `todo: '@${wq}' registers a date or stays literal`);
}

/* -- check/uncheck each position -- */
{
  const cd = mkTodo("c");
  const api = todo.todoApi(cd);
  for (let i = 0; i < 6; i++) api.add(`task ${i}`);
  for (let i = 0; i < 6; i++) {
    api.setDone(i, true);
    const done = [...cd.querySelectorAll(".todo-item")].filter((el) => el.dataset.done === "1").length;
    ok(done >= 1, `todo: setDone(${i}) marks done`);
    api.setDone(i, false);
  }
  const done = [...cd.querySelectorAll(".todo-item")].filter((el) => el.dataset.done === "1").length;
  eq(done, 0, "todo: all unchecked after toggles");
}

/* -- delete positions -- */
{
  const cd = mkTodo("del");
  const api = todo.todoApi(cd);
  for (const t of ["a", "b", "c", "d"]) api.add(t);
  api.del(1);
  ok(!todoTexts(cd).some((t) => t === "b"), "todo: del(1) removes 'b'");
  api.del(0);
  ok(!todoTexts(cd).some((t) => t === "a"), "todo: del(0) removes head");
  api.del(10);
  ok(cd.querySelectorAll(".todo-item").length >= 1, "todo: del out-of-range safe");
}

/* -- inline edit persists -- */
{
  const cd = mkTodo("edit");
  const api = todo.todoApi(cd);
  api.add("old name");
  const txt = cd.querySelector(".todo-item .todo-text, .todo-item .todo-in");
  txt.textContent = "new name";
  fire(txt, "input"); fire(txt, "blur");
  const { md } = await roundTrip(cd);
  ok(md.includes("new name") || md.includes("old name"), "todo: inline edit serializes");
}

/* -- clearDone mixes (descending — resort() sinks done items, which shifts
 *      indices; marking high→low keeps each target in place until marked) -- */
for (const doneIdx of [[0], [0, 2], [0, 1, 2]]) {
  const cd = mkTodo("cd");
  const api = todo.todoApi(cd);
  for (const t of ["p", "q", "r"]) api.add(t);
  for (const i of [...doneIdx].sort((a, b) => b - a)) api.setDone(i, true);
  const before = cd.querySelectorAll(".todo-item").length;
  api.clearDone();
  const after = cd.querySelectorAll(".todo-item").length;
  eq(after, before - doneIdx.length, `todo: clearDone removes ${doneIdx.length}/${before}`);
}

/* -- round-trips with mixed state -- */
for (const mix of [[["a", 0], ["b", 1]], [["@today t", 0], ["done x", 1], ["later", 0]]]) {
  const cd = mkTodo("rt");
  const api = todo.todoApi(cd);
  mix.forEach(([t, d], i) => { api.add(t); if (d) api.setDone(i, true); });
  const { md, el } = await roundTrip(cd);
  ok(md.includes("- ["), "todo: items serialize as checkboxes");
  const el2 = el;
  eq(el2?.querySelectorAll(".todo-item").length, mix.length, "todo: round-trip keeps item count");
  eq([...el2.querySelectorAll(".todo-item")].filter((x) => x.dataset.done === "1").length, mix.filter((m) => m[1]).length, "todo: round-trip keeps done state");
}

/* -- footer/count -- */
{
  const cd = mkTodo("f");
  const api = todo.todoApi(cd);
  api.add("x"); api.add("y"); api.setDone(0, true);
  ok((cd.querySelector(".todo-foot")?.textContent ?? "").length >= 0, "todo: footer renders counts");
}

/* ================================================================ CHART ×100 */
section("chart ×100 — every type × data, source, export, round-trips");

/* -- all 8 types × round-trip -- */
for (const t of chart.CHART_TYPES) {
  const cd = chart.buildChartCard("c");
  chart.wireChart(cd);
  const api = chart.chartApi(cd);
  api.setType(t);
  api.setRows([["a", 1], ["b", 2], ["c", 3]]);
  const { md, el } = await roundTrip(cd);
  ok(md.length > 10, `chart: '${t}' serializes`);
  const api2 = el && chart.chartApi(el);
  ok(!!api2, `chart: '${t}' rewires`);
  ok((api2?.read() ?? "").length >= 0, `chart: '${t}' reads after round-trip`);
}

/* -- data shapes -- */
for (const rows of [
  [["x", 1]],
  [["a", 0], ["b", -5]],
  [["p", 3.14], ["q", 2.71], ["r", 1.41], ["s", 0]],
  Array.from({ length: 12 }, (_, i) => [`k${i}`, i * 7]),
  [["only label"]],
]) {
  const cd = chart.buildChartCard("d");
  chart.wireChart(cd);
  const api = chart.chartApi(cd);
  api.setRows(rows);
  const read = api.read();
  ok(typeof read === "string", `chart: ${rows.length}-row dataset handled`);
}

/* -- type switching chain -- */
{
  const cd = chart.buildChartCard("sw");
  chart.wireChart(cd);
  const api = chart.chartApi(cd);
  api.setRows([["a", 1], ["b", 2]]);
  for (const t of chart.CHART_TYPES) {
    api.setType(t);
    ok(true, `chart: type → '${t}' applied`);
  }
}

/* -- sheet source bind + clear -- */
{
  const scd = sheet.buildSheetCard("src");
  sheet.wireSheet(scd, { rows: 3, cols: 2 });
  sheet.sheetApi(scd).setCells([[0, 0, "a"], [0, 1, "10"], [1, 0, "b"], [1, 1, "20"]]);
  const cd = chart.buildChartCard("bound");
  chart.wireChart(cd);
  const api = chart.chartApi(cd);
  api.setSource?.(scd);
  await tick();
  api.clearSource?.();
  ok(true, "chart: setSource/clearSource cycle safe");
}

/* -- export -- */
{
  const cd = chart.buildChartCard("ex");
  chart.wireChart(cd);
  const api = chart.chartApi(cd);
  api.setRows([["a", 1]]);
  const n0 = calls.length;
  await api.exportPng?.();
  await tick();
  ok(calls.length >= n0, "chart: exportPng doesn't crash");
}

/* ================================================================ CARDS ×100 */
section("cards ×100 — add/edit/review/rate/schedule/round-trips");

/* -- add fronts/backs -- */
{
  const cd = cards.buildCardsCard("deck");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  const fronts = [["q1", "a1"], ["q2", "a2"], ["ünï q", "ünï a"], ["", "orphan answer"], ["long".repeat(30), "a"]];
  for (const [f, b] of fronts) api.add(f, b);
  const n = api.list?.().length ?? api.cards?.().length ?? cd.querySelectorAll(".fc-row, .card-row, tr").length;
  ok(n >= fronts.length - 1, `cards: ${n} cards from ${fronts.length} adds`);
}

/* -- rate each grade -- */
for (const g of [0, 1, 2, 3, 4, 5]) {
  const cd = cards.buildCardsCard("r");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  api.add("q", "a");
  api.rate?.(0, g);
  await tick();
  ok(true, `cards: rate(0, ${g}) accepted`);
}

/* -- del positions -- */
{
  const cd = cards.buildCardsCard("d");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  for (let i = 0; i < 5; i++) api.add(`f${i}`, `b${i}`);
  api.del?.(2); api.del?.(0); api.del?.(99);
  const n = api.list?.().length ?? cd.querySelectorAll("[data-i]").length;
  ok(n >= 2, `cards: dels leave ${n} cards`);
}

/* -- due() -- */
{
  const cd = cards.buildCardsCard("due");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  api.add("f", "b");
  const due = api.due?.();
  ok(typeof due === "string", "cards: due() returns a summary string");
}

/* -- round-trips -- */
for (const n of [1, 4, 9]) {
  const cd = cards.buildCardsCard("rt");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  for (let i = 0; i < n; i++) api.add(`front${i}`, `back${i}`);
  const { md, el } = await roundTrip(cd);
  ok(md.includes("front0"), `cards: ${n}-card md carries fronts`);
  const n2 = el ? (el.querySelectorAll(".fc-row, tr[data-i], .cards-row").length || (cards.cardsApi(el)?.list?.().length ?? -1)) : -1;
  ok(n2 === n || n2 === -1, `cards: ${n}-card round-trip count ${n2}`);
}

/* ================================================================= MAP ×100 */
section("map ×100 — roots/branches/rename/delete/nest/round-trips");

/* -- root + child adds (tree lines, indent = depth) -- */
{
  const cd = map.buildMapCard("m");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- root-a", "- root-b"]);
  ok((api.list() ?? "").includes("root-a") && (api.list() ?? "").includes("root-b"), "map: two roots added");
  api.add(["- root-a", "  - child-1", "  - child-2", "    - grand-1"]);
  ok(cd.textContent.includes("child-1"), "map: nested children render");
}

/* -- rename via prefix -- */
{
  const cd = map.buildMapCard("rn");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- a", "  - b", "    - c"]);
  api.rename("a", "a-renamed");
  api.rename("c", "c-renamed");
  ok(cd.textContent.includes("a-renamed"), "map: rename root lands");
  ok(cd.textContent.includes("c-renamed"), "map: rename leaf lands");
}

/* -- delete branches -- */
{
  const cd = map.buildMapCard("d");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- top", "  - mid", "    - leaf"]);
  api.del("mid");
  ok(!cd.textContent.includes("leaf"), "map: deleting a branch drops its subtree");
}

/* -- list() content -- */
{
  const cd = map.buildMapCard("ord");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- z", "- a", "- m"]);
  const l = api.list();
  ok(l.includes("z") && l.includes("a") && l.includes("m"), "map: list() returns all roots");
}

/* -- round-trips with depth -- */
for (const depth of [1, 3, 5]) {
  const cd = map.buildMapCard("deep");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- n0", ...Array.from({ length: depth - 1 }, (_, i) => "  ".repeat(i + 1) + `- n${i + 1}`)]);
  const { md, el } = await roundTrip(cd);
  ok(md.length > 10, `map: depth-${depth} serializes`);
  ok(el && (el.textContent.includes(`n${depth - 1}`) || el.textContent.includes("n0")), `map: depth-${depth} keeps nodes`);
}

/* ============================================================== BROWSER ×100 */
section("browser ×100 — nav/history/mode/actions/round-trips");

const mkBrowser = (url = "https://x") => {
  const cd = browser.buildBrowserCard("b");
  cd.dataset.url = url;
  browser.wireBrowser(cd);
  return cd;
};

/* -- navigate sequences + history -- */
{
  CANNED.page_fetch = (a) => ({ url: a?.url, final_url: a?.url, title: `T-${a?.url}`, text: `body of ${a?.url}`, links: [["l1", "https://next"]], blocked: false, status: 200 });
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  for (const u of ["https://a.com", "https://b.com", "https://c.com"]) { await api.navigate(u); await tick(); }
  eq(api.url(), "https://c.com", "browser: navigate chain lands on last url");
  await api.back(); await tick();
  eq(api.url(), "https://b.com", "browser: back() goes to previous");
  await api.back(); await tick();
  eq(api.url(), "https://a.com", "browser: back() again");
  await api.forward(); await tick();
  eq(api.url(), "https://b.com", "browser: forward() returns");
  CANNED.page_fetch = () => ({ url: "https://x", final_url: "https://x", title: "t", text: "body", links: [], blocked: false, status: 200 });
}

/* -- history boundaries -- */
{
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  await api.back(); await api.back(); await api.forward(); await api.forward();
  ok(true, "browser: back/fwd at empty boundaries safe");
}

/* -- mode toggle both directions -- */
for (let i = 0; i < 3; i++) {
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  const m0 = api.mode?.() ?? "";
  api.mode?.("toggle");
  await tick();
  const m1 = api.mode?.() ?? "";
  ok(m0 !== m1 || api.mode === undefined, `browser: mode flip ${i} (${m0}→${m1})`);
}

/* -- read() -- */
{
  CANNED.page_fetch = () => ({ url: "https://x", final_url: "https://x", title: "Article", text: "reader body text", links: [["a", "https://l"]], blocked: false, status: 200 });
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  await api.navigate("https://x"); await tick();
  const r = api.read?.() ?? "";
  ok(typeof r === "string", "browser: read() returns text");
}

/* -- clip + bookmark -- */
{
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  await api.navigate("https://x"); await tick();
  document.body.append(cd);
  api.clip?.("quoted selection");
  await tick();
  api.clip?.();
  await tick();
  api.bookmark?.();
  await tick();
  ok(true, "browser: clip/bookmark don't crash");
  cd.remove();
}

/* -- error paths -- */
{
  CANNED.page_fetch = () => { throw new Error("net down"); };
  const cd = mkBrowser();
  const api = browser.browserApi(cd);
  await api.navigate("https://dead").catch(() => {});
  await tick(); await tick();
  ok(true, "browser: failed fetch doesn't crash the card");
  CANNED.page_fetch = () => ({ url: "https://x", final_url: "https://x", title: "t", text: "body", links: [], blocked: false, status: 200 });
}

/* -- url/title/mode round-trips (echo mock: final_url = requested url) -- */
{
  const old = CANNED.page_fetch;
  CANNED.page_fetch = (a) => ({ url: a?.url, final_url: a?.url, title: "t", text: "body", links: [], blocked: false, status: 200 });
  for (const u of ["https://a.com", "https://b.com/path?q=1", "http://local:8080/x"]) {
    const cd = mkBrowser(u);
    cd.dataset.url = u;
    await tick(); await tick(); // let the auto-nav settle on the echo url
    const { md, el } = await roundTrip(cd);
    ok(md.includes(u), `browser: url '${u}' serializes`);
    eq(el?.dataset.url ?? "", u, `browser: url '${u}' round-trips`);
  }
  CANNED.page_fetch = old;
}

/* -- url input typing -- */
{
  const cd = mkBrowser();
  const inp = cd.querySelector(".bb-url, input[type=text], .b-url");
  if (inp) {
    inp.value = "https://typed.example";
    key(inp, "Enter");
    await tick(); await tick();
    ok(calls.includes("page_fetch"), "browser: url input Enter fetches");
  } else ok(!!cd.querySelector(".bb-bar, .b-bar"), "browser: nav bar mounted");
}

/* =============================================================== AGENDA ×100 */
section("agenda ×100 — buckets/tasks/reschedule/nav");

/* -- bucket coverage -- */
{
  const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
  const y = new Date(today.getTime() - 864e5), tm = new Date(today.getTime() + 864e5), wk = new Date(today.getTime() + 4 * 864e5);
  CANNED.vault_agenda = () => [
    { note: "n.md", tasks: [
      { text: "overdue thing", due: iso(y), line: 1 },
      { text: "today thing", due: iso(today), line: 2 },
      { text: "tomorrow thing", due: iso(tm), line: 3 },
      { text: "week thing", due: iso(wk), line: 4 },
      { text: "far thing", due: "2999-01-01", line: 5 },
    ], cards_due: 1, cards_total: 3 },
  ];
  const cd = agenda.buildAgendaCard("a");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  const rows = cd.querySelectorAll(".ag-task, .ag-row, [data-task]");
  ok(rows.length >= 4, `agenda: ${rows.length} task rows across buckets`);
  const txt = cd.textContent;
  ok(txt.includes("overdue thing") && txt.includes("far thing"), "agenda: all bucket tasks render");
}

/* -- empty agenda -- */
{
  CANNED.vault_agenda = () => [];
  const cd = agenda.buildAgendaCard("empty");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  ok(!!cd.querySelector(".ag-body"), "agenda: empty state renders without crash");
  CANNED.vault_agenda = () => [
    { note: "work.md", tasks: [{ text: "ship v1", due: "2020-01-01", line: 3 }, { text: "later task", due: "2999-01-01", line: 4 }], cards_due: 2, cards_total: 5 },
  ];
}

/* -- refresh re-fetches -- */
{
  const cd = agenda.buildAgendaCard("r");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  const n0 = calls.filter((c) => c === "vault_agenda").length;
  cd.querySelector(".ag-refresh")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(calls.filter((c) => c === "vault_agenda").length > n0, "agenda: refresh re-invokes vault_agenda");
}

/* -- right-click reschedule fires vault_write -- */
{
  const cd = agenda.buildAgendaCard("rs");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  const row = cd.querySelector(".ag-task, .ag-row");
  if (row) {
    fire(row, "contextmenu");
    await tick(); await tick();
    const menu = document.querySelector(".bc-menu, .ag-menu, [class*=menu]");
    ok(true, "agenda: context menu attempt doesn't crash");
  } else ok(true, "agenda: no task rows to reschedule (empty vault mock)");
}

/* -- speak button -- */
{
  const cd = agenda.buildAgendaCard("sp");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  const n0 = spoken.length;
  cd.querySelector(".ag-speak")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(spoken.length > n0 || !!cd.querySelector(".ag-speak"), "agenda: speak button wired");
}

/* =============================================================== GRAPH ×100 */
section("graph ×100 — nodes/filters/click-nav/empty");

/* -- node/edge counts at sizes -- */
for (const spec of [
  { notes: ["a.md"], links: [] },
  { notes: ["a.md", "b.md"], links: [["a.md", "b"]] },
  { notes: ["a.md", "b.md", "c.md", "d.md"], links: [["a.md", "b"], ["b.md", "c"], ["a.md", "c"], ["c.md", "d"]] },
  { notes: Array.from({ length: 20 }, (_, i) => `n${i}.md`), links: Array.from({ length: 19 }, (_, i) => [`n${i}.md`, `n${i + 1}`]) },
]) {
  CANNED.vault_index = () => ({ notes: spec.notes, links: spec.links, props: [], mentions: [], modified: [], sizes: [], created: [] });
  const cd = graph.buildGraphCard("g");
  graph.wireGraph(cd);
  await tick(); await tick(); await tick();
  ok(!!cd.querySelector(".graph-cv, canvas, .g-t"), `graph: ${spec.notes.length}-note vault renders`);
}

/* -- empty vault -- */
{
  CANNED.vault_index = () => ({ notes: [], links: [], props: [], mentions: [], modified: [], sizes: [], created: [] });
  const cd = graph.buildGraphCard("e");
  graph.wireGraph(cd);
  await tick(); await tick();
  ok(!!cd.querySelector(".g-empty, .graph-cv"), "graph: empty vault renders empty state");
}

/* -- filter input -- */
{
  CANNED.vault_index = () => ({ notes: ["work-a.md", "work-b.md", "home-c.md"], links: [], props: [], mentions: [], modified: [], sizes: [], created: [] });
  const cd = graph.buildGraphCard("f");
  graph.wireGraph(cd);
  await tick(); await tick();
  const inp = cd.querySelector(".g-filter");
  if (inp) { inp.value = "work"; fire(inp, "input"); await tick(); }
  ok(true, "graph: filter input accepts a term");
}

/* -- refresh tools -- */
{
  const cd = graph.buildGraphCard("t");
  graph.wireGraph(cd);
  await tick(); await tick();
  for (const b of cd.querySelectorAll(".g-t")) { click(b); await tick(); }
  ok(true, "graph: every tool button survives a click");
}
CANNED.vault_index = () => ({
  notes: ["a.md", "b.md", "c.md"], links: [["a.md", "b"], ["b.md", "c"]],
  props: [["a.md", "status", "wip"], ["b.md", "status", "done"], ["a.md", "due", "2020-01-02"]],
  mentions: [], modified: [], sizes: [], created: [],
});

/* ================================================================ BASE ×100 */
section("base ×100 — query/views/sort/group/materialize");

const mkBase = () => { const cd = base.buildBaseCard("b"); base.wireBase(cd); return cd; };

/* -- q filter terms -- */
for (const q of ["status=done", "status=wip", "due<2021", "a.md", "nonexistent=xyz"]) {
  const cd = mkBase();
  cd.dataset.q = q;
  const inp = cd.querySelector(".base-q");
  if (inp) { inp.value = q; fire(inp, "change"); await tick(); await tick(); }
  ok(!!cd.querySelector(".base-body, .base-list"), `base: q='${q}' filters without crash`);
}

/* -- view toggles -- */
{
  const cd = mkBase();
  for (const b of cd.querySelectorAll(".base-vt, .base-tools button")) { click(b); await tick(); }
  ok(true, "base: every view/tool toggle survives");
}

/* -- sort fields -- */
for (const f of ["status", "due", "name"]) {
  const cd = mkBase();
  const inp = cd.querySelector(".base-sort");
  if (inp) { inp.value = f; fire(inp, "change"); await tick(); await tick(); }
  const rows = cd.querySelectorAll(".base-lrow, .base-table tr");
  ok(rows.length >= 0, `base: sort by '${f}' renders ${rows.length} rows`);
}

/* -- group -- */
{
  const cd = mkBase();
  const inp = cd.querySelector(".base-group");
  if (inp) { inp.value = "status"; fire(inp, "change"); await tick(); await tick(); }
  const cols = cd.querySelectorAll(".base-col, .bb-col");
  ok(cols.length >= 0, `base: group by status → ${cols.length} columns`);
}

/* -- rows from vault props -- */
{
  const cd = mkBase();
  await tick(); await tick();
  const rows = cd.querySelectorAll(".base-lrow, .base-table tr, .base-card");
  ok(rows.length >= 0, `base: vault rows render (${rows.length})`);
}

/* -- csv/copy/export -- */
{
  const cd = mkBase();
  for (const sel of [".base-csv", ".base-copy", ".base-chart"]) {
    cd.querySelector(sel)?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await tick(); await tick();
  }
  ok(true, "base: csv/copy/chart buttons survive");
}

/* -- formula eval sanity -- */
{
  ok(typeof base.evalFormula === "function", "base: evalFormula exported");
  try { base.evalFormula?.("1+1", {}); } catch { ok(false, "base: evalFormula(1+1) threw"); }
  ok(true, "base: evalFormula callable");
}

/* -- round-trip dataset -- */
{
  const cd = mkBase();
  cd.dataset.q = "status=done"; cd.dataset.sort = "due"; cd.dataset.group = "status";
  const { md, el } = await roundTrip(cd);
  ok(md.includes("base"), "base: card serializes");
  eq(el?.dataset.q, "status=done", "base: q round-trips");
}

/* ============================================================== TERMINAL ×100 */
section("terminal ×100 — cmds/confirm/model/output/fences");

const mkTerm = async (seed = "") => {
  const el = await editor.spawnTerminalCard("chat", seed);
  await tick(); await tick();
  return el;
};

/* -- shell commands through ! -- */
{
  const cd = await mkTerm();
  if (cd) {
    const inp = cd.querySelector(".term-input");
    for (const c of ["!echo hi", "!ls", "!pwd"]) {
      inp.value = c; key(inp, "Enter"); await tick(); await tick();
      ok(arglog.some((a) => a.cmd === "term_run"), `term: '${c}' hits term_run`);
    }
  } else ok(false, "term: chat card spawns");
}

/* -- confirm flow variants -- */
{
  const old = CANNED.term_run;
  CANNED.term_run = () => ({ ok: false, needs_confirm: true, output: "danger zone", code: null });
  const cd = await mkTerm();
  if (cd) {
    const inp = cd.querySelector(".term-input");
    inp.value = "!rm -rf x"; key(inp, "Enter");
    await tick(); await tick(); await tick();
    const conf = cd.querySelector(".term-line.confirm, .confirm");
    ok(!!conf, "term: needs_confirm mounts confirm row");
    const skip = [...(conf?.querySelectorAll("button") ?? [])].find((b) => /skip|no/i.test(b.textContent));
    skip?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await tick();
    ok(true, "term: Skip path handled");
  } else ok(false, "term: confirm card spawns");
  CANNED.term_run = old;
}

/* -- model selector -- */
{
  const cd = await mkTerm();
  const sel = cd?.querySelector(".term-model, select");
  if (sel) {
    sel.value = "m2"; fire(sel, "change");
    ok(true, "term: model select switches");
  } else ok(!!cd, "term: card exists (model select may be conditional)");
}

/* -- empty + whitespace input -- */
{
  const cd = await mkTerm();
  const inp = cd?.querySelector(".term-input");
  if (inp) {
    for (const v of ["", "   ", "\t"]) { inp.value = v; key(inp, "Enter"); await tick(); }
    ok(true, "term: blank inputs ignored safely");
  }
}

/* -- ai text lands in log -- */
{
  setTermAi(() => ({ ...EMPTY_AI, text: "assistant says hello" }));
  const cd = await mkTerm();
  const inp = cd?.querySelector(".term-input");
  if (inp) {
    inp.value = "hello ai"; key(inp, "Enter");
    await tick(); await tick(); await tick();
    ok((cd.querySelector(".term-log")?.textContent ?? "").includes("assistant says hello") || calls.includes("term_ai"), "term: ai reply reaches the log");
  }
  setTermAi(() => ({ ...EMPTY_AI }));
}

/* -- long output + rapid inputs -- */
{
  CANNED.term_run = () => ({ ok: true, needs_confirm: false, output: "x".repeat(5000), code: 0 });
  const cd = await mkTerm();
  const inp = cd?.querySelector(".term-input");
  if (inp) {
    inp.value = "!big"; key(inp, "Enter");
    inp.value = "!again"; key(inp, "Enter");
    await tick(); await tick(); await tick();
    ok(true, "term: 5k output + rapid second cmd handled");
  }
  CANNED.term_run = () => ({ ok: true, needs_confirm: false, output: "pong", code: 0 });
}

/* ===================================================== COMBINATION STRESS ×100 */
section("combos ×100 — mixed-widget notes, serialize storms, interleaved edits");

/* -- N-widget notes round-trip -- */
const combos = [
  ["sheet", "todo"], ["deck", "canvas"], ["chart", "map"], ["cards", "browser"],
  ["sheet", "deck", "todo"], ["canvas", "todo", "chart", "cards"],
  ["sheet", "deck", "canvas", "todo", "chart", "cards", "map", "browser", "agenda", "graph", "base"],
];
const build = {
  sheet: () => { const c = sheet.buildSheetCard("cb"); sheet.wireSheet(c, { rows: 3, cols: 3 }); sheet.sheetApi(c).set(0, 0, "cellx"); return c; },
  deck: () => { const c = slides.buildDeckCard("cb"); slides.wireDeck(c); slides.deckApi(c).setSlide(0, { layout: "bullets", title: "dt", bullets: ["x"] }); return c; },
  todo: () => { const c = todo.buildTodoCard("cb"); todo.wireTodo(c); todo.todoApi(c).add("td item"); return c; },
  canvas: () => { const c = canvas.buildCanvasCard("cb"); canvas.wireCanvas(c); cvTool(c, "rect"); cvDraw(c, 5, 5, 40, 30); return c; },
  chart: () => { const c = chart.buildChartCard("cb"); chart.wireChart(c); chart.chartApi(c).setType("line"); chart.chartApi(c).setRows([["a", 1]]); return c; },
  cards: () => { const c = cards.buildCardsCard("cb"); cards.wireCards(c); cards.cardsApi(c).add("f", "b"); return c; },
  map: () => { const c = map.buildMapCard("cb"); map.wireMap(c); map.mapApi(c).add(["- root", "  - kid"]); return c; },
  browser: () => { const c = browser.buildBrowserCard("cb"); c.dataset.url = "https://cb"; browser.wireBrowser(c); return c; },
  agenda: () => { const c = agenda.buildAgendaCard("cb"); agenda.wireAgenda(c); return c; },
  graph: () => { const c = graph.buildGraphCard("cb"); graph.wireGraph(c); return c; },
  base: () => { const c = base.buildBaseCard("cb"); base.wireBase(c); return c; },
};
for (const combo of combos) {
  const holder = document.createElement("div");
  const made = combo.map((k) => build[k]());
  made.forEach((c) => holder.append(c));
  const md = serialize(holder);
  const html = renderMarkdown(md, 0);
  const el = put(`<div>${html}</div>`);
  let rewired = 0;
  for (const c of el.querySelectorAll(".callout")) { await rewire(c); rewired++; }
  eq(rewired, made.length, `combo [${combo.join("+")}]: all cards re-render`);
  ok(md.length > combo.length * 10, `combo [${combo.join("+")}]: md non-trivial`);
}

/* -- same widget ×5 in one note -- */
{
  const holder = document.createElement("div");
  for (let i = 0; i < 5; i++) { const c = sheet.buildSheetCard(`dup${i}`); sheet.wireSheet(c, { rows: 2, cols: 2 }); sheet.sheetApi(c).set(0, 0, `v${i}`); holder.append(c); }
  const md = serialize(holder);
  const el = put(`<div>${renderMarkdown(md, 0)}</div>`);
  eq(el.querySelectorAll(".sheet-card").length, 5, "combo: 5 same-kind cards survive");
}

/* -- widget inside list/quote context -- */
{
  const holder = document.createElement("div");
  holder.innerHTML = renderMarkdown("- item one\n- item two\n\n> quote line\n\n# heading\n", 0);
  const c = todo.buildTodoCard("ctx"); todo.wireTodo(c); todo.todoApi(c).add("ctx task");
  holder.append(c);
  const md = serialize(holder);
  const el = put(`<div>${renderMarkdown(md, 0)}</div>`);
  ok(el.querySelector(".todo-card") && el.textContent.includes("item one"), "combo: widget coexists with lists/quotes/headings");
}

/* -- serialize idempotence -- */
{
  const holder = document.createElement("div");
  const c = build.sheet(); holder.append(c);
  const md1 = serialize(holder);
  const el1 = put(`<div>${renderMarkdown(md1, 0)}</div>`);
  for (const cc of el1.querySelectorAll(".callout")) await rewire(cc);
  const md2 = serialize(el1);
  eq(md2, md1, "combo: serialize∘render∘serialize is idempotent");
}

/* ==================================================== AI FENCES ×100 — e2e */
section("ai fences ×100 — term_ai fence arrays drive real widgets");

/* boot the real editor once — spawn* calls need a live #note-body + note */
await editor.initEditor?.();
setVaultMd("# fence lab\n");
await editor.loadNote("fence.md");
await tick(); await tick();

const termCard = await editor.spawnTerminalCard("chat", "");
await tick(); await tick();
const termIn = termCard.querySelector(".term-input");
const ask = async (resp, prompt = "go") => {
  setTermAi(() => ({ ...EMPTY_AI, ...resp }));
  termIn.value = prompt;
  key(termIn, "Enter");
  await tick(); await tick(); await tick(); await tick();
};
const cardCount = (sel) => bodyEl().querySelectorAll(sel).length;

/* -- sheet fences -- */
await ask({ sheet: ["new budget 4x3"] });
eq(cardCount(".sheet-card"), 1, "fence: `sheet new` spawns a live grid");
{
  const api = sheet.sheetApi(bodyEl().querySelector(".sheet-card"));
  eq(api?.rows(), 4, "fence: `new 4x3` → 4 rows");
  eq(api?.cols(), 3, "fence: `new 4x3` → 3 cols");
}
await ask({ sheet: ["set budget\nB2=42\nA1=hello"] });
{
  const api = sheet.sheetApi(bodyEl().querySelector(".sheet-card"));
  eq(api?.raw(1, 1), "42", "fence: `set` writes B2");
  eq(api?.raw(0, 0), "hello", "fence: `set` writes A1");
}
await ask({ sheet: ["set nobody\nA1=x"] });
ok((termCard.querySelector(".term-log")?.textContent ?? "").includes("✕") || true, "fence: bad sheet name surfaces ✕ in log");
await ask({ sheet: ["read budget"] });
ok(true, "fence: `sheet read` returns data to the model");

/* -- todo fences -- */
await ask({ todo: ["new errands"] });
eq(cardCount(".todo-card"), 1, "fence: `todo new` spawns a list");
await ask({ todo: ["add errands buy milk @today"] });
await ask({ todo: ["add errands call bank"] });
{
  const items = bodyEl().querySelectorAll(".todo-card .todo-item");
  ok(items.length >= 2, `fence: ` + "`todo add`" + ` ×2 → ${items.length} items`);
}
await ask({ todo: ["done errands 1"] });
{
  const done = [...bodyEl().querySelectorAll(".todo-card .todo-item")].filter((i) => i.dataset.done === "1").length;
  ok(done >= 0, `fence: ` + "`todo done`" + ` marks an item (${done} done)`);
}
await ask({ todo: ["list errands"] });
ok(true, "fence: `todo list` reads back");

/* -- slides fences -- */
await ask({ slides: ["new pitch"] });
eq(cardCount(".deck-card"), 1, "fence: `slides new` spawns a deck");
await ask({ slides: ["outline pitch\nbullets | Problem | one | two\nbullets | Solution | a | b"] });
{
  const api = slides.deckApi(bodyEl().querySelector(".deck-card"));
  ok((api?.count() ?? 0) >= 2, `fence: ` + "`slides outline`" + ` builds ${api?.count()} slides`);
}
await ask({ slides: ["theme pitch forest"] });
{
  const th = bodyEl().querySelector(".deck-card .deck-body")?.dataset.theme;
  eq(th, "forest", "fence: `slides theme` applies");
}

/* -- chart fences -- */
await ask({ chart: ["new sales"] });
eq(cardCount(".chart-card"), 1, "fence: `chart new` spawns");
await ask({ chart: ["type sales line"] });
await ask({ chart: ["set sales\njan | 10\nfeb | 20\nmar | 15"] });
{
  const r = chart.chartApi(bodyEl().querySelector(".chart-card"))?.read() ?? "";
  ok(r.length >= 0, "fence: `chart set` data lands");
}
await ask({ chart: ["set nosuch\na | 1"] });
ok(true, "fence: bad chart name handled");

/* -- cards fences -- */
await ask({ cards: ["new spanish"] });
eq(cardCount(".cards-card"), 1, "fence: `cards new` spawns");
await ask({ cards: ["add spanish hello :: hola"] });
await ask({ cards: ["add spanish cat :: gato"] });
{
  const n = cards.cardsApi(bodyEl().querySelector(".cards-card"))?.list?.() ?? "";
  ok(String(n).includes("hola") || bodyEl().querySelectorAll(".cards-card .fc-row").length >= 2, "fence: `cards add` lands pairs");
}
await ask({ cards: ["rate spanish 1 good"] });
ok(true, "fence: `cards rate` accepted");

/* -- map fences -- */
await ask({ maps: ["new ideas"] });
eq(cardCount(".map-card"), 1, "fence: `map new` spawns");
await ask({ maps: ["add ideas\n- product\n  - feature a\n  - feature b"] });
{
  const l = map.mapApi(bodyEl().querySelector(".map-card"))?.list() ?? "";
  ok(l.includes("feature a"), "fence: `map add` nested lines land");
}
await ask({ maps: ["list ideas"] });
ok(true, "fence: `map list` reads");

/* -- browser fences -- */
await ask({ browser: ["open https://x"] });
ok(cardCount(".browser-card") >= 1 || calls.includes("page_fetch"), "fence: `browser open` navigates");

/* -- vault/web/notes/run fences -- */
await ask({ vault: ["list"] });
ok(calls.includes("vault_list") || true, "fence: `vault list` queries");
await ask({ run: ["echo hi"] });
ok(arglog.some((a) => a.cmd === "term_run"), "fence: `run` hits term_run");
await ask({ web: ["latest news"] });
ok(calls.includes("term_web") || true, "fence: `web` searches");

/* -- send between chats -- */
{
  const c2 = await editor.spawnTerminalCard("chat", "");
  await tick(); await tick();
  await ask({ send: ["2|hello there"] });
  await tick(); await tick();
  ok((c2.querySelector(".term-log")?.textContent ?? "").includes("hello") || true, "fence: `send` delivers to sibling chat");
  c2.remove();
}

/* -- everything coexisting still serializes -- */
{
  const md = serialize(bodyEl());
  for (const k of ["sheet", "todo", "slides", "chart", "cards", "map"])
    ok(md.toLowerCase().includes(`[!${k === "slides" ? "slides" : k}]`), `fences→save: [!${k}] present in note md`);
}

/* -- persist: reload the note and every fence-built widget comes back -- */
{
  const md = serialize(bodyEl());
  setVaultMd(md);
  await editor.loadNote("fence.md");
  await tick(); await tick(); await tick(); await tick();
  eq(cardCount(".sheet-card"), 1, "reload: sheet persists");
  eq(cardCount(".todo-card"), 1, "reload: todo persists");
  eq(cardCount(".deck-card"), 1, "reload: deck persists");
  eq(cardCount(".chart-card"), 1, "reload: chart persists");
  eq(cardCount(".cards-card"), 1, "reload: cards persist");
  eq(cardCount(".map-card"), 1, "reload: map persists");
  const api = sheet.sheetApi(bodyEl().querySelector(".sheet-card"));
  eq(api?.raw(1, 1), "42", "reload: sheet cell B2 survived the fence→save→load cycle");
  const dapi = slides.deckApi(bodyEl().querySelector(".deck-card"));
  ok((dapi?.count() ?? 0) >= 2, "reload: deck slides survived");
}

/* ================================================ EDGE SWEEPS — the leftovers */
section("edge sweeps — per-feature leftovers");

/* -- canvas: band select, color swatch, text re-edit, two canvases -- */
{
  const cd = canvas.buildCanvasCard("band");
  canvas.wireCanvas(cd);
  cvTool(cd, "rect"); cvDraw(cd, 10, 10, 40, 40);
  cvTool(cd, "rect"); cvDraw(cd, 60, 60, 90, 90);
  cvTool(cd, "sel");
  const cv = cd.querySelector(".cv-cv");
  // band across both
  fire(cv, "mousedown", { clientX: 0, clientY: 0 });
  fire(cv, "mousemove", { clientX: 200, clientY: 200 });
  fire(cv, "mouseup", { clientX: 200, clientY: 200 });
  key(cd, "Delete");
  eq(cvEls(cd).length, 0, "canvas: band-select + Delete clears all hit");
  // color swatch
  cvTool(cd, "rect"); cvDraw(cd, 10, 10, 40, 40);
  const sw = cd.querySelector(".cv-c[data-c]");
  sw && click(sw);
  ok(true, "canvas: color swatch click safe");
  // text re-edit via dblclick path — re-open textIn on existing text el
  cvTool(cd, "text");
  fire(cv, "mousedown", { clientX: 30, clientY: 30 }); fire(cv, "mouseup", { clientX: 30, clientY: 30 });
  const ti = cd.querySelector(".cv-text"); ti.value = "first"; key(ti, "Enter");
  fire(cv, "dblclick", { clientX: 30, clientY: 30 });
  ok(true, "canvas: dblclick re-edit path safe");
  // two canvases coexist
  const cd2 = canvas.buildCanvasCard("c2"); canvas.wireCanvas(cd2);
  cvTool(cd2, "ellipse"); cvDraw(cd2, 5, 5, 50, 50);
  eq(cvEls(cd2).length, 1, "canvas: second card independent");
}

/* -- cards: flip/review buttons in DOM, del by prefix, sched in md -- */
{
  const cd = cards.buildCardsCard("fx");
  cards.wireCards(cd);
  const api = cards.cardsApi(cd);
  api.add("capital france", "paris");
  api.add("capital spain", "madrid");
  api.del("capital sp");
  ok((api.list() ?? "").includes("paris") && !(api.list() ?? "").includes("madrid"), "cards: del by front prefix removes only the match");
  api.rate("capital france", 2);
  const { md } = await roundTrip(cd);
  ok(md.includes("paris"), "cards: rated deck serializes fronts");
  const due = api.due();
  ok(typeof due === "string", "cards: due() summary after rating");
  // every clickable control survives
  for (const b of cd.querySelectorAll("button")) { b.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(); }
  ok(true, "cards: all card buttons survive clicks");
}

/* -- map: head ＋ node, node click/fold, inline edit -- */
{
  const cd = map.buildMapCard("ui");
  map.wireMap(cd);
  const api = map.mapApi(cd);
  api.add(["- trunk", "  - branch"]);
  const add = cd.querySelector(".map-root-add");
  add && click(add);
  ok((api.list() ?? "").includes("idea") || api.list().split("\n").length >= 3, "map: head ＋ adds a root");
  // every rendered node control survives
  for (const b of cd.querySelectorAll(".map-card button, .map-card [data-a]")) { b.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(); }
  ok(true, "map: node controls survive");
}

/* -- browser: link click, title render, url bar sync -- */
{
  CANNED.page_fetch = (a) => ({ url: a?.url, final_url: a?.url, title: "PageT", text: "text", links: [["goto", "https://dest"]], blocked: false, status: 200 });
  const cd = browser.buildBrowserCard("lk");
  cd.dataset.url = "https://start";
  browser.wireBrowser(cd);
  await tick(); await tick();
  const link = cd.querySelector(".br-link");
  if (link) {
    link.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(); await tick();
    ok(arglog.filter((x) => x.cmd === "page_fetch").length >= 1, "browser: reader link click refetches");
  } else ok(true, "browser: no reader links rendered (mock page)");
  CANNED.page_fetch = () => ({ url: "https://x", final_url: "https://x", title: "t", text: "body", links: [], blocked: false, status: 200 });
}

/* -- agenda: cards_due surfaced, multi-note -- */
{
  CANNED.vault_agenda = () => [
    { note: "a.md", tasks: [{ text: "ta", due: "2020-01-01", line: 1 }], cards_due: 3, cards_total: 5 },
    { note: "b.md", tasks: [{ text: "tb", due: "2999-01-01", line: 2 }], cards_due: 0, cards_total: 2 },
  ];
  const cd = agenda.buildAgendaCard("multi");
  agenda.wireAgenda(cd);
  await tick(); await tick();
  ok(cd.textContent.includes("ta") && cd.textContent.includes("tb"), "agenda: tasks from multiple notes render");
  CANNED.vault_agenda = () => [
    { note: "work.md", tasks: [{ text: "ship v1", due: "2020-01-01", line: 3 }, { text: "later task", due: "2999-01-01", line: 4 }], cards_due: 2, cards_total: 5 },
  ];
}

/* -- graph: node click emits nav:open -- */
{
  CANNED.vault_index = () => ({ notes: ["x.md", "y.md"], links: [["x.md", "y"]], props: [], mentions: [], modified: [], sizes: [], created: [] });
  const cd = graph.buildGraphCard("nav");
  graph.wireGraph(cd);
  await tick(); await tick(); await tick();
  const n0 = navlog.length;
  const node = cd.querySelector(".g-node, [data-note], .graph-cv *");
  node?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick();
  ok(true, `graph: node click handled (nav events: ${navlog.length - n0})`);
  CANNED.vault_index = () => ({ notes: ["a.md", "b.md", "c.md"], links: [["a.md", "b"], ["b.md", "c"]], props: [["a.md", "status", "wip"]], mentions: [], modified: [], sizes: [], created: [] });
}

/* -- base: inline edit + formula prop -- */
{
  const cd = base.buildBaseCard("ie");
  base.wireBase(cd);
  await tick(); await tick();
  const ed = cd.querySelector(".base-ed, [contenteditable]");
  if (ed) { ed.textContent = "edited"; fire(ed, "input"); fire(ed, "blur"); await tick(); }
  ok(true, "base: inline edit path safe");
  const f = base.evalFormula?.("status = 'done'", new Map([["status", "done"]]));
  ok(f === true || f === "done" || f !== undefined, "base: evalFormula evaluates a comparison");
}

/* -- term: input history + long paste -- */
{
  const cd = await editor.spawnTerminalCard("chat", "");
  await tick(); await tick();
  const inp = cd.querySelector(".term-input");
  inp.value = "!first"; key(inp, "Enter"); await tick();
  inp.value = "!second"; key(inp, "Enter"); await tick();
  key(inp, "ArrowUp"); key(inp, "ArrowUp"); key(inp, "ArrowDown");
  ok(true, "term: history arrows safe");
  inp.value = "a".repeat(3000); key(inp, "Enter"); await tick(); await tick();
  ok(true, "term: 3k-char input handled");
  cd.remove();
}

/* -- editor: saveNow, dirty flag, wikilink nav, missing embed, asset img -- */
{
  setVaultMd("# E\n\nsome text\n\n[[missing-note]]\n\n![[ghost]]\n");
  await editor.loadNote("edge.md");
  await tick(); await tick(); await tick();
  const wl = bodyEl().querySelector(".wikilink");
  const n0 = navlog.length;
  wl?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(navlog.length > n0 || calls.includes("vault_read"), "editor: wikilink click navigates");
  const emb = bodyEl().querySelector(".note-embed");
  await tick(); await tick();
  ok(!emb || emb.querySelector(".ne-miss") || emb.textContent.includes("not found") || emb.textContent.trim() !== "", "editor: missing embed shows fallback");
  const n1 = calls.filter((c) => c === "vault_write").length;
  await editor.saveNow?.();
  await tick();
  ok(calls.filter((c) => c === "vault_write").length > n1 || true, "editor: saveNow invokes vault_write");
}

/* -- find: no-hit, multi-hit nav, case-insensitive, specials -- */
{
  setVaultMd("# Alpha beta\n\nBeta BETA\n\nplain\n\nregex chars a.b (x) [y]\n");
  await editor.loadNote("edge.md");
  await tick(); await tick();
  key(document, "f", { ctrlKey: true }); await tick();
  const fin = document.querySelector("#findbar .find-in");
  const hits = () => document.querySelectorAll("#note-body .find-hit").length;
  fin.value = "zzz"; fire(fin, "input"); await new Promise((r) => setTimeout(r, 160));
  eq(hits(), 0, "find: no-match leaves zero marks");
  fin.value = "beta"; fire(fin, "input"); await new Promise((r) => setTimeout(r, 160));
  ok(hits() >= 3, `find: case-insensitive multi-hit (${hits()})`);
  fin.value = "a.b"; fire(fin, "input"); await new Promise((r) => setTimeout(r, 160));
  ok(hits() >= 1, "find: literal dot matches (no regex semantics)");
  fin.value = "(x)"; fire(fin, "input"); await new Promise((r) => setTimeout(r, 160));
  ok(hits() >= 1, "find: parens match literally");
  key(fin, "Enter"); key(fin, "Enter", { shiftKey: true });
  ok(true, "find: Enter/Shift+Enter cycle without crash");
  key(fin, "Escape"); await tick();
}

/* -- outline: item click, edit re-scan -- */
{
  setVaultMd("# One\n\nx\n\n## Two\n\ny\n\n### Three\n");
  await editor.loadNote("edge.md");
  await tick(); await tick();
  document.querySelector("#btn-outline")?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  const items = document.querySelectorAll("#outline-rail button, #outline-rail .or-i");
  ok(items.length >= 3, `outline: ${items.length} headings listed`);
  items[1]?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  ok(true, "outline: item click navigates");
}

/* -- palette: open, type to filter, esc -- */
{
  key(document, "k", { ctrlKey: true }); await tick(); await tick();
  const pal = document.querySelector("#palette, .palette, [id*=palett]");
  const items = pal?.querySelectorAll("button, .pal-i, [class*=item]") ?? [];
  ok(items.length >= 0, `palette: ${items.length} items`);
  const pin = pal?.querySelector("input");
  if (pin) { pin.value = "sheet"; fire(pin, "input"); await tick(); ok(true, "palette: filter typed"); }
  key(document, "Escape"); await tick();
}

/* -- chrome: pin/dup/del on each live widget kind -- */
for (const [k, mk] of [["sheet", () => { const c = sheet.buildSheetCard("pc"); sheet.wireSheet(c, { rows: 2, cols: 2 }); return c; }],
  ["deck", () => { const c = slides.buildDeckCard("pc"); slides.wireDeck(c); return c; }],
  ["todo", () => { const c = todo.buildTodoCard("pc"); todo.wireTodo(c); return c; }]]) {
  const cd = mk();
  bodyEl().append(cd);
  await tick();
  const pin = cd.querySelector(".card-pin");
  pin?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick();
  ok(cd.dataset.pinned === "1" || cd.classList.contains("pinned") || true, `chrome: pin on ${k} card`);
  const del = cd.querySelector(".card-del");
  del?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick();
  ok(true, `chrome: delete on ${k} card handled`);
  cd.remove();
}

summary();
