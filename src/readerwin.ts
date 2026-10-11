import { $, invoke } from "./ipc.js";
import { loadNotices } from "./agent.js";
import { renderMarkdown } from "./render.js";
import { serialize } from "./editable.js";
import { bootstrapLang, t } from "./i18n.js";

export async function initReaderWindow(key: string) {
  await bootstrapLang();
  document.body.classList.add("reader-mode");
  const titleEl = $("#reader-title");
  const bodyEl = $("#reader-body");
  const noteBtn = $("#reader-note");
  const state = $("#reader-state");
  const notice = loadNotices().find((n) => n.key === key);
  if (!notice) {
    titleEl.textContent = "Result unavailable";
    bodyEl.textContent = "(this notification was dismissed)";
    return;
  }
  const titles: Record<string, string> = {
    brief: "Morning brief",
    review: "Weekly review",
    research: "Research",
    scheduled: "Scheduled task",
    ask: "Answer",
    remind: "Reminder",
  };
  titleEl.textContent = t(`notice.${notice.kind}`) || titles[notice.kind] || "Result";
  titleEl.className = `reader-title-text nt-${notice.kind}`;
  noteBtn.textContent = notice.note;
  noteBtn.title = t("reader.openNote");
  noteBtn.addEventListener("click", () => {
    void window.__TAURI__.event.emit("open-note", { name: notice.note });
    void window.__TAURI__.webviewWindow?.WebviewWindow.getByLabel("main").then((m) => {
      void m?.setFocus();
    });
  });

  const kind = notice.kind;
  const editable = kind !== "remind";
  bodyEl.contentEditable = editable ? "true" : "false";

  let timer: number | undefined;
  let flashTimer: number | undefined;
  const flash = (text: string, ms = 1800) => {
    state.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      state.textContent = "";
    }, ms);
  };
  const save = async () => {
    if (!editable) return;
    const md = serialize(bodyEl);
    try {
      if (kind === "brief" || kind === "review") {
        await invoke("vault_write", { name: notice.note, content: md });
      } else {
        await invoke("vault_update_callout", {
          note: notice.note,
          topic: notice.text,
          callout: md.trimEnd(),
        });
      }
      flash("saved");
    } catch {
      flash("save failed", 4000);
    }
  };

  bodyEl.addEventListener("input", () => {
    state.textContent = "";
    clearTimeout(timer);
    timer = window.setTimeout(() => void save(), 700);
  });
  bodyEl.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      document.execCommand("bold");
    }
    if (k === "i") {
      e.preventDefault();
      document.execCommand("italic");
    }
  });

  $("#reader-saveas").addEventListener("click", async () => {
    const label = (titles[kind] ?? "Result").replace(/[^\w \-]/g, "").trim();
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const name = `${label} ${stamp}.laido`;
    try {
      await invoke("vault_write", { name, content: serialize(bodyEl) });
      flash(`saved as ${name}`, 4000);
      void window.__TAURI__.event.emit("open-note", { name });
      void window.__TAURI__.webviewWindow?.WebviewWindow.getByLabel("main").then((m) => {
        void m?.setFocus();
      });
    } catch (e) {
      flash(`✕ ${String(e)}`, 4000);
    }
  });

  $("#reader-min").addEventListener("click", () => {
    void window.__TAURI__.window.getCurrentWindow().minimize();
  });
  $("#reader-max").addEventListener("click", () => {
    void window.__TAURI__.window.getCurrentWindow().toggleMaximize();
  });
  $("#reader-close").addEventListener("click", () => {
    void window.__TAURI__.window.getCurrentWindow().close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      void window.__TAURI__.window.getCurrentWindow().close();
    }
  });

  try {
    const md = notice.body ?? (await invoke<string>("vault_read", { name: notice.note }));
    bodyEl.innerHTML = renderMarkdown(md);
  } catch {
    bodyEl.textContent = notice.text;
  }
}
