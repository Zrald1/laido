import { $ } from "./ipc.js";

const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";

const activity: string[] = [];

export function addActivity(text: string) {
  activity.unshift(S(text));
  if (activity.length > 12) activity.length = 12;
  renderActivity();
}

export function renderActivity() {
  const el = $("#activity");
  el.innerHTML = "";
  if (activity.length === 0) {
    el.className = "muted";
    el.textContent = "quiet…";
    return;
  }
  el.className = "";
  for (const line of activity) {
    const d = document.createElement("div");
    d.className = "act-line";
    d.textContent = line;
    el.append(d);
  }
}
