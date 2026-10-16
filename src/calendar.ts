import { $, invoke } from "./ipc.js";
import { addActivity } from "./log.js";
import { openTab } from "./tabs.js";
import { currentLang, t } from "./i18n.js";

/* ---------- schedule calendar — krono-style views over @schedule lines ---------- */

interface DayPin {
  day: number;
  time: string;
  action: string;
  note: string;
  line: string;
  kind: string;
}
interface Occ extends DayPin {
  date: string; // YYYY-MM-DD
}
type View = "month" | "week" | "day" | "agenda";

const KINDS = ["brief", "review", "remind", "research", "prompt", "ask"] as const;
const HOUR_H = 52;
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

let view: View = "month";
let cur = new Date();
let cache = new Map<string, DayPin[]>();
let editOf: Occ | null = null;
let specLocked = false;

const pad = (n: number) => String(n).padStart(2, "0");
const dkey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a: Date, b: Date) => dkey(a) === dkey(b);
const today = () => new Date();

function actionTitle(a: string): string {
  return a
    .replace(/^@research\s+/, "research: ")
    .replace(/^@skill\s+/, "skill: ")
    .replace(/^remind:\s*/, "")
    .replace(/^prompt:\s*/, "")
    .replace(/^\?\s*/, "ask: ");
}

function specOf(line: string): string {
  const t = line.trim().replace(/^@schedule\s+/, "").replace(/\s+off$/, "");
  return t.replace(/\s+(brief|review|remind:.*|prompt:.*|\?.*|@.*)$/, "");
}

