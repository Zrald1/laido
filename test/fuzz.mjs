/* Mega-fuzz — every exported fn × every arg slot × hostile values; every api
 * verb × arg slots; random op sequences per widget; dataset corruption;
 * serialize round-trips. Dedupes crashes by exception site (unique bugs).
 * Run: node test/fuzz.mjs  (after npx tsc) */

import * as E from "./env.mjs";
const {
  w, put, tick, rewire, cardToMd, renderMarkdown, renderCalloutMd,
  sheet, slides, canvas, todo, browser, chart, cards, map, agenda, graph, base,
  editable, render, term, editor, agent, section, U,
} = E;
const links = await U("links.js");
const match = await U("match.js");
const slices = await U("slices.js");
const wikictx = await U("wikictx.js");
const i18n = await U("i18n.js");
const log = await U("log.js");
const cardundo = await U("cardundo.js");

/* ---------- harness ---------- */
const LEAKY = /undefined|NaN|\[object|\bnull\b/;
const crashMap = new Map(); // site -> {name, err}
const leaks = [];
let clean = 0;

const siteOf = (e) => {
  const m = String(e.stack || "").match(/ui[\/\\](\w+\.js):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : String(e).slice(0, 80);
};
const pending = [];
process.on("unhandledRejection", (e) => recordSync("async-unhandled", e));
const recordSync = (name, e) => {
  const site = siteOf(e);
  if (!crashMap.has(site)) crashMap.set(site, []);
  crashMap.get(site).push(`${name} → ${String(e).slice(0, 90)}`);
};
const record = (name, fn) => {
  try {
    const r = fn();
    if (r?.then) { pending.push(Promise.resolve(r).then((v) => okRet(name, v)).catch((e) => recordSync(name, e))); return; }
    okRet(name, r);
  } catch (e) { recordSync(name, e); }
};
const describe = (v) =>
  v === undefined ? "undef" : v === null ? "null" : typeof v === "symbol" ? "sym"
  : typeof v === "bigint" ? "bigint" : typeof v === "function" ? "fn"
  : v instanceof Date ? "date" : typeof v === "string" && v.length > 40 ? "long"
  : JSON.stringify(v)?.slice(0, 20) ?? String(v);
const okRet = (name, out) => {
  const texts = [];
  if (typeof out === "string") texts.push(out);
  if (out instanceof HTMLElement) texts.push(out.outerHTML.slice(0, 5000));
  const hit = texts.find((t) => !t.startsWith("✕") && LEAKY.test(t));
  if (hit) { leaks.push(`${name}: …${hit.slice(Math.max(0, hit.search(LEAKY) - 50), hit.search(LEAKY) + 50).replace(/\n/g, " | ")}`); return; }
  clean++;
};

/* hostile inputs — getters/proxies excluded from JSON paths to keep it honest */
const BAD = [
  undefined, null, 0, -1, NaN, Infinity, -Infinity, "", " ", 1e9, "x",
  "\u0000", "\ud800", "<img src=x onerror=1>", "💣", "\n\t\r", "{}", "[]",
  "a".repeat(9000), {}, [], [null], [undefined], { a: 1 }, { length: 3 },
  () => {}, Symbol("s"), 5n, new Date("junk"), true,
];

const GOOD = {
  card: () => put(`<div class="callout" data-kind="todo" data-topic="x"></div>`),
  sheetCard: () => sheet.buildSheetCard("g"),
  sched: () => ({ ease: 2.5, ivl: 1, reps: 1, due: "2025-01-01" }),
  slide: () => slides.emptySlide("title"),
};

/* signature table: [label, fn, goodArgs, fuzzArgCount] — each of the first N
 * arg slots gets swapped with every BAD value; rest stay good */
const FNS = [
  // agenda
  ["dueBucket", agenda.dueBucket, ["2025-01-02", "2025-01-01", "2025-01-07"], 3],
  ["agendaCallout", agenda.agendaCallout, [["agenda title", "todo tasks", "- [ ] x @today"]], 1],
  ["agendaToMd", agenda.agendaToMd, [agenda.buildAgendaCard()], 1],
  // agent
  ["noticeKey", agent.noticeKey, ["kind", "note", "text", 1], 4],
  ["dismissNotice", agent.dismissNotice, [{ id: "x", kind: "k" }], 1],
  // base
  ["baseCallout", base.baseCallout, [["base t", "q kind:task"]], 1],
  ["propCmp", base.propCmp, ["eq", "a", "a"], 3],
  ["evalFormula", base.evalFormula, ["a*2", new Map([["a", 2]])], 2],
  ["parseFormulas", base.parseFormulas, ["sum=+"], 1],
  ["isToken", base.isToken, ["tok"], 1],
  ["baseMatch", base.baseMatch, [{ name: "n", props: { kind: "task" } }, "kind:task"], 2],
  ["buildPropMaps", base.buildPropMaps, [[{ name: "n", props: { k: "v" }, text: "" }]], 1],
  ["baseSort", base.baseSort, [[["k", 1], ["a", 2]], "0"], 2],
  ["buildBaseCard", base.buildBaseCard, ["t"], 1],
  // browser
  ["toUrl", browser.toUrl, ["example.com"], 1],
  ["parseBrowser", browser.parseBrowser, [["browser t", "url: x"]], 1],
  ["browserToMd", browser.browserToMd, [browser.buildBrowserCard("t", "u")], 1],
  ["buildBrowserCard", browser.buildBrowserCard, ["t", "u"], 2],
  // canvas
  ["canvasCallout", canvas.canvasCallout, [["canvas t", 'scene: {"els":[]}']], 1],
  ["canvasToMd", canvas.canvasToMd, [canvas.buildCanvasCard("t")], 1],
  ["buildCanvasCard", canvas.buildCanvasCard, ["t"], 1],
  // cards
  ["h8", cards.h8, ["front"], 1],
  ["grade", cards.grade, [GOOD.sched(), 2], 2],
  ["previewIvl", cards.previewIvl, [GOOD.sched(), 2], 2],
  ["isDue", cards.isDue, [GOOD.sched()], 1],
  ["parseCards", cards.parseCards, [["cards t", "a :: b"]], 1],
  ["cardsToMd", cards.cardsToMd, [cards.buildCardsCard("t")], 1],
  ["buildCardsCard", cards.buildCardsCard, ["t", [{ front: "a", back: "b" }]], 2],
  // cardundo
  ["tryCardUndo", cardundo.tryCardUndo, [GOOD.card(), 1], 2],
  ["armCardUndo", cardundo.armCardUndo, [GOOD.card()], 1],
  // chart
  ["parseChart", chart.parseChart, [["chart t", "type: bar", "a | 1"]], 1],
  ["chartToMd", chart.chartToMd, [chart.buildChartCard("t")], 1],
  ["chartFromCard", chart.chartFromCard, [chart.buildChartCard("t")], 1],
  ["buildChartCard", chart.buildChartCard, ["t"], 1],
  // editable
  ["cardToMd", editable.cardToMd, [GOOD.card()], 1],
  ["normalizeCard", editable.normalizeCard, [GOOD.card()], 1],
  ["serialize", editable.serialize, [], 0],
  // editor pure-ish
  ["fillTemplateVars", editor.fillTemplateVars, ["{{today}}", "n", new Date()], 3],
  ["insertClip", editor.insertClip, ["t", "u", "x"], 3],
  ["pinCard", editor.pinCard, [GOOD.card()], 1],
  ["popOutStickyById", editor.popOutStickyById, ["id"], 1],
  // find
  ["openFind", (await U("find.js")).openFind, [], 0],
  // graph
  ["graphCallout", graph.graphCallout, [["graph t"]], 1],
  ["graphToMd", graph.graphToMd, [graph.buildGraphCard("t")], 1],
  ["buildGraphCard", graph.buildGraphCard, ["t"], 1],
  // i18n
  ["i18n.t", i18n.t, ["save"], 1],
  ["setLang", i18n.setLang, ["en"], 1],
  // links
  ["isSetFromIndex", links.isSetFromIndex, ["p", ["n1"]], 2],
  ["isLinkSet", links.isLinkSet, ["p", [["a", "n1"]], ["n1"]], 3],
  ["isProbe", links.isProbe, ["prop"], 1],
  ["isFmQueries", links.isFmQueries, ["kind:x other:y"], 1],
  ["linkifyLine", links.linkifyLine, ["a line [[n1]]", ["n1"]], 2],
  ["linkInfo", links.linkInfo, ["n1"], 1],
  // log
  ["addActivity", log.addActivity, ["did a thing"], 1],
  // map
  ["parseMapTree", map.parseMapTree, [["- a", "  - b"]], 1],
  ["mapTreeLines", map.mapTreeLines, [map.parseMapTree(["- a"])], 1],
  ["mapCallout", map.mapCallout, [["map t", "- a"]], 1],
  ["cardMapTree", map.cardMapTree, [map.buildMapCard("t")], 1],
  ["mapToMd", map.mapToMd, [map.buildMapCard("t")], 1],
  ["buildMapCard", map.buildMapCard, ["t"], 1],
  // match
  ["stem", match.stem, ["running"], 1],
  ["fuzzy", match.fuzzy, ["abc", "xabcx"], 2],
  // render
  ["renderCalloutMd", render.renderCalloutMd, ["> [!todo] t"], 1],
  ["renderMarkdown", render.renderMarkdown, ["# h"], 1],
  // sheet
  ["groupKeys", sheet.groupKeys, [["a", "b"]], 1],
  ["parseDay", sheet.parseDay, ["today"], 1],
  ["isoOf", sheet.isoOf, [2025, 0, 1], 3],
  ["parseDelim", sheet.parseDelim, ["a\tb\nc"], 1],
  ["toDelim", sheet.toDelim, [[["a", "b"]], "\t"], 2],
  ["parseSheetLine", sheet.parseSheetLine, ["A1 = 2"], 1],
  ["sheetToMd", sheet.sheetToMd, [sheet.buildSheetCard("t")], 1],
  ["cellName", sheet.cellName, [0, 0], 2],
  ["buildSheetCard", sheet.buildSheetCard, ["t"], 1],
  // slices — markdown surgery on hostile strings
  ["sectionRange", slices.sectionRange, ["# a\nx", "a"], 2],
  ["sliceSection", slices.sliceSection, ["# a\nx", "a"], 2],
  ["sliceBlock", slices.sliceBlock, ["> [!todo] t\nx", "id"], 2],
  ["spliceSection", slices.spliceSection, ["# a\nx", "a", "new"], 3],
  ["spliceBlock", slices.spliceBlock, ["> [!todo] t\nx", "id", "new"], 3],
  // slides
  ["emptySlide", slides.emptySlide, ["title"], 1],
  ["parseSlideHead", slides.parseSlideHead, ["## s | title"], 1],
  ["parseSlideLine", slides.parseSlideLine, ["- b", slides.emptySlide("title")], 2],
  ["parseDeck", slides.parseDeck, [["deck t", "## s", "- b"]], 1],
  ["deckToMd", slides.deckToMd, [slides.buildDeckCard("t")], 1],
  ["slideFromDom", slides.slideFromDom, [put("<div class='slide'></div>")], 1],
  ["slideHtml", slides.slideHtml, [slides.emptySlide("title"), 0], 2],
  ["buildDeckCard", slides.buildDeckCard, ["t"], 1],
  // todo
  ["parseWhen", todo.parseWhen, ["today"], 1],
  ["whenLabel", todo.whenLabel, ["2025-01-01"], 1],
  ["parseTodoLine", todo.parseTodoLine, ["- [ ] x @today"], 1],
  ["parseTodo", todo.parseTodo, [["todo t", "- [ ] x"]], 1],
  ["todoToMd", todo.todoToMd, [todo.buildTodoCard("t")], 1],
  ["buildTodoCard", todo.buildTodoCard, ["t"], 1],
  // wikictx
  ["matchWikiCtx", wikictx.matchWikiCtx, ["a [[b", 5], 2],
  ["splitWikiQuery", wikictx.splitWikiQuery, ["head#sec"], 1],
];

section("fuzz — exported fns, per-arg matrix");
for (const [name, fn, good, n] of FNS) {
  if (typeof fn !== "function") { console.log(`  (skip ${name} — not a fn)`); continue; }
  record(`${name}(good)`, () => fn(...good));
  for (let a = 0; a < n; a++)
    for (const b of BAD) {
      const args = good.slice(); args[a] = b;
      record(`${name}(arg${a}=${describe(b)})`, () => fn(...args));
    }
  // all-bad call
  record(`${name}(all-bad)`, () => fn(...good.map(() => BAD[0])));
}
/* ---------- api verb matrix ---------- */
section("fuzz — api verbs, per-arg matrix");
const WIDGETS = {
  sheet: { mk: () => sheet.buildSheetCard("s"), wire: sheet.wireSheet, api: sheet.sheetApi,
    verbs: {
      set: [0, 0, "v"], setCells: [[[0, 0, "v"]]], setAll: [[["a", "b"]]], addRow: [["a"]],
      addCol: [], delRow: [0], delCol: [0], clear: [], read: [], raw: [], display: [0, 0],
      rows: [], cols: [], title: [], setFmt: [0, 0, "b"], addCf: ["A1", "x"], clearCf: [],
      freeze: [0, 0], hideRow: [0], hideCol: [0], unhide: [], dedupe: [0], filter: ["x"],
    } },
  deck: { mk: () => slides.buildDeckCard("d"), wire: slides.wireDeck, api: slides.deckApi,
    verbs: {
      addSlide: ["title"], delSlide: [0], moveSlide: [0, 0], setLayout: [0, "title"],
      setSlide: [0, { title: "x" }], appendBullet: [0, "x"], setTheme: ["dark"],
      setTransition: ["fade"], setBg: [0, "#fff"], setNote: [0, "n"], duplicate: [0],
      title: [], count: [], read: [],
    } },
  todo: { mk: () => todo.buildTodoCard("t"), wire: todo.wireTodo, api: todo.todoApi,
    verbs: { title: [], items: [], list: [], add: ["x", "today"], setDone: [0, true], del: [0], clearDone: [] } },
  cards: { mk: () => cards.buildCardsCard("c"), wire: cards.wireCards, api: cards.cardsApi,
    verbs: { cards: [], add: ["f", "b"], del: ["f"], due: [], rate: ["f", 2], list: [] } },
  map: { mk: () => map.buildMapCard("m"), wire: map.wireMap, api: map.mapApi,
    verbs: { title: [], add: [["- a"]], del: ["a"], rename: ["a", "b"], list: [] } },
  chart: { mk: () => chart.buildChartCard("ch"), wire: chart.wireChart, api: chart.chartApi,
    verbs: { title: [], read: [], setType: ["bar"], setRows: [[["a", 1]]], setSource: ["A1:B2"], clearSource: [], exportPng: [] } },
  browser: { mk: () => browser.buildBrowserCard("b", ""), wire: browser.wireBrowser, api: browser.browserApi,
    verbs: { url: [], title: [], navigate: ["x"], back: [], forward: [], read: [], mode: [], clip: [false], bookmark: [] } },
};
for (const [kind, wdef] of Object.entries(WIDGETS)) {
  const card = wdef.mk(); document.body.appendChild(card); wdef.wire(card);
  const api = wdef.api(card);
  if (!api) { console.log(`  (no api for ${kind})`); continue; }
  for (const [verb, good] of Object.entries(wdef.verbs)) {
    if (typeof api[verb] !== "function") { record(`${kind}.${verb}`, () => { throw new Error("missing verb"); }); continue; }
    record(`${kind}.${verb}(good)`, () => api[verb](...good));
    for (let a = 0; a < good.length; a++)
      for (const b of BAD) {
        const args = good.slice(); args[a] = b;
        record(`${kind}.${verb}(arg${a}=${describe(b)})`, () => api[verb](...args));
      }
    record(`${kind}.${verb}(all-bad)`, () => api[verb](...good.map(() => BAD[0])));
    await tick();
  }
  card.remove();
}

/* ---------- random op sequences ---------- */
section("fuzz — random op sequences per widget");
const ri = (n) => Math.floor(Math.random() * n);
const rval = () => ["x", "12", "=A1+1", "", "💣", "=B2*Z9", "-3.5"][ri(7)];
const SEQ = {
  sheet: {
    mk: () => { const c = sheet.buildSheetCard("sq"); document.body.appendChild(c); sheet.wireSheet(c); return c; },
    api: sheet.sheetApi,
    ops: [
      (a) => a.set(ri(12), ri(6), rval()), (a) => a.addRow([rval(), rval()]), (a) => a.addCol(),
      (a) => a.delRow(ri(12)), (a) => a.delCol(ri(6)), (a) => a.setCells([[ri(8), ri(5), rval()]]),
      (a) => a.dedupe(ri(4)), (a) => a.hideRow(ri(10)), (a) => a.hideCol(ri(5)), (a) => a.unhide(),
      (a) => a.clear(), (a) => a.filter(rval()), (a) => a.setFmt(ri(5), ri(4), "b"),
      (a) => a.freeze(ri(3), ri(3)), (a) => a.addCf("A1", rval()), (a) => a.clearCf(),
    ],
  },
  deck: {
    mk: () => { const c = slides.buildDeckCard("sq"); document.body.appendChild(c); slides.wireDeck(c); return c; },
    api: slides.deckApi,
    ops: [
      (a) => a.addSlide(["title", "bullets", "quote", "twocol", "image", "bigfact", "chart", "blank"][ri(8)]),
      (a) => a.delSlide(ri(8)), (a) => a.moveSlide(ri(8), ri(8)), (a) => a.duplicate(ri(8)),
      (a) => a.appendBullet(ri(8), rval()), (a) => a.setNote(ri(8), rval()),
      (a) => a.setBg(ri(8), "#12" + ri(9)), (a) => a.setTheme(["dark", "light", "sepia"][ri(3)]),
      (a) => a.setTransition(["none", "fade", "slide"][ri(3)]),
      (a) => a.setLayout(ri(8), ["title", "bullets", "quote"][ri(3)]),
    ],
  },
  todo: {
    mk: () => { const c = todo.buildTodoCard("sq"); document.body.appendChild(c); todo.wireTodo(c); return c; },
    api: todo.todoApi,
    ops: [
      (a) => a.add(rval(), ["today", "tomorrow", "", "2025-13-40"][ri(4)]),
      (a) => a.setDone(ri(15), ri(2) === 0), (a) => a.del(ri(15)), (a) => a.clearDone(),
    ],
  },
  cards: {
    mk: () => { const c = cards.buildCardsCard("sq"); document.body.appendChild(c); cards.wireCards(c); return c; },
    api: cards.cardsApi,
    ops: [
      (a) => a.add(rval(), rval()), (a) => a.del(rval()), (a) => a.rate(rval(), ri(5)), (a) => a.due(),
    ],
  },
  map: {
    mk: () => { const c = map.buildMapCard("sq"); document.body.appendChild(c); map.wireMap(c); return c; },
    api: map.mapApi,
    ops: [
      (a) => a.add([["- x", "  - y"], ["- z"], ["bad indent          - deep"]][ri(3)]),
      (a) => a.del(rval()), (a) => a.rename(rval(), rval()),
    ],
  },
  chart: {
    mk: () => { const c = chart.buildChartCard("sq"); document.body.appendChild(c); chart.wireChart(c); return c; },
    api: chart.chartApi,
    ops: [
      (a) => a.setType(["bar", "line", "pie", "doughnut", "radar", "polarArea", "scatter", "bubble", "junk"][ri(9)]),
      (a) => a.setRows([[[rval(), ri(99)], [rval(), ri(99)]], [], [[undefined, NaN]], "x"][ri(4)]),
      (a) => a.setSource(rval()), (a) => a.clearSource(),
    ],
  },
  browser: {
    mk: () => { const c = browser.buildBrowserCard("sq", ""); document.body.appendChild(c); browser.wireBrowser(c); return c; },
    api: browser.browserApi,
    ops: [
      (a) => a.navigate([rval(), "example.com", "https://x.y/z", ""][ri(4)]),
      (a) => a.back(), (a) => a.forward(), (a) => a.bookmark(), (a) => a.clip(ri(2) === 0),
    ],
  },
};
for (const [kind, s] of Object.entries(SEQ)) {
  for (let round = 0; round < 4; round++) {
    const card = s.mk();
    const api = s.api(card);
    for (let step = 0; step < 60; step++) {
      const op = s.ops[ri(s.ops.length)];
      record(`${kind}.seq.r${round}.s${step}(${op.toString().slice(0, 40)})`, () => op(api));
      // every 7th step: serialize + rewire round-trip mid-chaos
      if (step % 7 === 6) {
        record(`${kind}.seq.r${round}.md`, () => cardToMd(card));
        const md = cardToMd(card);
        if (md && LEAKY.test(md)) leaks.push(`${kind}.seq.r${round}.md → …${md.slice(md.search(LEAKY) - 40, md.search(LEAKY) + 40)}`);
      }
      await tick();
    }
    // final serialize + full rewire
    record(`${kind}.seq.r${round}.final-md`, () => cardToMd(card));
    const md = cardToMd(card);
    if (md) {
      const reborn = renderCalloutMd(md);
      record(`${kind}.seq.r${round}.reborn`, () => {
        if (!reborn?.dataset?.kind) throw new Error("md did not re-render to a card");
      });
      if (reborn?.dataset?.kind) {
        document.body.appendChild(reborn);
        record(`${kind}.seq.r${round}.rewire`, () => s.api(reborn));
        reborn.remove();
      }
    }
    card.remove();
  }
}

/* ---------- dataset corruption ---------- */
section("fuzz — hostile dataset values → verbs + serialize");
const DS_BAD = ["undefined", "null", "NaN", "{}", "[]", "\u0000x", "<img>", "💣".repeat(300), "a".repeat(4000), " "];
for (const [kind, wdef] of Object.entries(WIDGETS)) {
  const card = wdef.mk(); document.body.appendChild(card); wdef.wire(card);
  const keys = Object.keys(card.dataset);
  for (const k of keys) {
    for (const bad of DS_BAD) {
      card.dataset[k] = bad;
      record(`${kind}.dataset.${k}=${bad.slice(0, 12)} + verbs`, () => {
        const api = wdef.api(card);
        if (!api) return;
        for (const [verb, good] of Object.entries(wdef.verbs))
          if (typeof api[verb] === "function") api[verb](...good);
      });
      record(`${kind}.dataset.${k}=${bad.slice(0, 12)} + md`, () => cardToMd(card));
    }
  }
  card.remove();
}

/* ---------- report ---------- */
await Promise.all(pending);
let bugs = 0;
console.log(`\n${clean} clean`);
console.log(`\n=== UNIQUE CRASH SITES (${crashMap.size}) ===`);
for (const [site, list] of crashMap) {
  bugs++;
  console.log(`  ${site}  ×${list.length}`);
  list.slice(0, 3).forEach((l) => console.log(`      ${l}`));
}
if (leaks.length) {
  console.log(`\n=== LEAKS (${leaks.length}) ===`);
  leaks.slice(0, 40).forEach((l) => console.log("  " + l));
  bugs += leaks.length;
}
console.log(`\n≈ ${bugs} unique fix sites`);
process.exit(crashMap.size || leaks.length ? 1 : 0);
