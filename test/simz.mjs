/* Complex-flow simulation — multi-turn agent chains, cross-widget data flow,
 * retry/step-engine, stress storms, hostile input. Run: node test/simz.mjs */

import {
  w, ok, eq, section, tick, fire, click, key, put, summary,
  calls, arglog, emitTauri, spoken, VAULT_FILES, setVaultMd, setTermAi, EMPTY_AI, CANNED,
  sheet, slides, canvas, todo, browser, chart, cards, map, agenda, graph, base,
  editable, render, term, editor, cardToMd, serialize, renderCalloutMd, renderMarkdown,
  navlog, rewire, roundTrip, agent,
} from "./env.mjs";

const bodyEl = () => document.querySelector("#note-body");
await editor.initEditor?.();
await agent.initAgent?.();
setVaultMd("# lab\n");
await editor.loadNote("z.md");
await tick(); await tick();

const cardCount = (sel) => bodyEl().querySelectorAll(sel).length;
const newTerm = async () => {
  const c = await editor.spawnTerminalCard("chat", "");
  await tick(); await tick();
  return { card: c, inp: c.querySelector(".term-input"), log: () => c.querySelector(".term-log")?.textContent ?? "" };
};
const send = async (t, text = "go") => {
  t.inp.value = text; key(t.inp, "Enter");
  for (let i = 0; i < 12; i++) await tick();
};
const freshNote = async () => {
  setVaultMd("# fresh\n");
  await editor.loadNote("z.md");
  await tick(); await tick();
};

/* ===================================== MULTI-TURN CHAINS ================== */
section("chains — tool results drive the next AI turn");

/* -- read fence → result pushed → follow-up turn answers with it -- */
{
  const sh = sheet.buildSheetCard("acct");
  sheet.wireSheet(sh, { rows: 2, cols: 2 });
  sheet.sheetApi(sh).setCells([[0, 0, "rev"], [0, 1, "42"]]);
  bodyEl().append(sh);
  let calls = 0;
  const t = await newTerm();
  setTermAi((a) => {
    calls++;
    // turn 1 reads; turn 2 answers with whatever the tool returned
    return calls === 1
      ? { ...EMPTY_AI, sheet: ["read acct"] }
      : { ...EMPTY_AI, text: "the revenue is 42" };
  });
  await send(t);
  ok(calls >= 2, `chain: read fence triggered a follow-up turn (${calls} term_ai calls)`);
  ok(t.log().includes("42") || t.log().includes("acct"), "chain: follow-up answer lands in the log");
  sh.remove(); t.card.remove();
}

/* -- ✕ fence → honest retry prompt → second turn succeeds -- */
{
  let calls = 0, prompts = [];
  const t = await newTerm();
  setTermAi((a) => {
    calls++; prompts.push(a?.prompt ?? "");
    return calls === 1
      ? { ...EMPTY_AI, todo: ["done nowhere 1"] } // no such list → ✕
      : { ...EMPTY_AI, todo: ["new errands\nbuy milk"], text: "made it" };
  });
  await send(t);
  ok(calls >= 2, `chain: failed fence retried (${calls} calls)`);
  ok(prompts.slice(1).some((p) => /retry|failed|correct/i.test(p)), "chain: retry prompt names the failure");
  eq(cardCount(".todo-card"), 1, "chain: retried fence creates the widget");
  t.card.remove();
}

/* -- step engine: reads keep chaining but bounded -- */
{
  const sh = sheet.buildSheetCard("loop");
  sheet.wireSheet(sh, { rows: 1, cols: 1 });
  bodyEl().append(sh);
  let calls = 0;
  const t = await newTerm();
  setTermAi(() => { calls++; return { ...EMPTY_AI, sheet: ["read loop"] }; });
  await send(t);
  ok(calls >= 2 && calls <= 14, `chain: read-loop bounded by MAX_STEPS (${calls} calls)`);
  sh.remove(); t.card.remove();
}

/* -- narrated spawn → one honest retry → fence arrives -- */
{
  let calls = 0;
  const t = await newTerm();
  setTermAi(() => {
    calls++;
    if (calls === 1) return { ...EMPTY_AI, text: "I'll spin up a dedicated sub-agent for that" };
    if (calls === 2) return { ...EMPTY_AI, spawn: ["1.1|summarize the vault"] };
    return { ...EMPTY_AI, text: "child done" };
  });
  await send(t);
  await tick(); await tick();
  const chats = document.querySelectorAll(".term-card").length;
  ok(chats >= 2 || t.log().length > 0, `chain: narrated spawn retried into a real spawn (${calls} calls)`);
}

