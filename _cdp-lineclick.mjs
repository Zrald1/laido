// click-to-caret on an old note: open My.laido (has a big pinned ai card),
// verify lines are reachable, click one, type — the word must land there.
const CDP = "http://localhost:9223/json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = async () => (await (await fetch(CDP)).json()).filter((t) => t.type === "page");
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  };
  const s = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => {
    const r = await Promise.race([
      s("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }),
      sleep(10000).then(() => ({ timeout: 1 })),
    ]);
    if (r.timeout) return "timeout";
    if (r.result?.exceptionDetails) return "EXC:" + (r.result.exceptionDetails.exception?.description ?? "").slice(0, 200);
    return r.result?.result?.value;
  };
  return { ws, s, ev };
}
const findMain = async () => {
  for (const p of (await pages()).filter((t) => t.url.includes("tauri.localhost"))) {
    const a = await attach(p);
    if ((await a.ev("window.__TAURI__.window.getCurrentWindow().label")) === "main") return a;
    a.ws.close();
  }
  return null;
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const main = await findMain();
if (!main) { console.log("no main"); process.exit(1); }

await main.ev(`document.dispatchEvent(new CustomEvent("nav:open",{detail:"My.laido"}));""`);
await sleep(3000);

// 1) coverage: what do hit-points land on?
const cov = await main.ev(`(()=>{const nb=document.getElementById("note-body");const r=nb.getBoundingClientRect();let card=0,text=0,other=0;
for(let gy=0.08;gy<1;gy+=0.07)for(let gx=0.08;gx<1;gx+=0.08){
const el=document.elementFromPoint(r.left+r.width*gx,r.top+r.height*gy);
if(!el)continue;
if(el.closest(".callout"))card++;
else if(el.closest("p,h1,h2,h3,li,blockquote"))text++;
else other++}
return{card,text,other}})()`);
check("text lines clickable", cov.text > 0, JSON.stringify(cov));

const floats = await main.ev(`[...document.querySelectorAll(".callout.floating")].map(c=>({k:c.dataset.kind,sized:c.classList.contains("sized"),w:Math.round(c.getBoundingClientRect().width),h:Math.round(c.getBoundingClientRect().height)}))`);
console.log("   floats:", JSON.stringify(floats));
const vh = await main.ev(`document.getElementById("note-body").clientHeight`);
const iw = await main.ev(`window.innerWidth`);
// sized (restored) floats must fit the paper viewport; auto-sized floats
// cap their body at 46vh and scroll internally — only their width can
// never exceed the window
check("restored cards fit viewport", floats.every((f) => (!f.sized || f.h <= vh) && f.w <= iw), `vh=${vh} iw=${iw}`);

// 2) click a text line — even an empty placeholder paragraph must take
//    a caret and accept typing (that's the user's exact complaint)
const target = await main.ev(`(()=>{const els=[...document.querySelectorAll("#note-body p,#note-body li,#note-body h1,#note-body h2,#note-body h3")].filter(e=>e.offsetParent&&!e.closest(".callout"));
const el=els[Math.min(2,els.length-1)];if(!el)return null;
const r=el.getBoundingClientRect();
// don't click under a floating card — find a point that hits the line itself
for(const fx of [0.2,0.5,0.8]){
const x=r.left+r.width*fx,y=r.top+r.height/2;
const hit=document.elementFromPoint(x,y);
if(hit&&(hit===el||el.contains(hit)))return{x,y,tag:el.tagName,idx:els.indexOf(el)}}
return{offscreen:true,tag:el.tagName}})()`);
check("text target found", !!target && !target.offscreen, JSON.stringify(target));
if (target && !target.offscreen) {
  await main.s("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await main.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
  await sleep(600);
  const sel = await main.ev(`(()=>{const s=getSelection();if(!s.rangeCount)return{none:1};const r=s.getRangeAt(0);const an=s.anchorNode;const el=an?.nodeType===1?an:an?.parentElement;return{collapsed:s.isCollapsed,inEl:el?.closest("p,li,h1,h2,h3")?.tagName||String(el?.tagName),onCard:!!el?.closest(".callout")}})()`);
  check("caret placed in text", sel.collapsed === true && !sel.onCard, JSON.stringify(sel));
  // type a marker word via real key events
  for (const ch of "ZZTOP") {
    await main.s("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
    await main.s("Input.dispatchKeyEvent", { type: "keyUp", text: ch, key: ch });
    await sleep(25);
  }
  await sleep(400);
  const has = await main.ev(`document.getElementById("note-body").innerText.includes("ZZTOP")`);
  check("typed word inserted", has === true);
  // undo the typing so the note isn't dirtied
  for (let i = 0; i < 5; i++) {
    await main.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
    await main.s("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
    await sleep(25);
  }
  await sleep(300);
}

// 3) click on empty paper BELOW content → caret lands at end (prior feature)
const nb = await main.ev(`(()=>{const el=document.getElementById("note-body");const r=el.getBoundingClientRect();return{x:r.left+r.width*0.5,y:Math.min(r.bottom-30,r.top+r.height*0.92)}})()`);
await main.s("Input.dispatchMouseEvent", { type: "mousePressed", x: nb.x, y: nb.y, button: "left", clickCount: 1 });
await main.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: nb.x, y: nb.y, button: "left", clickCount: 1 });
await sleep(600);
const sel2 = await main.ev(`(()=>{const s=getSelection();if(!s.rangeCount)return{none:1};const el=s.anchorNode?.nodeType===1?s.anchorNode:s.anchorNode?.parentElement;return{c:s.isCollapsed,onCard:!!el?.closest(".callout"),inNb:!!document.getElementById("note-body").contains(el)}})()`);
check("below-content click keeps caret in note", sel2.c === true && sel2.inNb === true, JSON.stringify(sel2));

const fails = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
