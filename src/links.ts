/* ---------- the vault's connective tissue ----------
 * One Rust scan (vault_index) → links/headings/tags/mentions, cached here.
 * Rides on three surfaces:
 *   1. the links strip under the note — "← linked: a · b | mentions: c · d"
 *   2. Ctrl+K / Ctrl+O palette — fuzzy switcher over notes + headings +
 *      `>` commands + `#` tags (Obsidian/Switcher++ pattern)
 *   3. `@today` — open-or-create the YYYY-MM-DD daily note */

import { invoke } from "./ipc.js";
import { currentNote, markEdited } from "./editor.js";
import { openTab } from "./tabs.js";
import { fuzzy, stem } from "./match.js";
import { addActivity } from "./log.js";
import { propCmp } from "./base.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

export interface VaultIndex {
  notes: string[];
  links: [string, string][];
  heads: [string, string][];
  tags: [string, string][];
  mentions: [string, string][];
  /** (note, key, value) — frontmatter pairs for `prop:` / bases */
  props: [string, string, string][];
  modified: [string, number][];
  /** (note, bytes) — the `file.size` pseudo-prop */
  sizes: [string, number][];
  /** (note, ctime-secs) — the `file.ctime` pseudo-prop */
  created: [string, number][];
}

let index: VaultIndex | null = null;
let indexAt = 0;

/** refresh the index — cheap enough on save/load; stale ≤4s between
 *  calls. A forced refresh (post-save, tab switch) broadcasts
 *  `index:changed` so live views — bases, agenda — repaint with the
 *  new truth instead of waiting for a manual ⟳. */
export async function refreshIndex(force = false): Promise<VaultIndex> {
  if (index && !force && Date.now() - indexAt < 4000) return index;
  index = await invoke<VaultIndex>("vault_index");
  indexAt = Date.now();
  if (force) document.dispatchEvent(new CustomEvent("index:changed"));
  return index;
}

/** the cached vault index (may be null before the first refresh) */
export const vaultIndex = () => index;

let watchTimer: number | null = null;
/** light external-edit watcher — `vault_list` is stat-only (names +
 *  mtimes, no file reads), so a 4s poll costs nothing. A changed
 *  fingerprint (note count + Σmtimes) forces an index refresh, which
 *  broadcasts `index:changed` → bases, boards, agenda repaint. Edits
 *  made in-app already force-refresh on save; this catches the rest —
 *  other apps, sync tools, hand-edited files. */
export function startVaultWatcher() {
  if (watchTimer !== null) return;
  let fp = "";
  const tick = async () => {
    const list = await invoke<{ name: string; modified: number }[]>("vault_list")
      .catch(() => null);
    if (!list) return;
    const next = `${list.length}:${list.reduce((a, n) => a + n.modified, 0)}`;
    if (fp !== "" && next !== fp) void refreshIndex(true);
    fp = next;
  };
  void tick(); // seed — first tick sets the baseline, no storm
  watchTimer = window.setInterval(() => void tick(), 4000);
}

/* ---------- the links strip ---------- */

/** notes that `[[link]]` TO the current note + notes that mention it bare */
export function linkInfo(name: string): { linked: string[]; mentioned: string[] } {
  name = S(name);
  if (!index) return { linked: [], mentioned: [] };
  const t = stem(name).toLowerCase();
  const linked = index.links
    .filter(([from, to]) => stem(to).toLowerCase() === t && from !== name)
    .map(([from]) => from);
  const mentioned = index.mentions
    .filter(([_n, s]) => s.toLowerCase() === t)
    .map(([n]) => n)
    .filter((n) => n !== name && !linked.includes(n));
  return { linked: dedupe(linked), mentioned: dedupe(mentioned) };
}

const dedupe = (a: string[]) => Array.from(new Set(a));

export function paintLinkStrip() {
  const el = document.getElementById("linkstrip");
  if (!el) return;
  const cur = currentNote();
  if (!cur) {
    el.innerHTML = "";
    return;
  }
  const { linked, mentioned } = linkInfo(cur);
  const chip = (n: string, cls: string) =>
    `<button class="lk-chip ${cls}" data-note="${n.replace(/"/g, "&quot;")}" title="${n.replace(/"/g, "&quot;")}">${stem(n)}</button>`;
  const parts: string[] = [];
  if (linked.length)
    parts.push(`<span class="lk-label">← linked</span>` + linked.map((n) => chip(n, "lk-in")).join(""));
  if (mentioned.length)
    parts.push(`<span class="lk-label">mentions</span>` + mentioned.map((n) => chip(n, "lk-mention")).join(""));
  if (linked.length || mentioned.length)
    parts.push(`<button class="lk-more" title="open the backlinks rail — every linking line">⇤ ${linked.length + mentioned.length}</button>`);
  el.innerHTML = parts.join("");
  el.querySelector<HTMLElement>(".lk-more")?.addEventListener("click", () => void paintBacklinks());
  el.classList.toggle("empty", !linked.length && !mentioned.length);
  el.querySelectorAll<HTMLElement>(".lk-chip").forEach((c) => {
    c.addEventListener("click", () => void openTab(c.dataset.note ?? ""));
  });
}

/* ---------- fuzzy match (subsequence, boundary/consecutive bonuses) ---------- */

/* ---------- Ctrl+K / Ctrl+O palette ---------- */

interface Item {
  kind: "note" | "head" | "cmd" | "tag" | "hit";
  label: string;
  sub: string;
  run: (mode: "open" | "tab" | "create") => void | Promise<void>;
  /** completion items rewrite the input instead of dismissing it */
  sticky?: boolean;
}

interface FindHit {
  note: string;
  line: number;
  snippet: string;
}

