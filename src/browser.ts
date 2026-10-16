/* ---------- the browser widget — a web page living in a callout card ------
 * Storage: `> [!browser] title` + `> url: <address>` lines.
 *
 * Two lanes:
 *   reader — Rust page_fetch extracts readable text + links (always works,
 *            and it's the text the AI answers questions about)
 *   live   — an <iframe> of the real page, used when the site's
 *            X-Frame-Options / frame-ancestors allow embedding.
 * Typing a non-URL into the bar searches via DuckDuckGo Lite (it renders
 * cleanly in reader mode). Every open browser card is listed in the chat
 * digest, and ` ```browser ` fences drive it via browserApi. */

import { invoke } from "./ipc.js";
import { addActivity } from "./log.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };

export interface PageInfo {
  url: string;
  final_url: string;
  title: string;
  text: string;
  links: [string, string][];
  blocked: boolean;
  walled?: boolean;
  status: number;
}

const escHtml = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "search words" → url; real urls pass through */
export function toUrl(input: string): string {
  if (typeof input !== "string") return "";
  const s = input.trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !s.includes(" ")) return `https://${s}`;
  const clean = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ""));
  // real engine default — google like every browser's omnibox
  return `https://www.google.com/search?q=${encodeURIComponent(clean)}`;
}

/* ---------- markdown <-> card ---------- */

/** `[!browser] title` + `url: …` + `tab: url | title` + `tool:`/`chat:`
 *  lines → card fields */
export function parseBrowser(block: string[]): {
  title: string;
  url: string;
  tabs: { url: string; title: string }[];
  atab: number;
  tools: { name: string; js: string }[];
  chat: string;
} {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim();
  let url = "";
  const tabs: { url: string; title: string }[] = [];
  const tools: { name: string; js: string }[] = [];
  let chat = "";
  let atab = 0;
  for (const raw of block.slice(1)) {
    const line = raw.trim();
    const m = line.match(/^url:\s*(\S+)/i);
    if (m) url = m[1];
    const mt = line.match(/^tab:\s*(\S+)(?:\s*\|\s*(.*))?$/i);
    if (mt) tabs.push({ url: mt[1] === "about:blank" ? "" : mt[1], title: (mt[2] ?? "").trim() });
    const ma = line.match(/^atab:\s*(\d+)/i);
    if (ma) atab = parseInt(ma[1], 10) || 0;
    const mo = line.match(/^tool:\s*(\{[\s\S]*\})\s*$/i);
    if (mo) {
      try {
        const t = JSON.parse(mo[1]) as { name?: unknown; js?: unknown };
        if (t && typeof t.name === "string" && typeof t.js === "string" && t.name && t.js)
          tools.push({ name: t.name.slice(0, 40), js: t.js });
      } catch { /* malformed tool line — skip */ }
    }
    const mc = line.match(/^chat:\s*(.+)$/i);
    if (mc) chat = mc[1];
  }
  return { title: title || "browser", url, tabs, atab, tools, chat };
}

export function browserToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const url = DS(card.dataset.url) ?? "";
  const title = DS(card.dataset.topic) ?? "browser";
  let md = `> [!browser] ${title}\n> url: ${url}`;
  try {
    const tabs = JSON.parse(DS(card.dataset.tabs) || "[]") as { url: string; title: string }[];
    if (tabs.length > 1) {
      md += `\n> atab: ${parseInt(card.dataset.atab ?? "0", 10) || 0}`;
      for (const tb of tabs)
        md += `\n> tab: ${tb.url || "about:blank"} | ${(tb.title || "").replace(/\|/g, "/")}`;
    }
  } catch { /* tab state is best-effort */ }
  try {
    const tools = JSON.parse(DS(card.dataset.tools) || "[]") as { name: string; js: string }[];
    for (const t of tools)
      if (t?.name && t?.js) md += `\n> tool: ${JSON.stringify({ name: t.name, js: t.js })}`;
  } catch { /* tool state is best-effort */ }
  if (DS(card.dataset.chat)) md += `\n> chat: ${DS(card.dataset.chat)}`;
  return md;
}

/** the card markup render.ts emits; wireBrowser upgrades it live */
export function browserInnerHtml(): string {
  return (
    `<div class="browser-bar" contenteditable="false">` +
    `<button class="bb-b" data-a="back" title="back">◀</button>` +
    `<button class="bb-b" data-a="fwd" title="forward">▶</button>` +
    `<button class="bb-b" data-a="re" title="reload">⟳</button>` +
    `<span class="bb-lock" title="connection">·</span>` +
    `<input class="bb-url" spellcheck="false" placeholder="url or search…"/>` +
    `<button class="bb-b" data-a="mode" title="toggle reader / live view">◐</button>` +
    `<button class="bb-b" data-a="clip" title="clip page text (or selection) into the note">⇲</button>` +
    `<button class="bb-b" data-a="bm" title="save to bookmarks.laido">★</button>` +
    `<button class="bb-b" data-a="win" title="open in a real window">⧉</button>` +
    `<button class="bb-b" data-a="chat" title="ask AI about this page">✦</button>` +
    `</div>` +
    `<div class="btabs" contenteditable="false"></div>` +
    `<div class="btools" contenteditable="false" hidden></div>` +
    `<div class="browser-main">` +
    `<div class="browser-view">` +
    `<div class="browser-reader"></div>` +
    `</div>` +
    `<div class="browser-chat" contenteditable="false">` +
    `<div class="bc-head"><span class="bc-t">✦ ask AI</span>` +
    `<button class="bc-x" title="hide the panel">×</button></div>` +
    `<div class="bc-log"></div>` +
    `<div class="bc-bar"><input class="bc-in" maxlength="280" spellcheck="false" ` +
    `placeholder="ask about this page — 'summarize it', 'grab prices', 'make a tool'…"></div>` +
    `</div>` +
    `</div>` +
    `<div class="browser-status" contenteditable="false">idle</div>`
  );
}

