/* ---------- base — property-driven table/kanban view card -----------------
 * `[!base] title` + `> q: prop:status=wip` + `> cols: status,due` +
 * `> group: status` + `> view: board` persists a vault query — Obsidian
 * Bases' filter/order/group fields in three lines of markdown.
 * Table view: rows of note|prop|prop. Board view (group set): a kanban —
 * columns are the group property's distinct values; dragging a card to a
 * column writes that property back into the note's frontmatter
 * (vault_prop_set, snapshot-backed → undoable via `> history`). */

import { invoke } from "./ipc.js";
import { stem } from "./match.js";
import { addActivity } from "./log.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };

const esc = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const headHtml = (title: string) =>
  `<div class="callout-head"><span class="callout-title">▦ ${esc(title)}</span>` +
  `<span class="base-tools" contenteditable="false">` +
  `<button class="base-vt" title="toggle table / board">⇄</button>` +
  `<input class="base-q" placeholder="prop:k=v · text" spellcheck="false" title="filter — prop:key=val, prop:key, bare text (AND)"/>` +
  `<input class="base-cols" placeholder="cols: status, due" spellcheck="false" title="columns / card-face properties"/>` +
  `<input class="base-sort" placeholder="sort: file.mtime desc" spellcheck="false" title="sort — prop [asc|desc] or -prop; comma for ties"/>` +
  `<input class="base-group" placeholder="group: status" spellcheck="false" title="kanban column property"/>` +
  `<button class="base-csv" title="materialize this view as a live sheet card">⤓</button>` +
  `<button class="base-copy" title="copy this view as CSV to the clipboard">⇩</button>` +
  `<button class="base-chart" title="chart this view — first numeric column as bars">📊</button>` +
  `<button class="base-re" title="rescan">⟳</button></span></div>`;

export function baseCallout(block: string[]): string {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "base";
  let q = "";
  let cols = "";
  let group = "";
  let view = "";
  let sort = "";
  let gorder = "";
  let sum = "";
  let dateProp = "";
  let limit = "";
  let corder = "";
  let span0 = "";
  let dir = "";
  let hide = "";
  const fx: string[] = [];
  for (const l of block.slice(1)) {
    const m = l.match(/^(q|filter|where)\s*:\s*(.*)$/i);
    if (m) q = m[2].trim();
    const c = l.match(/^(cols?|order|props?)\s*:\s*(.*)$/i);
    if (c) cols = c[2].trim();
    const g = l.match(/^group(?:_?by)?\s*:\s*(.*)$/i);
    if (g) group = g[1].trim();
    const v = l.match(/^view\s*:\s*(\w+)$/i);
    if (v) view = v[1].trim().toLowerCase();
    const s = l.match(/^sort\s*:\s*(.*)$/i);
    if (s) sort = s[1].trim();
    const go = l.match(/^g(?:roup)?_?order\s*:\s*(.*)$/i);
    if (go) gorder = go[1].trim();
    const su = l.match(/^(?:sum|summar(?:y|ies))\s*:\s*(.*)$/i);
    if (su) sum = su[1].trim();
    const fxm = l.match(/^(?:f|formula|calc)\s*:\s*([\w-]+)\s*=\s*(.+)$/i);
    if (fxm) fx.push(`${fxm[1].toLowerCase()}=${fxm[2].trim()}`);
    const dm = l.match(/^date\s*:\s*(.*)$/i);
    if (dm) dateProp = dm[1].trim();
    const lm = l.match(/^(?:limit|take|top)\s*:\s*(\d+)$/i);
    if (lm) limit = lm[1];
    const om = l.match(/^corder\s*:\s*(.*)$/i);
    if (om) corder = om[1].trim();
    const sm = l.match(/^span\s*:\s*(week|month)/i);
    if (sm) span0 = sm[1].toLowerCase();
    const inm = l.match(/^(?:in|from|path|folder)\s*:\s*(.*)$/i);
    if (inm) dir = inm[1].trim();
    const hm = l.match(/^(?:hide|collapsed)\s*:\s*(.*)$/i);
    if (hm) hide = hm[1].trim();
  }
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout base-card" data-kind="base" data-title="${esc(topic)}"` +
    ` data-q="${esc(q)}" data-cols="${esc(cols)}" data-group="${esc(group)}"` +
    ` data-sort="${esc(sort)}" data-gorder="${esc(gorder)}" data-sum="${esc(sum)}"` +
    ` data-fx="${esc(fx.join(";;"))}" data-date="${esc(dateProp)}"` +
    ` data-limit="${esc(limit)}"` +
    ` data-corder="${esc(corder)}"` +
    ` data-span="${esc(span0)}"` +
    ` data-in="${esc(dir)}"` +
    ` data-hide="${esc(hide)}"` +
    ` data-view="${esc(view || (group ? "board" : "table"))}" data-md="${esc(raw)}">` +
    headHtml(topic) +
    `<div class="callout-body"><div class="base-body"></div></div>` +
    `</div>`
  );
}

export function buildBaseCard(title: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout base-card";
  card.dataset.kind = "base";
  card.dataset.title = title || "base";
  card.dataset.q = "";
  card.dataset.cols = "";
  card.dataset.group = "";
  card.dataset.sort = "";
  card.dataset.gorder = "";
  card.dataset.sum = "";
  card.dataset.fx = "";
  card.dataset.date = "";
  card.dataset.limit = "";
  card.dataset.corder = "";
  card.dataset.span = "";
  card.dataset.in = "";
  card.dataset.hide = "";
  card.dataset.view = "table";
  card.innerHTML = headHtml(title || "base") + `<div class="callout-body"><div class="base-body"></div></div>`;
  return card;
}

export function baseToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const lines = [`> [!base] ${DS(card.dataset.title) ?? "base"}`];
  const q = DS(card.dataset.q)?.trim();
  const cols = DS(card.dataset.cols)?.trim();
  const group = DS(card.dataset.group)?.trim();
  const sort = DS(card.dataset.sort)?.trim();
  const gorder = DS(card.dataset.gorder)?.trim();
  const sum = DS(card.dataset.sum)?.trim();
  if (q) lines.push(`> q: ${q}`);
  if (cols) lines.push(`> cols: ${cols}`);
  if (sort) lines.push(`> sort: ${sort}`);
  if (group) lines.push(`> group: ${group}`);
  if (gorder) lines.push(`> gorder: ${gorder}`);
  if (sum) lines.push(`> sum: ${sum}`);
  for (const d of (DS(card.dataset.fx) ?? "").split(";;").filter(Boolean)) {
    const eq = d.indexOf("=");
    if (eq > 0) lines.push(`> f: ${d.slice(0, eq)} = ${d.slice(eq + 1)}`);
  }
  const dateP = DS(card.dataset.date)?.trim();
  if (dateP) lines.push(`> date: ${dateP}`);
  const lim = DS(card.dataset.limit)?.trim();
  if (lim) lines.push(`> limit: ${lim}`);
  const ord = DS(card.dataset.corder)?.trim();
  if (ord) lines.push(`> corder: ${ord}`);
  const sp = DS(card.dataset.span)?.trim();
  if (sp && sp !== "month") lines.push(`> span: ${sp}`);
  const dirP = DS(card.dataset.in)?.trim();
  if (dirP) lines.push(`> in: ${dirP}`);
  const hideP = DS(card.dataset.hide)?.trim();
  if (hideP) lines.push(`> hide: ${hideP}`);
  const view = DS(card.dataset.view) ?? "table";
  if (view !== "table" && (view !== "board" || group)) lines.push(`> view: ${view}`);
  return lines.join("\n");
}

