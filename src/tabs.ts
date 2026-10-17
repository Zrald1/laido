import { $, invoke } from "./ipc.js";
import {
  loadNote,
  save,
  clearNote,
  saveNow,
  startSaveAs,
  printNote,
  setFileCallbacks,
} from "./editor.js";
import { addActivity } from "./log.js";

const KEY = "laido.tabs";

/** the built-in guide — created once in the vault and opened on every launch
 *  so new users can always read how Laido works */
const GUIDE = "Instructions.laido";
const GUIDE_MD = `# Welcome to Laido

Your notes are the interface. Write anything; Laido reads it, answers from it, researches the web, and leaves every result on the page as a card — never hidden in a chat log.

## Commands — no symbols to remember

Type a command word, press **Space** and pick from the dropdown — or just start typing: r offers research, recall, related. Tab or the arrow keys move the highlight, Space, Enter or a click chooses — then type your message and press Enter.

- **ask** — your notes + your library + the web, fused into one cited answer
- **document** — ask one library file (or all of them)
- **research** — deep research on a topic
- **loop** — iterative research with a simulation each round
- **summary** — summarize this note
- **recall** — quiz yourself from your notes
- **tasks** — pull action items out of your notes or files
- **related** — the notes closest to this one
- **skill** — run a saved skill
- **schedule** — recurring work while you sleep, like: schedule daily 08:00 brief
- **terminal** — an AI terminal on this note: ask in plain words, run ! commands, save skills

## Your library

Click any file in the **Library** panel to ask it a question — the cited answer lands here as a card. Drop PDFs, slides, images, and text files there to make them searchable.

## Good to know

- Commands run only when you press **Enter** on their line — pasting text is always safe.
- Press **Escape** to cancel a command — the line goes back to plain text.
- Every card is editable; drag, resize, or pin it wherever it helps.
- Your notes live as plain files in your Documents folder — they are yours.
- Add your keys (Nebius, Tavily, AssemblyAI) in **Settings**.

You can edit this note or close its tab — it comes back the next time you open Laido.
`;

let tabs: string[] = [];
let active = "";

function persist() {
  // never serialize a bad entry — one malformed name would poison every
  // future render() for the session (name.replace on undefined)
  localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.filter((n) => typeof n === "string" && n), active }));
}

/* note → media state in its parked browser engines — browser.ts's audio
 * tick broadcasts nav:audio; the tab shows ⏸ (click pauses) or ▶ (click
 * resumes), and nav:audiotoggle asks browser.ts to flip playback. The
 * TITLE still navigates — only the icon is the transport control */
let noteAudio = new Map<string, { titles: string[]; muted: boolean; playing: boolean }>();

function paintSnd() {
  document.querySelectorAll<HTMLElement>("#tabs .tab").forEach((t) => {
    const name = t.dataset.note ?? "";
    const info = name ? noteAudio.get(name) : undefined;
    let ic = t.querySelector<HTMLElement>(".tab-snd");
    if (!info) {
      ic?.remove();
      return;
    }
    if (!ic) {
      ic = document.createElement("span");
      ic.className = "tab-snd";
      ic.addEventListener("click", (e) => {
        e.stopPropagation(); // transport only — never navigates
        document.dispatchEvent(new CustomEvent("nav:audiotoggle", { detail: name }));
      });
      t.insertBefore(ic, t.querySelector(".tab-close"));
    }
    ic.textContent = info.playing ? "⏸" : "▶";
    ic.title = info.playing
      ? `playing: ${info.titles.join(" · ")} — click to pause`
      : `paused: ${info.titles.join(" · ")} — click to resume`;
  });
}

