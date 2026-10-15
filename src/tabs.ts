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
  localStorage.setItem(KEY, JSON.stringify({ tabs, active }));
}

function render() {
  const el = $("#tabs");
  el.innerHTML = "";
  for (const name of tabs) {
    const t = document.createElement("button");
    t.className = "tab" + (name === active ? " active" : "");
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
    let dragFrom: { x: number; y: number } | null = null;
    t.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
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
}

async function select(name: string) {
  if (name === active) return;
  await save();
  active = name;
  pushRecent(name);
  persist();
  render();
  try {
    await loadNote(name);
  } catch {
    await close(name);
  }
}

async function close(name: string) {
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
}

export async function openTab(name: string) {
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
  if (name) void openTab(name);
});

export async function initTabs() {
  const qp = new URLSearchParams(location.search).get("note");
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
      await close(active);
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
  const api = window.__TAURI__.webviewWindow;
  if (!api?.WebviewWindow) {
    addActivity("✕ cannot open a new window in this build");
    return;
  }
  try {
    new api.WebviewWindow(`note-${Date.now().toString(36)}`, {
      url: `index.html?note=${encodeURIComponent(name)}`,
      width: 900,
      height: 640,
      x: Math.round(window.screenX + Math.max(0, e.clientX - 150)),
      y: Math.round(window.screenY + Math.max(0, e.clientY - 20)),
      decorations: false,
      title: "Laido",
    });
  } catch (err) {
    addActivity(`✕ ${String(err)}`);
    return;
  }
  await close(name);
}

const RECENT_KEY = "laido.recent";

function pushRecent(name: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).filter(
      (n) => n !== name,
    );
    list.unshift(name);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
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
