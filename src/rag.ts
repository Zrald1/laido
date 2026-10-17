import { $, invoke } from "./ipc.js";
import { addActivity } from "./log.js";
import { wireChatTools } from "./chatplus.js";
import { currentNote } from "./editor.js";

interface RagInfo {
  slug: string;
  name: string;
  size: number;
  chunks: number;
  dims: number;
}

export function toggleLibrary(force?: boolean) {
  const open = force ?? !document.body.classList.contains("lib-open");
  document.body.classList.toggle("lib-open", open);
  localStorage.setItem("laido.library", open ? "1" : "0");
  if (open) void refreshLibrary();
}

export async function refreshLibrary() {
  try {
    const list = await invoke<RagInfo[]>("rag_list");
    const el = $("#lib-list");
    el.innerHTML = "";
    if (list.length === 0) {
      const e = document.createElement("div");
      e.className = "muted";
      e.style.fontSize = "11.5px";
      e.textContent = "no files yet — drop a document or picture above";
      el.append(e);
    }
    for (const d of list) {
      const row = document.createElement("div");
      row.className = "lib-row";
      const name = document.createElement("span");
      name.className = "lib-name";
      name.textContent = d.name;
      name.title = "click to ask this file";
      const meta = document.createElement("span");
      meta.className = "lib-meta";
      meta.textContent = `${d.chunks} chunks`;
      const del = document.createElement("button");
      del.className = "lib-del";
      del.textContent = "\u2715";
      del.title = "Remove file and vectors";
      del.addEventListener("click", () => {
        void invoke("rag_remove", { slug: d.slug }).then(() => {
          addActivity(`🗑 removed ${d.name} from the library`);
          void refreshLibrary();
        });
      });
      // click a row → an inline ask box; the answer card lands in the note
      const ask = document.createElement("div");
      ask.className = "lib-ask hidden";
      const input = document.createElement("textarea");
      input.rows = 1;
      input.placeholder = "Ask this file…";
      input.spellcheck = false;
      ask.append(input);
      /* 📎 + 🎙 — text files inline into the query; pictures go to the
       * widget chats (rag_ask is a text-retrieval lane) */
      const tools = wireChatTools(input, {
        images: false,
        onErr: (m) => addActivity(`✕ ${m}`),
      });
      row.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".lib-del") || t.closest(".lib-ask")) return;
        el.querySelectorAll(".lib-ask").forEach((n) => n.classList.add("hidden"));
        ask.classList.remove("hidden");
        input.focus();
      });
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          input.value = "";
          ask.classList.add("hidden");
          return;
        }
        if (e.key !== "Enter" || e.shiftKey) return;
        const send = tools.collect(input.value.trim());
        if (!send.prompt.trim()) return;
        tools.reset();
        input.value = "";
        ask.classList.add("hidden");
        void askLibrary(d.slug, d.name, send.prompt);
      });
      row.append(name, meta, del, ask);
      el.append(row);
    }
    const chunks = list.reduce((a, b) => a + b.chunks, 0);
    const dims = list.length > 0 ? list[0].dims : 1024;
    $("#lib-stats").textContent =
      list.length === 0 ? "" : `${list.length} files · ${chunks} chunks · ${dims} dims`;
  } catch {
    /* ignore */
  }
}

/** a library ask: make sure a note is open (library.laido if none), then run
 *  the normal rag ask scoped to the file — the answer card lands in the note */
async function askLibrary(slug: string, label: string, query: string) {
  let note = currentNote();
  if (!note) {
    note = "library.laido";
    try {
      const list = await invoke<Array<{ name: string }>>("vault_list").catch(() => []);
      if (!list.some((n) => n.name === note))
        await invoke("vault_write", { name: note, content: "" });
    } catch {
      /* the write races the open — ignore */
    }
    void window.__TAURI__.event.emit("open-note", { name: note });
    for (let i = 0; i < 40 && currentNote() !== note; i++) {
      await new Promise((r) => window.setTimeout(r, 50));
    }
  }
  addActivity(`🔎 asking ${label}…`);
  try {
    await invoke("rag_ask", {
      note,
      target: slug,
      query,
      quiet: true,
      anchor: null,
      parent: null,
      question: query,
      web: false,
    });
    addActivity(`✓ answered from ${label}`);
  } catch (e) {
    addActivity(`✕ ${String(e)}`);
  }
}

