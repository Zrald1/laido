import { invoke } from "./ipc.js";
import { addActivity } from "./log.js";
import { currentNote, spawnTerminalCard, spawnSheetCard, spawnDeckCard, insertClip, spawnCardsCard, loadNote } from "./editor.js";
import { sheetApi, cellName, refRC, expandRange, isStyleSpec } from "./sheet.js";
import { deckApi, parseSlideLine, parseElLine, emptySlide, DECK_LAYOUTS, DECK_THEMES, DECK_TRANSITIONS } from "./slides.js";
import { todoApi } from "./todo.js";
import { spawnTodoCard, spawnBrowserCard } from "./editor.js";
import { browserApi } from "./browser.js";
import { clipToDaily } from "./links.js";
import { wireChatTools, type ChatImage } from "./chatplus.js";
import { cardsApi } from "./cards.js";
import { chartApi, CHART_TYPES } from "./chart.js";
import { spawnChartCard } from "./editor.js";
import { mapApi } from "./map.js";
import { spawnMapCard } from "./editor.js";
import { baseApi } from "./base.js";
import { spawnBaseCard, spawnAgendaCard, spawnGraphCard, spawnCanvasCard } from "./editor.js";

interface TermResult {
  ok: boolean;
  needs_confirm: boolean;
  output: string;
  code: number | null;
}

interface TermAi {
  text: string;
  commands: string[];
  laido: string[];
  web: string[];
  notes: string[];
  send: string[];
  assign: string[];
  spawn: string[];
  sheet: string[];
  slides: string[];
  todo: string[];
  browser: string[];
  chart: string[];
  cards: string[];
  maps: string[];
  vault: string[];
  base: string[];
}

const MAX_STEPS = 12;

/** pull path/format/sheet tokens out of `export budget csv C:/out.x` — the
 *  words left over are the widget title */
const pullXferArgs = (
  rest: string,
  fmts: string[],
): { title: string; path?: string; fmt?: string; sheet?: string } => {
  let path: string | undefined, fmt: string | undefined, sheet: string | undefined;
  const keep: string[] = [];
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    const sm = w.match(/^sheet=(.+)$/i);
    if (sm) {
      sheet = sm[1];
      continue;
    }
    if (/\.[a-z0-9]{2,5}$/i.test(w) || /^[a-z]:[\\/]/i.test(w) || w.includes("\\") || w.includes("/")) {
      path = w;
      continue;
    }
    if (fmts.includes(w.toLowerCase()) && !fmt) {
      fmt = w.toLowerCase();
      continue;
    }
    keep.push(w);
  }
  return { title: keep.join(" "), path, fmt, sheet };
};
/** the model sometimes stuffs a shell command into a notes/web fence —
 *  detect it and run it as a shell command instead of a search query */
const SHELLISH = /^\s*(get-|set-|new-|remove-|test-|select-|dir\b|ls\b|cat\b|find\b|where\b|type\b|echo\s)/i;

/** same slug shape the backend uses — stem, lowercase, non-alnum → dash */
const slugOf = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** doc index for target matching — the library roster the widget can aim at */
let docCache: Array<{ slug: string; name: string }> | null = null;
const docs = async () => {
  if (!docCache)
    docCache = await invoke<Array<{ slug: string; name: string }>>("rag_list").catch(() => []);
  return docCache;
};
/** match a token against the library — real slug or slugified name */
const matchDoc = async (tok: string) => {
  const t = tok.toLowerCase();
  return (await docs()).find((d) => d.slug === t || slugOf(d.name) === t) ?? null;
};
const LAIDO_RE = /^(research|ask|document|summary|related|recall|tasks|loop|skill|widget|canvas|agenda|graph)\b\s*(.*)$/i;
/** search queries that are really the model echoing its instructions, not a
 *  real lookup — running them loops the tool chain forever */
const BOGUS_QUERY = new Set([
  "continue", "the above", "output", "results", "done", "yes", "search", "query",
]);

/** live chat sessions — lets one chat deliver a message into another */
interface Session {
  card: HTMLElement;
  line: (cls: string, text: string) => HTMLElement;
  aiTurn: (text: string, auto?: boolean) => Promise<string>;
}
const sessions = new Map<HTMLElement, Session>();

const pruneSessions = () => {
  for (const [el] of sessions) if (!el.isConnected) sessions.delete(el);
};

/** wire one terminal widget card: the log, the input line, the confirm
 *  chips, the AI loop and the skill save. The session history rebuilds
 *  from the persisted log so a reloaded terminal remembers its thread. */
/** locate a sheet card by title — exact, then fuzzy, then the only sheet
 *  on the note when the model omits or garbles the title */
const findSheet = (name: string): HTMLElement | null => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"));
  if (!all.length) return null;
  const n = name.trim().toLowerCase();
  if (!n) return all.length === 1 ? all[0] : null;
  const hit =
    all.find((c) => (c.dataset.topic ?? "").toLowerCase() === n) ??
    all.find((c) => {
      const t = (c.dataset.topic ?? "").toLowerCase();
      return fuzzyHit(n, t);
    });
  if (hit) return hit;
  /* workbook tabs — a stashed sheet's name isn't on any card's topic; the
   * matching card activates that tab in place and gets returned */
  for (const c of all) {
    const tabs = sheetApi(c)?.tabs?.() ?? [];
    const nm = tabs.find((t) => t.toLowerCase() === n) ??
      tabs.find((t) => t.toLowerCase().includes(n) || n.includes(t.toLowerCase()));
    if (nm) {
      sheetApi(c)?.activateTab?.(nm);
      return c;
    }
  }
  /* no catch-all for a wrong title — "set revenue A1=x" must NOT write to
   * the lone "costs" sheet. Title-less forms (tool/apply/tooldel) carry
   * their own explicit single-sheet fallbacks. */
  return null;
};

/** strict existence — exact card topic or workbook tab name only. `new`
 * uses this so a same-titled sheet is detected without the fuzzy catch. */
const strictSheet = (name: string): HTMLElement | null => {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  for (const c of Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"))) {
    if ((c.dataset.topic ?? "").toLowerCase() === n) return c;
    if (sheetApi(c)?.tabs?.().some((t) => t.toLowerCase() === n)) return c;
  }
  return null;
};

/* fuzzy title match — "budget 2024" finds the "budget" card, partial
 * prefixes work, but a coincidental substring ("nodb" ⊃ "db") must not. */
const fuzzyHit = (n: string, t: string): boolean =>
  t === n ||
  n.startsWith(t) ||
  t.startsWith(n) ||
  n.includes(` ${t}`) ||
  t.includes(` ${n}`);

