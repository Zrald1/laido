import { parseSheetLine } from "./sheet.js";
import { mapCallout } from "./map.js";
import { agendaCallout } from "./agenda.js";
import { graphCallout } from "./graph.js";
import { canvasCallout } from "./canvas.js";
import { baseCallout } from "./base.js";
import { parseDeck, deckInnerHtml } from "./slides.js";
import { parseTodo, todoInnerHtml } from "./todo.js";
import { parseBrowser, browserInnerHtml } from "./browser.js";
import { parseChart, chartInnerHtml } from "./chart.js";
import { parseCards, cardsInnerHtml, h8 } from "./cards.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const katexApi = () =>
  (window as unknown as {
    katex?: { renderToString: (tex: string, opts?: object) => string };
  }).katex;

/** LaTeX → rendered HTML via KaTeX; the source rides along in data-tex so
 *  inlineToMd can round-trip it back to \[…\] / \(…\) on save */
function renderTex(tex: string, display: boolean): string {
  const meta = ` data-tex="${attr(tex)}"${display ? ' data-disp="1"' : ""}`;
  const k = katexApi();
  if (!k) return `<code class="tex"${meta}>${esc(tex)}</code>`;
  try {
    return `<span class="tex"${meta}>${k.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
    })}</span>`;
  } catch {
    return `<code class="tex"${meta}>${esc(tex)}</code>`;
  }
}

/** gather a multi-line \[ … \] block starting at lines[i]; returns
 *  { tex, end } — end is the index of the line holding \] */
function texBlock(lines: string[], i: number): { tex: string; end: number } | null {
  const buf: string[] = [];
  for (let j = i; j < lines.length; j++) {
    buf.push(lines[j]);
    if (j > i && lines[j].includes("\\]")) return { tex: unwrapTex(buf), end: j };
    if (j === i && lines[j].includes("\\]", lines[j].indexOf("\\[") + 2)) return null; // single-line — inline() covers it
    if (j - i > 40) return null;
  }
  return buf.length > 1 ? { tex: unwrapTex(buf), end: i + buf.length - 1 } : null;
}

function unwrapTex(buf: string[]): string {
  return buf
    .join("\n")
    .replace(/^[\s\S]*?\\\[/, "")
    .replace(/\\\][\s\S]*$/, "")
    .trim();
}