export function initPalette() {
  const ov = document.getElementById("palette");
  const inp = document.getElementById("palette-in") as HTMLInputElement | null;
  const list = document.getElementById("palette-list");
  if (!ov || !inp || !list) return;
  let sel = 0;
  let items: Item[] = [];

  const open = () => {
    ov.classList.remove("hidden");
    inp.value = "";
    sel = 0;
    render("");
    inp.focus();
  };
  const close = () => ov.classList.add("hidden");
  startVaultWatcher();
  // operator hints — the palette gets the same datalist as base `q:`:
  // typing `is:`/`prop:`/`#`/`-`/`/` surfaces completions on the fly
  if (!inp.getAttribute("list")) {
    const dl = document.createElement("datalist");
    dl.id = "pal-ops";
    document.body.append(dl);
    inp.setAttribute("list", dl.id);
    inp.addEventListener("focus", () => {
      void invoke<{ props?: [string, string, string][] }>("vault_index").then((ix) => {
        const keys = new Set<string>();
        for (const [, k] of ix?.props ?? []) keys.add(k);
        const sugg = [
          ...["overdue", "today", "week", "nodate", "daily", "template", "persona", "task", "done", "card"]
            .map((p) => `is:${p}`),
          ...[...keys].map((k) => `prop:${k}=`),
          ...["file.name", "file.mtime", "file.size", "file.backlinks"].map((k) => `prop:${k}`),
        ];
        dl.innerHTML = sugg.map((s) => `<option value="${s}">`).join("");
      }).catch(() => {});
    });
  }

  const noteItem = (n: string, sub = ""): Item => ({
    kind: "note",
    label: stem(n),
    sub,
    run: async (mode) => {
      if (mode === "create") {
        // Shift+Enter creates an exact-name note
        const file = /\.(laido|md)$/.test(inp.value.trim()) ? inp.value.trim() : `${inp.value.trim()}.laido`;
        await invoke("vault_write", { name: file, content: "" });
        void refreshIndex(true);
        await openTab(file);
      } else {
        await openTab(n);
      }
    },
  });

  const commands: Item[] = [
    { kind: "cmd", label: "today", sub: "open today's daily note", run: () => openToday() },
    { kind: "cmd", label: "new note", sub: "blank note in a new tab", run: async () => {
      const file = `note-${Date.now() % 100000}.laido`;
      await invoke("vault_write", { name: file, content: "" });
      void refreshIndex(true);
      await openTab(file);
    } },
    { kind: "cmd", label: "new sheet", sub: "spreadsheet card on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "sheet" })); } },
    { kind: "cmd", label: "new deck", sub: "slides card on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "slides" })); } },
    { kind: "cmd", label: "new chart", sub: "data-viz card on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "chart" })); } },
    { kind: "cmd", label: "new todo", sub: "task list on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "todo" })); } },
    { kind: "cmd", label: "new browser", sub: "web card on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "browser" })); } },
    { kind: "cmd", label: "new cards", sub: "flashcards deck on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "cards" })); } },
    { kind: "cmd", label: "new map", sub: "mind map on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "map" })); } },
    { kind: "cmd", label: "new graph", sub: "force-directed map of the vault's [[links]]", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "graph" })); } },
    { kind: "cmd", label: "new canvas", sub: "freeform drawing card on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "canvas" })); } },
    { kind: "cmd", label: "new base", sub: "table view over note properties (prop: filters)", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "base" })); } },
    { kind: "cmd", label: "properties", sub: "frontmatter key: value panel on this note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "props" })); } },
    { kind: "cmd", label: "rename property", sub: "rename a --- key across the whole vault", run: async () => {
      const old = prompt("rename which property? (the --- key)", "");
      if (!old?.trim()) return;
      const next = prompt(`rename “${old.trim()}” to`, old.trim());
      if (!next?.trim() || next.trim() === old.trim()) return;
      const n = await invoke<number>("vault_prop_rename", { old: old.trim(), new: next.trim() })
        .catch((e: unknown) => { addActivity(`rename failed — ${String(e)}`); return -1; });
      if (n >= 0) addActivity(`renamed ${old.trim()} → ${next.trim()} in ${n} note${n === 1 ? "" : "s"} (> history undoes)`);
      void refreshIndex(true);
    } },
    { kind: "cmd", label: "agenda", sub: "due tasks + flashcards across the vault", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "agenda" })); } },
    { kind: "cmd", label: "new persona", sub: "persona-<name> note — @persona <name> chats as it", run: async () => {
      const file = `persona-${Date.now() % 1000}.laido`;
      await invoke("vault_write", { name: file, content: "# persona\n\nYou are a role. Describe voice, expertise, and style here — every `@persona <name>` chat adopts it.\n\n- expertise: \n- tone: \n- always: \n- never: \n" });
      void refreshIndex(true);
      await openTab(file);
    } },
    { kind: "cmd", label: "history", sub: "restore a snapshot of this note", run: () => { void openHistory(); } },
    { kind: "cmd", label: "backlinks", sub: "every line that links or mentions this note", run: () => { void paintBacklinks(); } },
    { kind: "cmd", label: "digest", sub: "spoken brief of everything due", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "digest" })); } },
    { kind: "cmd", label: "linkify", sub: "wrap bare note-title mentions in [[links]]", run: () => { void linkifyNote(); } },
    { kind: "cmd", label: "speak", sub: "read the selection (or note) aloud", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "speak" })); } },
    { kind: "cmd", label: "research", sub: "@research <topic> — agent dig on the note", run: () => { document.dispatchEvent(new CustomEvent("palette:cmd", { detail: "research" })); } },
  ];

  const paint = () => {
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items
      .map((it, i) => {
        const ic = { note: "◦", head: "#", cmd: "›", tag: "#", hit: "⌕" }[it.kind];
        return `<div class="pl-item${i === sel ? " on" : ""}${it.sticky ? " stk" : ""}" data-i="${i}"><span class="pl-ic">${ic}</span><span class="pl-l">${it.label}</span><span class="pl-s">${it.sub}</span></div>`;
      })
      .join("") ||
      `<div class="pl-item"><span class="pl-ic">＋</span><span class="pl-l">${(inp.value.replace(/^[>#?]\s*/, "").trim()) || "new note"}</span><span class="pl-s">Shift+Enter to create</span></div>`;
    list.querySelectorAll<HTMLElement>(".pl-item[data-i]").forEach((el) => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pick(Number(el.dataset.i), e.ctrlKey ? "tab" : "open");
      });
    });
  };

  let findSeq = 0;
  const render = (q0: string) => {
    const ix = index;
    const q = q0.trim();
    const mode = q.startsWith(">") ? "cmd" : q.startsWith("#") ? "tag" : q.startsWith("?") ? "find" : "all";
    const needle = q.replace(/^[>#?]\s*/, "").trim();

    // `?` mode — vault-wide CONTENT search; async hits paint into the
    // list. `tag:x` tokens filter hits to notes carrying #x (index tags).
    if (mode === "find") {
      const seq = ++findSeq;
      // `/re/` spans are opaque — pull them out first so `-`/`is:`/`tag:`
      // extraction never mangles a pattern like /foo-bar/
      const regexes = [...needle.matchAll(/(?:^|\s)(\/[^/]+\/)/g)].map((m) => m[1]);
      const bare = needle.replace(/(?:^|\s)\/[^/]+\//g, " ");
      const tags = [...bare.matchAll(/(?:^|\s)tag:([\w-]+)/g)].map((m) => m[1].toLowerCase());
      const terms = bare.replace(/(?:^|\s)tag:[\w-]+/g, " ").trim();
      // notes carrying every requested tag
      let tagNotes: Set<string> | null = null;
      for (const tg of tags) {
        const withTag = new Set<string>(
          (ix?.tags ?? []).filter(([t]) => t.toLowerCase() === tg).map(([, n]) => n),
        );
        const prev = tagNotes as Set<string> | null;
        tagNotes = prev === null
          ? withTag
          : new Set([...prev].filter((n) => withTag.has(n)));
      }
      // `is:x` property filters — each resolves to a note set; hits must
      // belong to every set. is:daily/template/persona answer from the
      // index; is:task/done/card run content probes (vault_find is a
      // substring match, so "- [ ]" and "[!" work as literals).
      const isToks = [...terms.matchAll(/(?:^|\s)(-?)is:([\w-]+)/g)]
        .map((m) => ({ neg: !!m[1], p: m[2].toLowerCase() }));
      // `prop:key[=val]` — frontmatter property filters; the Rust side
      // scans only the top `---` block so body `key: v` lines can't hit.
      // `-prop:`/`-is:` negate — the `-` belongs to the token, not word-neg
      const PROP_RE = /(?:^|\s)(-?)prop:([\w.-]+(?:\s*(?:>=|<=|!=|==?|>|<)\s*(?:"[^"]*"|\S+))?)/g;
      const propToks = [...terms.matchAll(PROP_RE)].map((m) => ({ neg: !!m[1], p: m[2] }));
      const rest = terms
        .replace(/(?:^|\s)-?is:[\w-]+/g, " ")
        .replace(PROP_RE, " ")
        .trim();
      // operator completions — a trailing partial `is:x` / `prop:k` /
      // `prop:k=v` lists the grammar as sticky items that rewrite the
      // input in place (the palette stays open — datalist can't do that)
      const sugs: Item[] = [];
      const tailM = needle.match(/-?(?:is|prop|tag):[\w.-]*(?:[=<>!]=?"?[^"]*)?$/);
      if (tailM) {
        const tail = tailM[0];
        const neg = tail.startsWith("-") ? "-" : "";
        const pm = tail.slice(neg.length).match(/^(is|prop|tag):([\w.-]*)((?:[=<>!]=?)?)"?(.*)$/);
        const complete = (full: string, sub: string): Item => ({
          kind: "cmd", label: neg + full, sub, sticky: true,
          run: () => {
            const at = inp.value.lastIndexOf(tail);
            inp.value = inp.value.slice(0, at) + neg + full;
            inp.focus(); sel = 0; render(inp.value);
          },
        });
        if (pm) {
          const [, op, key, sep, vpart] = pm;
          const pre = (s: string) => s.toLowerCase().startsWith(key.toLowerCase());
          if (op === "is" && !sep)
            for (const p of ["overdue", "today", "week", "nodate", "daily", "template", "persona", "task", "done", "card", "orphan", "deadend", "hub"])
              if (pre(p)) sugs.push(complete(`is:${p}`, "predicate — Enter completes the token"));
          if (op === "tag" && !sep)
            for (const [t] of ix?.tags ?? [])
              if (pre(t) && sugs.length < 8) sugs.push(complete(`tag:${t}`, "#tag filter"));
          if (op === "prop" && !sep) {
            const keys = new Set<string>();
            for (const [, k] of ix?.props ?? []) keys.add(k);
            for (const k of ["file.name", "file.mtime", "file.size", "file.backlinks", "file.outlinks"]) keys.add(k);
            for (const k of [...keys].sort())
              if (pre(k) && sugs.length < 8) sugs.push(complete(`prop:${k}=`, "property filter — add a value"));
          }
          if (op === "prop" && sep === "=") {
            const vals = new Set<string>();
            for (const [, k, v] of ix?.props ?? [])
              if (k.toLowerCase() === key.toLowerCase() && v) vals.add(v);
            for (const v of [...vals].sort())
              if (v.toLowerCase().startsWith(vpart.toLowerCase()) && sugs.length < 8)
                sugs.push(complete(`prop:${key}=${v.includes(" ") ? `"${v}"` : v}`, `value of ${key}`));
          }
        }
      }
      const finish = () => { items = sugs.concat(items); paint(); };
      const isSet = async (p: string): Promise<Set<string>> => {
        const idx = isSetFromIndex(p, ix?.notes ?? []);
        if (idx) return idx;
        const dates = isDateSet(p, ix?.props ?? [], ix?.notes ?? []);
        if (dates) return dates;
        const lnks = isLinkSet(p, ix?.links ?? [], ix?.notes ?? []);
        if (lnks) return lnks;
        const out = new Set<string>();
        const probe = isProbe(p);
        if (probe) {
          const hs = await invoke<FindHit[]>("vault_find", { query: probe }).catch(() => []);
          for (const h of hs) out.add(h.note);
        }
        // frontmatter inheritance — `is:X` also matches notes declaring
        // `X: true` or `status: X` in their properties block
        for (const q of isFmQueries(p)) {
          const hs = await invoke<FindHit[]>("vault_find", { query: q }).catch(() => []);
          for (const h of hs) out.add(h.note);
        }
        return out;
      };
      if (tagNotes && isToks.length === 0 && propToks.length === 0 && rest.length < 2 && regexes.length === 0) {
        // tag-only query → the tagged notes themselves are the hits
        items = [...tagNotes].map((n) => ({
          kind: "note" as const,
          label: stem(n),
          sub: `tagged ${tags.map((t) => "#" + t).join(" ")}`,
          run: () => openTab(n),
        }));
        finish();
        return;
      }
      // `-word` exclusion: notes containing the term drop out entirely
      const negs = [...rest.matchAll(/(?:^|\s)-([\w-]+)/g)].map((m) => m[1].toLowerCase());
      const core = rest.replace(/(?:^|\s)-[\w-]+/g, " ").trim();
      if (core.length < 2 && isToks.length === 0 && propToks.length === 0 && regexes.length === 0) {
        items = [];
        finish();
        return;
      }
      void (async () => {
        // a note containing ANY negated term is excluded
        const excl = new Set<string>();
        for (const nt of negs) {
          const bad = await invoke<FindHit[]>("vault_find", { query: nt }).catch(() => []);
          for (const h of bad) excl.add(h.note);
        }
        let isNotes: Set<string> | null = null;
        const isExcl = new Set<string>();
        for (const t of isToks) {
          const withP = await isSet(t.p);
          if (t.neg) { for (const n of withP) isExcl.add(n); continue; }
          const prev2 = isNotes as Set<string> | null;
          isNotes = prev2 === null ? withP : new Set([...prev2].filter((n) => withP.has(n)));
        }
        // prop:key[=val] → frontmatter-scoped probe per token, ANDed.
        // file.* keys resolve off the index instead (never in fm).
        let propNotes: Set<string> | null = null;
        const propExcl = new Set<string>();
        const fileVal = (k: string, n: string): string | undefined => {
          const mt = ix?.modified.find(([nn]) => nn === n)?.[1] ?? 0;
          const sz = ix?.sizes?.find(([nn]) => nn === n)?.[1] ?? 0;
          const ct = ix?.created?.find(([nn]) => nn === n)?.[1] ?? 0;
          switch (k) {
            case "file.name": case "file.stem": return stem(n);
            case "file.ext": return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
            case "file.mtime": case "file.modified": return mt ? new Date(mt * 1000).toISOString().slice(0, 10) : "";
            case "file.ctime": case "file.created": return ct ? new Date(ct * 1000).toISOString().slice(0, 10) : "";
            case "file.size": return String(sz);
            // links targets are raw [[stems]] — normalize both sides
            case "file.backlinks":
              return String((ix?.links ?? []).filter(([, to]) => stem(to) === stem(n)).length);
            case "file.outlinks":
              return String((ix?.links ?? []).filter(([from]) => stem(from) === stem(n)).length);
            default: return undefined;
          }
        };
        for (const t of propToks) {
          const pm = t.p.match(/^([\w.-]+)(>=|<=|!=|==?|>|<)?(.*)$/);
          const set = new Set<string>();
          if (pm && pm[1].toLowerCase().startsWith("file.")) {
            for (const n of ix?.notes ?? []) {
              const fv = fileVal(pm[1].toLowerCase(), n);
              if (fv === undefined) break;
              const w = (pm[3] ?? "").replace(/^"|"$/g, "");
              if (!pm[2]) { if (fv) set.add(n); }
              else if (propCmp(fv, pm[2], w)) set.add(n);
            }
          } else {
            const hs = await invoke<FindHit[]>("vault_find", { query: `prop:${t.p}` }).catch(() => []);
            for (const h of hs) set.add(h.note);
          }
          if (t.neg) { for (const n of set) propExcl.add(n); continue; }
          const prev4 = propNotes as Set<string> | null;
          propNotes = prev4 === null ? set : new Set([...prev4].filter((n) => set.has(n)));
        }
        // each /re/ is its own probe; results AND at the note level
        let reNotes: Set<string> | null = null;
        let reHits: FindHit[] = [];
        for (const rx of regexes) {
          const hh = await invoke<FindHit[]>("vault_find", { query: rx }).catch(() => []);
          const set = new Set(hh.map((h) => h.note));
          const prev3 = reNotes as Set<string> | null;
          reNotes = prev3 === null ? set : new Set([...prev3].filter((n) => set.has(n)));
          reHits = reHits.concat(hh);
        }
        if (seq !== findSeq) return;
        const passNote = (n: string) =>
          (!tagNotes || tagNotes.has(n)) &&
          (!isNotes || isNotes.has(n)) &&
          (!propNotes || propNotes.has(n)) &&
          (!reNotes || reNotes.has(n)) &&
          !excl.has(n) && !isExcl.has(n) && !propExcl.has(n);
        if (core.length < 2) {
          if (!regexes.length) {
            // is-/prop-only query → the matching notes themselves are hits
            const union = new Set<string>([...(isNotes ?? []), ...(propNotes ?? [])]);
            const notes = [...union].filter(passNote);
            items = notes.map((n) => ({
              kind: "note" as const,
              label: stem(n),
              sub: isToks.length
                ? isToks.map((t) => `${t.neg ? "-" : ""}is:${t.p}`).join(" ")
                : propToks.map((t) => `${t.neg ? "-" : ""}prop:${t.p}`).join(" "),
              run: () => openTab(n),
            }));
            finish();
            return;
          }
          // regex-only → show the regex line hits directly
          items = reHits
            .filter((h) => passNote(h.note))
            .map((h) => ({
              kind: "hit" as const,
              label: h.snippet,
              sub: `${stem(h.note)}:${h.line}`,
              run: () => openTab(h.note),
            }));
          finish();
          return;
        }
        const hits = await invoke<FindHit[]>("vault_find", { query: core }).catch(() => []);
        if (seq !== findSeq) return; // a newer query superseded this one
        items = hits
          .filter((h) => passNote(h.note))
          .map((h) => ({
            kind: "hit" as const,
            label: h.snippet,
            sub: `${stem(h.note)}:${h.line}`,
            run: () => openTab(h.note),
          }));
        finish();
      })();
      return;
    }

    const scored: [Item, number][] = [];
    if (mode === "cmd" || (mode === "all" && needle)) {
      for (const c of commands) {
        const sc = fuzzy(needle, c.label);
        if (sc >= 0) scored.push([c, sc + (mode === "cmd" ? 500 : 0)]);
      }
    }
    if (mode === "tag") {
      const seen = new Set<string>();
      for (const [tag] of ix?.tags ?? []) {
        if (seen.has(tag)) continue;
        const sc = fuzzy(needle, tag);
        if (sc >= 0) {
          seen.add(tag);
          scored.push([{ kind: "tag", label: `#${tag}`, sub: `${(ix?.tags ?? []).filter(([t]) => t === tag).length} notes`, run: async () => {
            // open the first note carrying the tag; the palette stays a
            // finder, not a filter view — full tag pages are W3
            const hit = (ix?.tags ?? []).find(([t]) => t === tag);
            if (hit) await openTab(hit[1]);
          } }, sc + 400]);
        }
      }
    }
    if (mode !== "cmd") {
      for (const n of ix?.notes ?? []) {
        let sc = fuzzy(needle, stem(n)) + 100;
        if (mode === "tag") sc -= 100; // deprioritize under #
        if (sc >= 0) scored.push([noteItem(n, ""), sc]);
      }
      if (needle) {
        for (const [n, h] of ix?.heads ?? []) {
          const sc = fuzzy(needle, h);
          if (sc >= 0)
            scored.push([{ kind: "head", label: h, sub: stem(n), run: () => openTab(n) }, sc]);
        }
      }
    }
    if (!needle) {
      // recents — mtime order already newest-first in ix.notes
      items = (ix?.notes ?? []).slice(0, 12).map((n) => noteItem(n, "recent"));
    } else {
      scored.sort((a, b) => b[1] - a[1]);
      items = scored.slice(0, 14).map(([it]) => it);
    }
    paint();
  };

  const pick = (i: number, mode: "open" | "tab" | "create") => {
    const it = items[i];
    if (!it?.sticky) close();
    if (it) void it.run(mode);
    else if (mode === "create") void noteItem(inp.value.trim()).run("create");
  };

  inp.addEventListener("input", () => { sel = 0; render(inp.value); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, Math.min(items.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)));
      render(inp.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const mode = e.shiftKey ? "create" : e.ctrlKey || e.metaKey ? "tab" : "open";
      if (items[sel]) pick(sel, mode);
      else if (mode === "create") void noteItem(inp.value.trim()).run("create");
    } else if (e.key === "Escape") {
      close();
    }
  });
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "o")) {
      e.preventDefault();
      void refreshIndex().then(open);
    }
    // Ctrl+Shift+F — vault-wide content search: the palette in `?` mode
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      void refreshIndex().then(() => {
        open();
        inp.value = "?";
        render("?");
      });
    }
  });
  (window as unknown as { openPalette: () => void }).openPalette = () => void refreshIndex().then(open);
}