/** compare two prop values — numeric when both parse as numbers,
 *  else lexical (ISO dates sort correctly as strings). Pure. */
export function propCmp(got: string, op: string, want: string): boolean {
  const g = S(got).trim();
  const w = S(want).trim();
  op = S(op);
  if (op === "=" || op === "==") {
    // `a|b` alternates — `prop:status=wip|done` is an OR group
    const wants = w.toLowerCase().split("|").map((s) => s.trim()).filter(Boolean);
    const parts = g.toLowerCase().split(",").map((s) => s.trim());
    return wants.some((w2) => g.toLowerCase() === w2 || parts.includes(w2));
  }
  if (op === "!=")
    return !propCmp(g, "=", w);
  const gn = Number(g), wn = Number(w);
  const [a, b] = g !== "" && w !== "" && !isNaN(gn) && !isNaN(wn)
    ? [gn, wn] as const
    : [g, w] as const;
  if (op === ">") return a > b;
  if (op === "<") return a < b;
  if (op === ">=") return a >= b;
  if (op === "<=") return a <= b;
  return false;
}

/* ---------- formula columns — `> f:age = days(now() - file.mtime)` --
 *  a tiny evaluator (no eval()): numbers, "strings", prop refs (numeric
 *  or ISO-date → epoch secs), now()/days()/if()/min/max/abs/round/
 *  floor/ceil, + - * / %, comparisons → 1|0, parens. Result lands in
 *  the note's prop map so sort/group/cols treat it like a real prop. */
type FVal = number | string;

export function evalFormula(expr: string, props: Map<string, string>): FVal {
  let i = 0;
  const s = S(expr);
  if (!(props instanceof Map)) props = new Map();
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const num = (v: FVal): number => {
    if (typeof v === "number") return v;
    const n = Number(v);
    if (!isNaN(n) && v !== "") return n;
    const t = Date.parse(v); // ISO props → epoch secs
    return isNaN(t) ? NaN : t / 1000;
  };
  const truthy = (v: FVal) => (typeof v === "number" ? v !== 0 : v !== "");

  function prim(): FVal {
    ws();
    if (s[i] === "(") { i++; const v = cmp(); ws(); if (s[i] === ")") i++; return v; }
    if (s[i] === '"') {
      i++;
      let out = "";
      while (i < s.length && s[i] !== '"') out += s[i++];
      i++;
      return out;
    }
    const nm = s.slice(i).match(/^-?\d+(?:\.\d+)?/);
    if (nm) { i += nm[0].length; return Number(nm[0]); }
    const idm = s.slice(i).match(/^[a-zA-Z_][\w.]*/);
    if (!idm) { i++; return ""; }
    i += idm[0].length;
    const id = idm[0].toLowerCase();
    ws();
    if (s[i] === "(") {
      i++;
      const args: FVal[] = [];
      ws();
      while (i < s.length && s[i] !== ")") { args.push(cmp()); ws(); if (s[i] === ",") { i++; ws(); } }
      if (s[i] === ")") i++;
      const iso = (v: FVal) => new Date(num(v) * 1000).toISOString().slice(0, 10);
      const dt = (v: FVal) => new Date(num(v) * 1000);
      switch (id) {
        case "now": return Date.now() / 1000;
        case "days": return Math.round((num(args[0] ?? 0) / 86400) * 10) / 10;
        case "hours": return Math.round((num(args[0] ?? 0) / 3600) * 10) / 10;
        case "mins": return Math.round(num(args[0] ?? 0) / 60);
        case "dateadd": return iso(num(args[0] ?? 0) + num(args[1] ?? 0) * 86400);
        case "weekday": return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][dt(args[0] ?? 0).getDay()];
        case "year": return dt(args[0] ?? 0).getFullYear();
        case "month": return dt(args[0] ?? 0).getMonth() + 1;
        case "day": return dt(args[0] ?? 0).getDate();
        case "iso": return iso(args[0] ?? 0);
        case "if": return truthy(args[0] ?? 0) ? (args[1] ?? "") : (args[2] ?? "");
        case "min": return Math.min(...args.map(num));
        case "max": return Math.max(...args.map(num));
        case "abs": return Math.abs(num(args[0] ?? 0));
        case "round": return Math.round(num(args[0] ?? 0));
        case "floor": return Math.floor(num(args[0] ?? 0));
        case "ceil": return Math.ceil(num(args[0] ?? 0));
        case "len": return S(args[0]).length;
        case "upper": return S(args[0]).toUpperCase();
        case "lower": return S(args[0]).toLowerCase();
        case "concat": return args.map((a) => String(a)).join("");
        case "contains": return S(args[0]).toLowerCase().includes(S(args[1]).toLowerCase()) ? 1 : 0;
        default: return "";
      }
    }
    // bare ident → prop lookup (case-insensitive), raw string value
    return [...props.entries()].find(([k]) => k.toLowerCase() === id)?.[1] ?? "";
  }
  function unary(): FVal {
    ws();
    if (s[i] === "-") { i++; return -num(unary()); }
    return prim();
  }
  function mul(): FVal {
    let l = unary();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== "*" && op !== "/" && op !== "%") return l;
      i++;
      const r = unary();
      const [a, b] = [num(l), num(r)];
      l = op === "*" ? a * b : op === "/" ? (b === 0 ? NaN : a / b) : (b === 0 ? NaN : a % b);
    }
  }
  function add(): FVal {
    let l = mul();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== "+" && op !== "-") return l;
      i++;
      const r = mul();
      if (op === "+") {
        const [a, b] = [num(l), num(r)];
        // Excel rule: number + number when both coerce, else concat
        l = !isNaN(a) && !isNaN(b) ? a + b : `${l}${r}`;
      } else l = num(l) - num(r);
    }
  }
  function cmp(): FVal {
    let l = add();
    for (;;) {
      ws();
      const m = s.slice(i).match(/^(>=|<=|!=|==|>|<)/);
      if (!m) return l;
      i += m[0].length;
      const r = add();
      const [a, b] = [num(l), num(r)];
      const bothN = !isNaN(a) && !isNaN(b);
      const lo = typeof l === "string" ? l : String(l);
      const ro = typeof r === "string" ? r : String(r);
      const c = bothN ? Math.sign(a - b) : lo.localeCompare(ro);
      l = m[0] === "==" ? (c === 0 ? 1 : 0)
        : m[0] === "!=" ? (c !== 0 ? 1 : 0)
        : m[0] === ">" ? (c > 0 ? 1 : 0)
        : m[0] === "<" ? (c < 0 ? 1 : 0)
        : m[0] === ">=" ? (c >= 0 ? 1 : 0)
        : (c <= 0 ? 1 : 0);
    }
  }
  const v = cmp();
  return typeof v === "number" && !isFinite(v) ? "" : v;
}