function inline(s: string): string {
  const links: string[] = [];
  const math: string[] = [];
  // LaTeX first — before the link esc() pass can tangle \[ \( \) with links
  let h = s.replace(
    /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$/g,
    (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
      math.push(renderTex((a ?? b ?? c ?? "").trim(), a !== undefined || c !== undefined));
      return `${math.length - 1}`;
    },
  );
  h = h.replace(
    /!\[([^\]]*)\]\(((?:attachments\/|https?:\/\/)[^()\s]+)\)/g,
    (_m, altRaw: string, src: string) => {
      // Obsidian sizing: `![alt|300](x)` or `![alt|300x200](x)`
      let alt = altRaw;
      let dims = "";
      const sz = altRaw.match(/^(.*)\|(\d+)(?:x(\d+))?$/s);
      if (sz) {
        alt = sz[1];
        dims = ` width="${sz[2]}"${sz[3] ? ` height="${sz[3]}"` : ""}`;
      }
      links.push(
        src.startsWith("http")
          ? `<img class="note-img" src="${attr(src)}" alt="${attr(alt)}"${dims}/>`
          : `<img class="note-img" data-asset="${attr(src)}" alt="${attr(alt)}"${dims}/>`,
      );
      return `\u0000${links.length - 1}\u0000`;
    },
  );

  h = h.replace(
    /\[((?:[^\[\]]|\[[^\]]*\])+)\]\(((?:https?:\/\/)(?:[^()\s]|\([^()\s]*\))+)\)/g,
    (_m, text: string, url: string) => {
      links.push(`<a class="lnk" data-url="${attr(url)}">${esc(text)}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    },
  );
  h = h.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_m, note: string, label?: string) => {
    const n = note.trim();
    links.push(`<a class="wikilink" data-note="${attr(n)}">${esc((label ?? n).trim())}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  h = esc(h);
  // code spans — CommonMark fence-of-n rule: `` ``a`b`` `` wraps content
  // containing backticks; padding spaces around the content are stripped
  // when they're required to disambiguate an edge backtick
  h = h.replace(/(`+)([\s\S]+?)\1/g, (_m, _f: string, t: string) => {
    if (t.length > 1 && t.startsWith(" ") && t.endsWith(" ") && t.trim() !== "")
      t = t.slice(1, -1);
    return `<code>${t}</code>`;
  });
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  h = h.replace(
    /==(?:(\w+):)?([^=]+)==/g,
    (_m, c: string | undefined, txt: string) => `<mark${c ? ` class="mk-${c}"` : ""}>${txt}</mark>`,
  );
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // models often answer with literal <sub>/<sup>/<u> markup — keep those
  // three tags (and only those) so formulas and units render properly
  h = h.replace(/&lt;sub&gt;([\s\S]*?)&lt;\/sub&gt;/g, "<sub>$1</sub>");
  h = h.replace(/&lt;sup&gt;([\s\S]*?)&lt;\/sup&gt;/g, "<sup>$1</sup>");
  h = h.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, "<u>$1</u>");
  h = h.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => links[Number(n)] ?? "");
  h = h.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => math[Number(n)] ?? "");
  // trailing ` ^id` — Obsidian block reference anchor; renders as a dim
  // badge, survives serialization via textContent
  h = h.replace(/\s\^([A-Za-z0-9_-]+)$/, ' <span class="blkid">^$1</span>');
  return h;
}

function callout(block: string[]): string {
  const head = block[0] ?? "";
  const marker = (head.match(/^\[!(\w+)\]/) ?? [])[1] ?? "ai";
  if (marker === "terminal") return termCallout(block);
  if (marker === "sheet") return sheetCallout(block);
  if (marker === "slides" || marker === "deck" || marker === "powerpoint")
    return deckCallout(block);
  if (marker === "todo" || marker === "todos") return todoCallout(block);
  if (marker === "browser" || marker === "web") return browserCallout(block);
  if (marker === "chart") return chartCallout(block);
  if (marker === "cards" || marker === "flashcards") return cardsCallout(block);
  if (marker === "map" || marker === "mindmap") return mapCallout(block);
  if (marker === "agenda" || marker === "today") return agendaCallout(block);
  if (marker === "graph") return graphCallout(block);
  if (marker === "canvas" || marker === "draw") return canvasCallout(block);
  if (marker === "base" || marker === "view" || marker === "database")
    return baseCallout(block);
  const sticky = marker === "sticky";
  const stickyRaw = sticky ? head.replace(/^\[!sticky\]\s*/, "").trim() : "";
  let topic = "";
  let title = "";
  let color = "yellow";
  if (sticky) {
    topic = stickyRaw.split(/\s+/)[0] ?? "";
    let rest = stickyRaw.slice(topic.length).trim();
    const cm = rest.match(/^color=(\w+)\s*/);
    if (cm) {
      color = cm[1];
      rest = rest.slice(cm[0].length).trim();
    }
    title = rest;
  } else {
    // strip the [!ai] marker plus any stacked legacy markers/prefixes
    // (older saves stored "research: [!ai] rag: name" verbatim)
    topic = head.replace(/^\[!\w+\]\s*/, "").trim();
    let prev = "";
    while (prev !== topic) {
      prev = topic;
      topic = topic.replace(/^(?:\[!\w+\]\s*|research:\s*|rag:\s*)/i, "").trim();
    }
  }
  const body: string[] = [];
  let sources: Array<{ title: string; url: string }> = [];
  for (const line of block.slice(1)) {
    const sm = line.match(/^Sources:\s*(.+)$/);
    if (sm) {
      sources = [
        ...sm[1].matchAll(
          /\[((?:[^\[\]]|\[[^\]]*\])+)\]\(((?:https?:\/\/)(?:[^()\s]|\([^()\s]*\))+)\)/g,
        ),
      ].map((x) => ({
        title: x[1],
        url: x[2],
      }));
    } else {
      body.push(line);
    }
  }
  const bodyHtml: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.trimStart().startsWith("\\[")) {
      const m = texBlock(body, i);
      if (m) {
        bodyHtml.push(`<p class="math-disp">${renderTex(m.tex, true)}</p>`);
        i = m.end;
        continue;
      }
    }
    const hm = l.match(/^#{1,4}\s+(.+)$/);
    if (hm) {
      bodyHtml.push(`<h4 class="co-h">${inline(hm[1])}</h4>`);
      continue;
    }
    if (l.trim().length) bodyHtml.push(`<p>${inline(l)}</p>`);
  }
  const srcHtml = sources
    .map((s) => {
      let host = "";
      try {
        host = new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        host = "";
      }
      return (
        `<a class="src" data-url="${attr(s.url)}">` +
        `<img class="fav" src="https://www.google.com/s2/favicons?domain=${attr(host)}&sz=64" alt="" onerror="this.style.visibility='hidden'"/>` +
        `<span class="src-site">${esc(host)}</span>` +
        `<span class="src-title">${esc(s.title)}</span>` +
        `</a>`
      );
    })
    .join("");
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout${sticky ? " sticky" : ""}" data-kind="${marker}"${
      sticky ? ` data-color="${attr(color)}"` : ""
    } data-md="${attr(raw)}" data-topic="${attr(topic)}">` +
    `<div class="callout-head">${
      sticky
        ? `<span class="sticky-title">${esc(title)}</span>`
        : `<span class="callout-title">${esc(topic)}</span>`
    }</div>` +
    `<div class="callout-body">${bodyHtml.join("")}</div>` +
    (srcHtml ? `<div class="callout-src">${srcHtml}</div>` : "") +
    `</div>`
  );
}

/** the terminal widget card: the session log as note lines + a live input
 *  row. The head may carry a chat id and a model: `chat 1.1|model-id` */
function termCallout(block: string[]): string {
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "terminal";
  const m = topic.match(/^(chat|terminal)\s+([\d.]+)?\|?(.+)?$/);
  const chatId = m?.[2] ?? "";
  const tail = m?.[3] ?? "";
  const [model, persona] = tail.split("@", 2).map((s) => s.trim());
  const label =
    (m?.[1] ?? topic) + (chatId ? ` ${chatId}` : "") + (persona ? ` · ${persona}` : "");
  const rows = block
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const t = l.startsWith("›") ? "ask" : l.startsWith("!") ? "cmd" : l.startsWith("✕") ? "err" : l.startsWith("≡") ? "ai" : l.startsWith("◆") ? "laido" : "out";
      const raw = t !== "out" ? l.slice(2).trimStart() : l;
      return `<div class="term-line ${t}" data-t="${t}" data-raw="${attr(raw)}">${esc(raw)}</div>`;
    });
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout term-card" data-kind="terminal" data-topic="${attr(m?.[1] ?? topic)}"` +
    ` data-chat-id="${attr(chatId)}" data-model="${attr(model)}" data-persona="${attr(persona ?? "")}" data-md="${attr(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${esc(label)}</span></div>` +
    `<div class="term-log">${rows.join("")}</div>` +
    `<div class="term-input-row"><span class="term-prompt">›</span><input class="term-input" placeholder="ask anything — or ! command" spellcheck="false" autocomplete="off"/></div>` +
    `</div>`
  );
}

