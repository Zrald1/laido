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
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(clean)}`;
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
    `<div class="browser-bar">` +
    `<button class="bb-b" data-a="back" title="back">◀</button>` +
    `<button class="bb-b" data-a="fwd" title="forward">▶</button>` +
    `<button class="bb-b" data-a="re" title="reload">⟳</button>` +
    `<input class="bb-url" spellcheck="false" placeholder="url or search…"/>` +
    `<button class="bb-b" data-a="mode" title="toggle reader / live view">◐</button>` +
    `<button class="bb-b" data-a="clip" title="clip page text (or selection) into the note">⇲</button>` +
    `<button class="bb-b" data-a="bm" title="save to bookmarks.laido">★</button>` +
    `<button class="bb-b" data-a="win" title="open in a real window">⧉</button>` +
    `</div>` +
    `<div class="browser-view">` +
    `<iframe class="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>` +
    `<div class="browser-reader"></div>` +
    `</div>` +
    `<div class="browser-status">idle</div>`
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
  mode(): string;
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

export function wireBrowser(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.browserWired) return;
  card.dataset.browserWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("browser:changed", { bubbles: true }));
  const bar = card.querySelector<HTMLElement>(".browser-bar");
  const urlIn = card.querySelector<HTMLInputElement>(".bb-url");
  const frame = card.querySelector<HTMLIFrameElement>(".browser-frame");
  const reader = card.querySelector<HTMLElement>(".browser-reader");
  const status = card.querySelector<HTMLElement>(".browser-status");
  if (!bar || !urlIn || !frame || !reader || !status) return;

  const hist: string[] = [];
  let hi = -1;
  let lastPage: PageInfo | null = null;
  let liveOn = false;

  const say = (msg: string) => {
    status.textContent = msg;
  };

  const setMode = (live: boolean) => {
    liveOn = live;
    frame.style.display = live ? "" : "none";
    reader.style.display = live ? "none" : "";
    bar.querySelector('[data-a="mode"]')?.classList.toggle("on", live);
  };

  const renderReader = (p: PageInfo) => {
    const links = (p.links ?? [])
      .slice(0, 40)
      .map(
        ([t, u]) =>
          `<a class="br-link" href="#" data-u="${escHtml(u)}">${escHtml(t)}</a>`,
      )
      .join("");
    reader.innerHTML =
      `<div class="br-title">${escHtml(p.title || p.final_url || "")}</div>` +
      `<div class="br-url">${escHtml(p.final_url ?? "")}</div>` +
      (links ? `<div class="br-links">${links}</div>` : "") +
      `<div class="br-text">${escHtml(p.text ?? "").replace(/\n/g, "<br>")}</div>`;
    reader.querySelectorAll<HTMLElement>(".br-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void nav(a.dataset.u ?? "", true);
      });
    });
  };

  const nav = async (input: string, push: boolean): Promise<string> => {
    const url = toUrl(input);
    if (!url) return "empty address";
    say("loading…");
    let p: PageInfo;
    try {
      p = await invoke<PageInfo>("page_fetch", { url });
    } catch (e) {
      say(`failed: ${String(e)}`);
      return `fetch failed: ${String(e)}`;
    }
    lastPage = p;
    card.dataset.url = p.final_url ?? "";
    if (urlIn.value !== p.final_url) urlIn.value = p.final_url ?? "";
    if (p.title) {
      card.dataset.topic = p.title;
      const t = card.querySelector(".callout-title");
      if (t) t.textContent = p.title;
    }
    renderReader(p);
    if (!p.blocked && (p.status === 0 || (p.status >= 200 && p.status < 400))) {
      frame.src = p.final_url;
      setMode(true);
      say(`live — ${p.status || "ok"}`);
    } else {
      frame.removeAttribute("src");
      setMode(false);
      say(p.blocked ? `reader — ${p.final_url.split("/")[2] ?? "site"} blocks embeds` : `reader — http ${p.status}`);
    }
    if (push) {
      hist.splice(hi + 1);
      hist.push(p.final_url);
      hi = hist.length - 1;
    }
    onChange();
    return `${p.title || p.final_url} — ${p.text.length} chars${p.blocked ? " (reader)" : " (live)"}`;
  };

  const navHist = async (d: number): Promise<string> => {
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
    else if (a === "re") void nav(card.dataset.url ?? urlIn.value, false).then(say);
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
    else if (a === "win") {
      const u = card.dataset.url ?? urlIn.value;
      const ww = window.__TAURI__?.webviewWindow?.WebviewWindow;
      if (ww && u) {
        const w = new ww(`laido-web-${Date.now()}`, { url: u, title: card.dataset.topic ?? "browser", width: 980, height: 720 });
        void w;
        addActivity(`browser: opened ${u} in a window`);
      } else if (u) {
        window.open(u, "_blank");
      }
    }
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
    mode: () => (liveOn ? "live" : "reader"),
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
      return clipBookmark(p.title || p.final_url, p.final_url);
    },
  });
}

/** append a bookmark line to `bookmarks.laido`, creating + deduping */
async function clipBookmark(title: string, url: string): Promise<string> {
  const name = "bookmarks";
  let cur = "";
  try {
    cur = await invoke<string>("vault_read", { name });
  } catch {
    cur = `# Bookmarks\n\n`;
  }
  if (cur.includes(`(${url})`)) return `already bookmarked — ${title}`;
  const next = `${cur.trimEnd()}\n- [ ] [${title.replace(/[\[\]\n]/g, " ")}](${url})\n`;
  await invoke("vault_write", { name, content: next });
  return `bookmarked ${title} → bookmarks.laido`;
}
