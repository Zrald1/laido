
const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };
/* ---------- map card — a mind map whose data IS the markdown outline.
 *  Persists as `[!map] title` + indented `- ` bullets (2 spaces/level);
 *  click a node collapses its branch, dblclick renames, ＋ adds a child,
 *  Enter on the add-input commits. The tree lives in a WeakMap; the DOM
 *  renders it. ---------- */

const escH = (s: string) => S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export interface MapNode {
  text: string;
  kids: MapNode[];
  fold?: boolean; // transient UI state — not persisted
}

/** indented `- ` / `* ` / `1. ` lines → nested tree; indent unit = 2 spaces
 *  (a leading tab counts as one level too). Text is the bullet body. */
export function parseMapTree(lines: string[]): MapNode[] {
  if (!Array.isArray(lines)) return [];
  const root: MapNode[] = [];
  const stack: { indent: number; kids: MapNode[] }[] = [{ indent: -1, kids: root }];
  for (const raw of lines) {
    const line = S(raw);
    const m = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!m) {
      // a bare line becomes a root node (AI-friendliness)
      if (line.trim() !== "") {
        stack.length = 1;
        root.push({ text: line.trim(), kids: [] });
      }
      continue;
    }
    const indent = m[1].replace(/\t/g, "  ").length;
    const node: MapNode = { text: m[2].trim(), kids: [] };
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].kids.push(node);
    stack.push({ indent, kids: node.kids });
  }
  return root;
}

/** tree → indented `- ` markdown lines (2 spaces per level) */
export function mapTreeLines(roots: MapNode[], depth = 0): string[] {
  const out: string[] = [];
  if (!Array.isArray(roots)) return out;
  for (const n of roots) {
    if (!n || typeof n !== "object") continue;
    out.push(`${"  ".repeat(depth)}- ${S(n.text)}`);
    out.push(...mapTreeLines(n.kids, depth + 1));
  }
  return out;
}

/** `[!map] t` + indented rows → html for the static render pass */
export function mapCallout(block: string[]): string {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "map";
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout map-card" data-kind="map" data-topic="${escH(topic)}" data-md="${escH(raw)}">` +
    `<div class="callout-head"><span class="callout-title">${escH(topic)}</span></div>` +
    `<div class="map-canvas"></div>` +
    `</div>`
  );
}

const trees = new WeakMap<HTMLElement, MapNode[]>();

export function cardMapTree(card: HTMLElement): MapNode[] {
  return trees.get(card) ?? [];
}

/** serialize the live card → `[!map]` + indented bullets (fold state is
 *  transient — only the tree persists) */
export function mapToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const rows = mapTreeLines(cardMapTree(card));
  return `> [!map] ${DS(card.dataset.topic) ?? "map"}${rows.length ? "\n" + rows.map((r) => `> ${r}`).join("\n") : ""}`;
}

/** render one node row + its (possibly folded) kids column */
function nodeEl(
  card: HTMLElement,
  n: MapNode,
  path: number[],
  repaint: () => void,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "mn";
  const row = document.createElement("div");
  row.className = "mn-row";
  const label = document.createElement("span");
  label.className = "mn-label";
  label.textContent = n.text;
  label.title = "double-click to rename · click to fold";
  label.addEventListener("click", () => {
    if (!n.kids.length) return;
    n.fold = !n.fold;
    repaint();
  });
  label.addEventListener("dblclick", () => {
    const inp = document.createElement("input");
    inp.className = "mn-edit";
    inp.value = n.text;
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && inp.value.trim()) {
        n.text = inp.value.trim();
        repaint();
        card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
      } else if (e.key === "Escape") repaint();
    });
    inp.addEventListener("blur", () => {
      if (inp.value.trim()) {
        n.text = inp.value.trim();
        card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
      }
      repaint();
    });
    label.replaceWith(inp);
    inp.focus();
    inp.select();
  });
  row.append(label);
  if (n.kids.length) {
    const chip = document.createElement("span");
    chip.className = "mn-count";
    chip.textContent = n.fold ? `⊕${n.kids.length}` : `⊖${n.kids.length}`;
    chip.title = n.fold ? "expand" : "collapse";
    chip.addEventListener("click", () => {
      n.fold = !n.fold;
      repaint();
    });
    row.append(chip);
  }
  const add = document.createElement("button");
  add.className = "mn-add";
  add.textContent = "＋";
  add.title = "add child";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const inp = document.createElement("input");
    inp.className = "mn-edit";
    inp.placeholder = "new node…";
    inp.addEventListener("keydown", (e2) => {
      e2.stopPropagation();
      if (e2.key === "Enter" && inp.value.trim()) {
        n.kids.push({ text: inp.value.trim(), kids: [] });
        n.fold = false;
        repaint();
        card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
      } else if (e2.key === "Escape") repaint();
    });
    inp.addEventListener("blur", () => repaint());
    inp.addEventListener("pointerdown", (e2) => e2.stopPropagation());
    row.append(inp);
    inp.focus();
  });
  row.append(add);
  const del = document.createElement("button");
  del.className = "mn-del";
  del.textContent = "✕";
  del.title = "delete node + its branch";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    const sib = parentArr(card, path.slice(0, -1));
    const idx = path[path.length - 1];
    sib.splice(idx, 1);
    repaint();
    card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
  });
  row.append(del);
  el.append(row);
  if (n.kids.length && !n.fold) {
    const kids = document.createElement("div");
    kids.className = "mn-kids";
    n.kids.forEach((k, i) => kids.append(nodeEl(card, k, [...path, i], repaint)));
    el.append(kids);
  }
  return el;
}