/** the sheet widget card: `> [!sheet] title` then one `> | a | b |` line per
 *  row — rendered as static grid markup that wireSheet upgrades into live
 *  cells (raw values/formulas ride in data-raw) */
function sheetCallout(block: string[]): string {
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "sheet";
  // `> [!fmt]/[!cf]/[!freeze]/[!hide]/[!w]/[!filter]` lines are sheet metadata —
  // formats, rules, widths, filters — they ride along in data-meta for
  // wireSheet to reapply, never render as cells
  // `[!tab] name` splits the body into workbook segments — lines before the
  // first marker belong to the active sheet; each later segment is one
  // inactive sheet's body (rows + its own [!x] meta, kept verbatim)
  const segs: Record<string, string[]> = {};
  const active: string[] = [];
  let cur: string[] | null = null;
  for (const l of block.slice(1)) {
    const tm = l.trim().match(/^\[!tab\]\s*(.*)$/i);
    if (tm) {
      cur = segs[(tm[1] ?? "").trim() || `sheet${Object.keys(segs).length + 1}`] = [];
      continue;
    }
    (cur ?? active).push(l);
  }
  const metaLines = active
    .map((l) => l.trim())
    .filter((l) => /^\[!\w+\]/.test(l));
  const rows = active
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^\[!\w+\]/.test(l))
    .map(parseSheetLine);
  if (!rows.length) rows.push([]);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const headRow =
    `<tr class="sheet-cols"><th class="sheet-corner">#</th>` +
    Array.from({ length: cols }, (_, i) => `<th data-c="${i}">${esc(String.fromCharCode(65 + i))}</th>`).join("") +
    `</tr>`;
  const bodyRows = rows
    .map(
      (cells, r) =>
        `<tr data-r="${r}"><th>${r + 1}</th>` +
        Array.from(
          { length: cols },
          (_, c) =>
            `<td data-raw="${attr(cells[c] ?? "")}" data-c="${c}">${esc(cells[c] ?? "")}</td>`,
        ).join("") +
        `<td class="sheet-rowctl"></td></tr>`,
    )
    .join("");
  const raw = "> " + block.join("\n> ");
  const sheetsAttr = Object.keys(segs).length ? ` data-sheets="${attr(JSON.stringify(segs))}"` : "";
  return (
    `<div class="callout sheet-card" data-kind="sheet" data-topic="${attr(topic)}" data-md="${attr(raw)}" data-meta="${attr(JSON.stringify(metaLines))}"${sheetsAttr}>` +
    `<div class="callout-head"><span class="callout-title">${esc(topic)}</span></div>` +
    `<div class="sheet-wrap"><table class="sheet-grid">${headRow}${bodyRows}</table></div>` +
    `</div>`
  );
}

