import { $, invoke } from "./ipc.js";
import { currentNote, insertCallout, hidePencil, loadNote, appendToNote, pinCard, layoutLoopRun } from "./editor.js";
import { addActivity } from "./log.js";
import { openCalendar } from "./calendar.js";
import { openTab } from "./tabs.js";
import { t } from "./i18n.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

export interface Settings {
  nebius_api_key: string;
  tavily_api_key: string;
  theme: string;
  base_url: string;
  model_fast: string;
  model_main: string;
  model_deep: string;
  model_rewrite: string;
  model_ocr: string;
  laido_session: string;
  laido_email: string;
}

interface PingResult {
  model: string;
  reply: string;
}

interface TavilyPing {
  results: number;
  first_title: string;
}

interface ActivityPayload {
  text: string;
}

interface ResearchDone {
  note: string;
  topic: string;
  callout: string;
  kind?: string;
  quiet?: boolean;
  anchor?: string | null;
  parent?: string | null;
  question?: string | null;
  loop?: number;
  total?: number;
  run?: string;
}

interface Reminder {
  note: string;
  text: string;
  ts: number;
}

interface SchedRow {
  note: string;
  line: string;
  action: string;
  next: number;
  last: number;
  paused: boolean;
}

/** site → gateway base for lk- keys */
const LAIDO_SITE = "https://laido.zraldwebdevelopmentservices.shop";
const LAIDO_GW = `${LAIDO_SITE}/v1`;

/** keys minted on the site only work on the Laido gateway; direct provider
 *  keys need the provider URL — route base_url accordingly on save. */
export function keyBasePatch(key: string, currentBase: string): string | undefined {
  if (key.startsWith("lk-")) return LAIDO_GW;
  if (currentBase === LAIDO_GW) return PROVIDERS.nebius;
  return undefined;
}

/** BYOK endpoints — name → OpenAI-compatible base URL */
export const PROVIDERS: Record<string, string> = {
  laido: LAIDO_GW,
  nebius: "https://api.tokenfactory.nebius.com/v1",
  cerebras: "https://api.cerebras.ai/v1",
  bitdeer: "https://api.bitdeer.ai/v1",
  openai: "https://api.openai.com/v1",
};

/** which provider preset the current key/base pair maps to */
function detectProvider(key: string, base: string): string {
  if (key.startsWith("lk-") || base === LAIDO_GW) return "laido";
  for (const [name, url] of Object.entries(PROVIDERS)) {
    if (name !== "laido" && url === base) return name;
  }
  return "custom";
}

/** managed mode: lk- key → the server owns model choice; the app sends
 *  sentinel values and the gateway substitutes the admin-configured models */
let managed = false;

export function modelPatch(): Record<string, string> {
  if (managed) {
    return {
      model_fast: "auto",
      model_main: "auto",
      model_deep: "auto",
      model_rewrite: "auto",
      model_ocr: "ocr",
    };
  }
  const pick = (id: string, cur: string) => {
    const v = $<HTMLSelectElement>(id)?.value;
    return v || cur;
  };
  return {
    model_fast: pick("#model-fast", settings?.model_fast ?? ""),
    model_main: pick("#model-main", settings?.model_main ?? ""),
    model_deep: pick("#model-deep", settings?.model_deep ?? ""),
    model_rewrite: pick("#model-rewrite-set", settings?.model_rewrite ?? ""),
    model_ocr: pick("#model-ocr-set", settings?.model_ocr ?? ""),
  };
}

/** reflect provider + managed state into the settings UI */
function applyProviderUI() {
  const prov = $<HTMLSelectElement>("#provider-select");
  const baseIn = $<HTMLInputElement>("#base-url");
  const locked = $("#model-locked");
  if (!prov) return;
  const key = $<HTMLInputElement>("#key-nebius")?.value.trim() ?? "";
  const p = detectProvider(key, settings?.base_url ?? "");
  prov.value = p;
  managed = p === "laido";
  if (baseIn) {
    baseIn.classList.toggle("hidden", p !== "custom");
    if (p === "custom") baseIn.value = settings?.base_url ?? "";
  }
  locked?.classList.toggle("hidden", !managed);
  // every model select — settings panel + quick picks — locks under the plan
  for (const id of [
    "#model-fast", "#model-main", "#model-deep", "#model-rewrite-set",
    "#model-ocr-set", "#model-quick", "#model-rewrite", "#model-ocr",
  ]) {
    const el = $<HTMLSelectElement>(id);
    if (el) el.disabled = managed;
  }
  const refresh = $<HTMLButtonElement>("#models-refresh");
  if (refresh) refresh.disabled = managed;
}

