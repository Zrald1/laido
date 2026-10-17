// pop a note holding a LIVE browser card — the engine must re-parent to
// the child window (native children can't move windows) and card
// commands must keep working there
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
      sleep(15000).then(() => ({ timeout: 1 })),
    ]);
    if (r.timeout) return "timeout";
    if (r.result?.exceptionDetails) return "EXC:" + (r.result.exceptionDetails.exception?.description ?? "").slice(0, 140);
    return r.result?.result?.value;
  };
  return { ws, s, ev };
}
const results = [];
const check = (n, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}${extra ? " — " + extra : ""}`); };

let main = null;
for (const c of (await pages()).filter((t) => t.title === "Laido" && t.url.includes("tauri.localhost"))) {
  const a = await attach(c);
  if ((await a.ev("window.__TAURI__.window.getCurrentWindow().label")) === "main") { main = a; break; }
  a.ws.close();
}
if (!main) { console.log("no main"); process.exit(1); }

// fresh test note + a real live browser card inside it
await main.ev(`window.__TAURI__.core.invoke("vault_write",{name:"popbrowser.laido",content:"# popbrowser\\n\\nbrowser note\\n"})`);
await main.ev(`document.dispatchEvent(new CustomEvent("nav:open",{detail:"popbrowser.laido"}));""`);
await sleep(2500);
const spawn = await main.ev(`import("./term.js").then(m=>m.runWidgetFence("browser","open https://example.com")).catch(e=>"ERR:"+String(e).slice(0,120))`);
check("browser card spawned", typeof spawn === "string" && spawn.startsWith("opened"), String(spawn).slice(0, 90));
await sleep(4000);
const bvMain = await main.ev(`(document.querySelector("[data-bv]")||{}).dataset?.bv||""`);
check("engine id on card", !!bvMain, bvMain);
const pvBefore = await main.ev(`window.__TAURI__.core.invoke("pv_list")`);
check("engine live in main", Array.isArray(pvBefore) && pvBefore.includes(bvMain), JSON.stringify(pvBefore));

// real drag of the tab out of the window
const rect = await main.ev(`(()=>{const t=[...document.querySelectorAll("#tabs .tab")].find(t=>t.dataset.note==="popbrowser.laido");if(!t)return null;const r=t.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
check("victim tab present", !!rect);
await main.s("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await main.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + i * 100, y: rect.y + i * 22, button: "left" });
  await sleep(30);
}
await main.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + 1200, y: rect.y + 260, button: "left", clickCount: 1 });

let child = null;
for (let i = 0; i < 25 && !child; i++) {
  await sleep(1500);
  for (const c of (await pages()).filter((t) => t.url.includes("tauri.localhost"))) {
    const a = await attach(c);
    const lab = await a.ev("window.__TAURI__.window.getCurrentWindow().label");
    if (typeof lab === "string" && lab.startsWith("note-")) { child = a; break; }
    a.ws.close();
  }
}
check("child window spawned", !!child);
if (child) {
  await sleep(5000);
  const ct = await child.ev(`[...document.querySelectorAll("#tabs .tab")].map(t=>t.dataset.note)`);
  check("child has the note", JSON.stringify(ct).includes("popbrowser"), JSON.stringify(ct));
  const bvChild = await child.ev(`(document.querySelector("[data-bv]")||{}).dataset?.bv||""`);
  check("browser card rendered in child", !!bvChild, bvChild);
  // the engine must exist AND belong to the child now — pv_url from the
  // child only answers when the engine is owned by the caller. The
  // reparent closes the main-owned engine and rebuilds it under the
  // child after the env-teardown gap (~11s) — poll through that window
  let url2 = "";
  for (let i = 0; i < 24; i++) {
    url2 = await child.ev(`window.__TAURI__.core.invoke("pv_url",{id:"${bvChild}"}).catch(e=>"ERR:"+String(e).slice(0,80))`);
    if (typeof url2 === "string" && !url2.startsWith("ERR") && url2.includes("example")) break;
    await sleep(1500);
  }
  check("engine owned by child (pv_url)", typeof url2 === "string" && !url2.startsWith("ERR") && url2.includes("example"), String(url2));
  // a command issued in the child: nav to example.org
  const navOut = await child.ev(`import("./term.js").then(m=>m.runWidgetFence("browser","open https://example.org")).catch(e=>"ERR:"+String(e).slice(0,100))`);
  check("browser command runs in child", typeof navOut === "string" && !navOut.startsWith("ERR") && !navOut.startsWith("✕"), String(navOut).slice(0, 90));
  await sleep(3500);
  // main's sweep must NOT have killed the child's engine
  const pvs = await main.ev(`window.__TAURI__.core.invoke("pv_list")`);
  check("child engine survives main sweep", Array.isArray(pvs) && pvs.length >= 1, JSON.stringify(pvs));
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
