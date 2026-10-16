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

import { invoke, refocusField } from "./ipc.js";
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
  tabs: { url: string; title: string; bv: string }[];
  atab: number;
  tools: { name: string; js: string }[];
  chat: string;
  bv: string;
} {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim();
  let url = "";
  const tabs: { url: string; title: string; bv: string }[] = [];
  const tools: { name: string; js: string }[] = [];
  let chat = "";
  let bv = "";
  let atab = 0;
  for (const raw of block.slice(1)) {
    const line = raw.trim();
    const m = line.match(/^url:\s*(\S+)/i);
    if (m) url = m[1];
    const mt = line.match(/^tab:\s*(\S+)(?:\s*\|\s*([^|]*?))?(?:\s*\|\s*(\S+))?\s*$/i);
    if (mt)
      tabs.push({
        url: mt[1] === "about:blank" ? "" : mt[1],
        title: (mt[2] ?? "").trim(),
        bv: mt[3] ?? "",
      });
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
    const mv = line.match(/^bv:\s*(\S+)/i);
    if (mv) bv = mv[1];
  }
  return { title: title || "browser", url, tabs, atab, tools, chat, bv };
}

export function browserToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const url = DS(card.dataset.url) ?? "";
  const title = DS(card.dataset.topic) ?? "browser";
  let md = `> [!browser] ${title}\n> url: ${url}`;
  try {
    const tabs = JSON.parse(DS(card.dataset.tabs) || "[]") as {
      url: string;
      title: string;
      bv?: string;
    }[];
    if (tabs.length > 1) {
      md += `\n> atab: ${parseInt(card.dataset.atab ?? "0", 10) || 0}`;
      for (const tb of tabs)
        md +=
          `\n> tab: ${tb.url || "about:blank"} | ${(tb.title || "").replace(/\|/g, "/")}` +
          (tb.bv ? ` | ${tb.bv}` : "");
    }
  } catch { /* tab state is best-effort */ }
  try {
    const tools = JSON.parse(DS(card.dataset.tools) || "[]") as { name: string; js: string }[];
    for (const t of tools)
      if (t?.name && t?.js) md += `\n> tool: ${JSON.stringify({ name: t.name, js: t.js })}`;
  } catch { /* tool state is best-effort */ }
  if (DS(card.dataset.chat)) md += `\n> chat: ${DS(card.dataset.chat)}`;
  /* the live engine id rides the markdown — reopening the note re-attaches
   * the card to the same webview, so playing media survives the switch */
  if (DS(card.dataset.bv)) md += `\n> bv: ${DS(card.dataset.bv)}`;
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
    `<button class="bb-b" data-a="ext" title="extensions — chrome/firefox add-ons & page scripts">🧩</button>` +
    `<span class="bb-exs" title="installed extensions — click a chip to turn it off/on"></span>` +
    `<button class="bb-b bb-snd" data-a="snd" hidden title="audio playing — click to mute">🔊</button>` +
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
    `<div class="bc-bar"><input class="bc-in" maxlength="1200" spellcheck="false" ` +
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

/* ---------- audio: engines that outlive their card ---------- */
/* A parked (note-switched) or visible engine that plays audio shows up in
 * #aud-pill on the titlebar — one click mutes it. mutedPv remembers the
 * intent per engine so fresh page loads re-mute themselves. */
const mutedPv = new Set<string>();
const audioPv = new Map<string, { playing: boolean; muted: boolean; title: string; warm: boolean }>();
/* engine → the note its card lived in — stamped by enhanceCard into
 * dataset.note, refreshed on every claim so a re-parked engine always
 * reports to the right tab (drives the note-tab 🔊 indicator) */
const engineNote = new Map<string, string>();
/* engines parked by a note switch, keyed by url — a revived card whose
 * markdown never caught its bv: line can still re-claim its engine */
const parkedByUrl = new Map<string, string>();

const AUD_JS =
  `(()=>{const ms=[...document.querySelectorAll('video,audio')];` +
  `return JSON.stringify({n:ms.length,` +
  `playing:ms.some(m=>!m.paused&&!m.ended&&(m.readyState>1||m.currentTime>0)),` +
  /* warm — media that has started (currentTime>0) but is now paused:
   * resumable from the note-tab ▶ button; a never-started page earns
   * no beacon */
  `warm:ms.some(m=>m.currentTime>0&&!m.ended),` +
  `muted:ms.length?ms.every(m=>m.muted||m.volume===0):false,` +
  `t:document.title||'',u:location.href})})()`;
/* SPA navigations (youtube video clicks, any pushState routing) never
 * fire pv:nav — so a tab left on a SPA keeps its FIRST url and switching
 * back reloads the wrong page. Every wired card registers a tracker the
 * audio tick feeds the engine's real location.href/document.title into. */
const liveTabs = new Map<string, (u: string, title: string) => void>();
const MUTE_JS = (on: boolean) =>
  `[...document.querySelectorAll('video,audio')].forEach(m=>{m.muted=${on}});'${on ? "muted" : "unmuted"}'`;

const renderAudioPill = () => {
  const pill = document.getElementById("aud-pill");
  if (!pill) return;
  const playing = [...audioPv.entries()].filter(([, a]) => a.playing);
  pill.classList.toggle("hidden", playing.length === 0);
  pill.innerHTML = "";
  for (const [id, a] of playing) {
    const chip = document.createElement("button");
    chip.className = "aud-chip" + (a.muted ? " muted" : "");
    chip.title = `${a.title || "media"} — ${a.muted ? "unmute" : "mute"}`;
    chip.innerHTML =
      `<span class="aud-ic">${a.muted ? "🔇" : "🔊"}</span>` +
      `<span class="aud-t"></span>` +
      `<span class="aud-x" title="stop">×</span>`;
    chip.querySelector(".aud-t")!.textContent = a.title || id;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest(".aud-x")) {
        void invoke("pv_close", { id }).catch(() => {});
        audioPv.delete(id);
        mutedPv.delete(id);
        engineNote.delete(id);
        renderAudioPill();
        return;
      }
      const on = !a.muted;
      if (on) mutedPv.add(id); else mutedPv.delete(id);
      void invoke("pv_eval", { id, js: MUTE_JS(on) }).catch(() => {});
      a.muted = on;
      renderAudioPill();
      paintSndButtons();
    });
    pill.append(chip);
  }
};

/* card-bar 🔊 buttons follow the registry each tick */
const paintSndButtons = () => {
  document.querySelectorAll<HTMLElement>(".browser-card").forEach((c) => {
    const b = c.querySelector<HTMLElement>('[data-a="snd"]');
    if (!b) return;
    const a = audioPv.get(c.dataset.bv ?? "");
    b.hidden = !(a?.playing);
    if (a) {
      b.textContent = a.muted ? "🔇" : "🔊";
      b.title = `${a.title || "audio"} — ${a.muted ? "unmute" : "mute"}`;
    }
  });
};