/* ---------- @today — daily note ---------- */

/** open-or-create YYYY-MM-DD.laido, seeded from a `templates/daily` note */
const todayFile = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.laido`;
};

const dailySkeleton = (iso: string) =>
  `# ${iso}\n\n## Tasks\n\n- [ ] \n\n## Notes\n\n`;

/** open-or-create today's note */
export async function openToday(): Promise<void> {
  const file = todayFile();
  const ix = await refreshIndex(true);
  if (!ix.notes.includes(file)) {
    // template seed: `templates/daily.laido|md` when present
    let bodyMd = dailySkeleton(file.replace(/\.laido$/, ""));
    // vault names are flat — a note literally named daily-template
    // (or template-daily) seeds new daily notes
    const tpl = ix.notes.find((n) => /^(daily[-_ ]?template|template[-_ ]?daily)$/i.test(stem(n)));
    if (tpl) {
      try {
        bodyMd = await invoke<string>("vault_read", { name: tpl });
      } catch { /* keep the skeleton */ }
    }
    await invoke("vault_write", { name: file, content: bodyMd });
  }
  await openTab(file);
}

/** append a web clip (quote + source) to today's daily note — creates the
 *  note (template-seeded) when absent. The capture-pipe for `clip today`. */
export async function clipToDaily(title: string, url: string, text: string): Promise<string> {
  const file = todayFile();
  let cur: string;
  try {
    cur = await invoke<string>("vault_read", { name: file });
  } catch {
    const ix = await refreshIndex(true);
    const tpl = ix.notes.find((n) => /^(daily[-_ ]?template|template[-_ ]?daily)$/i.test(stem(n)));
    cur = tpl ? await invoke<string>("vault_read", { name: tpl }) : dailySkeleton(file.replace(/\.laido$/, ""));
  }
  const quote = text
    .split("\n")
    .map((l) => `> ${l.trimEnd()}`.trimEnd())
    .join("\n");
  const src = `> — [${title.replace(/[\[\]\n]/g, " ")}](${url})`;
  await invoke("vault_write", { name: file, content: `${cur.trimEnd()}\n\n${quote}\n${src}\n` });
  void refreshIndex(true);
  return `clipped ${text.length} chars → ${file}`;
}

