
const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };
/* ---------- Laido Todo — tasks that live inside the note ----------
 * A `> [!todo]` callout persists as markdown checklist lines:
 *   > - [ ] buy milk @today        → open task, due today
 *   > - [x] call plumber           → done
 *   > - [ ] report @2026-02-10     → ISO due date
 * The card is the dashboard: add row on top, tasks grouped by due state
 * (overdue → today → upcoming → no date → done), box click toggles.
 * ` ```todo ` fences drive the same api the card exposes. */

export interface TodoItem {
  text: string;
  done: boolean;
  when: string; // "" or ISO YYYY-MM-DD
}

/* ---------- due-date parsing ---------- */

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "tomorrow", "+3d", "fri", "2026-02-10", "02-10" → ISO date, else "" */
export function parseWhen(raw: string): string {
  const t = S(raw).trim().toLowerCase();
  if (!t) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (t === "today" || t === "tonight") return isoOf(today);
  if (t === "tomorrow") return isoOf(new Date(today.getTime() + 86400000));
  let m = t.match(/^\+(\d+)d?$/);
  if (m) return isoOf(new Date(today.getTime() + Number(m[1]) * 86400000));
  const wd = WD.indexOf(t);
  if (wd >= 0) {
    // next occurrence of that weekday — "fri" on friday means *next* friday
    let d = (wd - today.getDay() + 7) % 7;
    if (d === 0) d = 7;
    return isoOf(new Date(today.getTime() + d * 86400000));
  }
  const realDate = (y: number, m0: number, d: number) => {
    // reject impossible dates — `new Date` happily rolls 2-30 over to Mar 2,
    // and a verbatim "2026-13-45" would sort/display as garbage
    if (m0 < 1 || m0 > 12 || d < 1 || d > 31) return "";
    const dt = new Date(y, m0 - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m0 - 1 && dt.getDate() === d
      ? `${y}-${pad2(m0)}-${pad2(d)}`
      : "";
  };
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return realDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    // this year; if it already passed, next year
    let iso = realDate(now.getFullYear(), +m[1], +m[2]);
    if (!iso) return "";
    if (new Date(iso + "T00:00:00").getTime() < today.getTime())
      iso = realDate(now.getFullYear() + 1, +m[1], +m[2]);
    return iso;
  }
  m = t.match(/^([a-z]{3,9})\s*(\d{1,2})$/); // "jan 5", "march 12"
  if (m) {
    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = MONTHS.findIndex((x) => m![1].startsWith(x));
    if (mi >= 0) {
      let iso = realDate(now.getFullYear(), mi + 1, +m[2]);
      if (!iso) return "";
      if (new Date(iso + "T00:00:00").getTime() < today.getTime())
        iso = realDate(now.getFullYear() + 1, mi + 1, +m[2]);
      return iso;
    }
  }
  return "";
}

/** ISO → friendly chip: overdue/today/tomorrow/weekday/date */
export function whenLabel(when: string): { label: string; cls: string } {
  when = S(when);
  if (!when) return { label: "", cls: "" };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d = new Date(when + "T00:00:00").getTime();
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return { label: days === -1 ? "yesterday" : `${-days}d ago`, cls: "over" };
  if (days === 0) return { label: "today", cls: "now" };
  if (days === 1) return { label: "tomorrow", cls: "soon" };
  if (days <= 7) return { label: WD[new Date(d).getDay()], cls: "soon" };
  return { label: when.slice(5), cls: "" }; // MM-DD
}

/* ---------- markdown <-> model ---------- */

/** "- [ ] text @when" / "- [x] text" → item; null when the line isn't a task */
export function parseTodoLine(line: string): TodoItem | null {
  const m = S(line).trim().match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
  if (!m) return null;
  const it: TodoItem = { text: "", done: m[1] !== " ", when: "" };
  let rest = m[2];
  const wm = rest.match(/@(\S+)\s*$/);
  if (wm) {
    const w = parseWhen(wm[1]);
    if (w || /^\d{4}-\d{2}-\d{2}$/.test(wm[1])) {
      it.when = w || wm[1];
      rest = rest.slice(0, wm.index).trim();
    }
  }
  it.text = rest;
  return it;
}

