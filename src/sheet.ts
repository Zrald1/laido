/** the sheet widget — a small spreadsheet living in a callout card on the
 *  note. The DOM grid is the source of truth; every change emits
 *  `sheet:changed` (bubbles) so the editor can mark the note dirty and save.
 *
 *  Persistence: the card serializes as a markdown table inside a
 *  `> [!sheet] title` callout — one `>` line per row, `|`-separated cells,
 *  `|` inside a cell escaped as `\|`. Formula cells store the raw formula
 *  (`=SUM(A1:A5)`); values are recomputed on render, so the file stays
 *  human-readable and truthful.
 *
 *  Formulas: `=A1+B2`, `=A1*10%`, `=SUM(A1:A5)`, `=IF(B1>5,"big","small")`,
 *  `=VLOOKUP("x",A1:C9,2,0)` — a recursive-descent evaluator over typed
 *  values (numbers, strings, booleans, 2D ranges), comparisons, `%` postfix,
 *  `&` concat, and ~120 Excel functions. Formula cells show the computed
 *  value; focusing one reveals the formula (raw rides in data-raw). */

import { invoke } from "./ipc.js";
import { tryCardUndo } from "./cardundo.js";

const COLS = (i: number) => String.fromCharCode(65 + i);
const escH = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** board column keys — distinct values, "" becomes "(blank)", sorted with
 *  the blank bucket last (pure so tests can lock the ordering) */
export function groupKeys(vals: string[]): string[] {
  const ks = [...new Set(vals.map((v) => (v === "" ? "(blank)" : v)))];
  return ks.sort((a, b) =>
    a === "(blank)" ? 1 : b === "(blank)" ? -1 : a.localeCompare(b),
  );
}

/** lenient date parse → [y, m(0-based), d] or null; accepts ISO,
 *  M/D/Y, and anything Date.parse gets */
