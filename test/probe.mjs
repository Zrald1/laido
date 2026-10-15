/* Hostile-input probe — every exported parser/builder/API gets garbage.
 * A CRASH is a real bug (user can hit it via malformed notes or AI output).
 * A LEAK is a serialized "undefined"/"NaN"/"null"/"[object Object]" — data rot.
 * Run: node test/probe.mjs */

import {
  w, ok, eq, section, tick, put, summary,
  calls, arglog, emitTauri, VAULT_FILES, setVaultMd, setTermAi, EMPTY_AI,
  sheet, slides, canvas, todo, browser, chart, cards, map, agenda, graph, base,
  editable, render, term, editor, cardToMd, serialize, renderCalloutMd, renderMarkdown,
} from "./env.mjs";

const bodyEl = () => document.querySelector("#note-body");
await editor.initEditor?.();
setVaultMd("# probe\n");
await editor.loadNote("z.md");
await tick();

let crash = 0, leak = 0, fine = 0;
const crashes = [], leaks = [];
const LEAKY = /undefined|NaN|\[object Object\]/;

/** run fn; crash = exception, leak = "undefined"/"NaN"/"null"/"[object" in output */
const probe = async (name, fn, opts = {}) => {
  let out;
  try {
    out = fn();
    if (out?.then) out = await out.catch((e) => { throw e; });
  } catch (e) {
    crash++;
    crashes.push(`${name}: ${String(e).slice(0, 110)}`);
    return;
  }
  // inspect returned strings + the DOM the fn may have touched
  const texts = [];
  if (typeof out === "string") texts.push(out);
  if (out instanceof HTMLElement) texts.push(out.outerHTML.slice(0, 4000));
  if (opts.dom) texts.push(opts.dom.outerHTML.slice(0, 4000));
  // `✕`-prefixed strings are honest rejection messages — echoing coerced input is fine
  const hit = texts.find((t) => !t.startsWith("✕") && LEAKY.test(t));
  if (hit && !opts.allowLeak) {
    leak++;
    leaks.push(`${name}: ${hit.slice(Math.max(0, hit.search(LEAKY) - 60), hit.search(LEAKY) + 60).replace(/\n/g, " | ")}`);
    return;
  }
  fine++;
};

const BAD = [undefined, null, "", " ", 0, -1, NaN, 1e9, "x", "\u0000", "<script>", "🕳️", "a".repeat(5000), {}, [], () => {}];
const BADTYPES = [undefined, null, 0, "x", {}, [], NaN];