export function buildBrowserCard(title: string, url: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout browser-card";
  card.dataset.kind = "browser";
  card.dataset.topic = title || "browser";
  card.dataset.url = typeof url === "string" ? url : "";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${escHtml(title || "browser")}</span></div>` +
    browserInnerHtml();
  return card;
}

/* ---------- the live card ---------- */

export interface BrowserApi {
  url(): string;
  title(): string;
  navigate(input: string): Promise<string>;
  back(): Promise<string>;
  forward(): Promise<string>;
  read(): string;
  /** live-DOM text from the real page (post-JS) — the AI's real eyes */
  readLive(): Promise<string>;
  /** run js inside the live page — JSON-parsed result (the AI's hands) */
  eval(js: string): Promise<unknown>;
  /** the page's extracted links — the agent's navigation targets */
  links(): [string, string][];
  mode(): string;
  live(): boolean;
  /** the clip payload — selection inside the reader view wins, else the
   *  whole extracted page text (capped) */
  clip(selOnly?: boolean): { title: string; url: string; text: string } | null;
  /** append `- [ ] [title](url)` to bookmarks.laido (created if missing) */
  bookmark(): Promise<string>;
  /** the card's tab strip — one live engine, an address + back-stack per tab */
  tabs(): { url: string; title: string; active: boolean }[];
  /** open a new tab (blank address bar when no url) and switch to it */
  newTab(url?: string): Promise<string>;
  /** switch to tab i (0-based) */
  tab(i: number): Promise<string>;
  /** the card's saved page tools */
  tools(): { name: string; js: string }[];
  /** save (or overwrite) a named page tool */
  saveTool(spec: { name: string; js: string }): string;
  /** delete a saved tool by name */
  delTool(name: string): string;
  /** run a saved tool's js in the live page — JSON-parsed result back */
  runTool(name: string): Promise<string>;
}

const apis = new WeakMap<HTMLElement, BrowserApi>();
export function browserApi(card: HTMLElement): BrowserApi | undefined {
  return apis.get(card);
}

let pvSeq = 0;

export function wireBrowser(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.browserWired) return;
  card.dataset.browserWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("browser:changed", { bubbles: true }));
  const bar = card.querySelector<HTMLElement>(".browser-bar");
  const urlIn = card.querySelector<HTMLInputElement>(".bb-url");
  const view = card.querySelector<HTMLElement>(".browser-view");
  const reader = card.querySelector<HTMLElement>(".browser-reader");
  const status = card.querySelector<HTMLElement>(".browser-status");
  if (!bar || !urlIn || !view || !reader || !status) return;
  const strip = card.querySelector<HTMLElement>(".btabs");

  /* tabs — one live engine, N addresses; each tab keeps its own url,
   * title and back-stack and switching navigates the same webview */
  interface BTab {
    url: string;
    title: string;
    hist: string[];
    hi: number;
  }
  let tabs: BTab[] = [];
  try {
    const raw = JSON.parse(DS(card.dataset.tabs) || "[]") as Partial<BTab>[];
    if (Array.isArray(raw))
      tabs = raw
        .filter((t) => t && typeof t.url === "string")
        .map((t) => {
          const h = Array.isArray(t.hist) ? t.hist.map(S).filter(Boolean).slice(-60) : [];
          const i = typeof t.hi === "number" && Number.isFinite(t.hi) ? t.hi : -1;
          return { url: S(t.url), title: S(t.title), hist: h, hi: Math.min(i, h.length - 1) };
        });
  } catch {
    tabs = [];
  }
  if (!tabs.length)
    tabs = [{ url: DS(card.dataset.url) ?? "", title: DS(card.dataset.topic) ?? "", hist: [], hi: -1 }];
  let active = Math.min(Math.max(parseInt(card.dataset.atab ?? "0", 10) || 0, 0), tabs.length - 1);
  const cur = () => tabs[active] ?? tabs[0];
  // hist/hi always alias the ACTIVE tab's stack
  let hist = cur().hist;
  let hi = cur().hi;
  let lastPage: PageInfo | null = null;
  // the real engine is the default lane — ◐ drops to the text reader
  let liveOn = true;
  let loading = false;
  /* the webview id must be STABLE across rewires — a fresh id makes the
   * restore path open a second engine and reload the page (and orphans
   * the old one). Reuse the card's id when it already has one */
  const bvId = card.dataset.bv || `bv-${Date.now().toString(36)}-${++pvSeq}`;
  card.dataset.bv = bvId;
  const lock = card.querySelector<HTMLElement>(".bb-lock");
  const reBtn = bar.querySelector<HTMLElement>('[data-a="re"]');
  const setLock = (u: string) => {
    if (!lock) return;
    const https = u.startsWith("https://");
    lock.textContent = u.startsWith("http") ? (https ? "🔒" : "⚠") : "·";
    lock.title = https ? "secure connection" : "not secure";
  };
  const setLoading = (on: boolean) => {
    loading = on;
    if (reBtn) {
      reBtn.textContent = on ? "✕" : "⟳";
      reBtn.title = on ? "stop loading" : "reload";
    }
  };

  const say = (msg: string) => {
    status.textContent = msg;
  };

  const hostOf = (u: string) => u.split("/")[2] ?? u;

  const persistTabs = () => {
    card.dataset.tabs = JSON.stringify(tabs);
    card.dataset.atab = String(active);
  };
  const syncTab = () => {
    const t = cur();
    t.hi = hi;
    t.url = card.dataset.url ?? t.url;
    t.title = card.dataset.topic ?? t.title;
    persistTabs();
  };
  const renderTabs = () => {
    if (!strip) return;
    strip.innerHTML =
      tabs
        .map(
          (tb, i) =>
            `<span class="btab${i === active ? " on" : ""}" data-i="${i}" title="${escHtml(tb.title || tb.url || "new tab")}">` +
            `<span class="btab-t">${escHtml(tb.title || hostOf(tb.url) || "new tab")}</span>` +
            (tabs.length > 1 ? `<button class="btab-x" data-x="${i}" title="close tab">×</button>` : "") +
            `</span>`,
        )
        .join("") +
      `<button class="btab-add" title="new tab">+</button>`;
  };

  /* ---------- saved page tools — named js that runs in the live page;
   * the strip sits under the tab bar and each chip is a one-click action */
  let tools: { name: string; js: string }[] = [];
  try {
    const raw = JSON.parse(DS(card.dataset.tools) || "[]") as { name?: unknown; js?: unknown }[];
    if (Array.isArray(raw))
      tools = raw
        .filter((t) => t && typeof t.name === "string" && typeof t.js === "string" && t.name && t.js)
        .map((t) => ({ name: t.name as string, js: t.js as string }));
  } catch { tools = []; }
  const toolsStrip = card.querySelector<HTMLElement>(".btools");
  const persistTools = () => {
    card.dataset.tools = JSON.stringify(tools);
    onChange();
  };
  const renderTools = () => {
    if (!toolsStrip) return;
    toolsStrip.hidden = !tools.length;
    toolsStrip.innerHTML = tools
      .map(
        (t, i) =>
          `<span class="btool" data-t="${i}" title="run ${escHtml(t.name)} on the live page">` +
          `⚒ ${escHtml(t.name)}<button class="btool-x" data-dx="${i}" title="delete tool">×</button></span>`,
      )
      .join("");
  };
  const saveTool = (spec: { name: string; js: string }): string => {
    const name = S(spec?.name).trim().slice(0, 40);
    const js = S(spec?.js).trim();
    if (!name || !js) return "✕ tool needs {name, js}";
    const ix = tools.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
    if (ix >= 0) tools[ix] = { name, js };
    else tools.push({ name, js });
    persistTools();
    renderTools();
    return `tool "${name}" saved to "${card.dataset.topic ?? "browser"}"`;
  };
  const delTool = (name: string): string => {
    const ix = tools.findIndex((t) => t.name.toLowerCase() === S(name).trim().toLowerCase());
    if (ix < 0) return `✕ no tool "${name}" on this card`;
    tools.splice(ix, 1);
    persistTools();
    renderTools();
    return `tool "${name}" removed`;
  };
  const runTool = async (name: string): Promise<string> => {
    const t = tools.find((x) => x.name.toLowerCase() === S(name).trim().toLowerCase());
    if (!t) return `✕ no tool "${name}" — ${tools.map((x) => x.name).join(", ") || "none saved"}`;
    try {
      const s = await invoke<string>("pv_eval", { id: bvId, js: t.js });
      const out = JSON.parse(s);
      const txt = typeof out === "string" ? out : JSON.stringify(out);
      say(`tool "${t.name}" → ${txt.slice(0, 80)}`);
      return `tool "${t.name}" → ${txt.slice(0, 4000)}`;
    } catch (e) {
      return `✕ tool "${t.name}" failed: ${String(e).slice(0, 120)}`;
    }
  };
  toolsStrip?.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const dx = el.closest<HTMLElement>(".btool-x");
    if (dx) {
      e.preventDefault(); e.stopPropagation();
      const t = tools[parseInt(dx.dataset.dx ?? "-1", 10)];
      if (t) say(delTool(t.name));
      return;
    }
    const chip = el.closest<HTMLElement>(".btool");
    if (chip) {
      e.preventDefault(); e.stopPropagation();
      const t = tools[parseInt(chip.dataset.t ?? "-1", 10)];
      if (t) void runTool(t.name).then((o) => chatAdd?.("out", o));
    }
  });
  const showBlank = () => {
    reader.innerHTML =
      `<div class="br-newtab"><b>new tab</b><span>type an address or a search above</span></div>`;
  };
  /* reader pane covers the view for reader mode AND for a blank tab — the
   * webview can't load about:blank, so an empty tab hides it and shows the
   * placeholder instead */
  const paintView = () => {
    reader.style.display = !liveOn || !cur().url ? "" : "none";
    if (!cur().url) showBlank();
  };
  const switchTab = (i: number, fromUi = false): Promise<string> | string => {
    if (i < 0 || i >= tabs.length) return `✕ no tab ${i + 1} — ${tabs.length} open`;
    if (i === active) {
      if (fromUi) urlIn.focus();
      return `already on tab ${i + 1}`;
    }
    syncTab();
    active = i;
    const t = cur();
    hist = t.hist;
    hi = t.hi;
    card.dataset.url = t.url;
    card.dataset.topic = t.title || "new tab";
    const el = card.querySelector(".callout-title");
    if (el) el.textContent = card.dataset.topic;
    urlIn.value = t.url;
    persistTabs();
    renderTabs();
    paintView();
    if (t.url) return nav(t.url, false);
    lastBox = "";
    pvSync();
    say("new tab");
    urlIn.focus();
    return "new tab";
  };
  const newTab = (input?: string): Promise<string> | string => {
    const url = input ? toUrl(input) : "";
    syncTab();
    tabs.push({ url, title: "", hist: [], hi: -1 });
    active = tabs.length - 1;
    hist = cur().hist;
    hi = -1;
    card.dataset.url = url;
    if (!url) {
      card.dataset.topic = "new tab";
      const el = card.querySelector(".callout-title");
      if (el) el.textContent = "new tab";
    }
    urlIn.value = url;
    persistTabs();
    renderTabs();
    paintView();
    if (url) return nav(url, true);
    lastBox = "";
    pvSync();
    say("new tab");
    urlIn.focus();
    return "new tab";
  };
  const closeTab = (i: number) => {
    if (tabs.length <= 1) return;
    tabs.splice(i, 1);
    if (active > i) active--;
    else if (active === i) active = Math.min(active, tabs.length - 1);
    const t = cur();
    hist = t.hist;
    hi = t.hi;
    card.dataset.url = t.url;
    card.dataset.topic = t.title || "new tab";
    const el = card.querySelector(".callout-title");
    if (el) el.textContent = card.dataset.topic;
    urlIn.value = t.url;
    persistTabs();
    renderTabs();
    paintView();
    if (t.url && t.url !== lastFetched) void nav(t.url, false).then(say);
    else if (!t.url) {
      lastBox = "";
      pvSync();
      say("new tab");
    } else pvSync();
    onChange();
  };

  /* the live lane is a REAL WebView2 composited over .browser-view —
   * window-level surface, not DOM: keep it glued to the card's rect and
   * hide it whenever the card scrolls out, hides, is covered by another
   * floating card, or leaves the note — it has no z-order of its own */
  const dpr = () => window.devicePixelRatio || 1;
  let lastBox = "";
  let coverTicks = 0;
  const pvSync = () => {
    if (!card.isConnected) return;
    const r = view.getBoundingClientRect();
    const clipEl = card.closest<HTMLElement>("#note-body") ?? document.body;
    const clip = clipEl.getBoundingClientRect();
    /* the callout body clips the view too (overflow:hidden on small
     * cards) — the webview may only cover the truly visible slice */
    const body = view.closest<HTMLElement>(".callout-body")?.getBoundingClientRect();
    const clipTop = body ? Math.max(clip.top, body.top) : clip.top;
    const clipBot = body ? Math.min(clip.bottom, body.bottom) : clip.bottom;
    /* the native surface can't be scissored by the DOM scroll region, so
     * position it at the visible intersection — a partially-shown card
     * keeps its page on screen instead of blinking out at the clip edge */
    const ix = Math.max(r.left, clip.left);
    const iy = Math.max(r.top, clipTop);
    const iw = Math.min(r.right, clip.right) - ix;
    const ih = Math.min(r.bottom, clipBot) - iy;
    /* a native webview punches through the DOM — if another card covers
     * the visible middle, the widget underneath must hide. Two consecutive
     * samples required so a transient hit-test gap can't flicker it */
    const mid =
      iw > 0 && ih > 0
        ? document.elementFromPoint(ix + iw / 2, iy + ih / 2)
        : null;
    coverTicks = !mid || !card.contains(mid) ? coverTicks + 1 : 0;
    const vis = liveOn && !!cur().url && coverTicks < 2 && iw > 8 && ih > 8;
    const d = dpr();
    const key = `${Math.round(ix)},${Math.round(iy)},${Math.round(iw)},${Math.round(ih)},${vis},${d}`;
    if (key === lastBox) return;
    lastBox = key;
    void invoke("pv_bounds", {
      id: bvId,
      x: Math.round(ix * d), y: Math.round(iy * d),
      w: Math.round(Math.max(1, iw) * d), h: Math.round(Math.max(1, ih) * d),
    }).catch(() => {});
    void invoke("pv_visible", { id: bvId, on: vis }).catch(() => {});
  };
  /* ResizeObserver catches card drags/resizes instantly instead of waiting
   * for the poll — the page surface tracks the grip in real time */
  const ro = new ResizeObserver(() => pvSync());
  ro.observe(view);
  let deadTicks = 0;
  const pvTimer = window.setInterval(() => {
    if (!card.isConnected) {
      // DOM detach = note switch or card delete → the webview must die
      if (++deadTicks >= 2) {
        window.clearInterval(pvTimer);
        ro.disconnect();
        void invoke("pv_close", { id: bvId }).catch(() => {});
        for (const u of unlistens) void u.then((f) => f()).catch(() => {});
      }
      return;
    }
    deadTicks = 0;
    pvSync();
  }, 140);

  /* walled pages need sign-in — the live engine handles them natively;
   * ⧉ opens a full window for sites that want more room */
  const openInBrowser = (u: string) => {
    if (!u) return;
    const ww = window.__TAURI__?.webviewWindow?.WebviewWindow;
    try {
      if (!ww) throw new Error("no tauri");
      const w = new ww(`laido-web-${Date.now()}`, {
        url: u,
        title: card.dataset.topic ?? "browser",
        width: 980,
        height: 720,
      });
      void w;
      addActivity(`browser: opened ${u} in a window`);
    } catch {
      void invoke("open_url", { url: u })
        .then(() => addActivity(`browser: opened ${u} externally`))
        .catch(() => window.open(u, "_blank"));
    }
  };

  bar.querySelector('[data-a="mode"]')?.classList.add("on");

  const setMode = (live: boolean) => {
    liveOn = live;
    lastBox = "";
    paintView();
    bar.querySelector('[data-a="mode"]')?.classList.toggle("on", live);
    if (!live) void invoke("pv_visible", { id: bvId, on: false }).catch(() => {});
    else pvSync();
  };
  paintView();
  renderTabs();

  const renderReader = (p: PageInfo) => {
    const all = p.links ?? [];
    const links = all
      .slice(0, 40)
      .map(
        ([t, u]) =>
          `<a class="br-link" href="#" data-u="${escHtml(u)}">${escHtml(t)}</a>`,
      )
      .join("");
    const host = hostOf(p.final_url ?? "");
    const wall = p.walled
      ? `<div class="br-wall">` +
        `<div class="br-wall-head">${escHtml(host)} needs sign-in or a real engine</div>` +
        `<div class="br-wall-sub">switch to live view — the page runs natively in the card and stays logged in</div>` +
        `<button class="br-wall-open" type="button">Show ${escHtml(host)} live ◐</button>` +
        `</div>`
      : "";
    reader.innerHTML =
      `<div class="br-title">${escHtml(p.title || p.final_url || "")}</div>` +
      `<div class="br-url">${escHtml(p.final_url ?? "")}</div>` +
      wall +
      (links
        ? `<button class="br-linkbtn" type="button">▸ ${all.length} link${all.length === 1 ? "" : "s"} on this page</button><div class="br-links" hidden>${links}</div>`
        : "") +
      `<div class="br-text">${escHtml(p.text ?? "").replace(/\n/g, "<br>")}</div>`;
    reader.querySelector<HTMLElement>(".br-wall-open")?.addEventListener("click", () => {
      setMode(true);
      say(`live — ${hostOf(p.final_url ?? "")}`);
    });
    reader.querySelectorAll<HTMLElement>(".br-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void nav(a.dataset.u ?? "", true);
      });
    });
    const lb = reader.querySelector<HTMLElement>(".br-linkbtn");
    lb?.addEventListener("click", () => {
      const list = reader.querySelector<HTMLElement>(".br-links");
      if (!list) return;
      const open = list.hasAttribute("hidden");
      if (open) list.removeAttribute("hidden"); else list.setAttribute("hidden", "");
      lb.textContent = `${open ? "▾" : "▸"} ${all.length} link${all.length === 1 ? "" : "s"} on this page`;
    });
  };

  // two fetches in flight resolve out of order — the latest request must
  // win, not the last response; a stale reply paints over the newer page
  let navSeq = 0;
  let lastFetched = "";
  const pvOpen = (url: string) => {
    const r = view.getBoundingClientRect();
    const d = dpr();
    return invoke("pv_open", {
      id: bvId, url,
      x: Math.round(r.left * d), y: Math.round(r.top * d),
      w: Math.round(r.width * d), h: Math.round(r.height * d),
    });
  };
  const nav = async (input: string, push: boolean): Promise<string> => {
    const url = toUrl(input);
    if (!url) return "empty address";
    const seq = ++navSeq;
    say("loading…");
    setLock(url);
    // a blank tab's webview is hidden — claim the url now so pvSync shows
    // it, and repaint so the new-tab placeholder drops out of live mode
    cur().url = url;
    paintView();
    // the real engine opens immediately — XFO/walls can't touch it; the
    // fetch lane runs in parallel for the AI's text + the reader view
    if (liveOn) {
      setLoading(true);
      const fail = (e: unknown) => {
        setLoading(false);
        setMode(false);
        say(`live view failed — reader: ${String(e)}`);
      };
      void pvOpen(url).catch((e) => {
        // a same-id open is still mid-create on the rust side — retry once
        if (/still opening/.test(String(e))) {
          window.setTimeout(() => {
            if (seq === navSeq) void pvOpen(url).catch(fail);
          }, 400);
          return;
        }
        fail(e);
      });
    }
    let p: PageInfo | null = null;
    let fetchErr = "";
    try {
      p = await invoke<PageInfo>("page_fetch", { url });
      lastFetched = p.final_url ?? url;
    } catch (e) {
      fetchErr = String(e);
    }
    if (seq !== navSeq) return "superseded";
    if (p) {
      lastPage = p;
      card.dataset.url = p.final_url ?? "";
      if (urlIn.value !== p.final_url) urlIn.value = p.final_url ?? "";
      if (p.title) {
        card.dataset.topic = p.title;
        const t = card.querySelector(".callout-title");
        if (t) t.textContent = p.title;
      }
      renderReader(p);
    }
    const host = hostOf(p?.final_url ?? url);
    if (liveOn) {
      say(
        p?.walled
          ? `live — ${host} may ask you to sign in`
          : p
            ? `live — ${p.status || "ok"}`
            : `live — fetch lane: ${fetchErr}`,
      );
    } else {
      say(
        !p
          ? `fetch failed: ${fetchErr}`
          : p.walled
            ? `${host} needs sign-in — ◐ shows it live`
            : `reader — ${p.status || "ok"}`,
      );
    }
    if (push) {
      hist.splice(hi + 1);
      hist.push(p?.final_url ?? url);
      hi = hist.length - 1;
    }
    if (p?.walled && !liveOn) status.dataset.live = "1";
    else delete status.dataset.live;
    syncTab();
    renderTabs();
    onChange();
    return `${p?.title || p?.final_url || url} — ${p?.text.length ?? 0} chars${p?.walled ? " (walled — sign-in needed, live in ◐)" : ""}${liveOn ? " (live)" : " (reader)"}`;
  };

  // the user navigated INSIDE the live page (link click, form submit) —
  // keep the bar, history, and the AI's text lane in step
  const listen = window.__TAURI__?.event?.listen?.bind(window.__TAURI__.event);
  const unlistens: Promise<() => void>[] = [];
  const on = (ev: string, cb: (e: { payload: any }) => void) => {
    const u = listen?.call(window.__TAURI__?.event, ev, cb);
    if (u) unlistens.push(u as Promise<() => void>);
  };
  on("pv:nav", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || pay.id !== bvId || !card.isConnected || !pay.url) return;
    const u = pay.url;
    card.dataset.url = u;
    cur().url = u;
    setLock(u);
    if (urlIn.value !== u) urlIn.value = u;
    if (hist[hi] !== u) {
      hist.splice(hi + 1);
      hist.push(u);
      hi = hist.length - 1;
    }
    syncTab();
    renderTabs();
    if (u === lastFetched) return;
    lastFetched = u;
    void invoke<PageInfo>("page_fetch", { url: u })
      .then((q) => {
        if (!card.isConnected || !q) return;
        lastPage = q;
        if (q.title) {
          card.dataset.topic = q.title;
          const t = card.querySelector(".callout-title");
          if (t) t.textContent = q.title;
        }
        if (!liveOn) renderReader(q);
        onChange();
      })
      .catch(() => {});
  });
  // real loading state — ⟳ flips to ✕ while the page loads
  on("pv:load", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || pay.id !== bvId || !card.isConnected) return;
    setLoading(!pay.done);
    if (pay.done && liveOn) say(`live — ${hostOf(pay.url || card.dataset.url || "")}`);
  });
  // real titles — js-set ones included (fetch can't see them)
  on("pv:title", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || pay.id !== bvId || !card.isConnected || !pay.title) return;
    card.dataset.topic = pay.title;
    const t = card.querySelector(".callout-title");
    if (t) t.textContent = pay.title;
    cur().title = pay.title;
    persistTabs();
    renderTabs();
  });
  // downloads — real files land in OS Downloads; trace them
  on("pv:dl", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || pay.id !== bvId || !card.isConnected) return;
    const name = (pay.path || pay.url).split(/[\\/]/).pop() ?? "file";
    if (pay.done) {
      addActivity(`browser: downloaded ${name}${pay.ok ? "" : " (failed)"}`);
      say(pay.ok ? `downloaded ${name}` : `download failed — ${name}`);
    } else {
      addActivity(`browser: downloading ${pay.url}`);
      say(`downloading ${name}…`);
    }
  });

  const navHist = async (d: number): Promise<string> => {
    // in live mode the engine's own history is the truth
    if (liveOn) {
      const js = d < 0 ? "history.back();'back'" : "history.forward();'forward'";
      await invoke("pv_eval", { id: bvId, js }).catch(() => {});
      return d < 0 ? "back" : "forward";
    }
    const n = hi + d;
    if (n < 0 || n >= hist.length) return "no more history";
    hi = n;
    return nav(hist[hi], false);
  };

  bar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    const a = b.dataset.a;
    if (a === "back") void navHist(-1).then(say);
    else if (a === "fwd") void navHist(1).then(say);
    else if (a === "re") {
      // a real browser's reload becomes stop mid-load
      if (loading) {
        setLoading(false);
        void invoke("pv_eval", { id: bvId, js: "window.stop();'stopped'" }).catch(() => {});
        say("stopped");
      } else {
        void nav(card.dataset.url ?? urlIn.value, false).then(say);
      }
    }
    else if (a === "mode") setMode(!liveOn);
    else if (a === "clip") {
      const c = apis.get(card)?.clip();
      if (!c) {
        say("nothing to clip — load a page first");
      } else {
        card.dispatchEvent(new CustomEvent("browser:clip", { bubbles: true, detail: c }));
        say(`clipped ${c.text.length} chars into the note`);
      }
    } else if (a === "bm") {
      void apis.get(card)?.bookmark().then(say);
    }
    else if (a === "win") openInBrowser(card.dataset.url ?? urlIn.value);
    else if (a === "chat") setChatOpen(chatPane ? chatPane.hidden : true);
  });
  status.addEventListener("click", () => {
    if (status.dataset.live) setMode(true);
  });
  urlIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void nav(urlIn.value, true).then(say);
    }
  });
  urlIn.addEventListener("pointerdown", (e) => e.stopPropagation());
  strip?.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const x = el.closest<HTMLElement>(".btab-x");
    if (x) {
      e.preventDefault();
      e.stopPropagation();
      closeTab(parseInt(x.dataset.x ?? "-1", 10));
      return;
    }
    if (el.closest(".btab-add")) {
      e.preventDefault();
      e.stopPropagation();
      void Promise.resolve(newTab()).then(say);
      return;
    }
    const tb = el.closest<HTMLElement>(".btab");
    if (tb) {
      e.preventDefault();
      e.stopPropagation();
      void Promise.resolve(switchTab(parseInt(tb.dataset.i ?? "-1", 10), true)).then(say);
    }
  });

  /* ---------- the AI chat dock — a vertical panel on the card's right
   * edge; the same fence machinery as the terminal, aimed at THIS card */
  const chatPane = card.querySelector<HTMLElement>(".browser-chat");
  const chatLog = card.querySelector<HTMLElement>(".bc-log");
  const chatIn = card.querySelector<HTMLInputElement>(".bc-in");
  const chatHist: { role: string; content: string }[] = [];
  interface ChatBubble { c: string; t: string }
  const liveCard = (): HTMLElement =>
    // a mid-flight AI mutation re-renders the callout — later bubbles must
    // land on the replacement card, not the detached one
    card.isConnected
      ? card
      : (Array.from(document.querySelectorAll<HTMLElement>(".browser-card")).find(
          (c) => (c.dataset.topic ?? "") === (card.dataset.topic ?? "browser"),
        ) ?? card);
  function chatAdd(cls: string, text: string): HTMLElement | null {
    const host = liveCard().querySelector<HTMLElement>(".bc-log") ?? chatLog;
    if (!host) return null;
    const m = document.createElement("div");
    m.className = `sc-msg ${cls}`;
    m.textContent = text;
    host.append(m);
    while (host.children.length > 40) host.firstElementChild!.remove();
    host.scrollTop = host.scrollHeight;
    if (cls !== "wait") {
      const bubbles: ChatBubble[] = Array.from(host.querySelectorAll<HTMLElement>(".sc-msg"))
        .map((x) => ({ c: x.className.replace("sc-msg ", ""), t: x.textContent ?? "" }))
        .filter((b) => b.c !== "wait")
        .slice(-20);
      liveCard().dataset.chat = JSON.stringify(bubbles);
    }
    return m;
  }
  try {
    for (const b of JSON.parse(DS(card.dataset.chat) || "[]") as ChatBubble[]) {
      if (!b || typeof b.c !== "string" || typeof b.t !== "string") continue;
      chatAdd(b.c, b.t);
      if (b.c === "user" || b.c === "ai")
        chatHist.push({ role: b.c === "user" ? "user" : "assistant", content: b.t });
    }
  } catch { /* malformed chat state — start clean */ }
  const setChatOpen = (on: boolean) => {
    if (!chatPane) return;
    chatPane.hidden = !on;
    card.dataset.chatopen = on ? "" : "0";
    bar.querySelector('[data-a="chat"]')?.classList.toggle("on", on);
    lastBox = "";
    pvSync();
  };
  card.querySelector<HTMLElement>(".bc-x")?.addEventListener("click", () => setChatOpen(false));
  if (card.dataset.chatopen === "0") setChatOpen(false);
  else setChatOpen(true);

  const askBrowser = async (q: string) => {
    if (!chatIn) return;
    chatIn.disabled = true;
    const pend = chatAdd("wait", "…");
    const title = card.dataset.topic ?? "browser";
    const others =
      `browser "${title}" on ${cur().url || "(blank tab)"} — a REAL webview2 ` +
      `page (js ran, post-render dom). Tabs: ` +
      `${tabs.map((t) => t.url || "blank").join(", ") || "one"}. ` +
      `Saved tools: ${tools.map((t) => t.name).join(", ") || "none"}.\n` +
      `The user asks about THIS card — aim every \`\`\`browser fence at ` +
      `"${title}". Verbs: read/extract/tables/click/eval/navigate/back/forward/` +
      `tabs/newtab/tab/clip/bookmark/search/open. Save a reusable page tool ` +
      `with \`tool ${title} {"name":"x","js":"…"}\` (js runs in the page, ` +
      `result comes back JSON) then \`runtool ${title} x\`; tooldel removes. ` +
      `Other widgets use their own \`\`\` fences with a \`new <title>\` verb.`;
    interface BrowserAi {
      text: string; sheet: string[]; slides: string[]; todo: string[];
      chart: string[]; cards: string[]; maps: string[]; base: string[];
      browser: string[]; laido: string[];
    }
    try {
      const { runWidgetFence } = await import("./term.js");
      const r = await invoke<BrowserAi>("term_ai", {
        prompt: q, history: chatHist.slice(-8), others,
        model: null, persona: null,
      });
      chatHist.push({ role: "user", content: q });
      if (r.text.trim()) chatHist.push({ role: "assistant", content: r.text });
      pend?.remove();
      let readBack = false;
      const outs: string[] = [];
      const kinds: [keyof BrowserAi, string][] = [
        ["browser", "browser"], ["sheet", "sheet"], ["slides", "slides"],
        ["todo", "todo"], ["chart", "chart"], ["cards", "cards"],
        ["maps", "map"], ["base", "base"],
      ];
      for (const [field, kind] of kinds) {
        for (const body of (r[field] as string[]) ?? []) {
          const out = await runWidgetFence(kind, body);
          const head = body.trim().split("\n")[0];
          outs.push(`${kind}: ${head} → ${out}`);
          chatAdd("out", out);
          const v = (head.split(/\s+/)[0] ?? "").toLowerCase();
          if (kind === "browser" && /^(read|get|extract|data|digest|tables|table|eval|js|runtool|click|links|tabs|list)$/.test(v))
            readBack = true;
          void window.__TAURI__?.event?.emit("agent:activity", {
            text: `browser ✦ ${title}: ${kind} ${head.slice(0, 60)}`,
          });
        }
      }
      if (readBack && outs.length) {
        // "what does the page say about X?" — feed the result back for a
        // spoken answer, not raw tool output
        const r2 = await invoke<BrowserAi>("term_ai", {
          prompt: `browser tool results:\n${outs.join("\n")}\nanswer the original request: ${q}`,
          history: chatHist.slice(-8), others: "", model: null, persona: null,
        });
        if (r2.text.trim()) {
          chatHist.push({ role: "assistant", content: r2.text });
          chatAdd("ai", r2.text.trim());
        } else chatAdd("out", outs.join(" · "));
      } else if (!outs.length) {
        chatAdd(r.text.trim() ? "ai" : "err", r.text.trim() || "no action came back — try rephrasing");
      } else if (r.text.trim()) {
        chatAdd("ai", r.text.trim());
      }
    } catch (e) {
      pend?.remove();
      chatAdd("err", `✕ ${String(e).slice(0, 140)}`);
    } finally {
      chatIn.disabled = false;
      chatIn.focus();
    }
  };
  chatIn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = chatIn.value.trim();
      if (!q) return;
      chatIn.value = "";
      chatAdd("user", q);
      void askBrowser(q);
    }
  });
  chatIn?.addEventListener("pointerdown", (e) => e.stopPropagation());

  // restore persisted address — but a re-wire (undo restore, md
  // re-render) must NOT reload a webview that already shows the page:
  // pv_open on an existing view calls navigate() again, which is a real
  // page reload. Ask the engine what it has first and only nav when the
  // view is missing or on a different url.
  if (cur().url) {
    urlIn.value = cur().url;
    const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    void invoke<string>("pv_url", { id: bvId })
      .then((have) => {
        if (sameUrl(have, cur().url)) {
          // the engine kept the page — just re-glue the surface
          lastBox = "";
          pvSync();
          paintView();
          say(`live — ${hostOf(cur().url)}`);
          return;
        }
        return nav(cur().url, true).then(say);
      })
      .catch(() => nav(cur().url, true).then(say));
  } else {
    say("new tab");
  }
  renderTools();

  apis.set(card, {
    url: () => card.dataset.url ?? "",
    title: () => card.dataset.topic ?? "browser",
    navigate: (input) => nav(input, true),
    back: () => navHist(-1),
    forward: () => navHist(1),
    read: () => lastPage?.text ?? "",
    readLive: async () => {
      if (!liveOn) return lastPage?.text ?? "";
      try {
        const s = await invoke<string>("pv_eval", {
          id: bvId,
          js: "document.body ? document.body.innerText.slice(0,48000) : ''",
        });
        const t = JSON.parse(s);
        return typeof t === "string" && t.trim() ? t : (lastPage?.text ?? "");
      } catch {
        return lastPage?.text ?? "";
      }
    },
    eval: async (js: string) => {
      const s = await invoke<string>("pv_eval", { id: bvId, js });
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    },
    links: () => lastPage?.links ?? [],
    mode: () => (liveOn ? "live" : "reader"),
    live: () => liveOn,
    clip: (selOnly?: boolean) => {
      if (!lastPage) return null;
      // a selection wholly inside the reader pane is the clip target
      const sel = window.getSelection();
      let text = "";
      if (
        sel &&
        sel.rangeCount > 0 &&
        sel.toString().trim() &&
        reader.contains(sel.getRangeAt(0).commonAncestorContainer)
      ) {
        text = sel.toString().trim();
      } else if (!selOnly) {
        text = lastPage.text.slice(0, 4000);
      }
      if (!text) return null;
      return { title: lastPage.title || lastPage.final_url, url: lastPage.final_url, text };
    },
    bookmark: async () => {
      const p = lastPage;
      if (!p) return "no page loaded";
      // walls return "Error"-ish titles — bookmark the host instead
      const t = p.walled || /^(error|log ?in|sign ?in)/i.test(p.title) ? hostOf(p.final_url) : p.title;
      return clipBookmark(t || p.final_url, p.final_url);
    },
    tabs: () => tabs.map((t, i) => ({ url: t.url, title: t.title, active: i === active })),
    newTab: (u?: string) => Promise.resolve(newTab(u)),
    tab: (i: number) => Promise.resolve(switchTab(i)),
    tools: () => tools.map((t) => ({ name: t.name, js: t.js })),
    saveTool,
    delTool,
    runTool,
  });
}

/** append a bookmark line to `bookmarks.laido`, creating + deduping */
async function clipBookmark(title: string, url: string): Promise<string> {
  const name = "bookmarks.laido";
  let cur = "";
  try {
    cur = await invoke<string>("vault_read", { name });
  } catch {
    cur = `# Bookmarks\n\n`;
  }
  // literal parens in a url (wikipedia "(disambiguation)" links) are only
  // legal in markdown when balanced — percent-encode both so the stored
  // link parses everywhere
  const safe = url.replace(/\(/g, "%28").replace(/\)/g, "%29");
  if (cur.includes(`(${safe})`)) return `already bookmarked — ${title}`;
  const next = `${cur.trimEnd()}\n- [ ] [${title.replace(/[\[\]\n]/g, " ")}](${safe})\n`;
  await invoke("vault_write", { name, content: next });
  return `bookmarked ${title} → bookmarks.laido`;
}