export function parseDay(v: string): [number, number, number] | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return [+m[1], +m[2] - 1, +m[3]];
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return [y, +m[1] - 1, +m[2]];
  }
  // wordy dates need a month name — bare numbers/"junk 12345" parse weird
  if (!/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return null;
  const t = Date.parse(s);
  if (isNaN(t)) return null;
  const d = new Date(t);
  if (d.getFullYear() < 1900 || d.getFullYear() > 2100) return null;
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}
export const isoOf = (y: number, m: number, d: number) =>
  [y, m, d].every(Number.isFinite)
    ? `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    : "";

/* ---------- csv/tsv — standard delimited interchange ----------
 * RFC-4180-ish: quoted fields, "" escapes, embedded commas/newlines. */

export function parseDelim(text: string, delim: string): string[][] {
  text = String(text ?? "");
  delim = String(delim ?? ",");
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQ = false;
  const push = () => {
    row.push(cell);
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) push();
    else if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      push();
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += ch;
  }
  push();
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

export function toDelim(rows: string[][], delim: string): string {
  const esc = (v: string) =>
    /["\n\r]/.test(v) || v.includes(delim) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map((r) => r.map(esc).join(delim)).join("\r\n") + "\r\n";
}

export interface SheetRow {
  cells: string[];
}

/** parse a `|a|b|c|` row line back into cell raw values */
export function parseSheetLine(line: string): string[] {
  line = String(line ?? "");
  const out: string[] = [];
  let cur = "";
  let esc = false;
  for (const ch of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (esc) {
      cur += ch === "|" ? "|" : ch;
      esc = false;
    } else if (ch === "\\") esc = true;
    else if (ch === "|") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const escCell = (raw: string) => String(raw ?? "").replace(/\|/g, "\\|");

/** grid → markdown rows for cardToMd. Beyond the `| a | b |` data rows the
 *  callout carries `> [!meta]` lines — cell formats, conditional rules,
 *  freeze/hide state, column widths, filters — all human-readable. */
/** the sheet's tool state as `[!x] body` lines — sheetToMd persists them to
 *  markdown and undo snapshots stash them so Ctrl+Z restores tool state too */
function collectMetaLines(card: HTMLElement): string[] {
  const meta: string[] = [];
  // cell formats — "B3=cur A1:A9=n2"
  const fmtBits: string[] = [];
  for (const td of Array.from(card.querySelectorAll<HTMLElement>("td[data-raw][data-fmt]"))) {
    const el = td as HTMLElement;
    const r = Number(el.closest<HTMLElement>("tr")?.dataset.r ?? 0);
    const c = Number(el.dataset.c ?? 0);
    if (el.dataset.fmt && el.dataset.fmt !== "general")
      fmtBits.push(`${cellName(r, c)}=${el.dataset.fmt}`);
  }
  if (fmtBits.length) meta.push(`[!fmt] ${fmtBits.join(" ")}`);
  if (card.dataset.cf) meta.push(`[!cf] ${card.dataset.cf}`);
  if (card.dataset.freeze) meta.push(`[!freeze] ${card.dataset.freeze}`);
  // hidden rows/cols — data-uhide on tr (filters also use display:none —
  // only an explicit hide counts), data-h on the column header
  const hidR: string[] = [];
  card.querySelectorAll<HTMLElement>(".sheet-grid tr[data-r]").forEach((tr) => {
    if (tr.dataset.uhide === "1") hidR.push(`r${Number(tr.dataset.r ?? 0) + 1}`);
  });
  const hidC: string[] = [];
  card.querySelectorAll<HTMLElement>(".sheet-grid tr.sheet-cols th[data-c][data-h]").forEach((th) => {
    hidC.push(`c${COLS(Number(th.dataset.c ?? 0))}`);
  });
  if (hidR.length || hidC.length) meta.push(`[!hide] ${[...hidR, ...hidC].join(",")}`);
  const w: string[] = [];
  card.querySelectorAll<HTMLElement>(".sheet-grid tr.sheet-cols th[data-c][data-w]").forEach((th) => {
    const el = th as HTMLElement;
    w.push(`${COLS(Number(el.dataset.c ?? 0))}=${el.dataset.w}`);
  });
  if (w.length) meta.push(`[!w] ${w.join(" ")}`);
  if (card.dataset.filter) meta.push(`[!filter] ${card.dataset.filter}`);
  if (card.dataset.view && card.dataset.view !== "grid")
    meta.push(`[!view] ${card.dataset.view}`);
  return meta;
}

export function sheetToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const rows: string[] = [];
  for (const tr of Array.from(card.querySelectorAll<HTMLElement>(".sheet-grid tr[data-r]"))) {
    const cells = Array.from(tr.querySelectorAll<HTMLElement>("td[data-raw]")).map(
      (td) => escCell(td.dataset.raw ?? ""),
    );
    rows.push(`> | ${cells.join(" | ")} |`);
  }
  const meta = collectMetaLines(card).map((l) => `> ${l}`);
  return `> [!sheet] ${card.dataset.topic ?? "sheet"}\n${rows.join("\n")}${meta.length ? "\n" + meta.join("\n") : ""}`;
}

const tdAt = (card: HTMLElement, r: number, c: number) =>
  card.querySelector<HTMLElement>(`.sheet-grid tr[data-r="${r}"] td[data-raw][data-c="${c}"]`);

const rawAt = (card: HTMLElement, r: number, c: number) => tdAt(card, r, c)?.dataset.raw ?? "";

/** A1 → [row, col] (0-based) */
function refRC(ref: string): [number, number] | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
}

function expandRange(range: string): Array<[number, number]> {
  const [a, b] = range.split(":");
  const ra = refRC(a ?? "");
  const rb = refRC(b ?? "");
  if (!ra) return [];
  if (!rb) return [ra];
  const out: Array<[number, number]> = [];
  for (let r = Math.min(ra[0], rb[0]); r <= Math.max(ra[0], rb[0]); r++)
    for (let c = Math.min(ra[1], rb[1]); c <= Math.max(ra[1], rb[1]); c++) out.push([r, c]);
  return out;
}

/** formula values — a scalar (number|string|bool) or a 2D range of scalars.
 *  Errors ride as "#…" strings and just display, like Excel's error cells. */
type Scalar = number | string | boolean;
type V = Scalar | Scalar[][];

/** the value a cell contributes — literals coerce like Excel ("5"→5,
 *  "20%"→0.2, "true"→bool); formula cells evaluate recursively */
function cellValue(card: HTMLElement, r: number, c: number, depth: number): Scalar {
  const raw = rawAt(card, r, c);
  if (raw.startsWith("=")) {
    const v = evalFormula(card, raw, depth + 1, [r, c]);
    return Array.isArray(v) ? "#err" : v;
  }
  if (raw === "") return "";
  const n = Number(raw.replace(/[$,\s]/g, "").replace(/%$/, ""));
  if (!isNaN(n)) return raw.endsWith("%") ? n / 100 : n;
  if (/^(true|false)$/i.test(raw)) return /^t/i.test(raw);
  return raw;
}

const scalarOf = (v: V): Scalar => (Array.isArray(v) ? v[0]?.[0] ?? "" : v);

const toNum = (v: V): number => {
  const s = scalarOf(v);
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  if (s === "") return 0;
  const n = Number(String(s).replace(/[$,\s]/g, "").replace(/%$/, ""));
  if (!isNaN(n)) return String(s).endsWith("%") ? n / 100 : n;
  return NaN;
};

const toStr = (v: Scalar): string =>
  typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? fmt(v) : v;

const toBool = (v: V): boolean => {
  const s = scalarOf(v);
  if (typeof s === "boolean") return s;
  if (typeof s === "number") return s !== 0;
  return /^\s*true\s*$/i.test(String(s));
};

const flatten = (args: V[]): Scalar[] => {
  const out: Scalar[] = [];
  for (const a of args)
    if (Array.isArray(a)) a.forEach((row) => row.forEach((x) => out.push(x)));
    else out.push(a);
  return out;
};
const nums = (args: V[]) => flatten(args).map(toNum).filter((n) => !isNaN(n));

/** ">5", "<=10", "<>x", "text", "5", "wild*" — SUMIF/COUNTIF criteria */
const matchCrit = (v: Scalar, crit: Scalar): boolean => {
  const s = String(crit).trim();
  const m = s.match(/^(<>|[<>=]=?)(.*)$/);
  const num = (x: string) => {
    const n = Number(x.trim());
    return isNaN(n) ? null : n;
  };
  if (m) {
    const t = num(m[2]);
    const lv = t === null ? String(v).toLowerCase() : toNum(v);
    const rv = t === null ? m[2].trim().toLowerCase() : t;
    if (m[1] === "=") return lv === rv;
    if (m[1] === "<>") return lv !== rv;
    return cmp2(lv as number | string, rv as number | string, m[1]);
  }
  if (s.includes("*") || s.includes("?")) {
    const re = new RegExp(
      "^" + s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i",
    );
    return re.test(String(v));
  }
  const t = num(s);
  return t === null
    ? String(v).toLowerCase() === s.toLowerCase()
    : toNum(v) === t;
};

const flatOf = (v: V): Scalar[] => (Array.isArray(v) ? v.flat() : [v]);

/** pull (range, crit) pairs from trailing args — SUMIFS/COUNTIFS/etc */
const critPairs = (a: V[], start: number): { ranges: Scalar[][]; crits: Scalar[] } => {
  const ranges: Scalar[][] = [];
  const crits: Scalar[] = [];
  for (let i = start; i + 1 < a.length; i += 2) {
    ranges.push(flatOf(a[i]));
    crits.push(scalarOf(a[i + 1]));
  }
  return { ranges, crits };
};

const cmp2 = (a: Scalar, b: Scalar, op: string): boolean => {
  const na: number | string = typeof a === "boolean" ? (a ? "TRUE" : "FALSE") : a;
  const nb: number | string = typeof b === "boolean" ? (b ? "TRUE" : "FALSE") : b;
  if (typeof na === "number" && typeof nb === "number") {
    if (op === "<") return na < nb;
    if (op === ">") return na > nb;
    if (op === "<=") return na <= nb;
    if (op === ">=") return na >= nb;
    return na === nb;
  }
  const x = String(na).toLowerCase();
  const y = String(nb).toLowerCase();
  if (op === "<") return x < y;
  if (op === ">") return x > y;
  if (op === "<=") return x <= y;
  if (op === ">=") return x >= y;
  return x === y;
};

/* ---------- dates ---------- */
const DAY_MS = 86400000;
const asDate = (v: Scalar): Date | null => {
  if (typeof v === "number" && v > 1000) return new Date(Math.round((v - 25569) * DAY_MS));
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
};
const dateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const serial = (d: Date) => Math.round(d.getTime() / DAY_MS) + 25569;

/* ---------- tokenizer ---------- */
type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; r: number; c: number }
  | { t: "range"; cells: Array<[number, number]> }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "pct" };

const isDig = (c: string) => c >= "0" && c <= "9";

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          j++;
          break;
        }
        s += src[j++];
      }
      toks.push({ t: "str", v: s });
      i = j;
      continue;
    }
    if (isDig(ch) || (ch === "." && isDig(src[i + 1] ?? ""))) {
      let j = i;
      let dot = false;
      while (j < src.length && (isDig(src[j]) || (!dot && src[j] === "."))) {
        if (src[j] === ".") dot = true;
        j++;
      }
      toks.push({ t: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_.$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      if (up === "TRUE" || up === "FALSE") {
        toks.push({ t: "bool", v: up === "TRUE" });
        i = j;
        continue;
      }
      if (src[j] === "(") {
        toks.push({ t: "name", v: up });
        i = j;
        continue;
      }
      if (/^[A-Za-z]+\d+$/.test(word)) {
        // cell ref, or a range when a second ref follows the colon
        if (src[j] === ":") {
          let k = j + 1;
          while (k < src.length && /[A-Za-z0-9$]/.test(src[k])) k++;
          if (/^[A-Za-z]+\d+$/.test(src.slice(j + 1, k))) {
            toks.push({
              t: "range",
              cells: expandRange(`${word.toUpperCase()}:${src.slice(j + 1, k).toUpperCase()}`),
            });
            i = k;
            continue;
          }
        }
        const rc = refRC(word);
        if (rc) {
          toks.push({ t: "ref", r: rc[0], c: rc[1] });
          i = j;
          continue;
        }
      }
      throw new Error(`unknown name ${word}`);
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      toks.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>".includes(ch)) {
      toks.push({ t: "op", v: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      toks.push({ t: "lp" });
      i++;
      continue;
    }
    if (ch === ")") {
      toks.push({ t: "rp" });
      i++;
      continue;
    }
    if (ch === "," || ch === ";") {
      toks.push({ t: "comma" });
      i++;
      continue;
    }
    if (ch === "%") {
      toks.push({ t: "pct" });
      i++;
      continue;
    }
    throw new Error(`bad char ${ch}`);
  }
  return toks;
}

/* ---------- recursive-descent evaluator ----------
 * compare → concat & → + - → * / → ^ → unary → % postfix → primary   */
function evalFormula(card: HTMLElement, raw: string, depth: number, host: [number, number] = [0, 0]): V {
  if (depth > 8) return "#cycle";
  let toks: Tok[];
  try {
    toks = tokenize(raw.slice(1));
  } catch {
    return "#bad";
  }
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...vs: string[]) => peek()?.t === "op" && vs.includes((peek() as { v: string }).v);

  const arith = (a: V, b: V, op: string): V => {
    const x = toNum(a);
    const y = toNum(b);
    if (isNaN(x) || isNaN(y)) return "#num";
    if (op === "+") return x + y;
    if (op === "-") return x - y;
    if (op === "*") return x * y;
    if (op === "/") return y === 0 ? "#div0" : x / y;
    return Math.pow(x, y);
  };
  const compare = (a: V, b: V, op: string): V => {
    const x = scalarOf(a);
    const y = scalarOf(b);
    if (op === "=") return cmp2(x, y, "=") ? true : false;
    if (op === "<>") return !cmp2(x, y, "=");
    return cmp2(x, y, op);
  };

  const parseExpr = (): V => parseCompare();
  const parseCompare = (): V => {
    let l = parseConcat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes((peek() as { v: string }).v)) {
      const op = (toks[p++] as { v: string }).v;
      l = compare(l, parseConcat(), op);
    }
    return l;
  };
  const parseConcat = (): V => {
    let l = parseAdd();
    while (isOp("&")) {
      p++;
      l = `${toStr(scalarOf(l))}${toStr(scalarOf(parseAdd()))}`;
    }
    return l;
  };
  const parseAdd = (): V => {
    let l = parseMul();
    while (isOp("+", "-")) {
      const op = (toks[p++] as { v: string }).v;
      l = arith(l, parseMul(), op);
    }
    return l;
  };
  const parseMul = (): V => {
    let l = parsePow();
    while (isOp("*", "/")) {
      const op = (toks[p++] as { v: string }).v;
      l = arith(l, parsePow(), op);
    }
    return l;
  };
  const parsePow = (): V => {
    const l = parseUnary();
    if (isOp("^")) {
      p++;
      return arith(l, parsePow(), "^");
    }
    return l;
  };
  const parseUnary = (): V => {
    if (isOp("-")) {
      p++;
      const v = parseUnary();
      const n = toNum(v);
      return isNaN(n) ? "#num" : -n;
    }
    if (isOp("+")) {
      p++;
      return parseUnary();
    }
    return parsePostfix();
  };
  const parsePostfix = (): V => {
    let v = parsePrimary();
    while (peek()?.t === "pct") {
      p++;
      const n = toNum(v);
      v = isNaN(n) ? "#num" : n / 100;
    }
    return v;
  };
  const parsePrimary = (): V => {
    const tk = toks[p++];
    if (!tk) throw new Error("eof");
    if (tk.t === "num") return tk.v;
    if (tk.t === "str") return tk.v;
    if (tk.t === "bool") return tk.v;
    if (tk.t === "ref") return cellValue(card, tk.r, tk.c, depth);
    if (tk.t === "range") return rangeValues(card, tk.cells, depth);
    if (tk.t === "lp") {
      const v = parseExpr();
      if (toks[p++]?.t !== "rp") throw new Error("parens");
      return v;
    }
    if (tk.t === "name") {
      if (toks[p++]?.t !== "lp") throw new Error("call");
      const args: V[] = [];
      // ref provenance: an arg that was literally one bare cell ref (B5)
      // keeps its coordinates — OFFSET/ROW/FORMULATEXT need the ref itself,
      // not just the value it resolved to
      const argRefs: Array<[number, number] | null> = [];
      if (peek()?.t !== "rp") {
        for (;;) {
          const before = p;
          args.push(parseExpr());
          const tok = toks[before] as { t: string; r?: number; c?: number } | undefined;
          argRefs.push(tok?.t === "ref" && p === before + 1 ? [tok.r ?? 0, tok.c ?? 0] : null);
          const t = toks[p++];
          if (t?.t === "comma") continue;
          if (t?.t === "rp") break;
          throw new Error("args");
        }
      } else p++;
      const fn = FNS[tk.v];
      if (!fn) return "#name";
      try {
        return fn(args, card, depth, host, argRefs);
      } catch {
        return "#err";
      }
    }
    throw new Error("primary");
  };

  try {
    const v = parseExpr();
    if (p < toks.length) return "#bad";
    return v;
  } catch {
    return "#bad";
  }
}

/** a range resolves to its cell values, shaped as rows for lookups */
function rangeValues(card: HTMLElement, cells: Array<[number, number]>, depth: number): Scalar[][] {
  const rs = cells.map(([r]) => r);
  const cs = cells.map(([, c]) => c);
  const r0 = Math.min(...rs);
  const c0 = Math.min(...cs);
  const out: Scalar[][] = [];
  for (const [r, c] of cells) {
    const rr = r - r0;
    const cc = c - c0;
    (out[rr] ??= [])[cc] = cellValue(card, r, c, depth);
  }
  for (let i = 0; i < out.length; i++) out[i] ??= [];
  return out;
}

type Fn = (
  args: V[],
  card: HTMLElement,
  depth: number,
  host: [number, number],
  refs?: Array<[number, number] | null>,
) => V;
const num1 = (a: V[], d = 0) => (a.length ? toNum(a[0]) : d);

const FNS: Record<string, Fn> = {
  /* aggregates + stats */
  SUM: (a) => nums(a).reduce((x, y) => x + y, 0),
  SUMSQ: (a) => nums(a).reduce((x, y) => x + y * y, 0),
  PRODUCT: (a) => nums(a).reduce((x, y) => x * y, 1),
  SUMPRODUCT: (a) => {
    const lists = a.map((x) => (Array.isArray(x) ? x.flat() : [x]).map(toNum));
    if (!lists.length || lists[0].length === 0) return 0;
    let s = 0;
    for (let i = 0; i < lists[0].length; i++)
      s += lists.reduce((acc, l) => acc * (isNaN(l[i]) ? 0 : l[i]), 1);
    return s;
  },
  AVERAGE: (a) => {
    const n = nums(a);
    return n.length ? n.reduce((x, y) => x + y, 0) / n.length : "#div0";
  },
  MEDIAN: (a) => {
    const n = nums(a).sort((x, y) => x - y);
    if (!n.length) return "#div0";
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  "MODE.SNGL": (a) => {
    const n = nums(a);
    const f = new Map<number, number>();
    n.forEach((x) => f.set(x, (f.get(x) ?? 0) + 1));
    let best = "#num" as V;
    let bc = 0;
    f.forEach((c, x) => {
      if (c > bc) {
        bc = c;
        best = x;
      }
    });
    return best;
  },
  COUNT: (a) => nums(a).length,
  COUNTA: (a) => flatten(a).filter((v) => v !== "").length,
  COUNTBLANK: (a) => flatten(a).filter((v) => v === "").length,
  MIN: (a) => (nums(a).length ? Math.min(...nums(a)) : 0),
  MAX: (a) => (nums(a).length ? Math.max(...nums(a)) : 0),
  SMALL: (a) => nums([a[0]]).sort((x, y) => x - y)[num1(a.slice(1), 1) - 1] ?? "#num",
  LARGE: (a) => nums([a[0]]).sort((x, y) => y - x)[num1(a.slice(1), 1) - 1] ?? "#num",
  "STDEV.S": (a) => {
    const n = nums(a);
    if (n.length < 2) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return Math.sqrt(n.reduce((x, y) => x + (y - m) ** 2, 0) / (n.length - 1));
  },
  STDEV: (a, c, d, h) => FNS["STDEV.S"](a, c, d, h),
  "STDEV.P": (a) => {
    const n = nums(a);
    if (!n.length) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return Math.sqrt(n.reduce((x, y) => x + (y - m) ** 2, 0) / n.length);
  },
  "VAR.S": (a) => {
    const n = nums(a);
    if (n.length < 2) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return n.reduce((x, y) => x + (y - m) ** 2, 0) / (n.length - 1);
  },
  VAR: (a, c, d, h) => FNS["VAR.S"](a, c, d, h),
  "VAR.P": (a) => {
    const n = nums(a);
    if (!n.length) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return n.reduce((x, y) => x + (y - m) ** 2, 0) / n.length;
  },
  SUBTOTAL: (a, c, d, h) => {
    const code = num1(a);
    const vals = a.slice(1);
    const f =
      code === 1 ? FNS.AVERAGE : code === 2 ? FNS.COUNT : code === 3 ? FNS.COUNTA
      : code === 4 ? FNS.MAX : code === 5 ? FNS.MIN : code === 6 ? FNS.PRODUCT
      : code === 7 ? FNS["STDEV.S"] : code === 8 ? FNS["STDEV.P"]
      : code === 10 ? FNS["VAR.S"] : code === 11 ? FNS["VAR.P"]
      : FNS.SUM;
    return f(vals, c, d, h);
  },
  RANK: (a) => {
    const v = toNum(a[0]);
    const l = nums([a[1]]).sort((x, y) => y - x);
    const i = l.indexOf(v);
    return i < 0 ? "#num" : i + 1;
  },
  "RANK.EQ": (a, c, d, h) => FNS.RANK(a, c, d, h),
  /* criteria aggregates */
  SUMIF: (a) => {
    const range = flatOf(a[0]);
    const crit = scalarOf(a[1]);
    const sum = flatOf(a.length > 2 ? a[2] : a[0]);
    return range.reduce<number>(
      (s, v, i) => (matchCrit(v, crit) ? s + toNum(sum[i] ?? "") : s),
      0,
    );
  },
  SUMIFS: (a) => {
    const sum = flatOf(a[0]);
    const { ranges, crits } = critPairs(a, 1);
    return sum.reduce<number>(
      (s, v, i) =>
        ranges.every((r, j) => matchCrit(r[i] ?? "", crits[j])) ? s + toNum(v) : s,
      0,
    );
  },
  COUNTIF: (a) => flatOf(a[0]).filter((v) => matchCrit(v, scalarOf(a[1]))).length,
  COUNTIFS: (a) => {
    const { ranges, crits } = critPairs(a, 0);
    return (ranges[0] ?? []).filter((_, i) =>
      ranges.every((r, j) => matchCrit(r[i] ?? "", crits[j])),
    ).length;
  },
  AVERAGEIF: (a) => {
    const range = flatOf(a[0]);
    const crit = scalarOf(a[1]);
    const pool = flatOf(a.length > 2 ? a[2] : a[0]);
    const hit = range
      .map((v, i) => (matchCrit(v, crit) ? toNum(pool[i] ?? "") : NaN))
      .filter((n) => !isNaN(n));
    return hit.length ? hit.reduce((x, y) => x + y, 0) / hit.length : "#div0";
  },
  AVERAGEIFS: (a) => {
    const pool = flatOf(a[0]);
    const { ranges, crits } = critPairs(a, 1);
    const hit = pool
      .map((v, i) => (ranges.every((r, j) => matchCrit(r[i] ?? "", crits[j])) ? toNum(v) : NaN))
      .filter((n) => !isNaN(n));
    return hit.length ? hit.reduce((x, y) => x + y, 0) / hit.length : "#div0";
  },
  /* logical */
  IF: (a) => (toBool(a[0]) ? a[1] ?? true : a[2] ?? false),
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (toBool(a[i])) return a[i + 1];
    return "#na";
  },
  AND: (a) => flatten(a).every(toBool),
  OR: (a) => flatten(a).some(toBool),
  NOT: (a) => !toBool(a[0]),
  XOR: (a) => flatten(a).filter(toBool).length % 2 === 1,
  TRUE: () => true,
  FALSE: () => false,
  IFERROR: (a) => (typeof a[0] === "string" && a[0].startsWith("#") ? a[1] ?? "" : a[0]),
  IFNA: (a) => (a[0] === "#na" ? a[1] ?? "" : a[0]),
  SWITCH: (a) => {
    const v = scalarOf(a[0]);
    for (let i = 1; i + 1 < a.length; i += 2)
      if (cmp2(v, scalarOf(a[i]), "=")) return a[i + 1];
    return a.length % 2 === 0 ? a[a.length - 1] : "#na";
  },
  /* math */
  ABS: (a) => Math.abs(toNum(a[0])),
  SIGN: (a) => Math.sign(toNum(a[0])),
  INT: (a) => Math.floor(toNum(a[0])),
  TRUNC: (a) => Math.trunc(toNum(a[0])),
  ROUND: (a) => {
    const d = num1(a.slice(1));
    const m = Math.pow(10, d);
    return Math.round(toNum(a[0]) * m) / m;
  },
  ROUNDDOWN: (a) => {
    const m = Math.pow(10, num1(a.slice(1)));
    return (Math.sign(toNum(a[0])) * Math.floor(Math.abs(toNum(a[0])) * m)) / m;
  },
  ROUNDUP: (a) => {
    const m = Math.pow(10, num1(a.slice(1)));
    return (Math.sign(toNum(a[0])) * Math.ceil(Math.abs(toNum(a[0])) * m)) / m;
  },
  CEILING: (a) => {
    const s = num1(a.slice(1), 1);
    return Math.ceil(toNum(a[0]) / s) * s;
  },
  FLOOR: (a) => {
    const s = num1(a.slice(1), 1);
    return Math.floor(toNum(a[0]) / s) * s;
  },
  MROUND: (a) => Math.round(toNum(a[0]) / toNum(a[1])) * toNum(a[1]),
  EVEN: (a) => {
    const n = Math.ceil(Math.abs(toNum(a[0])));
    return (n % 2 ? n + 1 : n) * Math.sign(toNum(a[0]) || 1);
  },
  ODD: (a) => {
    const n = Math.ceil(Math.abs(toNum(a[0])));
    return (n % 2 ? n : n + 1) * Math.sign(toNum(a[0]) || 1);
  },
  MOD: (a) => {
    const y = toNum(a[1]);
    return y === 0 ? "#div0" : toNum(a[0]) % y;
  },
  QUOTIENT: (a) => {
    const y = toNum(a[1]);
    return y === 0 ? "#div0" : Math.trunc(toNum(a[0]) / y);
  },
  POWER: (a) => Math.pow(toNum(a[0]), toNum(a[1])),
  SQRT: (a) => {
    const n = toNum(a[0]);
    return n < 0 ? "#num" : Math.sqrt(n);
  },
  EXP: (a) => Math.exp(toNum(a[0])),
  LN: (a) => Math.log(toNum(a[0])),
  LOG: (a) => Math.log(toNum(a[0])) / Math.log(num1(a.slice(1), 10)),
  LOG10: (a) => Math.log10(toNum(a[0])),
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (a) =>
    Math.floor(Math.random() * (toNum(a[1]) - toNum(a[0]) + 1)) + toNum(a[0]),
  GCD: (a) => {
    const g = (x: number, y: number): number => (y === 0 ? Math.abs(x) : g(y, x % y));
    return nums(a).reduce(g, 0);
  },
  LCM: (a) => {
    const g = (x: number, y: number): number => (y === 0 ? Math.abs(x) : g(y, x % y));
    return nums(a).reduce((x, y) => Math.abs(x * y) / g(x, y), 1);
  },
  FACT: (a) => {
    let n = Math.floor(toNum(a[0]));
    let r = 1;
    while (n > 1) r *= n--;
    return r;
  },
  COMBIN: (a) => {
    const f = (n: number) => {
      let r = 1;
      while (n > 1) r *= n--;
      return r;
    };
    const n = Math.floor(toNum(a[0]));
    const k = Math.floor(toNum(a[1]));
    return n < 0 || k < 0 || k > n ? "#num" : f(n) / (f(k) * f(n - k));
  },
  DEGREES: (a) => (toNum(a[0]) * 180) / Math.PI,
  RADIANS: (a) => (toNum(a[0]) * Math.PI) / 180,
  SIN: (a) => Math.sin(toNum(a[0])),
  COS: (a) => Math.cos(toNum(a[0])),
  TAN: (a) => Math.tan(toNum(a[0])),
};

/* ---------- text ---------- */
Object.assign(FNS, {
  CONCAT: (a) => flatten(a).map(toStr).join(""),
  CONCATENATE: (a) => flatten(a).map(toStr).join(""),
  TEXTJOIN: (a) => {
    const delim = toStr(scalarOf(a[0]));
    const skipEmpty = toBool(a[1]);
    return flatten(a.slice(2))
      .map(toStr)
      .filter((s) => !skipEmpty || s !== "")
      .join(delim);
  },
  LEFT: (a) => toStr(scalarOf(a[0])).slice(0, num1(a.slice(1), 1)),
  RIGHT: (a) => toStr(scalarOf(a[0])).slice(-num1(a.slice(1), 1)),
  MID: (a) =>
    toStr(scalarOf(a[0])).slice(toNum(a[1]) - 1, toNum(a[1]) - 1 + toNum(a[2])),
  LEN: (a) => toStr(scalarOf(a[0])).length,
  LOWER: (a) => toStr(scalarOf(a[0])).toLowerCase(),
  UPPER: (a) => toStr(scalarOf(a[0])).toUpperCase(),
  PROPER: (a) =>
    toStr(scalarOf(a[0]))
      .toLowerCase()
      .replace(/(^|[^a-zA-Z'])[a-z]/g, (m) => m.toUpperCase()),
  TRIM: (a) => toStr(scalarOf(a[0])).trim().replace(/\s+/g, " "),
  CLEAN: (a) => Array.from(toStr(scalarOf(a[0]))).filter((ch) => ch.charCodeAt(0) >= 32).join(""),
  SUBSTITUTE: (a) => {
    const text = toStr(scalarOf(a[0]));
    const from = toStr(scalarOf(a[1]));
    const to = toStr(scalarOf(a[2]));
    if (from === "") return text;
    if (a.length > 3) {
      const n = toNum(a[3]);
      let i = -1;
      let pos = 0;
      for (let k = 0; k < n; k++) {
        i = text.indexOf(from, pos);
        if (i < 0) return text;
        pos = i + from.length;
      }
      return text.slice(0, i) + to + text.slice(i + from.length);
    }
    return text.split(from).join(to);
  },
  REPLACE: (a) => {
    const text = toStr(scalarOf(a[0]));
    const start = toNum(a[1]) - 1;
    return text.slice(0, start) + toStr(scalarOf(a[3])) + text.slice(start + toNum(a[2]));
  },
  FIND: (a) => {
    const i = toStr(scalarOf(a[1])).indexOf(toStr(scalarOf(a[0])), num1(a.slice(2), 1) - 1);
    return i < 0 ? "#value" : i + 1;
  },
  SEARCH: (a) => {
    const i = toStr(scalarOf(a[1]))
      .toLowerCase()
      .indexOf(toStr(scalarOf(a[0])).toLowerCase(), num1(a.slice(2), 1) - 1);
    return i < 0 ? "#value" : i + 1;
  },
  REPT: (a) => toStr(scalarOf(a[0])).repeat(Math.max(0, toNum(a[1]))),
  EXACT: (a) => toStr(scalarOf(a[0])) === toStr(scalarOf(a[1])),
  TEXT: (a) => {
    const v = scalarOf(a[0]);
    const f = toStr(scalarOf(a[1]));
    if (typeof v !== "number") return toStr(v);
    if (/0\.0+%/.test(f)) {
      const d = Math.max(0, (f.split(".")[1] ?? "").replace(/[^0]/g, "").length);
      return `${(v * 100).toFixed(d)}%`;
    }
    const d = f.includes(".") ? (f.split(".")[1] ?? "").replace(/[^0#]/g, "").length : 0;
    let s = v.toFixed(d);
    if (f.includes(",")) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return s;
  },
  FIXED: (a) => toNum(a[0]).toFixed(Math.max(0, num1(a.slice(1), 2))),
  VALUE: (a) => {
    const n = toNum(a[0]);
    return isNaN(n) ? "#value" : n;
  },
  NUMBERVALUE: (a) => {
    const n = toNum(a[0]);
    return isNaN(n) ? "#value" : n;
  },
  T: (a) => (typeof scalarOf(a[0]) === "string" ? scalarOf(a[0]) : ""),
  N: (a) => {
    const n = toNum(a[0]);
    return isNaN(n) ? 0 : n;
  },
  CHAR: (a) => String.fromCharCode(toNum(a[0])),
  UNICHAR: (a) => String.fromCharCode(toNum(a[0])),
  CODE: (a) => toStr(scalarOf(a[0])).charCodeAt(0) || "#value",
  UNICODE: (a) => toStr(scalarOf(a[0])).charCodeAt(0) || "#value",
  DOLLAR: (a) =>
    "$" +
    toNum(a[0])
      .toFixed(Math.max(0, num1(a.slice(1), 2)))
      .replace(/\B(?=(\d{3})+(?!\d))/g, ","),
} satisfies Record<string, Fn>);

/* ---------- lookup ---------- */
Object.assign(FNS, {
  VLOOKUP: (a) => {
    const key = scalarOf(a[0]);
    const table = Array.isArray(a[1]) ? a[1] : [[scalarOf(a[1])]];
    const col = toNum(a[2]) - 1;
    const approx = a.length < 4 || toBool(a[3]);
    let best: Scalar[] | null = null;
    for (const row of table) {
      if (cmp2(row[0] ?? "", key, "=")) return row[col] ?? "#na";
      if (approx && typeof row[0] === "number" && typeof key === "number" && row[0] <= key)
        if (!best || (best[0] as number) < row[0]) best = row;
    }
    return approx && best ? best[col] ?? "#na" : "#na";
  },
  HLOOKUP: (a) => {
    const key = scalarOf(a[0]);
    const table = Array.isArray(a[1]) ? a[1] : [[scalarOf(a[1])]];
    const row = toNum(a[2]) - 1;
    const first = table[0] ?? [];
    for (let c = 0; c < first.length; c++)
      if (cmp2(first[c] ?? "", key, "=")) return table[row]?.[c] ?? "#na";
    return "#na";
  },
  INDEX: (a) => {
    const table = Array.isArray(a[0]) ? a[0] : [[scalarOf(a[0])]];
    const r = toNum(a[1]) - 1;
    const c = a.length > 2 ? toNum(a[2]) - 1 : 0;
    return table[r]?.[c] ?? "#ref";
  },
  MATCH: (a) => {
    const key = scalarOf(a[0]);
    const list = (Array.isArray(a[1]) ? a[1] : [[scalarOf(a[1])]])
      .map((row) => (Array.isArray(row) && row.length === 1 ? row[0] : row))
      .flat()
      .map((v, i) => ({ v, i }));
    const type = a.length > 2 ? toNum(a[2]) : 1;
    if (type === 0) {
      const hit = list.find((x) => cmp2(x.v ?? "", key, "="));
      return hit ? hit.i + 1 : "#na";
    }
    let best = -1;
    for (const { v, i } of list)
      if (typeof v === "number" && typeof key === "number" && (type > 0 ? v <= key : v >= key))
        best = i;
    return best < 0 ? "#na" : best + 1;
  },
  XMATCH: (a, c, d, h) => FNS.MATCH([a[0], a[1], a[2] ?? 0], c, d, h),
  XLOOKUP: (a) => {
    const key = scalarOf(a[0]);
    const look = (Array.isArray(a[1]) ? a[1] : [[scalarOf(a[1])]]).flat();
    const ret = (Array.isArray(a[2]) ? a[2] : [[scalarOf(a[2])]]).flat();
    for (let i = 0; i < look.length; i++)
      if (cmp2(look[i] ?? "", key, "=")) return ret[i] ?? "#na";
    return a.length > 3 ? a[3] : "#na";
  },
  CHOOSE: (a) => {
    const n = Math.floor(toNum(a[0]));
    return n >= 1 && n < a.length ? a[n] : "#value";
  },
} satisfies Record<string, Fn>);

/* ---------- dates ---------- */
Object.assign(FNS, {
  TODAY: () => dateStr(new Date()),
  NOW: () => {
    const d = new Date();
    return `${dateStr(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },
  DATE: (a) => {
    const d = new Date(toNum(a[0]), toNum(a[1]) - 1, toNum(a[2]));
    return isNaN(d.getTime()) ? "#num" : dateStr(d);
  },
  DATEVALUE: (a) => {
    const d = asDate(scalarOf(a[0]));
    return d ? serial(d) : "#value";
  },
  YEAR: (a) => asDate(scalarOf(a[0]))?.getFullYear() ?? "#value",
  MONTH: (a) => (asDate(scalarOf(a[0])) ? asDate(scalarOf(a[0]))!.getMonth() + 1 : "#value"),
  DAY: (a) => asDate(scalarOf(a[0]))?.getDate() ?? "#value",
  HOUR: (a) => asDate(scalarOf(a[0]))?.getHours() ?? "#value",
  MINUTE: (a) => asDate(scalarOf(a[0]))?.getMinutes() ?? "#value",
  SECOND: (a) => asDate(scalarOf(a[0]))?.getSeconds() ?? "#value",
  WEEKDAY: (a) => {
    const d = asDate(scalarOf(a[0]));
    return d ? d.getDay() + 1 : "#value";
  },
  DAYS: (a) => {
    const e = asDate(scalarOf(a[0]));
    const s = asDate(scalarOf(a[1]));
    return e && s ? Math.round((e.getTime() - s.getTime()) / DAY_MS) : "#value";
  },
  DATEDIF: (a) => {
    const s = asDate(scalarOf(a[0]));
    const e = asDate(scalarOf(a[1]));
    const u = toStr(scalarOf(a[2])).toUpperCase();
    if (!s || !e || e < s) return "#num";
    if (u === "D") return Math.round((e.getTime() - s.getTime()) / DAY_MS);
    if (u === "M") return (e.getFullYear() - s.getFullYear()) * 12 + e.getMonth() - s.getMonth();
    if (u === "Y") {
      let y = e.getFullYear() - s.getFullYear();
      if (e.getMonth() < s.getMonth() || (e.getMonth() === s.getMonth() && e.getDate() < s.getDate())) y--;
      return y;
    }
    return "#num";
  },
  EDATE: (a) => {
    const d = asDate(scalarOf(a[0]));
    if (!d) return "#value";
    d.setMonth(d.getMonth() + toNum(a[1]));
    return dateStr(d);
  },
  EOMONTH: (a) => {
    const d = asDate(scalarOf(a[0]));
    if (!d) return "#value";
    d.setMonth(d.getMonth() + toNum(a[1]) + 1, 0);
    return dateStr(d);
  },
  WORKDAY: (a) => {
    const d = asDate(scalarOf(a[0]));
    if (!d) return "#value";
    let n = toNum(a[1]);
    const step = n >= 0 ? 1 : -1;
    while (n !== 0) {
      d.setDate(d.getDate() + step);
      if (d.getDay() !== 0 && d.getDay() !== 6) n -= step;
    }
    return dateStr(d);
  },
  NETWORKDAYS: (a) => {
    const s = asDate(scalarOf(a[0]));
    const e = asDate(scalarOf(a[1]));
    if (!s || !e) return "#value";
    const d = new Date(s);
    let n = 0;
    while (d <= e) {
      if (d.getDay() !== 0 && d.getDay() !== 6) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  },
  YEARFRAC: (a) => {
    const s = asDate(scalarOf(a[0]));
    const e = asDate(scalarOf(a[1]));
    return s && e ? (e.getTime() - s.getTime()) / (365 * DAY_MS) : "#value";
  },
} satisfies Record<string, Fn>);