function render() {
  const el = $("#tabs");
  el.innerHTML = "";
  for (const name of tabs) {
    if (typeof name !== "string" || !name) continue;
    const t = document.createElement("button");
    t.className = "tab" + (name === active ? " active" : "");
    t.dataset.note = name;
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = name.replace(/\.(laido|md)$/, "");
    const x = document.createElement("span");
    x.className = "tab-close";
    x.textContent = "×";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      void close(name);
    });
    t.append(label, x);
    t.addEventListener("click", () => void select(name));
    t.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTabMenu(name, e.clientX, e.clientY);
    });
    let dragFrom: { x: number; y: number } | null = null;
    t.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close, .tab-snd")) return;
      dragFrom = { x: e.clientX, y: e.clientY };
      t.setPointerCapture(e.pointerId);
    });
    t.addEventListener("pointerup", (e) => {
      const d = dragFrom;
      dragFrom = null;
      if (!d) return;
      const moved = Math.abs(e.clientX - d.x) > 20 || Math.abs(e.clientY - d.y) > 20;
      const out =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      if (moved && out) void popOutTab(name, e);
    });
    el.append(t);
  }
  paintSnd();
}

async function select(name: string) {
  if (typeof name !== "string" || !name || name === active) return;
  await save();
  active = name;
  pushRecent(name);
  persist();
  render();
  try {
    await loadNote(name);
  } catch {
    await close(name, true);
  }
}

async function close(name: string, soft = false) {
  if (typeof name !== "string" || !name) return;
  await save();
  const i = tabs.indexOf(name);
  if (i >= 0) tabs.splice(i, 1);
  if (active === name) {
    active = tabs[Math.min(i, Math.max(tabs.length - 1, 0))] ?? "";
    if (active) {
      try {
        await loadNote(active);
      } catch {
        active = "";
      }
    } else {
      clearNote();
    }
  }
  persist();
  render();
  /* a popped-out note window exists for its tab — a USER closing the
   * last one closes the window instead of leaving a chrome-only shell.
   * soft closes (load failures) never pull the window down — a fresh
   * window's IPC can still be spinning up, and a dead window hides it */
  if (tabs.length === 0 && !soft) {
    try {
      const w = window.__TAURI__.window.getCurrentWindow();
      if (w.label.startsWith("note-")) void w.close();
    } catch {
      /* not a popout */
    }
  }
}

/** bulk close — one save, one render. If the active tab is among the
 *  doomed, the clicked-on anchor tab becomes active (it survives every
 *  bulk op), else the nearest survivor. */
async function closeMany(doomed: string[], anchor: string) {
  const gone = new Set(doomed.filter((n) => typeof n === "string" && n));
  if (!gone.size) return;
  await save();
  const ai = tabs.indexOf(anchor);
  tabs = tabs.filter((n) => !gone.has(n));
  if (!tabs.includes(active)) {
    active = tabs.includes(anchor)
      ? anchor
      : tabs[Math.min(ai, Math.max(tabs.length - 1, 0))] ?? "";
    if (active) {
      try {
        await loadNote(active);
      } catch {
        active = "";
      }
    } else {
      clearNote();
    }
  }
  persist();
  render();
}

/* ---- tab context menu: close / others / right / left (Chrome-style) ---- */

let tabMenu: HTMLDivElement | null = null;

function closeTabMenu() {
  if (!tabMenu) return;
  tabMenu.remove();
  tabMenu = null;
  document.removeEventListener("pointerdown", onTabMenuOutside, true);
  document.removeEventListener("keydown", onTabMenuKey, true);
  $("#tabs")?.removeEventListener("contextmenu", onTabMenuReopen, true);
}

function openTabMenu(name: string, x: number, y: number) {
  closeTabMenu();
  const i = tabs.indexOf(name);
  if (i < 0) return;
  const menu = document.createElement("div");
  menu.className = "menu tab-ctx";
  const items: { label: string; run: () => void; enabled: boolean }[] = [
    { label: "Close", run: () => void close(name), enabled: true },
    { label: "Close other tabs", run: () => void closeMany(tabs.filter((n) => n !== name), name), enabled: tabs.length > 1 },
    { label: "Close tabs to the right", run: () => void closeMany(tabs.slice(i + 1), name), enabled: i < tabs.length - 1 },
    { label: "Close tabs to the left", run: () => void closeMany(tabs.slice(0, i), name), enabled: i > 0 },
  ];
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (!it.enabled) b.classList.add("off");
    else
      b.addEventListener("click", () => {
        closeTabMenu();
        it.run();
      });
    menu.append(b);
  }
  document.body.append(menu);
  tabMenu = menu;
  // keep the menu on screen — clamp inside the window
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onTabMenuOutside, true);
    document.addEventListener("keydown", onTabMenuKey, true);
    window.addEventListener("blur", closeTabMenu, { once: true });
    $("#tabs").addEventListener("contextmenu", onTabMenuReopen, true);
  }, 0);
}