/* ---------- outline rail — the open note's heading tree ----------
 * `≡` toggles a right rail of h1–h3 (headings inside widgets/embeds are
 * excluded — they belong to cards, not the note). Click scrolls +
 * flashes the heading. Rebuilt on a debounced MutationObserver while
 * the rail is open. */
let outlineObs: MutationObserver | null = null;
let dragSec: HTMLElement | null = null;

/** a heading's section: the heading + every sibling until the next
 *  heading of the same-or-higher level (h2 swallows its h3s) */
function sectionEls(h: HTMLElement): HTMLElement[] {
  const lvl = Number(h.tagName[1]);
  const els = [h];
  let nx = h.nextElementSibling as HTMLElement | null;
  while (nx) {
    if (/^H[123]$/.test(nx.tagName) && Number(nx.tagName[1]) <= lvl) break;
    els.push(nx);
    nx = nx.nextElementSibling as HTMLElement | null;
  }
  return els;
}

/** drop the dragged section just before the target section */
function moveSection(src: HTMLElement, dst: HTMLElement) {
  const host = src.parentElement;
  if (!host || host !== dst.parentElement) return;
  const moving = sectionEls(src);
  if (moving.includes(dst)) return; // can't drop a section into itself
  host.insertBefore(moving[0], dst); // anchor first — order is stable
  let anchor: HTMLElement = moving[0];
  for (const el of moving.slice(1)) {
    anchor.after(el);
    anchor = el;
  }
  markEdited();
  refreshOutline();
}