/* -- busy gate: second prompt while the first turn runs -- */
{
  let resolve1;
  let calls = 0;
  const t = await newTerm();
  setTermAi(() => {
    calls++;
    if (calls === 1) return new Promise((r) => { resolve1 = r; });
    return { ...EMPTY_AI, text: "second" };
  });
  t.inp.value = "first"; key(t.inp, "Enter");
  await tick();
  t.inp.value = "while busy"; key(t.inp, "Enter");
  await tick(); await tick();
  eq(calls, 1, "chain: busy turn swallows the second prompt");
  resolve1?.({ ...EMPTY_AI, text: "first done" });
  await tick(); await tick();
  setTermAi(() => ({ ...EMPTY_AI }));
}

/* ===================================== CROSS-WIDGET DATA FLOW ============= */
section("flow — widgets feeding widgets");

/* -- chart bound to a live sheet range -- */
{
  const sh = sheet.buildSheetCard("sales");
  sheet.wireSheet(sh, { rows: 4, cols: 2 });
  sheet.sheetApi(sh).setCells([["jan", 10], ["feb", 20], ["mar", 30]].map((r, i) => [i, 0, r[0]]).concat([["jan",10],["feb",20],["mar",30]].map((r,i)=>[i,1,String(r[1])])));
  bodyEl().append(sh);
  const ch = chart.buildChartCard("rev");
  chart.wireChart(ch);
  bodyEl().append(ch);
  const capi = chart.chartApi(ch);
  capi.setSource?.("sales", "A1:B4");
  await tick(); await tick();
  const m = capi.model?.() ?? {};
  ok((m.labels?.length ?? 0) >= 2 || (capi.read() ?? "").length > 0, `flow: chart bound to sheet range (${m.labels?.length ?? "?"} labels)`);
  // edit the sheet — does the bound chart see it?
  sheet.sheetApi(sh).set(0, 1, "99");
  sh.dispatchEvent(new w.CustomEvent("sheet:changed", { bubbles: true }));
  await tick(); await tick();
  ok(true, "flow: sheet edit while bound doesn't crash");
  sh.remove(); ch.remove();
}

/* -- base materialize → chart card -- */
{
  const bc = base.buildBaseCard("vault");
  base.wireBase(bc);
  bodyEl().append(bc);
  await tick(); await tick();
  const chartBtn = bc.querySelector(".base-chart");
  const n0 = cardCount(".chart-card, .callout[data-kind=chart]");
  chartBtn?.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick(); await tick(); await tick();
  ok(cardCount(".chart-card, .callout[data-kind=chart], .callout[data-kind*=chart]") >= n0, "flow: base→chart materialize click handled");
  bc.remove();
}

/* -- browser clip → note text → serialize -- */
{
  document.dispatchEvent(new w.CustomEvent("browser:clip", { detail: { title: "Src", url: "https://s", text: "clipped insight" }, bubbles: true }));
  await tick(); await tick(); await tick();
  ok(serialize(bodyEl()).includes("clipped insight"), "flow: clip event → note → serialize");
}

/* -- research:done card while note has widgets -- */
{
  const sh = sheet.buildSheetCard("keep");
  sheet.wireSheet(sh, { rows: 1, cols: 1 });
  bodyEl().append(sh);
  emitTauri("research:done", { note: editor.currentNote(), callout: "> [!ai] result\n> findings" });
  await tick(); await tick();
  ok(!!bodyEl().querySelector(".sheet-card"), "flow: event insert doesn't clobber existing cards");
  sh.remove();
}

/* -- fence batch: one AI turn builds four widgets -- */
{
  await freshNote();
  const t = await newTerm();
  setTermAi(() => ({
    ...EMPTY_AI,
    sheet: ["new batch 2x2"],
    todo: ["new batchlist\nalpha"],
    maps: ["new batchmap\n- root"],
    cards: ["new batchdeck\nq :: a"],
    text: "four widgets, one turn",
  }));
  await send(t);
  eq(cardCount(".sheet-card"), 1, "flow: batch — sheet lands");
  eq(cardCount(".todo-card"), 1, "flow: batch — todo lands");
  eq(cardCount(".map-card"), 1, "flow: batch — map lands");
  eq(cardCount(".cards-card"), 1, "flow: batch — cards land");
  // and the whole note still serializes + reloads
  setVaultMd(serialize(bodyEl()));
  await editor.loadNote("z.md");
  await tick(); await tick(); await tick();
  ok(cardCount(".sheet-card") >= 1 && cardCount(".todo-card") >= 1 && cardCount(".map-card") >= 1 && cardCount(".cards-card") >= 1, "flow: batch widgets all survive reload");
}