function onTabMenuOutside(e: Event) {
  if (tabMenu && !(e.target as HTMLElement).closest(".tab-ctx")) closeTabMenu();
}
function onTabMenuKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeTabMenu();
  }
}
function onTabMenuReopen() {
  closeTabMenu();
}

export async function openTab(name: string) {
  if (typeof name !== "string" || !name) return;
  if (!tabs.includes(name)) tabs.push(name);
  if (name !== active) await select(name);
  else {
    persist();
    render();
  }
}

/** names saved before the .laido migration still say .md — repair them
 *  against the vault so restored tabs, recent lists and menus always work */
function repairNames(names: string[], all: string[]): string[] {
  const set = new Set(all);
  const out: string[] = [];
  for (const n of names) {
    let fixed = n;
    if (!set.has(fixed) && /\.md$/.test(n)) {
      const alt = n.replace(/\.md$/, ".laido");
      if (set.has(alt)) fixed = alt;
    }
    if (set.has(fixed) && !out.includes(fixed)) out.push(fixed);
  }
  return out;
}

// decoupled navigation — any module can ask for a note to open without
// importing the editor graph (agenda cards, link lists, …)
document.addEventListener("nav:open", (e) => {
  const name = (e as CustomEvent<string>).detail;
  if (typeof name === "string" && name) void openTab(name);
});

document.addEventListener("nav:audio", (e) => {
  noteAudio = new Map(
    (e as CustomEvent<[string, { titles: string[]; muted: boolean; playing: boolean }][]>).detail,
  );
  paintSnd();
});

export async function initTabs() {
  const qp =
    new URLSearchParams(location.search).get("note") ??
    (window as unknown as { __POP_NOTE__?: string }).__POP_NOTE__ ??
    null;
  if (qp) {
    tabs = [qp];
    active = qp;
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
        tabs?: string[];
        active?: string;
      } | null;
      if (saved?.tabs?.length) {
        tabs = saved.tabs;
        active = saved.active && saved.tabs.includes(saved.active) ? saved.active : "";
      }
    } catch {
      tabs = [];
    }
  }
  const notes = await invoke<Array<{ name: string }>>("vault_list").catch(() => []);
  const allNames = notes.map((n) => n.name);
  // the instructions note is always there — created if missing, never
  // overwritten, so user edits to it persist
  if (!allNames.includes(GUIDE)) {
    try {
      await invoke("vault_write", { name: GUIDE, content: GUIDE_MD });
      allNames.push(GUIDE);
    } catch {
      /* vault not ready — try again next launch */
    }
  }
  tabs = repairNames(tabs, allNames);
  active = repairNames(active ? [active] : [], allNames)[0] ?? "";
  /* a popped window's target is authoritative — vault_list can race the
   * fresh window's IPC bridge and return empty, and repairNames would
   * eat the only tab, leaving a dead chrome-only window */
  if (qp) {
    tabs = [qp];
    active = qp;
  }
  if (!qp) {
    // every launch opens on the instructions — close the tab and it returns
    if (!tabs.includes(GUIDE)) tabs.unshift(GUIDE);
    active = GUIDE;
  }
  if (tabs.length === 0 && allNames.length > 0) tabs = [allNames[0]];
  if (active === "" && tabs.length > 0) active = tabs[0];
  persist();
  render();
  if (active) {
    try {
      await loadNote(active);
      pushRecent(active);
    } catch {
      /* a popped window's only tab was explicitly requested — the note
       * exists, a failure here is the fresh IPC bridge still warming.
       * One delayed retry before surrendering the tab */
      if (qp && active === qp) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          await loadNote(active);
          pushRecent(active);
        } catch {
          await close(active, true);
        }
      } else {
        await close(active, true);
      }
    }
  } else {
    clearNote();
  }

  $("#new-tab").addEventListener("click", async () => {
    await save();
    const name = await invoke<string>("vault_create");
    await openTab(name);
  });

  setFileCallbacks(
    (oldName, next) => {
      const i = tabs.indexOf(oldName);
      if (i >= 0) tabs[i] = next;
      if (active === oldName) active = next;
      const snd = noteAudio.get(oldName);
      if (snd) { noteAudio.delete(oldName); noteAudio.set(next, snd); }
      persist();
      render();
    },
    (next) => void openTab(next),
  );

  const menu = $("#file-menu");
  $("#btn-file").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#recent-menu").classList.add("hidden");
    menu.classList.toggle("hidden");
  });
  menu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest("[data-cmd]") as HTMLElement | null;
    if (!item) return;
    menu.classList.add("hidden");
    const cmd = item.dataset.cmd;
    if (cmd === "save") saveNow();
    else if (cmd === "save-as") startSaveAs();
    else if (cmd === "save-all") {
      saveNow();
      addActivity("all notes saved");
    } else if (cmd === "recent") void openRecentMenu();
    else if (cmd === "open") void openExternal();
    else if (cmd === "print") printNote();
  });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (
      !menu.classList.contains("hidden") &&
      !t.closest("#file-menu, #btn-file")
    ) {
      menu.classList.add("hidden");
    }
    const rm = $("#recent-menu");
    if (!rm.classList.contains("hidden") && !t.closest("#recent-menu, #btn-file")) {
      rm.classList.add("hidden");
    }
  });

  $("#open-filter").addEventListener("input", renderPicker);
  $("#open-close").addEventListener("click", () => $("#open-modal").classList.add("hidden"));
}