/** parse `f:`/`formula:` lines → name→expr map. Pure. */
export function parseFormulas(lines: string[]): Map<string, string> {
  if (!Array.isArray(lines)) lines = []; lines = lines.map((l) => S(l));
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = S(l).match(/^(?:f|formula|calc)\s*:\s*([\w-]+)\s*=\s*(.+)$/i);
    if (m) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

/** `q` grammar: `prop:k=v`, `prop:k`, `prop:k>v`/`!=`/`>=`/`<=` (and
 *  `="quoted values"`), `a|b` alternates, bare text — all ANDed. Pure. */
/** `is:x` inside a base `q:` — the prop-answerable slice of the palette
 *  predicates: stem ones (daily/template/persona), fm inheritance
 *  (`X: true` / `status: X`), and the date predicates. Content-probe
 *  kinds (task/card) can't answer off the index — they fall back to the
 *  fm form, so `is:task` reads `task: true` / `status: task`. Pure. */
export function isToken(p: string, noteStem: string, props: Map<string, string>): boolean {
  p = S(p);
  noteStem = S(noteStem);
  if (!(props instanceof Map)) props = new Map();
  const s = noteStem.toLowerCase();
  const get = (k: string) =>
    [...props.entries()].find(([kk]) => kk.toLowerCase() === k)?.[1] ?? "";
  const dayOf = (stemFb: boolean): string => {
    for (const k of ["due", "deadline", "date", "scheduled", "on"]) {
      const d = get(k).match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (d) return d;
    }
    return stemFb ? noteStem.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "" : "";
  };
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 6 * 86400e3).toISOString().slice(0, 10);
  switch (p) {
    case "daily": return /^\d{4}-\d{2}-\d{2}/.test(noteStem);
    case "template": case "tpl":
      return s.startsWith("tpl-") || s.startsWith("template-") || s.endsWith("-template");
    case "persona": return s.startsWith("persona-");
    case "overdue": case "late": { const d = dayOf(false); return d !== "" && d < today; }
    case "today": case "due": return dayOf(true) === today;
    case "week": case "soon": { const d = dayOf(true); return d >= today && d <= week; }
    case "nodate": return dayOf(false) === "";
    // graph-topology predicates — file.backlinks/outlinks merge into
    // the prop map at load, so they arrive like real props
    case "orphan": return get("file.backlinks") === "0" || get("file.backlinks") === "";
    case "deadend": return get("file.outlinks") === "0" || get("file.outlinks") === "";
    case "hub": return Number(get("file.backlinks")) >= 3;
    default:
      // generic fm inheritance — `is:wip` → wip:true or status:wip
      return /^(true|yes|on)$/i.test(get(p)) ||
        get("status").toLowerCase() === p.toLowerCase();
  }
}

export function baseMatch(
  q: string,
  noteStem: string,
  props: Map<string, string>,
): boolean {
  q = S(q);
  noteStem = S(noteStem);
  if (!(props instanceof Map)) props = new Map();
  // pull `prop:k="v with spaces"` out before space-tokenizing
  const quoted: string[] = [];
  const rest = q.replace(/-?prop:[\w.-]+\s*(?:>=|<=|!=|==?|>|<)?\s*"[^"]*"/gi,
    (m) => { quoted.push(m); return " "; });
  const toks = rest.split(/\s+/).filter(Boolean).concat(quoted);
  for (let tok of toks) {
    // `-x` negates — `-prop:k=v`, `-is:x`, `-word`
    let neg = false;
    if (tok.startsWith("-") && tok.length > 1) { neg = true; tok = tok.slice(1); }
    const im = tok.match(/^is:([\w-]+)$/i);
    if (im) {
      if (neg === isToken(im[1].toLowerCase(), noteStem, props)) return false;
      continue;
    }
    const pm = tok.match(/^prop:([\w.-]+)\s*(>=|<=|!=|==?|>|<)?(.*)$/i);
    if (pm) {
      const key = pm[1].toLowerCase();
      const ent = [...props.entries()].find(([k]) => k.toLowerCase() === key);
      const hit = !ent ? false
        : (pm[2] === undefined || pm[2] === "") ? true
        : propCmp(ent[1], pm[2], (pm[3] ?? "").replace(/^"|"$/g, "").trim());
      // drop when the hit equals what we were told to exclude
      if (neg === hit) return false;
      continue;
    }
    if (neg === noteStem.toLowerCase().includes(tok.toLowerCase())) return false;
  }
  return true;
}

/** `sort:` grammar — `prop [asc|desc]` or `-prop`, comma-separated
 *  for tie-breaks (Obsidian: multiple sorts, first wins ties).
 *  Returns a comparator over per-note prop maps. Pure. */
export interface IndexLike {
  notes: string[];
  links?: [string, string][];
  props?: [string, string, string][];
  modified?: [string, number][];
  sizes?: [string, number][];
  created?: [string, number][];
}

/** file.* pseudo-prop values — a note's own metadata so `prop:`,
 * `cols:` and `group:` reach them through one code path. */