section("probe — builders with no/bad args");
for (const bad of BAD.slice(0, 8)) {
  await probe(`buildSheetCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => sheet.buildSheetCard(bad));
  await probe(`buildDeckCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => slides.buildDeckCard(bad));
  await probe(`buildCanvasCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => canvas.buildCanvasCard(bad));
  await probe(`buildTodoCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => todo.buildTodoCard(bad));
  await probe(`buildBrowserCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => browser.buildBrowserCard(bad));
  await probe(`buildBrowserCard(t,url) bad`, () => browser.buildBrowserCard("t", bad));
  await probe(`buildChartCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => chart.buildChartCard(bad));
  await probe(`buildMapCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => map.buildMapCard(bad));
  await probe(`buildAgendaCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => agenda.buildAgendaCard(bad));
  await probe(`buildGraphCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => graph.buildGraphCard(bad));
  await probe(`buildBaseCard(${JSON.stringify(bad)?.slice(0, 12)})`, () => base.buildBaseCard(bad));
}

section("probe — wire on broken DOM");
for (const [n, fn] of [["wireSheet", sheet.wireSheet], ["wireDeck", slides.wireDeck], ["wireCanvas", canvas.wireCanvas],
  ["wireTodo", todo.wireTodo], ["wireBrowser", browser.wireBrowser], ["wireChart", chart.wireChart],
  ["wireCards", cards.wireCards], ["wireMap", map.wireMap], ["wireAgenda", agenda.wireAgenda],
  ["wireGraph", graph.wireGraph], ["wireBase", base.wireBase]]) {
  await probe(`${n}(empty div)`, () => fn(document.createElement("div")));
  await probe(`${n}(div with only callout class)`, () => { const d = document.createElement("div"); d.className = "callout"; fn(d); });
  await probe(`${n}(undefined)`, () => fn(undefined));
}

section("probe — parsers on hostile strings");
const junk = [undefined, null, "", " ", "\u0000", "<script>", "🕳️".repeat(300), "> [!sheet]\n> ", "=", "|", "---", 0, 5, {}, [], NaN];
for (const j of junk) {
  await probe(`parseSheetLine(${JSON.stringify(j)?.slice(0, 14)})`, () => sheet.parseSheetLine(j));
  await probe(`parseSlideLine`, () => slides.parseSlideLine(j));
  await probe(`parseSlideHead`, () => slides.parseSlideHead(j));
  await probe(`parseTodoLine`, () => todo.parseTodoLine(j));
  await probe(`parseTodo`, () => todo.parseTodo(j));
  await probe(`parseBrowser`, () => browser.parseBrowser(j));
  await probe(`parseChart`, () => chart.parseChart(j));
  await probe(`parseCards`, () => cards.parseCards(j));
  await probe(`parseMapTree`, () => map.parseMapTree(j));
  await probe(`parseDeck`, () => slides.parseDeck(j));
  await probe(`parseWhen`, () => todo.parseWhen(j));
  await probe(`parseDelim`, () => sheet.parseDelim(j));
  await probe(`parseFormulas`, () => base.parseFormulas(j));
  await probe(`evalFormula(j)`, () => base.evalFormula(j, new Map()));
  await probe(`baseMatch`, () => base.baseMatch(j, new Map()));
  await probe(`h8`, () => cards.h8(j));
  await probe(`isoOf`, () => sheet.isoOf(j));
  await probe(`cellName`, () => sheet.cellName(j, j));
  await probe(`toUrl`, () => browser.toUrl(j));
  await probe(`slideFromDom`, () => slides.slideFromDom(j));
  await probe(`parseDay`, () => sheet.parseDay(j));
}

section("probe — serializers on hostile cards");
for (const j of junk.slice(0, 10)) {
  await probe(`cardToMd(${JSON.stringify(j)?.slice(0, 14)})`, () => cardToMd(j), { allowLeak: true });
  await probe(`serialize(div of junk)`, () => { const d = document.createElement("div"); d.innerHTML = typeof j === "string" ? j : ""; serialize(d); }, { allowLeak: true });
}
for (const [n, fn, mk] of [
  ["sheetToMd", sheet.sheetToMd, () => sheet.buildSheetCard("x")],
  ["deckToMd", slides.deckToMd, () => slides.buildDeckCard("x")],
  ["canvasToMd", canvas.canvasToMd, () => canvas.buildCanvasCard("x")],
  ["todoToMd", todo.todoToMd, () => todo.buildTodoCard("x")],
  ["browserToMd", browser.browserToMd, () => browser.buildBrowserCard("x")],
  ["chartToMd", chart.chartToMd, () => chart.buildChartCard("x")],
  ["cardsToMd", cards.cardsToMd, () => cards.buildCardsCard("x", [])],
  ["mapToMd", map.mapToMd, () => map.buildMapCard("x")],
  ["agendaToMd", agenda.agendaToMd, () => agenda.buildAgendaCard("x")],
  ["graphToMd", graph.graphToMd, () => graph.buildGraphCard("x")],
  ["baseToMd", base.baseToMd, () => base.buildBaseCard("x")],
]) {
  await probe(`${n}(fresh card)`, () => fn(mk()));
  await probe(`${n}(empty div)`, () => fn(document.createElement("div")));
  await probe(`${n}(undefined)`, () => fn(undefined));
}

section("probe — api verbs with hostile args");
{
  const sh = sheet.buildSheetCard("a"); sheet.wireSheet(sh, { rows: 2, cols: 2 });
  const api = sheet.sheetApi(sh);
  for (const bad of BADTYPES) {
    await probe(`sheetApi.set(bad)`, () => api.set(bad, bad, bad));
    await probe(`sheetApi.raw(bad)`, () => api.raw(bad, bad));
    await probe(`sheetApi.addRow(bad)`, () => api.addRow(bad));
    await probe(`sheetApi.delRow(bad)`, () => api.delRow(bad));
    await probe(`sheetApi.delCol(bad)`, () => api.delCol(bad));
    await probe(`sheetApi.setCells(bad)`, () => api.setCells(bad));
    await probe(`sheetApi.clear(bad)`, () => api.clear(bad, bad));
    await probe(`sheetApi.dedupe(bad)`, () => api.dedupe?.(bad));
    await probe(`sheetApi.sort(bad)`, () => api.sort?.(bad, bad));
    await probe(`sheetApi.exportFile(bad)`, () => api.exportFile?.(bad));
  }
}
{
  const d = slides.buildDeckCard("a"); slides.wireDeck(d);
  const api = slides.deckApi(d);
  for (const bad of BADTYPES) {
    await probe(`deckApi.addSlide(bad)`, () => api.addSlide(bad));
    await probe(`deckApi.setSlide(bad)`, () => api.setSlide(bad, bad));
    await probe(`deckApi.moveSlide(bad)`, () => api.moveSlide(bad, bad));
    await probe(`deckApi.delSlide(bad)`, () => api.delSlide(bad));
    await probe(`deckApi.duplicate(bad)`, () => api.duplicate(bad));
    await probe(`deckApi.setTheme(bad)`, () => api.setTheme(bad));
    await probe(`deckApi.setTransition(bad)`, () => api.setTransition(bad));
    await probe(`deckApi.setNote(bad)`, () => api.setNote(bad, bad));
    await probe(`deckApi.setBg(bad)`, () => api.setBg(bad, bad));
    await probe(`deckApi.show(bad)`, () => api.show?.(bad));
  }
}
{
  const t = todo.buildTodoCard("a"); todo.wireTodo(t);
  const api = todo.todoApi(t);
  for (const bad of BADTYPES) {
    await probe(`todoApi.add(bad)`, () => api.add(bad));
    await probe(`todoApi.setDone(bad)`, () => api.setDone(bad, bad));
    await probe(`todoApi.del(bad)`, () => api.del(bad));
    await probe(`todoApi.edit(bad)`, () => api.edit?.(bad, bad));
  }
}
{
  const c = cards.buildCardsCard("a", []); cards.wireCards(c);
  const api = cards.cardsApi(c);
  for (const bad of BADTYPES) {
    await probe(`cardsApi.add(bad)`, () => api.add?.(bad));
    await probe(`cardsApi.del(bad)`, () => api.del?.(bad));
    await probe(`cardsApi.rate(bad)`, () => api.rate?.(bad, bad));
    await probe(`cardsApi.due(bad)`, () => api.due?.(bad));
  }
}
{
  const m = map.buildMapCard("a"); map.wireMap(m);
  const api = map.mapApi(m);
  for (const bad of BADTYPES) {
    await probe(`mapApi.add(bad)`, () => api.add?.(bad));
    await probe(`mapApi.del(bad)`, () => api.del?.(bad));
    await probe(`mapApi.rename(bad)`, () => api.rename?.(bad));
    await probe(`mapApi.fold(bad)`, () => api.fold?.(bad));
  }
}
{
  const b = browser.buildBrowserCard("a"); browser.wireBrowser(b);
  const api = browser.browserApi(b);
  for (const bad of BADTYPES) {
    await probe(`browserApi.nav(bad)`, () => api.nav?.(bad));
    await probe(`browserApi.back(bad)`, () => api.back?.(bad));
    await probe(`browserApi.fwd(bad)`, () => api.fwd?.(bad));
    await probe(`browserApi.setMode(bad)`, () => api.setMode?.(bad));
    await probe(`browserApi.bookmark(bad)`, () => api.bookmark?.(bad));
    await probe(`browserApi.clip(bad)`, () => api.clip?.(bad));
  }
}
{
  const ch = chart.buildChartCard("a"); chart.wireChart(ch);
  const api = chart.chartApi(ch);
  for (const bad of BADTYPES) {
    await probe(`chartApi.setType(bad)`, () => api.setType?.(bad));
    await probe(`chartApi.setRows(bad)`, () => api.setRows?.(bad));
    await probe(`chartApi.setSource(bad)`, () => api.setSource?.(bad));
    await probe(`chartApi.export(bad)`, () => api.export?.(bad));
  }
}
{
  const bs = base.buildBaseCard("a"); base.wireBase(bs);
  for (const bad of BADTYPES) {
    await probe(`propCmp(bad)`, () => base.propCmp(bad, bad));
  }
}

section("probe — markdown fuzz");
for (const md of [
  "> [!sheet]\n", "> [!sheet\n", "> [!!]\n> x", "> [!sheet] \u0000\n> !@#$%",
  "> [!deck]\n> ---\n> [!deck]\n> ---\n".repeat(30),
  "> [!todo]\n> - [ \n> - ] ]\n",
  "> [!map]\n" + "> " + "  ".repeat(200) + "- deep\n",
  "> [!chart] a\n> data: ,\n".repeat(50),
  "> [!cards] a\n> no rows\n> :: only\n> ::: triple\n",
  "> [!browser] a\n> url: javascript:alert(1)\n",
  "> [!base] a\n> q: x\n> q: y".repeat(30),
  "```sheet\nnever closed\n\n\n",
  "![[nonexistent]]\n![[]]\n[[broken link]]\n[[a#b#c]]",
  "> [!sheet] x\n" + "> " + "9".repeat(9000) + "\n",
]) {
  await probe(`renderMarkdown(${JSON.stringify(md.slice(0, 30))})`, () => {
    const el = document.createElement("div");
    el.innerHTML = renderMarkdown(md);
    return el;
  }, { allowLeak: true });
  await probe(`roundtrip(${JSON.stringify(md.slice(0, 30))})`, () => {
    const holder = document.createElement("div");
    holder.innerHTML = renderMarkdown(md);
    serialize(holder);
  }, { allowLeak: true });
}