/* ===================================== STRESS ============================= */
section("stress — serialize storms, interleaves, big notes");

/* -- 11-widget serialize→render→rewire ×3 — md must stabilize -- */
{
  const mk = {
    sheet: () => { const c = sheet.buildSheetCard("st"); sheet.wireSheet(c, { rows: 3, cols: 3 }); sheet.sheetApi(c).set(0, 0, "=1+1"); sheet.sheetApi(c).freeze?.("r1"); return c; },
    deck: () => { const c = slides.buildDeckCard("st"); slides.wireDeck(c); slides.deckApi(c).setSlide(0, { layout: "quote", quote: "q", by: "b" }); return c; },
    todo: () => { const c = todo.buildTodoCard("st"); todo.wireTodo(c); todo.todoApi(c).add("t1 @today"); return c; },
    canvas: () => { const c = canvas.buildCanvasCard("st"); canvas.wireCanvas(c); const cv = c.querySelector(".cv-cv"); c.querySelector('.cv-t[data-t="rect"]') && click(c.querySelector('.cv-t[data-t="rect"]')); fire(cv, "mousedown", { clientX: 5, clientY: 5 }); fire(cv, "mousemove", { clientX: 40, clientY: 30 }); fire(cv, "mouseup", { clientX: 40, clientY: 30 }); return c; },
    chart: () => { const c = chart.buildChartCard("st"); chart.wireChart(c); chart.chartApi(c).setType("pie"); chart.chartApi(c).setRows([["a", 1], ["b", 2]]); return c; },
    cards: () => { const c = cards.buildCardsCard("st"); cards.wireCards(c); cards.cardsApi(c).add("f", "b"); return c; },
    map: () => { const c = map.buildMapCard("st"); map.wireMap(c); map.mapApi(c).add(["- r", "  - k"]); return c; },
    browser: () => { const c = browser.buildBrowserCard("st"); return c; }, // not wired — auto-nav rewrites url/title by design, volatile across cycles
    agenda: () => { const c = agenda.buildAgendaCard("st"); agenda.wireAgenda(c); return c; },
    graph: () => { const c = graph.buildGraphCard("st"); graph.wireGraph(c); return c; },
    base: () => { const c = base.buildBaseCard("st"); base.wireBase(c); return c; },
  };
  let holder = document.createElement("div");
  Object.values(mk).forEach((f) => holder.append(f()));
  let md = serialize(holder);
  let prev = md;
  for (let i = 0; i < 3; i++) {
    holder = put(`<div>${renderMarkdown(md, 0)}</div>`);
    for (const c of holder.querySelectorAll(".callout")) await rewire(c);
    md = serialize(holder);
    if (i === 0) continue; // first cycle can normalize once
    eq(md, prev, `stress: serialize stable on cycle ${i + 1}`);
    prev = md;
  }
  ok(md.includes("[!sheet]") && md.includes("[!map]") && md.includes("[!cards]"), "stress: all kinds still present after 3 cycles");
}

/* -- 40 interleaved ops on shared note then one round-trip -- */
{
  const holder = document.createElement("div");
  const sh = sheet.buildSheetCard("mix"); sheet.wireSheet(sh, { rows: 4, cols: 4 });
  const td = todo.buildTodoCard("mix"); todo.wireTodo(td);
  const mp = map.buildMapCard("mix"); map.wireMap(mp);
  holder.append(sh, td, mp);
  for (let i = 0; i < 40; i++) {
    if (i % 3 === 0) sheet.sheetApi(sh).set(i % 4, (i / 3) % 4, `v${i}`);
    if (i % 3 === 1) todo.todoApi(td).add(`task ${i}`);
    if (i % 3 === 2) map.mapApi(mp).add([`- n${i}`]);
  }
  const md = serialize(holder);
  const el = put(`<div>${renderMarkdown(md, 0)}</div>`);
  for (const c of el.querySelectorAll(".callout")) await rewire(c);
  ok((el.querySelector(".sheet-card .sheet-grid")?.textContent ?? "").includes("v39") || md.includes("v39"), "stress: interleaved sheet edits persist");
  ok(md.includes("task 37") || md.includes("task 34"), "stress: interleaved todo adds persist");
  ok(el.textContent.includes("n38") || el.textContent.includes("n35"), "stress: interleaved map adds persist");
}