/* ---------- info ---------- */
Object.assign(FNS, {
  ISNUMBER: (a) => typeof scalarOf(a[0]) === "number",
  ISTEXT: (a) => typeof scalarOf(a[0]) === "string" && !String(scalarOf(a[0])).startsWith("#"),
  ISNONTEXT: (a) => typeof scalarOf(a[0]) !== "string",
  ISBLANK: (a) => scalarOf(a[0]) === "",
  ISLOGICAL: (a) => typeof scalarOf(a[0]) === "boolean",
  ISERROR: (a) => typeof scalarOf(a[0]) === "string" && String(scalarOf(a[0])).startsWith("#"),
  ISERR: (a) => {
    const v = scalarOf(a[0]);
    return typeof v === "string" && v.startsWith("#") && v !== "#na";
  },
  ISNA: (a) => scalarOf(a[0]) === "#na",
  ISEVEN: (a) => Math.floor(toNum(a[0])) % 2 === 0,
  ISODD: (a) => Math.floor(toNum(a[0])) % 2 !== 0,
  NA: () => "#na",
  MINIFS: (a) => {
    const pool = flatOf(a[0]);
    const { ranges, crits } = critPairs(a, 1);
    const hits = pool
      .map((v, i) => (ranges.every((r, j) => matchCrit(r[i] ?? "", crits[j])) ? toNum(v) : NaN))
      .filter((n) => !isNaN(n));
    return hits.length ? Math.min(...hits) : 0;
  },
  MAXIFS: (a) => {
    const pool = flatOf(a[0]);
    const { ranges, crits } = critPairs(a, 1);
    const hits = pool
      .map((v, i) => (ranges.every((r, j) => matchCrit(r[i] ?? "", crits[j])) ? toNum(v) : NaN))
      .filter((n) => !isNaN(n));
    return hits.length ? Math.max(...hits) : 0;
  },
} satisfies Record<string, Fn>);


/* ---------- host-aware + reference ---------- */
Object.assign(FNS, {
  ROW: (_a, _c, _d, host, refs) => (refs?.[0] ? refs[0][0] : host[0]) + 1,
  COLUMN: (_a, _c, _d, host, refs) => (refs?.[0] ? refs[0][1] : host[1]) + 1,
  FORMULATEXT: (a, card, _d, _h, refs) => {
    // FORMULATEXT(B2) — the referenced cell's raw formula, if it has one
    const rc = refs?.[0] ?? refRC(toStr(scalarOf(a[0])).replace(/\$/g, ""));
    if (!rc) return "#na";
    const raw = rawAt(card, rc[0], rc[1]);
    return raw.startsWith("=") ? raw : "#na";
  },
  // ISFORMULA(B2) — a real ref position when the arg was bare, else the
  // string form ("B2") still reaches the referenced cell's raw
  ISFORMULA: (a, card, _d, _h, refs) => {
    const rc = refs?.[0] ?? refRC(toStr(scalarOf(a[0])).replace(/\$/g, ""));
    return rc ? (rawAt(card, rc[0], rc[1]) ?? "").startsWith("=") : false;
  },
  SHEET: (_a, card) => card.dataset.topic ?? "sheet",
  SHEETS: () => document.querySelectorAll(".sheet-card").length,
  ADDRESS: (a) => {
    const r = toNum(a[0]);
    const c = toNum(a[1]);
    // abs_num: 1=$C$2 (default) 2=C$2 3=$C2 4=C2
    const mode = a.length > 2 ? toNum(a[2]) : 1;
    let s = "";
    let cc = c;
    while (cc > 0) {
      s = String.fromCharCode(64 + ((cc - 1) % 26) + 1) + s;
      cc = Math.floor((cc - 1) / 26);
    }
    const cd = mode === 1 || mode === 3 ? "$" : "";
    const rd = mode === 1 || mode === 2 ? "$" : "";
    return `${cd}${s}${rd}${r}`;
  },
  INDIRECT: (a, card, depth) => {
    const rc = refRC(toStr(scalarOf(a[0])).replace(/\$/g, ""));
    return rc ? cellValue(card, rc[0], rc[1], depth) : "#ref";
  },
  OFFSET: (a, card, depth, _h, refs) => {
    // OFFSET(A1, r, c) — the anchor can be a bare ref (provenance) or a
    // quoted "A1"; rows/cols offset it, optional height/width widen it
    const v = scalarOf(a[0]);
    const rc =
      refs?.[0] ?? (typeof v === "string" ? refRC(v.replace(/\$/g, "")) : null);
    if (!rc) return "#ref";
    const r = rc[0] + toNum(a[1]);
    const c = rc[1] + toNum(a[2]);
    if (a.length > 3 || a.length > 4) {
      const h = Math.max(1, a.length > 3 ? toNum(a[3]) : 1);
      const w = Math.max(1, a.length > 4 ? toNum(a[4]) : 1);
      const out: Scalar[][] = [];
      for (let i = 0; i < h; i++) {
        out[i] = [];
        for (let j = 0; j < w; j++) out[i][j] = cellValue(card, r + i, c + j, depth);
      }
      return out;
    }
    return cellValue(card, r, c, depth);
  },
} satisfies Record<string, Fn>);

/* ---------- financial ---------- */
Object.assign(FNS, {
  PMT: (a) => {
    const r = toNum(a[0]);
    const n = toNum(a[1]);
    const pv = toNum(a[2]);
    const fv = a.length > 3 ? toNum(a[3]) : 0;
    if (r === 0) return -(pv + fv) / n;
    const g = Math.pow(1 + r, n);
    return (-r * (pv * g + fv)) / (g - 1);
  },
  FV: (a) => {
    const r = toNum(a[0]);
    const n = toNum(a[1]);
    const p = a.length > 2 ? toNum(a[2]) : 0;
    const pv = a.length > 3 ? toNum(a[3]) : 0;
    if (r === 0) return -(pv + p * n);
    return -(pv * Math.pow(1 + r, n) + (p * (Math.pow(1 + r, n) - 1)) / r);
  },
  PV: (a) => {
    const r = toNum(a[0]);
    const n = toNum(a[1]);
    const p = a.length > 2 ? toNum(a[2]) : 0;
    const fv = a.length > 3 ? toNum(a[3]) : 0;
    if (r === 0) return -(fv + p * n);
    return (-(fv + (p * (Math.pow(1 + r, n) - 1)) / r)) / Math.pow(1 + r, n);
  },
  NPER: (a) => {
    const r = toNum(a[0]);
    const p = toNum(a[1]);
    const pv = toNum(a[2]);
    const fv = a.length > 3 ? toNum(a[3]) : 0;
    if (r === 0) return p === 0 ? "#num" : -(pv + fv) / p;
    const num = Math.log((p - fv * r) / (pv * r + p));
    return num / Math.log(1 + r);
  },
  RATE: (a) => {
    const n = toNum(a[0]);
    const p = toNum(a[1]);
    const pv = toNum(a[2]);
    const fv = a.length > 3 ? toNum(a[3]) : 0;
    let r = 0.1;
    for (let i = 0; i < 50; i++) {
      const f = pv * Math.pow(1 + r, n) + (p * (Math.pow(1 + r, n) - 1)) / r + fv;
      const df =
        n * pv * Math.pow(1 + r, n - 1) +
        (p * (n * Math.pow(1 + r, n - 1) * r - (Math.pow(1 + r, n) - 1))) / (r * r);
      if (Math.abs(df) < 1e-12) break;
      const nr = r - f / df;
      if (Math.abs(nr - r) < 1e-9) {
        r = nr;
        break;
      }
      r = nr;
    }
    return isFinite(r) ? r : "#num";
  },
  NPV: (a) => {
    const r = toNum(a[0]);
    return nums(a.slice(1)).reduce((s, v, i) => s + v / Math.pow(1 + r, i + 1), 0);
  },
  IRR: (a) => {
    // IRR(values, [guess]) — the guess must NOT fold into the cash flows
    const vs = nums([a[0]]);
    const f = (r: number) => vs.reduce((s, v, i) => s + v / Math.pow(1 + r, i), 0);
    let r = a.length > 1 ? toNum(a[1]) : 0.1;
    for (let i = 0; i < 100; i++) {
      const h = 1e-7;
      const df = (f(r + h) - f(r - h)) / (2 * h);
      if (Math.abs(df) < 1e-12) break;
      const nr = r - f(r) / df;
      if (Math.abs(nr - r) < 1e-9) {
        r = nr;
        break;
      }
      r = nr;
    }
    return isFinite(r) && Math.abs(f(r)) < 1e-4 ? r : "#num";
  },
} satisfies Record<string, Fn>);

/* ---------- regression + distribution stats ---------- */
const pairs = (a: V[]): Array<[number, number]> => {
  const xs = nums([a[0]]);
  const ys = nums([a[1]]);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) out.push([xs[i], ys[i]]);
  return out;
};
const linreg = (a: V[]) => {
  const xy = pairs(a);
  const n = xy.length;
  if (n < 2) return null;
  const mx = xy.reduce((s, p) => s + p[0], 0) / n;
  const my = xy.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of xy) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  return { mx, my, sxx, sxy, syy, n };
};
Object.assign(FNS, {
  CORREL: (a) => {
    const r = linreg(a);
    return r && r.sxx > 0 && r.syy > 0 ? r.sxy / Math.sqrt(r.sxx * r.syy) : "#div0";
  },
  PEARSON: (a, c, d, h) => FNS.CORREL(a, c, d, h),
  RSQ: (a) => {
    const r = FNS.CORREL(a, null as never, 0, [0, 0]);
    return typeof r === "number" ? r * r : r;
  },
  SLOPE: (a) => {
    // SLOPE(known_ys, known_xs) — linreg wants [xs, ys], so swap
    const r = linreg([a[1], a[0]]);
    return r && r.sxx > 0 ? r.sxy / r.sxx : "#div0";
  },
  INTERCEPT: (a) => {
    const r = linreg([a[1], a[0]]);
    return r && r.sxx > 0 ? r.my - (r.sxy / r.sxx) * r.mx : "#div0";
  },
  FORECAST: (a) => {
    // FORECAST(x, known_ys, known_xs) — linear regression prediction
    const r = linreg([a[2] ?? a[1], a[1]]);
    return r && r.sxx > 0 ? r.my + (r.sxy / r.sxx) * (toNum(a[0]) - r.mx) : "#div0";
  },
  "FORECAST.LINEAR": (a, c, d, h) => FNS.FORECAST(a, c, d, h),
  "COVARIANCE.P": (a) => {
    const xy = pairs(a);
    const n = xy.length;
    if (!n) return "#div0";
    const mx = xy.reduce((s, p) => s + p[0], 0) / n;
    const my = xy.reduce((s, p) => s + p[1], 0) / n;
    return xy.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / n;
  },
  "COVARIANCE.S": (a) => {
    const xy = pairs(a);
    const n = xy.length;
    if (n < 2) return "#div0";
    const mx = xy.reduce((s, p) => s + p[0], 0) / n;
    const my = xy.reduce((s, p) => s + p[1], 0) / n;
    return xy.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / (n - 1);
  },
  GEOMEAN: (a) => {
    const n = nums(a);
    return n.length && n.every((x) => x > 0)
      ? Math.pow(n.reduce((x, y) => x * y, 1), 1 / n.length)
      : "#num";
  },
  HARMEAN: (a) => {
    const n = nums(a);
    return n.length && n.every((x) => x !== 0)
      ? n.length / n.reduce((x, y) => x + 1 / y, 0)
      : "#num";
  },
  AVEDEV: (a) => {
    const n = nums(a);
    if (!n.length) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return n.reduce((x, y) => x + Math.abs(y - m), 0) / n.length;
  },
  DEVSQ: (a) => {
    const n = nums(a);
    if (!n.length) return "#div0";
    const m = n.reduce((x, y) => x + y, 0) / n.length;
    return n.reduce((x, y) => x + (y - m) ** 2, 0);
  },
  "PERCENTILE.INC": (a) => {
    const n = nums([a[0]]).sort((x, y) => x - y);
    if (!n.length) return "#num";
    const k = toNum(a[1]);
    const pos = k * (n.length - 1);
    const lo = Math.floor(pos);
    return n[lo] + (n[lo + 1] !== undefined ? (n[lo + 1] - n[lo]) * (pos - lo) : 0);
  },
  PERCENTILE: (a, c, d, h) => FNS["PERCENTILE.INC"](a, c, d, h),
  "QUARTILE.INC": (a) => FNS["PERCENTILE.INC"]([a[0], toNum(a[1]) / 4], null as never, 0, [0, 0]),
  QUARTILE: (a, c, d, h) => FNS["QUARTILE.INC"](a, c, d, h),
  "PERCENTRANK.INC": (a) => {
    const n = nums([a[0]]).sort((x, y) => x - y);
    const x = toNum(a[1]);
    if (!n.length || x < n[0] || x > n[n.length - 1]) return "#na";
    const i = n.findIndex((v) => v === x);
    if (i >= 0) return i / (n.length - 1);
    const j = n.findIndex((v) => v > x);
    return (j - 1 + (x - n[j - 1]) / (n[j] - n[j - 1])) / (n.length - 1);
  },
  STANDARDIZE: (a) => {
    const m = toNum(a[1]);
    const sd = toNum(a[2]);
    return sd === 0 ? "#div0" : (toNum(a[0]) - m) / sd;
  },
  "NORM.S.DIST": (a) => {
    const z = toNum(a[0]);
    const cum = a.length < 2 || toBool(a[1]);
    const pdf = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
    if (!cum) return pdf;
    // Abramowitz–Stegun 26.2.17 — Φ(z) accurate to ~1e-7
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const tail =
      pdf *
      t *
      (0.31938153 +
        t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - tail : tail;
  },
  "NORM.DIST": (a) => {
    const z = (toNum(a[0]) - toNum(a[1])) / toNum(a[2]);
    return FNS["NORM.S.DIST"]([z, a[3]], null as never, 0, [0, 0]);
  },
  "CONFIDENCE.NORM": (a) => {
    const alpha = toNum(a[0]);
    const sd = toNum(a[1]);
    const n = toNum(a[2]);
    // NORMSINV via A&S 26.2.23 — accurate to ~4.5e-4
    const p = Math.min(0.9999999, Math.max(0.0000001, 1 - alpha / 2));
    const lo = p <= 0.5;
    const q = lo ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(q));
    const z =
      t -
      (2.515517 + 0.802853 * t + 0.010328 * t * t) /
        (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
    return (Math.abs(z) * sd) / Math.sqrt(n);
  },
} satisfies Record<string, Fn>);

/* ---------- more math + base conversions ---------- */
Object.assign(FNS, {
  BASE: (a) => {
    const radix = toNum(a[1]);
    if (radix < 2 || radix > 36) return "#num";
    let s = Math.floor(toNum(a[0])).toString(radix).toUpperCase();
    if (a.length > 2) s = s.padStart(toNum(a[2]), "0");
    return s;
  },
  DECIMAL: (a) => {
    const n = parseInt(toStr(scalarOf(a[0])), toNum(a[1]));
    return isNaN(n) ? "#num" : n;
  },
  ARABIC: (a) => {
    const m: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const s = toStr(scalarOf(a[0])).toUpperCase();
    let t = 0;
    for (let i = 0; i < s.length; i++) {
      const v = m[s[i]];
      if (v === undefined) return "#value";
      t += v < (m[s[i + 1]] ?? 0) ? -v : v;
    }
    return t;
  },
  ROMAN: (a) => {
    let n = Math.floor(toNum(a[0]));
    if (n <= 0 || n > 3999) return "#value";
    const map: Array<[number, string]> = [
      [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
      [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
    ];
    let s = "";
    for (const [v, sym] of map) while (n >= v) {
      s += sym;
      n -= v;
    }
    return s;
  },
  SUMX2MY2: (a) => {
    const xs = nums([a[0]]);
    const ys = nums([a[1]]);
    return xs.reduce((s, x, i) => s + x * x - (ys[i] ?? 0) ** 2, 0);
  },
  SUMX2PY2: (a) => {
    const xs = nums([a[0]]);
    const ys = nums([a[1]]);
    return xs.reduce((s, x, i) => s + x * x + (ys[i] ?? 0) ** 2, 0);
  },
  SUMXMY2: (a) => {
    const xs = nums([a[0]]);
    const ys = nums([a[1]]);
    return xs.reduce((s, x, i) => s + (x - (ys[i] ?? 0)) ** 2, 0);
  },
  FACTDOUBLE: (a) => {
    let n = Math.floor(toNum(a[0]));
    let r = 1;
    while (n > 1) {
      r *= n;
      n -= 2;
    }
    return r;
  },
  MULTINOMIAL: (a) => {
    const f = (n: number) => {
      let r = 1;
      while (n > 1) r *= n--;
      return r;
    };
    const ns = nums(a);
    return f(ns.reduce((x, y) => x + y, 0)) / ns.reduce((x, y) => x * f(y), 1);
  },
  SERIESSUM: (a) => {
    const x = toNum(a[0]);
    const n = toNum(a[1]);
    const m = toNum(a[2]);
    const coefs = nums(a.slice(3));
    return coefs.reduce((s, c, i) => s + c * Math.pow(x, n + i * m), 0);
  },
  ACOSH: (a) => Math.log(toNum(a[0]) + Math.sqrt(toNum(a[0]) ** 2 - 1)),
  ASINH: (a) => Math.log(toNum(a[0]) + Math.sqrt(toNum(a[0]) ** 2 + 1)),
  ATANH: (a) => 0.5 * Math.log((1 + toNum(a[0])) / (1 - toNum(a[0]))),
  ASIN: (a) => Math.asin(toNum(a[0])),
  ACOS: (a) => Math.acos(toNum(a[0])),
  ATAN: (a) => Math.atan(toNum(a[0])),
  ATAN2: (a) => Math.atan2(toNum(a[1]), toNum(a[0])),
  SINH: (a) => Math.sinh(toNum(a[0])),
  COSH: (a) => Math.cosh(toNum(a[0])),
  TANH: (a) => Math.tanh(toNum(a[0])),
  SEC: (a) => 1 / Math.cos(toNum(a[0])),
  CSC: (a) => 1 / Math.sin(toNum(a[0])),
  COT: (a) => 1 / Math.tan(toNum(a[0])),
} satisfies Record<string, Fn>);

/* ---------- more text + info ---------- */
Object.assign(FNS, {
  TEXTBEFORE: (a) => {
    const s = toStr(scalarOf(a[0]));
    const d = toStr(scalarOf(a[1]));
    const i = s.indexOf(d);
    return i < 0 ? "#na" : s.slice(0, i);
  },
  TEXTAFTER: (a) => {
    const s = toStr(scalarOf(a[0]));
    const d = toStr(scalarOf(a[1]));
    const i = s.indexOf(d);
    return i < 0 ? "#na" : s.slice(i + d.length);
  },
  VALUETOTEXT: (a) => toStr(scalarOf(a[0])),
  ARRAYTOTEXT: (a) => flatten(a).map(toStr).join(", "),
  TEXTSPLIT: (a) => {
    const s = toStr(scalarOf(a[0]));
    const d = toStr(scalarOf(a[1]));
    return [s.split(d)];
  },
  TYPE: (a) => {
    const v = scalarOf(a[0]);
    if (typeof v === "number") return 1;
    if (typeof v === "boolean") return 4;
    return typeof v === "string" && v.startsWith("#") ? 16 : 2;
  },
  "ERROR.TYPE": (a) => {
    const v = scalarOf(a[0]);
    if (typeof v !== "string" || !v.startsWith("#")) return "#na";
    return v === "#na" ? 7 : v === "#div0" ? 2 : v === "#value" ? 3 : v === "#ref" ? 4 : v === "#name" ? 5 : 6;
  },
  WEEKNUM: (a) => {
    const d = asDate(scalarOf(a[0]));
    if (!d) return "#value";
    const start = new Date(d.getFullYear(), 0, 1);
    return Math.floor(((d.getTime() - start.getTime()) / DAY_MS + start.getDay()) / 7) + 1;
  },
  ISOWEEKNUM: (a) => {
    const d = asDate(scalarOf(a[0]));
    if (!d) return "#value";
    const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
    const jan1 = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    return Math.ceil(((day.getTime() - jan1.getTime()) / DAY_MS + 1) / 7);
  },
  DAYS360: (a) => {
    const s = asDate(scalarOf(a[0]));
    const e = asDate(scalarOf(a[1]));
    if (!s || !e) return "#value";
    return (e.getFullYear() - s.getFullYear()) * 360 + (e.getMonth() - s.getMonth()) * 30 + Math.min(30, e.getDate()) - Math.min(30, s.getDate());
  },
  TIME: (a) => {
    const h = toNum(a[0]);
    const m = toNum(a[1]);
    const s = toNum(a[2]);
    return `${String(Math.floor((h + m / 60 + s / 3600) % 24)).padStart(2, "0")}:${String(Math.floor((m + s / 60) % 60)).padStart(2, "0")}`;
  },
  TIMEVALUE: (a) => {
    const m = toStr(scalarOf(a[0])).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) / 86400 : "#value";
  },
} satisfies Record<string, Fn>);


/* ---------- wave 3: arrays, depreciation, dates-with-irregular flows,
 *  distributions, engineering, database ---------- */

/* dynamic array helpers — a V[][] is a first-class value already; these
 *  spill only inside other functions (INDEX/SUM/TRANSPOSE composition) */
Object.assign(FNS, {
  TRANSPOSE: (a) => {
    const m = (Array.isArray(a[0]) ? a[0] : [[scalarOf(a[0])]]) as Scalar[][];
    const h = m.length;
    const w = Math.max(...m.map((r) => r.length), 1);
    const out: Scalar[][] = [];
    for (let c = 0; c < w; c++) {
      out[c] = [];
      for (let r = 0; r < h; r++) out[c][r] = m[r]?.[c] ?? "";
    }
    return out;
  },
  ROWS: (a) => (Array.isArray(a[0]) ? a[0].length : 1),
  COLUMNS: (a) => (Array.isArray(a[0]) ? Math.max(...a[0].map((r) => r.length), 1) : 1),
  SEQUENCE: (a) => {
    const rows = Math.max(1, num1(a, 1));
    const cols = Math.max(1, a.length > 1 ? toNum(a[1]) : 1);
    const start = a.length > 2 ? toNum(a[2]) : 1;
    const step = a.length > 3 ? toNum(a[3]) : 1;
    const out: Scalar[][] = [];
    for (let r = 0; r < rows; r++) {
      out[r] = [];
      for (let c = 0; c < cols; c++) out[r][c] = start + step * (r * cols + c);
    }
    return out;
  },
  RANDARRAY: (a) => {
    const rows = Math.max(1, num1(a, 1));
    const cols = Math.max(1, a.length > 1 ? toNum(a[1]) : 1);
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => Math.random()),
    );
  },
  FREQUENCY: (a) => {
    const data = nums([a[0]]);
    const bins = nums([a[1]]).sort((x, y) => x - y);
    const counts = bins.map(() => 0);
    let over = 0;
    for (const v of data) {
      let hit = false;
      for (let i = 0; i < bins.length; i++)
        if (v <= bins[i]) {
          counts[i]++;
          hit = true;
          break;
        }
      if (!hit) over++;
    }
    return [...counts, over].map((n) => [n]);
  },
  TREND: (a) => {
    // TREND(known_ys, known_xs, new_xs) — linear-fit prediction; without
    // new_xs it returns the fitted values at each known x, like Excel
    const r = linreg([a[1], a[0]]);
    if (!r || r.sxx <= 0) return "#div0";
    const at = (x: number) => r.my + (r.sxy / r.sxx) * (x - r.mx);
    if (a.length < 3) return nums([a[1]]).map((x) => [at(x)]);
    const nx = a[2];
    if (Array.isArray(nx)) return nx.map((row) => row.map((v) => at(toNum(v))));
    return at(toNum(nx));
  },
  GROWTH: (a) => {
    // GROWTH(known_ys, known_xs, new_x) — exponential fit via ln-regression
    const xs = nums([a[1]]);
    const ys = nums([a[0]]).map((y) => (y > 0 ? Math.log(y) : NaN));
    const xy: Array<[number, number]> = [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++)
      if (!isNaN(ys[i])) xy.push([xs[i], ys[i]]);
    const n = xy.length;
    if (n < 2) return "#num";
    const mx = xy.reduce((s, p) => s + p[0], 0) / n;
    const my = xy.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of xy) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
    }
    if (sxx <= 0) return "#div0";
    const lnm = sxy / sxx;
    const lnb = my - lnm * mx;
    const x = a.length > 2 ? toNum(a[2]) : mx;
    return Math.exp(lnb + lnm * x);
  },
  AGGREGATE: (a, c, d, h) => {
    // AGGREGATE(fn_num, options, range) — options 5-7 ignore errors/hidden;
    // we always ignore error strings inside ranges
    const pick = (code: number): Fn | null =>
      (
        [
          FNS.AVERAGE, FNS.COUNT, FNS.COUNTA, FNS.MAX, FNS.MIN, FNS.PRODUCT,
          FNS["STDEV.S"], FNS["STDEV.P"], FNS.SUM, FNS["VAR.S"], FNS["VAR.P"],
          FNS.MEDIAN, FNS["MODE.SNGL"], FNS.LARGE, FNS.SMALL, FNS["PERCENTILE.INC"],
          FNS["QUARTILE.INC"], FNS["PERCENTILE.EXC"] ?? FNS["PERCENTILE.INC"],
          FNS["QUARTILE.EXC"] ?? FNS["QUARTILE.INC"],
        ] as Fn[]
      )[code - 1] ?? null;
    const fn = pick(toNum(a[0]));
    if (!fn) return "#num";
    // positional trailing args for LARGE/SMALL/PERCENTILE/QUARTILE ride on
    return fn(a.slice(2), c, d, h);
  },
  ISREF: (_a, _c, _d, _h, refs) => refs?.[0] != null,
  CELL: (a, card, _d, host, refs) => {
    const info = toStr(scalarOf(a[0])).toLowerCase();
    const rc = refs?.[1] ?? refs?.[0] ?? host;
    if (info === "address") return `$${COLS(rc[1])}$${rc[0] + 1}`;
    if (info === "row") return rc[0] + 1;
    if (info === "col") return rc[1] + 1;
    if (info === "contents") return rawAt(card, rc[0], rc[1]);
    if (info === "type") {
      const v = cellValue(card, rc[0], rc[1], 0);
      return v === "" ? "b" : typeof v === "number" ? "v" : "l";
    }
    if (info === "filename" || info === "protect" || info === "format") return "#na";
    return "#value";
  },
} satisfies Record<string, Fn>);