/** walk a path of indexes → the kids array at that path's end */
function parentArr(card: HTMLElement, path: number[]): MapNode[] {
  let arr = cardMapTree(card);
  for (const i of path) arr = arr[i].kids;
  return arr;
}

/** upgrade a rendered (or freshly built) map card */
export function wireMap(card: HTMLElement, seed?: MapNode[]) {
  if (!card?.dataset) return;
  if (card.dataset.mapWired) return;
  card.dataset.mapWired = "1";
  const canvas = card.querySelector<HTMLElement>(".map-canvas");
  if (!canvas) return;
  if (!trees.has(card)) {
    const fromMd = card.dataset.md
      ? parseMapTree(
          card.dataset.md
            .split("\n")
            .slice(1)
            .map((l) => l.replace(/^>\s?/, "")),
        )
      : [];
    trees.set(card, seed ?? fromMd);
  }
  const tree = trees.get(card)!;
  const repaint = () => {
    canvas.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "map-tree";
    tree.forEach((n, i) => wrap.append(nodeEl(card, n, [i], repaint)));
    if (!tree.length) {
      const hint = document.createElement("button");
      hint.className = "mn-add-root";
      hint.textContent = "＋ add a node";
      hint.addEventListener("click", () => {
        tree.push({ text: "idea", kids: [] });
        repaint();
        card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
      });
      wrap.append(hint);
    }
    canvas.append(wrap);
  };
  const changed = () =>
    card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
  apis.set(card, {
    title: () => card.dataset.topic ?? "map",
    add: (lines) => {
      const rows = parseMapTree(lines);
      tree.push(...rows);
      repaint();
      changed();
      return rows.length;
    },
    del: (prefix) => {
      const ok = removeNode(tree, S(prefix));
      if (ok) {
        repaint();
        changed();
      }
      return ok;
    },
    rename: (prefix, text) => {
      const n = findNode(tree, S(prefix));
      if (!n) return false;
      n.text = S(text);
      repaint();
      changed();
      return true;
    },
    list: () => mapTreeLines(tree).join("\n") || "(empty map)",
  });
  // head button: add a root node
  const head = card.querySelector<HTMLElement>(".callout-head");
  if (head && !head.querySelector(".map-root-add")) {
    const b = document.createElement("button");
    b.className = "map-root-add";
    b.textContent = "＋ node";
    b.title = "add a root node";
    b.contentEditable = "false";
    b.addEventListener("click", () => {
      tree.push({ text: "idea", kids: [] });
      repaint();
      card.dispatchEvent(new CustomEvent("map:changed", { bubbles: true }));
    });
    head.append(b);
  }
  repaint();
}

export interface MapApi {
  title(): string;
  /** add indented `- ` rows at root level (or under a matching prefix node) */
  add(lines: string[]): number;
  /** delete the first node whose text starts with `prefix` — whole branch */
  del(prefix: string): boolean;
  /** rename first node matching prefix */
  rename(prefix: string, text: string): boolean;
  /** the tree as indented `- ` lines */
  list(): string;
}
const apis = new WeakMap<HTMLElement, MapApi>();
export function mapApi(card: HTMLElement): MapApi | undefined {
  return apis.get(card);
}

/** depth-first find — first node whose text starts with prefix (ci) */
function findNode(roots: MapNode[], prefix: string): MapNode | null {
  const p = prefix.toLowerCase();
  for (const n of roots) {
    if (n.text.toLowerCase().startsWith(p)) return n;
    const f = findNode(n.kids, prefix);
    if (f) return f;
  }
  return null;
}
function removeNode(roots: MapNode[], prefix: string): boolean {
  const p = prefix.toLowerCase();
  const i = roots.findIndex((n) => n.text.toLowerCase().startsWith(p));
  if (i >= 0) {
    roots.splice(i, 1);
    return true;
  }
  return roots.some((n) => removeNode(n.kids, prefix));
}

/** spawn-time builder */
export function buildMapCard(title: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout map-card";
  card.dataset.kind = "map";
  card.dataset.topic = title || "map";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${title || "map"}</span></div>` +
    `<div class="map-canvas"></div>`;
  return card;
}

