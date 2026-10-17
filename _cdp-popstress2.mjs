// real drag-out stress: activate a note, drag its tab out, wait for the
// child, close the child, reopen — repeat. The crash raced engine churn
// on main (park/reattach) against window spawn on the shared env.
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
      sleep(8000).then(() => ({ timeout: 1 })),
    ]);
    if (r.timeout) return "timeout";
    if (r.result?.exceptionDetails) return "EXC:" + (r.result.exceptionDetails.exception?.description ?? "").slice(0, 150);
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
const alive = async () => { try { await pages(); return true; } catch { return false; } };
const childLabels = async () => {
  const out = [];
  for (const p of (await pages()).filter((t) => t.url.includes("tauri.localhost"))) {
    const a = await attach(p);
    const lab = await a.ev("window.__TAURI__.window.getCurrentWindow().label");
    if (lab && lab !== "main") out.push(lab);
    a.ws.close();
  }
  return out;
};

const main = await findMain();
if (!main) { console.log("no main"); process.exit(1); }

for (let round = 1; round <= 10; round++) {
  const note = round % 2 ? "Instructions.laido" : "My.laido";
  await main.ev(`document.dispatchEvent(new CustomEvent("nav:open",{detail:"${note}"}));""`);
  await sleep(1400);
  const rect = await main.ev(`(()=>{const t=[...document.querySelectorAll("#tabs .tab")].find(t=>t.dataset.note==="${note}");if(!t)return null;const r=t.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  if (!rect) { console.log(`round ${round}: no tab for ${note}`); continue; }
  await main.s("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    await main.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + i * 110, y: rect.y + i * 24, button: "left" });
    await sleep(28);
  }
  await main.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + 1100, y: rect.y + 240, button: "left", clickCount: 1 });
  await sleep(2200);
  if (!(await alive())) { console.log(`ROUND ${round}: PROCESS DEAD after drag of ${note}`); process.exit(2); }
  const kids = await childLabels();
  console.log(`round ${round}: ${note} → children ${JSON.stringify(kids)}`);
  // close the popouts handle-side
  for (const lab of Array.isArray(kids) ? kids : []) {
    await main.ev(`(async()=>{const all=await window.__TAURI__.webviewWindow.getAllWebviewWindows();const w=all.find(w=>w.label==="${lab}");if(w){w.close();return 1}return 0})()`);
    await sleep(300);
    if (!(await alive())) { console.log(`ROUND ${round}: PROCESS DEAD closing ${lab}`); process.exit(2); }
  }
}
console.log("survived all real-drag rounds");
process.exit(0);