export function refreshOutline() {
  const rail = document.getElementById("outline-rail");
  if (!rail || rail.classList.contains("hidden")) return;
  if (rail.dataset.mode) return; // history/backlinks own the rail
  const host = document.getElementById("note-body");
  if (!host) return;
  const heads = Array.from(host.querySelectorAll<HTMLElement>("h1, h2, h3")).filter(
    (h) => !h.closest(".callout, .note-embed"),
  );
  rail.innerHTML = heads.length
    ? ""
    : `<div class="or-empty">no headings — use # / ## / ###</div>`;
  for (const h of heads) {
    const lvl = Number(h.tagName[1]);
    const b = document.createElement("button");
    b.className = `or-h or-h${lvl}`;
    b.textContent = h.textContent?.trim() || "—";
    b.addEventListener("click", () => {
      h.scrollIntoView({ block: "center", behavior: "smooth" });
      h.classList.remove("or-flash");
      void h.offsetWidth; // restart the flash animation
      h.classList.add("or-flash");
    });
    // drag a heading row → its whole section moves in the note (the
    // section = heading + siblings until the next same-or-higher heading)
    b.draggable = true;
    b.addEventListener("dragstart", (e) => {
      dragSec = h;
      e.dataTransfer?.setData("text/plain", h.textContent ?? "");
      e.dataTransfer?.setDragImage(b, 8, 8);
    });
    b.addEventListener("dragover", (e) => {
      e.preventDefault();
      b.classList.add("or-drop");
    });
    b.addEventListener("dragleave", () => b.classList.remove("or-drop"));
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      b.classList.remove("or-drop");
      if (dragSec && dragSec !== h) moveSection(dragSec, h);
      dragSec = null;
    });
    b.addEventListener("dragend", () => { dragSec = null; });
    rail.append(b);
  }
}
export function initOutline() {
  const btn = document.getElementById("btn-outline");
  const rail = document.getElementById("outline-rail");
  if (!btn || !rail) return;
  let deb: ReturnType<typeof setTimeout> | null = null;
  btn.addEventListener("click", () => {
    rail.classList.toggle("hidden");
    document.getElementById("note-body")?.classList.toggle("or-open");
    if (!rail.classList.contains("hidden")) {
      delete rail.dataset.mode;
      refreshOutline();
      const host = document.getElementById("note-body");
      if (host && !outlineObs) {
        outlineObs = new MutationObserver(() => {
          if (deb) clearTimeout(deb);
          deb = setTimeout(refreshOutline, 400);
        });
        outlineObs.observe(host, { childList: true, subtree: true, characterData: true });
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
      e.preventDefault();
      btn.click();
    }
  });
  document.addEventListener("laido:outline", () => refreshOutline());
}

/* ---------- note history — .history/<stem>/<ms>.laido snapshots ----------
 * the palette `> history` command opens a snapshot list for the open
 * note; picking one writes it back (vault_write snapshots the CURRENT
 * content first — restoring never loses the present). */
/* ---------- `is:` search predicates — note-set filters for `?` mode ----
 * index-only predicates answer without touching the disk; the rest map
 * to a vault_find substring probe. */
export function isSetFromIndex(p: string, notes: string[]): Set<string> | null {
  p = S(p);
  if (!Array.isArray(notes)) notes = [];
  if (p === "daily")
    return new Set(notes.filter((n) => /^\d{4}-\d{2}-\d{2}/.test(stem(n))));
  if (p === "template" || p === "tpl")
    return new Set(
      notes.filter((n) => {
        const s = stem(n).toLowerCase();
        return s.startsWith("tpl-") || s.startsWith("template-") || s.endsWith("-template");
      }),
    );
  if (p === "persona")
    return new Set(notes.filter((n) => stem(n).toLowerCase().startsWith("persona-")));
  return null;
}

/** date-prop `is:` predicates — `is:overdue`/`is:today`/`is:week` scan a
 * note's fm date-ish keys against today; `is:nodate` inverts it. Answered
 * straight off the index's prop triples — zero file reads. */
export function isDateSet(
  p: string,
  props: [string, string, string][],
  notes: string[],
): Set<string> | null {
  p = S(p);
  if (!Array.isArray(props)) props = [];
  if (!Array.isArray(notes)) notes = [];
  const KEYS = ["due", "deadline", "date", "scheduled", "on"];
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 6 * 86400e3).toISOString().slice(0, 10);
  // stem-dated daily notes count as their date — but only for
  // today/week, not overdue (every past daily would flood the list)
  const dayOf = (n: string, stemFallback: boolean): string => {
    for (const row of props) {
      if (!Array.isArray(row)) continue;
      const [nn, k, v] = row.map((x) => S(x));
      if (nn !== n || !KEYS.includes(k.toLowerCase())) continue;
      const d = v.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (d) return d;
    }
    return stemFallback ? stem(n).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "" : "";
  };
  if (p === "overdue" || p === "late")
    return new Set(notes.filter((n) => { const d = dayOf(n, false); return d !== "" && d < today; }));
  if (p === "today" || p === "due")
    return new Set(notes.filter((n) => dayOf(n, true) === today));
  if (p === "week" || p === "soon")
    return new Set(notes.filter((n) => { const d = dayOf(n, true); return d >= today && d <= week; }));
  if (p === "nodate")
    return new Set(notes.filter((n) => dayOf(n, false) === ""));
  return null;
}