async function popOutTab(name: string, e: PointerEvent) {
  /* the window is built Rust-side (pop_window): the shared WebView2 env
   * requires identical options or creation is refused — the JS builder
   * can't set them. build() returning only means an HWND exists — the
   * tab leaves main only when the child emits pop:ready from its own
   * booted init, so a silent webview failure can never eat the tab */
  const label = `note-${Date.now().toString(36)}`;
  /* the listener must exist BEFORE the window spawns — the child emits
   * pop:ready at the top of its init, which can land before invoke()
   * returns; registering after the spawn races the emit and misses it */
  const ready = new Promise<boolean>((resolve) => {
    let un: (() => void) | undefined;
    const done = (ok: boolean) => {
      un?.();
      resolve(ok);
    };
    void window.__TAURI__.event
      .listen<string>("pop:ready", (ev) => {
        if (ev.payload === label) done(true);
      })
      .then((u) => (un = u));
    /* pop_window can silently retry a dead attach up to 3 times, and
     * each attempt may wait out a destroy tail — ~40s worst case plus
     * the child's own boot */
    setTimeout(() => done(false), 45000);
  });
  try {
    await invoke("pop_window", {
      label,
      url: "index.html",
      /* __POP_TOKEN__: the child emits this back on pop:ready — the
       * window's own label can differ if pop_window retried a dead
       * attach under a fresh label */
      init: `window.__POP_NOTE__=${JSON.stringify(name)};window.__POP_TOKEN__=${JSON.stringify(label)}`,
      x: Math.round(window.screenX + Math.max(0, e.clientX - 150)),
      y: Math.round(window.screenY + Math.max(0, e.clientY - 20)),
      w: 900,
      h: 640,
    });
  } catch (err) {
    addActivity(`✕ couldn't open a new window: ${String(err)}`);
    return;
  }
  if (!(await ready)) {
    addActivity(`✕ the new window didn't finish loading — tab kept`);
    // the dead shell is clutter — close it if the handle resolves
    try {
      const w = await window.__TAURI__.webviewWindow?.WebviewWindow.getByLabel(label);
      void w?.close();
    } catch {
      /* already gone */
    }
    return;
  }
  await close(name);
}

const RECENT_KEY = "laido.recent";

function pushRecent(name: string) {
  if (typeof name !== "string" || !name) return;
  try {
    const list = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).filter(
      (n) => n !== name,
    );
    list.unshift(name);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.filter((n) => typeof n === "string" && n).slice(0, 12)));
  } catch {
    /* ignore */
  }
}