const FALLBACK_MODELS = [
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "nvidia/Nemotron-3_5-Lightning",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/Nemotron-3-Ultra-550b-a55b",
];

const short = (m: string) => m.split("/").pop() ?? m;

let settings: Settings | null = null;
let models: string[] = [];

export async function refreshStatus() {
  settings = await invoke<Settings>("settings_get");
  $<HTMLInputElement>("#key-nebius").value = settings.nebius_api_key;
  $<HTMLInputElement>("#key-tavily").value = settings.tavily_api_key;
  const dot = $("#api-status .dot");
  const text = $("#api-status-text");
  if (settings.nebius_api_key) {
    dot.className = "dot ok";
    text.textContent = "ready";
  } else {
    dot.className = "dot warn";
    text.textContent = "sign in or add a key";
  }
  renderAccount();
  applyProviderUI();
}

/* ---- Laido account: sign in with Google via the site, key auto-installed ---- */

let laidoSigning = false;

function acctHint(s: string) {
  const el = $("#laido-hint");
  if (el) el.textContent = s;
}

export function renderAccount() {
  const who = $("#laido-acct");
  const sout = $("#laido-signout");
  const hdr = $<HTMLButtonElement>("#hdr-acct");
  if (settings?.laido_email) {
    if (who) { who.textContent = `${settings.laido_email}`; who.className = ""; }
    sout?.classList.remove("hidden");
    if (hdr) hdr.textContent = "Account · plans";
  } else {
    if (who) { who.textContent = "not signed in"; who.className = "muted"; }
    sout?.classList.add("hidden");
    if (hdr) hdr.textContent = "Sign in";
  }
}

export function initAccount() {
  $("#laido-signin")?.addEventListener("click", () => void laidoSignIn());
  // header button — signed in → the site dashboard (buy credits / manage
  // plan); signed out → the same Google sign-in flow
  $("#hdr-acct")?.addEventListener("click", async () => {
    if (settings?.laido_email) {
      await invoke("open_url", { url: `${LAIDO_SITE}/#dash` });
    } else {
      void laidoSignIn();
    }
  });
  $("#laido-signout")?.addEventListener("click", async () => {
    await invoke("settings_set", { patch: { laido_session: "", laido_email: "" } });
    await refreshStatus();
    acctHint("signed out — the installed API key still works until you delete it on the site");
  });
}

async function laidoSignIn() {
  if (laidoSigning) return;
  laidoSigning = true;
  const btn = $<HTMLButtonElement>("#laido-signin");
  btn.disabled = true;
  try {
    acctHint("opening your browser…");
    const begin = await invoke<{ sid: string; url: string }>("laido_auth_begin");
    await invoke("open_url", { url: begin.url });
    acctHint("finish signing in in your browser — this window is waiting…");
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      let res: { status: string; token?: string };
      try {
        res = await invoke<{ status: string; token?: string }>("laido_auth_poll", { sid: begin.sid });
      } catch {
        continue; // transient network blip — keep polling
      }
      if (res.status === "expired") {
        acctHint("link expired — try again");
        return;
      }
      if (res.status === "ok" && res.token) {
        const fin = await invoke<{ email: string; plan: string }>("laido_auth_finish", { token: res.token });
        await refreshStatus();
        await loadModels();
        syncModelSelects();
        acctHint(`signed in as ${fin.email} · ${fin.plan} — API key installed`);
        addActivity(`✓ signed in: ${fin.email} (${fin.plan}) — gateway key installed`);
        return;
      }
    }
    acctHint("timed out — try again");
  } catch (e) {
    acctHint(`sign-in failed: ${String(e)}`);
  } finally {
    btn.disabled = false;
    laidoSigning = false;
  }
}