async function addPaths(paths: string[]) {
  if (paths.length === 0) return;
  addActivity(`📄 embedding ${paths.length} file(s)…`);
  const bar = $("#lib-progress");
  bar.classList.remove("hidden");
  setProgress(0, "preparing…");
  try {
    await invoke("rag_add_files", { paths });
    addActivity("✓ library updated");
    setProgress(100, "done");
    window.setTimeout(() => bar.classList.add("hidden"), 1200);
  } catch (e) {
    addActivity(`✕ ${String(e)}`);
    bar.classList.add("hidden");
  }
  void refreshLibrary();
}

function setProgress(pct: number, label: string) {
  const bar = $("#lib-progress");
  (bar.querySelector(".lib-progress-fill") as HTMLElement).style.width =
    `${Math.min(100, Math.max(0, pct))}%`;
  (bar.querySelector(".lib-progress-label") as HTMLElement).textContent = label;
}

export function initLibrary() {
  $("#btn-library").addEventListener("click", () => toggleLibrary());
  $("#lib-close").addEventListener("click", () => toggleLibrary(false));
  const browse = async () => {
    const api = window.__TAURI__.dialog;
    if (!api) return;
    try {
      const picked = await api.open({
        multiple: true,
        filters: [
          {
            name: "Documents & images",
            extensions: [
              "pdf", "pptx", "ppt",
              "md", "markdown", "txt", "csv", "json", "log",
              "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff",
            ],
          },
        ],
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      if (paths.length > 0) addActivity(`⤓ selected ${paths.length} file(s)`);
      await addPaths(paths);
    } catch (e) {
      addActivity(`✕ ${String(e)}`);
    }
  };
  $("#lib-browse").addEventListener("click", (e) => {
    e.stopPropagation();
    void browse();
  });
  $("#lib-drop").addEventListener("click", () => void browse());
  void window.__TAURI__.event.listen("rag:changed", () => {
    void refreshLibrary();
  });
  void window.__TAURI__.event.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
    if (document.body.classList.contains("lib-open")) {
      const paths = e.payload.paths ?? [];
      addActivity(`⤓ dropped ${paths.length} file(s)`);
      void addPaths(paths);
    }
  });
  void window.__TAURI__.event.listen<{
    file: string;
    fileIndex: number;
    fileCount: number;
    done: number;
    total: number;
    pct: number;
    phase?: string;
  }>("rag:progress", (e) => {
    const p = e.payload;
    const bar = $("#lib-progress");
    bar.classList.remove("hidden");
    // one fill for the whole upload: extraction ≈ the first 40% of a file's
    // work, embedding the last 60% — the bar never jumps backwards
    const phaseP =
      p.phase === "ocr" ? 0.05 + 0.35 * (p.done / Math.max(1, p.total))
      : p.phase === "read" ? 0.02
      : 0.4 + 0.6 * (p.done / Math.max(1, p.total));
    const overall = Math.round(((p.fileIndex - 1 + phaseP) / p.fileCount) * 100);
    const label =
      p.phase === "ocr" ? `🔍 OCR ${p.file} — image ${p.done}/${p.total}`
      : p.phase === "read" ? `reading ${p.file}…`
      : `embedding ${p.file} — batch ${p.done}/${p.total}`;
    setProgress(overall, `${label} · ${overall}%`);
  });
  if (localStorage.getItem("laido.library") === "1") toggleLibrary(true);
  void refreshLibrary();
}
