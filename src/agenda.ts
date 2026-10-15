/* ---------- agenda card — the vault's due-work dashboard ----------
 * `[!agenda] title` persists as just the title (the content is computed);
 * wireAgenda pulls `vault_agenda` — every dated `- [ ] x @YYYY-MM-DD`
 * across every note + flashcard due counts — and renders Today-style:
 * overdue → today → this week → later. Clicking a row opens the note.
 * `⟳` rescans; nothing is stored — it's a live view. */

import { invoke } from "./ipc.js";

// note opening goes through the `nav:open` event (tabs.js listens) — a
// direct import would drag the whole editor graph into leaf modules
const openNote = (name: string) =>
  document.dispatchEvent(new CustomEvent("nav:open", { detail: name }));

const escH = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

export interface AgendaTask {
  text: string;
  due: string; // YYYY-MM-DD
  line: number;
}
export interface AgendaNote {
  note: string;
  tasks: AgendaTask[];
  cards_due: number;
  cards_total: number;
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const weekIso = () => {
  const d = new Date(Date.now() + 7 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** bucket a due date: 0 overdue · 1 today · 2 this week · 3 later — pure */
export function dueBucket(due: string, today: string, weekEnd: string): number {
  due = String(due ?? "");
  today = String(today ?? "");
  weekEnd = String(weekEnd ?? "");
  if (due < today) return 0;
  if (due === today) return 1;
  if (due <= weekEnd) return 2;
  return 3;
}
const BUCKETS = ["overdue", "today", "this week", "later"];

export function agendaCallout(block: string[]): string {
  if (!Array.isArray(block)) block = [];
  const head = block[0] ?? "";
  const topic = head.replace(/^\[!\w+\]\s*/, "").trim() || "agenda";
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout agenda-card" data-kind="agenda" data-topic="${escH(topic)}" data-md="${escH(raw)}">` +
    `<div class="callout-head"><span class="callout-title">📅 ${escH(topic)}</span></div>` +
    `<div class="ag-body"><span class="ag-load">…</span></div>` +
    `</div>`
  );
}

export function buildAgendaCard(title: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "callout agenda-card";
  card.dataset.kind = "agenda";
  card.dataset.topic = title || "agenda";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">📅 ${title || "agenda"}</span></div>` +
    `<div class="ag-body"><span class="ag-load">…</span></div>`;
  return card;
}

export function agendaToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  return `> [!agenda] ${card.dataset.topic ?? "agenda"}`;
}

export async function scanAgenda(): Promise<AgendaNote[]> {
  return invoke<AgendaNote[]>("vault_agenda").catch(() => []);
}

/** NotebookLM's Audio Overview, vault-sized: the agenda scan becomes a
 *  ≤4-sentence spoken brief via the model (a plain fallback when it's
 *  unreachable), read aloud with the OS voice, and the transcript lands
 *  on the note as a callout — AI actions leave a visible trace. */
export async function speakDigest() {
  const rows = await scanAgenda();
  const today = new Date().toISOString().slice(0, 10);
  const shape = rows.flatMap((n) =>
    n.tasks.map((t) => `${t.text} (due ${t.due}, in ${n.note})`)
      .concat(n.cards_due > 0 ? [`${n.cards_due} flashcards due in ${n.note}`] : []),
  );
  let text = "";
  try {
    const r = await invoke<{ text: string }>("term_ai", {
      prompt:
        `Voice-brief today's agenda in at most 4 short spoken sentences — ` +
        `overdue first, then today, then this week. Plain speech, no lists, ` +
        `no markdown. Today is ${today}. Items: ${JSON.stringify(shape)}`,
      history: [],
      others: "",
      model: null,
    });
    text = r.text.trim();
  } catch { /* model unreachable — fall back below */ }
  if (!text) {
    const over = shape.filter((s) => {
      const m = s.match(/\(due (\d{4}-\d{2}-\d{2})/);
      return m ? m[1] < today : false;
    }).length;
    text = shape.length
      ? `You have ${shape.length} open item${shape.length > 1 ? "s" : ""}` +
        (over ? `, ${over} overdue` : "") +
        `. ${shape.slice(0, 3).join(". ")}.`
      : "The vault is quiet — nothing due.";
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.onend = () => document.dispatchEvent(new CustomEvent("digest:done"));
  window.speechSynthesis.speak(u);
  document.dispatchEvent(new CustomEvent("digest:insert", { detail: text }));
}

export function wireAgenda(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.agendaWired) return;
  card.dataset.agendaWired = "1";
  const bodyEl = card.querySelector<HTMLElement>(".ag-body");
  if (!bodyEl) return;
  bodyEl.contentEditable = "false";
  const head = card.querySelector<HTMLElement>(".callout-head");
  if (head && !head.querySelector(".ag-refresh")) {
    const b = document.createElement("button");
    b.className = "ag-refresh";
    b.textContent = "⟳";
    b.title = "rescan the vault";
    b.contentEditable = "false";
    b.addEventListener("click", () => void paint());
    head.append(b);
  }
  if (head && !head.querySelector(".ag-speak")) {
    const s = document.createElement("button");
    s.className = "ag-speak";
    s.textContent = "🔊";
    s.title = "audio digest — a spoken brief of everything due";
    s.contentEditable = "false";
    s.addEventListener("click", () => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        return;
      }
      s.classList.add("speaking");
      document.addEventListener("digest:done", () => s.classList.remove("speaking"), { once: true });
      void speakDigest();
    });
    head.append(s);
  }
  const paint = async () => {
    const rows = await scanAgenda();
    // fm-due notes — `due:`/`deadline:`/`scheduled:`/`on:` props ride the
    // same index the `is:overdue` palette predicate reads, so a note
    // carrying a date shows here even with no `- [ ]` task inside
    const ix = await invoke<{ props: [string, string, string][] }>("vault_index").catch(() => null);
    const propDue = new Map<string, string>(); // note → earliest date
    for (const [n, k, v] of ix?.props ?? []) {
      if (!["due", "deadline", "date", "scheduled", "on"].includes(k.toLowerCase())) continue;
      const d = v.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (!d) continue;
      if (!propDue.has(n) || d < propDue.get(n)!) propDue.set(n, d);
    }
    const today = todayIso();
    const weekEnd = weekIso();
    bodyEl.innerHTML = "";
    const groups: HTMLElement[] = BUCKETS.map((b, i) => {
      const g = document.createElement("div");
      g.className = `ag-grp ag-b${i}`;
      g.innerHTML = `<div class="ag-h">${b}</div>`;
      g.style.display = "none";
      bodyEl.append(g);
      return g;
    });
    let any = false;
    for (const n of rows) {
      for (const t of n.tasks) {
        const b = dueBucket(t.due, today, weekEnd);
        const el = document.createElement("button");
        el.className = "ag-task" + (b === 0 ? " ag-over" : b === 1 ? " ag-today" : "");
        el.innerHTML =
          `<span class="ag-txt">${escH(t.text)}</span>` +
          `<span class="ag-due">${escH(t.due.slice(5))}</span>` +
          `<span class="ag-note">${escH(n.note.replace(/\.(laido|md)$/, ""))}</span>`;
        el.title = `${n.note}:${t.line} — click to open, right-click to reschedule`;
        el.addEventListener("click", () => openNote(n.note));
        // right-click → move the task's @date — rewritten in the note's
        // own line via vault_write (snapshot → `> history` undoes)
        el.addEventListener("contextmenu", (e) => {
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
          item("open", () => openNote(n.note));
          const move = (days: number | null) => void (async () => {
            const md = await invoke<string>("vault_read", { name: n.note }).catch(() => "");
            const lines = md.split("\n");
            const li = t.line - 1;
            if (li < 0 || li >= lines.length) return;
            if (days === null) {
              lines[li] = lines[li].replace(/\s*@\d{4}-\d{2}-\d{2}/, "");
            } else {
              const iso = new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10);
              lines[li] = /@\d{4}-\d{2}-\d{2}/.test(lines[li])
                ? lines[li].replace(/@\d{4}-\d{2}-\d{2}/, `@${iso}`)
                : `${lines[li]} @${iso}`;
            }
            await invoke("vault_write", { name: n.note, content: lines.join("\n") }).catch(() => {});
            void paint();
          })();
          item("→ today", () => move(0));
          item("→ tomorrow", () => move(1));
          item("→ next week", () => move(7));
          item("drop the date", () => move(null));
          menu.style.left = `${e.clientX}px`;
          menu.style.top = `${e.clientY}px`;
          document.body.append(menu);
          setTimeout(() =>
            document.addEventListener("mousedown", () => menu.remove(), { once: true }), 0);
        });
        groups[b].style.display = "";
        groups[b].append(el);
        any = true;
      }
      if (n.cards_due > 0) {
        const el = document.createElement("button");
        el.className = "ag-task ag-cards";
        el.innerHTML =
          `<span class="ag-txt">🃏 ${n.cards_due} flashcard${n.cards_due > 1 ? "s" : ""} due</span>` +
          `<span class="ag-note">${escH(n.note.replace(/\.(laido|md)$/, ""))}</span>`;
        el.title = `${n.note} — open to review`;
        el.addEventListener("click", () => openNote(n.note));
        groups[0].style.display = "";
        groups[0].append(el); // flashcards surface with overdue — they decay
        any = true;
      }
    }
    // fm-due notes bucket like tasks — styled as note rows, not todos
    for (const [n, d] of propDue) {
      const b = dueBucket(d, today, weekEnd);
      if (b >= 3) continue; // far-future props stay out of the agenda
      const el = document.createElement("button");
      el.className = "ag-task ag-fm" + (b === 0 ? " ag-over" : b === 1 ? " ag-today" : "");
      el.innerHTML =
        `<span class="ag-txt">📄 ${escH(n.replace(/\.(laido|md)$/, ""))}</span>` +
        `<span class="ag-due">${escH(d.slice(5))}</span>` +
        `<span class="ag-note">note</span>`;
      el.title = `${n} — due ${d}`;
      el.addEventListener("click", () => openNote(n));
      groups[b].style.display = "";
      groups[b].append(el);
      any = true;
    }
    if (!any) {
      bodyEl.innerHTML = `<div class="ag-empty">nothing due — the vault is quiet</div>`;
    }
    // overdue count in the card head — red chip while debt exists
    const n0 = groups[0].childElementCount - 1; // minus the .ag-h label
    let chip = head?.querySelector<HTMLElement>(".ag-count");
    if (n0 > 0) {
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "ag-count";
        chip.contentEditable = "false";
        head?.append(chip);
      }
      chip.textContent = `${n0} overdue`;
    } else chip?.remove();
  };
  // live view — repaints whenever the vault index refreshes
  document.addEventListener("index:changed", () => void paint());
  void paint();
}