async function loadModels() {
  try {
    models = await invoke<string[]>("llm_models");
  } catch {
    models = FALLBACK_MODELS;
  }
  if (models.length === 0) models = FALLBACK_MODELS;
}

const NON_CHAT = /embed|rerank|moderation|guard/i;
/** ids that look vision-capable — the OCR select only offers these */
const VISION =
  /vision|multimodal|vlm|vl2|[-_]vl\b|llava|pixtral|moondream|internvl|minicpm-[vo]|idefics|paligemma|gemma-3|gpt-4o|gpt-4\.1|gpt-5|gemini|molmo|got-?ocr|florence|kimi|deepseek-vl|qvq|janus|emu3|ovis|fuyu|bagel|llama-4|glm-\d.*v|4\.\d+v|nemotron-parse|ui-?tars|\baria\b|\b4v\b|ocr|image/i;

function fillSelect(sel: HTMLSelectElement, current: string, visionOnly = false) {
  sel.innerHTML = "";
  const pool = models.filter(
    (m) => !NON_CHAT.test(m) && (!visionOnly || VISION.test(m) || m === current),
  );
  const list = pool.includes(current) ? pool : current ? [current, ...pool] : pool;
  for (const m of list) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m ? short(m) : "(no vision model — pick one)";
    o.title = m;
    o.disabled = !m;
    sel.append(o);
  }
  sel.value = current;
}

export function syncModelSelects() {
  if (!settings) return;
  if (managed) {
    // server-managed — show what the gateway will route to, not a picker
    const lock = (id: string, label: string) => {
      const sel = $<HTMLSelectElement>(id);
      if (!sel) return;
      sel.innerHTML = "";
      const o = document.createElement("option");
      o.value = o.textContent = label;
      sel.append(o);
      sel.value = label;
      sel.disabled = true;
    };
    const auto = "auto — managed by plan";
    lock("#model-quick", auto); lock("#model-rewrite", auto);
    lock("#model-fast", auto); lock("#model-main", auto);
    lock("#model-deep", auto); lock("#model-rewrite-set", auto);
    lock("#model-ocr", auto); lock("#model-ocr-set", auto);
    return;
  }
  fillSelect($<HTMLSelectElement>("#model-quick"), settings.model_main);
  fillSelect($<HTMLSelectElement>("#model-rewrite"), settings.model_rewrite);
  fillSelect($<HTMLSelectElement>("#model-fast"), settings.model_fast);
  fillSelect($<HTMLSelectElement>("#model-main"), settings.model_main);
  fillSelect($<HTMLSelectElement>("#model-deep"), settings.model_deep);
  fillSelect($<HTMLSelectElement>("#model-rewrite-set"), settings.model_rewrite);
  fillSelect($<HTMLSelectElement>("#model-ocr"), settings.model_ocr, true);
  fillSelect($<HTMLSelectElement>("#model-ocr-set"), settings.model_ocr, true);
}