let audioTimer = 0;
const unclaimedTicks = new Map<string, number>();
const startAudioPoll = () => {
  if (audioTimer) return;
  audioTimer = window.setInterval(async () => {
    const ids = await invoke<string[]>("pv_list").catch(() => [] as string[]);
    /* orphan sweep — an engine with no connected card claiming it must
     * stay hidden: a stray visible surface floats at stale bounds and
     * eats clicks meant for the UI underneath (a "chatbox click" lands
     * on it and navigates the page). Two consecutive ticks so a just-
     * spawned engine isn't hidden mid-wire. */
    const claimed = new Set<string>();
    for (const c of document.querySelectorAll<HTMLElement>(".browser-card")) {
      if (!c.isConnected) continue;
      if (c.dataset.bv) claimed.add(c.dataset.bv);
      try {
        for (const t of JSON.parse(c.dataset.tabs || "[]") as { bv?: string }[])
          if (t.bv) claimed.add(t.bv);
      } catch { /* tab state optional — dataset.bv still covers single-tab cards */ }
    }
    for (const id of ids) {
      if (claimed.has(id)) { unclaimedTicks.delete(id); continue; }
      const n = (unclaimedTicks.get(id) ?? 0) + 1;
      unclaimedTicks.set(id, n);
      if (n >= 2) void invoke("pv_visible", { id, on: false }).catch(() => {});
    }
    for (const id of [...unclaimedTicks.keys()]) if (!ids.includes(id)) unclaimedTicks.delete(id);

    /* parallel evals — a serial loop over many parked engines stretches
     * the effective poll past several seconds and SPA tracking lags */
    await Promise.all(
      ids.map(async (id) => {
        const s = await invoke<string>("pv_eval", { id, js: AUD_JS }).catch(() => "");
        if (!s) return;
        try {
          const st = JSON.parse(JSON.parse(s)) as {
            playing: boolean;
            muted: boolean;
            warm?: boolean;
            t: string;
            u?: string;
          };
          audioPv.set(id, { playing: st.playing, muted: st.muted, title: st.t, warm: st.warm ?? st.playing });
          if (st.u) liveTabs.get(id)?.(st.u, st.t);
        } catch { /* odd page state — skip this engine */ }
      }),
    );
    for (const id of [...audioPv.keys()])
      if (!ids.includes(id)) { audioPv.delete(id); engineNote.delete(id); }
    renderAudioPill();
    paintSndButtons();
    broadcastNoteAudio();
  }, 2000);
};
/* note-tab media beacon: notes owning a live or resumable engine —
 * tabs.ts paints ⏸ (playing, click pauses) or ▶ (paused, click
 * resumes); the tab title still navigates */
const broadcastNoteAudio = () => {
  const noteAudio = new Map<string, { titles: string[]; muted: boolean; playing: boolean }>();
  for (const [id, a] of audioPv) {
    if (!a.playing && !a.warm) continue;
    const note = engineNote.get(id);
    if (!note) continue;
    const n = noteAudio.get(note) ?? { titles: [], muted: true, playing: false };
    n.titles.push(a.title || "media");
    if (!a.muted) n.muted = false;
    if (a.playing) n.playing = true;
    noteAudio.set(note, n);
  }
  document.dispatchEvent(
    new CustomEvent("nav:audio", { detail: [...noteAudio.entries()] }),
  );
};

/* run unconditionally — orphan engines can exist on notes with zero live
 * browser cards (deleted note, crash, stale park), and only the sweep
 * hides them */
startAudioPoll();

/* the note-tab ⏸/▶ beacon: pause every playing engine owned by that
 * note, or resume+unmute when it's all quiet — real playback control,
 * not just a marker (tabs.ts can't import this module, hence the event) */