/* depreciation + irregular cash flows */
Object.assign(FNS, {
  SLN: (a) => (toNum(a[0]) - toNum(a[1])) / toNum(a[2]),
  SYD: (a) => {
    const [cost, sal, life, per] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3])];
    return ((cost - sal) * (life - per + 1) * 2) / (life * (life + 1));
  },
  DB: (a) => {
    const [cost, sal, life, per] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3])];
    const month = a.length > 4 ? toNum(a[4]) : 12;
    if (cost <= 0 || life <= 0) return "#num";
    const rate = Math.round((1 - Math.pow(sal / cost, 1 / life)) * 1000) / 1000;
    let acc = 0;
    let prev = 0;
    for (let p = 1; p <= per; p++) {
      prev = p === 1 ? cost * rate * (month / 12) : (cost - acc) * rate;
      acc += prev;
    }
    return prev;
  },
  DDB: (a) => {
    const [cost, sal, life, per] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3])];
    const factor = a.length > 4 ? toNum(a[4]) : 2;
    if (cost <= 0 || life <= 0 || per < 1) return "#num";
    let book = cost;
    let dep = 0;
    for (let p = 1; p <= per; p++) {
      dep = Math.min((book * factor) / life, Math.max(0, book - sal));
      book -= dep;
    }
    return dep;
  },
  IPMT: (a) => {
    const [r, per, n, pv] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3])];
    const pmt = toNum(FNS.PMT([r, n, pv, a.length > 4 ? toNum(a[4]) : 0], null as never, 0, [0, 0]));
    let bal = pv;
    for (let k = 1; k < per; k++) bal = bal * (1 + r) + pmt;
    return -(bal * r);
  },
  PPMT: (a, c, d, h) => {
    const pmt = FNS.PMT([a[0], a[2], a[3], a[4] ?? 0], c, d, h);
    const ipmt = FNS.IPMT(a, c, d, h);
    return typeof pmt === "number" && typeof ipmt === "number" ? pmt - ipmt : "#num";
  },
  CUMIPMT: (a, c, d, h) => {
    const [r, n, pv, s, e] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3]), toNum(a[4])];
    let sum = 0;
    for (let p = Math.max(1, s); p <= Math.min(n, e); p++) {
      const v = FNS.IPMT([r, p, n, pv], c, d, h);
      if (typeof v !== "number") return "#num";
      sum += v;
    }
    return sum;
  },
  CUMPRINC: (a, c, d, h) => {
    const [r, n, pv, s, e] = [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3]), toNum(a[4])];
    let sum = 0;
    for (let p = Math.max(1, s); p <= Math.min(n, e); p++) {
      const v = FNS.PPMT([r, p, n, pv], c, d, h);
      if (typeof v !== "number") return "#num";
      sum += v;
    }
    return sum;
  },
  EFFECT: (a) => Math.pow(1 + toNum(a[0]) / toNum(a[1]), toNum(a[1])) - 1,
  NOMINAL: (a) => toNum(a[1]) * (Math.pow(1 + toNum(a[0]), 1 / toNum(a[1])) - 1),
  XNPV: (a) => {
    const r = toNum(a[0]);
    const vs = nums([a[1]]);
    const ds = flatten([a[2]]).map((v) => asDate(v)?.getTime() ?? NaN);
    if (!vs.length || ds.some((x) => isNaN(x))) return "#num";
    const d0 = ds[0];
    return vs.reduce(
      (s, v, i) => s + v / Math.pow(1 + r, (ds[i] - d0) / (365 * DAY_MS)),
      0,
    );
  },
  XIRR: (a) => {
    const vs = nums([a[0]]);
    const ds = flatten([a[1]]).map((v) => asDate(v)?.getTime() ?? NaN);
    if (!vs.length || ds.some((x) => isNaN(x))) return "#num";
    const d0 = ds[0];
    const f = (r: number) =>
      vs.reduce((s, v, i) => s + v / Math.pow(1 + r, (ds[i] - d0) / (365 * DAY_MS)), 0);
    let r = a.length > 2 ? toNum(a[2]) : 0.1;
    for (let i = 0; i < 80; i++) {
      const h = 1e-6;
      const df = (f(r + h) - f(r - h)) / (2 * h);
      if (Math.abs(df) < 1e-10) break;
      const nr = r - f(r) / df;
      if (Math.abs(nr - r) < 1e-9) {
        r = nr;
        break;
      }
      r = nr;
    }
    return isFinite(r) && Math.abs(f(r)) < 1e-3 ? r : "#num";
  },
} satisfies Record<string, Fn>);

/* distributions */
const normInv = (p: number) => {
  // Acklam's rational approximation
  if (p <= 0 || p >= 1) return NaN;
  const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const ph = 1 - pl;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p > ph) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
};
Object.assign(FNS, {
  "NORM.INV": (a) => {
    const z = normInv(toNum(a[0]));
    return isNaN(z) ? "#num" : toNum(a[1]) + z * toNum(a[2]);
  },
  "NORM.S.INV": (a) => {
    const z = normInv(toNum(a[0]));
    return isNaN(z) ? "#num" : z;
  },
  "BINOM.DIST": (a) => {
    const [k, n, p] = [toNum(a[0]), toNum(a[1]), toNum(a[2])];
    const cum = a.length > 3 && scalarOf(a[3]) !== false && scalarOf(a[3]) !== 0;
    const pmf = (x: number) =>
      (FNS.COMBIN([n, x], null as never, 0, [0, 0]) as number) *
      Math.pow(p, x) *
      Math.pow(1 - p, n - x);
    if (!cum) return pmf(k);
    let s = 0;
    for (let x = 0; x <= k; x++) s += pmf(x);
    return s;
  },
  "POISSON.DIST": (a) => {
    const [x, l] = [toNum(a[0]), toNum(a[1])];
    const cum = a.length > 2 && scalarOf(a[2]) !== false && scalarOf(a[2]) !== 0;
    const pmf = (k: number) => (Math.exp(-l) * Math.pow(l, k)) / (FNS.FACT([k], null as never, 0, [0, 0]) as number);
    if (!cum) return pmf(x);
    let s = 0;
    for (let k = 0; k <= x; k++) s += pmf(k);
    return s;
  },
  "EXPON.DIST": (a) => {
    const [x, l] = [toNum(a[0]), toNum(a[1])];
    if (x < 0) return "#num";
    const cum = a.length > 2 && scalarOf(a[2]) !== false && scalarOf(a[2]) !== 0;
    return cum ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x);
  },
  STANDARDIZE: (a) => (toNum(a[0]) - toNum(a[1])) / toNum(a[2]),
} satisfies Record<string, Fn>);

/* engineering: base conversions + delta/gestep + CONVERT */
const DEC_TO = (radix: number) => (a: V[]) => {
  const n = toNum(a[0]);
  if (!isFinite(n) || Math.abs(n) >= (radix === 2 ? 512 : 2 ** 30)) return "#num";
  let s = Math.abs(Math.trunc(n)).toString(radix).toUpperCase();
  if (a.length > 1) s = s.padStart(toNum(a[1]), "0");
  return n < 0 ? (radix === 2 ? (1024 + n).toString(2) : "-" + s) : s;
};
const TO_DEC = (radix: number) => (a: V[]) => {
  const s = toStr(scalarOf(a[0])).trim();
  if (!new RegExp(`^[0-${Math.min(radix - 1, 9)}${radix > 10 ? "A-" + String.fromCharCode(54 + radix) : ""}]+$`, "i").test(s))
    return "#num";
  return parseInt(s, radix);
};
const BASE_TO = (from: number, to: number) => (a: V[]) => {
  const d = TO_DEC(from)(a);
  return typeof d === "number" ? DEC_TO(to)([d, a[1]].filter(Boolean) as V[]) : d;
};
Object.assign(FNS, {
  DEC2BIN: DEC_TO(2),
  DEC2HEX: DEC_TO(16),
  DEC2OCT: DEC_TO(8),
  BIN2DEC: TO_DEC(2),
  HEX2DEC: TO_DEC(16),
  OCT2DEC: TO_DEC(8),
  BIN2HEX: BASE_TO(2, 16),
  BIN2OCT: BASE_TO(2, 8),
  HEX2BIN: BASE_TO(16, 2),
  HEX2OCT: BASE_TO(16, 8),
  OCT2BIN: BASE_TO(8, 2),
  OCT2HEX: BASE_TO(8, 16),
  DELTA: (a) => (toNum(a[0]) === toNum(a[1] ?? 0) ? 1 : 0),
  GESTEP: (a) => (toNum(a[0]) >= toNum(a[1] ?? 0) ? 1 : 0),
  CONVERT: (a) => {
    const n = toNum(a[0]);
    const from = toStr(scalarOf(a[1]));
    const to = toStr(scalarOf(a[2]));
    // temperature is affine, everything else is multiplicative via a base unit
    const temp = (x: number, u: string) =>
      u === "C" ? x : u === "F" ? ((x - 32) * 5) / 9 : u === "K" ? x - 273.15 : NaN;
    const fromC = (x: number, u: string) =>
      u === "C" ? x : u === "F" ? (x * 9) / 5 + 32 : u === "K" ? x + 273.15 : NaN;
    if (["C", "F", "K"].includes(from) && ["C", "F", "K"].includes(to))
      return fromC(temp(n, from), to);
    const T: Record<string, [string, number]> = {
      // length → m
      m: ["L", 1], km: ["L", 1000], cm: ["L", 0.01], mm: ["L", 0.001],
      in: ["L", 0.0254], ft: ["L", 0.3048], yd: ["L", 0.9144], mi: ["L", 1609.344],
      nmi: ["L", 1852],
      // mass → kg
      kg: ["M", 1], g: ["M", 0.001], lb: ["M", 0.45359237], oz: ["M", 0.028349523125],
      t: ["M", 1000], mg: ["M", 0.000001],
      // volume → l
      l: ["V", 1], ml: ["V", 0.001], gal: ["V", 3.785411784], qt: ["V", 0.946352946],
      pt: ["V", 0.473176473], cup: ["V", 0.2365882365], tsp: ["V", 0.00492892159],
      tbsp: ["V", 0.0147867648],
      // time → s
      s: ["T", 1], sec: ["T", 1], min: ["T", 60], hr: ["T", 3600], day: ["T", 86400],
      wk: ["T", 604800], yr: ["T", 31557600],
      // speed → m/s
      "m/s": ["S", 1], mps: ["S", 1], kmh: ["S", 1000 / 3600], mph: ["S", 0.44704],
      kn: ["S", 0.514444],
      // area → m²
      m2: ["A", 1], ft2: ["A", 0.09290304], acre: ["A", 4046.8564224], ha: ["A", 10000],
      // energy → J
      J: ["E", 1], cal: ["E", 4.184], kcal: ["E", 4184], kWh: ["E", 3600000],
      BTU: ["E", 1055.05585262], eV: ["E", 1.602176634e-19],
      // power → W
      W: ["P", 1], kW: ["P", 1000], hp: ["P", 745.69987158227022],
      // data → byte (1024)
      B: ["D", 1], KB: ["D", 1024], MB: ["D", 1048576], GB: ["D", 1073741824],
      TB: ["D", 1099511627776], bit: ["D", 0.125],
    };
    const f = T[from];
    const t2 = T[to];
    if (!f || !t2 || f[0] !== t2[0]) return "#na";
    return (n * f[1]) / t2[1];
  },
} satisfies Record<string, Fn>);

/* database functions — DSUM(db, field, criteria): db and criteria are 2D
 *  ranges whose first row is headers; each criteria row ANDs its cells,
 *  rows OR together — the classic Excel d-function model */
const dbSelect = (a: V[]): { rows: Scalar[][]; col: number } | null => {
  const db = (Array.isArray(a[0]) ? a[0] : null) as Scalar[][] | null;
  const crit = (Array.isArray(a[2]) ? a[2] : null) as Scalar[][] | null;
  if (!db || !crit || !db.length || !crit.length) return null;
  const head = db[0].map((v) => toStr(v).toLowerCase());
  let col = -1;
  const f = scalarOf(a[1]);
  if (typeof f === "number") col = f - 1;
  else col = head.indexOf(toStr(f).toLowerCase());
  if (col < 0) return null;
  const cHead = crit[0].map((v) => toStr(v).toLowerCase());
  const picked: Scalar[][] = [];
  for (const row of db.slice(1)) {
    let ok = false;
    for (const cr of crit.slice(1)) {
      let all = true;
      for (let j = 0; j < cr.length; j++) {
        const cv = cr[j];
        if (cv === "" || cv == null) continue;
        const di = head.indexOf(cHead[j] ?? "");
        if (di < 0 || !matchCrit(row[di] ?? "", cv)) {
          all = false;
          break;
        }
      }
      if (all) {
        ok = true;
        break;
      }
    }
    if (ok) picked.push(row);
  }
  return { rows: picked, col };
};
Object.assign(FNS, {
  DSUM: (a) => {
    const d = dbSelect(a);
    return d ? d.rows.reduce((s, r) => s + (toNum(r[d.col]) || 0), 0) : "#value";
  },
  DCOUNT: (a) => {
    const d = dbSelect(a);
    return d ? d.rows.filter((r) => !isNaN(toNum(r[d.col])) && r[d.col] !== "").length : "#value";
  },
  DCOUNTA: (a) => {
    const d = dbSelect(a);
    return d ? d.rows.filter((r) => (r[d.col] ?? "") !== "").length : "#value";
  },
  DAVERAGE: (a) => {
    const d = dbSelect(a);
    if (!d) return "#value";
    const n = d.rows.map((r) => toNum(r[d.col])).filter((x) => !isNaN(x));
    return n.length ? n.reduce((x, y) => x + y, 0) / n.length : "#div0";
  },
  DMAX: (a) => {
    const d = dbSelect(a);
    if (!d) return "#value";
    const n = d.rows.map((r) => toNum(r[d.col])).filter((x) => !isNaN(x));
    return n.length ? Math.max(...n) : 0;
  },
  DMIN: (a) => {
    const d = dbSelect(a);
    if (!d) return "#value";
    const n = d.rows.map((r) => toNum(r[d.col])).filter((x) => !isNaN(x));
    return n.length ? Math.min(...n) : 0;
  },
  DPRODUCT: (a) => {
    const d = dbSelect(a);
    return d ? d.rows.reduce((s, r) => s * (toNum(r[d.col]) || 0), 1) : "#value";
  },
  DGET: (a) => {
    const d = dbSelect(a);
    if (!d) return "#value";
    if (d.rows.length > 1) return "#num";
    return d.rows.length === 0 ? "#na" : d.rows[0][d.col] ?? "";
  },
} satisfies Record<string, Fn>);

/* weekend-aware workdays (WORKDAY.INTL / NETWORKDAYS.INTL) — the mask is a
 *  7-char Mon–Sun string of 0/1 like Excel's "0000011" (Sat+Sun off) */
const isOff = (d: Date, mask: string, hols: Set<number>) =>
  hols.has(Math.round(d.getTime() / DAY_MS)) || mask[(d.getDay() + 6) % 7] === "1";
Object.assign(FNS, {
  "WORKDAY.INTL": (a) => {
    const start = asDate(scalarOf(a[0]));
    if (!start) return "#value";
    const days = toNum(a[1]);
    const mask = (a.length > 2 ? toStr(scalarOf(a[2])) : "0000011").padEnd(7, "0");
    const hols = new Set(
      flatten([a[3] ?? []]).map((v) => asDate(v)?.getTime() ?? NaN).filter((x) => !isNaN(x)).map((x) => Math.round(x / DAY_MS)),
    );
    let d = new Date(start.getTime());
    let left = Math.abs(days);
    const step = days >= 0 ? 1 : -1;
    let guard = 4000;
    while (left > 0 && guard-- > 0) {
      d = new Date(d.getTime() + step * DAY_MS);
      if (!isOff(d, mask, hols)) left--;
    }
    return dateStr(d);
  },
  "NETWORKDAYS.INTL": (a) => {
    const s = asDate(scalarOf(a[0]));
    const e = asDate(scalarOf(a[1]));
    if (!s || !e) return "#value";
    const mask = (a.length > 2 ? toStr(scalarOf(a[2])) : "0000011").padEnd(7, "0");
    const hols = new Set(
      flatten([a[3] ?? []]).map((v) => asDate(v)?.getTime() ?? NaN).filter((x) => !isNaN(x)).map((x) => Math.round(x / DAY_MS)),
    );
    const dir = e >= s ? 1 : -1;
    let d = new Date(s.getTime());
    let n = 0;
    let guard = 40000;
    while (dir > 0 ? d <= e : d >= e) {
      if (guard-- <= 0) break;
      if (!isOff(d, mask, hols)) n += dir;
      d = new Date(d.getTime() + DAY_MS);
    }
    return n;
  },
} satisfies Record<string, Fn>);

const fmt = (v: number) => {
  if (isNaN(v) || !isFinite(v)) return "#num";
  const r = Math.round(v * 1e6) / 1e6;
  return String(r);
};

/* ---------- number formats — td.dataset.fmt restyles the DISPLAY only;
 *  the raw value never changes, exactly like Excel's format layer ---------- */