export async function initModels() {
  await loadModels();
  syncModelSelects();

  $<HTMLSelectElement>("#model-quick").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await invoke("settings_set", { patch: { model_main: value } });
    addActivity(`agent model → ${short(value)}`);
    await refreshStatus();
    syncModelSelects();
  });

  $<HTMLSelectElement>("#model-rewrite").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await invoke("settings_set", { patch: { model_rewrite: value } });
    addActivity(`rewriter model → ${short(value)}`);
    await refreshStatus();
    syncModelSelects();
  });

  $<HTMLSelectElement>("#model-ocr").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await invoke("settings_set", { patch: { model_ocr: value } });
    addActivity(`ocr model → ${short(value)}`);
    await refreshStatus();
    syncModelSelects();
  });

  $("#models-refresh").addEventListener("click", async () => {
    await loadModels();
    syncModelSelects();
    addActivity(`✓ model catalog: ${models.length} models`);
  });

  // provider switch — repoint the base URL and reload that catalog
  $<HTMLSelectElement>("#provider-select")?.addEventListener("change", async (e) => {
    const p = (e.target as HTMLSelectElement).value;
    const patch: Record<string, string> = {};
    if (p === "custom") {
      patch.base_url = $<HTMLInputElement>("#base-url").value.trim() || settings?.base_url || "";
    } else {
      patch.base_url = PROVIDERS[p] ?? PROVIDERS.nebius;
    }
    await invoke("settings_set", { patch });
    settings = await invoke<Settings>("settings_get");
    applyProviderUI();
    await loadModels();
    syncModelSelects();
  });
  $<HTMLInputElement>("#base-url")?.addEventListener("change", async (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (!v) return;
    await invoke("settings_set", { patch: { base_url: v } });
    settings = await invoke<Settings>("settings_get");
    await loadModels();
    syncModelSelects();
  });
  // key field — an lk- key snaps the provider to Laido cloud
  $<HTMLInputElement>("#key-nebius")?.addEventListener("input", () => {
    const prov = $<HTMLSelectElement>("#provider-select");
    const k = $<HTMLInputElement>("#key-nebius").value.trim();
    if (k.startsWith("lk-") && prov.value !== "laido") {
      prov.value = "laido";
      prov.dispatchEvent(new Event("change"));
    } else if (!k.startsWith("lk-") && prov.value === "laido" && !settings?.laido_email) {
      prov.value = "nebius";
      prov.dispatchEvent(new Event("change"));
    }
    applyProviderUI();
  });
}

