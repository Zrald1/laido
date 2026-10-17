import { $, invoke } from "./ipc.js";
import { initEditor } from "./editor.js";
import { initTabs } from "./tabs.js";
import { initCalendar } from "./calendar.js";
import { initLibrary, toggleLibrary } from "./rag.js";
import { refreshStatus, testConnection, initAgent, initModels, syncModelSelects } from "./agent.js";
import { initI18n, LANGS, setLang } from "./i18n.js";
import { addActivity } from "./log.js";

// native app feel — the WebView's default browser context menu is never wanted
document.addEventListener("contextmenu", (e) => e.preventDefault());

const modal = () => $("#settings-modal");

function initRail() {
  const btn = $("#btn-rail");
  const apply = (visible: boolean) => {
    document.body.classList.toggle("no-rail", !visible);
    btn.classList.toggle("on", visible);
    btn.title = `${visible ? "Hide" : "Show"} agent panel (Ctrl+J)`;
  };
  apply(localStorage.getItem("laido.rail") !== "0");
  btn.addEventListener("click", () => {
    const visible = localStorage.getItem("laido.rail") === "0";
    localStorage.setItem("laido.rail", visible ? "1" : "0");
    apply(visible);
  });
  // a slim handle on the window's right edge so a hidden rail stays discoverable
  const edge = document.createElement("button");
  edge.className = "rail-tab";
  edge.tabIndex = -1;
  edge.textContent = "agent";
  edge.title = "Show agent panel (Ctrl+J)";
  edge.addEventListener("click", () => btn.click());
  document.body.append(edge);
}

async function saveSettings() {
  await invoke("settings_set", {
    patch: {
      nebius_api_key: $<HTMLInputElement>("#key-nebius").value.trim(),
      tavily_api_key: $<HTMLInputElement>("#key-tavily").value.trim(),
      assemblyai_api_key: $<HTMLInputElement>("#key-assemblyai").value.trim(),
      model_fast: $<HTMLSelectElement>("#model-fast").value,
      model_main: $<HTMLSelectElement>("#model-main").value,
      model_deep: $<HTMLSelectElement>("#model-deep").value,
      model_rewrite: $<HTMLSelectElement>("#model-rewrite-set").value,
    },
  });
  $("#settings-status").textContent = "saved";
  await refreshStatus();
  syncModelSelects();
}

async function init() {
  /* popouts must prove their webview attached before the source tab/card
   * closes — build() succeeding only means an HWND exists; a silent
   * attach failure sits at about:blank forever and would still have
   * eaten the tab. init() running at all is the proof — emit immediately */
  const ownLabel = window.__TAURI__.window.getCurrentWindow().label;
  if (ownLabel.startsWith("note-") || ownLabel.startsWith("sticky-")) {
    void window.__TAURI__.event.emit("pop:ready", ownLabel);
  }
  const sticky =
    new URLSearchParams(location.search).get("sticky") ??
    (window as unknown as { __POP_STICKY__?: string }).__POP_STICKY__ ??
    null;
  if (sticky) {
    const { initStickyWindow } = await import("./stickywin.js");
    await initStickyWindow(sticky);
    return;
  }
  const notice = new URLSearchParams(location.search).get("notice");
  if (notice) {
    const { initNoticeWindow } = await import("./noticewin.js");
    initNoticeWindow();
    return;
  }
  const reader = new URLSearchParams(location.search).get("reader");
  if (reader) {
    const { initReaderWindow } = await import("./readerwin.js");
    await initReaderWindow(reader);
    return;
  }
  const win = window.__TAURI__.window.getCurrentWindow();
  $("#win-min").addEventListener("click", () => void win.minimize());
  $("#win-max").addEventListener("click", () => void win.toggleMaximize());
  $("#win-close").addEventListener("click", () => void win.close());

  const prefs = await invoke<{ language: string }>("settings_get");
  const detected = await invoke<string>("detect_locale").catch(() => "en");
  const lang = initI18n(prefs.language ?? "", detected);
  if (!prefs.language) {
    void invoke("settings_set", { patch: { language: lang } });
  }
  const langSel = $<HTMLSelectElement>("#lang-select");
  for (const [code, label] of LANGS) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = label;
    langSel.append(o);
  }
  langSel.value = lang;
  langSel.addEventListener("change", () => {
    setLang(langSel.value);
    void invoke("settings_set", { patch: { language: langSel.value } });
    addActivity(`language → ${langSel.value}`);
  });

  initRail();
  initEditor();
  initCalendar();
  initLibrary();
  await initTabs();
  // a .laido file opened from the shell (double-click / open-with) wins over
  // the restored tab
  const pending = await invoke<string | null>("pending_open").catch(() => null);
  if (pending) {
    const { loadNote } = await import("./editor.js");
    await loadNote(pending).catch(() => {});
  }
  await refreshStatus();
  await initModels();
  await initAgent();

  $("#btn-settings").addEventListener("click", async () => {
    await refreshStatus();
    syncModelSelects();
    modal().classList.remove("hidden");
  });
  $("#settings-close").addEventListener("click", () => modal().classList.add("hidden"));
  $("#settings-save").addEventListener("click", () => void saveSettings());
  $("#settings-test").addEventListener("click", () => void testConnection());

  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === "n") {
      e.preventDefault();
      $("#new-tab").click();
    }
    if (k === "j") {
      e.preventDefault();
      $("#btn-rail").click();
    }
    if (k === "l") {
      e.preventDefault();
      toggleLibrary();
    }
    if (e.key === ",") {
      e.preventDefault();
      modal().classList.toggle("hidden");
    }
  });
}

void init();