/* hostile Tauri payloads */
section("probe — hostile tauri payloads");
for (const [ev, p] of [
  ["remind:fired", undefined], ["remind:fired", {}], ["remind:fired", { note: 1, text: {}, ts: "x" }],
  ["brief:done", {}], ["brief:done", { name: 42 }],
  ["open-note", {}], ["open-note", { name: undefined }],
  ["agent:activity", {}], ["agent:activity", { text: undefined }],
  ["research:done", {}], ["research:done", { note: "z.md", topic: undefined, callout: undefined }],
  ["skill:proposed", {}],
]) {
  await probe.async ?? null;
  try {
    emitTauri(ev, p);
    for (let i = 0; i < 6; i++) await tick();
    fine++;
  } catch (e) { crash++; crashes.push(`emitTauri(${ev}, ${JSON.stringify(p)?.slice(0, 30)}): ${String(e).slice(0, 100)}`); }
}

/* ---- report ---- */
console.log(`\n${fine} clean, ${crash} crashes, ${leak} leaks`);
if (crashes.length) { console.log("\n=== CRASHES ==="); crashes.forEach((c) => console.log("  " + c)); }
if (leaks.length) { console.log("\n=== LEAKS ==="); leaks.forEach((c) => console.log("  " + c)); }
process.exit(crashes.length || leaks.length ? 1 : 0);