export async function testConnection() {
  const el = $("#settings-status");
  const set = (s: string) => {
    el.textContent = s;
    el.title = s;
  };

  set("saving…");
  const gwKey = $<HTMLInputElement>("#key-nebius").value.trim();
  await invoke("settings_set", {
    patch: {
      nebius_api_key: gwKey,
      base_url: managed
        ? LAIDO_GW
        : keyBasePatch(gwKey, settings?.base_url ?? "") ??
          (($("#provider-select") as HTMLSelectElement | null)?.value === "custom"
            ? $<HTMLInputElement>("#base-url").value.trim()
            : PROVIDERS[($("#provider-select") as HTMLSelectElement | null)?.value ?? ""] ??
              settings?.base_url),
      tavily_api_key: $<HTMLInputElement>("#key-tavily").value.trim(),
      ...modelPatch(),
    },
  });
  await refreshStatus();
  syncModelSelects();

  set("testing…");
  const parts: string[] = [];
  const t0 = performance.now();
  try {
    const r = await invoke<PingResult>("llm_ping", {
      message: "Reply with the single word: ready",
    });
    parts.push(`Nebius ✓ ${short(r.model)} · ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    parts.push(`Nebius ✕ ${String(e)}`);
  }
  if ($<HTMLInputElement>("#key-tavily").value.trim()) {
    try {
      const t = await invoke<TavilyPing>("tavily_ping");
      parts.push(`Tavily ✓ ${t.results} results`);
    } catch (e) {
      parts.push(`Tavily ✕ ${String(e)}`);
    }
  } else {
    parts.push("Tavily — not set");
  }
  set(parts.join(" · "));
}

export interface Notice {
  key: string;
  kind: string;
  text: string;
  note: string;
  ts: number;
  body?: string;
}

const NOTICE_KEY = "laido.notices";

export function noticeKey(kind: string, note: string, text: string, ts: number): string {
  kind = typeof kind === "string" ? kind : "";
  note = typeof note === "string" ? note : "";
  text = typeof text === "string" ? text : "";
  ts = Number.isFinite(ts) ? ts : 0;
  if (kind === "remind") return `${kind}|${note}|${text}|${ts}`;
  if (kind === "brief" || kind === "review") {
    return `${kind}|${note}|${new Date(ts * 1000).toISOString().slice(0, 10)}`;
  }
  return `${kind}|${note}|${text}`;
}

export function loadNotices(): Notice[] {
  let list: Notice[] = [];
  try {
    list = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? "[]") as Notice[];
  } catch {
    list = [];
  }
  if (list.length === 0) {
    try {
      const legacy = JSON.parse(localStorage.getItem("laido.reminders") ?? "[]") as Notice[];
      if (legacy.length > 0) {
        list = legacy.map((r) => ({ ...r, kind: "remind" }));
        localStorage.setItem(NOTICE_KEY, JSON.stringify(list));
      }
    } catch {
      list = [];
    }
    localStorage.removeItem("laido.reminders");
  }
  return list.map((n) => ({
    ...n,
    kind: n.kind ?? "remind",
    key: n.key ?? noticeKey(n.kind ?? "remind", n.note, n.text, n.ts),
  }));
}

export function saveNotices(list: Notice[]) {
  localStorage.setItem(NOTICE_KEY, JSON.stringify(list));
}

export function dismissNotice(n: Notice) {
  saveNotices(loadNotices().filter((x) => x.key !== n?.key));
}

function addNotice(n: Notice) {
  const list = loadNotices();
  if (list.some((x) => x.key === n.key)) return;
  saveNotices([...list, n]);
  void ensureNoticeWindow();
}

async function ensureNoticeWindow() {
  const api = window.__TAURI__.webviewWindow;
  if (!api?.WebviewWindow) return;
  try {
    const existing = await api.WebviewWindow.getByLabel("notice");
    if (existing) return;
  } catch {
    /* older runtime: try to create anyway */
  }
  const w = 360;
  const h = 280;
  try {
    new api.WebviewWindow("notice", {
      url: "index.html?notice=1",
      width: w,
      height: h,
      x: Math.max(0, window.screen.availWidth - w - 16),
      y: Math.max(0, window.screen.availHeight - h - 16),
      alwaysOnTop: true,
      decorations: false,
      transparent: true,
      skipTaskbar: true,
      resizable: true,
      title: "Laido notices",
    });
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
  }
}

export function renderNoticeCard(
  n: Notice,
  onOpen: (n: Notice) => void,
  onDismiss?: () => void,
): HTMLElement {
  n = n && typeof n === "object" ? n : ({} as Notice);
  n.kind = S(n.kind);
  n.ts = Number.isFinite(n.ts) ? n.ts : 0;
  const card = document.createElement("div");
  card.className = `reminder notice-${n.kind}`;
  const head = document.createElement("div");
  head.className = "reminder-head";
  const title = document.createElement("span");
  title.className = "reminder-title";
  title.textContent = t(`notice.${n.kind === "remind" ? "reminder" : n.kind}`) || n.kind.toUpperCase();
  const time = document.createElement("span");
  time.className = "reminder-time";
  time.textContent = new Date(n.ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const exit = document.createElement("button");
  exit.className = "reminder-exit";
  exit.textContent = "✕";
  exit.title = t("notice.dismiss");
  const body = document.createElement("div");
  body.className = "reminder-text";
  body.textContent = n.text;
  const foot = document.createElement("button");
  foot.className = "reminder-note";
  foot.textContent =
    n.kind === "remind" ? n.note : `${n.note} — ${t("notice.view")}`;
  head.append(title, time, exit);
  card.append(head, body, foot);
  exit.addEventListener("click", (e) => {
    e.stopPropagation();
    card.remove();
    dismissNotice(n);
    onDismiss?.();
  });
  if (n.kind === "remind") {
    foot.addEventListener("click", () => onOpen(n));
  } else {
    card.addEventListener("click", () => onOpen(n));
  }
  return card;
}

interface SkillProposal {
  note: string;
  name: string;
  description: string;
  steps: string[];
  count: number;
}

interface SkillRow {
  name: string;
  description: string;
  runs: number;
  steps: string[];
  triggers?: string[];
  body?: string;
}

function insertSkillProposal(p: SkillProposal) {
  const card = document.createElement("div");
  card.className = "callout proposal";
  const head = document.createElement("div");
  head.className = "callout-head";
  const title = document.createElement("span");
  title.className = "callout-title";
  title.textContent = `skill proposal: ${p.name}`;
  head.append(title);
  const bodyEl = document.createElement("div");
  bodyEl.className = "callout-body";
  const d = document.createElement("p");
  d.textContent = `You've done this ${p.count} times. Save it as a reusable skill?`;
  const ul = document.createElement("ul");
  for (const s of p.steps) {
    const li = document.createElement("li");
    li.textContent = s;
    ul.append(li);
  }
  bodyEl.append(d, ul);
  const actions = document.createElement("div");
  actions.className = "proposal-actions";
  const accept = document.createElement("button");
  accept.className = "primary mini";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => {
    void invoke("skill_save", { name: p.name, description: p.description, triggers: "", body: "", steps: p.steps }).then(
      () => {
        card.remove();
        addActivity(`✓ skill saved: ${p.name} — run it with @skill ${p.name}`);
        void refreshSkills();
      },
    );
  });
  const discard = document.createElement("button");
  discard.className = "ghost mini";
  discard.textContent = "Discard";
  discard.addEventListener("click", () => {
    card.remove();
    addActivity(`skill proposal discarded: ${p.name}`);
  });
  actions.append(accept, discard);
  card.append(head, bodyEl, actions);
  appendToNote(card);
}

let skillFilter = "";

export async function refreshSkills() {
  try {
    const list = await invoke<SkillRow[]>("skills_list");
    const el = $("#skills");
    el.innerHTML = "";
    const q = skillFilter.toLowerCase();
    const shown = list.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
    if (shown.length === 0) {
      el.className = "muted";
      el.textContent = list.length === 0 ? "—" : "—";
      return;
    }
    el.className = "";
    for (const s of shown) {
      const row = document.createElement("div");
      row.className = "act-line skill-row";
      const label = document.createElement("span");
      label.className = "skill-row-label";
      const knows = (s.body ?? "").trim() !== "";
      label.textContent = `${knows ? "📚 " : ""}${s.name} · ${s.runs}×`;
      label.title = knows
        ? `${s.description} — knowledge the AI recalls in chat${s.triggers?.length ? ` (when: ${s.triggers.join(", ")})` : ""} — click to run`
        : `${s.description} — click to run in the current note`;
      label.addEventListener("click", () => {
        const note = currentNote();
        if (!note) {
          addActivity("✕ open a note first — skills write their results into the current note");
          return;
        }
        void invoke("skill_run", { note, name: s.name, quiet: true }).then(() => void refreshSkills());
      });
      const edit = document.createElement("button");
      edit.className = "skill-edit";
      edit.textContent = "✎";
      edit.title = t("skill.edit");
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        void openSkillEditor(s.name);
      });
      row.append(label, edit);
      el.append(row);
    }
  } catch {
    /* ignore */
  }
}