const refOf = (s: string): [number, number] | null => {
  const mm = s.trim().match(/^([A-Za-z]{1,3})(\d{1,4})$/);
  if (!mm) return null;
  let c = 0;
  for (const ch of mm[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(mm[2]) - 1, c - 1];
};


/** execute one ` ```sheet ` fence — the AI's read/write channel into the
 *  grids. Verbs: new · read · set · append · addrow · addcol · delrow ·
 *  delcol · clear · sort. Returns a result line that feeds back to it. */
const SHEET_VERBS = new Set([
  "new", "create", "read", "get", "set", "append", "addrow", "addcol", "delrow", "delcol",
  "clear", "sort", "format", "fmt", "dedupe", "freeze", "hide", "unhide", "cf", "filter",
  "view", "style", "autosum", "sum", "tools", "tool", "addtool", "tooldel", "rmtool",
  "apply", "applytool", "stamp", "export", "import", "save", "load",
]);
export const sheetTool = async (body: string, depth = 0): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty sheet command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  /* the model often packs several commands in one fence body
   * (tool spec on line 1, apply on line 2) — any later line that starts
   * with a verb is its own command; data rows (B2=5, |cells|, {json})
   * stay with the head verb */
  const extra: string[] = [];
  const rows: string[] = [];
  for (const l of lines.slice(1)) {
    const first = (l.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (depth === 0 && SHEET_VERBS.has(first)) extra.push(l.trim());
    else rows.push(l);
  }
  const runExtra = async (head: string): Promise<string> => {
    for (const l of extra) head += "\n" + (await sheetTool(l, 1));
    return head;
  };
  const single = async (): Promise<string> => {

  if (verb === "new" || verb === "create") {
    const dm = rest.match(/(\d{1,2})\s*[x×]\s*(\d{1,2})/i);
    const r = Math.min(50, Math.max(1, Number(dm?.[1] ?? 6)));
    const c = Math.min(26, Math.max(1, Number(dm?.[2] ?? 4)));
    const title = (dm ? rest.replace(dm[0], "") : rest).trim() || "sheet";
    // idempotent — a same-titled sheet already on the note means the model
    // wants THAT grid, not a duplicate card
    if (strictSheet(title)) return `sheet "${title}" is already on the note — set/append to fill it`;
    const card = spawnSheetCard(title, r, c);
    /* `new budget\n| h1 | h2 |\n| a | b |` — body rows seed the grid.
     * a row of pure ref=value pairs places by ref, else rows land
     * sequentially from A1 */
    const api0 = sheetApi(card);
    if (rows.length && api0?.setCells) {
      const cells: Array<[number, number, string]> = [];
      rows.forEach((l, ri) => {
        const segs = l
          .split(/\t|\|/)
          .map((s) => s.trim())
          .filter((s, i, arr) => !(s === "" && (i === 0 || i === arr.length - 1)));
        const allRefs =
          segs.length > 0 &&
          segs.every((s) => {
            const e = s.indexOf("=");
            return e > 0 && refOf(s.slice(0, e));
          });
        segs.forEach((s, ci) => {
          if (allRefs) {
            const e = s.indexOf("=");
            const ref = refOf(s.slice(0, e))!;
            cells.push([ref[0], ref[1], s.slice(e + 1).trim()]);
          } else cells.push([ri, ci, s]);
        });
      });
      if (cells.length) api0.setCells(cells);
    }
    return `created sheet "${title}" (${r}x${c})` +
      (rows.length ? ` — ${rows.length} row${rows.length === 1 ? "" : "s"} seeded` : "");
  }
  if (verb === "read" || verb === "get") {
    const api = findSheet(rest) ? sheetApi(findSheet(rest)!) : null;
    if (!api) return `✕ no sheet found named "${rest || "?"}"`;
    return `sheet "${api.title()}" ${api.rows()}x${api.cols()} (raw TSV):\n${api.read()}`;
  }
  // export budget | export budget csv | export budget C:/out/budget.xlsx
  if (verb === "export" || verb === "save") {
    const { title, path, fmt } = pullXferArgs(rest, ["xlsx", "csv", "tsv"]);
    let card = findSheet(title);
    if (!card && !title) card = document.querySelector<HTMLElement>(".sheet-card") ?? null;
    const api = card ? sheetApi(card) : null;
    if (!api?.exportFile) return `✕ no sheet found named "${title || "?"}"`;
    return api.exportFile(path ?? (fmt ? `exports/${api.title()}.${fmt}` : undefined));
  }
  // import budget C:/in.xlsx sheet=Sheet2 | import C:/in.csv
  if (verb === "import" || verb === "load") {
    const { title, path, sheet } = pullXferArgs(rest, ["xlsx", "csv", "tsv"]);
    let card = title ? findSheet(title) : null;
    if (!card) {
      const stem = path?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || title || "sheet";
      card = spawnSheetCard(title || stem, 6, 4);
    }
    const api = sheetApi(card);
    if (!api?.importFile) return "✕ sheet import unavailable";
    return api.importFile(path, sheet);
  }
  if (verb === "set") {
    // `set <title> A1=x B2=y` — pairs may ride inline after the title; the
    // title is the words before the first ref= token (later lines still work)
    const im = rest.match(/\b[A-Za-z]{1,3}\d{1,4}\s*=/);
    const inline = im
      ? rest.slice(im.index).split(/(?=\b[A-Za-z]{1,3}\d{1,4}\s*=)/)
      : [];
    const card = findSheet(im ? rest.slice(0, im.index).trim() : rest);
    const api = card ? sheetApi(card) : null;
    if (!api) return `✕ no sheet found named "${rest || "?"}"`;
    let wrote = 0;
    const bad: string[] = [];
    const cells: Array<[number, number, string]> = [];
    for (const l of [...inline, ...rows]) {
      // a row may pack several cells — "A1=x | B1=y" or tab-separated
      for (const seg of l.split(/\t|\|/)) {
        const eq = seg.indexOf("=");
        if (eq < 1) {
          bad.push(seg.slice(0, 24));
          continue;
        }
        const ref = refOf(seg.slice(0, eq));
        if (!ref) {
          bad.push(seg.slice(0, 24));
          continue;
        }
        cells.push([ref[0], ref[1], seg.slice(eq + 1).trim()]);
        wrote++;
      }
    }
    api.setCells(cells);
    return `wrote ${wrote} cell${wrote === 1 ? "" : "s"} to "${api.title()}"` +
      (bad.length ? ` — skipped malformed: ${bad.join(", ")}` : "");
  }
  if (verb === "append") {
    const card = findSheet(rest);
    const api = card ? sheetApi(card) : null;
    if (!api) return `✕ no sheet found named "${rest || "?"}"`;
    if (!rows.length) return "✕ append needs rows (one per line, cells split by | or tab)";
    // the model sometimes writes append rows as ref=value pairs
    // ("A10=depth (m) | B10=B3") — a row that is ALL ref=value pairs lands
    // as cell writes, not as literal "A10=…" text inside a cell
    const refPair = (seg: string) => {
      const eq = seg.indexOf("=");
      return eq > 0 ? refOf(seg.slice(0, eq)) : null;
    };
    let placed = 0;
    const placedCells: Array<[number, number, string]> = [];
    for (const l of rows) {
      const segs = l.split(/\t|\|/).map((s) => s.trim());
      if (segs.length && segs.every((s) => refPair(s))) {
        for (const s of segs) {
          const eq = s.indexOf("=");
          const ref = refOf(s.slice(0, eq))!;
          placedCells.push([ref[0], ref[1], s.slice(eq + 1).trim()]);
          placed++;
        }
      } else {
        api.addRow(segs);
      }
    }
    if (placed) api.setCells(placedCells);
    return `appended ${rows.length} row${rows.length === 1 ? "" : "s"} to "${api.title()}"`;
  }
  if (verb === "addrow" || verb === "addcol") {
    const card = findSheet(rest);
    const api = card ? sheetApi(card) : null;
    if (!api) return `✕ no sheet found named "${rest || "?"}"`;
    if (verb === "addrow") api.addRow();
    else api.addCol();
    return `${verb === "addrow" ? "row" : "column"} added to "${api.title()}"`;
  }
  if (verb === "delrow" || verb === "delcol" || verb === "sort" || verb === "clear") {
    // these carry their target at the END of the line — "delrow budget 3",
    // "delcol budget B", "sort budget B desc", "clear budget [A1:B2]"
    const tm = rest.match(/^(.*?)\s+(\S+)$/);
    let title = rest;
    let arg = "";
    if (verb === "clear") {
      const rm = rest.match(/^(.*?)\s*([A-Za-z]{1,3}\d{1,4}(?::[A-Za-z]{1,3}\d{1,4})?)$/);
      if (rm) {
        title = rm[1];
        arg = rm[2];
      }
    } else if (verb === "sort") {
      const sm = rest.match(/^(.*?)\s+([A-Za-z]{1,3})\s*(desc|asc)?$/i);
      if (sm) {
        title = sm[1];
        arg = sm[2] + (sm[3] ? ` ${sm[3]}` : "");
      }
    } else if (tm) {
      title = tm[1];
      arg = tm[2];
    }
    const card = findSheet(title);
    const api = card ? sheetApi(card) : null;
    if (!api) return `✕ no sheet found named "${title || "?"}"`;
    if (verb === "delrow") {
      const n = Number(arg);
      if (!n || n < 1 || n > api.rows()) return `✕ row ${arg} out of range (1..${api.rows()})`;
      api.delRow(n - 1);
      return `deleted row ${n} from "${api.title()}"`;
    }
    if (verb === "delcol") {
      const mm = arg.match(/^[A-Za-z]{1,3}$/);
      if (!mm) return `✕ column "${arg}" isn't a letter`;
      let c = 0;
      for (const ch of arg.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
      if (c > api.cols()) return `✕ column ${arg} out of range (A..${cellName(0, api.cols() - 1).replace(/\d/, "")})`;
      api.delCol(c - 1);
      return `deleted column ${arg.toUpperCase()} from "${api.title()}"`;
    }
    if (verb === "clear") {
      if (!arg) {
        api.clear();
        return `cleared all of "${api.title()}"`;
      }
      const [a, b] = arg.split(":");
      const ra = refOf(a);
      const rb = refOf(b ?? a);
      if (!ra || !rb) return `✕ bad range "${arg}"`;
      api.clear(ra, rb);
      return `cleared ${arg.toUpperCase()} of "${api.title()}"`;
    }
    // sort — needs a column letter; the api doesn't expose sort (it's a
    // user-gesture op) so reorder via read+set
    const sm = arg.match(/^([A-Za-z]{1,3})\s*(desc|asc)?$/i);
    if (!sm) return `✕ sort needs a column letter — "sort ${api.title()} B"`;
    let c = 0;
    for (const ch of sm[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    const desc = /^desc$/i.test(sm[2] ?? "");
    const grid = api.read().split("\n").map((l) => l.split("\t"));
    const key = (row: string[]) => {
      const v = row[c - 1] ?? "";
      const n = Number(v.replace(/[$,\s]/g, ""));
      return { num: isNaN(n) ? null : n, s: v.toLowerCase() };
    };
    grid.sort((x, y) => {
      const ka = key(x);
      const kb = key(y);
      const cmp =
        ka.num !== null && kb.num !== null
          ? ka.num - kb.num
          : ka.num !== null
            ? -1
            : kb.num !== null
              ? 1
              : ka.s.localeCompare(kb.s);
      return desc ? -cmp : cmp;
    });
    api.setAll(grid);
    return `sorted "${api.title()}" by column ${sm[1].toUpperCase()} ${desc ? "descending" : "ascending"}`;
  }
  if (verb === "format" || verb === "fmt") {
    // "format budget B1:B9 cur" / "format budget B pct" — number formats.
    // the model often says "format … b" meaning BOLD — a spec that isn't a
    // number-format name but parses as a style spec routes to the font layer
    const fm = rest.match(/^(.*?)\s+([A-Za-z]{1,3}\d{0,4}(?::[A-Za-z]{1,3}\d{0,4})?)\s+(\S+)$/);
    if (!fm) return `✕ format needs <title> <range> <fmt> — e.g. "format budget B1:B9 cur"`;
    if (isStyleSpec(fm[3])) {
      const card = findSheet(fm[1]);
      const api = card ? sheetApi(card) : null;
      if (!api?.setStyle) return `✕ no sheet found named "${fm[1]}"`;
      const cells = expandRange(fm[2]);
      if (!cells.length) return `✕ bad range "${fm[2]}"`;
      api.setStyle(cells, fm[3]);
      return `styled ${cells.length} cells on "${api.title()}" → ${fm[3]}`;
    }
    const card = findSheet(fm[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.setFmt) return `✕ no sheet found named "${fm[1]}"`;
    const cells: Array<[number, number]> = [];
    const spec = fm[2];
    const parts = spec.split(":");
    const ra = refOf(parts[0]);
    const rb = parts[1] ? refOf(parts[1]) : ra;
    // a bare column letter means the whole column
    const colOnly = spec.match(/^([A-Za-z]{1,3})$/);
    if (colOnly) {
      let c = 0;
      for (const ch of colOnly[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
      for (let r = 0; r < api.rows(); r++) cells.push([r, c - 1]);
    } else if (ra && rb) {
      for (let r = Math.min(ra[0], rb[0]); r <= Math.max(ra[0], rb[0]); r++)
        for (let c = Math.min(ra[1], rb[1]); c <= Math.max(ra[1], rb[1]); c++) cells.push([r, c]);
    } else return `✕ bad range "${spec}"`;
    api.setFmt(cells, fm[3]);
    return `formatted ${cells.length} cells in "${api.title()}" as ${fm[3]}`;
  }
  if (verb === "dedupe") {
    const tm = rest.match(/^(.*?)\s+([A-Za-z]{1,3})$/);
    if (!tm) return `✕ dedupe needs <title> <col> — "dedupe budget B"`;
    const card = findSheet(tm[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.dedupe) return `✕ no sheet found named "${tm[1]}"`;
    let c = 0;
    for (const ch of tm[2].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    const n = api.dedupe(c - 1);
    return `removed ${n} duplicate row${n === 1 ? "" : "s"} from "${api.title()}" by column ${tm[2].toUpperCase()}`;
  }
  if (verb === "freeze") {
    // "freeze budget r1" / "freeze budget cA" / "freeze budget rc" / "freeze budget off"
    const tm = rest.match(/^(.*?)\s*(\boff\b|rc|r1|c[A-Za-z])?$/i);
    const card = findSheet(tm?.[1] ?? rest);
    const api = card ? sheetApi(card) : null;
    if (!api?.freeze) return `✕ no sheet found named "${rest}"`;
    const mode = (tm?.[2] ?? "").toLowerCase();
    const r = mode === "r1" || mode === "rc";
    const c = mode === "ca" || mode === "rc" || /^c[a-z]$/i.test(mode);
    api.freeze(r, c);
    return r || c ? `froze ${r ? "row 1" : ""}${r && c ? " + " : ""}${c ? "column A" : ""} of "${api.title()}"` : `unfroze "${api.title()}"`;
  }
  if (verb === "hide" || verb === "unhide") {
    if (verb === "unhide") {
      const card = findSheet(rest);
      const api = card ? sheetApi(card) : null;
      if (!api?.unhide) return `✕ no sheet found named "${rest}"`;
      api.unhide();
      return `unhid all of "${api.title()}"`;
    }
    // "hide budget r3" / "hide budget cB" / "hide budget 3" / "hide budget B"
    const tm = rest.match(/^(.*?)\s+([rc]?[A-Za-z0-9]+)$/i);
    if (!tm) return `✕ hide needs <title> <r3|cB>`;
    const card = findSheet(tm[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.hideRow) return `✕ no sheet found named "${tm[1]}"`;
    const m2 = tm[2].match(/^([rc]?)([A-Za-z]*)([0-9]*)$/i);
    if (m2?.[1]?.toLowerCase() === "r" || (!m2?.[2] && m2?.[3])) {
      api.hideRow(Number(m2![3] || m2![2]) - 1);
      return `hid row ${m2![3] || m2![2]} of "${api.title()}"`;
    }
    const L = (m2?.[2] || "").toUpperCase();
    let c = 0;
    for (const ch of L) c = c * 26 + (ch.charCodeAt(0) - 64);
    api.hideCol!(c - 1);
    return `hid column ${L} of "${api.title()}"`;
  }
  if (verb === "cf") {
    // "cf budget B > 100 #ffe08a" / "cf budget B dup #ffc9c9" / "cf budget B clear"
    const cm = rest.match(/^(.*?)\s+([A-Za-z]{1,3})\s+([!=<>]{1,2}|between|contains|top|dup|clear)\s*(\S*)\s*(#\w{3,8}|\w+)?$/i);
    if (!cm) return `✕ cf needs <title> <col> <op> <val> <color> — "cf budget B > 100 #ffe08a"`;
    const card = findSheet(cm[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.addCf) return `✕ no sheet found named "${cm[1]}"`;
    let c = 0;
    for (const ch of cm[2].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    if (cm[3].toLowerCase() === "clear") {
      api.clearCf!(c - 1);
      return `cleared conditional rules on ${api.title()} col ${cm[2].toUpperCase()}`;
    }
    const color = (cm[5] ?? "#ffe08a").startsWith("#") ? cm[5]! : "#ffe08a";
    api.addCf(c - 1, cm[3].toLowerCase(), cm[4] ?? "", color);
    return `highlight rule on "${api.title()}" col ${cm[2].toUpperCase()}: ${cm[3]}${cm[4] ?? ""} → ${color}`;
  }
  if (verb === "filter") {
    // "filter budget B apple|pear" / "filter budget B off" / "filter budget"
    const card0 = findSheet(rest);
    if (card0 && sheetApi(card0)?.filterState) {
      // bare "filter <title>" reports the current state
      return `filters on "${sheetApi(card0)!.title()}" — ${sheetApi(card0)!.filterState!()}`;
    }
    const fm = rest.match(/^(.*?)\s+([A-Za-z]{1,3})\s+(.+)$/);
    if (!fm) return `✕ filter needs <title> <col> <v1|v2|off>`;
    const card = findSheet(fm[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.filter) return `✕ no sheet found named "${fm[1]}"`;
    let c = 0;
    for (const ch of fm[2].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    if (/^off|clear|all$/i.test(fm[3].trim())) {
      api.filter(c - 1, null);
      return `cleared the filter on "${api.title()}" col ${fm[2].toUpperCase()}`;
    }
    api.filter(c - 1, fm[3].split("|").map((s) => s.trim()));
    return `filtered "${api.title()}" col ${fm[2].toUpperCase()} to: ${fm[3]}`;
  }
  if (verb === "view") {
    // "view budget kanban C" | "view budget grid" | "view budget" (report)
    const vm = rest.match(/^(.*?)\s+(kanban\s+[A-Za-z]{1,3}|calendar\s+[A-Za-z]{1,3}|grid)$/i);
    if (vm) {
      const card = findSheet(vm[1]);
      const api = card ? sheetApi(card) : null;
      if (!api?.view) return `✕ no sheet found named "${vm[1]}"`;
      const v = api.view(vm[2].replace(/\s+/g, " "));
      return `view on "${api.title()}" → ${v}`;
    }
    const card = findSheet(rest);
    if (card && sheetApi(card)?.view)
      return `"${sheetApi(card)!.title()}" view: ${sheetApi(card)!.view!()}`;
    return `✕ view needs <title> kanban <col>|grid`;
  }
  if (verb === "style") {
    // "style budget B2:D9 b,i,f:#ffe08a" / "style budget A1:C1 a:c" — the
    // Excel font layer: b/i/u/s flags, f:fill, k:ink, a:align
    const m = rest.match(/^(.*?)\s+([A-Za-z]{1,3}\d+(?::[A-Za-z]{1,3}\d+)?)\s+(\S+)\s*$/i);
    if (!m) return `✕ style needs <title> <range> <spec> — "style budget B2:D9 b,i,f:#ffe08a"`;
    const card = findSheet(m[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.setStyle) return `✕ no sheet found named "${m[1]}"`;
    const cells = expandRange(m[2]);
    if (!cells.length) return `✕ bad range "${m[2]}"`;
    api.setStyle(cells, m[3]);
    return `styled ${cells.length} cells on "${api.title()}" → ${m[3]}`;
  }
  if (verb === "autosum" || verb === "sum") {
    // "autosum budget B10" — Σ into that cell (detects the range above)
    const m = rest.match(/^(.*?)\s+([A-Za-z]{1,3}\d+)\s*$/);
    if (!m) return `✕ autosum needs <title> <cell> — "autosum budget B10"`;
    const card = findSheet(m[1]);
    const api = card ? sheetApi(card) : null;
    if (!api?.autoSum) return `✕ no sheet found named "${m[1]}"`;
    const rc = refRC(m[2]);
    api.autoSum(rc?.[0] ?? 0, rc?.[1] ?? 0);
    return `autosummed ${m[2].toUpperCase()} on "${api.title()}"`;
  }
  if (verb === "tools") {
    const card = findSheet(rest);
    const api = card ? sheetApi(card) : null;
    if (!api?.listTools) return `✕ no sheet found named "${rest}"`;
    const tl = api.listTools();
    return tl.length
      ? `tools in "${api.title()}":\n` + tl.map((t) => `· ${t.icon} ${t.name} — ${t.steps.length} step${t.steps.length === 1 ? "" : "s"}`).join("\n")
      : `no custom tools in "${api.title()}" — make one with the 'tool' verb`;
  }
  if (verb === "tool" || verb === "addtool") {
    // `tool <title> {"name":"x","icon":"Σ","steps":[{…}]}` — spec on the
    // head line or following rows. The model often writes `tool markit {…}`
    // (tool name where the title belongs) — when exactly one sheet is on
    // the note, that guess is unambiguous; use it.
    const hm2 = rest.match(/^(.*?)\s+(\{[\s\S]*)$/);
    const spec = hm2 ? hm2[2] : rest.includes("{") ? rest : rows.join("\n");
    const title = hm2 ? hm2[1] : rows.length ? "" : rest;
    let card = findSheet(title.trim());
    if (!card) {
      const sheets = Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"));
      if (sheets.length === 1) card = sheets[0];
    }
    const api = card ? sheetApi(card) : null;
    if (!api?.addTool) return `✕ tool <title> {json} — sheet "${title.trim() || "?"}" not found`;
    return api.addTool(spec);
  }
  if (verb === "tooldel" || verb === "rmtool") {
    // both title and tool name may have spaces — try each split; the one
    // whose suffix names a real tool in a real sheet wins
    const words = rest.split(/\s+/).filter(Boolean);
    for (let k = words.length - 1; k >= 1; k--) {
      const card = findSheet(words.slice(0, k).join(" "));
      const api = card ? sheetApi(card) : null;
      if (!api?.listTools) continue;
      const name = words.slice(k).join(" ");
      if (api.listTools().some((t) => t.name === name))
        return api.delTool!(name) ? `removed tool "${name}"` : `✕ no tool named "${name}"`;
    }
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"));
    for (const c of sheets) {
      const api = sheetApi(c);
      if (api?.listTools?.().some((t) => t.name === rest))
        return api.delTool!(rest) ? `removed tool "${rest}"` : `✕ no tool named "${rest}"`;
    }
    return `✕ tooldel <title> <tool name>`;
  }
  if (verb === "apply" || verb === "applytool" || verb === "stamp") {
    // "apply budget running total [A2:F9]" — run a saved tool on a range
    // (or the current selection when the range is omitted)
    const words = rest.split(/\s+/).filter(Boolean);
    const rm = rest.match(/\s+([A-Za-z]{1,3}\d+(?::[A-Za-z]{1,3}\d+)?)\s*$/);
    let bounds: [[number, number], [number, number]] | undefined;
    let wordsEnd = words.length;
    if (rm) {
      const mm = rm[1].match(/^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/);
      if (mm) {
        const colOf = (L: string) => { let c = 0; for (const ch of L.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; };
        // single cell or range — normalize so B4:B2 still stamps B2:B4
        const a: [number, number] = [Number(mm[2]) - 1, colOf(mm[1])];
        const b: [number, number] = mm[3] ? [Number(mm[4]) - 1, colOf(mm[3])] : a;
        bounds = [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
        wordsEnd = rest.slice(0, rm.index).trim().split(/\s+/).filter(Boolean).length;
      }
    }
    const head = words.slice(0, wordsEnd);
    for (let k = head.length - 1; k >= 1; k--) {
      const card = findSheet(head.slice(0, k).join(" "));
      const api = card ? sheetApi(card) : null;
      if (!api?.listTools) continue;
      const name = head.slice(k).join(" ");
      if (api.listTools().some((t) => t.name === name))
        return api.applyTool!(name, ...(bounds ?? [])) as string;
    }
    // title omitted or misplaced — `apply markit A1:C1`, `apply markit
    // budget A1:C1` — on a one-sheet note any prefix or suffix of the head
    // that names a real tool is unambiguous
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"));
    if (sheets.length === 1) {
      const api = sheetApi(sheets[0]);
      const tools = api?.listTools?.() ?? [];
      for (let k = 0; k < head.length; k++) {
        for (const name of [head.slice(k).join(" "), head.slice(0, k + 1).join(" ")]) {
          if (tools.some((t) => t.name === name))
            return api!.applyTool!(name, ...(bounds ?? [])) as string;
        }
      }
    }
    return `✕ apply <title> <tool name> [A1:B9]`;
  }
  return `✕ unknown sheet verb "${verb}" — new · read · set · append · addrow · addcol · delrow · delcol · clear · sort · format · dedupe · freeze · hide · unhide · cf · filter · view · style · autosum · tool · tools · tooldel · apply`;
  };
  return runExtra(await single());
};

/** ```map``` fence — outlines that draw as trees; rows are indented
 *  `- ` bullets (2 spaces = one level deeper) */
const mapTool = async (body: string): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty map command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  const splitMap = (): [HTMLElement | null, string] =>
    probeTitle(".map-card", rest.split(/\s+/).filter(Boolean));
  if (verb === "new" || verb === "create") {
    const card = spawnMapCard(rest || "map");
    const made = mapApi(card)!.add(lines.slice(1));
    return `map "${card.dataset.topic}" — ${made} nodes`;
  }
  if (verb === "add") {
    const [card, tail] = splitMap();
    if (!card) return `✕ no map found — create one: map new <title>`;
    const rows = [...(tail ? [tail] : []), ...lines.slice(1)];
    const made = mapApi(card)!.add(rows);
    return `+${made} nodes → "${card.dataset.topic}"`;
  }
  if (verb === "list" || verb === "read") {
    const [card] = splitMap();
    return card ? mapApi(card)!.list() : `✕ no map found named "${rest}"`;
  }
  if (verb === "del" || verb === "delete") {
    const [card, tail] = splitMap();
    return card && tail && mapApi(card)!.del(tail)
      ? `removed "${tail}" from "${card.dataset.topic}"`
      : `✕ del needs a map + a node prefix`;
  }
  if (verb === "rename") {
    const m2 = rest.match(/\s→\s|\s->\s/);
    const arrow = m2 ? m2[0] : null;
    if (!arrow) return `✕ rename needs <map> <prefix> -> <new text>`;
    const idx = rest.indexOf(arrow);
    const left = rest.slice(0, idx).trim();
    const right = rest.slice(idx + arrow.length).trim();
    const w = left.split(/\s+/).filter(Boolean);
    const [card, prefix] = probeTitle(".map-card", w);
    if (card && prefix && mapApi(card)!.rename(prefix, right))
      return `renamed → "${right}" in "${card.dataset.topic}"`;
    return `✕ rename needs a map + prefix + -> + new text`;
  }
  return `✕ unknown map verb "${verb}" — new/add/del/rename/list`;
};

/** k=v field scanner for base specs — a value ends at the NEXT k=
 *  boundary (or `|`/EOL), so `q=a view=b` parses both fields */
const kvSpec = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const hits = [...text.matchAll(/(?:^|[\s|])(q|cols|sort|group|view|in)\s*[:=]\s*/gi)];
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].index! + hits[i][0].length;
    const to = hits[i + 1]?.index ?? text.length;
    const v = text.slice(from, to).split("|")[0].trim();
    out[hits[i][1].toLowerCase()] = v; // explicit `q=` clears the field
  }
  return out;
};

/** ```base``` fence — property-query views over the vault. The whole
 *  widget is its query + view, so the verbs are just that.
 *    new <title> [q=…]        — a base card; optional filter right away
 *    set <title> k=v …        — q / cols / sort / group / view / in fields
 *    read|list [title]        — the current result rows as text */
const baseTool = async (body: string): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty base command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  const findBase = (name: string): HTMLElement | null => {
    const all = Array.from(document.querySelectorAll<HTMLElement>(".base-card"));
    if (!all.length) return null;
    const n = name.trim().toLowerCase();
    if (!n) return all.length === 1 ? all[0] : null;
    // wrong names must error, not silently land on the only base card
    return (
      all.find((c) => (c.dataset.title ?? "").toLowerCase() === n) ??
      all.find((c) => {
        const t = (c.dataset.title ?? "").toLowerCase();
        return fuzzyHit(n, t);
      }) ??
      null
    );
  };
  if (verb === "new" || verb === "create") {
    // `new <title> [q=…] [view=…]` — the title ends at the first k=v field
    const tm = rest.match(/^(.*?)\s+((?:q|cols|sort|group|view|in)\s*[:=].*)$/i);
    const card = spawnBaseCard((tm ? tm[1] : rest) || "base");
    const patch = kvSpec([tm?.[2] ?? "", ...lines.slice(1)].join("\n"));
    if (Object.keys(patch).length) baseApi(card)?.set(patch);
    return `created base "${card.dataset.title}"${patch.q ? ` — q="${patch.q}"` : ""}`;
  }
  if (verb === "set" || verb === "filter" || verb === "view") {
    // `set <title> q=status:done view=board` — title words end at first k=
    const m = rest.match(/^(.*?)\s+((?:q|cols|sort|group|view|in)\s*[:=].*)$/i);
    // `view <title> table` — the bare-word form maps to view=<word>
    const vw = !m && verb === "view" ? rest.match(/^(.*?)\s+(\w+)$/) : null;
    const [card, spec] = m ? [findBase(m[1]), m[2]]
      : vw ? [findBase(vw[1]), `view=${vw[2]}`]
      : [findBase(rest), ""];
    if (!card) return `✕ no base found named "${rest || "?"}"`;
    const patch = kvSpec([spec, ...lines.slice(1)].join("\n"));
    if (!Object.keys(patch).length)
      return `✕ set needs fields — q= · cols= · sort= · group= · view=table|board|list|calendar · in=folder`;
    baseApi(card)?.set(patch);
    return `base "${card.dataset.title}" → ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(" ")}`;
  }
  if (verb === "read" || verb === "list" || verb === "rows") {
    const card = findBase(rest);
    if (!card) return `✕ no base found named "${rest || "?"}"`;
    const api = baseApi(card);
    const out = api?.read() ?? "";
    return out || `base "${card.dataset.title}" — no rows yet (query: ${api?.query() || "none"})`;
  }
  return `✕ unknown base verb "${verb}" — new · set · read`;
};

/** ```cards``` fence — build decks, quiz sessions, rate cards.
 *  Convention: the deck title is a fuzzy PREFIX of the arg words —
 *  `add verbs tener :: to have` finds deck "verbs". */
const cardsTool = async (body: string): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty cards command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();

  // split `rest` into [deck, leftover] — title is a word-prefix of the args
  const splitDeck = (): [HTMLElement | null, string] =>
    probeTitle(".cards-card", rest.split(/\s+/).filter(Boolean));

  // new <title> + body rows "front :: back"
  if (verb === "new" || verb === "create") {
    const card = spawnCardsCard(rest || "cards");
    const api = cardsApi(card)!;
    let made = 0;
    for (const l of lines.slice(1)) {
      const i = l.indexOf("::");
      if (i >= 0) {
        api.add(l.slice(0, i).trim(), l.slice(i + 2).trim());
        made++;
      }
    }
    return `deck "${card.dataset.topic}" — ${made} cards`;
  }

  // add <title> [front :: back] — extra "front :: back" rows also land
  if (verb === "add") {
    const [card, tail] = splitDeck();
    if (!card) return `✕ no cards deck found — create one: cards new <title>`;
    const api = cardsApi(card)!;
    const rows = [...(tail.includes("::") ? [tail] : []), ...lines.slice(1)];
    let made = 0;
    for (const l of rows) {
      const i = l.indexOf("::");
      if (i >= 0) {
        api.add(l.slice(0, i).trim(), l.slice(i + 2).trim());
        made++;
      }
    }
    return made ? `+${made} cards → "${card.dataset.topic}"` : "✕ no `front :: back` rows given";
  }

  if (verb === "list" || verb === "read") {
    const [card] = splitDeck();
    return card ? cardsApi(card)!.list() : `✕ no cards deck found named "${rest}"`;
  }
  if (verb === "due" || verb === "review") {
    const [card] = splitDeck();
    return card ? cardsApi(card)!.due() : `✕ no cards deck found named "${rest}"`;
  }
  if (verb === "del" || verb === "delete") {
    const [card, tail] = splitDeck();
    return card && tail ? cardsApi(card)!.del(tail) : "✕ del needs a deck and a front prefix";
  }
  if (verb === "rate" || verb === "grade") {
    const g = rest.match(/\s(again|hard|good|easy|[0-3])\s*$/i);
    if (!g) return "✕ rate needs a trailing grade: again|hard|good|easy";
    const grade = { again: 0, hard: 1, good: 2, easy: 3 }[g[1].toLowerCase()];
    const noGrade = rest.slice(0, g.index).trim();
    const w = noGrade.split(/\s+/).filter(Boolean);
    const [card, front] = probeTitle(".cards-card", w);
    if (card && front)
      return cardsApi(card)!.rate(front, (grade ?? Number(g[1])) as 0 | 1 | 2 | 3);
    return "✕ rate needs a deck + front prefix + grade";
  }
  return `✕ unknown cards verb "${verb}" — new/add/del/list/due/rate`;
};

/** ```browser``` fence — open/read/navigate web pages on the note */
const browserTool = async (body: string): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty browser command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();

  // open <url-or-search> [title] — spawn a card and navigate it
  if (verb === "open" || verb === "new") {
    if (!rest) return "✕ open needs a url or search phrase";
    const words = rest.split(/\s+/);
    const urlish = words[0];
    const title = words.slice(1).join(" ");
    const stem = urlish.match(/^https?:\/\/([^/?#]+)/)?.[1] ?? urlish;
    const card = spawnBrowserCard(title || stem, "");
    const api = browserApi(card);
    const out = api ? await api.navigate(urlish) : "card created";
    return `opened "${card.dataset.topic}" — ${out}`;
  }

  // verbs that can take either a card title or a bare url
  // read <title|url> — the page's extracted text (the AI's eyes)
  if (verb === "read" || verb === "get") {
    if (!rest) return "✕ read needs a url or a browser card title";
    const card = findBrowser(rest);
    if (card) {
      const api = browserApi(card)!;
      let text = await api.readLive();
      if (!text) text = api.read();
      if (!text) {
        // card exists but hasn't fetched yet — navigate+read it now
        const u = api.url();
        if (!u) return `✕ browser "${api.title()}" has no page`;
        await api.navigate(u);
      }
      const txt = (await api.readLive()) || api.read();
      return txt
        ? `browser "${api.title()}" (${api.url()}) — page text:\n${txt.slice(0, 12000)}`
        : `✕ no page text on "${api.title()}"`;
    }
    // bare url — fetch straight to context, no card needed
    if (!/^(https?:\/\/|[\w-]+\.[\w-]+)/i.test(rest)) {
      return `✕ no browser card found named "${rest}"`;
    }
    try {
      const p = await invoke<{ title: string; final_url: string; text: string }>("page_fetch", {
        url: rest,
      });
      return `${p.title || p.final_url} — page text:\n${p.text.slice(0, 12000)}`;
    } catch (e) {
      return `✕ fetch failed: ${String(e)}`;
    }
  }

  if (verb === "navigate" || verb === "go" || verb === "goto") {
    // navigate <title> <url> — url is the last token
    const sp = rest.split(/\s+/);
    const url = sp.pop() ?? "";
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    return `→ ${await browserApi(card)!.navigate(url)}`;
  }
  if (verb === "back" || verb === "forward" || verb === "fwd") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    const api = browserApi(card)!;
    return verb === "back" ? api.back() : api.forward();
  }

  // clip <title> [sel|today] — capture page text into the note (or the
  // daily note for `today`; `sel` clips the reader selection only)
  if (verb === "clip") {
    const words = rest.split(/\s+/).filter(Boolean);
    const flag = words.length > 1 ? words.pop()! : "";
    const sel = flag === "sel" || flag === "selection";
    const today = flag === "today" || flag === "daily";
    const name = flag ? words.join(" ") : rest;
    const card = findBrowser(name);
    if (!card) return `✕ no browser found named "${name || "?"}"`;
    const c = browserApi(card)!.clip(sel);
    if (!c) return `✕ nothing to clip${sel ? " — select text in the reader first" : ""}`;
    if (today) return await clipToDaily(c.title, c.url, c.text);
    insertClip(c.title, c.url, c.text);
    return `clipped ${c.text.length} chars from "${c.title}" → note`;
  }

  // bookmark <title> — save the card's page to bookmarks.laido
  if (verb === "bookmark" || verb === "bm") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    return await browserApi(card)!.bookmark();
  }

  // links <title> — the page's extracted links; the agent's navigation map
  if (verb === "links") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    const api = browserApi(card)!;
    const links = api.links();
    if (!links.length)
      return `✕ no links on "${api.title()}" — load a page first`;
    return `links on "${api.title()}" (${api.url()}):\n` +
      links.slice(0, 40).map(([t, u]) => `${t} → ${u}`).join("\n");
  }

  // eval <title> <js> — run js inside the live page; JSON result back.
  // the AI's hands: form fills, button clicks, dom reads beyond text.
  if (verb === "eval" || verb === "js") {
    const sp = rest.split(/\s+/);
    let card = findBrowser(rest);
    let js = rest;
    if (!card) {
      for (let i = sp.length - 1; i > 0; i--) {
        card = findBrowser(sp.slice(0, i).join(" "));
        if (card) { js = sp.slice(i).join(" "); break; }
      }
    } else {
      // title matched the whole rest only if there's no js after it
      const t = (card.dataset.topic ?? "").toLowerCase();
      const i = rest.toLowerCase().indexOf(t);
      js = i >= 0 ? rest.slice(i + t.length).trim() : rest;
    }
    if (!card) return `✕ no browser found named "${rest.split(/\s+/)[0] || "?"}"`;
    if (!js) return "✕ eval needs javascript — eval <title> <js>";
    try {
      const out = await browserApi(card)!.eval(js);
      const s = typeof out === "string" ? out : JSON.stringify(out);
      return `eval on "${card.dataset.topic}" → ${s.slice(0, 4000)}`;
    } catch (e) {
      return `✕ eval failed: ${String(e)}`;
    }
  }

  /* ---------- the AI's web data-gathering lane ----------
   * the real engine means every site renders — these verbs turn live DOM
   * into formatted data the model can reason about or push into widgets */

  // search <query> — clean title→url hits; the discovery lane
  if (verb === "search" || verb === "find") {
    if (!rest) return "✕ search needs a query";
    const p = await invoke<{ links: [string, string][] }>("page_fetch", {
      url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(rest)}`,
    }).catch((e) => ({ links: [] as [string, string][], err: String(e) }));
    // ddg wraps every hit as /l/?uddg=<encoded-target> — unwrap to the
    // real destination so the agent gets urls it can open directly
    const hits = (p.links ?? [])
      .map(([t, u]) => {
        const m = u.match(/[?&]uddg=([^&]+)/);
        return [t, m ? decodeURIComponent(m[1]) : u] as [string, string];
      })
      .filter(([, u]) => u.startsWith("http"));
    return hits.length
      ? `search "${rest}" — ${hits.length} hits:\n` +
          hits.slice(0, 15).map(([t, u]) => `${t} → ${u}`).join("\n")
      : `✕ no results for "${rest}"`;
  }

  // extract <title> — the page as a structured digest: meta, json-ld,
  // headings, forms, tables count, and the readable text — one shot
  if (verb === "extract" || verb === "data" || verb === "digest") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    const api = browserApi(card)!;
    const d = (await api.eval(`(()=>{
      const q=(s,a)=>document.querySelector(s)?.${""}[a]??"";
      const heads=[...document.querySelectorAll("h1,h2,h3")].slice(0,24)
        .map(h=>"H"+h.tagName[1]+" "+h.innerText.trim()).filter(h=>h.length>4);
      const forms=[...document.querySelectorAll("form")].slice(0,6).map(f=>({
        action:f.action||"",inputs:[...f.elements].map(e=>e.name||e.id||e.type).filter(Boolean).slice(0,8)}));
      const jsonld=[...document.querySelectorAll('script[type="application/ld+json"]')]
        .map(s=>s.textContent?.trim()??"").filter(Boolean).slice(0,3);
      return {
        title:document.title, url:location.href,
        desc:q('meta[name="description"]',"content")||q('meta[property="og:description"]',"content"),
        site:q('meta[property="og:site_name"]',"content")||q('meta[name="application-name"]',"content"),
        heads, tables:document.querySelectorAll("table").length,
        forms, jsonld,
        text:(document.body?document.body.innerText:"").slice(0,5000),
      }})()`)) as {
      title: string; url: string; desc: string; site: string;
      heads: string[]; tables: number; forms: { action: string; inputs: string[] }[];
      jsonld: string[]; text: string;
    } | null;
    if (!d) return `✕ extract failed — is the page live?`;
    let out = `— extract: ${d.title} (${d.url})\n`;
    if (d.site) out += `site: ${d.site}\n`;
    if (d.desc) out += `desc: ${d.desc}\n`;
    if (d.heads.length) out += `headings:\n  ${d.heads.join("\n  ")}\n`;
    out += `tables: ${d.tables}${d.forms.length ? ` · forms: ${d.forms.map((f) => `[${f.inputs.join(",")}]→${f.action}`).join(" ")}` : ""}\n`;
    for (const j of d.jsonld) out += `json-ld: ${j.slice(0, 800)}\n`;
    out += `text:\n${d.text}`;
    return out.slice(0, 10000);
  }

  // tables <title> [n] — <table>s as pipe rows (drop-in for sheet append)
  if (verb === "tables" || verb === "table") {
    const sp = rest.split(/\s+/);
    const lastN = /^\d+$/.test(sp[sp.length - 1] ?? "") ? parseInt(sp.pop()!, 10) : -1;
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    const api = browserApi(card)!;
    const tabs = (await api.eval(`JSON.stringify(
      [...document.querySelectorAll("table")].slice(0,10).map(t=>
        [...t.rows].slice(0,80).map(r=>
          [...r.cells].map(c=>c.innerText.trim().replace(/\\s+/g," ").replace(/\\|/g,"/"))
          .join(" | ")).filter(l=>l.trim()).join("\\n")))`)) as string[] | string | null;
    const list: string[] = typeof tabs === "string" ? JSON.parse(tabs) : (tabs ?? []);
    if (!list.length) return `✕ no tables on "${card.dataset.topic}"`;
    const pick = lastN >= 0 ? list.slice(lastN, lastN + 1) : list.slice(0, 3);
    return pick
      .map((t, i) => `table ${lastN >= 0 ? lastN + i : i} (${t.split("\n").length} rows):\n${t}`)
      .join("\n\n")
      .slice(0, 10000);
  }

  // grab <browser> <n> <sheet> — table n straight into a named sheet
  if (verb === "grab") {
    const sp = rest.split(/\s+/);
    if (sp.length < 3) return "✕ grab needs <browser> <table#> <sheet>";
    const ni = sp.findIndex((t, i) => i > 0 && /^\d+$/.test(t));
    if (ni < 0 || ni === sp.length - 1) return "✕ grab needs <browser> <table#> <sheet>";
    const bname = sp.slice(0, ni).join(" ");
    const tno = parseInt(sp[ni], 10);
    const sname = sp.slice(ni + 1).join(" ");
    const card = findBrowser(bname);
    if (!card) return `✕ no browser found named "${bname || "?"}"`;
    const api = browserApi(card)!;
    const tabs = (await api.eval(`JSON.stringify(
      [...document.querySelectorAll("table")].slice(0,10).map(t=>
        [...t.rows].slice(0,80).map(r=>
          [...r.cells].map(c=>c.innerText.trim().replace(/\\s+/g," ").replace(/\\|/g,"/"))
          .join(" | ")).filter(l=>l.trim()).join("\\n")))`)) as string[] | string | null;
    const list: string[] = typeof tabs === "string" ? JSON.parse(tabs) : (tabs ?? []);
    if (tno < 0 || tno >= list.length)
      return `✕ table ${tno} not found — "${card.dataset.topic}" has ${list.length}`;
    const rows = list[tno].split("\n");
    if (!findSheet(sname)) await runWidgetFence("sheet", `new ${sname}`);
    const scard = findSheet(sname);
    const sapi = scard ? sheetApi(scard) : null;
    if (!sapi) return `✕ could not create sheet "${sname}"`;
    for (const l of rows) sapi.addRow(l.split("|").map((s) => s.trim()));
    return `grabbed table ${tno} from "${card.dataset.topic}" → ${rows.length} rows into sheet "${sapi.title()}"`;
  }

  // click <title> <n|text> — click a link inside the live page;
  // pv:nav tracks wherever it lands
  if (verb === "click") {
    const sp = rest.split(/\s+/);
    let card = findBrowser(rest);
    let sel = "";
    if (!card) {
      for (let i = sp.length - 1; i > 0; i--) {
        card = findBrowser(sp.slice(0, i).join(" "));
        if (card) { sel = sp.slice(i).join(" "); break; }
      }
    }
    if (!card) return `✕ no browser found named "${rest.split(/\s+/)[0] || "?"}"`;
    if (!sel) return "✕ click needs a link number or text — click <title> <n|text>";
    const csel = `a[href],button,summary,[role='link'],[role='button'],[tabindex],[onclick],input[type='submit'],input[type='button']`;
    const js = /^\d+$/.test(sel)
      ? `(()=>{const a=[...document.querySelectorAll(${JSON.stringify(csel)})];const m=a[${sel}];` +
        `if(!m)return "no link ${sel}";m.click();return "clicked → "+(m.innerText||m.value||m.href||"").trim().slice(0,80)})()`
      : `(()=>{const want=${JSON.stringify(sel.toLowerCase())};` +
        `const m=[...document.querySelectorAll(${JSON.stringify(csel)})]` +
        `.find(x=>(x.innerText||"").toLowerCase().includes(want));` +
        `if(!m)return "no link matching '${sel.replace(/'/g, "")}'";` +
        `m.click();return "clicked → "+(m.innerText||m.value||m.href||"").trim().slice(0,80)})()`;
    const out = await browserApi(card)!.eval(js);
    return String(out ?? "clicked");
  }

  if (verb === "list") {
    const all = Array.from(document.querySelectorAll<HTMLElement>(".browser-card"));
    if (!all.length) return "no browser cards open";
    return all
      .map((c) => `"${c.dataset.topic}" — ${c.dataset.url || "about:blank"}`)
      .join("\n");
  }

  // tabs <title> — the card's tab strip, active marked; tab <t> <n>
  // switches; newtab <t> [url] opens one (and goes there)
  if (verb === "tabs") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    return browserApi(card)!
      .tabs()
      .map((t, i) => `${t.active ? "→" : " "} ${i + 1}: ${t.title || t.url || "new tab"}${t.url ? ` — ${t.url}` : ""}`)
      .join("\n");
  }
  if (verb === "newtab") {
    const sp = rest.split(/\s+/);
    const maybeUrl = sp[sp.length - 1] ?? "";
    const hasUrl = /^(https?:\/\/|[\w-]+(\.[\w-]+)+)/.test(maybeUrl) && sp.length > 1;
    const card = findBrowser(hasUrl ? sp.slice(0, -1).join(" ") : rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    return await browserApi(card)!.newTab(hasUrl ? maybeUrl : undefined);
  }
  if (verb === "tab") {
    const sp = rest.split(/\s+/);
    const n = parseInt(sp.pop() ?? "", 10);
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    if (!Number.isFinite(n)) return "✕ tab needs a number — tab <title> <n>";
    return await browserApi(card)!.tab(n - 1);
  }

  /* ---------- saved page tools — named js chips that run in the live
   * page; the AI registers specs, the strip under the tabs runs them */
  if (verb === "tools") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    const ts = browserApi(card)!.tools();
    return ts.length
      ? `tools on "${card.dataset.topic}": ${ts.map((t) => t.name).join(", ")}`
      : `no tools on "${card.dataset.topic}" — save one: tool <title> {"name":"x","js":"…"}`;
  }
  if (verb === "tool" || verb === "addtool") {
    const j = rest.indexOf("{");
    const name = j < 0 ? rest : rest.slice(0, j).trim();
    const card = findBrowser(name);
    if (!card) return `✕ no browser found named "${name || "?"}"`;
    if (j < 0) return `✕ tool needs a spec — tool <title> {"name":"x","js":"…"}`;
    try {
      return browserApi(card)!.saveTool(JSON.parse(rest.slice(j)));
    } catch {
      // models often emit js-literal specs (single quotes, bare keys) — same
      // trust level as `eval`, so accept them through the literal parser
      try {
        const spec = new Function(`return (${rest.slice(j)})`)();
        if (spec && typeof spec === "object") return browserApi(card)!.saveTool(spec);
      } catch { /* fall through */ }
      return `✕ bad tool spec — tool <title> {"name":"x","js":"…"}`;
    }
  }
  if (verb === "runtool" || verb === "run") {
    const sp = rest.split(/\s+/);
    const tname = sp.pop() ?? "";
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    return await browserApi(card)!.runTool(tname);
  }
  if (verb === "tooldel" || verb === "rmtool") {
    const sp = rest.split(/\s+/);
    const tname = sp.pop() ?? "";
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    return browserApi(card)!.delTool(tname);
  }

  /* ---------- extensions — userscript lane: {name, js, css, matches} saved
   * app-wide and injected into every matching page load. `ext` is the AI's
   * build-an-extension verb; card arg only locates where to report/inject. */
  if (verb === "exts") {
    const card = findBrowser(rest);
    if (!card) return `✕ no browser found named "${rest || "?"}"`;
    const us = await invoke<{ name: string; enabled: boolean; matches: string[] }[]>("us_list").catch(() => []);
    return us.length
      ? `page scripts: ${us.map((s) => `${s.name}${s.enabled ? "" : " (off)"}`).join(", ")}`
      : `no page scripts — ext <title> {"name":"x","js":"…","matches":["*://*/*"]}`;
  }
  if (verb === "ext" || verb === "addon" || verb === "extension") {
    const j = rest.indexOf("{");
    const name = j < 0 ? rest : rest.slice(0, j).trim();
    const card = findBrowser(name);
    if (!card) return `✕ no browser found named "${name || "?"}"`;
    if (j < 0) return `✕ ext needs a spec — ext <title> {"name":"x","js":"…","matches":["*://*/*"],"css":"…"}`;
    let spec: { name?: string; js?: string; css?: string; matches?: string[] } | null = null;
    try {
      spec = JSON.parse(rest.slice(j));
    } catch {
      try { spec = new Function(`return (${rest.slice(j)})`)(); } catch { /* fall through */ }
    }
    if (!spec?.name || typeof spec.js !== "string")
      return `✕ ext spec needs name + js — ext <title> {"name":"x","js":"…"}`;
    await invoke("us_save", {
      name: spec.name,
      js: spec.js,
      css: typeof spec.css === "string" ? spec.css : "",
      matches: Array.isArray(spec.matches) ? spec.matches.filter((m) => typeof m === "string") : [],
    });
    // inject into the live page right now if the url matches
    const url = browserApi(card)!.url();
    const pats = spec.matches?.length ? spec.matches : ["*://*/*"];
    const hit = pats.some((m) => {
      const re = new RegExp(`^${m.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
      return re.test(url);
    });
    if (hit && url) {
      const tag = `__laidoExt_${spec.name.replace(/\W+/g, "_")}`;
      const js =
        `(()=>{const T=${JSON.stringify(tag)};if(window[T])return'have';window[T]=1;` +
        (spec.css ? `const st=document.createElement('style');st.textContent=${JSON.stringify(spec.css)};(document.head||document.documentElement).append(st);` : "") +
        `try{(function(){\n${spec.js}\n})()}catch(e){return 'err:'+e.message}return'on'})()`;
      const s = await invoke<string>("pv_eval", { id: card.dataset.bv ?? "", js }).catch(() => "");
      return `extension "${spec.name}" saved${s?.includes("on") ? " + live on this page" : ""}${s?.includes("err:") ? ` — script error: ${s}` : ""}`;
    }
    return `extension "${spec.name}" saved — injects on matching page loads`;
  }
  if (verb === "extdel" || verb === "rmext") {
    const sp = rest.split(/\s+/);
    const sname = sp.pop() ?? "";
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    await invoke("us_remove", { name: sname }).catch(() => {});
    return `extension "${sname}" removed`;
  }
  if (verb === "exton" || verb === "extoff") {
    const sp = rest.split(/\s+/);
    const sname = sp.pop() ?? "";
    const card = findBrowser(sp.join(" "));
    if (!card) return `✕ no browser found named "${sp.join(" ") || "?"}"`;
    await invoke("us_toggle", { name: sname, on: verb === "exton" }).catch(() => {});
    return `extension "${sname}" ${verb === "exton" ? "on" : "off"}`;
  }
  return `✕ unknown browser verb "${verb}" — open/read/links/search/extract/tables/grab/click/navigate/back/forward/clip/bookmark/eval/list/tabs/newtab/tab/tools/tool/runtool/tooldel/ext/exts/extdel`;
};

/** locate a chart card by title — same fuzzy logic as findSheet */
const findChart = (name: string): HTMLElement | null => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".chart-card"));
  if (!all.length) return null;
  const n = name.trim().toLowerCase();
  if (!n) return all.length === 1 ? all[0] : null;
  return (
    all.find((c) => (c.dataset.topic ?? "").toLowerCase() === n) ??
    all.find((c) => {
      const t = (c.dataset.topic ?? "").toLowerCase();
      return fuzzyHit(n, t);
    }) ??
    null
  );
};

/** ```chart``` fence — draw viz cards; data inline or live from a sheet */
const CHART_VERBS = new Set([
  "new", "create", "set", "source", "bind", "type", "read", "get", "unbind", "freeze", "export",
]);
const chartTool = async (body: string, depth = 0): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty chart command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  /* packed fence bodies — a later line that starts with a chart verb and
   * names a real chart is its own command (`new cx\nbind cx s A:B`) */
  const isChartCmd = (l: string): boolean => {
    const w = l.trim().split(/\s+/);
    const v = (w[0] ?? "").toLowerCase();
    if (!CHART_VERBS.has(v)) return false;
    if (v === "new" || v === "create") return true;
    return findChart(w.slice(1).join(" ")) != null;
  };
  const extra: string[] = [];
  const cmdRows: string[] = [];
  for (const l of lines.slice(1)) (depth === 0 && isChartCmd(l) ? extra : cmdRows).push(l.trim());
  const single = async (): Promise<string> => {

    // new <title> [type] — spawn a chart card
    if (verb === "new") {
      const card = spawnChartCard(rest || "chart");
      const m = rest.match(/\s(bar|barh|line|area|pie|doughnut|scatter|stacked)$/i);
      const api = chartApi(card);
      if (m && api) api.setType(m[1].toLowerCase());
      // data rows may follow on the same fence
      const rows = cmdRows.map((l) => l.split("|").map((s) => s.trim()));
      if (rows.length && api) api.setRows(rows);
      return `chart "${card.dataset.topic}" created${rows.length ? ` with ${rows.length} points` : ""}`;
    }

    // set <title> then `label | v1 | v2` rows — inline data
    if (verb === "set") {
      const card = findChart(rest);
      if (!card) return `✕ no chart found named "${rest || "?"}"`;
      const rows = cmdRows.map((l) => l.split("|").map((s) => s.trim()));
      if (!rows.length) return "✕ set needs `label | v` rows below it";
      chartApi(card)!.setRows(rows);
      return `chart "${card.dataset.topic}" set — ${rows.length} points`;
    }

    // source <title> <sheet-title> <A1:B9> — live binding to a sheet range
    if (verb === "source" || verb === "bind") {
      const sp = rest.split(/\s+/);
      const range = sp.pop() ?? "";
      const sheetTitle = sp.pop() ?? "";
      const title = sp.join(" ");
      const card = findChart(title);
      if (!card) return `✕ no chart found named "${title || "?"}"`;
      if (!sheetTitle || !range) return "✕ source needs <title> <sheet> <A1:B9>";
      chartApi(card)!.setSource(sheetTitle, range);
      return `chart "${card.dataset.topic}" now live-binds ${sheetTitle} ${range}`;
    }

    // type <title> <bar|line|…>
    if (verb === "type") {
      const sp = rest.split(/\s+/);
      const t = sp.pop() ?? "";
      const card = findChart(sp.join(" "));
      if (!card) return `✕ no chart found named "${sp.join(" ") || "?"}"`;
      if (!(CHART_TYPES as readonly string[]).includes(t)) return `✕ unknown type "${t}"`;
      chartApi(card)!.setType(t);
      return `chart "${card.dataset.topic}" → ${t}`;
    }

    // read <title> — current data back to the model
    if (verb === "read" || verb === "get") {
      const card = findChart(rest);
      if (!card) return `✕ no chart found named "${rest || "?"}"`;
      return chartApi(card)!.read();
    }

    // unbind <title> — freeze live binding back to a snapshot
    if (verb === "unbind" || verb === "freeze") {
      const card = findChart(rest);
      if (!card) return `✕ no chart found named "${rest || "?"}"`;
      const m = chartApi(card)!.model();
      chartApi(card)!.setRows(m.labels.map((l, i) => [l, ...m.series.map((s) => String(s[i] ?? 0))]));
      return `chart "${card.dataset.topic}" frozen to inline data`;
    }

    // export <title> [path] — PNG to disk
    if (verb === "export") {
      const sp = rest.split(/\s+/);
      let title = rest;
      let path: string | undefined;
      const fileIdx = sp.findIndex((w) => /\.(png)$/i.test(w) || /^[A-Za-z]:[\\/]/.test(w));
      if (fileIdx > 0) {
        path = sp.slice(fileIdx).join(" ");
        title = sp.slice(0, fileIdx).join(" ");
      }
      const card = findChart(title);
      if (!card) return `✕ no chart found named "${title || "?"}"`;
      const out = await chartApi(card)!.exportPng(path);
      return `exported → ${out}`;
    }

  return `✕ unknown chart verb "${verb}" — new/set/source/type/read/unbind/export`;
  };
  let out = await single();
  for (const l of extra) out += "\n" + (await chartTool(l, 1));
  return out;
};


/** locate a deck card by title — same fuzzy logic as findSheet */
const findDeck = (name: string): HTMLElement | null => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".deck-card"));
  if (!all.length) return null;
  const n = name.trim().toLowerCase();
  if (!n) return all.length === 1 ? all[0] : null;
  return (
    all.find((c) => (c.dataset.topic ?? "").toLowerCase() === n) ??
    all.find((c) => {
      const t = (c.dataset.topic ?? "").toLowerCase();
      return fuzzyHit(n, t);
    }) ??
    null
  );
};

/** execute one ` ```slides ` fence — the AI's read/write channel into
 *  decks. Slide numbers are 1-based for the model; the api is 0-based.
 *  Verbs:
 *    new <title> [theme]          — a deck card on the note
 *    read <title>                 — every slide's fields back as text
 *    outline <title>              — body rows build slides: `layout | field | field`
 *    addslide <title> <layout>    — one blank slide of a layout
 *    delslide <title> <n>         — remove slide n (decks keep ≥1 slide)
 *    move <title> <n> <m>         — move slide n to position m
 *    layout <title> <n> <layout>  — change a slide's layout
 *    set <title> <n> + body lines — the markdown-ish slide body
 *      (`# title` `## sub` `- bullet` `img: path | caption` `~ note`
 *       `bg: #hex` `> quote` `by: name` `col: a ; b ;; c ; d`)
 *    append <title> <n> <text>    — add one bullet to slide n
 *    theme <title> <name>         — deck theme (light·dark·navy·forest·
 *                                  sunset·mono·paper·coral)
 *    transition <title> <fx>      — none·fade·push·wipe·zoom
 *    bg <title> <n> <color>       — per-slide background
 *    note <title> <n> <text>      — speaker notes
 *    duplicate <title> <n>        — copy slide n
 *  Layouts: title · section · bullets · twocol · image · quote ·
 *  bigfact · blank. `outline` field order: `title | T | Sub`,
 *  `section/bigfact | T | Sub`, `quote | text | by`,
 *  `image | T | img-path | caption`, `twocol | T | a ; b | c ; d`,
 *  `bullets/blank | T | item | item …`. */
const DECK_VERBS = new Set([
  "new", "create", "read", "get", "export", "save", "import", "load", "outline",
  "addslide", "add", "delslide", "delete", "move", "layout", "set", "append",
  "theme", "transition", "bg", "note", "duplicate", "dup", "els", "elements",
  "el", "insert", "elset", "eldel", "tools", "tool", "addtool", "tooldel", "rmtool", "stamp",
]);
const deckTool = async (body: string, depth = 0): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty slides command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  /* packed fence bodies — a later line that starts with a deck verb and
   * names a real deck is its own command (`tool d {…}` + `stamp d 1 t`).
   * Slide-content lines never match: `# t` `- b` `layout: x` `col: y`
   * carry their own sigils; a stray `note to self` only dispatches if
   * its tail resolves to a real deck title */
  const isDeckCmd = (l: string): boolean => {
    const w = l.trim().split(/\s+/);
    const v = (w[0] ?? "").toLowerCase();
    if (!DECK_VERBS.has(v)) return false;
    if (v === "new" || v === "create") return true;
    return findDeck(w.slice(1).join(" ")) != null;
  };
  const extra: string[] = [];
  const rows: string[] = [];
  for (const l of lines.slice(1)) (depth === 0 && isDeckCmd(l) ? extra : rows).push(l.trim());
  const single = async (): Promise<string> => {
    const deckOf = (title: string) => {
      const c = findDeck(title);
      return c ? deckApi(c) : undefined;
    };
    const isLayout = (w: string) => (DECK_LAYOUTS as readonly string[]).includes(w.toLowerCase());

    if (verb === "new" || verb === "create") {
      // optional trailing theme word: `new pitch navy`
      const tm = rest.match(/^(.*?)\s+(\S+)$/);
      const theme = tm && DECK_THEMES[tm[2].toLowerCase()] ? tm[2].toLowerCase() : "";
      const title = theme ? tm![1].trim() : rest;
      const card = spawnDeckCard(title || "deck");
      if (theme) deckApi(card)?.setTheme(theme);
      return `created deck "${title || "deck"}"${theme ? ` (theme ${theme})` : ""}`;
    }

    // most verbs are `<title> …args` — parse args off the tail, fuzzy-match
    // the remaining words as the deck title
    const titleTail = (re: RegExp) => {
      const m = rest.match(re);
      return m ? { a: deckOf(m[1]), m } : null;
    };

    if (verb === "read" || verb === "get") {
      const a = deckOf(rest);
      if (!a) return `✕ no deck found named "${rest || "?"}"`;
      return `deck "${a.title()}" ${a.count()} slides:\n${a.read()}`;
    }
    // export mydeck | export mydeck C:/out.pptx | export mydeck md
    if (verb === "export" || verb === "save") {
      const { title, path, fmt } = pullXferArgs(rest, ["pptx", "md"]);
      let card = findDeck(title);
      if (!card && !title) card = document.querySelector<HTMLElement>(".deck-card") ?? null;
      const a = card ? deckApi(card) : undefined;
      if (!a?.exportFile) return `✕ no deck found named "${title || "?"}"`;
      return a.exportFile(path ?? (fmt ? `exports/${a.title()}.${fmt}` : undefined));
    }
    // import mydeck C:/in.pptx | import C:/in.pptx
    if (verb === "import" || verb === "load") {
      const { title, path } = pullXferArgs(rest, ["pptx"]);
      let card = title ? findDeck(title) : null;
      if (!card) {
        const stem = path?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || title || "deck";
        card = spawnDeckCard(title || stem);
      }
      const a = deckApi(card);
      if (!a?.importFile) return "✕ deck import unavailable";
      return a.importFile(path);
    }
    if (verb === "outline") {
      const a = deckOf(rest);
      if (!a) return `✕ no deck found named "${rest || "?"}"`;
      let made = 0;
      for (const l of rows) {
        const f = l.split("|").map((x) => x.trim()).filter((x, i) => i === 0 || x !== "");
        const layout = isLayout(f[0] ?? "") ? f[0].toLowerCase() : "bullets";
        const g = isLayout(f[0] ?? "") ? f.slice(1) : f;
        const s = emptySlide(layout);
        if (layout === "quote") {
          s.quote = g[0] ?? "";
          s.by = g[1] ?? "";
        } else if (layout === "twocol") {
          s.title = g[0] ?? "";
          s.cols = [
            (g[1] ?? "").split(";").map((x) => x.trim()).filter(Boolean),
            (g[2] ?? "").split(";").map((x) => x.trim()).filter(Boolean),
          ];
        } else if (layout === "image") {
          s.title = g[0] ?? "";
          s.img = g[1] ?? "";
          s.sub = g[2] ?? "";
        } else if (layout === "chart") {
          // `chart | title | type | sheet A1:B9` or `chart | title | type | label=v ; label=v`
          s.title = g[0] ?? "";
          s.chart = g[1] ?? "bar";
          const src = g[2] ?? "";
          if (/^(?:\S+\s+)?[A-Z]+\d*:[A-Z]+\d*$/i.test(src) && !src.includes("=")) {
            s.csrc = src;
          } else {
            s.bullets = src.split(";").map((x) => x.trim()).filter(Boolean).map((x) => x.replace("=", " | "));
          }
        } else if (layout === "bullets" || layout === "blank") {
          s.title = g[0] ?? "";
          s.bullets = g.slice(1);
        } else {
          // title · section · bigfact — headline + sub
          s.title = g[0] ?? "";
          s.sub = g[1] ?? "";
        }
        const idx = a.addSlide(layout);
        a.setSlide(idx, s);
        made++;
      }
      return `added ${made} slide${made === 1 ? "" : "s"} to "${a.title()}"`;
    }
    if (verb === "addslide" || verb === "add") {
      // `addslide <title> <layout>` — layout is the tail word when valid
      const tm = rest.match(/^(.*?)\s+(\S+)$/);
      const hasLay = tm && isLayout(tm[2]);
      const a = deckOf(hasLay ? tm![1] : rest);
      if (!a) return `✕ no deck found named "${rest || "?"}"`;
      const idx = a.addSlide(hasLay ? tm![2].toLowerCase() : "bullets");
      return `added slide ${idx + 1} to "${a.title()}"`;
    }
    if (verb === "delslide" || verb === "delete") {
      const hit = titleTail(/^(.*?)\s+(\d+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ delslide <title> <n>`;
      if (hit.a.count() <= 1) return `✕ a deck keeps at least one slide`;
      hit.a.delSlide(i - 1);
      return `deleted slide ${i} from "${hit.a.title()}"`;
    }
    if (verb === "move") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(\d+)$/);
      const i = Number(hit?.m[2]), j = Number(hit?.m[3]);
      if (!hit?.a || !(i >= 1 && j >= 1 && i <= hit.a.count() && j <= hit.a.count()))
        return `✕ move <title> <from> <to>`;
      hit.a.moveSlide(i - 1, j - 1);
      return `moved slide ${i} → ${j} in "${hit.a.title()}"`;
    }
    if (verb === "layout") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(\w+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count()) || !isLayout(hit.m[3]))
        return `✕ layout <title> <n> <layout> — ${DECK_LAYOUTS.join(" · ")}`;
      hit.a.setLayout(i - 1, hit.m[3].toLowerCase());
      return `slide ${i} layout → ${hit.m[3].toLowerCase()} in "${hit.a.title()}"`;
    }
    if (verb === "set") {
      const hit = titleTail(/^(.*?)\s+(\d+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ set <title> <n>`;
      const s = emptySlide();
      let layout = "";
      for (const l of rows) {
        const lm = l.match(/^layout:\s*(.*)$/i);
        if (lm) layout = lm[1].trim();
        else parseSlideLine(s, l);
      }
      delete (s as Partial<typeof s>).layout;
      hit.a.setSlide(i - 1, s);
      if (layout && isLayout(layout)) hit.a.setLayout(i - 1, layout.toLowerCase());
      return `set slide ${i} in "${hit.a.title()}"`;
    }
    if (verb === "append") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(.*)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ append <title> <n> <bullet text>`;
      hit.a.appendBullet(i - 1, hit.m[3]);
      return `added a bullet to slide ${i} in "${hit.a.title()}"`;
    }
    if (verb === "theme") {
      const hit = titleTail(/^(.*?)\s+(\S+)$/);
      if (!hit?.a || !DECK_THEMES[hit.m[2].toLowerCase()])
        return `✕ theme <title> <name> — ${Object.keys(DECK_THEMES).join(" · ")}`;
      hit.a.setTheme(hit.m[2].toLowerCase());
      return `deck "${hit.a.title()}" → theme ${hit.m[2].toLowerCase()}`;
    }
    if (verb === "transition") {
      const hit = titleTail(/^(.*?)\s+(\S+)$/);
      const fx = hit?.m[2].toLowerCase() ?? "";
      if (!hit?.a || !(DECK_TRANSITIONS as readonly string[]).includes(fx))
        return `✕ transition <title> <fx> — ${DECK_TRANSITIONS.join(" · ")}`;
      hit.a.setTransition(fx);
      return `deck "${hit.a.title()}" → transition ${fx}`;
    }
    if (verb === "bg") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(.+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ bg <title> <n> <color>`;
      hit.a.setBg(i - 1, hit.m[3]);
      return `slide ${i} bg → ${hit.m[3]} in "${hit.a.title()}"`;
    }
    if (verb === "note") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(.*)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ note <title> <n> <text>`;
      hit.a.setNote(i - 1, hit.m[3]);
      return `speaker note on slide ${i} in "${hit.a.title()}"`;
    }
    if (verb === "duplicate" || verb === "dup") {
      const hit = titleTail(/^(.*?)\s+(\d+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ duplicate <title> <n>`;
      const idx = hit.a.duplicate(i - 1);
      return `duplicated slide ${i} → slide ${idx + 1} in "${hit.a.title()}"`;
    }

    /* ---- the insert layer — same `el:` line grammar the file uses ---- */
    if (verb === "els" || verb === "elements") {
      const hit = titleTail(/^(.*?)\s+(\d+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ els <title> <n>`;
      const els = hit.a.listEls(i - 1);
      if (!els.length) return `slide ${i} has no elements`;
      return els
        .map(
          (el, n) =>
            `{${n + 1}} ${el.kind}${el.shape ? "." + el.shape : ""} @${el.x},${el.y} ${el.w}x${el.h}` +
            `${el.fill ? ` fill=${el.fill}` : ""}${el.line ? ` line=${el.line}` : ""}` +
            `${el.size ? ` ${el.size}px` : ""}${el.rot ? ` rot=${el.rot}` : ""}` +
            `${el.src ? ` src=${el.src}` : ""}${el.text ? ` "${el.text.replace(/\n/g, " ").slice(0, 48)}"` : ""}`,
        )
        .join("\n");
    }
    if (verb === "el" || verb === "insert") {
      // `el <title> <n> shape.arrow 10,20,30,15 | t=Go | f=#e2604c | l=#fff`
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(\S[\s\S]*)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count()))
        return `✕ el <title> <n> <kind[.shape]> x,y,w,h [| t=text | f=#hex | l=#hex | c=#hex | z=px | r=deg | s=src | a=lcr | b=1 | i=1]`;
      const fake = emptySlide();
      parseElLine(fake, `el: ${hit.m[3]}`);
      const el = fake.els[0];
      if (!el) return `✕ bad el spec — needs "kind[.shape] x,y,w,h"`;
      const at = hit.a.addEl(i - 1, el);
      return at >= 0
        ? `slide ${i} += ${el.kind}${el.shape ? "." + el.shape : ""} (element ${at + 1})`
        : `✕ element rejected — unknown kind/shape or dead img src`;
    }
    if (verb === "elset") {
      // `elset <title> <n> <m> | f=#hex | t=new text` — patch element m
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(\d+)\s+([\s\S]*)$/);
      const i = Number(hit?.m[2]), n = Number(hit?.m[3]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ elset <title> <n> <m> | k=v | …`;
      const fake = emptySlide();
      parseElLine(fake, `el: text 0,0,1,1 | ${hit.m[4]}`);
      const probe = fake.els[0];
      const patch: Partial<import("./slides.js").SlideEl> = {};
      if (probe) {
        if (probe.text) patch.text = probe.text;
        if (probe.fill) patch.fill = probe.fill;
        if (probe.line) patch.line = probe.line;
        if (probe.color) patch.color = probe.color;
        if (probe.size) patch.size = probe.size;
        if (probe.rot) patch.rot = probe.rot;
        if (probe.src) patch.src = probe.src;
        if (probe.bold) patch.bold = true;
        if (probe.ital) patch.ital = true;
        if (probe.align) patch.align = probe.align;
      }
      // geometry fields ride the same kv parts (x= y= w= h=)
      for (const gm of hit.m[4].matchAll(/(?:^|\|)\s*([xywh])\s*=\s*(-?[\d.]+)/g))
        patch[{ x: "x", y: "y", w: "w", h: "h" }[gm[1]] as "x" | "y" | "w" | "h"] = Number(gm[2]);
      if (!Object.keys(patch).length) return `✕ elset needs at least one field — | t= | f= | x= | w= | …`;
      hit.a.setEl(i - 1, n - 1, patch);
      return `slide ${i} element ${n} updated`;
    }
    if (verb === "eldel") {
      const hit = titleTail(/^(.*?)\s+(\d+)\s+(\d+)$/);
      const i = Number(hit?.m[2]), n = Number(hit?.m[3]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ eldel <title> <n> <m>`;
      if (!hit.a.listEls(i - 1)[n - 1]) return `✕ slide ${i} has no element ${n}`;
      hit.a.delEl(i - 1, n - 1);
      return `deleted element ${n} on slide ${i} in "${hit.a.title()}"`;
    }

    /* ---- custom tools — the AI can invent/register/stamp them too ---- */
    if (verb === "tools") {
      const a = deckOf(rest);
      if (!a) return `✕ no deck found named "${rest || "?"}"`;
      const tl = a.listTools();
      return tl.length
        ? `tools in "${a.title()}":\n` + tl.map((t) => `· ${t.icon} ${t.name} — ${t.els.length} element${t.els.length === 1 ? "" : "s"}`).join("\n")
        : `no custom tools in "${a.title()}" — make one with the 'tool' verb`;
    }
    if (verb === "tool" || verb === "addtool") {
      // `tool <title> {"name":"kpi","icon":"◉","els":[{…}]}` — spec may sit
      // on the head line or the following rows
      const hit = titleTail(/^(.*?)\s+(\{[\s\S]*)$/);
      const spec = hit ? hit.m[2] : rest.includes("{") ? rest : rows.join("\n");
      const title = hit ? hit.m[1] : rows.length ? "" : rest;
      const a = deckOf(title.trim());
      if (!a) return `✕ tool <title> {json} — deck "${title.trim() || "?"}" not found`;
      return a.addTool(spec);
    }
    if (verb === "tooldel" || verb === "rmtool") {
      // `tooldel <title…> <tool name…>` — both sides may have spaces, so
      // walk split points and take the split whose deck exists AND names
      // a real tool; longest title wins (titles match fuzzier than names)
      const words = rest.split(/\s+/).filter(Boolean);
      for (let k = words.length - 1; k >= 1; k--) {
        const a = deckOf(words.slice(0, k).join(" "));
        if (!a) continue;
        const name = words.slice(k).join(" ");
        if (a.listTools().some((t) => t.name === name))
          return a.delTool(name) ? `removed tool "${name}"` : `✕ no tool named "${name}"`;
      }
      // bare `tooldel <name>` with a lone deck — or title-only match
      const decks = Array.from(document.querySelectorAll<HTMLElement>(".deck-card"));
      for (const c of decks) {
        const a = deckApi(c);
        if (a?.listTools().some((t) => t.name === rest))
          return a.delTool(rest) ? `removed tool "${rest}"` : `✕ no tool named "${rest}"`;
      }
      const hit = titleTail(/^(.*?)\s+(.+)$/);
      if (hit?.a) {
        const name = hit.m[2].trim();
        return hit.a.delTool(name) ? `removed tool "${name}"` : `✕ no tool named "${name}"`;
      }
      return `✕ tooldel <title> <tool name>`;
    }
    if (verb === "stamp") {
      // `stamp <title> <n> <tool name> [x,y,w,h]` — run a custom tool onto slide n
      const hit = titleTail(/^(.*?)\s+(\d+)\s+([\s\S]+)$/);
      const i = Number(hit?.m[2]);
      if (!hit?.a || !(i >= 1 && i <= hit.a.count())) return `✕ stamp <title> <n> <tool name> [x,y,w,h]`;
      const bm = hit.m[3].match(/^(.*?)\s+(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\s*$/);
      const name = bm ? bm[1].trim() : hit.m[3].trim();
      const box = bm ? [Number(bm[2]), Number(bm[3]), Number(bm[4]), Number(bm[5])] as const : undefined;
      return hit.a.stamp(i - 1, name, ...(box ?? []));
    }

  return `✕ unknown slides verb "${verb}" — new · read · outline · addslide · delslide · move · layout · set · append · theme · transition · bg · note · duplicate · el · els · elset · eldel · stamp · tool · tools · tooldel`;
  };
  let out = await single();
  for (const l of extra) out += "\n" + (await deckTool(l, 1));
  return out;
};

/** locate a todo card by title — same fuzzy logic as findSheet */
const findTodo = (name: string): HTMLElement | null => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".todo-card"));
  if (!all.length) return null;
  const n = name.trim().toLowerCase();
  if (!n) return all.length === 1 ? all[0] : null;
  return (
    all.find((c) => (c.dataset.topic ?? "").toLowerCase() === n) ??
    all.find((c) => {
      const t = (c.dataset.topic ?? "").toLowerCase();
      return fuzzyHit(n, t);
    }) ??
    null
  );
};

/** execute one ` ```todo ` fence — the AI's task channel. Task numbers are
 *  1-based for the model; the api is 0-based.
 *    new <title>                  — a task-list card on the note
 *    list [title]                 — every task back as text (all cards when empty)
 *    add <title> <text> [@when]   — a task; when: today·tomorrow·+Nd·fri·YYYY-MM-DD
 *    done <title> <n> · open <title> <n> · del <title> <n>
 *    clear <title>                — remove completed tasks
 *    today                        — everything due today across all lists */
const todoTool = async (body: string): Promise<string> => {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  if (!lines.length) return "✕ empty todo command";
  const hm = lines[0].trim().match(/^(\S+)\s*(.*)$/);
  const verb = (hm?.[1] ?? "").toLowerCase();
  const rest = (hm?.[2] ?? "").trim();
  const rows = lines.slice(1);
  const todoOf = (title: string) => {
    const c = findTodo(title);
    return c ? todoApi(c) : undefined;
  };

  if (verb === "new" || verb === "create") {
    spawnTodoCard(rest || "tasks");
    // extra rows become tasks right away
    const api = todoApi(findTodo(rest || "tasks")!);
    rows.forEach((t) => api?.add(t));
    return `created todo "${rest || "tasks"}"${rows.length ? ` + ${rows.length} tasks` : ""}`;
  }
  if (verb === "today") {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const hits: string[] = [];
    for (const td of Array.from(document.querySelectorAll<HTMLElement>(".todo-card"))) {
      const a = todoApi(td);
      if (!a) continue;
      const due = a.items().filter((i) => !i.done && i.when && i.when <= iso);
      if (due.length)
        hits.push(`${a.title()}: ${due.map((i) => `${i.text}${i.when < iso ? " (overdue)" : ""}`).join(" · ")}`);
    }
    return hits.length ? `due today/overdue:\n${hits.join("\n")}` : "nothing due today";
  }
  if (verb === "list" || verb === "read") {
    if (!rest) {
      // every card
      const all = Array.from(document.querySelectorAll<HTMLElement>(".todo-card"))
        .map((c) => todoApi(c))
        .filter(Boolean);
      if (!all.length) return "no todo lists on this note";
      return all.map((a) => `== ${a!.title()} ==\n${a!.list() || "(empty)"}`).join("\n");
    }
    const a = todoOf(rest);
    if (!a) return `✕ no todo list named "${rest}"`;
    return `== ${a.title()} ==\n${a.list() || "(empty)"}`;
  }
  if (verb === "add") {
    // `add <title> <text> [@when]` — title is a word-prefix of the arg list
    const [card, text] = probeTitle(".todo-card", rest.split(/\s+/).filter(Boolean));
    const api = card ? todoApi(card) : undefined;
    if (!api) return `✕ no todo list found — create one first: \`new <title>\``;
    if (!text) return `✕ add <list> <task text> [@when]`;
    const i = api.add(text);
    return `added task ${i} to "${api.title()}"`;
  }
  if (verb === "done" || verb === "check" || verb === "open" || verb === "undone" || verb === "del" || verb === "clear") {
    const nm = rest.match(/^(.*?)\s+(\d+)$/);
    const isClear = verb === "clear";
    const a = isClear ? todoOf(rest) : nm ? todoOf(nm[1]) : undefined;
    if (!a) return `✕ no todo list named "${isClear ? rest : nm?.[1] ?? rest}"`;
    if (isClear) {
      const n = a.clearDone();
      return `cleared ${n} done task${n === 1 ? "" : "s"} from "${a.title()}"`;
    }
    const i = Number(nm![2]);
    if (!(i >= 1 && i <= a.items().length)) return `✕ ${verb} <list> <n> — 1..${a.items().length}`;
    if (verb === "del") {
      a.del(i - 1);
      return `deleted task ${i} from "${a.title()}"`;
    }
    const done = verb === "done" || verb === "check";
    a.setDone(i - 1, done);
    return `task ${i} in "${a.title()}" → ${done ? "done ✓" : "reopened"}`;
  }
  return `✕ unknown todo verb "${verb}" — new · list · add · done · open · del · clear · today`;
};


/** `<verb> <title…> <tail…>` — the card title is a word-prefix of the arg
 *  list. A probe only matches a card when the probe equals or word-prefixes
 *  the card's topic — never the reverse (a probe that *contains* the topic
 *  has eaten the tail). The fuzzy finders above must not be used here:
 *  their contains/only-card fallbacks match at the longest probe and leave
 *  an empty tail — which broke `add <title> <content>` fences whenever one
 *  card existed. Longest probe wins; a lone card takes the whole rest. */
const probeTitle = (sel: string, words: string[]): [HTMLElement | null, string] => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(sel));
  const topic = (c: HTMLElement) => (c.dataset.topic ?? "").toLowerCase();
  for (let i = words.length; i >= 0; i--) {
    const n = words.slice(0, i).join(" ").toLowerCase();
    const hit = n ? all.find((c) => topic(c) === n || topic(c).startsWith(n + " ")) : null;
    if (hit) return [hit, words.slice(i).join(" ")];
  }
  if (all.length === 1) return [all[0], words.join(" ")];
  return [null, words.join(" ")];
};

/** locate a browser card by title/url — same fuzzy logic as findSheet */
const findBrowser = (name: string): HTMLElement | null => {
  const all = Array.from(document.querySelectorAll<HTMLElement>(".browser-card"));
  if (!all.length) return null;
  // models quote titles ("Example Domain" 1) — the quotes aren't part of it
  const n = name.trim().replace(/^["']+|["']+$/g, "").toLowerCase();
  if (!n) return all.length === 1 ? all[0] : null;
  return (
    all.find((c) => (c.dataset.topic ?? "").toLowerCase() === n) ??
    all.find((c) => (c.dataset.url ?? "").toLowerCase() === n) ??
    all.find((c) => {
      const t = (c.dataset.topic ?? "").toLowerCase();
      const u = (c.dataset.url ?? "").toLowerCase();
      return fuzzyHit(n, t) || u.includes(n);
    }) ??
    null
  );
};


/** one entry point for every widget fence — the terminal's dispatch
 *  loop and the sheet's AI chat bar both route through here, so asking a
 *  sheet to "chart this" or "make a deck of it" reaches the same verbs. */
export const runWidgetFence = async (kind: string, body: string): Promise<string> => {
  switch (kind) {
    case "sheet": return sheetTool(body);
    case "slides":
    case "deck": return deckTool(body);
    case "todo": return todoTool(body);
    case "chart": return chartTool(body);
    case "cards": return cardsTool(body);
    case "map": return mapTool(body);
    case "base": return baseTool(body);
    case "browser": return browserTool(body);
    default: return `✕ no handler for ${kind} fences`;
  }
};

export function wireTerminal(card: HTMLElement) {
  if (!card?.dataset) return;
  const log = card.querySelector<HTMLElement>(".term-log");
  const input = card.querySelector<HTMLTextAreaElement>(".term-input");
  if (!log || !input || card.dataset.wired) return;
  card.dataset.wired = "1";
  const history: Array<{ role: string; content: string }> = [];
  const searched = new Set<string>();
  let steps = 0;
  let busy = false;
  let spawnRetries = 0;

  const line = (cls: string, text: string) => {
    const d = document.createElement("div");
    d.className = `term-line ${cls}`;
    d.dataset.t = cls;
    d.dataset.raw = text;
    d.textContent = text;
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };

  // the persisted log is the thread — rebuild it so the AI remembers
  for (const l of Array.from(log.querySelectorAll<HTMLElement>(".term-line"))) {
    const t = l.dataset.t ?? "out";
    const raw = l.dataset.raw ?? "";
    if (t === "ask") history.push({ role: "user", content: raw });
    else if (t === "ai") history.push({ role: "assistant", content: raw });
    else if (t === "cmd") history.push({ role: "user", content: `ran: ! ${raw}` });
    else if (t === "out" && raw.trim()) history.push({ role: "user", content: `output: ${raw}` });
  }

  /** the note context for card-landing commands — in a sticky window the
   *  cards land inside the sticky itself (its own research:done listener) */
  const noteName = () =>
    currentNote() || (document.body.classList.contains("sticky-mode") ? "sticky" : "");

  const emitCard = (topic: string, md: string) => {
    void window.__TAURI__.event.emit("research:done", {
      note: noteName(),
      topic,
      callout: md,
      kind: "rag",
      quiet: true,
      anchor: null,
    });
  };

  const resolveTarget = async (rest: string, hybrid: boolean) => {
    const m = rest.match(/^@?([\w-]+)\s+(.+)$/);
    const pseudo = ["all-files", "my-notes", "everything"];
    if (m && (pseudo.includes(m[1]) || (await matchDoc(m[1])))) {
      // resolve the slug so a fuzzy name token still scopes correctly
      const hit = pseudo.includes(m[1]) ? m[1] : (await matchDoc(m[1]))?.slug ?? m[1];
      return { target: hit, query: m[2] };
    }
    return { target: hybrid ? "everything" : "all-files", query: rest };
  };

  const parseTargetN = (rest: string, defN: number) => {
    let target = "my-notes";
    let n = defN;
    const parts = rest.trim().split(/\s+/).filter(Boolean);
    if (parts[0] && !/^\d+$/.test(parts[0])) {
      target = parts[0].replace(/^@/, "");
      parts.shift();
    }
    if (parts[0] && /^\d+$/.test(parts[0])) n = Number(parts[0]) || defN;
    return { target, n };
  };

  /** Laido commands inside the widget — typed by the user or proposed by
   *  the AI (```laido``` fences); results land as cards on the note */
  const runLaido = async (cmd: string): Promise<string> => {
    const m = cmd.trim().match(LAIDO_RE);
    if (!m) {
      line("err", `unknown command: ${cmd}`);
      return "";
    }
    const verb = m[1].toLowerCase();
    const rest = m[2].trim();
    const note = noteName();
    if (!note) {
      line("err", "no note open — open one first");
      return "";
    }
    try {
      switch (verb) {
        case "research": {
          if (!rest) throw new Error("give the research a topic");
          await invoke("agent_run", { name: note, text: `@research ${rest}`, anchor: null });
          line("ai", "researching — the card lands on your note");
          break;
        }
        case "ask": {
          if (!rest) throw new Error("give the ask a question");
          const { target, query } = await resolveTarget(rest, true);
          await invoke("rag_ask", {
            note, target, query, quiet: true, anchor: null, question: query, web: true,
          });
          line("ai", `✓ answered from ${target} — the card is on your note`);
          break;
        }
        case "document": {
          if (!rest) throw new Error("give the document a question");
          const { target, query } = await resolveTarget(rest, false);
          await invoke("rag_ask", {
            note, target, query, quiet: true, anchor: null, question: query, web: false,
          });
          line("ai", `✓ answered from ${target}`);
          break;
        }
        case "summary": {
          const md = await invoke<string>("note_summary", { name: note, instruction: rest || null });
          emitCard(`summary: ${note}`, md);
          line("ai", "✓ summarized — the card is on your note");
          break;
        }
        case "related": {
          const rows = await invoke<Array<{ name: string; score: number }>>("related_notes", { name: note });
          const body = rows.length
            ? rows
                .map((r) => `- [[${r.name.replace(/\.(laido|md)$/, "")}]] · ${Math.round(r.score * 100)}%`)
                .join("\n")
            : "no related notes yet — keep writing";
          emitCard("related", `> [!ai] related: ${note}\n> ${body.split("\n").join("\n> ")}`);
          line("ai", "✓ related notes carded");
          break;
        }
        case "recall": {
          const { target, n } = parseTargetN(rest, 6);
          const md = await invoke<string>("rag_quiz", { target, n });
          emitCard(`recall: ${target}`, md);
          line("ai", "✓ recall carded");
          break;
        }
        case "tasks": {
          const { target, n } = parseTargetN(rest, 8);
          const md = await invoke<string>("rag_tasks", { target, n });
          emitCard(`tasks: ${target}`, md);
          line("ai", "✓ tasks carded");
          break;
        }
        case "loop": {
          let q = rest;
          let loops = 3;
          const nm = q.match(/^(\d{1,2})\s+/);
          if (nm) {
            loops = Math.max(1, Math.min(10, Number(nm[1])));
            q = q.slice(nm[0].length).trim();
          }
          let target: string | null = null;
          const tm = q.match(/^(@?[\w-]+)\s+(.+)$/);
          if (tm) {
            const cand = tm[1].replace(/^@/, "");
            const pseudo = ["all-files", "my-notes", "everything"];
            const files = await invoke<Array<{ slug: string }>>("rag_list").catch(() => []);
            if (pseudo.includes(cand) || files.some((f) => f.slug === cand)) {
              target = cand;
              q = tm[2].trim();
            }
          }
          if (!q) throw new Error("give the loop a research query");
          await invoke("loop_run", { note, query: q, loops, target, anchor: null });
          line("ai", `🔁 loop started — up to ${loops} rounds`);
          break;
        }
        case "skill": {
          const name = rest.split(/\s+/)[0];
          if (!name) throw new Error("name the skill to run");
          await invoke("skill_run", { note, name, quiet: true });
          line("ai", `✓ skill ${name} ran — its cards land on your note`);
          break;
        }
        case "widget":
        case "canvas":
        case "agenda":
        case "graph": {
          // fence-less spawnables — canvas/agenda/graph have no tool fence
          // (freeform strokes / computed views); the fence only births them.
          // `widget canvas t` and bare `canvas t` both work — the model
          // writes either
          const bare = verb !== "widget";
          const sp = rest.match(/^(\S+)\s*(.*)$/);
          const kind = bare ? verb : (sp?.[1] ?? "").toLowerCase();
          const title = (bare ? rest : sp?.[2]?.trim() || "")
            .replace(/^new\s+/i, "").replace(/^a\s+/i, "").trim() || "";
          const card =
            kind === "canvas" || kind === "draw" ? spawnCanvasCard(title || "canvas")
            : kind === "agenda" || kind === "due" ? spawnAgendaCard(title || "agenda")
            : kind === "graph" || kind === "map-view" ? spawnGraphCard(title || "vault map")
            : null;
          if (!card) throw new Error(`unknown widget "${kind}" — canvas · agenda · graph (sheet/slides/todo/chart/cards/map/base spawn from their own fence 'new')`);
          line("ai", `✓ ${kind} card spawned — "${card.dataset.topic ?? card.dataset.title ?? (title || kind)}"`);
          break;
        }
      }
    } catch (err) {
      line("err", `✕ ${String(err)}`);
    }
    return "ok";
  };

  const showOutput = (r: TermResult) => {
    for (const l of r.output.split("\n").filter((l) => l.trim() !== "").slice(-14)) {
      line("out", l);
    }
    if (!r.ok && r.code !== null) line("out", `(exit ${r.code})`);
  };

  const runShell = async (cmd: string): Promise<string> => {
    line("cmd", cmd);
    const r = await invoke<TermResult>("term_run", { cmd, confirm: false });
    if (r.needs_confirm) {
      const row = document.createElement("div");
      row.className = "term-line confirm";
      const span = document.createElement("span");
      span.textContent = cmd;
      const run = document.createElement("button");
      run.className = "term-btn";
      run.textContent = "Run";
      const skip = document.createElement("button");
      skip.className = "term-btn ghost";
      skip.textContent = "Skip";
      row.append(span, run, skip);
      log.append(row);
      log.scrollTop = log.scrollHeight;
      return await new Promise<string>((resolve) => {
        run.addEventListener("click", async () => {
          row.remove();
          const rr = await invoke<TermResult>("term_run", { cmd, confirm: true });
          showOutput(rr);
          resolve(rr.output);
        });
        skip.addEventListener("click", () => {
          row.remove();
          line("out", "(skipped)");
          resolve("");
        });
      });
    }
    showOutput(r);
    return r.output;
  };

  /** every other live chat widget on this sheet — with its id, so the AI can
   *  name them in send proposals; empty chats are listed too so nothing on
   *  the sheet is invisible to the others */
  const othersDigest = () => {
    const parts: string[] = [];
    for (const c of Array.from(document.querySelectorAll<HTMLElement>(".term-card"))) {
      if (c === card) continue;
      const lines = Array.from(
        c.querySelectorAll<HTMLElement>('.term-line[data-t="ask"], .term-line[data-t="ai"]'),
      )
        .map((l) => (l.dataset.raw ?? "").slice(0, 80))
        .filter(Boolean)
        .slice(-4);
      const id = c.dataset.chatId ?? "?";
      parts.push(`chat ${id}: ${lines.length ? lines.join(" | ") : "(fresh, no messages yet)"}`);
    }
    // sheets are listed too — the AI reads/edits them with `sheet` fences
    for (const s of Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"))) {
      const api = sheetApi(s);
      const title = s.dataset.topic ?? "sheet";
      if (!api) {
        parts.push(`sheet "${title}" (loading)`);
        continue;
      }
      const peek: string[] = [];
      for (let r = 0; r < Math.min(api.rows(), 10) && peek.length < 14; r++)
        for (let c = 0; c < api.cols() && peek.length < 14; c++) {
          const raw = api.raw(r, c);
          if (raw.trim()) peek.push(`${cellName(r, c)}=${raw.slice(0, 24)}`);
        }
      const tabs = api.tabs?.() ?? [];
      const tabNote = tabs.length > 1 ? ` [workbook tabs: ${tabs.join(", ")}]` : "";
      parts.push(
        `sheet "${title}" ${api.rows()}x${api.cols()}${tabNote}: ${peek.join(", ") || "(empty)"} — use a \`\`\`sheet fence to read it fully or edit it`,
      );
    }
    // decks are listed too — `slides` fences read/edit them
    for (const d of Array.from(document.querySelectorAll<HTMLElement>(".deck-card"))) {
      const api = deckApi(d);
      const title = d.dataset.topic ?? "deck";
      if (!api) {
        parts.push(`deck "${title}" (loading)`);
        continue;
      }
      parts.push(
        `deck "${title}" ${api.count()} slides — use a \`\`\`slides fence to read/edit it`,
      );
    }
    // todo lists too — `todo` fences read/edit them
    for (const td of Array.from(document.querySelectorAll<HTMLElement>(".todo-card"))) {
      const api = todoApi(td);
      const title = td.dataset.topic ?? "todo";
      if (!api) {
        parts.push(`todo "${title}" (loading)`);
        continue;
      }
      const open = api.items().filter((i) => !i.done).length;
      parts.push(
        `todo "${title}" ${open} open / ${api.items().length} total — use a \`\`\`todo fence to read/edit it`,
      );
    }
    // browser cards — `browser` fences navigate them or read the page text
    for (const bc of Array.from(document.querySelectorAll<HTMLElement>(".browser-card"))) {
      const api = browserApi(bc);
      const title = bc.dataset.topic ?? "browser";
      if (!api) {
        parts.push(`browser "${title}" (loading)`);
        continue;
      }
      // a peek at the page text puts real context in the prompt — the
      // agent can answer without burning a fence call just to look
      const peek = api.read().trim().replace(/\s+/g, " ").slice(0, 180);
      parts.push(
        `browser "${title}" at ${api.url() || "about:blank"} (${api.mode()})` +
          (peek ? ` — page text starts: "${peek}…"` : " (no page loaded yet)") +
          ` — use a \`\`\`browser fence to navigate/read it`,
      );
    }
    // chart cards — `chart` fences draw them, bind them to sheet ranges
    for (const cc of Array.from(document.querySelectorAll<HTMLElement>(".chart-card"))) {
      const api = chartApi(cc);
      const title = cc.dataset.topic ?? "chart";
      if (!api) {
        parts.push(`chart "${title}" (loading)`);
        continue;
      }
      const src = cc.dataset.csrc ? ` ← live from ${cc.dataset.csrc}` : " (inline data)";
      parts.push(
        `chart "${title}" ${cc.dataset.ctype || "bar"}${src} — use a \`\`\`chart fence to set data/type/source`,
      );
    }
    // flashcards — `cards` fences build decks and quiz them
    for (const cc of Array.from(document.querySelectorAll<HTMLElement>(".cards-card"))) {
      const api = cardsApi(cc);
      const title = cc.dataset.topic ?? "cards";
      if (!api) {
        parts.push(`cards "${title}" (loading)`);
        continue;
      }
      const n = api.cards().length;
      const dueLine = api.due();
      const dueN = dueLine === "nothing due" ? 0 : dueLine.split("\n").length;
      parts.push(`cards "${title}" — ${n} cards, ${dueN} due — use a \`\`\`cards fence to add/list/rate`);
    }
    // mind maps — `map` fences build outlines that draw as trees
    for (const mc of Array.from(document.querySelectorAll<HTMLElement>(".map-card"))) {
      const api = mapApi(mc);
      const title = mc.dataset.topic ?? "map";
      const n = api ? api.list().split("\n").filter((l) => l.trim()).length : 0;
      parts.push(`map "${title}" — ${n} nodes — use a \`\`\`map fence to add/read`);
    }
    // base cards — property-query views; `base` fences set/read them
    for (const bc of Array.from(document.querySelectorAll<HTMLElement>(".base-card"))) {
      const api = baseApi(bc);
      const title = bc.dataset.title ?? "base";
      if (!api) {
        parts.push(`base "${title}" (loading)`);
        continue;
      }
      parts.push(
        `base "${title}" ${api.view()} view${api.query() ? ` q="${api.query()}"` : ""} — ${api.rows().length} rows — use a \`\`\`base fence to set/read it`,
      );
    }
    return parts.join("\n");
  };


  /** ```note``` fence — the model creates/reads/appends vault notes.
   *  This is how reports, briefings and saved research get written. */
  const noteTool = async (body: string): Promise<string> => {
    const lines = body.split("\n");
    const hm = (lines[0] ?? "").trim().match(/^(\S+)\s*(.*)$/);
    const verb = (hm?.[1] ?? "").toLowerCase();
    const rest = (hm?.[2] ?? "").trim();
    const noteName = (s: string) =>
      s.trim().replace(/\.(md|laido)$/i, "").replace(/[<>:"\\|?*#^\[\]]/g, "-");
    if (verb === "new" || verb === "write" || verb === "create") {
      const name = noteName(rest);
      if (!name) return "✕ note new needs a name";
      const md = lines.slice(1).join("\n");
      await invoke("vault_write", { name: `${name}.laido`, content: md + "\n" });
      addActivity(`wrote note "${name}" (${md.split("\n").length} lines)`);
      return `note "${name}" written — open it from the palette or \`@today\`-style`;
    }
    if (verb === "append") {
      const name = noteName(rest);
      if (!name) return "✕ note append needs a name";
      const md = lines.slice(1).join("\n");
      let cur = "";
      try {
        cur = await invoke<string>("vault_read", { name: `${name}.laido` });
      } catch { /* fresh note */ }
      await invoke("vault_write", {
        name: `${name}.laido`,
        content: cur.trimEnd() + "\n\n" + md + "\n",
      });
      addActivity(`appended ${md.split("\n").length} lines to "${name}"`);
      return `appended to "${name}"`;
    }
    if (verb === "read" || verb === "get") {
      const name = noteName(rest);
      try {
        return await invoke<string>("vault_read", { name: `${name}.laido` });
      } catch {
        return `✕ no note named "${name}"`;
      }
    }
    if (verb === "list") {
      const files = await invoke<Array<{ name: string }>>("vault_list").catch(() => []);
      return files.map((f) => f.name).join("\n") || "(empty vault)";
    }
    if (verb === "open") {
      const name = noteName(rest);
      void loadNote(`${name}.laido`);
      return `opened "${name}"`;
    }
    return `✕ unknown note verb "${verb}" — new/append/read/list/open`;
  };


  const aiTurn = async (text: string, auto = false, images: ChatImage[] = []): Promise<string> => {
    if (busy && !auto) return "";
    busy = true;
    steps++;
    if (!auto) spawnRetries = 0;
    let finalText = "";
    const pend = line("pending", "…");
    try {
      const r = await invoke<TermAi>("term_ai", {
        prompt: text,
        history: history.slice(-12),
        others: othersDigest(),
        model: card.dataset.model || null,
        persona: card.dataset.persona || null,
        images,
      });
      pend.remove();
      for (const l of r.text.split("\n").filter((l) => l.trim() !== "")) line("ai", l);
      finalText = r.text;
      // the model sometimes narrates "spinning up a sub-AI" or "delegating
      // it to chat 2" without emitting any fence — one honest retry so the
      // promise actually happens
      const narratedSpawn =
        r.spawn.length === 0 &&
        /\b(spawn|spin(ning)?\s?up|launch(ing)?|creat(e|ing)|open(ing)?|dedicated)\b[\s\S]{0,45}\b(sub[\s-]?ai|sub[\s-]?agent|chat|agent|widget)\b/i.test(
          r.text,
        );
      const narratedHand =
        r.send.length === 0 &&
        r.assign.length === 0 &&
        /\b(delegat|assign|forward|send|hand|pass|tell|ask|giv)[a-z]*\b[^.\n]{0,45}\bchat\b/i.test(
          r.text,
        );
      // same failure for widgets: "I'll create a sheet for you" with no
      // ```sheet fence means the user watches a promise that never lands —
      // they see the AI describe the widget instead of making it
      const noWidgetFence =
        r.sheet.length === 0 &&
        r.slides.length === 0 &&
        r.todo.length === 0 &&
        r.browser.length === 0 &&
        r.chart.length === 0 &&
        r.cards.length === 0 &&
        r.maps.length === 0 &&
        r.vault.length === 0 &&
        (r.base ?? []).length === 0;
      const narratedTool =
        noWidgetFence &&
        !/\b(shall i|want me|would you like|do you want|should i)\b/i.test(r.text) &&
        /\b(creat|mak|build|add|draw|generat|set ?up|open|start|put|spawn)\w*\b[\s\S]{0,45}\b(sheet|spreadsheet|deck|slides?|presentation|todo|tasks?|chart|plot|graph|flash ?cards?|mind ?map|browser|web ?page|note|canvas|widget)\b/i.test(
          r.text,
        );
      if ((narratedSpawn || narratedHand || narratedTool) && spawnRetries < 1) {
        spawnRetries++;
        finalText = await aiTurn(
          "you described an action — but nothing happens until you emit the fence. Emit it now:\n" +
            "```assign\n<open chat id> <the task>\n``` — delegate a task to a chat that is already open (its result reports back)\n" +
            "```send\n<open chat id> <message>\n``` — a plain message\n" +
            "```spawn\n<task>\n``` — only to create a NEW chat widget\n" +
            "```sheet\nnew <title>\n``` · ```slides\nnew <title>\n``` · ```todo\nnew <title>\n<task>\n``` · " +
            "```chart\nnew <title> <type>\n<label> | <value>\n``` · ```cards\nnew <title>\n<front> :: <back>\n``` · " +
            "```map\nnew <title>\n- root\n``` · ```browser\nopen <url>\n``` · ```vault\nnew <name>\n# body\n``` — whichever the promise was",
          true,
        );
      }
      const proposed = [
        ...r.laido.map((c) => "```laido\n" + c + "\n```"),
        ...r.commands.map((c) => "```run\n" + c + "\n```"),
        ...r.web.map((q) => "```web\n" + q + "\n```"),
        ...r.notes.map((q) => "```notes\n" + q + "\n```"),
        ...r.sheet.map((c) => "```sheet\n" + c + "\n```"),
        ...r.slides.map((c) => "```slides\n" + c + "\n```"),
        ...r.todo.map((c) => "```todo\n" + c + "\n```"),
        ...r.browser.map((c) => "```browser\n" + c + "\n```"),
        ...r.chart.map((c) => "```chart\n" + c + "\n```"),
        ...(r.base ?? []).map((c) => "```base\n" + c + "\n```"),
      ].join("\n");
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: [r.text, proposed].filter(Boolean).join("\n") });
      for (const body of r.send) {
        // "```send\n1.1 hello there```" — deliver into that chat's session
        const sp = body.trim().split(/\s+/);
        if (/^chat$/i.test(sp[0] ?? "")) sp.shift(); // "chat 1.1" → "1.1"
        const toId = sp.shift() ?? "";
        const message = sp.join(" ");
        line("laido", `send to chat ${toId}: ${message}`);
        deliver(card, toId, message);
      }
      for (const body of r.assign) {
        // "```assign\n2 summarize my notes```" — delegate real work to a
        // chat that is already open; its result reports back here
        const sp = body.trim().split(/\s+/);
        if (/^chat$/i.test(sp[0] ?? "")) sp.shift();
        const toId = sp.shift() ?? "";
        const task = sp.join(" ");
        line("laido", `task for chat ${toId}: ${task}`);
        deliver(card, toId, task, true);
      }
      for (const body of r.spawn) {
        // "```spawn\n<task one>\n<task two>```" — one new chat per task, each
        // works its task in parallel and reports its answer back here
        const tasks = body.split("\n").map((t: string) => t.trim()).filter(Boolean);
        if (!tasks.length) continue;
        line("laido", `spawning ${tasks.length} chats with tasks`);
        await spawnChats(tasks);
      }
      for (const q of r.web) {
        const key = q.trim().toLowerCase();
        // bogus queries (the model echoing its instructions) and exact repeats
        // would loop the tool chain forever — skip them
        if (key.length < 3 || BOGUS_QUERY.has(key) || searched.has(`w:${key}`)) continue;
        searched.add(`w:${key}`);
        if (SHELLISH.test(q)) {
          const out = await runShell(q);
          history.push({ role: "user", content: `output of \`${q}\`:\n${out}` });
          if (steps < MAX_STEPS) finalText = await aiTurn("answer the request using this output", true);
          continue;
        }
        line("laido", `web: ${q}`);
        const hits = await invoke<string>("term_web", { query: q }).catch((e) => `✕ ${String(e)}`);
        history.push({ role: "user", content: `web results for \`${q}\`:\n${hits}` });
        if (steps < MAX_STEPS) {
          finalText = await aiTurn(
            "answer the request using these results — only search again if something critical is missing",
            true,
          );
        }
      }
      for (const q of r.notes) {
        const key = q.trim().toLowerCase();
        if (key.length < 3 || BOGUS_QUERY.has(key) || searched.has(`n:${key}`)) continue;
        searched.add(`n:${key}`);
        if (SHELLISH.test(q)) {
          // mis-routed shell command — run it, the output feeds back
          const out = await runShell(q);
          history.push({ role: "user", content: `output of \`${q}\`:\n${out}` });
          if (steps < MAX_STEPS) finalText = await aiTurn("answer the request using this output", true);
          continue;
        }
        // a leading doc token scopes the search to that one document —
        // "notes\nmy-resume what does it say about X" or "my-resume: what…"
        let target: string | null = null;
        let query = q;
        const tm = q.match(/^@?([\w-]+)\s*[: ]\s*(.+)$/s);
        if (tm) {
          const hit = await matchDoc(tm[1]);
          if (hit) {
            target = hit.slug;
            query = tm[2];
          }
        }
        line("laido", `notes${target ? ` [${target}]` : ""}: ${query}`);
        const chunks = await invoke<string>("term_notes", { query, target }).catch(
          (e) => `✕ ${String(e)}`,
        );
        history.push({ role: "user", content: `notes/library excerpts for \`${q}\`:\n${chunks}` });
        if (steps < MAX_STEPS) {
          finalText = await aiTurn(
            "answer the request using these excerpts — only search again if something critical is missing",
            true,
          );
        }
      }
      for (const cmd of r.laido) {
        line("laido", cmd);
        // research and loop are long, costly runs — the AI proposing one must
        // be confirmed; the cheap in-app commands go straight through
        if (/^(research|loop)\b/i.test(cmd)) {
          const out = await new Promise<string>((resolve) => {
            const row = document.createElement("div");
            row.className = "term-line confirm";
            const span = document.createElement("span");
            span.textContent = cmd;
            const run = document.createElement("button");
            run.className = "term-btn";
            run.textContent = "Run";
            const skip = document.createElement("button");
            skip.className = "term-btn ghost";
            skip.textContent = "Skip";
            row.append(span, run, skip);
            log.append(row);
            log.scrollTop = log.scrollHeight;
            run.addEventListener("click", () => {
              row.remove();
              resolve("run");
            });
            skip.addEventListener("click", () => {
              row.remove();
              line("out", "(skipped)");
              resolve("");
            });
          });
          if (!out) continue;
        }
        await runLaido(cmd);
      }
      const savedTools: string[] = [];
      for (const body of r.sheet) {
        // "```sheet\nset budget\nB2=5```" — create/read/edit grids on the note
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await sheetTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `sheet: ${head} → ${out}`);
        const saved = out.match(/tool "([^"]+)" saved/);
        if (saved) savedTools.push(saved[1]);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `sheet tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the sheet action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `sheet tool result:\n${out}` });
        // only reads need a spoken follow-up — mutations speak via the
        // visible trace line and the grid itself
        if ((verb === "read" || verb === "get") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this sheet data", true);
      }
      /* "…and apply it to A1:B9" — the model sometimes registers the tool
       * but forgets the apply fence. If a tool actually SAVED this turn and
       * the ask named a range, apply that tool ourselves. */
      if (/\bapply\b/i.test(text) && savedTools.length && !r.sheet.some((b) => /^apply\b/i.test(b.trim()))) {
        const range = text.match(/[A-Za-z]{1,3}\d{1,4}\s*:\s*[A-Za-z]{1,3}\d{1,4}/)?.[0]?.replace(/\s+/g, "");
        if (range) {
          const name = savedTools.at(-1)!;
          const out = await sheetTool(`apply ${name} ${range}`);
          line("laido", `sheet: apply ${name} ${range} → ${out}`);
          history.push({ role: "user", content: `sheet tool result:\n${out}` });
        }
      }
      for (const body of r.slides) {
        // "```slides\noutline pitch\nbullets | Pain | one | two```" —
        // create/read/edit decks on the note
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await deckTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `slides: ${head} → ${out}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `slides tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the slides action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `slides tool result:\n${out}` });
        if ((verb === "read" || verb === "get") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this deck data", true);
      }
      for (const body of r.todo) {
        // "```todo\nadd my day buy milk @friday```" — task lists on the note
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await todoTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `todo: ${head} → ${out}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `todo tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the todo action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `todo tool result:\n${out}` });
        if ((verb === "list" || verb === "read" || verb === "today") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this task data", true);
      }
      for (const body of r.browser) {
        // "```browser\nopen example.com```" — web pages on the note + page
        // text the AI can read to answer questions
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await browserTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `browser: ${head} → ${out.slice(0, 120)}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `browser tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the browser action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `browser tool result:\n${out}` });
        // reads/links return page content — the model answers from it
        if ((verb === "read" || verb === "get" || verb === "links") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this page text", true);
      }
      for (const body of r.chart) {
        // "```chart\nnew sales bar\nJan | 10```" — viz cards, optionally
        // live-bound to a sheet range
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await chartTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `chart: ${head} → ${out}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `chart tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the chart action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `chart tool result:\n${out}` });
        if ((verb === "read" || verb === "get") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this chart data", true);
      }
      for (const body of r.cards) {
        // "```cards\nnew verbs\ntener :: to have```" — flashcard decks
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await cardsTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `cards: ${head} → ${out.slice(0, 120)}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `cards tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the cards action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `cards tool result:\n${out}` });
        if ((verb === "list" || verb === "read" || verb === "due" || verb === "review") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this deck data", true);
      }
      for (const body of r.maps) {
        // "```map\nnew plan\n- root\n  - kid```" — mind-map outlines
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await mapTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `map: ${head} → ${out.slice(0, 120)}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `map tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the map action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `map tool result:\n${out}` });
        if ((verb === "list" || verb === "read") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this map outline", true);
      }
      for (const body of r.vault) {
        // "```vault\nnew report\n# …```" — create/read/append vault notes
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await noteTool(body);
        line("laido", `note: ${body.trim().split("\n")[0]} → ${out.slice(0, 120)}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `note tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the note action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `note tool result:\n${out}` });
        if ((verb === "read" || verb === "get" || verb === "list") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this note data", true);
      }
      for (const body of r.base ?? []) {
        // "```base\nset myview q=status:done view=board```" — query cards
        const verb = (body.trim().split(/\s+/)[0] ?? "").toLowerCase();
        const out = await baseTool(body);
        const head = body.trim().split("\n")[0] ?? "";
        line("laido", `base: ${head} → ${out.slice(0, 120)}`);
        if (out.startsWith("✕")) {
          history.push({ role: "user", content: `base tool failed: ${out}` });
          if (steps < MAX_STEPS)
            finalText = await aiTurn("the base action failed — retry with the correct syntax", true);
          continue;
        }
        history.push({ role: "user", content: `base tool result:\n${out}` });
        if ((verb === "read" || verb === "list" || verb === "rows") && steps < MAX_STEPS)
          finalText = await aiTurn("answer the request using this view data", true);
      }
      for (const cmd of r.commands) {
        const out = await runShell(cmd);
        if (!out) break; // skipped or empty — the loop waits for the user
        history.push({ role: "user", content: `output of \`${cmd}\`:\n${out}` });
        if (steps < MAX_STEPS) finalText = await aiTurn("continue with the output above", true);
      }
    } catch (err) {
      pend.remove();
      line("err", `✕ ${String(err)}`);
    }
    busy = false;
    return finalText;
  };

  /** delegate: one brand-new chat per task, all working in parallel; every
   *  chat reports its answer back here, and once all are in, this chat's AI
   *  synthesizes them */
  const spawnChats = async (tasks: string[]) => {
    const parentId = card.dataset.chatId ?? "1";
    const created: Array<{ id: string; el: HTMLElement; task: string }> = [];
    for (const task of tasks) {
      const el = spawnTerminalCard("chat", undefined, undefined, parentId);
      created.push({ id: el.dataset.chatId ?? "", el, task });
    }
    // cascade the fresh widgets so they don't stack
    created.forEach(({ el }, i) => {
      el.style.left = `${(parseFloat(el.style.left) || 0) + i * 34}px`;
      el.style.top = `${(parseFloat(el.style.top) || 0) + i * 34}px`;
    });
    let reported = 0;
    for (const { id, el, task } of created) {
      const s = sessions.get(el);
      if (!s) continue;
      s.line("incoming", `task from chat ${parentId}: ${task}`);
      void s.aiTurn(`(task from chat ${parentId}) ${task} — do it now with your tools and report the result`, true).then((reply) => {
        reported++;
        line("incoming", `chat ${id} reports: ${reply || "(no answer)"}`);
        history.push({ role: "user", content: `chat ${id} reports: ${reply || "(no answer)"}` });
        if (reported >= created.length) {
          void aiTurn("all the delegated chats have reported — synthesize their answers for me", true);
        }
      });
    }
  };

  const saveSkill = async (name: string) => {
    const cmds = Array.from(log.querySelectorAll<HTMLElement>(".term-line[data-t=cmd]"))
      .map((l) => l.dataset.raw ?? "")
      .filter((c) => c.trim() !== "");
    if (!cmds.length) {
      line("err", "nothing to save — run a ! command first");
      return;
    }
    const nm =
      (name || `term-${Date.now().toString(36)}`).trim().toLowerCase().replace(/[^\w-]+/g, "-") ||
      `term-${Date.now().toString(36)}`;
    try {
      await invoke("skill_save", { name: nm, description: "saved from the terminal", steps: cmds });
      addActivity(`✓ skill saved: ${nm}`);
      line("ai", `skill saved: ${nm} — run it with skill ${nm}`);
    } catch (err) {
      line("err", `✕ ${String(err)}`);
    }
  };

  const prune = () => pruneSessions();

  /** hand something to another open chat widget. A plain message renders
   *  there as an incoming line and that chat's AI handles it with its own
   *  history; a task delegates real work — the target runs it with its own
   *  tools and its answer reports back into THIS chat's log once it
   *  finishes, then this chat's AI speaks the result */
  const deliver = (from: HTMLElement, toId: string, message: string, task = false) => {
    prune();
    const id = toId.replace(/^chat\s*/i, "").trim();
    const entry = Array.from(sessions.entries()).find(([elm]) => elm.dataset.chatId === id);
    if (!entry) {
      line("err", `no chat ${toId} on this sheet`);
      return;
    }
    const [, s] = entry;
    const fromId = from.dataset.chatId ?? "?";
    if (task) {
      s.line("incoming", `task from chat ${fromId}: ${message}`);
      void s
        .aiTurn(
          `(task from chat ${fromId}) ${message} — do it now with your tools and report the result`,
          true,
        )
        .then((reply) => {
          line("incoming", `chat ${id} reports: ${reply || "(no answer)"}`);
          history.push({ role: "user", content: `chat ${id} reports: ${reply || "(no answer)"}` });
          void aiTurn(`chat ${id} finished its delegated task — give me its result briefly`, true);
        });
    } else {
      s.line("incoming", `from chat ${fromId}: ${message}`);
      void s.aiTurn(`(message from chat ${fromId}) ${message}`);
    }
  };

  // the per-widget model selector — top center of the head
  const head = card.querySelector<HTMLElement>(".callout-head");
  if (head && !card.querySelector(".term-model-select")) {
    const sel = document.createElement("select");
    sel.className = "term-model-select";
    sel.title = "Model for this chat";
    void (async () => {
      try {
        const models = await invoke<string[]>("llm_models");
        const s = await invoke<{ model_main?: string }>("settings_get");
        for (const m of models) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = m.split("/").pop() ?? m;
          sel.append(o);
        }
        const want = card.dataset.model || s.model_main || "";
        if (want && !Array.from(sel.options).some((o) => o.value === want)) {
          const o = document.createElement("option");
          o.value = want;
          o.textContent = want;
          sel.append(o);
        }
        sel.value = want;
      } catch {
        /* no model list — the default model is used */
      }
    })();
    sel.addEventListener("change", () => {
      card.dataset.model = sel.value;
      addActivity(`model → ${sel.value}`);
    });
    head.append(sel);
  }

  // 📎 + 🎙 — shared chat tools (attach/paste/drop images+files, voice
  // record→transcribe). Errors land as log lines; chips show under the bar.
  const chatTools = wireChatTools(input, {
    onErr: (m) => line("err", m),
  });

  sessions.set(card, { card, line, aiTurn });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
    const text = input.value.trim();
    if (!text && !chatTools.hasPending()) return;
    input.value = "";
    // the user's own line always shows — every path, command or chat
    if (!text.startsWith("!")) line("ask", text || `📎 ${chatTools.names().join(", ")}`);
    if (text.startsWith("!")) void runShell(text.slice(1).trim());
    else if (/^skill:/i.test(text)) void saveSkill(text.replace(/^skill:\s*/i, ""));
    else if (/^spawn\b/i.test(text)) {
      // spawn task one | task two | task three — delegate directly
      const tasks = text.replace(/^spawn\s*/i, "").split("|").map((t) => t.trim()).filter(Boolean);
      if (tasks.length) void spawnChats(tasks);
      else line("err", "give each chat a task: spawn task one | task two");
    } else if (/^(assign|task)\s+/i.test(text)) {
      // assign 2 summarize my coffee notes — delegate real work to an open chat
      const m =
        text.match(/^(?:assign|task)\s+chat\s*([\w.-]+)\s+(.+)$/is) ??
        text.match(/^(?:assign|task)\s+([\w.-]+)\s+(.+)$/is);
      if (m) {
        line("laido", `task for chat ${m[1]}: ${m[2]}`);
        deliver(card, m[1], m[2], true);
      } else line("err", "use: assign <chat id> <task>");
    } else if (/^send\s+/i.test(text)) {
      // send 1.1 hello there — a plain message to an open chat
      const m =
        text.match(/^send\s+chat\s*([\w.-]+)\s+(.+)$/is) ??
        text.match(/^send\s+([\w.-]+)\s+(.+)$/is);
      if (m) {
        line("laido", `send to chat ${m[1]}: ${m[2]}`);
        deliver(card, m[1], m[2]);
      } else line("err", "use: send <chat id> <message>");
    } else if (LAIDO_RE.test(text)) void runLaido(text);
    else {
      const send = chatTools.collect(text);
      chatTools.reset();
      void aiTurn(send.prompt, false, send.images);
    }
  });
}