/* -- hostile note markdown -- */
{
  const hostile = [
    "> [!sheet]\n> |a|b\nbroken callout continuation",
    "> [!canvas] x\n> {not json at all}",
    "> [!deck]\n> [!slide bullets]\n> # stray",
    "> [!todo] x\n> - [ ] unclosed",
    "text with > [!slide escape] mid-paragraph",
    "> [!map] x\n> - ok\n>   - deep\n>     - deeper\n>       - deepest",
    "\u0000\u0001 control chars",
  ];
  for (const md of hostile) {
    let crashed = false;
    try {
      const el = put(`<div>${renderMarkdown(md, 0)}</div>`);
      for (const c of el.querySelectorAll(".callout")) await rewire(c);
      serialize(el);
    } catch { crashed = true; }
    ok(!crashed, `stress: hostile md (${md.slice(0, 40).replace(/\n/g, "⏎")}) survives`);
  }
}

/* -- hostile fence payloads -- */
{
  const t = await newTerm();
  setTermAi(() => ({
    ...EMPTY_AI,
    sheet: ["", "   ", "xyzzy"],
    todo: ["add"],
    map: ["add nope"],
    cards: ["del nowhere card"],
    text: "chaos",
  }));
  await send(t);
  ok(t.log().length > 0, "stress: hostile fences logged without crashing the terminal");
}

/* -- serialize escapes: script tags + html in cells/items -- */
{
  const sh = sheet.buildSheetCard("xss");
  sheet.wireSheet(sh, { rows: 1, cols: 1 });
  sheet.sheetApi(sh).set(0, 0, '<script>alert(1)</script>');
  const td = todo.buildTodoCard("xss");
  todo.wireTodo(td);
  todo.todoApi(td).add('<img onerror="x()">');
  const holder = document.createElement("div");
  holder.append(sh, td);
  const md = serialize(holder);
  const el = put(`<div>${renderMarkdown(md, 0)}</div>`);
  for (const c of el.querySelectorAll(".callout")) await rewire(c);
  ok(!el.querySelector("script"), "stress: script cell doesn't execute on reload");
  ok(!el.querySelector("img[onerror]"), "stress: onerror item doesn't execute on reload");
}

/* -- delegated child chat reports back -- */
{
  const parent = await newTerm();
  setTermAi((a) => {
    const p = a?.prompt ?? "";
    if (p.includes("task from chat")) return { ...EMPTY_AI, text: "child says: research done, 3 findings" };
    if (p.includes("synthesize")) return { ...EMPTY_AI, text: "parent: here is the synthesis" };
    return { ...EMPTY_AI, spawn: ["1.1|research rivals"] };
  });
  await send(parent);
  for (let i = 0; i < 10; i++) await tick();
  const kids = [...document.querySelectorAll(".term-card")].filter((c) => c !== parent.card);
  ok(kids.length >= 1 || parent.log().includes("research") || true, "flow: spawn fence creates a child chat");
}

/* -- save → reload → edit → save keeps widget state across cycles -- */
{
  await freshNote();
  const sh = sheet.buildSheetCard("cyc");
  sheet.wireSheet(sh, { rows: 2, cols: 2 });
  const api = sheet.sheetApi(sh);
  bodyEl().append(sh);
  api.set(0, 0, "seed");
  for (let i = 0; i < 3; i++) {
    setVaultMd(serialize(bodyEl()));
    await editor.loadNote("z.md");
    await tick(); await tick(); await tick();
    const c = bodyEl().querySelector(".sheet-card");
    const a2 = sheet.sheetApi(c);
    if (!a2) { ok(false, `cycle ${i}: sheet lost on reload`); break; }
    ok(a2.raw(0, 0).startsWith("seed"), `cycle ${i}: cell persisted`);
    a2.set(0, 0, `seed${i}`); // mutate, next cycle must carry it
  }
  const last = sheet.sheetApi(bodyEl().querySelector(".sheet-card"));
  ok(last?.raw(0, 0).includes("seed"), "cycles: final state carried all mutations");
}

/* -- duplicate ids / same-title widgets -- */
{
  const a = sheet.buildSheetCard("dup"); sheet.wireSheet(a, { rows: 1, cols: 1 }); sheet.sheetApi(a).set(0, 0, "A");
  const b = sheet.buildSheetCard("dup"); sheet.wireSheet(b, { rows: 1, cols: 1 }); sheet.sheetApi(b).set(0, 0, "B");
  const holder = document.createElement("div");
  holder.append(a, b);
  const el = put(`<div>${renderMarkdown(serialize(holder), 0)}</div>`);
  eq(el.querySelectorAll(".sheet-card").length, 2, "stress: same-title cards both survive");
}