document.addEventListener("nav:audiotoggle", (e) => {
  const note = (e as CustomEvent<string>).detail;
  if (!note) return;
  const ids = [...engineNote.entries()].filter(([, n]) => n === note).map(([id]) => id);
  const anyPlaying = ids.some((id) => audioPv.get(id)?.playing);
  const js = anyPlaying
    ? `[...document.querySelectorAll('video,audio')].forEach(m=>{try{m.pause()}catch(_){}})`
    : `[...document.querySelectorAll('video,audio')].forEach(m=>{try{m.muted=false;if(m.volume===0)m.volume=.8;const p=m.play();p&&p.catch?p.catch(()=>{}):0}catch(_){}})`;
  for (const id of ids) {
    void invoke("pv_eval", { id, js }).catch(() => {});
    /* flip the beacon now — the 2s tick lands the authoritative state */
    const a = audioPv.get(id);
    if (a) {
      a.playing = !anyPlaying && a.warm;
      if (!anyPlaying) a.muted = false;
    }
  }
  paintSndButtons();
  broadcastNoteAudio();
});

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

  /* tabs — ONE LIVE ENGINE PER TAB: each tab keeps its own url, title,
   * back-stack AND webview, so switching is show/hide, never a reload.
   * bv is "" until the tab first navigates (engines are lazy). */
  interface BTab {
    url: string;
    title: string;
    hist: string[];
    hi: number;
    bv: string;
    at: number; // last-active ms — LRU victim when engines cap out
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
          return {
            url: S(t.url),
            title: S(t.title),
            hist: h,
            hi: Math.min(i, h.length - 1),
            bv: S(t.bv),
            at: 0,
          };
        });
  } catch {
    tabs = [];
  }
  if (!tabs.length)
    tabs = [
      {
        url: DS(card.dataset.url) ?? "",
        title: DS(card.dataset.topic) ?? "",
        hist: [],
        hi: -1,
        bv: "",
        at: 0,
      },
    ];
  let active = Math.min(Math.max(parseInt(card.dataset.atab ?? "0", 10) || 0, 0), tabs.length - 1);
  const cur = () => tabs[active] ?? tabs[0];
  // hist/hi always alias the ACTIVE tab's stack
  let hist = cur().hist;
  let hi = cur().hi;
  let lastPage: PageInfo | null = null;
  // the real engine is the default lane — ◐ drops to the text reader
  let liveOn = true;
  let loading = false;
  /* each tab's bv must be STABLE across rewires — serialized in its tab:
   * line, reclaimed by url as a fallback, or recreated on next activate.
   * The card-level bv: is the ACTIVE tab's engine (back-compat). */
  delete card.dataset.park;
  const normU = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  // the card-level bv belongs to the active tab
  if (!cur().bv && card.dataset.bv) cur().bv = card.dataset.bv;
  for (const t of tabs) {
    if (!t.bv && t.url) {
      const parked = parkedByUrl.get(normU(t.url));
      if (parked) {
        t.bv = parked;
        parkedByUrl.delete(normU(t.url));
      }
    }
  }
  /* a duplicated card carries the source's bvs — two live cards must
   * never share engines (bounds fight). Strip any bv another card owns. */
  const foreign = new Set<string>();
  for (const c of document.querySelectorAll<HTMLElement>(".browser-card")) {
    if (c === card || !c.isConnected) continue;
    if (c.dataset.bv) foreign.add(c.dataset.bv);
    try {
      for (const t of JSON.parse(c.dataset.tabs || "[]") as { bv?: string }[])
        if (t.bv) foreign.add(t.bv);
    } catch { /* unparsed sibling — its dataset.bv still covers it */ }
  }
  for (const t of tabs) if (t.bv && foreign.has(t.bv)) t.bv = "";
  /* dead engines (evicted, crashed, or closed since the note saved) get
   * cleared so their tab falls back to a fresh nav on activate. ONLY the
   * ids parsed at wire time are checked — a bv assigned by nav() during
   * THIS wire is still mid-creation (OPENING claim — not in pv_list yet)
   * and clearing it here orphans every event route for that tab */
  const parsedBvs = new Set(tabs.map((t) => t.bv).filter(Boolean));
  void invoke<string[]>("pv_list")
    .then((ids) => {
      if (!Array.isArray(ids)) return;
      let dirty = false;
      for (const t of tabs)
        if (t.bv && parsedBvs.has(t.bv) && !ids.includes(t.bv)) {
          t.bv = "";
          dirty = true;
        }
      if (dirty) {
        persistTabs();
        renderTabs();
      }
    })
    .catch(() => {});
  const genBv = () => `bv-${Date.now().toString(36)}-${++pvSeq}`;
  /* bvId mirrors the ACTIVE tab's engine — every active-page invoke uses
   * it; sibling engines are only ever hidden/closed by id */
  let bvId = cur().bv;
  card.dataset.bv = bvId;
  startAudioPoll();
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
  /* pushState/SPA navigations never fire pv:nav — stamp the engine's
   * REAL location into the tab that OWNS that engine (a background tab's
   * autoplay nav belongs to it, not the active tab). Mirrors pv:nav. */
  const liveTrack = (id: string, u: string, title: string) => {
    const ti = tabs.findIndex((t) => t.bv === id);
    if (ti < 0) return;
    const t = tabs[ti];
    const act = ti === active;
    if (act && (!liveOn || Date.now() - switchAt < 900)) return;
    if (u && u !== "about:blank" && u !== t.url) {
      t.url = u;
      if (t.hist[t.hi] !== u) {
        t.hist.splice(t.hi + 1);
        t.hist.push(u);
        t.hi = t.hist.length - 1;
      }
      if (act) {
        card.dataset.url = u;
        setLock(u);
        if (urlIn.value !== u) urlIn.value = u;
        onChange();
      }
      persistTabs();
      renderTabs();
    }
    if (title && title !== t.title) {
      t.title = title;
      if (act) {
        card.dataset.topic = title;
        const el = card.querySelector(".callout-title");
        if (el) el.textContent = title;
      }
      renderTabs();
    }
  };
  const claimEng = (id: string) => {
    liveTabs.set(id, (u, t) => liveTrack(id, u, t));
    engineNote.set(id, card.dataset.note ?? "");
  };
  for (const t of tabs) if (t.bv) claimEng(t.bv);
  /* every inactive tab's engine hides — only the active one shows */
  const hideSiblings = () => {
    for (const t of tabs)
      if (t.bv && t !== cur())
        void invoke("pv_visible", { id: t.bv, on: false }).catch(() => {});
  };
  /* engine budget: an idle webview costs ~80MB — beyond the cap, close
   * the least-recently-active background engine; its tab falls back to a
   * real nav on next switch (same as before per-tab engines) */
  const MAX_ENGINES = 8;
  const evictIdle = () => {
    const live = tabs.filter((t) => t.bv);
    if (live.length <= MAX_ENGINES) return;
    const vic = live
      .filter((t) => t !== cur())
      .sort((a, b) => a.at - b.at)[0];
    if (!vic) return;
    void invoke("pv_close", { id: vic.bv }).catch(() => {});
    liveTabs.delete(vic.bv);
    engineNote.delete(vic.bv);
    vic.bv = "";
    persistTabs();
  };
  /* same capture, synchronous-ish, run right before leaving a tab so its
   * stored url is the page the engine is really on — even if the user
   * switched within a poll tick of clicking a SPA link */
  const seizeLive = async () => {
    if (!liveOn) {
      syncTab();
      return;
    }
    try {
      const s = await invoke<string>("pv_eval", {
        id: bvId,
        js: "JSON.stringify({u:location.href,t:document.title})",
      });
      const p = s
        ? (JSON.parse(JSON.parse(s)) as { u?: string; t?: string })
        : null;
      if (p?.u && p.u !== "about:blank" && p.u !== cur().url) {
        cur().url = p.u;
        card.dataset.url = p.u;
        if (hist[hi] !== p.u) {
          hist.splice(hi + 1);
          hist.push(p.u);
          hi = hist.length - 1;
        }
      }
      if (p?.t) {
        cur().title = p.t;
        card.dataset.topic = p.t;
      }
    } catch {
      /* engine mid-nav or dead — keep last-known state */
    }
    syncTab();
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
  /* activate the tab at index `i`: hide every other tab's engine, then
   * show the target's live engine at the card rect — no navigation, no
   * reload, the page kept running. Only a tab whose engine was evicted
   * or never created falls back to nav(). */
  const activateTab = (i: number): Promise<string> | string => {
    const t = cur();
    hist = t.hist;
    hi = t.hi;
    t.at = Date.now();
    card.dataset.url = t.url;
    card.dataset.topic = t.title || "new tab";
    const el = card.querySelector(".callout-title");
    if (el) el.textContent = card.dataset.topic;
    urlIn.value = t.url;
    persistTabs();
    renderTabs();
    paintView();
    hideSiblings();
    bvId = t.bv;
    card.dataset.bv = bvId;
    /* a hidden engine can't own fullscreen — clear a stale __pvFs that
     * points at one of OUR background tabs (another card's fs stays) */
    {
      const w = window as unknown as { __pvFs?: string };
      if (w.__pvFs && w.__pvFs !== bvId && tabs.some((t) => t.bv === w.__pvFs))
        delete w.__pvFs;
    }
    if (fsOn) setFs(false); // the old engine hides — it can't stay fullscreen
    lastBox = "";
    pvSync();
    if (t.bv) return `tab ${i + 1}`;
    if (t.url) return nav(t.url, false);
    say("new tab");
    refocusField(urlIn);
    return "new tab";
  };
  const switchTab = async (i: number, fromUi = false): Promise<string> => {
    if (i < 0 || i >= tabs.length) return `✕ no tab ${i + 1} — ${tabs.length} open`;
    if (i === active) {
      if (fromUi) refocusField(urlIn);
      return `already on tab ${i + 1}`;
    }
    await seizeLive();
    active = i;
    return activateTab(i);
  };
  const newTab = async (input?: string): Promise<string> => {
    const url = input ? toUrl(input) : "";
    await seizeLive();
    tabs.push({ url, title: "", hist: [], hi: -1, bv: "", at: 0 });
    active = tabs.length - 1;
    return activateTab(active);
  };
  const closeTab = (i: number) => {
    if (tabs.length <= 1) return;
    const vic = tabs[i];
    if (vic?.bv) {
      void invoke("pv_close", { id: vic.bv }).catch(() => {});
      liveTabs.delete(vic.bv);
    }
    tabs.splice(i, 1);
    if (active > i) active--;
    else if (active === i) active = Math.min(active, tabs.length - 1);
    void Promise.resolve(activateTab(active)).then(say);
    onChange();
  };

  /* the live lane is a REAL WebView2 composited over .browser-view —
   * window-level surface, not DOM: keep it glued to the card's rect and
   * hide it whenever the card scrolls out, hides, is covered by another
   * floating card, or leaves the note — it has no z-order of its own */
  const dpr = () => window.devicePixelRatio || 1;
  let lastBox = "";
  let coverTicks = 0;
  /* page fullscreen (youtube ⛶ etc.): the child webview is a native HWND —
   * DOM fullscreen succeeds but nothing resizes the surface, so the video
   * stays card-sized. Poll document.fullscreenElement; while a page is
   * fullscreen, window.__pvFs = our id → this card's surface covers the
   * whole window and every other card's surface stays hidden. */
  let fsOn = false;
  let fsTick = 0;
  const fsFlag = () => (window as unknown as { __pvFs?: string }).__pvFs;
  const setFs = (on: boolean) => {
    if (on === fsOn) return;
    fsOn = on;
    const w = window as unknown as { __pvFs?: string };
    if (on) w.__pvFs = bvId;
    else if (w.__pvFs === bvId) delete w.__pvFs;
    void window.__TAURI__?.window
      ?.getCurrentWindow?.()
      .setFullscreen(on)
      .catch(() => {});
    lastBox = "";
    pvSync();
  };
  const pvSync = () => {
    if (!card.isConnected || !bvId) return; // blank tab — no engine to glue
    const fsOwner = fsFlag();
    if (bvId && fsOwner === bvId) {
      // our page owns fullscreen — the surface covers the whole window
      const d = dpr();
      const key = `fs,${window.innerWidth},${window.innerHeight},${d}`;
      if (key === lastBox) return;
      lastBox = key;
      void invoke("pv_bounds", {
        id: bvId, x: 0, y: 0,
        w: Math.max(1, Math.round(window.innerWidth * d)),
        h: Math.max(1, Math.round(window.innerHeight * d)),
      }).catch(() => {});
      void invoke("pv_visible", { id: bvId, on: true }).catch(() => {});
      return;
    }
    if (fsOwner) {
      // a sibling card is fullscreen — our surface must not punch through
      if (lastBox !== "fs-peer") {
        lastBox = "fs-peer";
        void invoke("pv_visible", { id: bvId, on: false }).catch(() => {});
      }
      return;
    }
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
    let ix = Math.max(r.left, clip.left);
    const iy = Math.max(r.top, clipTop);
    let iw = Math.min(r.right, clip.right) - ix;
    const ih = Math.min(r.bottom, clipBot) - iy;
    /* DOM popovers can never beat the native HWND — while the ext panel
     * overlaps the view rect, give the engine only the uncovered slice
     * so the whole panel stays on screen (restored on close) */
    if (!extPop.hidden) {
      const pr = extPop.getBoundingClientRect();
      const ox = Math.min(pr.right, ix + iw) - Math.max(pr.left, ix);
      const oy = Math.min(pr.bottom, iy + ih) - Math.max(pr.top, iy);
      if (ox > 0 && oy > 0) {
        if (pr.left > ix) {
          iw = Math.min(iw, pr.left - ix); // intrudes from the right
        } else if (pr.right < ix + iw) {
          iw -= pr.right - ix;
          ix = pr.right; // intrudes from the left
        } else {
          iw = 0; // panel swallows the whole view
        }
      }
    }
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
      /* DOM detach has two meanings: a real card delete kills the engine,
       * but a note switch (loadNote marks data-park first) PARKS it —
       * hidden, still alive, so playing media keeps going and reopening
       * the note re-glues the same webview without a reload */
      if (++deadTicks >= 2) {
        window.clearInterval(pvTimer);
        ro.disconnect();
        extResize.disconnect();
        window.removeEventListener("resize", extWinFit);
        document.removeEventListener("pointerdown", closeExt);
        document.removeEventListener("keydown", escExt, true);
        if (fsOn) setFs(false); // a dead card can't hold fullscreen
        /* every tab's engine: parked → hidden + re-claimable by url;
         * deleted → closed for real */
        for (const t of tabs) {
          if (!t.bv) continue;
          if (card.dataset.park) {
            if (t.url) parkedByUrl.set(normU(t.url), t.bv);
            void invoke("pv_visible", { id: t.bv, on: false }).catch(() => {});
          } else {
            void invoke("pv_close", { id: t.bv }).catch(() => {});
            engineNote.delete(t.bv);
          }
          liveTabs.delete(t.bv);
        }
        for (const u of unlistens) void u.then((f) => f()).catch(() => {});
      }
      return;
    }
    deadTicks = 0;
    /* page fullscreen check — ~1s cadence, only while the live engine is
     * on. Esc / the site's own exit clears fullscreenElement → setFs(false)
     * drops the window back to normal and pvSync re-glues the surface. */
    if (++fsTick >= 7 && liveOn && !fsOn) {
      fsTick = 0;
      void invoke<string>("pv_eval", {
        id: bvId,
        js: "!!document.fullscreenElement",
      })
        .then((s) => {
          let on = false;
          try { on = !!JSON.parse(s); } catch { on = s === "true"; }
          if (on) setFs(true);
        })
        .catch(() => {});
    } else if (fsOn && fsTick >= 3) {
      fsTick = 0;
      void invoke<string>("pv_eval", {
        id: bvId,
        js: "!!document.fullscreenElement",
      })
        .then((s) => {
          let on = false;
          try { on = !!JSON.parse(s); } catch { on = s === "true"; }
          if (!on) setFs(false);
        })
        .catch(() => setFs(false));
    }
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
    else if (bvId) pvSync();
    else if (cur().url) void nav(cur().url, false).then(say); // engine evicted — rebuild
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
  /* in-tab navigation on the ACTIVE engine: the old page's late events
   * (title churn, delayed loads, a just-in-flight redirect) would stamp
   * back over the page we asked for. leaveTo() starts a short suppression
   * window; stalePv() filters the departing page's events. */
  let switchAt = 0;
  let leaveUrl = "";
  let expectUrl = "";
  const noTrail = (u: string) => u.replace(/\/+$/, "");
  const leaveTo = (target: string) => {
    leaveUrl = card.dataset.url ?? cur().url;
    expectUrl = target;
    switchAt = Date.now();
  };
  const stalePv = (u: string) =>
    Date.now() - switchAt < 900 &&
    (expectUrl ? noTrail(u) === noTrail(leaveUrl) : u !== "about:blank");
  const nav = async (input: string, push: boolean): Promise<string> => {
    const url = toUrl(input);
    if (!url) return "empty address";
    const seq = ++navSeq;
    leaveTo(url);
    say("loading…");
    setLock(url);
    // a blank tab's webview is hidden — claim the url now so pvSync shows
    // it, and repaint so the new-tab placeholder drops out of live mode
    cur().url = url;
    paintView();
    /* a tab with no engine yet gets one on first nav — engines are lazy
     * so blank tabs cost nothing. Budget check first: past the cap, the
     * oldest background engine dies instead */
    if (liveOn && !cur().bv) {
      evictIdle();
      cur().bv = genBv();
      bvId = cur().bv;
      card.dataset.bv = bvId;
      claimEng(bvId);
    }
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
  /* every engine event carries its engine id — route it to the OWNING
   * tab. A background tab's events (autoplay nav, title churn) update
   * its own state; only the active tab's events touch the card chrome */
  const ownTab = (id: string) => {
    const ti = tabs.findIndex((t) => t.bv === id);
    return ti < 0 ? null : { t: tabs[ti], act: ti === active };
  };
  on("pv:nav", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || !card.isConnected || !pay.url) return;
    const o = ownTab(pay.id);
    if (!o) return;
    const { t, act } = o;
    if (act && stalePv(pay.url)) return; // the departed page still talking
    if (pay.url === "about:blank") {
      t.url = "";
      if (act) card.dataset.url = "";
      renderTabs();
      return;
    }
    const u = pay.url;
    t.url = u;
    if (t.hist[t.hi] !== u) {
      t.hist.splice(t.hi + 1);
      t.hist.push(u);
      t.hi = t.hist.length - 1;
    }
    if (!act) {
      persistTabs();
      renderTabs();
      return;
    }
    card.dataset.url = u;
    setLock(u);
    if (urlIn.value !== u) urlIn.value = u;
    hi = t.hi;
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
    if (!pay || !card.isConnected) return;
    const o = ownTab(pay.id);
    if (!o || !o.act) return;
    if (pay.url && stalePv(pay.url)) return;
    setLoading(!pay.done);
    if (pay.done && liveOn) {
      say(`live — ${hostOf(pay.url || card.dataset.url || "")}`);
      void injectScripts(pay.url || card.dataset.url || "");
      /* a muted engine stays muted across navigations */
      if (mutedPv.has(bvId))
        void invoke("pv_eval", { id: bvId, js: MUTE_JS(true) }).catch(() => {});
    }
  });
  // real titles — js-set ones included (fetch can't see them)
  on("pv:title", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || !card.isConnected || !pay.title) return;
    const o = ownTab(pay.id);
    if (!o) return;
    /* store pages flag install clicks through the title channel — the
     * store's own "add to chrome" flow can't finish inside an embedded
     * webview, so the hook asks us to run our real install lane */
    if (pay.title.startsWith("laido-install::")) {
      const url = pay.title.slice("laido-install::".length);
      void invoke<string>("pv_eval", {
        id: pay.id,
        js: "if(window.__laidoKeepT)document.title=window.__laidoKeepT;'r'",
      }).catch(() => {});
      void installFromStore(url);
      return;
    }
    /* titles carry no url — drop every one inside the transition window;
     * the new page's own title arrives after its load */
    if (o.act && Date.now() - switchAt < 900) return;
    o.t.title = pay.title;
    if (o.act) {
      card.dataset.topic = pay.title;
      const t = card.querySelector(".callout-title");
      if (t) t.textContent = pay.title;
    }
    persistTabs();
    renderTabs();
  });
  // downloads — real files land in OS Downloads; trace them
  on("pv:dl", (e: { payload: any }) => {
    const pay = e.payload;
    if (!pay || !ownTab(pay.id)?.act || !card.isConnected) return;
    const name = (pay.path || pay.url).split(/[\\/]/).pop() ?? "file";
    if (pay.done) {
      addActivity(`browser: downloaded ${name}${pay.ok ? "" : " (failed)"}`);
      say(pay.ok ? `downloaded ${name}` : `download failed — ${name}`);
      /* a finished .crx/.xpi IS an extension — install it straight into
       * the profile rather than leaving it inert in Downloads */
      if (pay.ok && pay.path && /\.(crx|xpi)$/i.test(name))
        void installFromPath(pay.path);
    } else {
      addActivity(`browser: downloading ${pay.url}`);
      say(`downloading ${name}…`);
    }
  });

  /* ---------- extensions ---------- */
  interface UScript {
    name: string; enabled: boolean; matches: string[]; js: string; css: string;
  }
  interface NativeExt { id: string; name: string; version: string; desc: string; enabled: boolean }
  /* chrome-style match patterns (e.g. "*://*.youtube.com/x"): `*` becomes `.*`,
   * anything else is literal */
  const matchRe = (m: string): RegExp => {
    const esc = m.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${esc}$`, "i");
  };
  /* every enabled script whose pattern matches the url gets injected once
   * per page (window flag guards re-entry on soft navigations) */
  const injectScripts = async (url: string) => {
    if (!url || !liveOn) return;
    /* store pages get the install-click hook so "add to chrome/firefox"
     * routes to our install lane instead of dying on the page's own
     * download machinery */
    if (/chromewebstore\.google\.com|addons\.mozilla\.org/.test(url))
      void invoke<string>("pv_eval", { id: bvId, js: STORE_HOOK_JS }).catch(() => {});
    const scripts = await invoke<UScript[]>("us_list").catch(() => [] as UScript[]);
    for (const sc of scripts) {
      if (!sc.enabled) continue;
      const pats = sc.matches.length ? sc.matches : ["*://*/*"];
      if (!pats.some((m) => matchRe(m).test(url))) continue;
      const tag = `__laidoExt_${sc.name.replace(/\W+/g, "_")}`;
      const js =
        `(()=>{const T=${JSON.stringify(tag)};if(window[T])return'have';window[T]=1;` +
        (sc.css
          ? `const st=document.createElement('style');st.dataset.laidoExt=${JSON.stringify(sc.name)};st.textContent=${JSON.stringify(sc.css)};(document.head||document.documentElement).append(st);`
          : "") +
        `try{(function(){\n${sc.js}\n})()}catch(e){console.warn('[ext]',e)}return'on'})()`;
      void invoke<string>("pv_eval", { id: bvId, js })
        .then((s) => { if (s && s.includes("on")) say(`🧩 ${sc.name} active on this page`); })
        .catch(() => {});
    }
  };

  /* the extensions popover — two lanes:
   *  page scripts inject instantly; native chrome/firefox add-ons load into
   *  the webview profile at creation, so they apply on the next page/tab
   *  (the apply button force-recreates the engine right away) */
  const extPop = document.createElement("div");
  extPop.className = "bc-ext";
  extPop.contentEditable = "false";
  extPop.hidden = true;
  const closeBtn = document.createElement("button");
  closeBtn.className = "bx-close";
  closeBtn.dataset.x = "close";
  closeBtn.title = "close (Esc)";
  closeBtn.textContent = "×";
  extPop.append(closeBtn);
  card.append(extPop);
  /* installed extensions get a letter chip right of 🧩 — one click on the
   * bar turns an extension off/on without opening the panel (applies to
   * new pages; apply ⟳ restarts the current one) */
  const extChips = bar?.querySelector<HTMLElement>(".bb-exs");
  const refreshExtChips = async () => {
    if (!extChips) return;
    const list = await invoke<NativeExt[]>("ext_list").catch(() => [] as NativeExt[]);
    extChips.innerHTML = "";
    for (const x of list.slice(0, 4)) {
      const b = document.createElement("button");
      b.className = `bb-b bb-ex${x.enabled ? "" : " off"}`;
      b.dataset.exid = x.id;
      b.title = `${x.name} ${x.version} — ${x.enabled ? "on (click to turn off)" : "off (click to turn on)"}`;
      b.textContent = (x.name.trim()[0] ?? "🧩").toUpperCase();
      extChips.append(b);
    }
    if (list.length > 4) {
      const more = document.createElement("button");
      more.className = "bb-b bb-ex bb-exmore";
      more.dataset.x = "more";
      more.title = `${list.length - 4} more — open the extensions panel`;
      more.textContent = `+${list.length - 4}`;
      extChips.append(more);
    }
  };
  extChips?.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".bb-ex");
    if (!b) return;
    if (b.dataset.x === "more") { void toggleExt(true); return; }
    const off = !b.classList.contains("off");
    const r = await invoke<string>("ext_toggle", { id: b.dataset.exid ?? "", on: !off }).catch((x) => String(x));
    if (typeof r === "string" && r) { say(`✕ ${r.slice(0, 80)}`); return; }
    say(`🧩 ${b.title.split(" — ")[0]} ${off ? "off" : "on"} — applies to new pages (apply ⟳ = this page)`);
    void refreshExtChips();
    if (!extPop.hidden) void renderExt();
  });
  void refreshExtChips();
  const reopenEngine = async (): Promise<string> => {
    const r = view.getBoundingClientRect();
    const d = dpr();
    const u = cur().url;
    await invoke("pv_close", { id: bvId }).catch(() => {});
    await new Promise((r2) => setTimeout(r2, 250));
    if (!u) return "no page to reload";
    await invoke("pv_open", {
      id: bvId, url: u,
      x: Math.round(r.left * d), y: Math.round(r.top * d),
      w: Math.round(Math.max(1, r.width) * d), h: Math.round(Math.max(1, r.height) * d),
    }).catch((e) => String(e));
    lastBox = "";
    pvSync();
    return "engine restarted — extensions active";
  };
  const renderExt = async () => {
    const [nat, us] = await Promise.all([
      invoke<NativeExt[]>("ext_list").catch(() => [] as NativeExt[]),
      invoke<UScript[]>("us_list").catch(() => [] as UScript[]),
    ]);
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    extPop.innerHTML =
      `<div class="bx-sec">page scripts — inject into pages instantly</div>` +
      (us.length
        ? us.map((s) =>
            `<div class="bx-row"><label class="bx-l"><input type="checkbox" class="bx-tog" data-n="${esc(s.name)}"${s.enabled ? " checked" : ""}/><span class="bx-n" title="${esc(s.matches.join(", "))}">${esc(s.name)}</span></label><button class="bx-del" data-n="${esc(s.name)}" title="delete">×</button></div>`,
          ).join("")
        : `<div class="bx-none">none yet — ask the AI to make one, or upload a file</div>`) +
      `<div class="bx-actions"><button class="bx-b" data-x="usup">＋ upload .js / .css / .json</button><button class="bx-b" data-x="mkai">✦ ask AI to build one</button></div>` +
      `<div class="bx-sec">chrome / firefox extensions — load on next page</div>` +
      (nat.length
        ? nat.map((x) =>
            `<div class="bx-row${x.enabled ? "" : " off"}"><label class="bx-l"><input type="checkbox" class="nx-tog" data-n="${esc(x.id)}"${x.enabled ? " checked" : ""}/><span class="bx-n" title="${esc(x.desc)}">${esc(x.name)} <em>${esc(x.version)}</em></span></label><button class="nx-del" data-n="${esc(x.id)}" title="remove">×</button></div>`,
          ).join("")
        : `<div class="bx-none">none installed — open a store page in this card then press “install this page”, or upload a file</div>`) +
      `<div class="bx-actions"><input class="bx-url" placeholder="store link or .crx/.xpi url…"/><button class="bx-b" data-x="insturl">install</button></div>` +
      `<div class="bx-actions"><button class="bx-b" data-x="instpage">install this page</button><button class="bx-b" data-x="natup">upload .crx/.xpi/.zip/folder</button><button class="bx-b" data-x="apply">apply ⟳</button></div>` +
      `<div class="bx-actions"><button class="bx-b" data-x="cws">⌕ chrome store</button><button class="bx-b" data-x="amo">🦊 firefox add-ons</button></div>`;
    /* the × survives every re-render — always an exit, even while the
     * list is still loading */
    extPop.prepend(closeBtn);
    void refreshExtChips(); // the toolbar chips mirror the same list
  };
  /* keep the popover inside the visible area — the card's right edge can
   * sit past the pane (resized wider than the window, narrow windows) and
   * a `right:6px` anchor clips against overflow:hidden ancestors. Bound
   * to #note-body ∩ the viewport — the window edge is the ultimate clip.
   * Runs on open AND every card/window resize while visible. */
  const fitExt = () => {
    extPop.style.right = "";
    extPop.style.left = "";
    extPop.style.top = "";
    extPop.style.width = "";
    extPop.style.maxHeight = "";
    const clipEl = card.closest<HTMLElement>("#note-body") ?? document.body;
    const clr = clipEl.getBoundingClientRect();
    const clip = {
      left: Math.max(clr.left, 0),
      right: Math.min(clr.right, window.innerWidth),
      top: Math.max(clr.top, 0),
      bottom: Math.min(clr.bottom, window.innerHeight),
    };
    const cr = card.getBoundingClientRect();
    let pr = extPop.getBoundingClientRect();
    if (pr.right > clip.right - 6) {
      extPop.style.right = `${cr.right - (clip.right - 6)}px`;
      pr = extPop.getBoundingClientRect();
    }
    if (pr.left < clip.left + 6) {
      extPop.style.width = `${Math.max(200, pr.right - (clip.left + 6))}px`;
      pr = extPop.getBoundingClientRect();
    }
    if (pr.top < clip.top + 6) {
      extPop.style.top = `${clip.top + 6 - cr.top}px`;
      pr = extPop.getBoundingClientRect();
    }
    const room = clip.bottom - pr.top - 8;
    if (room < 380) extPop.style.maxHeight = `${Math.max(120, room)}px`;
    /* the engine must re-cut its surface around the panel's new rect */
    pvSync();
  };
  /* re-fit whenever geometry changes while open — card resizes/drags and
   * window resizes can each shove the anchor point off-screen */
  const extResize = new ResizeObserver(() => {
    if (!extPop.hidden) fitExt();
  });
  extResize.observe(card);
  const extWinFit = () => { if (!extPop.hidden) fitExt(); };
  window.addEventListener("resize", extWinFit);
  /* dismiss paths — the panel must close on ×, Escape, or a click
   * anywhere outside it (extPop's own pointerdown stopPropagation
   * shields inside clicks; the 🧩 button toggles itself) */
  const closeExt = (e: PointerEvent) => {
    if (extPop.hidden) return;
    if ((e.target as HTMLElement).closest('[data-a="ext"]')) return;
    void toggleExt(false);
  };
  document.addEventListener("pointerdown", closeExt);
  const escExt = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || extPop.hidden) return;
    e.stopPropagation();
    void toggleExt(false);
  };
  /* capture phase — the card head's own keydown handler stopPropagations
   * every key (typing isolation), which would swallow Escape typed into
   * the url input before it ever bubbles to document */
  document.addEventListener("keydown", escExt, true);
  const toggleExt = async (on: boolean) => {
    extPop.hidden = !on;
    bar.querySelector('[data-a="ext"]')?.classList.toggle("on", on);
    if (!on) pvSync(); // restore the full surface when the panel closes
    if (on) {
      /* the engine may hold OS keyboard focus — Escape/Esc can't reach
       * the panel's document listener until the main webview takes it */
      void invoke("pv_focus_main").catch(() => {});
      fitExt();
      await renderExt().catch(() => {});
      fitExt();
    }
  };
  /* a store-page click or an extension download resolved to a real
   * install — show the payoff: status + the panel listing it */
  const installFromStore = async (url: string) => {
    say("installing extension…");
    const n = await invoke<string>("ext_install_url", { url })
      .catch((e) => `✕ ${String(e).slice(0, 110)}`);
    if (n.startsWith("✕")) { say(n); return; }
    say(`🧩 “${n}” installed — loads into new pages (⟳ apply = now)`);
    addActivity(`browser: installed extension “${n}”`);
    void toggleExt(true);
  };
  const installFromPath = async (path: string) => {
    const n = await invoke<string>("ext_install_path", { path })
      .catch((e) => `✕ ${String(e).slice(0, 110)}`);
    if (n.startsWith("✕")) { say(n); return; }
    say(`🧩 “${n}” installed from ${path.split(/[\\/]/).pop()} — ⟳ apply loads it`);
    addActivity(`browser: installed extension “${n}”`);
    void toggleExt(true);
  };
  /* injected into store pages: their install button runs the browser's
   * own add-to-chrome machinery — which doesn't exist here, so the page
   * just reports "download interrupted". Capture the click and flag the
   * host through document.title → pv:title → our real install lane. */
  const STORE_HOOK_JS =
    `(()=>{if(window.__laidoInst)return'have';window.__laidoInst=1;` +
    `document.addEventListener('click',(e)=>{` +
    `const el=e.target&&e.target.closest?e.target.closest('button,a,[role="button"],[role="link"]'):null;` +
    `if(!el)return;const host=location.hostname;` +
    `const cws=host==='chromewebstore.google.com';` +
    `const amo=host==='addons.mozilla.org';` +
    `if(!cws&&!amo)return;` +
    `const txt=((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.title||'')).toLowerCase();` +
    `const cls=String(el.className||'').toLowerCase();` +
    `const hit=(cws&&/add to chrome|install/.test(txt))||` +
    `(amo&&(/add to firefox|install/.test(txt)||/installbutton|button--download/.test(cls)));` +
    `if(!hit)return;e.preventDefault();e.stopImmediatePropagation();` +
    `window.__laidoKeepT=document.title;` +
    `document.title='laido-install::'+location.href;` +
    `},true);return'on'})()`;
  extPop.addEventListener("pointerdown", (e) => e.stopPropagation());
  /* checkbox toggles live on `change`, not click — the click handler's
   * preventDefault would revert the check; change fires after the state
   * settles (label clicks dispatch it on the control too) */
  extPop.addEventListener("change", async (e) => {
    const el = e.target as HTMLElement;
    const tog = el.closest<HTMLInputElement>(".bx-tog");
    if (tog) {
      await invoke("us_toggle", { name: tog.dataset.n ?? "", on: tog.checked }).catch(() => {});
      say(`${tog.checked ? "enabled" : "paused"} “${tog.dataset.n}”`);
      return;
    }
    const ntog = el.closest<HTMLInputElement>(".nx-tog");
    if (ntog) {
      const r = await invoke<string>("ext_toggle", { id: ntog.dataset.n ?? "", on: ntog.checked }).catch((x) => String(x));
      if (typeof r === "string" && r) { say(`✕ ${r.slice(0, 80)}`); ntog.checked = !ntog.checked; return; }
      say(`🧩 extension ${ntog.checked ? "on" : "off"} — applies to new pages (apply ⟳ = this page)`);
      ntog.closest(".bx-row")?.classList.toggle("off", !ntog.checked);
      void refreshExtChips();
    }
  });
  extPop.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    /* labels/inputs: let the default toggle run (change handler takes it);
     * preventDefault here would cancel the activation */
    if (el.closest("input,label")) { e.stopPropagation(); return; }
    e.preventDefault();
    e.stopPropagation();
    const del = el.closest<HTMLElement>(".bx-del");
    if (del) {
      await invoke("us_remove", { name: del.dataset.n ?? "" }).catch(() => {});
      await renderExt();
      return;
    }
    const ndel = el.closest<HTMLElement>(".nx-del");
    if (ndel) {
      await invoke("ext_remove", { id: ndel.dataset.n ?? "" }).catch(() => {});
      await renderExt();
      return;
    }
    const act = el.closest<HTMLElement>("[data-x]")?.dataset.x;
    if (!act) return;
    if (act === "close") { void toggleExt(false); return; }
    const dlg = window.__TAURI__?.dialog;
    if (act === "usup" && dlg) {
      const p = await dlg.open({
        multiple: false,
        filters: [{ name: "page script", extensions: ["js", "css", "json", "user.js"] }],
      });
      if (typeof p === "string") {
        const n = await invoke<string>("us_upload", { path: p }).catch((e) => `✕ ${String(e).slice(0, 90)}`);
        say(`🧩 script “${n}” ready — injects on matching pages`);
        void injectScripts(cur().url);
        await renderExt();
      }
    } else if (act === "mkai") {
      setChatOpen(true);
      refocusField(chatIn);
      chatIn!.value = "make a page extension that ";
    } else if (act === "insturl") {
      const u = extPop.querySelector<HTMLInputElement>(".bx-url")?.value.trim() ?? "";
      if (!u) { say("paste a store link or .crx url first"); return; }
      say("installing…");
      const n = await invoke<string>("ext_install_url", { url: u }).catch((e) => `✕ ${String(e).slice(0, 110)}`);
      say(n.startsWith("✕") ? n : `🧩 “${n}” installed — loads into new pages (⟳ apply = now)`);
      await renderExt();
    } else if (act === "instpage") {
      const u = cur().url;
      if (!/chromewebstore\.google\.com|addons\.mozilla\.org/.test(u)) {
        say("open a chrome web store or firefox add-ons page in this card first");
        return;
      }
      say("installing…");
      const n = await invoke<string>("ext_install_url", { url: u }).catch((e) => `✕ ${String(e).slice(0, 110)}`);
      say(n.startsWith("✕") ? n : `🧩 “${n}” installed — loads into new pages (⟳ apply = now)`);
      await renderExt();
    } else if (act === "natup" && dlg) {
      const p = await dlg.open({
        multiple: false,
        filters: [{ name: "extension", extensions: ["crx", "xpi", "zip"] }],
      });
      if (typeof p === "string") {
        say("installing…");
        const n = await invoke<string>("ext_install_path", { path: p }).catch((e) => `✕ ${String(e).slice(0, 110)}`);
        say(n.startsWith("✕") ? n : `🧩 “${n}” installed — loads into new pages (⟳ apply = now)`);
        await renderExt();
      }
    } else if (act === "apply") {
      say("restarting the page engine…");
      say(await reopenEngine());
    } else if (act === "cws" || act === "amo") {
      const q = extPop.querySelector<HTMLInputElement>(".bx-url")?.value.trim() ?? "";
      const base = act === "cws"
        ? "https://chromewebstore.google.com/search/"
        : "https://addons.mozilla.org/en-US/firefox/search/?q=";
      void nav(base + encodeURIComponent(q), true).then(say);
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
    else if (a === "ext") void toggleExt(extPop.hidden);
    else if (a === "snd") {
      const on = !mutedPv.has(bvId);
      if (on) mutedPv.add(bvId); else mutedPv.delete(bvId);
      void invoke<string>("pv_eval", { id: bvId, js: MUTE_JS(on) }).then(say).catch(() => {});
      const a2 = audioPv.get(bvId);
      if (a2) { a2.muted = on; renderAudioPill(); }
      b.textContent = on ? "🔇" : "🔊";
    }
    else if (a === "chat") setChatOpen(chatPane ? chatPane.hidden : true);
  });
  status.addEventListener("click", () => {
    if (status.dataset.live) setMode(true);
  });
  urlIn.addEventListener("keydown", (e) => {
    e.stopPropagation();
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
  let asking = false;
  let idlePlaceholder = "";
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

  /* a compact live digest of the page as the user sees it — read through
   * the real DOM so post-js content (ai overviews, rendered tables) is
   * what the model gets. Falls back to the fetch lane when the engine
   * isn't up. Lets "summarize this" answer in one call, no fence. */
  const digestPage = async (): Promise<string> => {
    try {
      const s = await invoke<string>("pv_eval", {
        id: bvId,
        js:
          `(() => { const pick=(x)=>[...document.querySelectorAll(x)]` +
          `.map(e=>e.textContent.trim()).filter(Boolean).slice(0,10);` +
          `const m=document.querySelector('main,[role=main],article')||document.body;` +
          `return {t:document.title,u:location.href,` +
          `d:document.querySelector('meta[name=description]')?.content||'',` +
          `h:pick('h1,h2'),text:(m.innerText||'').replace(/\\s+/g,' ').slice(0,2200)}; })()`,
      });
      const d = JSON.parse(s) as { t?: string; u?: string; d?: string; h?: string[]; text?: string };
      return (
        `LIVE PAGE RIGHT NOW — title "${d.t ?? ""}", url ${d.u ?? ""}` +
        `${d.d ? `, desc "${d.d}"` : ""}.` +
        `${d.h?.length ? ` headings: ${d.h.join(" | ")}.` : ""}` +
        `${d.text ? ` text: ${d.text}` : ""}`
      );
    } catch {
      const t = lastPage?.text?.slice(0, 1800);
      return t ? `page text (fetch lane): ${t}` : "";
    }
  };
  const askBrowser = async (q: string) => {
    if (!chatIn) return;
    asking = true;
    idlePlaceholder ??= chatIn.placeholder;
    chatIn.placeholder = "ai is answering…";
    const pend = chatAdd("wait", "…");
    const title = card.dataset.topic ?? "browser";
    const digest = await digestPage();
    const others =
      `browser "${title}" on ${cur().url || "(blank tab)"} — a REAL webview2 ` +
      `page (js ran, post-render dom). Tabs: ` +
      `${tabs.map((t) => t.url || "blank").join(", ") || "one"}. ` +
      `Saved tools: ${tools.map((t) => t.name).join(", ") || "none"}.\n` +
      `${digest}\n` +
      `The user asks about THIS card. Answer page questions from the live ` +
      `digest above — no fence needed for "summarize/what does it say". ` +
      `Emit a \`\`\`browser fence aimed at "${title}" only when you need data ` +
      `the digest lacks, or to ACT (navigate/click/tab/tool/clip/grab). ` +
      `Answering an action request with prose alone does NOTHING — no fence, ` +
      `no action. ` +
      `Verbs: read/extract/tables/click/eval/navigate/back/forward/` +
      `tabs/newtab/tab/clip/bookmark/search/open. Multi-step asks chain in ` +
      `one reply: \`tab ${title} 2\` then \`extract ${title}\`. Save a ` +
      `reusable page tool with \`tool ${title} {"name":"x","js":"…"}\` ` +
      `(js runs in the page, JSON back) then \`runtool ${title} x\`; ` +
      `tooldel removes. Other widgets use their own \`\`\` fences with a ` +
      `\`new <title>\` verb. Keep answers short — this is a side panel.`;
    interface BrowserAi {
      text: string; sheet: string[]; slides: string[]; todo: string[];
      chart: string[]; cards: string[]; maps: string[]; base: string[];
      browser: string[]; laido: string[];
    }
    try {
      const { runWidgetFence } = await import("./term.js");
      const kinds: [keyof BrowserAi, string][] = [
        ["browser", "browser"], ["sheet", "sheet"], ["slides", "slides"],
        ["todo", "todo"], ["chart", "chart"], ["cards", "cards"],
        ["maps", "map"], ["base", "base"],
      ];
      /* run every fence a reply carries; outs collect for the narration
       * pass, nav-class verbs wait for the page to settle first */
      const dispatch = async (r: BrowserAi): Promise<{ outs: string[]; readBack: boolean }> => {
        const outs: string[] = [];
        let readBack = false;
        for (const [field, kind] of kinds) {
          for (const body of (r[field] as string[]) ?? []) {
            const out = await runWidgetFence(kind, body);
            const head = body.trim().split("\n")[0];
            outs.push(`${kind}: ${head} → ${out}`);
            chatAdd("out", out);
            const v = (head.split(/\s+/)[0] ?? "").toLowerCase();
            if (kind === "browser" && /^(read|get|extract|data|digest|tables|table|eval|js|runtool|click|links|tabs|list)$/.test(v))
              readBack = true;
            if (kind === "browser" && /^(open|new|navigate|go|goto|back|forward|fwd|tab|newtab|closetab|click)$/.test(v)) {
              const t0 = Date.now();
              while (loading && Date.now() - t0 < 9000)
                await new Promise((r) => setTimeout(r, 150));
            }
            void window.__TAURI__?.event?.emit("agent:activity", {
              text: `browser ✦ ${title}: ${kind} ${head.slice(0, 60)}`,
            });
          }
        }
        return { outs, readBack };
      };
      const r = await invoke<BrowserAi>("term_ai", {
        prompt: q, history: chatHist.slice(-8), others,
        model: null, persona: null,
      });
      chatHist.push({ role: "user", content: q });
      if (r.text.trim()) chatHist.push({ role: "assistant", content: r.text });
      pend?.remove();
      const first = await dispatch(r);
      const outs = [...first.outs];
      let readBack = first.readBack;
      /* the task asked for an action (open/switch/run/…) but the model
       * replied with prose and no fence — narrating does nothing, so push
       * back once and make it emit the fence. One pass, no loops. */
      let tail = r.text.trim();
      if (!outs.length && /\b(open|new tab|switch|navigate|go to|visit|load|browse|click|grab|delete|close|runtool|create|make)\b/i.test(q)) {
        const rc = await invoke<BrowserAi>("term_ai", {
          prompt: `you described doing something but emitted no fence — narrating does nothing. emit the needed \`\`\`browser fence(s) now (or say plainly why not): ${q}`,
          history: chatHist.slice(-8), others, model: null, persona: null,
        });
        const more = await dispatch(rc);
        outs.push(...more.outs);
        readBack = readBack || more.readBack;
        if (rc.text.trim()) {
          chatHist.push({ role: "assistant", content: rc.text });
          tail = rc.text.trim();
        }
      }
      const hadErr = outs.some((o) => o.includes("→ ✕"));
      if ((readBack || hadErr) && outs.length) {
        // "what does the page say about X?" — feed the result back for a
        // spoken answer, not raw tool output; a ✕ step gets explained or
        // retried instead of the model claiming a switch that never ran
        const r2 = await invoke<BrowserAi>("term_ai", {
          prompt: `browser tool results:\n${outs.join("\n")}\n${hadErr ? "a step failed (✕) — say so briefly and what to fix, don't claim it worked. " : ""}answer the original request: ${q}`,
          history: chatHist.slice(-8), others: "", model: null, persona: null,
        });
        if (r2.text.trim()) {
          chatHist.push({ role: "assistant", content: r2.text });
          chatAdd("ai", r2.text.trim());
        } else chatAdd("out", outs.join(" · "));
      } else if (!outs.length) {
        chatAdd(tail ? "ai" : "err", tail || "no action came back — try rephrasing");
      } else if (tail) {
        chatAdd("ai", tail);
      }
    } catch (e) {
      pend?.remove();
      chatAdd("err", `✕ ${String(e).slice(0, 140)}`);
    } finally {
      asking = false;
      chatIn.placeholder = idlePlaceholder;
      refocusField(chatIn);
    }
  };
  chatIn?.addEventListener("keydown", (e) => {
    e.stopPropagation(); // widget keys never reach note-level chip/picker logic
    if (e.key === "Enter") {
      e.preventDefault();
      if (asking) return; // one in-flight ask — the field stays editable
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
          void injectScripts(cur().url);
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