const NUMFMT: Record<string, (n: number) => string> = {
  n0: (n) => String(Math.round(n)),
  n2: (n) => n.toFixed(2),
  comma: (n) => n.toLocaleString("en-US", { maximumFractionDigits: 6 }),
  cur: (n) =>
    (n < 0 ? "-$" : "$") +
    Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  pct: (n) => (n * 100).toFixed(1) + "%",
  pct0: (n) => Math.round(n * 100) + "%",
  date: (n) => {
    const d = asDate(n);
    return d ? dateStr(d) : "#value";
  },
  time: (n) => {
    const f = ((n % 1) + 1) % 1;
    const mins = Math.round(f * 1440) % 1440;
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  },
};
/** the shown text for a value honoring the cell's format */
const displayFor = (td: HTMLElement, s: Scalar): string => {
  const f = td.dataset.fmt;
  if (!f || f === "general" || f === "text") return toStr(s);
  const n = typeof s === "number" ? s : NaN;
  if (isNaN(n)) return toStr(s);
  return NUMFMT[f]?.(n) ?? toStr(s);
};

/** recompute every formula cell's display (raw stays untouched) */
export function recalc(card: HTMLElement) {
  for (const td of Array.from(card.querySelectorAll<HTMLElement>("td[data-raw]"))) {
    const raw = td.dataset.raw ?? "";
    td.classList.toggle("num", /^-?[\d$,.]+%?$/.test(raw) && td.dataset.fmt !== "text");
    if (raw.startsWith("=")) {
      if (document.activeElement !== td) {
        const tr = td.closest<HTMLElement>("tr[data-r]");
        const v = evalFormula(card, raw, 0, [
          Number(tr?.dataset.r ?? 0),
          Number(td.dataset.c ?? 0),
        ]);
        const s = scalarOf(v);
        td.textContent = displayFor(td, s);
        td.classList.toggle("num", typeof s === "number" && td.dataset.fmt !== "text");
        td.classList.add("fx");
      }
    } else {
      td.classList.remove("fx");
      if (document.activeElement !== td) {
        const r = Number(td.closest<HTMLElement>("tr")?.dataset.r ?? 0);
        const c = Number(td.dataset.c ?? 0);
        td.textContent = raw === "" ? "" : displayFor(td, cellValue(card, r, c, 0));
      }
    }
  }
}

/** shared handles a td gets from its grid — selection, clipboard, undo */
interface SheetUI {
  copy(cut: boolean): void;
  paste(e: ClipboardEvent, r: number, c: number): boolean;
  clearSelContents(): boolean;
  undo(): boolean; // false when the stack was empty → caller may bubble
  redo(): boolean;
  fillFrom(td: HTMLElement): boolean;
  repaint(): void;
  autoSum(td: HTMLElement): void;
  openFind(): void;
}

function makeTd(
  card: HTMLElement,
  r: number,
  c: number,
  raw: string,
  onChange: () => void,
  ui?: SheetUI,
) {
  const td = document.createElement("td");
  td.dataset.raw = raw;
  td.dataset.c = String(c);
  td.contentEditable = "true";
  td.spellcheck = false;
  td.textContent = raw;
  td.addEventListener("focus", () => {
    // editing a formula cell shows the formula again
    if ((td.dataset.raw ?? "").startsWith("=")) td.textContent = td.dataset.raw ?? "";
  });
  td.addEventListener("blur", () => {
    const next = td.textContent ?? "";
    if (next !== (td.dataset.raw ?? "")) td.dataset.raw = next;
    if (ui) ui.repaint();
    else recalc(card);
    onChange();
  });
  td.addEventListener("input", () => {
    td.dataset.raw = td.textContent ?? "";
  });
  td.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        ui?.copy(false);
      } else if (k === "x") {
        e.preventDefault();
        ui?.copy(true);
      } else if (k === "z" || k === "y") {
        // cell undo first; an empty cell stack falls through to the
        // card-level undo (title/meta/whole-card history)
        const isRedo = k === "y" || (k === "z" && e.shiftKey);
        const consumed = isRedo ? ui?.redo() : ui?.undo();
        const cardEl = (e.target as HTMLElement).closest?.(".callout") as HTMLElement | null;
        const fellThrough =
          consumed === false && cardEl ? tryCardUndo(cardEl, isRedo) : consumed === true;
        if (fellThrough) e.preventDefault();
      } else if (k === "f") {
        e.preventDefault();
        ui?.openFind();
      }
      return;
    }
    if (e.altKey && (e.key === "=" || e.key === "≠")) {
      // Alt+= — AutoSum into this cell, the Excel shortcut
      e.preventDefault();
      ui?.autoSum(td);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      td.blur();
      const next = tdAt(card, e.shiftKey ? r - 1 : r + 1, c);
      if (next) placeCaret(next);
    } else if (e.key === "Tab") {
      e.preventDefault();
      td.blur();
      const next = tdAt(card, r, e.shiftKey ? c - 1 : c + 1);
      if (next) placeCaret(next);
    } else if (e.key === "Escape") {
      td.textContent = td.dataset.raw ?? "";
      td.blur();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // with a multi-cell selection a tap clears the whole range — Excel-style;
      // editing inside one cell keeps the normal character delete
      const sel = (e.target as HTMLElement).closest(".sheet-grid")?.querySelectorAll(".sel");
      if (sel && sel.length > 1 && ui?.clearSelContents()) e.preventDefault();
    } else if (e.key === "F2") {
      e.preventDefault();
      placeCaret(td);
    }
  });
  td.addEventListener("paste", (e) => {
    e.preventDefault();
    if (ui?.paste(e, r, c)) return;
    // plain text only — the grid stores raw strings
    const t = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, t.replace(/\n/g, " "));
  });
  return td;
}

function placeCaret(el: HTMLElement) {
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

function relabel(grid: HTMLElement) {
  grid.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr, i) => {
    tr.dataset.r = String(i);
    const th = tr.querySelector<HTMLElement>("th");
    if (th) th.textContent = String(i + 1);
    tr.querySelectorAll<HTMLElement>("td[data-raw]").forEach((td, c) => {
      td.dataset.c = String(c);
    });
  });
  grid.querySelectorAll<HTMLElement>("tr.sheet-cols th[data-c]").forEach((th, i) => {
    th.dataset.c = String(i);
    th.textContent = COLS(i);
    th.title = `column ${COLS(i)} — click to select`;
  });
}

/* ---------- external control surface (AI tools, future commands) ---------- */

export interface SheetApi {
  title(): string;
  rows(): number;
  cols(): number;
  raw(r: number, c: number): string;
  display(r: number, c: number): string;
  set(r: number, c: number, raw: string): void;
  setCells(cells: Array<[number, number, string]>): void;
  setAll(raws: string[][]): void;
  addRow(raws?: string[]): void;
  addCol(): void;
  delRow(r: number): void;
  delCol(c: number): void;
  clear(a?: [number, number], b?: [number, number]): void;
  read(): string;
  /* tools layer — the AI can drive these too */
  setFmt?(cells: Array<[number, number]>, f: string): void;
  addCf?(col: number, op: string, val: string, color: string): void;
  clearCf?(col?: number): void;
  freeze?(row: boolean, col: boolean): void;
  hideRow?(r: number): void;
  hideCol?(c: number): void;
  unhide?(): void;
  dedupe?(c: number): number;
  filter?(c: number, allowed: string[] | null): void;
  filterState?(): string;
  /* views — "grid" | "kanban <COL>" (board grouped by that column) */
  view?(spec?: string): string;
  /* file interchange — .xlsx/.xls/.ods/.csv/.tsv; no path → file dialog */
  exportFile?(path?: string): Promise<string>;
  importFile?(path?: string, sheet?: string): Promise<string>;
}

export const SHEET_SAVE_FILTERS = [
  { name: "Excel workbook", extensions: ["xlsx"] },
  { name: "CSV", extensions: ["csv"] },
  { name: "TSV / tab-separated", extensions: ["tsv", "txt"] },
];
export const SHEET_OPEN_FILTERS = [
  { name: "Spreadsheets", extensions: ["xlsx", "xls", "xlsm", "ods", "csv", "tsv", "txt"] },
];

export const pickSave = (
  filters: { name: string; extensions: string[] }[],
  defaultPath: string,
): Promise<string | null> =>
  window.__TAURI__?.dialog?.save({ filters, defaultPath }) ?? Promise.resolve(null);

export const pickOpen = async (
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> => {
  const p = await (window.__TAURI__?.dialog?.open({ filters, multiple: false }) ?? Promise.resolve(null));
  return Array.isArray(p) ? (p[0] ?? null) : p;
};

const apis = new WeakMap<HTMLElement, SheetApi>();
export function sheetApi(card: HTMLElement): SheetApi | undefined {
  return apis.get(card);
}

/** A1-style name for a 0-based cell — shared with the chat tooling */
export const cellName = (r: number, c: number) =>
  Number.isFinite(r) && Number.isFinite(c) ? `${COLS(c)}${r + 1}` : "?";

/** shift the A1 refs inside a formula by [dr,dc] — $-anchors hold their
 *  axis, refs inside "quotes" stay untouched, fn names like LOG10( are safe */
const offsetRefs = (raw: string, dr: number, dc: number) =>
  raw
    .split('"')
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\s*\()/g, (_m, d1, L, d2, N) => {
            let col = 0;
            for (const ch of String(L).toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            const nc = d1 ? col : col + dc;
            const nr = d2 ? Number(N) : Number(N) + dr;
            if (nc < 1 || nr < 1 || nc > 16384) return `${d1}${L}${d2}${N}`;
            let s = "";
            let x = nc;
            while (x > 0) {
              s = String.fromCharCode(64 + ((x - 1) % 26) + 1) + s;
              x = Math.floor((x - 1) / 26);
            }
            return `${d1}${s}${d2}${nr}`;
          }),
    )
    .join('"');

/** rewrite refs after a structural edit on `axis`: refs at/after `at`
 *  (0-based grid index) shift by `delta`; refs that pointed into a deleted
 *  row/col become #REF! instead of silently re-pointing at the wrong data.
 *  Unlike fill/copy, $ anchors shift too — the grid itself moved. */
const shiftRefs = (raw: string, axis: "row" | "col", at: number, delta: 1 | -1) =>
  raw
    .split('"')
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\s*\()/g, (_m, d1, L, d2, N) => {
            let col = 0;
            for (const ch of String(L).toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            let nr = Number(N);
            let nc = col;
            const idx = axis === "row" ? nr : nc;
            const cut = at + 1;
            if (delta < 0 && idx === cut) return "#REF!";
            if (idx >= cut) {
              if (axis === "row") nr += delta;
              else nc += delta;
            }
            if (nc < 1 || nr < 1) return "#REF!";
            let s = "";
            let x = nc;
            while (x > 0) {
              s = String.fromCharCode(64 + ((x - 1) % 26) + 1) + s;
              x = Math.floor((x - 1) / 26);
            }
            return `${d1}${s}${d2}${nr}`;
          }),
    )
    .join('"');

/** rebuild the interactive grid inside a card — rows may arrive as seeds
 *  (spawn) or as the static tds a reloaded callout rendered. `seed` sizes a
 *  fresh grid (the insert-time rows × columns). */