async function pinsFor(y: number, m: number): Promise<DayPin[]> {
  const key = `${y}-${m}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let pins: DayPin[] = [];
  try {
    pins = await invoke<DayPin[]>("schedule_month", { year: y, month: m });
  } catch {
    pins = [];
  }
  cache.set(key, pins);
  return pins;
}

/** occurrences on a set of YYYY-MM-DD dates — fetches every covered month */
async function occsOn(dates: string[]): Promise<Map<string, Occ[]>> {
  const months = new Map<string, { y: number; m: number }>();
  for (const d of dates) {
    const [y, m] = d.split("-").map(Number);
    months.set(`${y}-${m}`, { y, m });
  }
  for (const { y, m } of months.values()) await pinsFor(y, m);
  const out = new Map<string, Occ[]>();
  for (const d of dates) {
    const [y, m, day] = d.split("-").map(Number);
    const list = (cache.get(`${y}-${m}`) ?? [])
      .filter((p) => p.day === day)
      .map((p) => ({ ...p, date: d }));
    if (list.length) out.set(d, list);
  }
  return out;
}

async function refresh() {
  cache = new Map();
  render();
}

export function openCalendar() {
  cur = today();
  $("#cal-modal").classList.remove("hidden");
  render();
}

/* ---------- navigation ---------- */
function shift(dir: number) {
  const d = new Date(cur);
  if (view === "week") d.setDate(d.getDate() + 7 * dir);
  else if (view === "day") d.setDate(d.getDate() + dir);
  else d.setMonth(d.getMonth() + dir); // month + agenda move a month
  cur = d;
  render();
}

function title(): string {
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(currentLang(), o).format(d);
  if (view === "day") return fmt(cur, { weekday: "long", month: "long", day: "numeric" });
  if (view === "week") {
    const s = weekStart(cur);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    const sm = fmt(s, { month: "short", day: "numeric" });
    const em = fmt(e, { month: "short", day: "numeric" });
    return `${sm} – ${em}`;
  }
  return fmt(cur, { month: "long", year: "numeric" });
}

function weekStart(d: Date): Date {
  const s = new Date(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // monday
  return s;
}

function render() {
  $("#cal-title").textContent = title();
  document.querySelectorAll("#cal-views button").forEach((b) => {
    b.classList.toggle("on", (b as HTMLElement).dataset.v === view);
  });
  const host = $("#cal-view");
  host.innerHTML = "";
  if (view === "month") renderMonth(host);
  else if (view === "week") renderGrid(host, weekDays());
  else if (view === "day") renderGrid(host, [new Date(cur)]);
  else void renderAgenda(host);
}

function weekDays(): Date[] {
  const s = weekStart(cur);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(s);
    d.setDate(s.getDate() + i);
    return d;
  });
}

/* ---------- month view ---------- */
function renderMonth(host: HTMLElement) {
  const y = cur.getFullYear();
  const mo = cur.getMonth();
  const first = new Date(y, mo, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // monday before the 1st
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  const wdRow = document.createElement("div");
  wdRow.className = "cal-wk";
  for (const n of weekdayLabels()) {
    const s = document.createElement("span");
    s.textContent = n;
    wdRow.append(s);
  }
  const grid = document.createElement("div");
  grid.className = "cal-mgrid";
  host.append(wdRow, grid);

  void occsOn(days.map(dkey)).then((occ) => {
    grid.innerHTML = "";
    for (const d of days) {
      const cell = document.createElement("div");
      cell.className = "cal-mday";
      if (d.getMonth() !== mo) cell.classList.add("dim");
      if (sameDay(d, today())) cell.classList.add("today");
      const head = document.createElement("div");
      head.className = "cal-mhead";
      const num = document.createElement("button");
      num.className = "cal-mnum";
      num.textContent = String(d.getDate());
      num.addEventListener("click", (e) => {
        e.stopPropagation();
        cur = new Date(d);
        view = "day";
        render();
      });
      const plus = document.createElement("button");
      plus.className = "cal-mplus";
      plus.textContent = "+";
      plus.title = "Add entry";
      plus.addEventListener("click", (e) => {
        e.stopPropagation();
        openAdd(dkey(d));
      });
      head.append(num, plus);
      cell.append(head);

      const list = occ.get(dkey(d)) ?? [];
      for (const p of list.slice(0, 3)) cell.append(chip(p));
      if (list.length > 3) {
        const more = document.createElement("button");
        more.className = "cal-mmore";
        more.textContent = `+${list.length - 3} more`;
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          cur = new Date(d);
          view = "day";
          render();
        });
        cell.append(more);
      }
      cell.addEventListener("click", () => openAdd(dkey(d)));
      grid.append(cell);
    }
  });
}

function chip(p: Occ): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "cal-chip";
  b.title = `${p.time} · ${p.action} · ${p.note}`;
  const dot = document.createElement("span");
  dot.className = `cal-dot kind-${p.kind}`;
  const tm = document.createElement("span");
  tm.className = "cal-chip-time";
  tm.textContent = p.time;
  const tx = document.createElement("span");
  tx.className = "cal-chip-tx";
  tx.textContent = actionTitle(p.action);
  b.append(dot, tm, tx);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetail(p, b);
  });
  return b;
}

/* ---------- week + day time grids ---------- */
function renderGrid(host: HTMLElement, days: Date[]) {
  void occsOn(days.map(dkey)).then((occ) => {
    host.innerHTML = "";
    const head = document.createElement("div");
    head.className = "cal-thead";
    const g0 = document.createElement("span");
    g0.className = "cal-tgut";
    g0.textContent = "time";
    head.append(g0);
    for (const d of days) {
      const h = document.createElement("button");
      h.className = "cal-tday-head" + (sameDay(d, today()) ? " today" : "");
      const wd = document.createElement("span");
      wd.className = "cal-twd";
      wd.textContent = weekdayLabels()[d.getDay()];
      const num = document.createElement("span");
      num.className = "cal-tnum";
      num.textContent = String(d.getDate());
      h.append(wd, num);
      h.addEventListener("click", () => {
        cur = new Date(d);
        view = "day";
        render();
      });
      head.append(h);
    }
    host.append(head);

    const body = document.createElement("div");
    body.className = "cal-tbody";
    host.append(body);
    const gut = document.createElement("div");
    gut.className = "cal-tgut";
    for (let h = 0; h < 24; h++) {
      const s = document.createElement("div");
      s.className = "cal-tlabel";
      s.style.height = `${HOUR_H}px`;
      s.textContent = h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`;
      gut.append(s);
    }
    body.append(gut);
    const cols = document.createElement("div");
    cols.className = "cal-tcols";
    body.append(cols);

    const nowTop = ((today().getHours() * 60 + today().getMinutes()) / 60) * HOUR_H;
    for (const d of days) {
      const col = document.createElement("div");
      col.className = "cal-tcol";
      col.style.height = `${24 * HOUR_H}px`;
      for (let h = 0; h < 24; h++) {
        const rule = document.createElement("div");
        rule.className = "cal-trule";
        rule.style.height = `${HOUR_H}px`;
        col.append(rule);
      }
      col.addEventListener("click", (e) => {
        if (e.target !== col && !(e.target as HTMLElement).classList.contains("cal-trule")) return;
        const r = col.getBoundingClientRect();
        const hour = Math.min(23, Math.max(0, Math.floor((e.clientY - r.top) / HOUR_H)));
        openAdd(dkey(d), hour);
      });
      if (sameDay(d, today())) {
        const line = document.createElement("div");
        line.className = "cal-now";
        line.style.top = `${nowTop}px`;
        col.append(line);
      }
      // same-minute entries share the column side-by-side
      const list = [...(occ.get(dkey(d)) ?? [])].sort((a, b) => a.time.localeCompare(b.time));
      const groups = new Map<string, Occ[]>();
      for (const p of list) {
        const g = groups.get(p.time) ?? [];
        g.push(p);
        groups.set(p.time, g);
      }
      for (const [tm, gs] of groups) {
        const [hh, mm] = tm.split(":").map(Number);
        gs.forEach((p, i) => {
          const ev = document.createElement("button");
          ev.className = `cal-event kind-${p.kind}`;
          ev.style.top = `${((hh * 60 + mm) / 60) * HOUR_H}px`;
          ev.style.height = `${Math.min(HOUR_H - 6, 46)}px`;
          ev.style.left = `${(i / gs.length) * 100}%`;
          ev.style.width = `${100 / gs.length}%`;
          ev.title = `${p.time} · ${p.action} · ${p.note}`;
          const t1 = document.createElement("span");
          t1.className = "cal-event-t";
          t1.textContent = p.time;
          const t2 = document.createElement("span");
          t2.className = "cal-event-x";
          t2.textContent = actionTitle(p.action);
          ev.append(t1, t2);
          ev.addEventListener("click", (e) => {
            e.stopPropagation();
            openDetail(p, ev);
          });
          col.append(ev);
        });
      }
      cols.append(col);
    }
    // land on the workday like krono does
    body.scrollTop = 7.5 * HOUR_H;
  });
}

