/* ---------- the flashcards widget — a spaced-repetition deck in a card ----
 * Storage: `> [!cards] title` + rows `> front :: back` + state
 * `> sched: <h8> <iso-due> <ease> <ivl> <reps>` lines (h8 = fnv of the
 * front text — editing a front detaches its state, same caveat Obsidian's
 * SR plugin has).
 *
 * Click a row to flip front→back. `▶ review` opens a session over the
 * card: the front shows alone; click / Space reveals the back; rate
 * Again(1) Hard(2) Good(3) Easy(4) — each button previews the next
 * interval (Anki's convention). Again requeues the card at the end of
 * the session. ` ```cards ` AI fences create and quiz decks. */

import { addActivity } from "./log.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const DS = (v: string | undefined): string => { const s = v ?? ""; return /^(?:undefined|null|NaN|-?Infinity|[object [^]]*])$/.test(s) ? "" : s; };

export interface FlashCard {
  front: string;
  back: string;
}

export interface Sched {
  due: string; // iso date
  ease: number; // 1.3 .. ~3
  ivl: number; // days
  reps: number;
}

/** fnv-1a 8-hex — the card-line id that survives reload */
export function h8(s: string): string {
  s = S(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const escHtml = (s: string) =>
  S(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00`); // noon — dodge DST edges
  if (!Number.isFinite(+d) || !Number.isFinite(n)) return S(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const NEW_SCHED: Sched = { due: "1970-01-01", ease: 2.5, ivl: 0, reps: 0 };

/* ---------- SM-2-lite scheduling (pure — unit-testable) ---------- */

/** grade 0=again 1=hard 2=good 3=easy → the next schedule state */
export function grade(s: Sched, g: 0 | 1 | 2 | 3, today = todayIso()): Sched {
  s = s && typeof s === "object" ? s : { ...NEW_SCHED };
  if (![0, 1, 2, 3].includes(g)) g = 2;
  const ease = Math.max(1.3, Number.isFinite(s.ease) ? s.ease : 2.5);
  const ivl0 = Number.isFinite(s.ivl) ? s.ivl : 0;
  const reps = Number.isFinite(s.reps) ? s.reps : 0;
  const s2 = { ...s, ease, ivl: ivl0, reps };
  s = s2;
  if (g === 0) return { due: today, ease: Math.max(1.3, ease - 0.2), ivl: 0, reps: 0 };
  if (g === 1) {
    const ivl = Math.max(1, Math.round(Math.max(1, s.ivl) * 1.2));
    return { due: addDays(today, ivl), ease: Math.max(1.3, ease - 0.15), ivl, reps: s.reps + 1 };
  }
  if (g === 3) {
    const ivl = s.reps === 0 ? 4 : Math.max(4, Math.round(s.ivl * ease * 1.3));
    return { due: addDays(today, ivl), ease: ease + 0.15, ivl, reps: s.reps + 1 };
  }
  const ivl = s.reps === 0 ? 1 : s.reps === 1 ? 6 : Math.max(1, Math.round(s.ivl * ease));
  return { due: addDays(today, ivl), ease, ivl, reps: s.reps + 1 };
}

/** what the rating buttons preview */
export function previewIvl(s: Sched, g: 0 | 1 | 2 | 3): string {
  const ivl = grade(s, g).ivl;
  return !Number.isFinite(ivl) || ivl <= 0 ? "<1d" : `${ivl}d`;
}

export function isDue(s: Sched | undefined, today = todayIso()): boolean {
  return !s || S(s.due) <= today;
}

/* ---------- markdown <-> model ---------- */

export interface CardDeck {
  title: string;
  cards: FlashCard[];
  sched: Map<string, Sched>; // keyed by h8(front)
}

export function parseCards(block: string[]): CardDeck {
  if (!Array.isArray(block)) block = []; block = block.map((l) => S(l));
  const head = block[0] ?? "";
  const title = head.replace(/^\[!\w+\]\s*/, "").trim() || "cards";
  const cards: FlashCard[] = [];
  const sched = new Map<string, Sched>();
  for (const raw of block.slice(1)) {
    const l = raw.trim();
    const sm = l.match(/^sched:\s*([0-9a-f]{8})\s+(\d{4}-\d{2}-\d{2})\s+([\d.]+)\s+(\d+)\s+(\d+)/i);
    if (sm) {
      sched.set(sm[1].toLowerCase(), {
        due: sm[2],
        ease: Number(sm[3]) || 2.5,
        ivl: Number(sm[4]) || 0,
        reps: Number(sm[5]) || 0,
      });
      continue;
    }
    const i = l.indexOf("::");
    if (i >= 0) {
      cards.push({ front: l.slice(0, i).trim(), back: l.slice(i + 2).trim() });
    }
  }
  return { title, cards, sched };
}

export function cardsToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const title = DS(card.dataset.topic) ?? "cards";
  const lines = [`> [!cards] ${title}`];
  const seen = new Set<string>();
  card.querySelectorAll<HTMLElement>(".fc-row").forEach((r) => {
    const f = r.querySelector<HTMLElement>(".fc-front")?.textContent ?? "";
    const b = r.dataset.back ?? "";
    lines.push(`> ${f} :: ${b}`);
    seen.add(r.dataset.h ?? "");
  });
  // only persist sched state whose card still exists
  let sched: Record<string, Sched> = {};
  try {
    sched = DS(card.dataset.sched) ? JSON.parse(DS(card.dataset.sched)) as Record<string, Sched> : {};
  } catch { sched = {}; }
  for (const h of seen) {
    const s = sched[h];
    if (s) lines.push(`> sched: ${h} ${s.due} ${s.ease} ${s.ivl} ${s.reps}`);
  }
  return lines.join("\n");
}

/** the card markup render.ts emits; wireCards upgrades it live */
export function cardsInnerHtml(): string {
  return (
    `<div class="fc-tools"><button class="fc-b" data-a="review" title="review due cards (Space flips, 1-4 rates)">▶ review</button>` +
    `<span class="fc-count"></span>` +
    `<button class="fc-b fc-add" data-a="add" title="add a card">＋</button></div>` +
    `<div class="fc-list"></div>` +
    `<div class="fc-addrow"><input class="fc-in" placeholder="front"/>` +
    `<input class="fc-in" placeholder="back"/><button class="fc-b" data-a="ok">add</button></div>` +
    `<div class="fc-status"></div>`
  );
}

export function buildCardsCard(title: string, cards: FlashCard[] = []): HTMLElement {
  title = S(title);
  const el = document.createElement("div");
  el.className = "callout cards-card";
  el.dataset.kind = "cards";
  el.dataset.topic = title || "cards";
  el.innerHTML =
    `<div class="callout-head"><span class="callout-title">${escHtml(title || "cards")}</span></div>` +
    cardsInnerHtml();
  const list = el.querySelector<HTMLElement>(".fc-list")!;
  for (const c of Array.isArray(cards) ? cards : [])
    if (c && typeof c === "object") list.appendChild(fcRow(c, new Map(), () => {}));
  return el;
}

/* ---------- row ---------- */

function fcRow(c: FlashCard, sched: Map<string, Sched>, changed: () => void): HTMLElement {
  const h = h8(c.front);
  const r = document.createElement("div");
  r.className = "fc-row";
  r.dataset.h = h;
  r.dataset.back = S(c.back);
  const due = sched.get(h);
  const dueLabel =
    due && due.ivl > 0
      ? due.due <= todayIso()
        ? "due"
        : due.due.slice(5)
      : "new";
  r.innerHTML =
    `<button class="fc-del" title="delete card">✕</button>` +
    `<span class="fc-front">${escHtml(c.front)}</span>` +
    `<span class="fc-back">${escHtml(c.back)}</span>` +
    `<span class="fc-due">${escHtml(dueLabel)}</span>`;
  r.querySelector<HTMLElement>(".fc-del")?.addEventListener("click", (e) => {
    e.stopPropagation();
    r.remove();
    changed();
  });
  r.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".fc-del")) return;
    r.classList.toggle("flipped");
  });
  return r;
}

/* ---------- the live card ---------- */

export interface CardsApi {
  cards(): FlashCard[];
  add(front: string, back: string): string;
  del(frontPrefix: string): string;
  due(): string;
  /** grade a card by front text — 0..3 */
  rate(frontPrefix: string, g: 0 | 1 | 2 | 3): string;
  list(): string;
}

const apis = new WeakMap<HTMLElement, CardsApi>();
export function cardsApi(card: HTMLElement): CardsApi | undefined {
  return apis.get(card);
}

export function wireCards(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.cardsWired) return;
  card.dataset.cardsWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("cards:changed", { bubbles: true }));
  const list = card.querySelector<HTMLElement>(".fc-list");
  const count = card.querySelector<HTMLElement>(".fc-count");
  const status = card.querySelector<HTMLElement>(".fc-status");
  const addRow = card.querySelector<HTMLElement>(".fc-addrow");
  const tools = card.querySelector<HTMLElement>(".fc-tools");
  if (!list || !count || !status || !addRow || !tools) return;

  const say = (m: string) => {
    status.textContent = m;
  };

  const schedOf = (): Map<string, Sched> => {
    try {
      const raw = card.dataset.sched ? (JSON.parse(card.dataset.sched) as Record<string, Sched>) : {};
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  };
  const saveSched = (m: Map<string, Sched>) => {
    card.dataset.sched = JSON.stringify(Object.fromEntries(m));
    onChange();
  };

  const rowCard = (r: HTMLElement): FlashCard => ({
    front: r.querySelector<HTMLElement>(".fc-front")?.textContent ?? "",
    back: r.dataset.back ?? "",
  });

  const refreshCount = () => {
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".fc-row"));
    const sch = schedOf();
    const due = rows.filter((r) => isDue(sch.get(r.dataset.h ?? ""))).length;
    count.textContent = `${rows.length} cards · ${due} due`;
  };

  // seed existing rows (from parse path) with flip/del wiring
  const wireRow = (r: HTMLElement) => {
    const c = rowCard(r);
    r.dataset.h = h8(c.front);
    r.dataset.back = S(c.back);
    r.querySelector<HTMLElement>(".fc-del")?.addEventListener("click", (e) => {
      e.stopPropagation();
      r.remove();
      refreshCount();
      onChange();
    });
    r.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".fc-del")) return;
      r.classList.toggle("flipped");
    });
  };
  list.querySelectorAll<HTMLElement>(".fc-row").forEach(wireRow);

  const addCard = (front: string, back: string): string => {
    front = S(front).trim();
    back = S(back).trim();
    if (!front || !back) return "✕ card needs a front :: back";
    const r = fcRow({ front, back }, schedOf(), () => {
      refreshCount();
      onChange();
    });
    wireRowExtra(r);
    list.appendChild(r);
    refreshCount();
    onChange();
    return `+ ${front}`;
  };
  // fcRow already wires itself; wireRow adds the dataset init for rows
  // built from markdown — both paths converge on the same listeners
  const wireRowExtra = (r: HTMLElement) => {
    // fcRow's internal listeners already cover del/flip; nothing extra
    void r;
  };

  const delCard = (frontPrefix: string): string => {
    frontPrefix = S(frontPrefix);
    const r = Array.from(list.querySelectorAll<HTMLElement>(".fc-row")).find((x) =>
      (x.querySelector<HTMLElement>(".fc-front")?.textContent ?? "").startsWith(frontPrefix),
    );
    if (!r) return `✕ no card starting "${frontPrefix}"`;
    const f = rowCard(r).front;
    r.remove();
    refreshCount();
    onChange();
    return `- ${f}`;
  };

  const rateCard = (frontPrefix: string, g: 0 | 1 | 2 | 3): string => {
    frontPrefix = S(frontPrefix);
    if (!(g === 0 || g === 1 || g === 2 || g === 3)) return `✕ grade must be 0–3`;
    const r = Array.from(list.querySelectorAll<HTMLElement>(".fc-row")).find((x) =>
      (x.querySelector<HTMLElement>(".fc-front")?.textContent ?? "").startsWith(frontPrefix),
    );
    if (!r) return `✕ no card starting "${frontPrefix}"`;
    const m = schedOf();
    const h = r.dataset.h ?? "";
    const next = grade(m.get(h) ?? { ...NEW_SCHED }, g);
    m.set(h, next);
    saveSched(m);
    r.querySelector<HTMLElement>(".fc-due")!.textContent = next.ivl > 0 ? next.due.slice(5) : "due";
    refreshCount();
    const gname = ["again", "hard", "good", "easy"][g];
    return `${gname} → ${rowCard(r).front} (due ${next.due})`;
  };

  /* ---------- the review session ---------- */

  const review = () => {
    const sch = schedOf();
    const due = Array.from(list.querySelectorAll<HTMLElement>(".fc-row")).filter((r) =>
      isDue(sch.get(r.dataset.h ?? "")),
    );
    if (!due.length) {
      say("nothing due — all caught up");
      return;
    }
    const queue = [...due];
    let i = 0;
    let flipped = false;
    let againCount = 0;

    const ov = document.createElement("div");
    ov.className = "fc-review";
    ov.innerHTML =
      `<div class="fr-prog"></div><div class="fr-front"></div>` +
      `<div class="fr-back"></div>` +
      `<div class="fr-btns"><button class="fr-show">show answer</button>` +
      `<div class="fr-rates">` +
      `<button class="fr-r fr-again">Again<small></small></button>` +
      `<button class="fr-r fr-hard">Hard<small></small></button>` +
      `<button class="fr-r fr-good">Good<small></small></button>` +
      `<button class="fr-r fr-easy">Easy<small></small></button>` +
      `</div></div>` +
      `<button class="fr-x" title="end session">✕</button>`;
    card.appendChild(ov);

    const prog = ov.querySelector<HTMLElement>(".fr-prog")!;
    const frontEl = ov.querySelector<HTMLElement>(".fr-front")!;
    const backEl = ov.querySelector<HTMLElement>(".fr-back")!;
    const show = ov.querySelector<HTMLElement>(".fr-show")!;
    const rates = ov.querySelector<HTMLElement>(".fr-rates")!;

    const done = () => {
      ov.remove();
      refreshCount();
      say(`session done — ${againCount} again${againCount === 1 ? "" : "s"}`);
      addActivity(`cards: reviewed "${card.dataset.topic}" (${againCount} again)`);
    };

    const cur = () => queue[i];
    const render = () => {
      const r = cur();
      if (!r) {
        done();
        return;
      }
      const c = rowCard(r);
      const sch = schedOf();
      const s = sch.get(r.dataset.h ?? "") ?? NEW_SCHED;
      prog.textContent = `${i + 1} / ${queue.length}`;
      frontEl.textContent = c.front;
      backEl.textContent = "";
      backEl.style.display = "none";
      show.style.display = "";
      rates.style.display = "none";
      flipped = false;
      // interval previews — Anki's convention, shown before you rate
      ov.querySelector<HTMLElement>(".fr-again small")!.textContent = previewIvl(s, 0);
      ov.querySelector<HTMLElement>(".fr-hard small")!.textContent = previewIvl(s, 1);
      ov.querySelector<HTMLElement>(".fr-good small")!.textContent = previewIvl(s, 2);
      ov.querySelector<HTMLElement>(".fr-easy small")!.textContent = previewIvl(s, 3);
      void s;
    };

    const flip = () => {
      const c = rowCard(cur());
      backEl.textContent = c.back;
      backEl.style.display = "";
      show.style.display = "none";
      rates.style.display = "";
      flipped = true;
    };

    const rate = (g: 0 | 1 | 2 | 3) => {
      const r = cur();
      const m = schedOf();
      const h = r.dataset.h ?? "";
      const next = grade(m.get(h) ?? { ...NEW_SCHED }, g);
      m.set(h, next);
      saveSched(m);
      r.querySelector<HTMLElement>(".fc-due")!.textContent = next.ivl > 0 ? next.due.slice(5) : "due";
      if (g === 0) {
        againCount++;
        queue.push(r); // again → back of the queue this session
      }
      i++;
      render();
    };

    show.addEventListener("click", flip);
    ov.querySelector<HTMLElement>(".fr-again")!.addEventListener("click", () => rate(0));
    ov.querySelector<HTMLElement>(".fr-hard")!.addEventListener("click", () => rate(1));
    ov.querySelector<HTMLElement>(".fr-good")!.addEventListener("click", () => rate(2));
    ov.querySelector<HTMLElement>(".fr-easy")!.addEventListener("click", () => rate(3));
    ov.querySelector<HTMLElement>(".fr-x")!.addEventListener("click", () => {
      ov.remove();
      say("session ended");
    });
    const key = (e: KeyboardEvent) => {
      if (!ov.isConnected) {
        document.removeEventListener("keydown", key);
        return;
      }
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!flipped) flip();
        else rate(2);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        rate((Number(e.key) - 1) as 0 | 1 | 2 | 3);
      } else if (e.key === "Escape") {
        ov.remove();
        say("session ended");
      }
      e.stopPropagation();
    };
    document.addEventListener("keydown", key);
    render();
  };

  tools.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.a === "review") review();
    else if (b.dataset.a === "add") addRow.classList.toggle("open");
  });
  addRow.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a='ok']");
    if (!b) return;
    const ins = addRow.querySelectorAll<HTMLInputElement>(".fc-in");
    const msg = addCard(ins[0]?.value ?? "", ins[1]?.value ?? "");
    say(msg);
    if (!msg.startsWith("✕")) {
      ins[0]!.value = "";
      ins[1]!.value = "";
    }
  });
  addRow.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRow.querySelector<HTMLElement>("[data-a='ok']")?.click();
    }
    e.stopPropagation();
  });
  refreshCount();

  apis.set(card, {
    cards: () =>
      Array.from(list.querySelectorAll<HTMLElement>(".fc-row")).map(rowCard),
    add: addCard,
    del: delCard,
    due: () => {
      const sch = schedOf();
      const rows = Array.from(list.querySelectorAll<HTMLElement>(".fc-row"));
      const d = rows.filter((r) => isDue(sch.get(r.dataset.h ?? "")));
      if (!d.length) return "nothing due";
      return d
        .map((r) => {
          const c = rowCard(r);
          const s = sch.get(r.dataset.h ?? "");
          return `${c.front} :: ${c.back} (${s ? `due ${s.due}, ivl ${s.ivl}d` : "new"})`;
        })
        .join("\n");
    },
    rate: rateCard,
    list: () => {
      const rows = Array.from(list.querySelectorAll<HTMLElement>(".fc-row"));
      if (!rows.length) return "empty deck";
      return rows.map((r) => {
        const c = rowCard(r);
        return `${c.front} :: ${c.back}`;
      }).join("\n");
    },
  });
}