async function openSkillEditor(name?: string) {
  const modal = $("#skill-modal");
  const nameEl = $<HTMLInputElement>("#skill-name");
  const descEl = $<HTMLInputElement>("#skill-desc");
  const trigEl = $<HTMLInputElement>("#skill-triggers");
  const knowEl = $<HTMLTextAreaElement>("#skill-know");
  const stepsEl = $<HTMLTextAreaElement>("#skill-steps");
  $("#skill-modal-title").textContent = name ? t("skill.edit") : t("skill.new");
  nameEl.value = name ?? "";
  nameEl.disabled = !!name;
  descEl.value = "";
  trigEl.value = "";
  knowEl.value = "";
  stepsEl.value = "";
  $("#skill-status").textContent = "";
  if (name) {
    try {
      const md = await invoke<string>("skill_read", { name });
      const fm = md.split("---")[1] ?? "";
      descEl.value = (fm.match(/description:\s*(.*)/)?.[1] ?? "").trim();
      trigEl.value = (fm.match(/triggers:\s*(.*)/)?.[1] ?? "").trim();
      // body = everything after the frontmatter, minus the trailing
      // "## Steps" block (those bullets load into the steps field);
      // legacy skills have no Steps heading — their bullets are steps
      const rest = md.split("---").slice(2).join("---");
      const [bodyPart, stepsPart] = rest.split(/^##\s*Steps\s*$/m);
      if (stepsPart !== undefined) {
        knowEl.value = bodyPart.trim();
        stepsEl.value = stepsPart
          .split("\n")
          .filter((l) => l.trim().startsWith("- "))
          .map((l) => l.trim().slice(2))
          .join("\n");
      } else {
        const KNOWN = /^(loop:|@research|! |prompt:|\?|remind:|summary|brief|review)/;
        const bullets = rest
          .split("\n")
          .filter((l) => KNOWN.test(l.trim().replace(/^[-*]\s+/, "")));
        if (bullets.length) {
          stepsEl.value = bullets
            .map((l) => l.trim().replace(/^[-*]\s+/, ""))
            .join("\n");
          knowEl.value = rest
            .split("\n")
            .filter((l) => !bullets.includes(l))
            .join("\n")
            .trim();
        } else {
          knowEl.value = rest.trim();
        }
      }
    } catch {
      /* ignore */
    }
  }
  modal.classList.remove("hidden");
  (name ? stepsEl : nameEl).focus();
}

export function initSkillTools() {
  const search = $<HTMLInputElement>("#skill-search");
  search.placeholder = t("skill.search");
  search.addEventListener("input", () => {
    skillFilter = search.value;
    void refreshSkills();
  });
  $("#skill-new").addEventListener("click", () => void openSkillEditor());
  $("#skill-sample").addEventListener("click", () => {
    // a knowledge skill — teaches the AI a recipe it recalls in chat
    $<HTMLInputElement>("#skill-name").value = "concrete-estimate";
    $<HTMLInputElement>("#skill-desc").value =
      "Estimate cement, sand and gravel for concrete work";
    $<HTMLInputElement>("#skill-triggers").value =
      "concrete, slab, footing, cement, sand, gravel, estimate, materials";
    $<HTMLTextAreaElement>("#skill-know").value =
      "## When to use\nThe user asks for material quantities for concrete work — slabs, footings, posts, walls.\n\n" +
      "## Knowledge\n- concrete volume V = L × W × thickness (m³)\n" +
      "- dry volume = V × 1.54 (accounts for voids & waste)\n" +
      "- mix 1:2:4 (cement:sand:gravel) → cement = dry/7, sand = 2·dry/7, gravel = 4·dry/7\n" +
      "- cement bags = cement m³ × 1440 kg/m³ ÷ 50 kg per bag\n" +
      "- always show the working: put formulas in the sheet cells, not just numbers\n\n" +
      "## Examples\n" +
      "Q: \"concrete for a 4×5 slab 0.1 thick\" → build a sheet titled concrete-estimate: " +
      "L=4, W=5, t=0.1, V=L*W*t=2 m³, dry=V*1.54=3.08, cement=dry/7=0.44 m³, " +
      "bags=0.44*1440/50≈12.7, sand=2·dry/7=0.88 m³, gravel=4·dry/7=1.76 m³ — " +
      "use ```sheet fences so every cell is a live formula";
    $<HTMLTextAreaElement>("#skill-steps").value = "";
  });
  $("#skill-cancel").addEventListener("click", () => $("#skill-modal").classList.add("hidden"));
  $("#skill-save").addEventListener("click", () => {
    const name = $<HTMLInputElement>("#skill-name")
      .value.trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    const description = $<HTMLInputElement>("#skill-desc").value.trim();
    const triggers = $<HTMLInputElement>("#skill-triggers").value.trim();
    const body = $<HTMLTextAreaElement>("#skill-know").value;
    const steps = $<HTMLTextAreaElement>("#skill-steps")
      .value.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!name || (!steps.length && !body.trim())) {
      $("#skill-status").textContent = "name plus knowledge or at least one step required";
      return;
    }
    void invoke("skill_save", { name, description, triggers, body, steps }).then(() => {
      $("#skill-modal").classList.add("hidden");
      addActivity(`✓ skill saved: ${name}`);
      void refreshSkills();
    });
  });
}

