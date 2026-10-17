// real drag-out test: grab a tab, drag beyond the window edge, verify a
// note-* window spawns WITH the note loaded, and main loses the tab.
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
const label = async (pg) => {
  const { ev } = await attach(pg);
  return ev("window.__TAURI__.window.getCurrentWindow().label");
};
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
if (!main) { console.log("no main window"); process.exit(1); }

// make sure a victim note is open
await main.ev(`document.dispatchEvent(new CustomEvent("nav:open",{detail:"untitled-48.laido"}));""`);
await sleep(1800);
const rect = await main.ev(`(()=>{const t=[...document.querySelectorAll("#tabs .tab")].find(t=>t.dataset.note==="untitled-48.laido");if(!t)return null;const r=t.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
check("victim tab present", !!rect);
const before = (await pages()).filter((t) => t.url.includes("tauri.localhost")).length;

// drag it out — right past innerWidth, stepwise like a real drag
await main.s("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await main.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x + i * 100, y: rect.y + i * 22, button: "left" });
  await sleep(30);
}
await main.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x + 1200, y: rect.y + 260, button: "left", clickCount: 1 });
await sleep(5000);

const wins = (await pages()).filter((t) => t.url.includes("tauri.localhost"));
check("new window spawned", wins.length === before + 1, `${before}→${wins.length}`);
const mainTabs = await main.ev(`[...document.querySelectorAll("#tabs .tab")].map(t=>t.dataset.note)`);
check("tab left main", !mainTabs.includes("untitled-48.laido"), JSON.stringify(mainTabs));

// find the child and verify note loaded
let child = null;
for (const w of wins) {
  const a = await attach(w);
  const lab = await a.ev("window.__TAURI__.window.getCurrentWindow().label");
  if (typeof lab === "string" && lab.startsWith("note-")) { child = a; break; }
  a.ws.close();
}
if (child) {
  await sleep(3500);
  const tabs = await child.ev(`[...document.querySelectorAll("#tabs .tab")].map(t=>t.dataset.note)`);
  check("child shows the note tab", JSON.stringify(tabs).includes("untitled-48"), JSON.stringify(tabs));
  const title = await child.ev(`document.getElementById("note-title")?.textContent`);
  const blocks = await child.ev(`document.querySelectorAll("#note-body>*").length`);
  check("child loaded the note", /untitled-48/.test(title ?? "") && typeof blocks === "number" && blocks > 0, `${title} / ${blocks} blocks`);
  const floats = await child.ev(`document.querySelectorAll(".callout.floating").length`);
  check("no runaway floats", floats === 0, String(floats));
  // close the popout via its tab X — exercises last-tab→window-close
  await child.ev(`document.querySelector("#tabs .tab .tab-close")?.click();""`);
  await sleep(2500);
  const wins2 = (await pages()).filter((t) => t.url.includes("tauri.localhost"));
  check("popout closed with last tab", wins2.length === before, `${wins2.length} left`);
} else {
  check("child window found", false);
}

const fails = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - fails}/${results.length} pass`);
process.exit(fails ? 1 : 0);