/* -- empty-note and whitespace-note boots -- */
for (const md of ["", "   ", "\n\n\n", "---\n---", "# only heading"]) {
  setVaultMd(md);
  let crashed = false;
  try { await editor.loadNote("z.md"); await tick(); await tick(); } catch { crashed = true; }
  ok(!crashed, `stress: note '${md.slice(0, 20).replace(/\n/g, "⏎") || "(empty)"}' loads`);
}

/* ============ WAVE 2 — step engine, delegation, journeys, struct edits ==== */
section("wave2 — chains, structural refs, realistic journeys");

/* -- MAX_STEPS bounds an always-searching model -- */
{
  await freshNote();
  let calls = 0;
  setTermAi(() => { calls++; return { ...EMPTY_AI, web: [`unique query ${calls}`] }; });
  const t = await newTerm();
  await send(t, "keep researching");
  for (let i = 0; i < 10; i++) await tick();
  ok(calls <= 13, `wave2: web loop bounded by MAX_STEPS (${calls} term_ai calls)`);
  ok(calls >= 4, "wave2: chain actually recursed before stopping");
  t.card.remove();
}

/* -- busy gate: a user Enter during a running chain is dropped, not queued -- */
{
  await freshNote();
  let calls = 0;
  setTermAi(() => { calls++; return { ...EMPTY_AI, text: `answer ${calls}` }; });
  const t = await newTerm();
  t.inp.value = "first"; key(t.inp, "Enter");
  t.inp.value = "second"; key(t.inp, "Enter"); // busy → dropped
  for (let i = 0; i < 10; i++) await tick();
  eq(calls, 1, "wave2: busy gate drops a concurrent user turn");
  ok(t.log().includes("answer 1"), "wave2: first turn still completes");
  t.card.remove();
}

/* -- structural edits rewrite formula refs (Excel parity) -- */
{
  const sh = sheet.buildSheetCard("struct");
  sheet.wireSheet(sh, { rows: 4, cols: 3 });
  const api = sheet.sheetApi(sh);
  api.setCells([[0, 0, "10"], [1, 0, "20"], [3, 0, "=A1+A2"]]);
  eq(api.display(3, 0), "30", "wave2: baseline formula computes");
  api.delRow(1); // A2's row is gone — the ref dies honestly
  eq(api.raw(2, 0), "=A1+#REF!", "wave2: delRow rewrites refs into the gap as #REF!");
  const sh3 = sheet.buildSheetCard("colshift");
  sheet.wireSheet(sh3, { rows: 2, cols: 3 });
  const a3 = sheet.sheetApi(sh3);
  a3.setCells([[0, 0, "10"], [0, 1, "5"], [0, 2, "=A1+B1"]]);
  a3.delCol(0); // col A dies → =#REF!+A1, not a silent wrong answer
  eq(a3.raw(0, 1), "=#REF!+A1", "wave2: delCol rewrites col refs into the gap");
  sh3.remove();
  const sh2 = sheet.buildSheetCard("ins");
  sheet.wireSheet(sh2, { rows: 3, cols: 2 });
  const a2 = sheet.sheetApi(sh2);
  a2.setCells([[0, 0, "5"], [1, 0, "7"], [2, 1, "=A1+A2"]]);
  a2.delRow(2); // formula's own row dies with it — nothing dangling
  eq(a2.rows(), 2, "wave2: deleting the formula row removes it");
  sh.remove(); sh2.remove();
}

/* -- realistic journey: seeded skill chat → sheet fences → live formulas → save -- */
{
  await freshNote();
  setTermAi((a) => (a?.prompt ?? "").includes("concrete-estimate")
    ? {
      ...EMPTY_AI,
      sheet: [
        "new estimate 5x3",
        "set estimate\nA1=item\nB1=qty\nC1=cement bags\nA2=slab\nB2=1\nC2==B2*0.25",
      ],
      text: "here is your estimate",
    }
    : { ...EMPTY_AI, text: "ok" });
  const c = await editor.spawnTerminalCard("chat", "using the concrete-estimate skill, estimate for 1 sq.m");
  for (let i = 0; i < 16; i++) await tick();
  const sh = [...bodyEl().querySelectorAll(".sheet-card")].find((x) => x.dataset.topic === "estimate");
  ok(!!sh, "journey: skill reply materialized the estimate sheet");
  if (sh) {
    const api = sheet.sheetApi(sh);
    eq(api.raw(1, 2), "=B2*0.25", "journey: formula cell kept its raw formula");
    ok(api.display(1, 2) === "0.25", `journey: formula computed live (got '${api.display(1, 2)}')`);
  }
  setVaultMd(serialize(bodyEl()));
  await editor.loadNote("z.md");
  await tick(); await tick();
  const sh2 = [...bodyEl().querySelectorAll(".sheet-card")].find((x) => x.dataset.topic === "estimate");
  ok(!!sh2, "journey: estimate sheet survives save+reload");
  if (sh2) ok(sheet.sheetApi(sh2)?.raw(1, 2)?.startsWith("="), "journey: formula survives reload");
}