/* ---------- agenda view ---------- */
async function renderAgenda(host: HTMLElement) {
  const y = cur.getFullYear();
  const mo = cur.getMonth();
  const days = new Date(y, mo + 1, 0).getDate();
  const dates = Array.from({ length: days }, (_, i) => dkey(new Date(y, mo, i + 1)));
  const occ = await occsOn(dates);
  const wrap = document.createElement("div");
  wrap.className = "cal-agenda";
  host.innerHTML = "";
  host.append(wrap);
  let any = false;
  for (const d of dates) {
    const list = occ.get(d);
    if (!list?.length) continue;
    any = true;
    const dt = new Date(`${d}T00:00:00`);
    const head = document.createElement("div");
    head.className = "cal-ahead" + (sameDay(dt, today()) ? " today" : "");
    const dn = document.createElement("span");
    dn.className = "cal-adnum";
    dn.textContent = String(dt.getDate());
    const dl = document.createElement("span");
    dl.className = "cal-adlab";
    dl.textContent = new Intl.DateTimeFormat(currentLang(), {
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(dt) + (sameDay(dt, today()) ? " · today" : "");
    head.append(dn, dl);
    wrap.append(head);
    for (const p of list) {
      const row = document.createElement("button");
      row.className = "cal-arow";
      const dot = document.createElement("span");
      dot.className = `cal-dot kind-${p.kind}`;
      const tm = document.createElement("span");
      tm.className = "cal-arow-t";
      tm.textContent = p.time;
      const tx = document.createElement("span");
      tx.className = "cal-arow-x";
      tx.textContent = actionTitle(p.action);
      const spec = document.createElement("span");
      spec.className = "cal-arow-s";
      spec.textContent = specOf(p.line);
      spec.title = p.line;
      row.append(dot, tm, tx, spec);
      row.addEventListener("click", () => openDetail(p, row));
      wrap.append(row);
    }
  }
  if (!any) {
    const e = document.createElement("div");
    e.className = "cal-empty";
    e.textContent = t("cal.nothing");
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = "+ Add entry";
    b.addEventListener("click", () => openAdd(dkey(cur)));
    e.append(b);
    wrap.append(e);
  }
}

/* ---------- detail popover ---------- */
function openDetail(p: Occ, anchor: HTMLElement) {
  closeDetail();
  const el = $("#cal-detail");
  const paused = p.line.trim().endsWith(" off");
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "cal-dhead";
  const dot = document.createElement("span");
  dot.className = `cal-dot kind-${p.kind}`;
  const ti = document.createElement("span");
  ti.className = "cal-dtitle";
  ti.textContent = actionTitle(p.action);
  const x = document.createElement("button");
  x.className = "ghost mini";
  x.textContent = "✕";
  x.addEventListener("click", closeDetail);
  head.append(dot, ti, x);
  const meta = document.createElement("div");
  meta.className = "cal-dmeta";
  const dt = new Date(`${p.date}T00:00:00`);
  meta.textContent = `${new Intl.DateTimeFormat(currentLang(), {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dt)} · ${p.time} · ${specOf(p.line)} · ${p.note}${paused ? " · paused" : ""}`;
  const btns = document.createElement("div");
  btns.className = "cal-dbtns";
  const mk = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = `ghost mini ${cls}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    btns.append(b);
  };
  mk(t("cal.runNow"), "", () => {
    void invoke("schedule_run_now", { note: p.note, line: p.line })
      .then(() => addActivity(`⚡ ran: ${p.action}`))
      .catch((err) => addActivity(`✕ ${String(err)}`));
    closeDetail();
  });
  mk(paused ? "resume" : t("cal.pause"), "", () => {
    void invoke("schedule_toggle", { note: p.note, line: p.line }).then(() => void refresh());
    closeDetail();
  });
  mk("edit", "", () => {
    closeDetail();
    openEdit(p);
  });
  mk(t("cal.note"), "", () => {
    void openTab(p.note);
    closeDetail();
  });
  mk(t("cal.delete"), "bad", () => {
    void invoke("schedule_remove", { note: p.note, line: p.line }).then(() => void refresh());
    closeDetail();
  });
  el.append(head, meta, btns);
  el.classList.remove("hidden");
  const card = $("#cal-modal .modal-card").getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.min(r.bottom - card.top + 6, card.height - 140)}px`;
  el.style.left = `${Math.max(8, Math.min(r.left - card.left, card.width - 330))}px`;
}
function closeDetail() {
  $("#cal-detail").classList.add("hidden");
}

/* ---------- add / edit entry modal ---------- */
function kindChips() {
  const host = $("#cal-add-kinds");
  host.innerHTML = "";
  for (const k of KINDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cal-kchip kind-${k}`;
    b.dataset.k = k;
    b.innerHTML = `<span class="cal-dot kind-${k}"></span>${k}`;
    b.addEventListener("click", () => {
      host.querySelectorAll(".cal-kchip").forEach((c) => c.classList.remove("on"));
      b.classList.add("on");
      syncActionField();
    });
    host.append(b);
  }
  (host.firstElementChild as HTMLElement)?.classList.add("on");
}
function pickedKind(): string {
  return ($("#cal-add-kinds .cal-kchip.on") as HTMLElement | null)?.dataset.k ?? "brief";
}
function syncActionField() {
  const needsText = !["brief", "review"].includes(pickedKind());
  $("#cal-add-text-row").classList.toggle("hidden", !needsText);
}

function freqSpec(): string {
  const freq = $<HTMLSelectElement>("#cal-freq").value;
  const time = $<HTMLInputElement>("#cal-add-time").value || "08:00";
  const date = $<HTMLInputElement>("#cal-add-date").value || dkey(cur);
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (freq === "once") return `once ${date} ${time}`;
  if (freq === "daily") return `daily ${time}`;
  if (freq === "weekly") return `${WD[dt.getDay()]} ${time}`;
  if (freq === "monthly") return `monthly ${dt.getDate()} ${time}`;
  if (freq === "weekdays") return `mon-fri ${time}`;
  const n = Math.max(1, Math.min(72, parseInt($<HTMLInputElement>("#cal-add-every").value) || 2));
  return `every ${n}h`;
}

function actionSpec(): string {
  const kind = pickedKind();
  const text = $<HTMLInputElement>("#cal-add-text").value.trim();
  if (kind === "brief") return "brief";
  if (kind === "review") return "review";
  if (kind === "remind") return `remind: ${text}`;
  if (kind === "research") return `@research ${text}`;
  if (kind === "ask") return `? ${text}`;
  return `prompt: ${text}`;
}

function openAdd(date?: string, hour?: number) {
  editOf = null;
  specLocked = false;
  $("#cal-add-title").textContent = "New entry";
  $("#cal-add-save").textContent = "Inscribe entry";
  $("#cal-add-hint").textContent = "";
  $<HTMLInputElement>("#cal-add-text").value = "";
  $<HTMLInputElement>("#cal-add-date").value = date ?? dkey(cur);
  $<HTMLInputElement>("#cal-add-time").value =
    hour !== undefined ? `${pad(hour)}:00` : "08:00";
  $<HTMLSelectElement>("#cal-freq").value = "once";
  $<HTMLSelectElement>("#cal-freq").disabled = false;
  syncFreqUI();
  kindChips();
  $("#cal-add-text-row").classList.add("hidden");
  $("#cal-add").classList.remove("hidden");
  window.setTimeout(() => $<HTMLInputElement>("#cal-add-text").focus(), 40);
}

/** recover controls from a @schedule line; exotic specs stay verbatim (specLocked) */
function openEdit(p: Occ) {
  editOf = p;
  specLocked = false;
  $("#cal-add-title").textContent = "Edit entry";
  $("#cal-add-save").textContent = "Save revisions";
  kindChips();
  const a = p.action;
  const kind =
    a === "brief" ? "brief"
    : a === "review" ? "review"
    : a.startsWith("@research") ? "research"
    : a.startsWith("remind:") ? "remind"
    : a.startsWith("?") ? "ask" : "prompt";
  document.querySelectorAll("#cal-add-kinds .cal-kchip").forEach((c) => {
    c.classList.toggle("on", (c as HTMLElement).dataset.k === kind);
  });
  const text = a
    .replace(/^@research\s+/, "")
    .replace(/^remind:\s*/, "")
    .replace(/^prompt:\s*/, "")
    .replace(/^\?\s*/, "");
  $<HTMLInputElement>("#cal-add-text").value = ["brief", "review"].includes(kind) ? "" : text;
  $<HTMLInputElement>("#cal-add-note").value = p.note;
  syncActionField();

  // spec → controls, or lock it if the grammar can't be round-tripped
  const spec = specOf(p.line);
  const freq = $<HTMLSelectElement>("#cal-freq");
  const setTime = (s: string) => ($<HTMLInputElement>("#cal-add-time").value = s);
  const once = spec.match(/^once (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
  const daily = spec.match(/^daily (\d{2}:\d{2})$/);
  const every = spec.match(/^every (\d+)h$/);
  const monthly = spec.match(/^monthly (\d{1,2}) (\d{2}:\d{2})$/);
  const days = spec.match(/^([a-z-]+) (\d{2}:\d{2})$/);
  freq.disabled = false;
  if (once) {
    freq.value = "once";
    $<HTMLInputElement>("#cal-add-date").value = once[1];
    setTime(once[2]);
  } else if (daily) {
    freq.value = "daily";
    setTime(daily[1]);
  } else if (every) {
    freq.value = "every";
    $<HTMLInputElement>("#cal-add-every").value = every[1];
  } else if (monthly) {
    freq.value = "monthly";
    setTime(monthly[2]);
  } else if (days && days[1] === "mon-fri") {
    freq.value = "weekdays";
    setTime(days[2]);
  } else if (days && WD.includes(days[1])) {
    freq.value = "weekly";
    setTime(days[2]);
    // keep the picked date on that weekday so the rebuild produces the same day
    const wd = WD.indexOf(days[1]);
    const d = new Date();
    while (d.getDay() !== wd) d.setDate(d.getDate() + 1);
    $<HTMLInputElement>("#cal-add-date").value = dkey(d);
  } else {
    specLocked = true;
    freq.disabled = true;
    $("#cal-add-hint").textContent = `keeps its schedule text — “${spec}”`;
  }
  if (!specLocked) $("#cal-add-hint").textContent = "";
  syncFreqUI();
  $("#cal-add").classList.remove("hidden");
  window.setTimeout(() => $<HTMLInputElement>("#cal-add-text").focus(), 40);
}

function syncFreqUI() {
  const v = $<HTMLSelectElement>("#cal-freq").value;
  $("#cal-add-every").classList.toggle("hidden", v !== "every");
  $("#cal-add-date-row").classList.toggle("hidden", ["daily", "weekdays", "every"].includes(v));
}

async function saveEntry() {
  const note = $<HTMLInputElement>("#cal-add-note").value.trim() || "schedule.laido";
  const kind = pickedKind();
  const text = $<HTMLInputElement>("#cal-add-text").value.trim();
  if (!["brief", "review"].includes(kind) && !text) {
    $<HTMLInputElement>("#cal-add-text").focus();
    return;
  }
  const spec = specLocked && editOf ? specOf(editOf.line) : freqSpec();
  try {
    const line = await invoke<string>("schedule_create", {
      note,
      spec,
      action: actionSpec(),
    });
    if (editOf) await invoke("schedule_remove", { note: editOf.note, line: editOf.line });
    addActivity(`⏰ scheduled: ${line}`);
    $("#cal-add").classList.add("hidden");
    editOf = null;
    await refresh();
  } catch (e) {
    addActivity(`✕ ${String(e)}`);
  }
}

function weekdayLabels(): string[] {
  const monday = new Date(2026, 9, 12);
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(currentLang(), { weekday: "short" }).format(
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i),
    ),
  );
}

export function initCalendar() {
  $("#btn-calendar").addEventListener("click", () => openCalendar());
  $("#cal-close").addEventListener("click", () => $("#cal-modal").classList.add("hidden"));
  $("#cal-prev").addEventListener("click", () => shift(-1));
  $("#cal-next").addEventListener("click", () => shift(1));
  $("#cal-today").addEventListener("click", () => {
    cur = today();
    render();
  });
  $("#cal-add-btn").addEventListener("click", () => openAdd());
  $("#cal-add-save").addEventListener("click", () => void saveEntry());
  $("#cal-add-cancel").addEventListener("click", () => $("#cal-add").classList.add("hidden"));
  $("#cal-add-discard").addEventListener("click", () => $("#cal-add").classList.add("hidden"));
  $("#cal-freq").addEventListener("change", syncFreqUI);
  document.querySelectorAll("#cal-views button").forEach((b) => {
    b.addEventListener("click", () => {
      view = (b as HTMLElement).dataset.v as View;
      render();
    });
  });
  document.addEventListener("pointerdown", (e) => {
    const d = $("#cal-detail");
    if (!d || d.classList.contains("hidden")) return;
    if ((e.target as HTMLElement).closest("#cal-detail")) return;
    closeDetail();
  });
  // krono keys: m/w/d/a views · t today · n new · arrows navigate · esc closes
  document.addEventListener("keydown", (e) => {
    if ($("#cal-modal").classList.contains("hidden")) return;
    if (!$("#cal-add").classList.contains("hidden")) {
      if (e.key === "Escape") $("#cal-add").classList.add("hidden");
      return;
    }
    const tag = (e.target as HTMLElement).tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    if (e.key === "Escape") {
      $("#cal-modal").classList.add("hidden");
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "t") { cur = today(); render(); }
    else if (k === "n") openAdd();
    else if (k === "arrowleft") shift(-1);
    else if (k === "arrowright") shift(1);
    else if (["m", "w", "d", "a"].includes(k)) {
      view = { m: "month", w: "week", d: "day", a: "agenda" }[k] as View;
      render();
    }
  });
}