async function openRecentMenu() {
  $("#file-menu").classList.add("hidden");
  const menu = $("#recent-menu");
  menu.innerHTML = "";
  let list: string[] = [];
  try {
    list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    list = [];
  }
  let all: string[] = [];
  try {
    all = (await invoke<Array<{ name: string }>>("vault_list")).map((n) => n.name);
  } catch {
    all = [];
  }
  // recent entries saved before the .laido migration say .md — repair them
  // against the vault and drop anything that no longer exists
  list = repairNames(list, all);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  const add = (label: string, name: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.classList.add("hidden");
      void openTab(name);
    });
    menu.append(b);
  };
  if (list.length > 0) {
    const h = document.createElement("div");
    h.className = "menu-label";
    h.textContent = "Recent";
    menu.append(h);
    for (const n of list) add(n.replace(/\.(laido|md)$/, ""), n);
  }
  const others = all.filter((n) => !list.includes(n));
  if (others.length > 0) {
    const h = document.createElement("div");
    h.className = "menu-label";
    h.textContent = "All notes";
    menu.append(h);
    for (const n of others) add(n.replace(/\.(laido|md)$/, ""), n);
  }
  if (list.length === 0 && all.length === 0) {
    const e = document.createElement("div");
    e.className = "menu-sub";
    e.textContent = "no notes yet";
    menu.append(e);
  }
  const browse = document.createElement("button");
  browse.textContent = "Browse with locations…";
  browse.addEventListener("click", () => {
    menu.classList.add("hidden");
    void openPicker();
  });
  menu.append(browse);
  menu.classList.remove("hidden");
}

async function openExternal() {
  const api = window.__TAURI__.dialog;
  if (!api) {
    addActivity("✕ file dialog unavailable in this build");
    return;
  }
  try {
    const picked = await api.open({
      multiple: false,
      filters: [
        { name: "Laido notes", extensions: ["laido"] },
        { name: "Markdown & text", extensions: ["md", "markdown", "txt"] },
      ],
    });
    if (!picked || typeof picked !== "string") return;
    // a note that already lives in the vault opens directly — importing it
    // would duplicate it as name-2.laido
    const dir = await invoke<string>("vault_dir").catch(() => "");
    const file = picked.replace(/\\/g, "/").split("/").pop() ?? "";
    if (dir && picked.replace(/\\/g, "/").startsWith(dir.replace(/\\/g, "/")) && file) {
      await openTab(file);
      return;
    }
    const name = await invoke<string>("import_note", { path: picked });
    addActivity(`⤓ opened ${name} from disk`);
    await openTab(name);
  } catch (e) {
    addActivity(`✕ ${String(e)}`);
  }
}

let pickerNotes: string[] = [];
let notesDir = "";

async function openPicker() {
  pickerNotes = (await invoke<Array<{ name: string }>>("vault_list")).map((n) => n.name);
  try {
    notesDir = await invoke<string>("vault_dir");
  } catch {
    notesDir = "";
  }
  $("#open-location").textContent = notesDir ? `location: ${notesDir}` : "";
  $<HTMLInputElement>("#open-filter").value = "";
  renderPicker();
  $("#open-modal").classList.remove("hidden");
  $<HTMLInputElement>("#open-filter").focus();
}

function renderPicker() {
  const q = $<HTMLInputElement>("#open-filter").value.toLowerCase();
  const list = $("#open-list");
  list.innerHTML = "";
  for (const n of pickerNotes.filter((x) => x.toLowerCase().includes(q))) {
    const row = document.createElement("div");
    row.className = "open-row";
    const main = document.createElement("button");
    main.className = "open-item";
    main.textContent = n.replace(/\.(laido|md)$/, "");
    main.addEventListener("click", () => {
      $("#open-modal").classList.add("hidden");
      void openTab(n);
    });
    const path = document.createElement("span");
    path.className = "open-path";
    path.textContent = notesDir ? `${notesDir}\\${n}` : n;
    path.title = path.textContent;
    const loc = document.createElement("button");
    loc.className = "ghost mini";
    loc.textContent = "Location";
    loc.title = "Show this file in your file manager";
    loc.addEventListener("click", () => {
      void invoke("reveal_note", { name: n }).catch(() => undefined);
    });
    row.append(main, path, loc);
    list.append(row);
  }
}