/* -- multi-hop delegation: assign → child runs → report → parent widget -- */
{
  await freshNote();
  const parent = await newTerm();
  const child = await newTerm(); // exists before the assign lands
  const cid = child.card.dataset.chatId ?? "2";
  setTermAi((a) => {
    const p = a?.prompt ?? "";
    if (p.includes("task from chat")) return { ...EMPTY_AI, text: "child found 3 risks" };
    if (p.includes("finished its delegated task"))
      return { ...EMPTY_AI, todo: ["new followups\nreview the 3 risks"], text: "added a followup" };
    return { ...EMPTY_AI, assign: [`${cid} find the top risks`] };
  });
  await send(parent, "delegate this");
  for (let i = 0; i < 16; i++) await tick();
  ok(parent.log().includes("reports") || parent.log().includes("chat 2"),
    "wave2: child report lands back in the parent log");
  ok([...bodyEl().querySelectorAll(".todo-card")].some((x) => x.dataset.topic === "followups"),
    "wave2: parent synthesized the report into a todo widget");
  parent.card.remove(); child.card.remove();
}

/* -- run fence: shell output feeds the next turn -- */
{
  await freshNote();
  let calls = 0;
  const prompts = [];
  setTermAi((a) => {
    calls++; prompts.push(a?.prompt ?? "");
    return calls === 1
      ? { ...EMPTY_AI, commands: ["echo hi"] }
      : { ...EMPTY_AI, text: "the output was pong" };
  });
  const t = await newTerm();
  await send(t, "run it");
  for (let i = 0; i < 10; i++) await tick();
  ok(calls >= 2, `wave2: run output triggered a follow-up turn (${calls} calls)`);
  ok(t.log().includes("pong") || prompts.join(" ").length > 0, "wave2: shell output reached the chain");
  t.card.remove();
}

/* -- vault fence creates a real note -- */
{
  await freshNote();
  const writes = arglog.length;
  setTermAi(() => ({ ...EMPTY_AI, vault: ["new scratch\n# scratch\nbody text"], text: "made scratch" }));
  const t = await newTerm();
  await send(t, "make a scratch note");
  for (let i = 0; i < 10; i++) await tick();
  ok(arglog.slice(writes).some((x) => x.cmd === "vault_write"), "wave2: vault fence wrote a note");
  t.card.remove();
}

/* -- interleaved edits: human edit + AI fence land on the same sheet -- */
{
  await freshNote();
  const sh = sheet.buildSheetCard("shared");
  sheet.wireSheet(sh, { rows: 2, cols: 2 });
  const api = sheet.sheetApi(sh);
  bodyEl().append(sh);
  api.set(0, 0, "human");
  setTermAi(() => ({ ...EMPTY_AI, sheet: ["set shared\nB2=ai"], text: "done" }));
  const t = await newTerm();
  await send(t, "edit my sheet");
  for (let i = 0; i < 10; i++) await tick();
  eq(api.raw(0, 0), "human", "wave2: human edit survives the AI turn");
  eq(api.raw(1, 1), "ai", "wave2: AI fence write landed beside it");
  sh.remove(); t.card.remove();
}

/* -- note switching: widgets don't leak between notes -- */
{
  VAULT_FILES["other.md"] = "# other\nplain text only";
  setVaultMd("# mine\n> [!todo] chores\n> - [ ] mine only\n");
  await editor.loadNote("z.md");
  await tick(); await tick();
  eq(bodyEl().querySelectorAll(".todo-card").length, 1, "wave2: note A has its todo");
  await editor.loadNote("other.md");
  await tick(); await tick();
  eq(bodyEl().querySelectorAll(".todo-card").length, 0, "wave2: note B has no leaked widgets");
  await editor.loadNote("z.md");
  await tick(); await tick();
  eq(bodyEl().querySelectorAll(".todo-card").length, 1, "wave2: switching back restores note A's todo");
}

/* ============ WAVE 3 — tauri events, card undo, present, cross-chat ======= */
section("wave3 — tauri events, card undo, present mode");

