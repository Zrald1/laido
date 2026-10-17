/* fspane — the right rail file browser.
 *
 * Replaces the old agent rail: quick-location chips up top, a breadcrumb
 * + up button, then the current folder's entries (dirs first). Rows drag
 * straight into any AI chat composer — the drop lands as a real
 * attachment (text inlines, images go as image payloads, folders become
 * listings) via fs_attach + the x-laido-path MIME. Double-click a file
 * opens it in the OS default app. */
import { $, invoke } from "./ipc.js";

interface FsRoot { label: string; path: string }
interface FsEntry { name: string; path: string; dir: boolean; size: number; mtime: number }

export const LAIDO_PATH_MIME = "application/x-laido-path";

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}M`
  : n >= 1024 ? `${(n / 1024).toFixed(0)}K`
  : `${n}B`;

const ICON = (dir: boolean, name: string) => {
  if (dir) return "📁";
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name)) return "🖼";
  if (/\.(mp[34]|wav|ogg|flac|aac)$/i.test(name)) return "🎵";
  if (/\.(mp4|mov|avi|mkv|webm)$/i.test(name)) return "🎬";
  if (/\.(pdf)$/i.test(name)) return "📕";
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name)) return "🗜";
  if (/\.(laido|md|txt|markdown)$/i.test(name)) return "📝";
  if (/\.(json|ya?ml|toml|xml|csv|tsv)$/i.test(name)) return "📊";
  if (/\.(js|ts|tsx|jsx|py|rs|html?|css|sh|bat|ps1)$/i.test(name)) return "📜";
  return "📄";
};

export function initFsPane(): void {
  const pane = $("#fspane");
  if (!pane) return;
  const crumbs = $("#fspane-crumb") as HTMLElement;
  const list = $("#fspane-list") as HTMLElement;
  const filter = $("#fspane-filter") as HTMLInputElement;
  let cwd = "";
  let entries: FsEntry[] = [];

  const render = () => {
    crumbs.textContent = cwd.replaceAll("\\", " › ");
    const q = filter.value.trim().toLowerCase();
    list.innerHTML = "";
    const show = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    if (!show.length) {
      list.innerHTML = `<div class="fsp-empty muted">${q ? "no matches" : "empty folder"}</div>`;
      return;
    }
    for (const e of show.slice(0, 300)) {
      const row = document.createElement("div");
      row.className = `fsp-row${e.dir ? " dir" : ""}`;
      row.draggable = true;
      row.title = e.path;
      row.innerHTML =
        `<span class="fsp-ico">${ICON(e.dir, e.name)}</span>` +
        `<span class="fsp-name">${e.name}</span>` +
        (e.dir ? `<span class="fsp-meta"></span>` : `<span class="fsp-meta">${fmtSize(e.size)}</span>`);
      row.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData(LAIDO_PATH_MIME, e.path);
        ev.dataTransfer?.setData("text/plain", e.path);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
      });
      row.addEventListener("dblclick", () => {
        if (e.dir) void nav(e.path);
        else void invoke("fs_open", { path: e.path }).catch(() => {});
      });
      row.addEventListener("click", () => {
        if (e.dir) void nav(e.path);
      });
      list.append(row);
    }
  };

  const nav = async (path: string) => {
    try {
      entries = await invoke<FsEntry[]>("fs_list", { path });
      cwd = path;
      render();
    } catch {
      /* permission/denied — stay where we are */
    }
  };

  filter.addEventListener("input", render);
  $("#fspane-up").addEventListener("click", () => {
    const sep = cwd.includes("\\") ? "\\" : "/";
    const parent = cwd.replace(/[\\/]+$/, "").split(sep).slice(0, -1).join(sep);
    if (parent && parent !== cwd) void nav(parent.includes(sep) ? parent : `${parent}${sep}`);
  });
  $("#fspane-reload").addEventListener("click", () => void nav(cwd));

  void (async () => {
    const roots = await invoke<FsRoot[]>("fs_roots").catch(() => [] as FsRoot[]);
    const chips = $("#fspane-roots") as HTMLElement;
    for (const r of roots) {
      const c = document.createElement("button");
      c.className = "fsp-chip";
      c.textContent = r.label;
      c.title = r.path;
      c.addEventListener("click", () => {
        chips.querySelectorAll(".fsp-chip").forEach((x) => x.classList.toggle("on", x === c));
        void nav(r.path);
      });
      chips.append(c);
    }
    /* start on Downloads — that's the folder this feature exists for */
    const dl = [...chips.querySelectorAll<HTMLElement>(".fsp-chip")].find(
      (c) => c.textContent === "Downloads",
    ) ?? chips.querySelector<HTMLElement>(".fsp-chip");
    dl?.click();
  })();
}