/** graph-topology `is:` predicates — `is:orphan` (nothing links in),
 * `is:deadend` (links out to nothing), `is:hub` (3+ inbound). Counted
 * off index.links — same rule as file.backlinks/file.outlinks. */
export function isLinkSet(p: string, links: [string, string][], notes: string[]): Set<string> | null {
  p = S(p);
  if (!Array.isArray(links)) links = [];
  if (!Array.isArray(notes)) notes = [];
  const want = { orphan: 1, deadend: 1, hub: 1 }[p];
  if (!want) return null;
  const inL = new Map<string, number>(), outL = new Map<string, number>();
  for (const row of links) {
    if (!Array.isArray(row)) continue;
    const [from, to] = row.map((x) => S(x));
    // targets are raw [[stems]]; normalize everything to stems
    inL.set(stem(to), (inL.get(stem(to)) ?? 0) + 1);
    outL.set(stem(from), (outL.get(stem(from)) ?? 0) + 1);
  }
  if (p === "orphan") return new Set(notes.filter((n) => !inL.get(stem(n))));
  if (p === "deadend") return new Set(notes.filter((n) => !outL.get(stem(n))));
  return new Set(notes.filter((n) => (inL.get(stem(n)) ?? 0) >= 3));
}

/** `is:` kinds that need a content probe → the substring to search for */
export function isProbe(p: string): string | null {
  if (p === "task") return "- [ ]";
  if (p === "done") return "- [x]";
  if (p === "card" || p === "widget") return "[!";
  return null;
}