export async function refreshSchedules() {
  try {
    const list = await invoke<SchedRow[]>("schedule_list");
    const el = $("#schedules");
    el.innerHTML = "";
    if (list.length === 0) {
      el.className = "muted";
      el.textContent = "none — open the calendar (▦) or write @schedule";
      return;
    }
    el.className = "";
    for (const s of list) {
      const d = document.createElement("div");
      d.className = "act-line" + (s.paused ? " paused" : "");
      const mins = Math.round(s.next - Date.now() / 1000) / 60;
      const when = s.paused
        ? "paused"
        : mins < 60
          ? `in ${Math.max(0, Math.round(mins))}m`
          : mins < 1440
            ? `in ${Math.round(mins / 60)}h`
            : `in ${Math.round(mins / 1440)}d`;
      d.textContent = `${s.line.replace("@schedule ", "")} · ${when}`;
      d.title = `${s.note} — click for the calendar`;
      d.addEventListener("click", () => openCalendar());
      el.append(d);
    }
  } catch {
    /* ignore */
  }
}

export async function initAgent() {
  const listen = window.__TAURI__.event.listen;
  await listen<ActivityPayload>("agent:activity", (e) => {
    addActivity(e.payload.text);
    // only foreground-job failures dismiss the loader — background noise
    // (graph builds, uploads, scheduled tasks) must not kill an in-flight ask
    if (
      /^✕ (research failed|synthesis failed|skill [^\n]*failed|morning brief|daily brief|weekly review|summary failed|loop \d+ failed)/.test(
        e.payload.text,
      )
    )
      hidePencil();
    void refreshSchedules();
    void refreshSkills();
  });
  await listen<ResearchDone>("research:done", async (e) => {
    const p = e.payload;
    hidePencil();
    if (currentNote() === p.note) {
      const card = insertCallout(
        p.topic,
        p.callout,
        p.anchor ?? undefined,
        p.parent ?? undefined,
        p.question ?? undefined,
      );
      // every successful research-loop card stays pinned, and the whole run
      // auto-lays-out into a clean two-column grid as loops arrive
      if (card && (p.kind === "loop" || p.kind === "loop-final")) {
        card.dataset.loopRun = S(p.run) || "loop";
        card.dataset.loopIndex = String(typeof p.loop === "number" && Number.isFinite(p.loop) ? Math.trunc(p.loop) : 0);
        pinCard(card);
        layoutLoopRun(S(p.run) || "loop");
      }
    } else {
      await invoke("vault_insert", {
        name: p.note,
        topic: p.topic,
        callout: p.callout,
        anchor: p.anchor ?? null,
      });
    }
    if (!p.quiet) {
      const ts = Math.floor(Date.now() / 1000);
      addNotice({
        kind: p.kind ?? "research",
        text: p.topic,
        note: p.note,
        ts,
        body: p.callout,
        key: noticeKey(p.kind ?? "research", p.note, p.topic, ts),
      });
    }
  });
  await listen<{ name: string; quiet?: boolean }>("brief:done", async (e) => {
    const name = e.payload.name;
    if (currentNote() === name) {
      await loadNote(name);
    }
    if (e.payload.quiet) return;
    const kind = name.startsWith("review") ? "review" : "brief";
    const text = kind === "review" ? "weekly review is ready" : "morning brief is ready";
    const ts = Math.floor(Date.now() / 1000);
    addNotice({ kind, text, note: name, ts, key: noticeKey(kind, name, text, ts) });
  });
  await listen<Reminder>("remind:fired", (e) => {
    const r = e.payload;
    addNotice({ ...r, kind: "remind", key: noticeKey("remind", r.note, r.text, r.ts) });
  });
  await listen<SkillProposal>("skill:proposed", (e) => {
    const p = e.payload;
    if (currentNote() === p.note) {
      insertSkillProposal(p);
    } else {
      addActivity(`💡 skill idea in ${p.note}: @skill ${p.name} — open that note to review`);
    }
  });
  await listen<{ name: string }>("open-note", async (e) => {
    const name = e.payload?.name;
    if (typeof name === "string" && name) await openTab(name);
  });
  if (loadNotices().length > 0) {
    void ensureNoticeWindow();
  }
  initSkillTools();
  await refreshSchedules();
  await refreshSkills();
  window.setInterval(() => {
    void refreshSchedules();
    if (loadNotices().length === 0) {
      void window.__TAURI__.webviewWindow?.WebviewWindow.getByLabel("notice").then((w) => {
        if (w) void w.close();
      });
    }
  }, 60000);
}