function fileProp(key: string, note: string, mtime: number, size: number, ctime: number) {
  switch (key.toLowerCase()) {
    case "file.name":
    case "file.stem":
      return stem(note);
    case "file.mtime":
    case "file.modified":
      return mtime ? new Date(mtime * 1000).toISOString().slice(0, 10) : "";
    case "file.ctime":
    case "file.created":
      return ctime ? new Date(ctime * 1000).toISOString().slice(0, 10) : "";
    case "file.size":
      return size ? (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`) : "";
    case "file.ext":
      return note.includes(".") ? note.slice(note.lastIndexOf(".") + 1) : "";
    default:
      return undefined;
  }
}

/** per-note prop maps — fm props merged with file.* pseudo-props and
 * link counts, keyed by note name. Shared by bases and the graph so a
 * `prop:`/`is:` filter means the same thing on every surface. */
export function buildPropMaps(ix: IndexLike): Map<string, Map<string, string>> {
  ix = ix && typeof ix === "object" ? ix : ({} as IndexLike);
  const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
  const mtimes = new Map(list(ix.modified).map(([n, m]) => [n, m]));
  const sizes = new Map(list(ix.sizes).map(([n, s]) => [n, s]));
  const ctimes = new Map(list(ix.created).map(([n, c]) => [n, c]));
  // link counts — how many notes point at / out of each note.
  // ix.links targets are raw [[stems]] — key both sides by stem or
  // the filename-vs-stem compare silently zeroes every count
  const inLink = new Map<string, number>(), outLink = new Map<string, number>();
  for (const pair of list(ix.links)) {
    const [from, to] = Array.isArray(pair) ? pair : ["", ""];
    inLink.set(stem(to), (inLink.get(stem(to)) ?? 0) + 1);
    outLink.set(stem(from), (outLink.get(stem(from)) ?? 0) + 1);
  }
  const byNote = new Map<string, Map<string, string>>();
  const fileOf = (n: string) => {
    const m = new Map<string, string>();
    for (const k of ["file.name", "file.stem", "file.mtime", "file.modified", "file.ctime", "file.created", "file.size", "file.ext"]) {
      const v = fileProp(k, n, mtimes.get(n) ?? 0, sizes.get(n) ?? 0, ctimes.get(n) ?? 0);
      if (v) m.set(k, v);
    }
    m.set("file.backlinks", String(inLink.get(stem(n)) ?? 0));
    m.set("file.outlinks", String(outLink.get(stem(n)) ?? 0));
    return m;
  };
  for (const row of list(ix.props)) {
    if (!Array.isArray(row)) continue;
    const [note, k, v] = row.map((x) => S(x));
    if (!byNote.has(note)) byNote.set(note, fileOf(note));
    byNote.get(note)!.set(k, v);
  }
  for (const n of list(ix.notes).map((x) => S(x))) if (!byNote.has(n)) byNote.set(n, fileOf(n));
  return byNote;
}

export function baseSort(spec: string): (a: Map<string, string>, b: Map<string, string>) => number {
  const rules = S(spec).split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(-?)([\w.-]+)(?:\s+(asc|desc))?$/i);
    return m ? { key: m[2].toLowerCase(), desc: m[1] === "-" || m[3]?.toLowerCase() === "desc" } : null;
  }).filter((r): r is { key: string; desc: boolean } => !!r);
  const get = (m: Map<string, string>, k: string) =>
    [...m.entries()].find(([kk]) => kk.toLowerCase() === k)?.[1] ?? "";
  return (a, b) => {
    for (const r of rules) {
      const av = get(a, r.key), bv = get(b, r.key);
      if (av === bv) continue;
      const an = Number(av), bn = Number(bv);
      const bothNum = av !== "" && bv !== "" && !isNaN(an) && !isNaN(bn);
      const c = bothNum ? an - bn : av.localeCompare(bv);
      // empty values sink to the bottom regardless of direction
      if (av === "") return 1;
      if (bv === "") return -1;
      if (c !== 0) return r.desc ? -c : c;
    }
    return 0;
  };
}

/* the external api — ```base fences drive it: set the query/view, read rows */
export interface BaseApi {
  title(): string;
  view(): string;
  query(): string;
  set(p: { q?: string; cols?: string; sort?: string; group?: string; view?: string; in?: string }): void;
  rows(): string[];
  read(): string;
}
const apis = new WeakMap<HTMLElement, BaseApi>();
export function baseApi(card: HTMLElement): BaseApi | undefined {
  return apis.get(card);
}

export function wireBase(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.baseWired) return;
  card.dataset.baseWired = "1";
  const body = card.querySelector<HTMLElement>(".base-body")!;
  const qIn = card.querySelector<HTMLInputElement>(".base-q")!;
  const colsIn = card.querySelector<HTMLInputElement>(".base-cols")!;
  const sortIn = card.querySelector<HTMLInputElement>(".base-sort")!;
  const groupIn = card.querySelector<HTMLInputElement>(".base-group")!;
  const vtBtn = card.querySelector<HTMLElement>(".base-vt")!;
  if (!body || !qIn || !colsIn || !sortIn || !groupIn || !vtBtn) return;
  qIn.value = card.dataset.q ?? "";
  // query autocomplete — a datalist of prop keys + is: predicates +
  // file.* pseudo-props, rebuilt from the index on each focus
  const dl = document.createElement("datalist");
  dl.id = `bdl-${Math.random().toString(36).slice(2, 8)}`;
  card.append(dl);
  qIn.setAttribute("list", dl.id);
  qIn.addEventListener("focus", () => {
    void invoke<{ props?: [string, string, string][] }>("vault_index")
      .then((ix) => {
        const keys = new Set<string>();
        for (const [, k] of ix?.props ?? []) keys.add(k);
        const sugg = [
          ...[...keys].map((k) => `prop:${k}=`),
          ...["overdue", "today", "week", "nodate", "daily", "template", "persona", "done", "task"]
            .map((p) => `is:${p}`),
          ...["file.name", "file.mtime", "file.ctime", "file.size", "file.ext", "file.backlinks", "file.outlinks"]
            .map((k) => `prop:${k}`),
        ];
        // datalist completes the whole input — a lone-token UX aid; the
        // multi-token q: grammar is documented in the title tooltip
        dl.innerHTML = sugg.map((s) => `<option value="${esc(s)}">`).join("");
      })
      .catch(() => {});
  });
  colsIn.value = card.dataset.cols ?? "";
  sortIn.value = card.dataset.sort ?? "";
  groupIn.value = card.dataset.group ?? "";

  /** latest render's view snapshot — cols/rows/cell for the ⤓ bridge */
  let exportData: { cols: string[]; rows: string[]; cell: (n: string, c: string) => string } | null = null;

  async function load() {
    const ix = await invoke<IndexLike>("vault_index").catch(() => null);
    if (!ix) return;
    // fm props + file.* + link counts per note
    const byNote = buildPropMaps(ix);
    // formula columns — evaluate into every note's prop map so match,
    // sort, group and cols all treat `f:` results like real props
    const fxDefs = new Map<string, string>();
    for (const d of (card.dataset.fx ?? "").split(";;").filter(Boolean)) {
      const eq = d.indexOf("=");
      if (eq > 0) fxDefs.set(d.slice(0, eq), d.slice(eq + 1));
    }
    for (const m of byNote.values())
      for (const [name, expr] of fxDefs)
        m.set(name, String(evalFormula(expr, m)));
    const q = card.dataset.q ?? "";
    // `> in: projects/` scopes the whole view to a folder prefix
    const scope = (card.dataset.in ?? "").trim().replace(/\/+$/, "");
    let rows = ix.notes
      .filter((n) => !scope || n === scope || n.startsWith(scope + "/"))
      .filter((n) => baseMatch(q, stem(n), byNote.get(n) ?? new Map()));
    const sortSpec = card.dataset.sort?.trim() ?? "";
    if (sortSpec) {
      const cmp = baseSort(sortSpec);
      rows = [...rows].sort((a, b) =>
        cmp(byNote.get(a) ?? new Map(), byNote.get(b) ?? new Map()));
    }
    const cols = (card.dataset.cols ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const effCols = cols.length
      ? cols
      : [...new Set(rows.flatMap((n) => [...(byNote.get(n)?.keys() ?? [])]))]
          .filter((k) => !k.toLowerCase().startsWith("file."))
          .slice(0, 5);
    const cell = (n: string, c: string) => {
      const props = byNote.get(n) ?? new Map();
      return [...props.entries()].find(([k]) => k.toLowerCase() === c.toLowerCase())?.[1] ?? "·";
    };
    const group = card.dataset.group?.trim() ?? "";
    const board = card.dataset.view === "board" && group !== "";
    groupIn.style.display = board || group ? "" : "none";
    vtBtn.classList.toggle("on", board);
    vtBtn.title = group ? "toggle table / board" : "set a group property first";

    // the ⤓ bridge — snapshot this render for sheet export
    const cap = Number(card.dataset.limit) > 0 ? Number(card.dataset.limit) : 60;
    exportData = { cols: effCols, rows: rows.slice(0, Math.max(cap, 200)), cell };

    if (board) return paintBoard(rows, byNote);
    if (card.dataset.view === "calendar") return paintCalendar(rows);
    if (card.dataset.view === "list") return paintList(rows);
    paintTable(rows);

    /** month grid over a date prop — `> date: due` picks it,
     *  file.mtime by default. ◀▶ walk months; chips open the note. */
    function paintCalendar(rows: string[]) {
      const dateKey = (card.dataset.date ?? "").trim() || "file.mtime";
      // chips reschedule only onto real frontmatter props — file.* and
      // formula results are computed, not writable
      const writable = !dateKey.toLowerCase().startsWith("file.") && !fxDefs.has(dateKey.toLowerCase());
      const nowYm = new Date().toISOString().slice(0, 7);
      const [y, m] = (card.dataset.ym ?? nowYm).split("-").map(Number);
      const byDay = new Map<string, string[]>();
      for (const n of rows) {
        const dm = cell(n, dateKey).match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!dm) continue;
        const d = `${dm[1]}-${dm[2]}-${dm[3]}`;
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d)!.push(n);
      }
      const dim = new Date(y, m, 0).getDate();
      const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Mon-start
      const span = card.dataset.span === "week" ? "week" : "month";
      const todayIso = new Date().toISOString().slice(0, 10);
      const wrap = document.createElement("div");
      wrap.className = "base-cal";
      const head = document.createElement("div");
      head.className = "bc-head";
      head.innerHTML =
        `<button class="bc-nav" data-d="-1" title="prev ${span}">◀</button>` +
        `<span class="bc-ym">${y}-${String(m).padStart(2, "0")}</span>` +
        `<button class="bc-nav" data-d="1" title="next ${span}">▶</button>` +
        `<button class="bc-today" title="jump to now">•</button>` +
        `<button class="bc-span" title="toggle week / month">${span === "week" ? "▤" : "▦"}</button>` +
        `<span class="bc-key">${esc(dateKey)}</span>`;
      head.querySelectorAll<HTMLElement>(".bc-nav").forEach((b) =>
        b.addEventListener("click", () => {
          const d = Number(b.dataset.d);
          if (span === "week") {
            // walk by 7 days from the week anchor (stored in data-wk)
            const anchor = card.dataset.wk ?? todayIso;
            const t = new Date(anchor + "T00:00:00");
            t.setDate(t.getDate() + d * 7);
            card.dataset.wk = t.toISOString().slice(0, 10);
          } else {
            const ny = m + d > 12 ? y + 1 : m + d < 1 ? y - 1 : y;
            const nm = m + d > 12 ? 1 : m + d < 1 ? 12 : m + d;
            card.dataset.ym = `${ny}-${String(nm).padStart(2, "0")}`;
          }
          void load();
        }));
      head.querySelector(".bc-today")!.addEventListener("click", () => {
        card.dataset.ym = nowYm;
        card.dataset.wk = todayIso;
        void load();
      });
      head.querySelector(".bc-span")!.addEventListener("click", () => {
        card.dataset.span = span === "week" ? "month" : "week";
        card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
        void load();
      });
      wrap.append(head);
      const grid = document.createElement("div");
      grid.className = "bc-grid" + (span === "week" ? " bc-week" : "");
      for (const w of ["mo", "tu", "we", "th", "fr", "sa", "su"])
        grid.insertAdjacentHTML("beforeend", `<div class="bc-w">${w}</div>`);
      // one day's cell — chips, drop-reschedule, `+` creates a dated note
      const dayCell = (iso: string, dnum: number | string) => {
        const cellEl = document.createElement("div");
        cellEl.className = "bc-day" + (iso === todayIso ? " today" : "");
        cellEl.innerHTML = `<span class="bc-d">${dnum}</span>`;
        const notes = byDay.get(iso) ?? [];
        const show = span === "week" ? notes.length : 3;
        for (const n of notes.slice(0, show)) {
          const chip = document.createElement("div");
          chip.className = "bc-chip";
          chip.textContent = stem(n);
          chip.title = `${stem(n)} — ${cell(n, dateKey)}`;
          chip.draggable = writable;
          let dragged = false;
          chip.addEventListener("dragstart", (e) => {
            dragged = true;
            e.dataTransfer?.setData("laido/base-card", n);
            e.stopPropagation();
          });
          chip.addEventListener("dragend", () => (dragged = false));
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!dragged) document.dispatchEvent(new CustomEvent("nav:open", { detail: n }));
          });
          // right-click → open / reschedule / clear (writable dates only)
          chip.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.querySelectorAll(".bc-menu").forEach((m) => m.remove());
            const menu = document.createElement("div");
            menu.className = "bc-menu";
            const item = (label: string, fn: () => void) => {
              const b = document.createElement("button");
              b.textContent = label;
              b.addEventListener("click", () => { menu.remove(); fn(); });
              menu.append(b);
            };
            item("open", () =>
              document.dispatchEvent(new CustomEvent("nav:open", { detail: n })));
            if (writable) {
              const shift = (days: number) => {
                const d = new Date();
                d.setDate(d.getDate() + days);
                void setProp(n, dateKey, d.toISOString().slice(0, 10));
              };
              item(`→ today`, () => shift(0));
              item(`→ tomorrow`, () => shift(1));
              item(`→ next week`, () => shift(7));
              item(`clear ${dateKey}`, () => void setProp(n, dateKey, ""));
            }
            menu.style.left = `${e.clientX}px`;
            menu.style.top = `${e.clientY}px`;
            document.body.append(menu);
            setTimeout(() =>
              document.addEventListener("mousedown", () => menu.remove(), { once: true }), 0);
          });
          cellEl.append(chip);
        }
        if (writable) {
          // drag a chip onto this day → the date prop rewrites itself
          cellEl.addEventListener("dragover", (e) => {
            if (e.dataTransfer?.types.includes("laido/base-card")) {
              e.preventDefault();
              cellEl.classList.add("over");
            }
          });
          cellEl.addEventListener("dragleave", () => cellEl.classList.remove("over"));
          cellEl.addEventListener("drop", (e) => {
            e.preventDefault();
            cellEl.classList.remove("over");
            const note = e.dataTransfer?.getData("laido/base-card");
            if (!note) return;
            void setProp(note, dateKey, iso);
          });
          // `+` on the day → a new note already carrying that date
          const add = document.createElement("button");
          add.className = "bc-add";
          add.textContent = "＋";
          add.title = `new note with ${dateKey}: ${iso}`;
          add.addEventListener("click", async (e) => {
            e.stopPropagation();
            const name = await invoke<string>("vault_create").catch(() => "");
            if (!name) return;
            await invoke("vault_write", {
              name,
              content: `---\n${dateKey}: ${iso}\n---\n`,
            }).catch(() => {});
            void load();
          });
          cellEl.append(add);
        }
        if (notes.length > show)
          cellEl.insertAdjacentHTML("beforeend", `<div class="bc-more">+${notes.length - show}</div>`);
        return cellEl;
      };
      if (span === "week") {
        // Mon-start week containing data.wk (defaults to today)
        const anchor = card.dataset.wk ?? todayIso;
        const a = new Date(anchor + "T00:00:00");
        a.setDate(a.getDate() - ((a.getDay() + 6) % 7));
        for (let i = 0; i < 7; i++) {
          const t = new Date(a);
          t.setDate(a.getDate() + i);
          const iso = t.toISOString().slice(0, 10);
          grid.append(dayCell(iso, t.getDate()));
        }
      } else {
        for (let i = 0; i < lead; i++) grid.append(document.createElement("div"));
        for (let d = 1; d <= dim; d++) {
          const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          grid.append(dayCell(iso, d));
        }
      }
      body.innerHTML = "";
      body.append(wrap);
      const meta = document.createElement("div");
      meta.className = "base-meta";
      const placed = [...byDay.keys()].filter((k) => k.startsWith(`${y}-${String(m).padStart(2, "0")}`)).reduce((a, k) => a + byDay.get(k)!.length, 0);
      meta.textContent = `${placed} of ${rows.length} notes this month`;
      body.append(meta);
    }

    /** write `key: value` into note `n`'s frontmatter, then rescan —
     *  the one write path for every editable cell (snapshot-backed,
     *  so `> history` on that note undoes a bad edit) */
    const setProp = (n: string, k: string, v: string) =>
      invoke("vault_prop_set", { note: n, key: k, value: v })
        .then(() => load())
        .catch(() => {});

    /** click a prop cell → inline editor (GoodBases convention:
     *  checkbox values toggle in place; file-props and formula
     *  columns are read-only) */
    function editCell(td: HTMLElement, n: string, key: string) {
      if (key.toLowerCase().startsWith("file.") || fxDefs.has(key.toLowerCase())) return;
      const cur = cell(n, key);
      if (cur === "true" || cur === "false") {
        void setProp(n, key, cur === "true" ? "false" : "true");
        return;
      }
      const inp = document.createElement("input");
      inp.className = "base-edit";
      inp.value = cur === "·" ? "" : cur;
      inp.spellcheck = false;
      td.textContent = "";
      td.append(inp);
      inp.focus();
      inp.select();
      const commit = () => {
        const v = inp.value.trim();
        if (v !== cur && v !== "") void setProp(n, key, v);
        else load();
      };
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { inp.blur(); }
        if (e.key === "Escape") { inp.onblur = null; load(); }
      });
      inp.onblur = commit;
    }

    function paintList(rows: string[]) {
      // Obsidian list layout — title left, first props right
      if (!rows.length) {
        body.innerHTML = `<div class="base-empty">no notes match${q ? ` “${esc(q)}”` : ""}</div>`;
        return;
      }
      const list = document.createElement("div");
      list.className = "base-list";
      for (const n of rows.slice(0, cap)) {
        const r = document.createElement("div");
        r.className = "base-lrow";
        const sub = effCols.slice(0, 3).map((c) => cell(n, c)).filter((x) => x && x !== "·").join("  ·  ");
        r.innerHTML = `<span class="base-lname">${esc(stem(n))}</span><span class="base-lprops">${esc(sub)}</span>`;
        r.addEventListener("click", () =>
          document.dispatchEvent(new CustomEvent("nav:open", { detail: n })));
        list.append(r);
      }
      body.innerHTML = "";
      body.append(list);
      const meta = document.createElement("div");
      meta.className = "base-meta";
      meta.textContent = `${rows.length} notes`;
      body.append(meta);
    }

    function paintTable(rows: string[]) {
      if (!rows.length) {
        body.innerHTML = `<div class="base-empty">no notes match${q ? ` “${esc(q)}”` : ""} — add properties with a --- block</div>`;
        return;
      }
      const table = document.createElement("table");
      table.className = "base-table";
      table.innerHTML =
        `<thead><tr><th>note</th>${effCols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>`;
      const tb = document.createElement("tbody");
      for (const n of rows.slice(0, cap)) {
        const tr = document.createElement("tr");
        const nameTd = document.createElement("td");
        nameTd.className = "base-name";
        nameTd.textContent = stem(n);
        nameTd.addEventListener("click", () =>
          document.dispatchEvent(new CustomEvent("nav:open", { detail: n })));
        tr.append(nameTd);
        for (const c of effCols) {
          const td = document.createElement("td");
          const v = cell(n, c);
          const ro = c.toLowerCase().startsWith("file.") || fxDefs.has(c.toLowerCase());
          if ((v === "true" || v === "false") && !ro) {
            td.className = "base-bool";
            td.innerHTML = `<input type="checkbox"${v === "true" ? " checked" : ""}/>`;
            td.querySelector("input")!.addEventListener("click", (e) => {
              e.stopPropagation();
              void setProp(n, c, v === "true" ? "false" : "true");
            });
          } else {
            td.textContent = v;
            if (!ro) {
              td.classList.add("base-ed");
              td.title = "click to edit";
              td.addEventListener("click", (e) => {
                e.stopPropagation();
                editCell(td, n, c);
              });
            } else td.classList.add("base-ro");
          }
          tr.append(td);
        }
        tb.append(tr);
      }
      table.append(tb);
      // `> sum: a,b` → footer summaries — numeric cols total, the rest
      // count unique values (Obsidian's column summaries, one flat row)
      const sumCols = (card.dataset.sum ?? "")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (sumCols.length) {
        const tf = document.createElement("tfoot");
        const fr = document.createElement("tr");
        fr.innerHTML = `<td class="base-sumlab">Σ</td>`;
        for (const c of effCols) {
          const td = document.createElement("td");
          if (sumCols.includes(c.toLowerCase())) {
            const vs = rows.map((n) => cell(n, c)).filter((v) => v && v !== "·");
            const nums = vs.map(Number).filter((x) => !isNaN(x));
            td.className = "base-sumv";
            td.textContent = nums.length && nums.length === vs.length
              ? `Σ ${nums.reduce((a, b) => a + b, 0)}`
              : `${new Set(vs).size} uniq`;
          }
          fr.append(td);
        }
        tf.append(fr);
        table.append(tf);
      }
      body.innerHTML = "";
      body.append(table);
      const meta = document.createElement("div");
      meta.className = "base-meta";
      meta.textContent = `${rows.length} note${rows.length === 1 ? "" : "s"}${rows.length > cap ? ` — first ${cap}` : ""}`;
      body.append(meta);
    }

    function paintBoard(rows: string[], byNote: Map<string, Map<string, string>>) {
      // columns = the group property's distinct values (sorted), + a
      // "none" column for notes without it
      const groupKey = card.dataset.group!.trim();
      const vals = new Map<string, string[]>(); // value → notes
      const none: string[] = [];
      for (const n of rows) {
        const props = byNote.get(n) ?? new Map();
        const v = [...props.entries()].find(([k]) => k.toLowerCase() === groupKey.toLowerCase())?.[1] ?? "";
        if (!v) { none.push(n); continue; }
        for (const piece of v.split(",").map((s: string) => s.trim()).filter(Boolean)) {
          if (!vals.has(piece)) vals.set(piece, []);
          vals.get(piece)!.push(n);
        }
      }
      // `gorder: a,b,null,c` pins column order — only listed values
      // show (Obsidian groupOrder); `null`/`none` positions the
      // uncategorized column. No gorder → alpha sort, none last.
      const gspec = (card.dataset.gorder ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      let cols2: string[];
      if (gspec.length) {
        cols2 = gspec
          .map((g) => (/^(null|none)$/i.test(g) ? "" : g))
          .filter((g) => (g === "" ? none.length > 0 : vals.has(g)));
      } else {
        cols2 = [...vals.keys()].sort();
        if (none.length) cols2.push(""); // "" renders as "none"
      }
      if (!cols2.length) {
        body.innerHTML = `<div class="base-empty">no values for “${esc(groupKey)}” — add it to a note's properties</div>`;
        return;
      }
      // `corder: a.md,b.md` — within-column card order persists in the
      // board file (kanban-plugin convention), not in each note's fm
      const orderList = (card.dataset.corder ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      const posOf = (n: string) => {
        const i = orderList.indexOf(n);
        return i < 0 ? 1e9 + rows.indexOf(n) : i;
      };
      for (const arr of vals.values()) arr.sort((a, b) => posOf(a) - posOf(b));
      none.sort((a, b) => posOf(a) - posOf(b));
      const board = document.createElement("div");
      board.className = "base-board";
      // persist the rendered card order — DOM order across every column
      const persistOrder = (note: string, before: string | null) => {
        const ord = [...board.querySelectorAll<HTMLElement>(".bb-card")]
          .map((c2) => c2.dataset.note ?? "")
          .filter((x) => x && x !== note);
        if (before && ord.includes(before)) ord.splice(ord.indexOf(before), 0, note);
        else ord.push(note);
        card.dataset.corder = ord.join(",");
        card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
      };
      // `> hide: a,b` — collapsed columns show name + count only
      const hidden = new Set(
        (card.dataset.hide ?? "").split(",").map((s) => s.trim()).filter(Boolean));
      // `> sum: k` totals the column's values per group — Notion's
      // board aggregations (only numeric values count)
      const sumKeys = (card.dataset.sum ?? "")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      for (const val of cols2) {
        const notes = val === "" ? none : vals.get(val)!;
        const col = document.createElement("div");
        col.className = "bb-col" + (hidden.has(val) ? " bb-mini" : "");
        col.dataset.val = val;
        const colSum = sumKeys.length
          ? notes.reduce((a, n) => a + (Number(cell(n, sumKeys[0])) || 0), 0)
          : null;
        col.innerHTML =
          `<div class="bb-head"><span class="bb-name">${val ? esc(val) : "· none"}</span>` +
          `<span class="bb-count">${notes.length}</span>` +
          (colSum !== null
            ? `<span class="bb-sum" title="Σ ${sumKeys[0]} over this column">Σ ${Math.round(colSum * 100) / 100}</span>`
            : "") +
          `<button class="bb-fold" title="collapse column">${hidden.has(val) ? "▸" : "▾"}</button>` +
          `<button class="bb-add" title="new note with ${esc(val) || "a value"}">＋</button></div>`;
        col.querySelector(".bb-fold")!.addEventListener("click", (e) => {
          e.stopPropagation();
          if (hidden.has(val)) hidden.delete(val); else hidden.add(val);
          card.dataset.hide = [...hidden].join(",");
          card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
          void load();
        });
        const list = document.createElement("div");
        list.className = "bb-list";
        for (const n of notes) {
          const c = document.createElement("div");
          c.className = "bb-card";
          c.draggable = true;
          c.dataset.note = n;
          const face = effCols
            .filter((x) => x.toLowerCase() !== groupKey.toLowerCase())
            .slice(0, 2)
            .map((x) => ({ k: x, v: cell(n, x) }))
            .filter((f) => f.v && f.v !== "·");
          c.innerHTML =
            `<div class="bb-title">${esc(stem(n))}</div>` +
            (face.length
              ? `<div class="bb-sub">` + face.map((f) =>
                  `<span class="bb-chip" data-k="${esc(f.k)}" title="${esc(f.k)} — dbl-click to edit">${esc(f.v)}</span>`
                ).join(" · ") + `</div>`
              : "");
          // dbl-click a face chip → inline edit writes through to fm
          c.querySelectorAll<HTMLElement>(".bb-chip").forEach((chip) => {
            const key = chip.dataset.k ?? "";
            if (key.toLowerCase().startsWith("file.") || fxDefs.has(key.toLowerCase())) {
              chip.classList.add("base-ro");
              chip.title = `${key} — read-only`;
              return;
            }
            chip.addEventListener("dblclick", (e) => {
              e.stopPropagation();
              const orig = chip.textContent ?? "";
              const inp = document.createElement("input");
              inp.className = "base-edit";
              inp.value = orig;
              inp.spellcheck = false;
              chip.textContent = "";
              chip.append(inp);
              inp.focus();
              inp.select();
              inp.addEventListener("keydown", (ev) => {
                ev.stopPropagation();
                if (ev.key === "Enter") inp.blur();
                if (ev.key === "Escape") { inp.onblur = null; void load(); }
              });
              inp.onblur = () => {
                const v = inp.value.trim();
                if (v && v !== orig) void setProp(n, key, v);
                else void load();
              };
            });
          });
          let dragged = false;
          c.addEventListener("dragstart", (e) => {
            dragged = true;
            e.dataTransfer?.setData("text/plain", n);
            e.dataTransfer?.setData("laido/base-card", n);
          });
          c.addEventListener("dragend", () => (dragged = false));
          c.addEventListener("click", () => {
            if (!dragged) document.dispatchEvent(new CustomEvent("nav:open", { detail: n }));
          });
          // dropping a card on a card inserts before it — same column is
          // a pure reorder (corder), different column also writes the prop
          c.addEventListener("dragover", (e) => {
            if (e.dataTransfer?.types.includes("laido/base-card")) {
              e.preventDefault();
              e.stopPropagation();
              c.classList.add("insert");
            }
          });
          c.addEventListener("dragleave", () => c.classList.remove("insert"));
          c.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            c.classList.remove("insert");
            const note = e.dataTransfer?.getData("laido/base-card");
            if (!note || note === n) return;
            const cur = cell(note, groupKey);
            const sameCol = cur.split(",").map((s: string) => s.trim()).includes(val) ||
              (val === "" && !cur);
            persistOrder(note, n);
            if (!sameCol)
              void invoke("vault_prop_set", { note, key: groupKey, value: val })
                .then(() => load()).catch(() => {});
            else void load();
          });
          list.append(c);
        }
        col.append(list);
        // drop target — moving a card here writes the group property into
        // the note's frontmatter (snapshot-backed, so `> history` undoes)
        col.addEventListener("dragover", (e) => {
          if (e.dataTransfer?.types.includes("laido/base-card") ||
              e.dataTransfer?.types.includes("laido/base-col")) {
            e.preventDefault();
            col.classList.add("over");
          }
        });
        col.addEventListener("dragleave", () => col.classList.remove("over"));
        col.addEventListener("drop", (e) => {
          e.preventDefault();
          col.classList.remove("over");
          const rawCol = e.dataTransfer?.getData("laido/base-col");
          if (rawCol) {
            const fromCol = rawCol === "null" ? "" : rawCol;
            // column reorder → persist as gorder ("" round-trips as null)
            const order = cols2.filter((x) => x !== fromCol);
            order.splice(order.indexOf(val), 0, fromCol);
            card.dataset.gorder = order.map((x) => (x === "" ? "null" : x)).join(",");
            card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
            void load();
            return;
          }
          const note = e.dataTransfer?.getData("laido/base-card");
          if (!note) return;
          const cur = cell(note, groupKey);
          const sameCol = cur.split(",").map((s: string) => s.trim()).includes(val) ||
            (val === "" && !cur);
          persistOrder(note, null); // empty-space drop → end of column
          if (!sameCol)
            void invoke("vault_prop_set", { note, key: groupKey, value: val })
              .then(() => load()).catch(() => {});
          else void load();
        });
        // dragging the head reorders columns (Notion/Obsidian boards) —
        // the order lands in data-gorder so it persists in the markdown
        const h = col.querySelector<HTMLElement>(".bb-head")!;
        h.draggable = true;
        h.addEventListener("dragstart", (e) => {
          e.dataTransfer?.setData("laido/base-col", val === "" ? "null" : val);
          e.stopPropagation(); // never collide with card drags
        });
        // column `+` → a new note pre-filled with the group value, and
        // appended to corder so it lands at the column's end
        col.querySelector(".bb-add")!.addEventListener("click", async () => {
          const name = await invoke<string>("vault_create").catch(() => "");
          if (!name) return;
          await invoke("vault_write", {
            name,
            content: `---\n${groupKey}: ${val}\n---\n\n`,
          }).catch(() => {});
          const cur = (card.dataset.corder ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          // insert after this column's last card — new notes shouldn't
          // teleport past cards sitting in later columns
          const lastOfCol = [...notes].pop();
          const at = lastOfCol ? cur.indexOf(lastOfCol) : -1;
          if (at >= 0) cur.splice(at + 1, 0, name); else cur.push(name);
          card.dataset.corder = cur.join(",");
          card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
          void load();
        });
        board.append(col);
      }
      body.innerHTML = "";
      body.append(board);
    }
  }

  const sync = () => {
    card.dataset.q = qIn.value;
    card.dataset.cols = colsIn.value;
    card.dataset.sort = sortIn.value;
    card.dataset.group = groupIn.value;
    card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
    void load();
  };
  qIn.addEventListener("change", sync);
  colsIn.addEventListener("change", sync);
  sortIn.addEventListener("change", sync);
  groupIn.addEventListener("change", sync);
  for (const inp of [qIn, colsIn, sortIn, groupIn])
    inp.addEventListener("keydown", (e) => e.stopPropagation());
  vtBtn.addEventListener("click", () => {
    // cycle table → board (when grouped) → list → calendar → table
    const views = card.dataset.group?.trim()
      ? ["table", "board", "list", "calendar"]
      : ["table", "list", "calendar"];
    const i = views.indexOf(card.dataset.view ?? "table");
    card.dataset.view = views[(i + 1) % views.length];
    card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
    void load();
  });
  card.querySelector(".base-re")!.addEventListener("click", () => void load());
  card.querySelector(".base-csv")!.addEventListener("click", () => {
    if (!exportData) return;
    // the query result lands as a real [!sheet] card — formulas,
    // sorting, xlsx export: the base filters, the sheet computes
    const rows = [
      ["note", ...exportData.cols],
      ...exportData.rows.map((n) => [
        stem(n),
        ...exportData!.cols.map((c) => exportData!.cell(n, c)),
      ]),
    ];
    const md =
      `> [!sheet] ${card.dataset.title ?? "base"}\n` +
      rows.map((r) => `> | ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
    document.dispatchEvent(new CustomEvent("base:export", { detail: md }));
  });
  // ⇩ — the same view as CSV on the clipboard (RFC-4180 quoting)
  card.querySelector(".base-copy")!.addEventListener("click", () => {
    if (!exportData) return;
    const csvq = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [
      ["note", ...exportData.cols].map(csvq).join(","),
      ...exportData.rows.map((n) =>
        [stem(n), ...exportData!.cols.map((c) => exportData!.cell(n, c))].map(csvq).join(",")),
    ].join("\n");
    void navigator.clipboard?.writeText(csv).then(() =>
      addActivity(`copied ${exportData!.rows.length} rows as CSV`));
  });
  // 📊 — materialize the view as a [!chart] card: first the type
  // picker (bar/line/pie/doughnut), then the first numeric column
  // becomes the series; none → a count per group-column value
  card.querySelector(".base-chart")!.addEventListener("click", (ev) => {
    if (!exportData) return;
    document.querySelectorAll(".bc-menu").forEach((m) => m.remove());
    const menu = document.createElement("div");
    menu.className = "bc-menu";
    for (const ty of ["bar", "line", "pie", "doughnut"]) {
      const b = document.createElement("button");
      b.textContent = `${ty} chart`;
      b.addEventListener("click", () => {
        menu.remove();
        const numCol = exportData!.cols.find((c) =>
          exportData!.rows.length > 0 &&
          exportData!.rows.every((n) => {
            const v = exportData!.cell(n, c);
            return v === "" || !isNaN(Number(v));
          }) &&
          exportData!.rows.some((n) => exportData!.cell(n, c) !== ""));
        const rows: string[] = [];
        if (numCol) {
          for (const n of exportData!.rows.slice(0, 20)) {
            const v = exportData!.cell(n, numCol);
            if (v !== "") rows.push(`> ${stem(n).replace(/\|/g, "/")} | ${v}`);
          }
        } else {
          const gk = card.dataset.group?.trim() || exportData!.cols[0];
          const counts = new Map<string, number>();
          for (const n of exportData!.rows)
            for (const v of (exportData!.cell(n, gk ?? "") || "·").split(",").map((s) => s.trim()))
              counts.set(v, (counts.get(v) ?? 0) + 1);
          for (const [v, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
            rows.push(`> ${v.replace(/\|/g, "/")} | ${c}`);
        }
        if (!rows.length) return;
        document.dispatchEvent(new CustomEvent("base:export", {
          detail: `> [!chart] ${card.dataset.title ?? "base"}\n> type: ${ty}\n` + rows.join("\n"),
        }));
      });
      menu.append(b);
    }
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.body.append(menu);
    setTimeout(() =>
      document.addEventListener("mousedown", () => menu.remove(), { once: true }), 0);
  });

  // live view — any save/index refresh repaints this base; the listener
  // removes itself once the card is gone so deleted bases stop reloading
  const onIndex = () => {
    if (!card.isConnected) {
      document.removeEventListener("index:changed", onIndex);
      return;
    }
    void load();
  };
  document.addEventListener("index:changed", onIndex);
  void load();

  /* the external api — a ```base fence drives this */
  apis.set(card, {
    title: () => card.dataset.title ?? "base",
    view: () => card.dataset.view ?? "table",
    query: () => card.dataset.q ?? "",
    set: (p) => {
      if (!p || typeof p !== "object") return;
      if (p.q !== undefined) card.dataset.q = S(p.q).slice(0, 500);
      if (p.cols !== undefined) card.dataset.cols = S(p.cols).slice(0, 300);
      if (p.sort !== undefined) card.dataset.sort = S(p.sort).slice(0, 120);
      if (p.group !== undefined) card.dataset.group = S(p.group).slice(0, 80);
      if (p.in !== undefined)
        card.dataset.in = S(p.in).replace(/\.\./g, "").replace(/^\/+/, "").slice(0, 200);
      if (p.view !== undefined && ["table", "board", "list", "calendar"].includes(S(p.view)))
        card.dataset.view = S(p.view);
      qIn.value = card.dataset.q ?? "";
      colsIn.value = card.dataset.cols ?? "";
      sortIn.value = card.dataset.sort ?? "";
      groupIn.value = card.dataset.group ?? "";
      card.dispatchEvent(new CustomEvent("base:changed", { bubbles: true }));
      void load();
    },
    rows: () => exportData?.rows ?? [],
    read: () =>
      !exportData
        ? ""
        : [`note | ${exportData.cols.join(" | ")}`,
            ...exportData.rows
              .slice(0, 50)
              .map((n) => `${stem(n)} | ${exportData!.cols.map((c) => exportData!.cell(n, c)).join(" | ")}`),
          ].join("\n"),
  });
}