const escCell = (s: string) =>
  S(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n");
const unesc = (s: string) => {
  let o = "";
  let e = false;
  for (const ch of S(s)) {
    if (e) {
      o += ch === "n" ? "\n" : ch === "|" || ch === "\\" ? ch : "\\" + ch;
      e = false;
    } else if (ch === "\\") e = true;
    else o += ch;
  }
  return e ? o + "\\" : o;
};

/** callout body lines (post-`>` strip) → items */
export function parseTodo(block: string[]): { title: string; items: TodoItem[] } {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const title = (block[0] ?? "").replace(/^\[!\w+\]\s*/, "").trim() || "todo";
  const items: TodoItem[] = [];
  for (const raw of block.slice(1)) {
    const it = parseTodoLine(raw);
    if (it) {
      it.text = unesc(it.text);
      items.push(it);
    }
  }
  return { title, items };
}

/** live card DOM → markdown callout */
export function todoToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const lines: string[] = [`> [!todo] ${DS(card.dataset.topic) ?? "todo"}`];
  card.querySelectorAll<HTMLElement>(".todo-item").forEach((el) => {
    const done = el.dataset.done === "1";
    const when = el.dataset.when ?? "";
    const text = el.querySelector(".todo-text")?.textContent?.trim() ?? "";
    lines.push(`> - [${done ? "x" : " "}] ${escCell(text)}${when ? ` @${when}` : ""}`);
  });
  return lines.join("\n");
}

/* ---------- markup ---------- */

const escHtml = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function itemHtml(it: TodoItem): string {
  const w = it.when ? ` data-when="${escHtml(it.when)}"` : "";
  const wl = it.when ? whenLabel(it.when) : null;
  const chip = wl?.label ? `<span class="todo-when ${wl.cls}">${escHtml(wl.label)}</span>` : "";
  return (
    `<div class="todo-item${it.done ? " done" : ""}" data-done="${it.done ? 1 : 0}"${w}>` +
    `<span class="todo-box">${it.done ? "☑" : "☐"}</span>` +
    `<span class="todo-text" contenteditable="true" spellcheck="false" data-ph="task">${escHtml(it.text)}</span>` +
    chip +
    `<button class="todo-x" title="delete">✕</button></div>`
  );
}

/** card inner markup — render.ts wraps this in the callout div */
export function todoInnerHtml(d: { title: string; items: TodoItem[] }): string {
  return (
    `<div class="todo-body">` +
    `<div class="todo-add"><span class="todo-plus">+</span>` +
    `<span class="todo-in" contenteditable="true" spellcheck="false" data-ph="add a task — @tomorrow, +3d, fri, 2026-02-10…"></span></div>` +
    `<div class="todo-list">${d.items.map(itemHtml).join("")}</div>` +
    `<div class="todo-foot"></div>` +
    `</div>`
  );
}