/** the deck card: `> [!slides] title` + `[!theme]`/`[!transition]` meta +
 *  `[!slide layout]` blocks — static markup wireDeck upgrades to a live deck */
function deckCallout(block: string[]): string {
  const d = parseDeck(block);
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout deck-card" data-kind="deck" data-topic="${attr(d.title)}"` +
    ` data-theme="${attr(d.theme)}" data-trans="${attr(d.transition)}" data-md="${attr(raw)}"` +
    ` data-tools="${attr(JSON.stringify(d.tools))}">` +
    `<div class="callout-head"><span class="callout-title">${esc(d.title)}</span></div>` +
    deckInnerHtml(d) +
    `</div>`
  );
}

/** the todo card: `> [!todo] title` + `- [ ] task @when` lines — static
 *  markup wireTodo upgrades to the live dashboard */
function todoCallout(block: string[]): string {
  const d = parseTodo(block);
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout todo-card" data-kind="todo" data-topic="${attr(d.title)}" data-md="${attr(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${esc(d.title)}</span></div>` +
    todoInnerHtml(d) +
    `</div>`
  );
}

/** the browser card: `> [!browser] title` + `> url: x` — wireBrowser
 *  upgrades it to a live mini-browser (real engine + reader fallback) */
function browserCallout(block: string[]): string {
  const d = parseBrowser(block);
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout browser-card" data-kind="browser" data-topic="${attr(d.title)}"` +
    ` data-url="${attr(d.url)}"` +
    (d.bv ? ` data-bv="${attr(d.bv)}"` : "") +
    (d.tabs.length > 1 ? ` data-tabs="${attr(JSON.stringify(d.tabs))}" data-atab="${d.atab}"` : "") +
    (d.tools.length ? ` data-tools="${attr(JSON.stringify(d.tools))}"` : "") +
    (d.chat ? ` data-chat="${attr(d.chat)}"` : "") +
    ` data-md="${attr(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${esc(d.title)}</span></div>` +
    browserInnerHtml() +
    `</div>`
  );
}

/** the chart card: `> [!chart] title` + `type:`/`data:`/inline rows —
 *  wireChart upgrades it to the live canvas widget */
function chartCallout(block: string[]): string {
  const d = parseChart(block);
  const raw = "> " + block.join("\n> ");
  const labels = d.labels.join("\u0001");
  const ser = JSON.stringify(d.series);
  return (
    `<div class="callout chart-card" data-kind="chart" data-topic="${attr(d.title)}"` +
    ` data-ctype="${attr(d.type)}" data-csrc="${attr(d.source)}"` +
    ` data-ccolors="${attr(d.colors.join(","))}"` +
    ` data-clabels="${attr(labels)}" data-cseries="${attr(ser)}"` +
    ` data-md="${attr(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${esc(d.title)}</span></div>` +
    chartInnerHtml() +
    `</div>`
  );
}

/** the flashcards card: `> [!cards] title` + `front :: back` rows +
 *  `sched:` state lines — wireCards upgrades it to a live deck */
function cardsCallout(block: string[]): string {
  const d = parseCards(block);
  const raw = "> " + block.join("\n> ");
  const schedJson = JSON.stringify(Object.fromEntries(d.sched));
  const rows = d.cards
    .map(
      (c) =>
        `<div class="fc-row" data-h="${h8(c.front)}" data-back="${attr(c.back)}">` +
        `<button class="fc-del" title="delete card">✕</button>` +
        `<span class="fc-front">${esc(c.front)}</span>` +
        `<span class="fc-back">${esc(c.back)}</span>` +
        `<span class="fc-due"></span></div>`,
    )
    .join("");
  return (
    `<div class="callout cards-card" data-kind="cards" data-topic="${attr(d.title)}"` +
    ` data-sched="${attr(schedJson)}" data-md="${attr(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${esc(d.title)}</span></div>` +
    cardsInnerHtml() +
    `</div>`
  ).replace(`<div class="fc-list"></div>`, `<div class="fc-list">${rows}</div>`);
}

export function renderCalloutMd(md: string): string {
  const block = S(md).split("\n").map((l) => l.trimStart().replace(/^>\s?/, ""));
  return callout(block);
}

export function renderMarkdown(src: string, depth = 0): string {
  const lines = S(src).split("\n");
  const out: string[] = [];

  // YAML frontmatter (`---`…`---` at byte 0) → an editable properties
  // panel, Obsidian-style: rows of key/value inputs + add/remove.
  if (depth === 0 && lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { end = i; break; }
    }
    if (end > 0) {
      // strict grammar: `key: val` rows, or `key:` + indented `- item`
      // list lines. Anything richer (nested maps, comments) keeps the
      // raw text path — the panel must never eat YAML it can't write.
      const fmLines = lines.slice(1, end);
      const rows: { k: string; v: string; list: boolean }[] = [];
      let ok = true;
      for (let i = 0; i < fmLines.length; i++) {
        const l = fmLines[i];
        if (!l.trim()) continue;
        const m = l.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (m) {
          const items: string[] = [];
          if (!m[2].trim()) {
            while (i + 1 < fmLines.length && /^\s+-\s+/.test(fmLines[i + 1])) {
              items.push(fmLines[++i].replace(/^\s+-\s+/, "").trim());
            }
          }
          rows.push({
            k: m[1],
            v: m[2].trim() ? m[2].replace(/^["']|["']$/g, "") : items.join(", "),
            list: items.length > 0,
          });
        } else if (/^\s+-\s+/.test(l) && rows.length) {
          // a continuation item for the previous bare `key:` row
          const r = rows[rows.length - 1];
          r.list = true;
          r.v = [r.v, l.replace(/^\s+-\s+/, "").trim()].filter(Boolean).join(", ");
        } else {
          ok = false;
          break;
        }
      }
      if (ok && rows.length) {
        // Obsidian property types: `true`/`false` → a checkbox, ISO dates
        // → date pickers, lists → comma-edited text. Everything else is
        // a plain text row.
        const fmType = (v: string) =>
          /^(true|false)$/i.test(v.trim())
            ? "checkbox"
            : /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
              ? "date"
              : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim())
                ? "datetime-local"
                : "text";
        const valInput = (r: { v: string; list: boolean }) => {
          if (r.list) return `<input class="fm-v" value="${attr(r.v)}" spellcheck="false"/>`;
          const t = fmType(r.v);
          if (t === "checkbox")
            return `<input type="checkbox" class="fm-v fm-cb"${r.v.trim().toLowerCase() === "true" ? " checked" : ""}/>`;
          if (t === "date" || t === "datetime-local")
            return `<input type="${t}" class="fm-v" value="${attr(r.v.trim().replace(" ", "T"))}"/>`;
          return `<input class="fm-v" value="${attr(r.v)}" spellcheck="false"/>`;
        };
        out.push(
          `<div class="fm-props" contenteditable="false">` +
            `<div class="fm-title">properties</div>` +
            rows
              .map(
                (r) =>
                  `<div class="fm-row"${r.list ? ` data-list="1"` : ""}>` +
                  `<input class="fm-k" value="${attr(r.k)}" spellcheck="false"/>` +
                  valInput(r) +
                  `<button class="fm-x" title="remove property" tabindex="-1">✕</button></div>`,
              )
              .join("") +
            `<button class="fm-add" title="add property">＋ property</button>` +
            `</div>`,
        );
        lines.splice(0, end + 1);
      }
    }
  }
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushAll = flushPara;

  /** a list item's inner html — "- [ ] text @when" carries a clickable box
   *  and a due chip; plain items are inline content */
  const itemInner = (body: string, ord: boolean) => {
    const tm = ord ? null : body.match(/^\[([ xX])\]\s+(.*)$/);
    if (!tm) return { html: inline(body), cls: "", when: "" };
    const done = tm[1] !== " ";
    let rest = tm[2];
    const wm = rest.match(/@(\S+)\s*$/);
    const when = wm ? ` data-when="${attr(wm[1])}"` : "";
    if (wm) rest = rest.slice(0, wm.index).trim();
    return {
      html:
        `<span class="todo-box" contenteditable="false">${done ? "☑" : "☐"}</span> ` +
        inline(rest),
      cls: ` class="todo${done ? " done" : ""}"`,
      when,
    };
  };
  /** leveled rows → nested <ul>/<ol>. A stack builds the tree so any
   *  indentation pattern works — a row dedenting below the current depth
   *  pops back to the right ancestor instead of being dropped */
  const listHtml = (rows: { lvl: number; ord: boolean; body: string }[]): string => {
    type Row = { ord: boolean; body: string; lvl: number; kids: Row[] };
    const roots: Row[] = [];
    const stack: Row[] = [];
    for (const r of rows) {
      const row: Row = { ord: r.ord, body: r.body, lvl: r.lvl, kids: [] };
      while (stack.length && stack[stack.length - 1].lvl >= row.lvl) stack.pop();
      if (stack.length) stack[stack.length - 1].kids.push(row);
      else roots.push(row);
      stack.push(row);
    }
    const emit = (nodes: Row[]): string => {
      let html = "";
      let i = 0;
      while (i < nodes.length) {
        const ord = nodes[i].ord;
        html += ord ? "<ol>" : "<ul>";
        while (i < nodes.length && nodes[i].ord === ord) {
          const n = nodes[i];
          const it = itemInner(n.body, n.ord);
          html +=
            `<li${it.cls}${it.when}>${it.html}` +
            (n.kids.length ? emit(n.kids) : "") +
            `</li>`;
          i++;
        }
        html += ord ? "</ol>" : "</ul>";
      }
      return html;
    };
    return emit(roots);
  };

  /** a leading `\` before a structural marker makes the line literal text —
   *  `\> [!x]` renders as "> [!x]", not a callout. serialize writes the
   *  escape; render eats the backslash so the user never sees it. */
  const wouldBlock = (u: string) =>
    u.startsWith(">") ||
    /^#{1,3}\s/.test(u) ||
    /^[-*]\s/.test(u) ||
    /^\d+[.)]\s/.test(u) ||
    /^(-{3,}|\*{3,})$/.test(u) ||
    /^!\[\[.*\]\]$/.test(u) ||
    /^`{3,}/.test(u) ||
    u.startsWith("\\");

  // fenced code is opaque — callouts, headings and markers inside a ``` block
  // are literal text, never structure. The opener may carry a language
  // (```js); the closer needs at least as many backticks as the opener so
  // code containing ``` still round-trips inside a ```` fence.
  let fenceLen = 0;
  let fenceLang = "";
  let fenceBuf: string[] = [];
  const closeFence = () => {
    out.push(
      `<pre class="md-code"${fenceLang ? ` data-lang="${attr(fenceLang)}"` : ""}><code>` +
        esc(fenceBuf.join("\n")) +
        `</code></pre>`,
    );
    fenceLen = 0;
    fenceBuf = [];
    fenceLang = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (fenceLen) {
      const close = t.match(/^(`{3,})\s*$/);
      if (close && close[1].length >= fenceLen) closeFence();
      else fenceBuf.push(line);
      continue;
    }
    const open = t.match(/^(`{3,})(.*)$/);
    if (open) {
      flushAll();
      fenceLen = open[1].length;
      fenceLang = open[2].trim();
      fenceBuf = [];
      continue;
    }

    if (t.startsWith("\\") && wouldBlock(t.slice(1))) {
      para.push(line.replace(/\\/, ""));
      continue;
    }

    if (t.startsWith("> [!")) {
      flushAll();
      const block: string[] = [];
      // some callouts carry internal [!x] sub-markers — a deck's [!slide]/
      // [!theme]/[!transition] blocks and a sheet's [!fmt]/[!cf]/[!freeze]/
      // [!hide]/[!w]/[!filter]/[!view] metadata lines belong to their card,
      // not to new callouts of their own
      const kind = (line.match(/^\s*>\s*\[!(\w+)\]/) ?? [])[1] ?? "";
      const inner = (c: string) => {
        if (/^(slides|deck|powerpoint)$/.test(kind))
          return /^\[!(slide|theme|transition|tool)\b/.test(c);
        if (kind === "sheet")
          return (
            /^\[!(fmt|cf|freeze|hide|w|filter|style|tool|chat|tab)\b/.test(c) ||
            /^\[!view\]\s+(kanban|calendar)\s/i.test(c)
          );
        return false;
      };
      let j = i;
      while (j < lines.length) {
        const lt = lines[j].trimStart();
        if (lt.startsWith(">")) {
          const content = lt.replace(/^>\s?/, "");
          if (block.length > 0 && content.startsWith("[!") && !inner(content)) break;
          block.push(content);
          j++;
          continue;
        }
        if (lt.trim() === "") {
          let k = j;
          while (k < lines.length && lines[k].trim() === "") k++;
          if (k < lines.length) {
            const nxt = lines[k].trimStart();
            if (nxt.startsWith(">")) {
              const nc = nxt.replace(/^>\s?/, "");
              if (!nc.startsWith("[!") || inner(nc)) {
                j++;
                continue;
              }
            }
          }
        }
        break;
      }
      i = j - 1;
      out.push(callout(block));
      continue;
    }
    if (t.startsWith(">")) {
      flushAll();
      // consecutive > lines join one blockquote — a callout head ends the run
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        const c = lines[i].trim().replace(/^>\s?/, "");
        if (c.startsWith("[!")) break;
        parts.push(inline(c));
        i++;
      }
      i--;
      out.push(`<blockquote>${parts.join("<br>")}</blockquote>`);
      continue;
    }
    if (t.startsWith("\\[")) {
      const m = texBlock(lines, i);
      if (m) {
        flushAll();
        out.push(`<div class="math-disp">${renderTex(m.tex, true)}</div>`);
        i = m.end;
        continue;
      }
      // single-line \[…\] — fall through; inline() renders it inline
    }
    // `![[note]]` / `![[note#Heading]]` / `![[note#^block]]` — a note
    // embed (transclusion), or `![[img.png|300]]` — a sized image embed.
    // Depth-capped so embedded notes can't recursively embed.
    const em = t.match(/^!\[\[([^\[\]#|]+?)(?:#([^\[\]|]+?))?(?:\|(\d+(?:x\d+)?))?\]\]$/);
    if (em && /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(em[1].trim())) {
      // wiki image embed — bare filenames resolve under attachments/
      flushAll();
      const src = em[1].trim();
      const rel = src.includes("/") ? src : `attachments/${src}`;
      const dims = em[3]
        ? ` width="${em[3].split("x")[0]}"${em[3].includes("x") ? ` height="${em[3].split("x")[1]}"` : ""}`
        : "";
      out.push(
        `<img class="note-img" data-asset="${attr(rel)}" data-wiki="1"${dims}/>`,
      );
      continue;
    }
    if (em && depth < 1) {
      flushAll();
      const src = em[1].trim();
      const headPart = (em[2] ?? "").trim();
      const rawMd = `![[${src}${headPart ? `#${headPart}` : ""}]]`;
      out.push(
        `<div class="callout note-embed" data-kind="embed" data-src="${attr(src)}"` +
          (headPart ? ` data-head="${attr(headPart)}"` : "") +
          ` data-md="${attr(rawMd)}">` +
          `<div class="callout-head"><span class="callout-title">📄 ${esc(src)}${headPart ? ` <span class="ne-sec">#${esc(headPart)}</span>` : ""}</span>` +
          `<button class="ne-open" title="open note" contenteditable="false">↗</button></div>` +
          `<div class="ne-body" contenteditable="false"><span class="ne-load">…</span></div>` +
          `</div>`,
      );
      continue;
    }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushAll();
      out.push("<hr/>");
      continue;
    }
    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      // collect the whole contiguous list block — indentation decides the
      // nesting level, so `  - child` becomes a real nested <ul> inside its
      // parent <li> instead of flattening into a sibling
      const raws: { ind: number; ord: boolean; body: string }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        raws.push({
          ind: m[1].replace(/\t/g, "  ").length,
          ord: /^\d/.test(m[2]),
          body: m[3],
        });
        i++;
      }
      i--;
      // normalize arbitrary indents (2sp/4sp/tab) to nesting levels
      const lvls = [...new Set(raws.map((r) => r.ind))].sort((a, b) => a - b);
      const rows = raws.map((r) => ({ lvl: lvls.indexOf(r.ind), ...r }));
      out.push(listHtml(rows));
      continue;
    }
    if (t === "") {
      flushAll();
      continue;
    }
    para.push(line);
  }
  if (fenceLen) closeFence(); // unclosed fence still renders its lines as code
  flushAll();
  return out.join("\n");
}