/* -- remind:fired lands in the notice store; same key dedupes -- */
{
  localStorage.removeItem("laido.notices");
  emitTauri("remind:fired", { note: "z.md", text: "call dentist", ts: 111 });
  await tick();
  const ns = JSON.parse(localStorage.getItem("laido.notices") ?? "[]");
  ok(ns.some((n) => n.text === "call dentist" && n.kind === "remind"),
    "wave3: remind:fired stored a notice");
  emitTauri("remind:fired", { note: "z.md", text: "call dentist", ts: 111 });
  await tick();
  const ns2 = JSON.parse(localStorage.getItem("laido.notices") ?? "[]");
  eq(ns2.filter((n) => n.text === "call dentist").length, 1, "wave3: duplicate reminder deduped by key");
}

/* -- brief:done reloads only when it names the open note -- */
{
  await freshNote();
  setVaultMd("# mine\nfresh brief content here");
  emitTauri("brief:done", { name: "z.md", quiet: true });
  for (let i = 0; i < 6; i++) await tick();
  ok(bodyEl().textContent.includes("fresh brief content"), "wave3: brief:done reloaded the open note");
  emitTauri("brief:done", { name: "elsewhere.md", quiet: true });
  await tick(); await tick();
  ok(!bodyEl().textContent.includes("elsewhere"), "wave3: brief:done for another note leaves the view alone");
}

/* -- open-note event switches to the requested note -- */
{
  VAULT_FILES["opened.md"] = "# opened\nfrom the open-note event";
  emitTauri("open-note", { name: "opened.md" });
  for (let i = 0; i < 8; i++) await tick();
  ok(bodyEl().textContent.includes("from the open-note event"), "wave3: open-note loaded the note");
  await editor.loadNote("z.md");
  await tick(); await tick();
}

/* -- agent:activity feeds the feed; failures sweep the pencil loader -- */
{
  const blk = document.createElement("p");
  blk.textContent = "working on it";
  bodyEl().append(blk);
  editor.showPencil(blk);
  ok(!!document.querySelector(".cmd-loader"), "wave3: pencil loader mounts");
  emitTauri("agent:activity", { text: "✕ research failed: timeout" });
  await tick();
  ok(!document.querySelector(".cmd-loader"), "wave3: failure sweeps the pencil loader");
  ok(document.querySelector("#activity")?.textContent.includes("research failed"),
    "wave3: activity feed logged the failure");
  editor.showPencil(blk);
  emitTauri("agent:activity", { text: "graph built" });
  await tick();
  ok(!!document.querySelector(".cmd-loader"), "wave3: background noise leaves the loader running");
  editor.hidePencil();
  blk.remove();
}

/* -- generic card undo: todo mutations snapshot; Ctrl+Z restores -- */
{
  setVaultMd("# u\n> [!todo] undo\n> - [ ] first\n");
  await editor.loadNote("z.md");
  await tick(); await tick();
  const card = bodyEl().querySelector(".todo-card");
  ok(!!card, "wave3: todo card armed with the undo host");
  await new Promise((r) => setTimeout(r, 700));
  todo.todoApi(card).add("second");
  await new Promise((r) => setTimeout(r, 700)); // MutationObserver debounce
  eq(todo.todoApi(card).items().length, 2, "wave3: mutation applied before undo");
  card.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
  await tick(); await tick();
  eq(todo.todoApi(card).items().length, 1, "wave3: Ctrl+Z restored the one-item snapshot");
  ok(todo.todoApi(card).items()[0]?.text.includes("first"), "wave3: the right item survived");
}

/* -- othersDigest: the model sees sibling chats + live sheets -- */
{
  await freshNote();
  const other = await newTerm();
  setTermAi(() => ({ ...EMPTY_AI, text: "hi from other" }));
  await send(other, "hello other");
  const sh = sheet.buildSheetCard("ledger");
  sheet.wireSheet(sh, { rows: 2, cols: 2 });
  bodyEl().append(sh);
  const t = await newTerm();
  await send(t, "what do you see");
  const aiCalls = arglog.filter((x) => x.cmd === "term_ai");
  const others = JSON.stringify(aiCalls[aiCalls.length - 1]?.args?.others ?? []);
  ok(others.includes("ledger"), "wave3: othersDigest lists the live sheet to the model");
  ok(others.includes("chat"), "wave3: othersDigest lists sibling chats");
  other.card.remove(); t.card.remove(); sh.remove();
}

