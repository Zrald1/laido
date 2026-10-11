import { $ } from "./ipc.js";
import { loadNotices, renderNoticeCard, type Notice } from "./agent.js";
import { bootstrapLang } from "./i18n.js";

export async function initNoticeWindow() {
  await bootstrapLang();
  document.body.classList.add("notice-mode");
  const box = $("#reminders");
  const rendered = new Map<string, HTMLElement>();

  const closeIfEmpty = () => {
    if (loadNotices().length === 0) {
      void window.__TAURI__.window.getCurrentWindow().close();
    }
  };

  const draw = () => {
    const list = loadNotices();
    if (list.length === 0) {
      void window.__TAURI__.window.getCurrentWindow().close();
      return;
    }
    for (const [k, el] of rendered) {
      if (!list.some((n) => n.key === k)) {
        el.remove();
        rendered.delete(k);
      }
    }
    for (const n of list) {
      if (rendered.has(n.key)) continue;
      const el = renderNoticeCard(
        n,
        (x: Notice) => void openReader(x.key),
        closeIfEmpty,
      );
      rendered.set(n.key, el);
      box.append(el);
    }
  };

  async function openReader(key: string) {
    const api = window.__TAURI__.webviewWindow;
    if (!api?.WebviewWindow) return;
    try {
      const existing = await api.WebviewWindow.getByLabel("reader");
      if (existing) await existing.close();
    } catch {
      /* ignore */
    }
    try {
      new api.WebviewWindow("reader", {
        url: `index.html?reader=${encodeURIComponent(key)}`,
        width: 560,
        height: 640,
        alwaysOnTop: true,
        decorations: false,
        resizable: true,
        title: "Laido — result",
      });
    } catch {
      /* ignore */
    }
  }

  draw();
  const ev = window.__TAURI__.event;
  void ev.listen("remind:fired", () => window.setTimeout(draw, 150));
  void ev.listen("brief:done", () => window.setTimeout(draw, 150));
  void ev.listen("research:done", () => window.setTimeout(draw, 150));
  window.setInterval(draw, 5000);
}
