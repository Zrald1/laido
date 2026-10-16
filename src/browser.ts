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

/** `[!browser] title` + `url: …` lines → card fields */
export function parseBrowser(block: string[]): { title: string; url: string } {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim();
  let url = "";
  for (const raw of block.slice(1)) {
    const m = raw.trim().match(/^url:\s*(\S+)/i);
    if (m) url = m[1];
  }
  return { title: title || "browser", url };
}

export function browserToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const url = DS(card.dataset.url) ?? "";
  const title = DS(card.dataset.topic) ?? "browser";
  return `> [!browser] ${title}\n> url: ${url}`;
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
    `</div>` +
    `<div class="browser-view">` +
    `<div class="browser-reader"></div>` +
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

  const hist: string[] = [];
  let hi = -1;
  let lastPage: PageInfo | null = null;
  // the real engine is the default lane — ◐ drops to the text reader
  let liveOn = true;
  let loading = false;
  const bvId = `bv-${Date.now().toString(36)}-${++pvSeq}`;
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

  /* the live lane is a REAL WebView2 composited over .browser-view —
   * window-level surface, not DOM: keep it glued to the card's rect and
   * hide it whenever the card scrolls out, hides, or leaves the note */
  const dpr = () => window.devicePixelRatio || 1;
  let lastBox = "";
  const pvSync = () => {
    if (!card.isConnected) return;
    const r = view.getBoundingClientRect();
    const clipEl = card.closest<HTMLElement>("#note-body") ?? document.body;
    const clip = clipEl.getBoundingClientRect();
    const vis =
      liveOn && r.width > 8 && r.height > 8 &&
      r.top >= clip.top - 2 && r.bottom <= clip.bottom + 2 &&
      r.left >= clip.left - 2 && r.right <= clip.right + 2;
    const d = dpr();
    const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${vis},${d}`;
    if (key === lastBox) return;
    lastBox = key;
    void invoke("pv_bounds", {
      id: bvId,
      x: Math.round(r.left * d), y: Math.round(r.top * d),
      w: Math.round(r.width * d), h: Math.round(r.height * d),
    }).catch(() => {});
    void invoke("pv_visible", { id: bvId, on: vis }).catch(() => {});
  };
  let deadTicks = 0;
  const pvTimer = window.setInterval(() => {
    if (!card.isConnected) {
      // DOM detach = note switch or card delete → the webview must die
      if (++deadTicks >= 2) {
        window.clearInterval(pvTimer);
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

  reader.style.display = "none";
  bar.querySelector('[data-a="mode"]')?.classList.add("on");

  const setMode = (live: boolean) => {
    liveOn = live;
    lastBox = "";
    reader.style.display = live ? "none" : "";
    bar.querySelector('[data-a="mode"]')?.classList.toggle("on", live);
    if (!live) void invoke("pv_visible", { id: bvId, on: false }).catch(() => {});
    else pvSync();
  };

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
    // the real engine opens immediately — XFO/walls can't touch it; the
    // fetch lane runs in parallel for the AI's text + the reader view
    if (liveOn) {
      setLoading(true);
      void pvOpen(url).catch((e) => {
        setLoading(false);
        setMode(false);
        say(`live view failed — reader: ${String(e)}`);
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
    setLock(u);
    if (urlIn.value !== u) urlIn.value = u;
    if (hist[hi] !== u) {
      hist.splice(hi + 1);
      hist.push(u);
      hi = hist.length - 1;
    }
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

  // restore persisted address
  if (card.dataset.url) {
    urlIn.value = card.dataset.url;
    void nav(card.dataset.url, true).then(say);
  }

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