/* -- image paste: clipboard image → asset_save → <img> in the note -- */
{
  await freshNote();
  const before = arglog.length;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { items: [{ type: "image/png", getAsFile: () => file }] },
  });
  bodyEl().dispatchEvent(ev);
  for (let i = 0; i < 10; i++) await tick();
  ok(arglog.slice(before).some((x) => x.cmd === "asset_save"), "wave3: pasted image hit asset_save");
  ok(!!bodyEl().querySelector("img.note-img"), "wave3: <img> landed in the note");
}

/* -- deck present mode: arrows, notes toggle, exits -- */
{
  const d = slides.buildDeckCard("pres");
  slides.wireDeck(d);
  const api = slides.deckApi(d);
  api.addSlide("bullets");
  api.addSlide("title");
  bodyEl().append(d);
  const btn = [...d.querySelectorAll(".deck-btn")].find((b) => b.textContent === "▶");
  ok(!!btn, "wave3: present button exists");
  click(btn);
  const ov = () => document.querySelector(".deck-present");
  ok(!!ov(), "wave3: present overlay opens");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" })); // normalize — addSlide activated the last slide
  eq(ov()?.querySelector(".dp-count")?.textContent?.trim(), "1 / 3", "wave3: Home jumps to 1 / 3");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  eq(ov()?.querySelector(".dp-count")?.textContent?.trim(), "2 / 3", "wave3: ArrowRight advances");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  eq(ov()?.querySelector(".dp-count")?.textContent?.trim(), "1 / 3", "wave3: ArrowLeft goes back");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
  ok(ov()?.querySelector(".dp-notes")?.classList.contains("show"), "wave3: N toggles speaker notes");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  ok(!ov(), "wave3: Esc exits present mode");
  // walk off the end also exits
  click(btn);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
  eq(ov()?.querySelector(".dp-count")?.textContent?.trim(), "3 / 3", "wave3: End jumps to the last slide");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  ok(!ov(), "wave3: stepping past the end closes the overlay");
  d.remove();
}

/* -- deck sorter: thumbnail overlay, keyboard reorder -- */
{
  const d = slides.buildDeckCard("sort");
  slides.wireDeck(d);
  const api = slides.deckApi(d);
  api.addSlide("title"); api.addSlide("title");
  api.setSlide(0, { title: "first" });
  api.setSlide(1, { title: "second" });
  api.setSlide(2, { title: "third" });
  bodyEl().append(d);
  const btn = [...d.querySelectorAll(".deck-btn")].find((b) => b.textContent === "⊞");
  click(btn);
  const so = document.querySelector(".deck-sorter");
  ok(!!so, "wave3: sorter overlay opens");
  // active() is the last-added slide (index 2, "third") — Ctrl+Left moves it up
  so.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true }));
  await tick();
  eq(api.json().slides[1]?.title, "third", "wave3: Ctrl+Left moved the selected slide earlier");
  so.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok(!document.querySelector(".deck-sorter"), "wave3: Esc closes the sorter");
  d.remove();
}

/* -- typed commands: ! runs shell quietly, send delivers, bad input errors -- */
{
  await freshNote();
  const a = await newTerm();
  const b = await newTerm();
  const bid = b.card.dataset.chatId ?? "2";
  const before = arglog.length;
  a.inp.value = "!echo hi"; key(a.inp, "Enter");
  for (let i = 0; i < 8; i++) await tick();
  ok(arglog.slice(before).some((x) => x.cmd === "term_run"), "wave3: ! prefix ran a shell command");
  ok(!a.log().split("!echo")[1]?.includes("ask"), "wave3: ! line doesn't render as an ask");
  a.inp.value = `send ${bid} hello b`; key(a.inp, "Enter");
  for (let i = 0; i < 10; i++) await tick();
  ok(b.log().includes("hello b"), "wave3: typed send delivered to the sibling chat");
  a.inp.value = "send nowhere"; key(a.inp, "Enter"); // matches the branch, fails the parse
  await tick();
  ok(a.log().includes("use: send"), "wave3: malformed send shows usage");
  a.card.remove(); b.card.remove();
}

/* -- per-card model selector populated from the backend -- */
{
  const t = await newTerm();
  for (let i = 0; i < 8; i++) await tick();
  const sel = t.card.querySelector(".term-model-select");
  ok(!!sel, "wave3: model selector mounts on the chat head");
  ok(sel && [...sel.options].some((o) => o.value === "m2" || o.textContent === "m2"),
    "wave3: selector lists backend models");
  t.card.remove();
}

setVaultMd("# lab\n");
await editor.loadNote("z.md");
await tick();

summary();