/** frontmatter inheritance — `is:X` also hits notes with `X: true`
 * (`is:done` → `done: true` checkboxes) or `status: X` (`is:wip` →
 * `status: wip`), on top of any content probe */
export function isFmQueries(p: string): string[] {
  p = S(p);
  return [`prop:${p}=true`, `prop:status=${p}`];
}

/* ---------- linkify — bare mentions become real wikilinks ----------
 * vault_index already knows which stems the open note mentions without
 * brackets; we rewrite the raw markdown (fences and existing links are
 * skipped; alias keeps the user's casing) then write it back — which
 * snapshots the old content, so a bad linkify is one palette hop away
 * from being undone. */
/** wrap bare `stem` mentions in a line's non-link segments — pure */
export function linkifyLine(line: string, stems: string[]): [string, number] {
  line = S(line);
  if (!Array.isArray(stems)) stems = [];
  let count = 0;
  const out = line
    .split(/(\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\))/)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // inside a link/embed — leave it
      let s = seg;
      for (const stm of stems) {
        if (typeof stm !== "string" || !stm) continue;
        const re = new RegExp(
          `(?<![\\w/\\[#])(${stm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w\\]])`,
          "gi",
        );
        s = s.replace(re, (m) => {
          count++;
          return m === stm ? `[[${stm}]]` : `[[${stm}|${m}]]`;
        });
      }
      return s;
    })
    .join("");
  return [out, count];
}