export function wireSheet(card: HTMLElement, seed?: { rows: number; cols: number }) {
  if (!card?.dataset) return;
  if (card.dataset.sheetWired) return;
  card.dataset.sheetWired = "1";
  const wrap = card.querySelector<HTMLElement>(".sheet-wrap");
  if (!wrap) return;
  const onChange = () => card.dispatchEvent(new CustomEvent("sheet:changed", { bubbles: true }));

  let grid = card.querySelector<HTMLElement>(".sheet-grid");

  const R = () => grid!.querySelectorAll("tr[data-r]").length;
  const C = () => grid!.querySelector("tr.sheet-cols")?.querySelectorAll("th[data-c]").length ?? 0;
  const growTo = (r: number, c: number) => {
    while (R() <= r && R() < 200) addRow();
    while (C() <= c && C() < 40) addCol();
  };

  // a reloaded card already carries its rows as tds — keep them; a fresh
  // card starts as a blank grid at the picked size
  if (!grid) {
    grid = document.createElement("table");
    grid.className = "sheet-grid";
    const head = document.createElement("tr");
    head.className = "sheet-cols";
    head.innerHTML = `<th class="sheet-corner">#</th>`;
    grid.append(head);
    wrap.prepend(grid);
  }
  const g = grid;

  /* ---- undo / redo: cell + tool-state snapshots around every mutation ---- */
  interface Snap {
    raws: string[][];
    meta: string[];
  }
  const undoStk: Snap[] = [];
  const redoStk: Snap[] = [];
  const snapshot = (): Snap => ({
    raws: Array.from(grid!.querySelectorAll<HTMLElement>("tr[data-r]")).map((tr) =>
      Array.from(tr.querySelectorAll<HTMLElement>("td[data-raw]")).map(
        (td) => td.dataset.raw ?? "",
      ),
    ),
    meta: collectMetaLines(card),
  });
  const pushUndo = () => {
    undoStk.push(snapshot());
    if (undoStk.length > 60) undoStk.shift();
    redoStk.length = 0;
  };
  const restore = (snap: Snap) => {
    grid!.querySelectorAll("tr[data-r]").forEach((t) => t.remove());
    grid!.querySelectorAll("tr.sheet-cols th[data-c]").forEach((t) => t.remove());
    const cols = Math.max(1, ...snap.raws.map((r) => r.length));
    for (let c = 0; c < cols; c++) addCol();
    if (!snap.raws.length) addRow();
    else for (const r of snap.raws) addRow(r);
    clearSelVisual();
    relabel(grid!);
    // replay the snapshotted tool state — rebuilt cells start meta-clean, and
    // resetToolState + applyMeta bring back formats/hidden/freeze/filters
    resetToolState();
    card.dataset.meta = JSON.stringify(snap.meta);
    applyMeta();
    repaint();
    onChange();
  };
  const undo = () => {
    if (!undoStk.length) return false;
    redoStk.push(snapshot());
    restore(undoStk.pop()!);
    return true;
  };
  const redo = () => {
    if (!redoStk.length) return false;
    undoStk.push(snapshot());
    restore(redoStk.pop()!);
    return true;
  };

  /* ---- selection ---- */
  let sel: { a: [number, number]; b: [number, number] } | null = null;
  let selHdr: { kind: "row" | "col"; n: number } | null = null;
  let tools: HTMLElement | null = null;

  const selBounds = (): [[number, number], [number, number]] | null => {
    if (sel) {
      return [
        [Math.min(sel.a[0], sel.b[0]), Math.min(sel.a[1], sel.b[1])],
        [Math.max(sel.a[0], sel.b[0]), Math.max(sel.a[1], sel.b[1])],
      ];
    }
    if (selHdr?.kind === "col") return [[0, selHdr.n], [R() - 1, selHdr.n]];
    if (selHdr?.kind === "row") return [[selHdr.n, 0], [selHdr.n, C() - 1]];
    return null;
  };

  const paintSel = () => {
    grid!.querySelectorAll(".sel").forEach((el) => el.classList.remove("sel"));
    grid!.querySelectorAll(".selh").forEach((el) => el.classList.remove("selh"));
    grid!.querySelectorAll(".sheet-fill").forEach((el) => el.remove());
    const b = selBounds();
    if (b) {
      const [[r0, c0], [r1, c1]] = b;
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) tdAt(card, r, c)?.classList.add("sel");
      if (selHdr) {
        const sel2 =
          selHdr.kind === "col"
            ? grid!.querySelectorAll<HTMLElement>(`tr.sheet-cols th[data-c="${selHdr.n}"]`)
            : grid!.querySelectorAll<HTMLElement>(`tr[data-r="${selHdr.n}"] > th`);
        sel2.forEach((t) => t.classList.add("selh"));
      }
      // the fill handle rides on the selection's bottom-right corner
      const anchor = tdAt(card, r1, c1);
      if (anchor && !selHdr) {
        const f = document.createElement("span");
        f.className = "sheet-fill";
        f.title = "drag to fill";
        f.contentEditable = "false";
        anchor.append(f);
      }
    }
  };

  const clearSelVisual = () => {
    sel = null;
    selHdr = null;
    tools?.remove();
    tools = null;
    paintSel();
  };

  const showTools = () => {
    tools?.remove();
    tools = null;
    if (!selHdr) return;
    const { kind, n } = selHdr;
    tools = document.createElement("div");
    tools.className = "sheet-tools";
    tools.contentEditable = "false";
    const mk = (label: string, tip: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = tip;
      b.contentEditable = "false";
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      tools!.append(b);
    };
    if (kind === "row") {
      mk("⤒ insert", "insert a row above", () => { pushUndo(); insertRow(n); });
      mk("⤓ insert", "insert a row below", () => { pushUndo(); insertRow(n + 1); });
      mk("✕ delete", "delete this row", () => { pushUndo(); delRow(n); });
      mk("▭ hide", "hide this row", () => hideRow(n));
      mk("clear", "empty this row", () => { pushUndo(); clearRange([n, 0], [n, C() - 1]); });
    } else {
      mk("⇤ insert", "insert a column to the left", () => { pushUndo(); insertCol(n); });
      mk("⇥ insert", "insert a column to the right", () => { pushUndo(); insertCol(n + 1); });
      mk("A→Z", "sort rows by this column, ascending", () => { pushUndo(); sortCol(n, true); });
      mk("Z→A", "sort rows by this column, descending", () => { pushUndo(); sortCol(n, false); });
      mk("⧨ filter", "filter this column's values", () => openFilter(n));
      mk("⧉ dedupe", "remove rows with duplicate values in this column", () => dedupe(n));
      mk("▯ hide", "hide this column", () => hideCol(n));
      mk("✕ delete", "delete this column", () => { pushUndo(); delCol(n); });
      mk("clear", "empty this column", () => { pushUndo(); clearRange([0, n], [R() - 1, n]); });
    }
    wrap.insertBefore(tools, wrap.firstChild);
  };

  /* ---- structural ops ---- */
  /** after a structural move, rewrite every surviving formula's refs so they
   *  keep pointing at the same data (refs into a deleted index → #REF!) */
  const shiftAllRefs = (axis: "row" | "col", at: number, delta: 1 | -1) => {
    grid!.querySelectorAll<HTMLElement>("td[data-raw]").forEach((td) => {
      const raw = td.dataset.raw ?? "";
      if (!raw.startsWith("=")) return;
      const next = shiftRefs(raw, axis, at, delta);
      if (next !== raw) td.dataset.raw = next;
    });
  };
  const delRow = (r: number) => {
    grid!.querySelector<HTMLElement>(`tr[data-r="${r}"]`)?.remove();
    clearSelVisual();
    relabel(grid!);
    shiftAllRefs("row", r, -1);
    repaint();
    onChange();
  };
  const delCol = (c: number) => {
    grid!.querySelectorAll<HTMLElement>(`tr[data-r] td[data-raw][data-c="${c}"]`).forEach((t) =>
      t.remove(),
    );
    grid!.querySelector<HTMLElement>(`tr.sheet-cols th[data-c="${c}"]`)?.remove();
    clearSelVisual();
    relabel(grid!);
    shiftColMeta(c, -1);
    shiftAllRefs("col", c, -1);
    repaint();
    onChange();
  };
  const insertRow = (at: number) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    tr.append(th);
    wireRowTh(th);
    for (let c = 0; c < C(); c++) tr.append(makeTd(card, at, c, "", onChange, ui));
    const ctl = document.createElement("td");
    ctl.className = "sheet-rowctl";
    tr.append(ctl);
    const ref = grid!.querySelectorAll<HTMLElement>("tr[data-r]")[at] ?? null;
    grid!.insertBefore(tr, ref);
    relabel(grid!);
    shiftAllRefs("row", at, 1);
    repaint();
    onChange();
  };
  const insertCol = (at: number) => {
    const head = grid!.querySelector<HTMLElement>("tr.sheet-cols")!;
    const th = document.createElement("th");
    th.dataset.c = String(at);
    th.textContent = COLS(at);
    wireColTh(th);
    const ref =
      head.querySelector<HTMLElement>(`th[data-c="${at}"]`) ??
      head.querySelector(".sheet-addcol");
    head.insertBefore(th, ref);
    for (const tr of Array.from(grid!.querySelectorAll<HTMLElement>("tr[data-r]"))) {
      const refTd =
        tr.querySelector<HTMLElement>(`td[data-raw][data-c="${at}"]`) ??
        tr.querySelector("td.sheet-rowctl");
      tr.insertBefore(makeTd(card, Number(tr.dataset.r), at, "", onChange, ui), refTd);
    }
    relabel(grid!);
    shiftColMeta(at, 1);
    shiftAllRefs("col", at, 1);
    repaint();
    onChange();
  };
  const sortCol = (c: number, asc: boolean) => {
    const trs = Array.from(grid!.querySelectorAll<HTMLElement>("tr[data-r]"));
    const key = (tr: HTMLElement) => {
      // the DISPLAYED value sorts — formulas rank by their computed result
      const raw = tr.querySelector<HTMLElement>(`td[data-raw][data-c="${c}"]`)?.textContent ?? "";
      const n = Number(raw.replace(/[$,\s]/g, "").replace(/%$/, ""));
      return { num: isNaN(n) ? null : raw.endsWith("%") ? n / 100 : n, s: raw.toLowerCase() };
    };
    trs.sort((x, y) => {
      const a = key(x);
      const b = key(y);
      const cmp =
        a.num !== null && b.num !== null
          ? a.num - b.num
          : a.num !== null
            ? -1
            : b.num !== null
              ? 1
              : a.s.localeCompare(b.s);
      return asc ? cmp : -cmp;
    });
    for (const tr of trs) grid!.append(tr);
    relabel(grid!);
    repaint();
    onChange();
  };
  const clearRange = (a: [number, number], b: [number, number]) => {
    for (let r = Math.min(a[0], b[0]); r <= Math.max(a[0], b[0]); r++)
      for (let c = Math.min(a[1], b[1]); c <= Math.max(a[1], b[1]); c++) {
        const td = tdAt(card, r, c);
        if (td) {
          td.dataset.raw = "";
          td.textContent = "";
        }
      }
    repaint();
    onChange();
  };

  /* ---- clipboard: TSV out (like Excel), TSV or adjusted-raw in ---- */
  let clip: { raws: string[][]; shown: string[][]; from: [number, number]; cut: boolean } | null =
    null;
  const copy = (cut: boolean) => {
    const b = selBounds();
    if (!b) return;
    const [[r0, c0], [r1, c1]] = b;
    const raws: string[][] = [];
    const shown: string[][] = [];
    for (let r = r0; r <= r1; r++) {
      const rr: string[] = [];
      const ss: string[] = [];
      for (let c = c0; c <= c1; c++) {
        const td = tdAt(card, r, c);
        rr.push(td?.dataset.raw ?? "");
        ss.push((td?.textContent ?? "").replace(/\n/g, " "));
      }
      raws.push(rr);
      shown.push(ss);
    }
    clip = { raws, shown, from: [r0, c0], cut };
    const tsv = shown.map((r) => r.join("\t")).join("\n");
    void navigator.clipboard?.writeText(tsv).catch(() => {});
  };

  const paste = (e: ClipboardEvent, r: number, c: number): boolean => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return false;
    const internal = clip !== null && clip.shown.map((x) => x.join("\t")).join("\n") === text;
    const src = internal ? clip! : null;
    const grid2 = src
      ? src.raws
      : text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.split("\t"));
    // single-cell plain text into an editing field stays inline — multi-cell
    // or grid-internal pastes land as a block at the anchor
    if (!src && grid2.length === 1 && grid2[0].length === 1) return false;
    pushUndo();
    const dr = src ? r - src.from[0] : 0;
    const dc = src ? c - src.from[1] : 0;
    if (src?.cut) {
      clearRange(src.from, [
        src.from[0] + src.raws.length - 1,
        src.from[1] + (src.raws[0]?.length ?? 1) - 1,
      ]);
      clip = null;
    }
    grid2.forEach((cells, di) =>
      cells.forEach((raw, dj) => {
        const tr = r + di;
        const tc = c + dj;
        growTo(tr, tc);
        const cell = tdAt(card, tr, tc);
        if (!cell) return;
        cell.dataset.raw =
          internal && raw.startsWith("=") ? offsetRefs(raw, dr + di, dc + dj) : raw;
      }),
    );
    sel = { a: [r, c], b: [r + grid2.length - 1, c + (grid2[0]?.length ?? 1) - 1] };
    selHdr = null;
    paintSel();
    repaint();
    onChange();
    return true;
  };

  const clearSelContents = (): boolean => {
    const b = selBounds();
    if (!b) return false;
    const [[r0, c0], [r1, c1]] = b;
    if (r0 === r1 && c0 === c1) return false;
    pushUndo();
    clearRange([r0, c0], [r1, c1]);
    return true;
  };

  /* ---- fill handle: drag the corner dot — formulas ref-offset like Excel ---- */
  let fillDrag: { from: [[number, number], [number, number]] } | null = null;
  const fillTo = (r: number, c: number) => {
    if (!fillDrag) return;
    const [[r0, c0], [r1, c1]] = fillDrag.from;
    // fill only extends outward from the source box on one axis — the bigger delta wins
    const dr = Math.max(0, r - r1);
    const dc = Math.max(0, c - c1);
    if (!dr && !dc) return;
    pushUndo();
    if (dr) {
      for (let tr = r1 + 1; tr <= r1 + dr; tr++)
        for (let c = c0; c <= c1; c++) {
          const srcR = r0 + ((tr - r0) % (r1 - r0 + 1));
          const srcRaw = rawAt(card, srcR, c);
          growTo(tr, c);
          const td = tdAt(card, tr, c);
          if (td)
            td.dataset.raw = srcRaw.startsWith("=") ? offsetRefs(srcRaw, tr - srcR, 0) : srcRaw;
        }
      sel = { a: [r0, c0], b: [r1 + dr, c1] };
    } else if (dc) {
      for (let tc = c1 + 1; tc <= c1 + dc; tc++)
        for (let r = r0; r <= r1; r++) {
          const srcC = c0 + ((tc - c0) % (c1 - c0 + 1));
          const srcRaw = rawAt(card, r, srcC);
          growTo(r, tc);
          const td = tdAt(card, r, tc);
          if (td)
            td.dataset.raw = srcRaw.startsWith("=") ? offsetRefs(srcRaw, 0, tc - srcC) : srcRaw;
        }
      sel = { a: [r0, c0], b: [r1, c1 + dc] };
    }
    fillDrag = null;
    paintSel();
    repaint();
    onChange();
  };

  /* ---- the td↔grid bridge ---- */
  const ui: SheetUI = {
    copy,
    paste,
    clearSelContents,
    undo,
    redo,
    repaint: () => repaint(),
    autoSum: (td) => autoSum(td),
    openFind: () => openFind(),
    fillFrom: (td) => {
      const b = selBounds();
      if (!b) return false;
      fillDrag = { from: b };
      void td;
      return true;
    },
  };

  // seed a fresh grid AFTER ui exists — addCol/addRow build cells through
  // makeTd(..., ui), and calling them earlier throws on the const (TDZ),
  // leaving a spawned sheet card as an empty shell
  if (card.querySelectorAll("tr[data-r]").length === 0) {
    for (let c = 0; c < (seed?.cols ?? 3); c++) addCol();
    for (let r = 0; r < (seed?.rows ?? 4); r++) addRow();
  }

  /* ---- point-click formula entry + range/header selection ---- */
  let drag: [number, number] | null = null;
  let refDrag: { r: number; c: number; editing: HTMLElement } | null = null;
  let refEnd: [number, number] | null = null;

  const editingCell = () => {
    const el = document.activeElement as HTMLElement | null;
    return el?.matches?.("td[data-raw]") && card.contains(el) ? el : null;
  };
  const editingFormula = () => (editingCell()?.textContent ?? "").startsWith("=");

  const markFxRef = (a: [number, number], b: [number, number] | null) => {
    grid!.querySelectorAll(".fxref").forEach((el) => el.classList.remove("fxref"));
    const bb = b ?? a;
    for (let r = Math.min(a[0], bb[0]); r <= Math.max(a[0], bb[0]); r++)
      for (let c = Math.min(a[1], bb[1]); c <= Math.max(a[1], bb[1]); c++)
        tdAt(card, r, c)?.classList.add("fxref");
  };

  const insertText = (text: string) => {
    const el = editingCell();
    if (!el) return;
    el.focus();
    document.execCommand("insertText", false, text);
    el.dataset.raw = el.textContent ?? "";
  };

  g.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    // right edge of a column header starts a resize drag, not a selection
    const thEdge = t.closest<HTMLElement>("tr.sheet-cols th[data-c]");
    if (thEdge && e.offsetX > thEdge.offsetWidth - 5) {
      e.preventDefault();
      colResize = { c: Number(thEdge.dataset.c), x0: e.clientX, w0: thEdge.offsetWidth, th: thEdge };
      return;
    }
    const fill = t.closest(".sheet-fill");
    if (fill) {
      e.preventDefault();
      e.stopPropagation();
      ui.fillFrom(fill as HTMLElement);
      return;
    }
    const th = t.closest<HTMLElement>("tr.sheet-cols th[data-c], tr[data-r] > th");
    const td = t.closest<HTMLElement>("td[data-raw]");
    // typing a formula and clicking a cell/header inserts its ref — the
    // Excel gesture; preventDefault keeps the caret inside the formula
    if (editingFormula() && (td || th)) {
      if (td && td === editingCell()) return; // caret move inside the formula
      e.preventDefault();
      if (th) {
        // a header click drops the whole column/row range into the formula
        const tr = th.closest("tr")!;
        const ref = tr.classList.contains("sheet-cols")
          ? `${cellName(0, Number((th as HTMLElement).dataset.c ?? 0))}:${cellName(R() - 1, Number((th as HTMLElement).dataset.c ?? 0))}`
          : `${cellName(Number(tr.dataset.r ?? 0), 0)}:${cellName(Number(tr.dataset.r ?? 0), C() - 1)}`;
        insertText(ref);
        return;
      }
      const tr = td!.closest("tr")!;
      refDrag = { r: Number(tr.dataset.r), c: Number(td!.dataset.c), editing: editingCell()! };
      markFxRef([refDrag.r, refDrag.c], null);
      return;
    }
    if (th) {
      // headers SELECT — never delete on a plain click (the toolbar carries
      // insert/delete/sort, like Excel's right-click menu)
      e.preventDefault();
      const tr = th.closest("tr")!;
      if (tr.classList.contains("sheet-cols")) {
        const n = Number((th as HTMLElement).dataset.c ?? 0);
        selHdr = { kind: "col", n };
        sel = { a: [0, n], b: [R() - 1, n] };
      } else {
        const n = Number(tr.dataset.r ?? 0);
        selHdr = { kind: "row", n };
        sel = { a: [n, 0], b: [n, C() - 1] };
      }
      showTools();
      paintSel();
      return;
    }
    if (td) {
      selHdr = null;
      tools?.remove();
      tools = null;
      drag = [Number(td.closest("tr")!.dataset.r), Number(td.dataset.c)];
      sel = { a: drag, b: drag };
      paintSel();
    }
  });

  g.addEventListener("mouseover", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-raw]");
    if (!td) return;
    const r = Number(td.closest("tr")!.dataset.r);
    const c = Number(td.dataset.c);
    if (fillDrag) {
      fillTo(r, c);
      return;
    }
    if (refDrag) {
      refEnd = [r, c];
      markFxRef([refDrag.r, refDrag.c], refEnd);
      return;
    }
    if (drag && sel) {
      sel.b = [r, c];
      paintSel();
    }
  });

  const onDocUp = () => {
    if (refDrag) {
      const a: [number, number] = [refDrag.r, refDrag.c];
      const b = refEnd ?? a;
      const ref =
        a[0] === b[0] && a[1] === b[1]
          ? cellName(a[0], a[1])
          : `${cellName(Math.min(a[0], b[0]), Math.min(a[1], b[1]))}:${cellName(Math.max(a[0], b[0]), Math.max(a[1], b[1]))}`;
      grid!.querySelectorAll(".fxref").forEach((el) => el.classList.remove("fxref"));
      refDrag = null;
      refEnd = null;
      insertText(ref);
      return;
    }
    drag = null;
    fillDrag = null;
  };
  document.addEventListener("mouseup", onDocUp);
  // a detached card (deleted/moved) must not keep a document listener alive
  const gc = new MutationObserver(() => {
    if (!card.isConnected) {
      document.removeEventListener("mouseup", onDocUp);
      gc.disconnect();
    }
  });
  gc.observe(document.body, { childList: true, subtree: true });

  /** the row-number header selects its row (toolbar carries the edits) */
  function wireRowTh(th: HTMLElement) {
    if (th.dataset.wired) return;
    th.dataset.wired = "1";
    th.title = "click to select row — toolbar for insert/delete/sort";
  }

  /** a column header selects its column */
  function wireColTh(th: HTMLElement) {
    if (th.dataset.wired) return;
    th.dataset.wired = "1";
    th.title = "click to select column — toolbar for insert/delete/sort";
  }

  function addCol() {
    const head = grid!.querySelector<HTMLElement>("tr.sheet-cols")!;
    const c = head.querySelectorAll("th[data-c]").length;
    const th = document.createElement("th");
    th.dataset.c = String(c);
    th.textContent = COLS(c);
    wireColTh(th);
    head.insertBefore(th, head.querySelector(".sheet-addcol"));
    for (const tr of Array.from(grid!.querySelectorAll<HTMLElement>("tr[data-r]"))) {
      const r = Number(tr.dataset.r);
      tr.insertBefore(
        makeTd(card, r, c, "", onChange, ui),
        tr.querySelector("td.sheet-rowctl"),
      );
    }
    relabel(grid!);
  }

  function addRow(raws?: string[]) {
    const head = grid!.querySelector<HTMLElement>("tr.sheet-cols")!;
    const cols = head.querySelectorAll("th[data-c]").length;
    const r = grid!.querySelectorAll("tr[data-r]").length;
    const tr = document.createElement("tr");
    tr.dataset.r = String(r);
    const th = document.createElement("th");
    tr.append(th);
    wireRowTh(th);
    for (let c = 0; c < cols; c++) tr.append(makeTd(card, r, c, raws?.[c] ?? "", onChange, ui));
    const ctl = document.createElement("td");
    ctl.className = "sheet-rowctl";
    tr.append(ctl);
    grid!.append(tr);
    relabel(grid!);
  }

  // controls: the corner "+" column and an add-row button under the grid
  const head = g.querySelector<HTMLElement>("tr.sheet-cols")!;
  if (!head.querySelector(".sheet-addcol")) {
    const ac = document.createElement("th");
    ac.className = "sheet-addcol";
    ac.textContent = "+";
    ac.title = "add column";
    ac.contentEditable = "false";
    ac.addEventListener("click", () => {
      pushUndo();
      addCol();
      relabel(grid!);
      onChange();
    });
    head.append(ac);
  }
  if (!wrap.querySelector(".sheet-addrow")) {
    const ar = document.createElement("button");
    ar.className = "sheet-addrow";
    ar.textContent = "+ row";
    ar.title = "add row";
    ar.contentEditable = "false";
    ar.addEventListener("click", () => {
      pushUndo();
      addRow();
      relabel(grid!);
      onChange();
    });
    wrap.append(ar);
  }
  // a reloaded grid's cells came in as static markup — upgrade them to live
  // cells so they edit/recompute like a fresh card; rewire the header
  // selects and give every row its trailing control cell too
  g.querySelectorAll<HTMLElement>("tr.sheet-cols th[data-c]").forEach(wireColTh);
  g.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr) => {
    const th = tr.querySelector<HTMLElement>("th");
    if (th) wireRowTh(th);
    if (!tr.querySelector("td.sheet-rowctl")) {
      const ctl = document.createElement("td");
      ctl.className = "sheet-rowctl";
      tr.append(ctl);
    }
  });
  g.querySelectorAll<HTMLElement>("tr[data-r] td[data-raw]").forEach((old) => {
    const r = Number(old.closest<HTMLElement>("tr")!.dataset.r);
    const c = Number(old.dataset.c ?? Array.from(old.parentElement!.children).indexOf(old) - 1);
    const fresh = makeTd(card, r, c, old.dataset.raw ?? "", onChange, ui);
    old.replaceWith(fresh);
  });
  relabel(grid);

  /* ================= tools layer =================
   *  the everyday Excel surface: filters, conditional formats, freeze panes,
   *  hide/unhide, column widths, find & replace, AutoSum, dedupe, a right-click
   *  context menu — everything persists as `> [!meta]` lines in the callout */

  /* -- per-column filters (value sets; empty set = no filter) -- */
  const filters = new Map<number, Set<string>>();
  // column-keyed state (filters, cf rules) must ride along when columns move
  const shiftColMeta = (at: number, delta: 1 | -1) => {
    const remap = <T>(m: Map<number, T>) => {
      const next = new Map<number, T>();
      for (const [k, v] of m) {
        if (delta === -1 && k === at) continue; // the deleted column's rule dies with it
        next.set(k >= at ? k + delta : k, v);
      }
      m.clear();
      for (const [k, v] of next) if (k >= 0) m.set(k, v);
    };
    remap(filters);
    remap(cfRules);
    syncFilterMeta();
    syncCfMeta();
  };
  const syncFilterMeta = () => {
    if (!filters.size) {
      delete card.dataset.filter;
      return;
    }
    card.dataset.filter = Array.from(filters.entries())
      .map(([c, set]) => `${COLS(c)}=${[...set].join("|")}`)
      .join(";");
  };
  const applyFilters = () => {
    grid!.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr) => {
      if (tr.dataset.uhide === "1") {
        tr.style.display = "none";
        return;
      }
      let show = true;
      for (const [c, set] of filters) {
        const td = tr.querySelector<HTMLElement>(`td[data-raw][data-c="${c}"]`);
        if (!set.has((td?.textContent ?? "").trim())) {
          show = false;
          break;
        }
      }
      tr.style.display = show ? "" : "none";
    });
    grid!.querySelectorAll<HTMLElement>("tr.sheet-cols th[data-c]").forEach((th) =>
      th.classList.toggle("filtered", filters.has(Number(th.dataset.c))),
    );
  };

  /* -- conditional formats: rules per column, first match wins -- */
  interface CfRule {
    op: string;
    val: string;
    color: string;
  }
  const cfRules = new Map<number, CfRule[]>();
  const syncCfMeta = () => {
    if (!cfRules.size) {
      delete card.dataset.cf;
      return;
    }
    card.dataset.cf = Array.from(cfRules.entries())
      .map(([c, rs]) => `${COLS(c)}:${rs.map((r) => `${r.op}${r.val}=${r.color}`).join("|")}`)
      .join(";");
  };
  const cfMatch = (rule: CfRule, txt: string, v: number | null, colVals: string[]): boolean => {
    switch (rule.op) {
      case ">": return v !== null && v > Number(rule.val);
      case ">=": return v !== null && v >= Number(rule.val);
      case "<": return v !== null && v < Number(rule.val);
      case "<=": return v !== null && v <= Number(rule.val);
      case "=": return txt === rule.val || (v !== null && v === Number(rule.val));
      case "!=": return txt !== rule.val && (v === null || v !== Number(rule.val));
      case "between": {
        const [a, b] = rule.val.split(",").map(Number);
        return v !== null && v >= Math.min(a, b) && v <= Math.max(a, b);
      }
      case "contains": return txt.toLowerCase().includes(rule.val.toLowerCase());
      case "top": {
        const n = Number(rule.val) || 3;
        const nums2 = colVals.map((x) => Number(x.replace(/[$,%]/g, ""))).filter((x) => !isNaN(x)).sort((a, b) => b - a);
        return v !== null && nums2.slice(0, Math.max(1, n)).includes(v);
      }
      case "dup": return txt !== "" && colVals.filter((x) => x === txt).length > 1;
      default: return false;
    }
  };
  const applyCf = () => {
    grid!.querySelectorAll<HTMLElement>("td[data-raw][data-cfset]").forEach((td) => {
      td.style.background = "";
      td.style.color = "";
      delete td.dataset.cfset;
    });
    for (const [c, rules] of cfRules) {
      const tds = Array.from(
        grid!.querySelectorAll<HTMLElement>(`tr[data-r] td[data-raw][data-c="${c}"]`),
      );
      const colVals = tds.map((t) => (t.textContent ?? "").trim());
      for (const td of tds) {
        const txt = (td.textContent ?? "").trim();
        const n = Number(txt.replace(/[$,%]/g, ""));
        const v = isNaN(n) || txt === "" ? null : n;
        for (const rule of rules) {
          if (cfMatch(rule, txt, v, colVals)) {
            td.style.background = rule.color;
            td.style.color = "#202020";
            td.dataset.cfset = "1";
            break;
          }
        }
      }
    }
  };

  const repaint = () => {
    recalc(card)
    applyFilters();
    applyCf();
    // a live view repaints too — card text shows computed values
    if (board) applyView();
  };

  /* -- freeze panes: sticky first row and/or column inside the scrolling wrap -- */
  const setFreeze = (r: boolean, c: boolean, fire = true) => {
    grid!.classList.toggle("frz-r", r);
    grid!.classList.toggle("frz-c", c);
    if (r || c) card.dataset.freeze = `${r ? "r" : ""}${c ? "c" : ""}`;
    else delete card.dataset.freeze;
    if (fire) onChange();
  };

  /* -- hide / unhide -- */
  const hideRow = (r: number, fire = true) => {
    const tr = grid!.querySelector<HTMLElement>(`tr[data-r="${r}"]`);
    if (!tr) return;
    tr.dataset.uhide = "1";
    tr.style.display = "none";
    if (fire) onChange();
  };
  const hideCol = (c: number, fire = true) => {
    grid!.querySelector<HTMLElement>(`tr.sheet-cols th[data-c="${c}"]`)?.setAttribute("data-h", "1");
    grid!
      .querySelectorAll<HTMLElement>(
        `tr.sheet-cols th[data-c="${c}"], tr[data-r] td[data-raw][data-c="${c}"]`,
      )
      .forEach((el) => (el.style.display = "none"));
    if (fire) onChange();
  };
  const unhideAll = () => {
    grid!.querySelectorAll<HTMLElement>("tr[data-r][data-uhide]").forEach((tr) => {
      delete tr.dataset.uhide;
      tr.style.display = "";
    });
    grid!.querySelectorAll<HTMLElement>("[data-h]").forEach((el) =>
      (el as HTMLElement).removeAttribute("data-h"),
    );
    grid!.querySelectorAll<HTMLElement>("td[data-raw], tr.sheet-cols th[data-c]").forEach((el) => {
      el.style.display = "";
    });
    applyFilters();
    onChange();
  };

  /* -- AutoSum: =SUM of the contiguous block directly above (Excel's Σ) -- */
  const autoSum = (td: HTMLElement) => {
    const tr = td.closest("tr")!;
    const r = Number(tr.dataset.r);
    const c = Number(td.dataset.c ?? 0);
    if (r === 0) return;
    let start = r - 1;
    while (start >= 0) {
      const v = (tdAt(card, start, c)?.textContent ?? "").trim();
      if (v === "") break;
      start--;
    }
    start++;
    const range =
      start === r ? `${COLS(c)}1:${COLS(c)}${r}` : `${COLS(c)}${start + 1}:${COLS(c)}${r}`;
    pushUndo();
    td.dataset.raw = `=SUM(${range})`;
    td.textContent = td.dataset.raw;
    td.blur();
    repaint();
    onChange();
  };

  /* -- remove duplicates on a column (keeps the first occurrence) -- */
  const dedupe = (c: number): number => {
    pushUndo();
    const seen = new Set<string>();
    let removed = 0;
    for (const tr of Array.from(grid!.querySelectorAll<HTMLElement>("tr[data-r]"))) {
      const txt = (
        tr.querySelector<HTMLElement>(`td[data-raw][data-c="${c}"]`)?.textContent ?? ""
      ).trim();
      if (seen.has(txt)) {
        tr.remove();
        removed++;
      } else seen.add(txt);
    }
    relabel(grid!);
    repaint();
    onChange();
    return removed;
  };

  /* -- formats onto the current selection (or a range) -- */
  const setFmtOn = (cells: Array<[number, number]>, f: string) => {
    pushUndo();
    for (const [r, c] of cells) {
      const td = tdAt(card, r, c);
      if (td) td.dataset.fmt = f === "general" ? "" : f;
    }
    repaint();
    onChange();
  };
  const boundsCells = (): Array<[number, number]> => {
    const b = selBounds();
    if (!b) return [];
    const out: Array<[number, number]> = [];
    for (let r = b[0][0]; r <= b[1][0]; r++)
      for (let c = b[0][1]; c <= b[1][1]; c++) out.push([r, c]);
    return out;
  };

  /* ---- context menu (right-click) — the Excel surface in one place ---- */
  let ctx: HTMLElement | null = null;
  let pop: HTMLElement | null = null;
  const closeCtx = () => {
    ctx?.remove();
    ctx = null;
    pop?.remove();
    pop = null;
  };
  const fmtLabel = (f: string) =>
    ({ general: "General", n0: "Number · 0", n2: "Number · 0.00", comma: "Comma 1,000", cur: "Currency $", pct: "Percent 0.0%", pct0: "Percent 0%", date: "Date", time: "Time", text: "Text" })[f] ?? f;

  const openCtx = (e: MouseEvent, td: HTMLElement | null, _th: HTMLElement | null) => {
    closeCtx();
    ctx = document.createElement("div");
    ctx.className = "sheet-ctx";
    ctx.contentEditable = "false";
    const item = (label: string, fn: () => void, dim = false) => {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item" + (dim ? " dim" : "");
      b.innerHTML = label;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeCtx();
        fn();
      });
      ctx!.append(b);
      return b;
    };
    const sep = () => {
      const d = document.createElement("div");
      d.className = "sheet-ctx-sep";
      ctx!.append(d);
    };
    const r = td ? Number(td.closest("tr")!.dataset.r) : selHdr?.n ?? 0;
    const c = td ? Number(td.dataset.c) : selHdr?.kind === "col" ? selHdr.n : 0;

    item("✂&ensp;Cut", () => copy(true));
    item("⧉&ensp;Copy", () => copy(false));
    item("📋&ensp;Paste", () => {
      void navigator.clipboard?.readText().then((txt) => {
        if (!txt) return;
        const fake = {
          clipboardData: { getData: () => txt },
          preventDefault: () => {},
        } as unknown as ClipboardEvent;
        paste(fake, r, c);
      }).catch(() => {});
    });
    sep();
    item("⤒&ensp;Insert row above", () => { pushUndo(); insertRow(r); });
    item("⤓&ensp;Insert row below", () => { pushUndo(); insertRow(r + 1); });
    item("⇤&ensp;Insert column left", () => { pushUndo(); insertCol(c); });
    item("⇥&ensp;Insert column right", () => { pushUndo(); insertCol(c + 1); });
    sep();
    item("✕&ensp;Delete row", () => { pushUndo(); delRow(r); });
    item("✕&ensp;Delete column", () => { pushUndo(); delCol(c); });
    item("⌫&ensp;Clear contents", () => {
      const b = selBounds();
      pushUndo();
      clearRange(b ? b[0] : [r, c], b ? b[1] : [r, c]);
    });
    sep();
    item("A→Z&ensp;Sort ascending", () => { pushUndo(); sortCol(c, true); });
    item("Z→A&ensp;Sort descending", () => { pushUndo(); sortCol(c, false); });
    item("⧨&ensp;Filter this column…", () => openFilter(c));
    sep();
    item("▭&ensp;Hide row", () => hideRow(r));
    item("▯&ensp;Hide column", () => hideCol(c));
    item("▢&ensp;Unhide all", () => unhideAll(), !grid!.querySelector("[data-uhide],[data-h]"));
    sep();
    item("Σ&ensp;AutoSum into cell", () => { const t = td ?? tdAt(card, r, c); if (t) autoSum(t); });
    item("⧉&ensp;Remove duplicates (col " + COLS(c) + ")", () => dedupe(c));
    item("🔎&ensp;Find && replace…", () => openFind());
    sep();
    // format submenu
    const fsub = document.createElement("div");
    fsub.className = "sheet-ctx-sub";
    for (const f of ["general", "n0", "n2", "comma", "cur", "pct", "pct0", "date", "time", "text"]) {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item";
      b.textContent = fmtLabel(f);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeCtx();
        setFmtOn(boundsCells().length ? boundsCells() : [[r, c]], f);
      });
      fsub.append(b);
    }
    const fh = document.createElement("div");
    fh.className = "sheet-ctx-item sub";
    fh.innerHTML = "◧&ensp;Format cell <span class='arr'>▸</span>";
    fh.append(fsub);
    ctx!.append(fh);
    // conditional format submenu
    const csub = document.createElement("div");
    csub.className = "sheet-ctx-sub";
    for (const [label, op, ph] of [
      ["Highlight >", ">", "value"],
      ["Highlight <", "<", "value"],
      ["Highlight ≥", ">=", "value"],
      ["Highlight ≤", "<=", "value"],
      ["Highlight =", "=", "value"],
      ["Highlight ≠", "!=", "value"],
      ["Text contains…", "contains", "text"],
      ["Between…", "between", "low,high"],
      ["Top 3", "top", "3"],
      ["Duplicates", "dup", ""],
    ] as Array<[string, string, string]>) {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item";
      b.textContent = label;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeCtx();
        openCfForm(c, op, ph);
      });
      csub.append(b);
    }
    const cclear = document.createElement("button");
    cclear.className = "sheet-ctx-item dim";
    cclear.textContent = "Clear column rules";
    cclear.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeCtx();
      pushUndo();
      cfRules.delete(c);
      syncCfMeta();
      repaint();
      onChange();
    });
    csub.append(cclear);
    const ch = document.createElement("div");
    ch.className = "sheet-ctx-item sub";
    ch.innerHTML = "🎨&ensp;Conditional format <span class='arr'>▸</span>";
    ch.append(csub);
    ctx!.append(ch);
    sep();
    const fz = document.createElement("div");
    fz.className = "sheet-ctx-item sub";
    fz.innerHTML = "❄&ensp;Freeze <span class='arr'>▸</span>";
    const fzsub = document.createElement("div");
    fzsub.className = "sheet-ctx-sub";
    for (const [label, fr, fc] of [
      ["Row 1", true, false],
      ["Column A", false, true],
      ["Row 1 + Column A", true, true],
      ["Unfreeze", false, false],
    ] as Array<[string, boolean, boolean]>) {
      const b = document.createElement("button");
      b.className = "sheet-ctx-item";
      b.textContent = label;
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeCtx();
        setFreeze(fr, fc);
      });
      fzsub.append(b);
    }
    fz.append(fzsub);
    ctx!.append(fz);
    sep();
    item("⇪&ensp;Export file…", () => { void doExport(); });
    item("⇩&ensp;Import file…", () => { void doImport(); });

    document.body.append(ctx);
    const w = ctx.offsetWidth;
    const h = ctx.offsetHeight;
    ctx.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - w - 8))}px`;
    ctx.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - h - 8))}px`;
  };

  /* -- the filter popover under a column header -- */
  const openFilter = (c: number) => {
    closeCtx();
    const tds = Array.from(
      grid!.querySelectorAll<HTMLElement>(`tr[data-r] td[data-raw][data-c="${c}"]`),
    );
    const vals = Array.from(new Set(tds.map((t) => (t.textContent ?? "").trim()))).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const active = filters.get(c);
    pop = document.createElement("div");
    pop.className = "sheet-filterpop";
    pop.contentEditable = "false";
    pop.innerHTML =
      `<div class="fp-head">Filter ${COLS(c)} — ${active ? active.size + " shown" : "all shown"}</div>` +
      `<div class="fp-sort"><button data-s="a">A→Z</button><button data-s="z">Z→A</button></div>` +
      `<div class="fp-vals">${vals
        .slice(0, 60)
        .map(
          (v) =>
            `<label><input type="checkbox" data-v="${v.replace(/"/g, "&quot;")}" ${
              !active || active.has(v) ? "checked" : ""
            }/> <span>${v === "" ? "(blank)" : v.replace(/</g, "&lt;")}</span></label>`,
        )
        .join("")}${vals.length > 60 ? `<div class="fp-more">+${vals.length - 60} more</div>` : ""}</div>` +
      `<div class="fp-foot"><button data-k="all">All</button><button data-k="none">None</button><button class="fp-apply">Apply</button><button class="fp-clear">Clear</button></div>`;
    pop.querySelectorAll<HTMLElement>(".fp-sort button").forEach((b) =>
      b.addEventListener("click", () => {
        pushUndo();
        sortCol(c, b.dataset.s === "a");
        closeCtx();
      }),
    );
    pop.querySelectorAll<HTMLElement>(".fp-foot [data-k]").forEach((b) =>
      b.addEventListener("click", () => {
        const on = b.dataset.k === "all";
        pop!.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
          cb.checked = on;
        });
      }),
    );
    pop.querySelector<HTMLElement>(".fp-apply")!.addEventListener("click", () => {
      pushUndo();
      const keep = new Set<string>();
      pop!.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
        if (cb.checked) keep.add(cb.dataset.v ?? "");
      });
      if (keep.size === vals.length) filters.delete(c);
      else filters.set(c, keep);
      syncFilterMeta();
      applyFilters();
      onChange();
      closeCtx();
    });
    pop.querySelector<HTMLElement>(".fp-clear")!.addEventListener("click", () => {
      pushUndo();
      filters.delete(c);
      syncFilterMeta();
      applyFilters();
      onChange();
      closeCtx();
    });
    const th = grid!.querySelector<HTMLElement>(`tr.sheet-cols th[data-c="${c}"]`);
    document.body.append(pop);
    const wr = th?.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min((wr?.left ?? 100), window.innerWidth - 240))}px`;
    pop.style.top = `${(wr?.bottom ?? 100) + 4}px`;
  };

  /* -- the CF mini-form: op + value + color swatches -- */
  const openCfForm = (c: number, op: string, ph: string) => {
    closeCtx();
    pop = document.createElement("div");
    pop.className = "sheet-cfform";
    pop.contentEditable = "false";
    const needVal = !["dup", "top"].includes(op) || op === "top";
    pop.innerHTML =
      `<div class="fp-head">Highlight ${COLS(c)} where ${op === "top" ? "top N" : op === "dup" ? "duplicates" : op + " …"}</div>` +
      (op === "dup"
        ? ""
        : `<input class="cf-val" placeholder="${ph || "value"}" value="${op === "top" ? "3" : ""}"/>`) +
      `<div class="cf-sw">${["#ffe08a", "#b6f2c1", "#ffc9c9", "#bfd8ff", "#e8c9ff", "#ffd8a8"]
        .map((cl) => `<button class="cf-swbtn" data-c="${cl}" style="background:${cl}"></button>`)
        .join("")}</div>` +
      `<div class="fp-foot"><button class="fp-apply">Apply</button></div>`;
    let color = "#ffe08a";
    pop.querySelectorAll<HTMLElement>(".cf-swbtn").forEach((b) =>
      b.addEventListener("click", () => {
        color = b.dataset.c ?? color;
        pop!.querySelectorAll(".cf-swbtn").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      }),
    );
    pop.querySelector<HTMLElement>(".fp-apply")!.addEventListener("click", () => {
      pushUndo();
      const val = (pop!.querySelector<HTMLInputElement>(".cf-val")?.value ?? "").trim();
      if (needVal && val === "" && op !== "top") return closeCtx();
      const l = cfRules.get(c) ?? [];
      l.push({ op, val: op === "top" ? val || "3" : val, color });
      cfRules.set(c, l);
      syncCfMeta();
      repaint();
      onChange();
      closeCtx();
    });
    const th = grid!.querySelector<HTMLElement>(`tr.sheet-cols th[data-c="${c}"]`);
    document.body.append(pop);
    const wr = th?.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min((wr?.left ?? 100), window.innerWidth - 240))}px`;
    pop.style.top = `${(wr?.bottom ?? 100) + 4}px`;
    pop.querySelector<HTMLInputElement>(".cf-val")?.focus();
  };

  /* -- find & replace bar -- */
  const openFind = () => {
    wrap.querySelector(".sheet-findbar")?.remove();
    const bar = document.createElement("div");
    bar.className = "sheet-findbar";
    bar.contentEditable = "false";
    bar.innerHTML =
      `<input class="fb-q" placeholder="find in sheet"/>` +
      `<span class="fb-count"></span>` +
      `<button class="fb-nav" data-n="-1" title="previous">↑</button><button class="fb-nav" data-n="1" title="next">↓</button>` +
      `<input class="fb-r" placeholder="replace with"/>` +
      `<button class="fb-rep" title="replace current">Replace</button>` +
      `<button class="fb-all" title="replace all">All</button>` +
      `<button class="fb-x" title="close">✕</button>`;
    wrap.prepend(bar);
    const q = bar.querySelector<HTMLInputElement>(".fb-q")!;
    const ri = bar.querySelector<HTMLInputElement>(".fb-r")!;
    const count = bar.querySelector<HTMLElement>(".fb-count")!;
    let hits: HTMLElement[] = [];
    let idx = -1;
    const scan = () => {
      grid!.querySelectorAll(".findhit,.findcur").forEach((el) =>
        el.classList.remove("findhit", "findcur"),
      );
      const needle = q.value.toLowerCase();
      hits = [];
      idx = -1;
      if (needle) {
        for (const td of Array.from(grid!.querySelectorAll<HTMLElement>("td[data-raw]"))) {
          if (
            (td.dataset.raw ?? "").toLowerCase().includes(needle) ||
            (td.textContent ?? "").toLowerCase().includes(needle)
          )
            hits.push(td);
        }
      }
      for (const td of hits) td.classList.add("findhit");
      if (hits.length) {
        idx = 0;
        hits[0].classList.add("findcur");
        hits[0].scrollIntoView({ block: "nearest" });
      }
      count.textContent = hits.length ? `1/${hits.length}` : "0";
    };
    const step = (d: number) => {
      if (!hits.length) return;
      hits[idx].classList.remove("findcur");
      idx = (idx + d + hits.length) % hits.length;
      hits[idx].classList.add("findcur");
      hits[idx].scrollIntoView({ block: "nearest" });
      count.textContent = `${idx + 1}/${hits.length}`;
    };
    q.addEventListener("input", scan);
    q.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") step(1);
      if (e.key === "Escape") bar.remove();
    });
    ri.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") bar.remove();
    });
    bar.querySelectorAll<HTMLElement>(".fb-nav").forEach((b) =>
      b.addEventListener("click", () => step(Number(b.dataset.n))),
    );
    bar.querySelector<HTMLElement>(".fb-rep")!.addEventListener("click", () => {
      if (idx < 0 || !hits[idx]) return;
      pushUndo();
      const td = hits[idx];
      const needle = q.value;
      td.dataset.raw = (td.dataset.raw ?? "").replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), ri.value);
      repaint();
      onChange();
      scan();
    });
    bar.querySelector<HTMLElement>(".fb-all")!.addEventListener("click", () => {
      if (!q.value) return;
      pushUndo();
      const rx = new RegExp(q.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      for (const td of hits) td.dataset.raw = (td.dataset.raw ?? "").replace(rx, ri.value);
      repaint();
      onChange();
      scan();
    });
    bar.querySelector<HTMLElement>(".fb-x")!.addEventListener("click", () => {
      grid!.querySelectorAll(".findhit,.findcur").forEach((el) =>
        el.classList.remove("findhit", "findcur"),
      );
      bar.remove();
    });
    q.focus();
  };

  /* ---- views — `view:` turns the same grid into a board; the dataset is
   *  the single source of truth, a card drag WRITES the group cell back -- */

  /** rows visible to a view: data rows, not user-hidden/filtered, and not
   *  completely blank */
  const viewRows = (): number[] => {
    const out: number[] = [];
    grid!.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr) => {
      if (tr.style.display === "none") return;
      const r = Number(tr.dataset.r);
      const cells = Array.from(tr.querySelectorAll<HTMLElement>("td[data-raw]"));
      if (!cells.some((td) => (td.dataset.raw ?? "") !== "")) return;
      out.push(r);
    });
    return out;
  };
  /** the DISPLAY value of a cell (formulas resolved) */
  const dispAt = (r: number, c: number) =>
    tdAt(card, r, c)?.textContent?.trim() ?? "";

  let board: HTMLElement | null = null;
  /** the cell write boards use (callers pushUndo first so row adds fold
   *  into the same undo step) */
  const writeCell = (r: number, c: number, raw: string) => {
    growTo(r, c);
    const td = tdAt(card, r, c);
    if (td) {
      td.dataset.raw = raw;
      td.textContent = raw;
    }
    repaint();
    onChange();
  };
  /** render the kanban board grouped by column `gc` — columns are that
   *  column's distinct values; cards are rows; a drop writes the cell */
  const renderBoard = (gc: number) => {
    board?.remove();
    board = document.createElement("div");
    board.className = "sheet-board";
    board.contentEditable = "false";
    const groups = new Map<string, number[]>();
    const rows = viewRows();
    const keys = groupKeys(rows.map((r) => dispAt(r, gc)));
    for (const r of rows) {
      const k = dispAt(r, gc) === "" ? "(blank)" : dispAt(r, gc);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    for (const k of keys) {
      const col = document.createElement("div");
      col.className = "sb-col" + (k === "(blank)" ? " sb-blank" : "");
      col.dataset.group = k;
      const head = document.createElement("div");
      head.className = "sb-head";
      head.innerHTML = `<b>${escH(k)}</b><span>${groups.get(k)!.length}</span>`;
      col.append(head);
      for (const r of groups.get(k)!) {
        const el = document.createElement("div");
        el.className = "sb-card";
        el.draggable = true;
        el.dataset.r = String(r);
        const title =
          Array.from({ length: C() }, (_, c) => c)
            .filter((c) => c !== gc)
            .map((c) => dispAt(r, c))
            .find((v) => v !== "") ?? `row ${r + 1}`;
        const chips = Array.from({ length: C() }, (_, c) => c)
          .filter((c) => c !== gc && dispAt(r, c) !== "" && dispAt(r, c) !== title)
          .map((c) => `<span class="sb-chip">${escH(COLS(c))}: ${escH(dispAt(r, c))}</span>`)
          .join("");
        el.innerHTML =
          `<div class="sb-title">${escH(title)}</div>` +
          (chips ? `<div class="sb-chips">${chips}</div>` : "") +
          `<button class="sb-move" title="move to another column">⋯</button>`;
        el.addEventListener("dragstart", (e) => {
          e.dataTransfer!.setData("text/laido-row", String(r));
          el.classList.add("sb-drag");
        });
        el.addEventListener("dragend", () => el.classList.remove("sb-drag"));
        el.querySelector<HTMLElement>(".sb-move")!.addEventListener("click", (e) => {
          e.stopPropagation();
          boardMoveMenu(el, r, keys);
        });
        el.addEventListener("dblclick", () => {
          card.dataset.view = "grid";
          applyView();
          onChange();
          tdAt(card, r, 0)?.scrollIntoView({ block: "center" });
        });
        col.append(el);
      }
      const add = document.createElement("button");
      add.className = "sb-add";
      add.textContent = "＋ card";
      add.addEventListener("click", () => {
        pushUndo();
        addRow();
        writeCell(R() - 1, gc, k === "(blank)" ? "" : k);
      });
      col.append(add);
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("sb-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("sb-over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("sb-over");
        const r = Number(e.dataTransfer!.getData("text/laido-row"));
        if (Number.isNaN(r)) return;
        const v = k === "(blank)" ? "" : k;
        if (rawAt(card, r, gc) === v) return;
        pushUndo();
        writeCell(r, gc, v);
      });
      board.append(col);
    }
    wrap.append(board);
  };
  /** ⋯ menu — the keyboard/no-drag path to move a card between columns */
  const boardMoveMenu = (el: HTMLElement, r: number, keys: string[]) => {
    el.querySelector(".sb-menu")?.remove();
    const m = document.createElement("div");
    m.className = "sb-menu";
    for (const k of keys) {
      const b = document.createElement("button");
      b.textContent = `→ ${k}`;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        m.remove();
        const gc = colOf((card.dataset.view ?? "").replace(/^kanban\s+/i, ""));
        const v = k === "(blank)" ? "" : k;
        if (rawAt(card, r, gc) !== v) {
          pushUndo();
          writeCell(r, gc, v);
        }
      });
      m.append(b);
    }
    const back = document.createElement("button");
    back.textContent = "⬒ open in grid";
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      card.dataset.view = "grid";
      applyView();
      onChange();
    });
    m.append(back);
    el.append(m);
    const off = () => {
      m.remove();
      document.removeEventListener("click", off);
    };
    setTimeout(() => document.addEventListener("click", off), 0);
  };
  /* ---- calendar view — month grid; records sit on their date column's
   *  day; dragging a chip reschedules by writing the date cell ---- */

  let calMonth: Date | null = null; // transient nav state — not persisted
  const renderCalendar = (dc: number) => {
    board?.remove();
    const rows = viewRows();
    const byDay = new Map<string, number[]>();
    const uns: number[] = [];
    for (const r of rows) {
      const p = parseDay(dispAt(r, dc));
      if (!p) {
        uns.push(r);
        continue;
      }
      const k = isoOf(p[0], p[1], p[2]);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k)!.push(r);
    }
    if (!calMonth) {
      const first = rows.map((r) => parseDay(dispAt(r, dc))).find((p) => p);
      calMonth = first ? new Date(first[0], first[1], 1) : new Date();
      calMonth.setDate(1);
    }
    board = document.createElement("div");
    board.className = "sheet-cal";
    board.contentEditable = "false";
    // month nav
    const nav = document.createElement("div");
    nav.className = "sc-nav";
    const label = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    nav.innerHTML = `<button data-n="-1">◀</button><b>${escH(label)}</b>` +
      `<button data-n="1">▶</button><button class="sc-today">today</button>`;
    nav.querySelectorAll<HTMLElement>("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.classList.contains("sc-today")) calMonth = new Date();
        else calMonth = new Date(calMonth!.getFullYear(), calMonth!.getMonth() + Number(b.dataset.n), 1);
        calMonth.setDate(1);
        renderCalendar(dc);
      }),
    );
    board.append(nav);
    const body = document.createElement("div");
    body.className = "sc-body";
    const gridEl = document.createElement("div");
    gridEl.className = "sc-grid";
    for (const d of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
      const h = document.createElement("div");
      h.className = "sc-dow";
      h.textContent = d;
      gridEl.append(h);
    }
    const firstDow = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1).getDay();
    const daysIn = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
    const todayIso = isoOf(...(() => { const t = new Date(); return [t.getFullYear(), t.getMonth(), t.getDate()] as [number, number, number]; })());
    for (let i = 0; i < firstDow + daysIn; i++) {
      const cell = document.createElement("div");
      const inMonth = i >= firstDow;
      const day = inMonth ? i - firstDow + 1 : 0;
      const iso = inMonth ? isoOf(calMonth.getFullYear(), calMonth.getMonth(), day) : "";
      cell.className = "sc-day" + (inMonth ? "" : " sc-off") + (iso === todayIso ? " sc-today" : "");
      if (inMonth) {
        cell.innerHTML = `<span class="sc-n">${day}</span>`;
        for (const r of byDay.get(iso) ?? []) {
          const chip = document.createElement("div");
          chip.className = "sc-chip";
          chip.draggable = true;
          chip.dataset.r = String(r);
          const title =
            Array.from({ length: C() }, (_, c) => c)
              .filter((c) => c !== dc)
              .map((c) => dispAt(r, c))
              .find((v) => v !== "") ?? `row ${r + 1}`;
          chip.textContent = title;
          chip.title = `row ${r + 1} — drag to reschedule`;
          chip.addEventListener("dragstart", (e) => {
            e.dataTransfer!.setData("text/laido-row", String(r));
          });
          chip.addEventListener("dblclick", () => {
            card.dataset.view = "grid";
            applyView();
            onChange();
            tdAt(card, r, 0)?.scrollIntoView({ block: "center" });
          });
          cell.append(chip);
        }
        cell.addEventListener("dragover", (e) => {
          e.preventDefault();
          cell.classList.add("sc-over");
        });
        cell.addEventListener("dragleave", () => cell.classList.remove("sc-over"));
        cell.addEventListener("drop", (e) => {
          e.preventDefault();
          cell.classList.remove("sc-over");
          const r = Number(e.dataTransfer!.getData("text/laido-row"));
          if (Number.isNaN(r)) return;
          pushUndo();
          writeCell(r, dc, iso);
        });
        const add = document.createElement("button");
        add.className = "sc-add";
        add.textContent = "＋";
        add.title = `new record on ${iso}`;
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          pushUndo();
          addRow();
          writeCell(R() - 1, dc, iso);
        });
        cell.append(add);
      }
      gridEl.append(cell);
    }
    body.append(gridEl);
    if (uns.length) {
      const side = document.createElement("div");
      side.className = "sc-side";
      side.innerHTML = `<div class="sc-side-h">unscheduled · ${uns.length}</div>`;
      for (const r of uns) {
        const chip = document.createElement("div");
        chip.className = "sc-chip";
        chip.draggable = true;
        chip.dataset.r = String(r);
        chip.textContent =
          Array.from({ length: C() }, (_, c) => c)
            .filter((c) => c !== dc)
            .map((c) => dispAt(r, c))
            .find((v) => v !== "") ?? `row ${r + 1}`;
        chip.addEventListener("dragstart", (e) =>
          e.dataTransfer!.setData("text/laido-row", String(r)),
        );
        side.append(chip);
      }
      // dropping back on the sidebar unschedules (clears the date)
      side.addEventListener("dragover", (e) => e.preventDefault());
      side.addEventListener("drop", (e) => {
        e.preventDefault();
        const r = Number(e.dataTransfer!.getData("text/laido-row"));
        if (Number.isNaN(r)) return;
        pushUndo();
        writeCell(r, dc, "");
      });
      body.append(side);
    }
    board.append(body);
    wrap.append(board);
  };

  /** apply card.dataset.view — "grid" | "kanban <col>" | "calendar <col>" */
  const applyView = () => {
    const spec = (card.dataset.view ?? "grid").trim();
    const km = spec.match(/^kanban\s+([A-Za-z]+)$/);
    const cm = spec.match(/^calendar\s+([A-Za-z]+)$/);
    if (km || cm) {
      card.classList.add("sheet-boarded");
      if (km) renderBoard(colOf(km[1]));
      else {
        if (card.dataset.view !== spec) card.dataset.view = spec;
        renderCalendar(colOf(cm![1]));
      }
    } else {
      card.classList.remove("sheet-boarded");
      calMonth = null;
      board?.remove();
      board = null;
      if (spec !== "grid") card.dataset.view = "grid";
    }
    viewSel && paintViewSel();
  };
  /** the head picker — a plain select, no popover machinery */
  let viewSel: HTMLSelectElement | null = null;
  const buildViewSel = () => {
    const headEl = card.querySelector<HTMLElement>(".callout-head");
    if (!headEl || headEl.querySelector(".sheet-view")) return;
    viewSel = document.createElement("select");
    viewSel.className = "sheet-view";
    viewSel.contentEditable = "false";
    viewSel.title = "view — one dataset, many faces";
    headEl.append(viewSel);
    viewSel.addEventListener("change", () => {
      pushUndo();
      card.dataset.view = viewSel!.value;
      applyView();
      onChange();
    });
    viewSel.addEventListener("pointerdown", (e) => e.stopPropagation());
    paintViewSel();
  };
  const paintViewSel = () => {
    if (!viewSel) return;
    const cur = card.dataset.view ?? "grid";
    viewSel.innerHTML =
      `<option value="grid">grid</option>` +
      Array.from({ length: C() }, (_, c) => `<option value="kanban ${COLS(c)}">board: ${COLS(c)}</option>`).join("") +
      Array.from({ length: C() }, (_, c) => `<option value="calendar ${COLS(c)}">calendar: ${COLS(c)}</option>`).join("");
    viewSel.value = /^(kanban|calendar)\s+[A-Za-z]+$/.test(cur) ? cur : "grid";
  };

  /* -- wipe all tool state so applyMeta can replay clean (undo restore) -- */
  const resetToolState = () => {
    filters.clear();
    cfRules.clear();
    delete card.dataset.filter;
    delete card.dataset.cf;
    delete card.dataset.freeze;
    delete card.dataset.view;
    card.classList.remove("sheet-boarded");
    board?.remove();
    board = null;
    grid!.classList.remove("frz-r", "frz-c");
    grid!.querySelectorAll<HTMLElement>("tr[data-r]").forEach((tr) => {
      delete tr.dataset.uhide;
      tr.style.display = "";
    });
    grid!.querySelectorAll<HTMLElement>("td[data-raw]").forEach((td) => {
      delete td.dataset.fmt;
      td.style.display = "";
      td.style.background = "";
      td.style.color = "";
      delete td.dataset.cfset;
    });
    grid!.querySelectorAll<HTMLElement>("tr.sheet-cols th[data-c]").forEach((th) => {
      th.removeAttribute("data-h");
      th.removeAttribute("data-w");
      th.style.display = "";
      th.style.width = "";
      th.classList.remove("filtered");
    });
  };

  /* -- replay `> [!meta]` lines after a reload -- */
  const colOf = (L: string) => {
    let c = 0;
    for (const ch of L.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
    return c - 1;
  };
  const applyMeta = () => {
    let lines: string[] = [];
    try {
      lines = JSON.parse(card.dataset.meta ?? "[]");
    } catch {
      lines = [];
    }
    for (const l of lines) {
      const m = l.match(/^\[!(\w+)\]\s*(.*)$/);
      if (!m) continue;
      const body = m[2];
      if (m[1] === "fmt") {
        for (const bit of body.trim().split(/\s+/)) {
          const eq = bit.indexOf("=");
          if (eq < 0) continue;
          const lhs = bit.slice(0, eq);
          const f = bit.slice(eq + 1);
          const cells = lhs.includes(":") ? expandRange(lhs) : refRC(lhs) ? [refRC(lhs)!] : [];
          for (const [r, c] of cells) {
            const td = tdAt(card, r, c);
            if (td) td.dataset.fmt = f;
          }
        }
      } else if (m[1] === "cf") {
        for (const seg of body.split(";")) {
          const cm = seg.match(/^([A-Z]+):(.+)$/i);
          if (!cm) continue;
          const rules = cm[2]
            .split("|")
            .map((bit) => {
              const rm = bit.match(/^([a-z!>=<]+)([^=]*)=(.+)$/);
              return rm ? { op: rm[1], val: rm[2], color: rm[3] } : null;
            })
            .filter((x): x is { op: string; val: string; color: string } => x !== null);
          if (rules.length) cfRules.set(colOf(cm[1]), rules);
        }
      } else if (m[1] === "freeze") {
        setFreeze(body.includes("r"), body.includes("c"), false);
      } else if (m[1] === "hide") {
        for (const tok of body.split(",")) {
          const hm = tok.match(/^([rc])(.+)$/i);
          if (!hm) continue;
          if (hm[1].toLowerCase() === "r") hideRow(Number(hm[2]) - 1, false);
          else hideCol(colOf(hm[2]), false);
        }
      } else if (m[1] === "view") {
        card.dataset.view = body.trim() || "grid";
      } else if (m[1] === "w") {
        for (const bit of body.trim().split(/\s+/)) {
          const eq = bit.indexOf("=");
          if (eq < 0) continue;
          const th = grid!.querySelector<HTMLElement>(
            `tr.sheet-cols th[data-c="${colOf(bit.slice(0, eq))}"]`,
          );
          if (th) {
            th.style.width = `${Number(bit.slice(eq + 1))}px`;
            th.dataset.w = bit.slice(eq + 1);
          }
        }
      } else if (m[1] === "filter") {
        for (const seg of body.split(";")) {
          const fm = seg.match(/^([A-Z]+)=(.*)$/);
          if (!fm) continue;
          filters.set(colOf(fm[1]), new Set(fm[2].split("|")));
        }
      }
    }
    applyView();
  };

  /* ---- wire the tool gestures into the grid ---- */
  // right-click → the context menu
  grid!.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".sheet-findbar") || t.closest(".sheet-tools")) return;
    e.preventDefault();
    const td = t.closest<HTMLElement>("td[data-raw]");
    const th = t.closest<HTMLElement>("tr.sheet-cols th[data-c], tr[data-r] > th");
    // right-click inside the selection keeps it; outside moves it
    if (td && !td.classList.contains("sel")) {
      const tr = td.closest("tr")!;
      sel = { a: [Number(tr.dataset.r), Number(td.dataset.c)], b: [Number(tr.dataset.r), Number(td.dataset.c)] };
      selHdr = null;
      paintSel();
    } else if (th) {
      const tr = th.closest("tr")!;
      const isCol = tr.classList.contains("sheet-cols");
      const n = isCol ? Number((th as HTMLElement).dataset.c ?? 0) : Number(tr.dataset.r ?? 0);
      selHdr = { kind: isCol ? "col" : "row", n };
      sel = isCol ? { a: [0, n], b: [R() - 1, n] } : { a: [n, 0], b: [n, C() - 1] };
      paintSel();
    }
    openCtx(e, td, th);
  });
  // clicking anywhere outside closes menu/popovers
  document.addEventListener("mousedown", (e) => {
    if (!card.isConnected) return;
    if (ctx && !(e.target as HTMLElement).closest(".sheet-ctx")) ctx.remove();
    if (pop && !(e.target as HTMLElement).closest(".sheet-filterpop, .sheet-cfform")) {
      pop.remove();
      pop = null;
    }
  });

  // column-resize drag on the right edge of a header + resize cursor
  let colResize: { c: number; x0: number; w0: number; th: HTMLElement } | null = null;
  grid!.addEventListener("mousemove", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>("tr.sheet-cols th[data-c]");
    if (th && !colResize) {
      const near = e.offsetX > th.offsetWidth - 5;
      th.style.cursor = near ? "col-resize" : "";
    }
  });
  const onResizeMove = (e: MouseEvent) => {
    if (!colResize) return;
    const w = Math.max(34, colResize.w0 + (e.clientX - colResize.x0));
    colResize.th.style.width = `${w}px`;
    colResize.th.dataset.w = String(Math.round(w));
  };
  const onResizeUp = () => {
    if (colResize) {
      colResize = null;
      onChange();
    }
  };
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeUp);
  const gc2 = new MutationObserver(() => {
    if (!card.isConnected) {
      document.removeEventListener("mousemove", onResizeMove);
      document.removeEventListener("mouseup", onResizeUp);
      gc2.disconnect();
    }
  });
  gc2.observe(document.body, { childList: true, subtree: true });

  // `> [!meta]` lines from the markdown ride in data-meta — replay them now
  // that the live grid exists, then paint once
  buildViewSel();
  applyMeta();
  repaint();

  /* ---- the external api — chat widgets and future commands drive sheets
   *  through this, never by poking the DOM directly ---- */
  /* ---- file interchange — .xlsx via Rust (calamine/xlsxwriter), .csv/.tsv in TS ---- */
  const cellsGrid = (): string[][] => {
    const out: string[][] = [];
    for (let r = 0; r < R(); r++) {
      const row: string[] = [];
      for (let c = 0; c < C(); c++) row.push(rawAt(card, r, c));
      out.push(row);
    }
    return out;
  };
  const doExport = async (path?: string): Promise<string> => {
    let p: string | null | undefined = path;
    if (!p) {
      p = await pickSave(SHEET_SAVE_FILTERS, `${card.dataset.topic || "sheet"}.xlsx`);
      if (!p) return "export cancelled";
    }
    const ext = String(p).split(".").pop()?.toLowerCase() ?? "xlsx";
    const cells = cellsGrid();
    try {
      if (ext === "csv" || ext === "tsv" || ext === "txt") {
        return await invoke<string>("file_write_text", {
          path: p,
          content: toDelim(cells, ext === "csv" ? "," : "\t"),
        });
      }
      return await invoke<string>("sheet_xlsx_export", { path: p, cells });
    } catch (e) {
      return `export failed: ${String(e)}`;
    }
  };
  const doImport = async (path?: string, sheet?: string): Promise<string> => {
    let p: string | null | undefined = path;
    if (!p) {
      p = await pickOpen(SHEET_OPEN_FILTERS);
      if (!p) return "import cancelled";
    }
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    try {
      if (ext === "csv" || ext === "tsv" || ext === "txt") {
        const text = await invoke<string>("file_read_text", { path: p });
        const rows = parseDelim(text, ext === "tsv" || ext === "txt" ? "\t" : ",");
        pushUndo();
        restore({ raws: rows, meta: collectMetaLines(card) });
        onChange();
        return `${rows.length} rows imported from ${p.split(/[\\/]/).pop()}`;
      }
      const names = await invoke<string[]>("sheet_xlsx_sheets", { path: p });
      let sheetName: string | undefined = sheet ?? names[0];
      if (names.length > 1 && !sheet) {
        const pick = prompt(
          `workbook has ${names.length} sheets — type the one to import:\n${names.join(", ")}`,
          names[0],
        );
        if (pick === null) return "import cancelled";
        sheetName = pick.trim() || names[0];
      }
      const cells = await invoke<string[][]>("sheet_xlsx_import", {
        path: p,
        sheet: sheetName ?? null,
      });
      pushUndo();
      restore({ raws: cells, meta: collectMetaLines(card) });
      onChange();
      return `${cells.length}×${cells[0]?.length ?? 0} imported from "${sheetName}" (${p.split(/[\\/]/).pop()})`;
    } catch (e) {
      return `import failed: ${String(e)}`;
    }
  };

  apis.set(card, {
    title: () => card.dataset.topic ?? "sheet",
    rows: () => R(),
    cols: () => C(),
    raw: (r, c) => rawAt(card, r, c),
    display: (r, c) => tdAt(card, r, c)?.textContent ?? "",
    set: (r, c, raw) => {
      pushUndo();
      growTo(r, c);
      const td = tdAt(card, r, c);
      if (td) {
        td.dataset.raw = raw;
        td.textContent = raw;
      }
      repaint();
      onChange();
    },
    // bulk writes — one undo step, one recalc, no matter how many cells
    setCells: (cells) => {
      if (!Array.isArray(cells)) return;
      pushUndo();
      let mr = 0;
      let mc = 0;
      for (const [r, c] of cells) {
        mr = Math.max(mr, r);
        mc = Math.max(mc, c);
      }
      growTo(mr, mc);
      for (const [r, c, raw] of cells) {
        const td = tdAt(card, r, c);
        if (td) {
          td.dataset.raw = raw;
          td.textContent = raw;
        }
      }
      repaint();
      onChange();
    },
    setAll: (raws) => {
      pushUndo();
      restore({ raws, meta: collectMetaLines(card) });
    },
    addRow: (raws) => {
      pushUndo();
      addRow(raws);
      onChange();
    },
    addCol: () => {
      pushUndo();
      addCol();
      onChange();
    },
    delRow: (r) => {
      pushUndo();
      delRow(r);
    },
    delCol: (c) => {
      pushUndo();
      delCol(c);
    },
    clear: (a, b) => {
      pushUndo();
      clearRange(a ?? [0, 0], b ?? [R() - 1, C() - 1]);
    },
    read: () => {
      const out: string[] = [];
      for (let r = 0; r < R(); r++) {
        const line: string[] = [];
        for (let c = 0; c < C(); c++) line.push(rawAt(card, r, c));
        out.push(line.join("\t"));
      }
      return out.join("\n");
    },
    setFmt: (cells, f) => setFmtOn(cells, f),
    addCf: (col, op, val, color) => {
      pushUndo();
      const l = cfRules.get(col) ?? [];
      l.push({ op, val, color });
      cfRules.set(col, l);
      syncCfMeta();
      repaint();
      onChange();
    },
    clearCf: (col) => {
      pushUndo();
      if (col === undefined) cfRules.clear();
      else cfRules.delete(col);
      syncCfMeta();
      repaint();
      onChange();
    },
    freeze: (row, col) => setFreeze(row, col),
    hideRow: (r) => hideRow(r),
    hideCol: (c) => hideCol(c),
    unhide: () => unhideAll(),
    dedupe: (c) => dedupe(c),
    filter: (c, allowed) => {
      pushUndo();
      if (allowed === null) filters.delete(c);
      else filters.set(c, new Set(allowed));
      syncFilterMeta();
      applyFilters();
      onChange();
    },
    filterState: () =>
      filters.size
        ? Array.from(filters.entries())
            .map(([c, set]) => `${COLS(c)}: ${set.size} values shown`)
            .join("; ")
        : "no filters",
    view: (spec) => {
      if (spec !== undefined) {
        pushUndo();
        card.dataset.view = spec;
        applyView();
        onChange();
      }
      return card.dataset.view ?? "grid";
    },
    exportFile: (path) => doExport(path),
    importFile: (path, sheet) => doImport(path, sheet),
  });
}

/** spawn-time card builder — an empty grid, title in the head */
export function buildSheetCard(title: string): HTMLElement {
  title = String(title ?? "");
  const card = document.createElement("div");
  card.className = "callout sheet-card";
  card.dataset.kind = "sheet";
  card.dataset.topic = title || "sheet";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${title || "sheet"}</span></div>` +
    `<div class="sheet-wrap"></div>`;
  return card;
}