/** spawn-time card builder */
export function buildTodoCard(title: string): HTMLElement {
  title = S(title);
  const card = document.createElement("div");
  card.className = "callout todo-card";
  card.dataset.kind = "todo";
  card.dataset.topic = title || "todo";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${escHtml(title || "todo")}</span></div>` +
    todoInnerHtml({ title, items: [] });
  return card;
}

/* ---------- the live card ---------- */

export interface TodoApi {
  title(): string;
  items(): TodoItem[];
  list(): string;
  add(text: string, when?: string): number;
  setDone(i: number, done: boolean): void;
  del(i: number): void;
  clearDone(): number;
}

const todos = new WeakMap<HTMLElement, TodoApi>();
export function todoApi(card: HTMLElement): TodoApi | undefined {
  return todos.get(card);
}

export function wireTodo(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.todoWired) return;
  card.dataset.todoWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("todo:changed", { bubbles: true }));
  const list = card.querySelector<HTMLElement>(".todo-list");
  const input = card.querySelector<HTMLElement>(".todo-in");
  const foot = card.querySelector<HTMLElement>(".todo-foot");
  if (!list || !input || !foot) return;

  const items = () => Array.from(list.querySelectorAll<HTMLElement>(".todo-item"));

  const model = (el: HTMLElement): TodoItem => ({
    text: el.querySelector(".todo-text")?.textContent?.trim() ?? "",
    done: el.dataset.done === "1",
    when: el.dataset.when ?? "",
  });

  /** regroup: overdue → today → upcoming → no-date → done (each in add order) */
  const resort = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const rank = (el: HTMLElement) => {
      if (el.dataset.done === "1") return 4;
      const w = el.dataset.when;
      if (!w) return 3;
      const d = new Date(w + "T00:00:00").getTime();
      if (d < today) return 0;
      if (d === today) return 1;
      return 2;
    };
    items()
      .map((el) => ({ el, rank: rank(el) }))
      .sort((a, b) => a.rank - b.rank)
      .forEach(({ el }) => list.append(el));
    paintFoot();
  };

  const paintFoot = () => {
    const all = items();
    const done = all.filter((e) => e.dataset.done === "1").length;
    const open = all.length - done;
    foot.innerHTML = "";
    const s = document.createElement("span");
    s.className = "todo-count";
    s.textContent = open ? `${open} open · ${done} done` : all.length ? `all ${done} done ✓` : "";
    foot.append(s);
    if (done) {
      const b = document.createElement("button");
      b.className = "todo-clear";
      b.textContent = "clear done";
      b.title = "remove completed tasks";
      b.addEventListener("click", () => {
        clearDone();
      });
      foot.append(b);
    }
  };

  const paintChip = (el: HTMLElement) => {
    el.querySelector(".todo-when")?.remove();
    const w = el.dataset.when ?? "";
    if (!w) return;
    const wl = whenLabel(w);
    const chip = document.createElement("span");
    chip.className = `todo-when ${wl.cls}`;
    chip.textContent = wl.label;
    chip.title = w;
    el.querySelector(".todo-text")?.after(chip);
  };

  const wireItem = (el: HTMLElement) => {
    if (el.dataset.wired) return;
    el.dataset.wired = "1";
    const box = el.querySelector<HTMLElement>(".todo-box");
    const text = el.querySelector<HTMLElement>(".todo-text");
    const x = el.querySelector<HTMLElement>(".todo-x");
    box?.addEventListener("click", (e) => {
      e.stopPropagation();
      const done = el.dataset.done !== "1";
      el.dataset.done = done ? "1" : "0";
      el.classList.toggle("done", done);
      box.textContent = done ? "☑" : "☐";
      resort();
      onChange();
    });
    text?.addEventListener("blur", () => {
      // trailing "@when" typed into the text becomes the due date
      const t = text.textContent ?? "";
      const wm = t.match(/@(\S+)\s*$/);
      if (wm) {
        const w = parseWhen(wm[1]);
        if (w) {
          text.textContent = t.slice(0, wm.index).trim();
          el.dataset.when = S(w);
        }
      }
      paintChip(el);
      resort();
      onChange();
    });
    text?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        text.blur();
      } else if (e.key === "Escape") text.blur();
    });
    text?.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, t.replace(/\n/g, " "));
    });
    x?.addEventListener("click", (e) => {
      e.stopPropagation();
      el.remove();
      paintFoot();
      onChange();
    });
  };

  const add = (text: string, when = ""): number => {
    text = S(text);
    when = S(when);
    const it: TodoItem = { text: "", done: false, when: "" };
    // "@when" trailing the text sets the due date
    const wm = text.match(/@(\S+)\s*$/);
    if (wm) {
      const w = parseWhen(wm[1]);
      if (w || /^\d{4}-\d{2}-\d{2}$/.test(wm[1])) {
        it.when = w || wm[1];
        text = text.slice(0, wm.index).trim();
      }
    }
    it.text = text;
    it.when = when || it.when;
    const tmp = document.createElement("div");
    tmp.innerHTML = itemHtml(it);
    const el = tmp.firstElementChild as HTMLElement;
    list.append(el);
    wireItem(el);
    resort();
    onChange();
    return items().indexOf(el);
  };

  const clearDone = (): number => {
    const done = items().filter((e) => e.dataset.done === "1");
    done.forEach((e) => e.remove());
    paintFoot();
    onChange();
    return done.length;
  };

  // the add row: Enter commits
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const t = (input.textContent ?? "").trim();
      if (t) add(t);
      input.textContent = "";
    } else if (e.key === "Escape") input.blur();
  });
  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, t.replace(/\n/g, " "));
  });

  // upgrade the static markup render.ts emitted
  items().forEach(wireItem);
  items().forEach(paintChip);
  resort();

  /* ---- the external api — the ```todo``` fence drives this ---- */
  todos.set(card, {
    title: () => card.dataset.topic ?? "todo",
    items: () => items().map(model),
    list: () =>
      items()
        .map((el, i) => {
          const m = model(el);
          return `${i + 1}. [${m.done ? "x" : " "}] ${m.text}${m.when ? ` @${m.when} (${whenLabel(m.when).label})` : ""}`;
        })
        .join("\n"),
    add: (text, when) => add(text, when ?? "") + 1,
    setDone: (i, done) => {
      const el = items()[i];
      if (!el) return;
      el.dataset.done = done ? "1" : "0";
      el.classList.toggle("done", done);
      const box = el.querySelector(".todo-box");
      if (box) box.textContent = done ? "☑" : "☐";
      resort();
      onChange();
    },
    del: (i) => {
      items()[i]?.remove();
      paintFoot();
      onChange();
    },
    clearDone: () => clearDone(),
  });
}