export async function linkifyNote() {
  const note = currentNote();
  if (!note) return;
  const ix = await refreshIndex().catch(() => null);
  if (!ix) return;
  const selfStem = stem(note);
  const stems = [
    ...new Set(
      (ix.mentions ?? [])
        .filter(([n]) => n === note)
        .map(([, s]) => s)
        .filter((s) => s && s.length >= 3 && s !== selfStem), // never self-link
    ),
  ];
  if (!stems.length) {
    document.dispatchEvent(new CustomEvent("laido:toast", { detail: "no unlinked mentions here" }));
    return;
  }
  const md = await invoke<string>("vault_read", { name: note }).catch(() => null);
  if (md === null) return;
  let count = 0;
  let inFence = false;
  const out = md.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const [l, n] = linkifyLine(line, stems);
    count += n;
    return l;
  });
  if (!count) {
    document.dispatchEvent(new CustomEvent("laido:toast", { detail: "no unlinked mentions here" }));
    return;
  }
  await invoke("vault_write", { name: note, content: out.join("\n") });
  document.dispatchEvent(new CustomEvent("laido:toast", { detail: `linked ${count} mention${count > 1 ? "s" : ""}` }));
  document.dispatchEvent(new CustomEvent("laido:reload"));
}

/* ---------- backlinks rail — Obsidian's linked + unlinked mentions ----
 * The linkstrip chips say WHO; this says WHAT — every line that links
 * or mentions the open note, grouped per source note, click to jump. */
export async function paintBacklinks() {
  const rail = document.getElementById("outline-rail");
  const note = currentNote();
  if (!rail || !note) return;
  rail.dataset.mode = "links";
  rail.classList.remove("hidden");
  document.getElementById("note-body")?.classList.add("or-open");
  const s = stem(note);
  rail.innerHTML = `<div class="or-empty">backlinks — ${s}…</div>`;
  // every line containing the stem, then split: lines carrying
  // `[[stem`/![[stem` are linked mentions, the rest are unlinked
  const hits = await invoke<FindHit[]>("vault_find", { query: s }).catch(() => []);
  if (rail.dataset.mode !== "links") return; // user switched mode mid-scan
  const linkRe = new RegExp(`!?\\[\\[\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[\\]|#]`, "i");
  const groups = new Map<string, { linked: FindHit[]; unlinked: FindHit[] }>();
  for (const h of hits) {
    if (h.note === note) continue; // self-mentions don't count
    const g = groups.get(h.note) ?? { linked: [], unlinked: [] };
    (linkRe.test(h.snippet) ? g.linked : g.unlinked).push(h);
    groups.set(h.note, g);
  }
  rail.innerHTML = "";
  const head = document.createElement("div");
  head.className = "bl-head";
  head.innerHTML = `<span>backlinks — <b>${s}</b></span><button class="bl-x" title="back to outline">✕</button>`;
  head.querySelector(".bl-x")!.addEventListener("click", () => {
    delete rail.dataset.mode;
    refreshOutline();
  });
  rail.append(head);
  const sect = (label: string, cls: string, notes: [string, FindHit[]][]) => {
    if (!notes.length) return;
    const h = document.createElement("div");
    h.className = "bl-sect";
    h.textContent = `${label} (${notes.reduce((a, [, hs]) => a + hs.length, 0)})`;
    rail.append(h);
    for (const [n, hs] of notes) {
      const d = document.createElement("div");
      d.className = `bl-note ${cls}`;
      const btn = document.createElement("button");
      btn.className = "bl-name";
      btn.textContent = stem(n);
      btn.addEventListener("click", () => void openTab(n));
      d.append(btn);
      for (const h of hs) {
        const ln = document.createElement("button");
        ln.className = "bl-line";
        ln.textContent = h.snippet;
        ln.title = `${n}:${h.line}`;
        ln.addEventListener("click", () => void openTab(n));
        d.append(ln);
      }
      rail.append(d);
    }
  };
  const linked = [...groups.entries()].filter(([, g]) => g.linked.length).map(([n, g]) => [n, g.linked] as [string, FindHit[]]);
  const unlinked = [...groups.entries()].filter(([, g]) => g.unlinked.length).map(([n, g]) => [n, g.unlinked] as [string, FindHit[]]);
  sect("linked mentions", "bl-linked", linked);
  sect("unlinked mentions", "bl-unlinked", unlinked);
  if (!linked.length && !unlinked.length)
    rail.insertAdjacentHTML("beforeend", `<div class="or-empty">nothing links here yet — write [[${s}]] in a note</div>`);
}

export async function openHistory() {
  const note = currentNote();
  if (!note) return;
  const snaps = await invoke<
    Array<{ ts: number; size: number; preview: string }>
  >("vault_history", { name: note }).catch(() => []);
  if (!snaps.length) {
    document.dispatchEvent(
      new CustomEvent("laido:toast", { detail: "no snapshots yet — history starts on your next edit" }),
    );
    return;
  }
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  rail.classList.remove("hidden");
  rail.dataset.mode = "hist";
  rail.innerHTML =
    `<div class="or-empty" style="display:flex;justify-content:space-between">` +
    `<span>snapshots of ${stem(note)}</span><button class="or-x" title="back to outline">✕</button></div>`;
  rail.querySelector(".or-x")?.addEventListener("click", () => {
    delete rail.dataset.mode;
    rail.innerHTML = "";
    document.dispatchEvent(new CustomEvent("laido:outline"));
  });
  for (const s of snaps) {
    const b = document.createElement("button");
    b.className = "or-h";
    const when = new Date(Number(s.ts)).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    b.innerHTML = `${when} <span style="opacity:.55">· ${s.size}b · ${s.preview.replace(/</g, "&lt;").slice(0, 28)}</span>`;
    b.addEventListener("click", async () => {
      const md = await invoke<string>("vault_snapshot_read", { name: note, ts: s.ts }).catch(() => null);
      if (md === null) return;
      await invoke("vault_write", { name: note, content: md });
      delete rail.dataset.mode;
      document.dispatchEvent(new CustomEvent("laido:reload"));
    });
    rail.append(b);
  }
}
