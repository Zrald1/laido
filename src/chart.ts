/* ---------- the chart widget — data viz living in a callout card ----------
 * Storage: `> [!chart] title` + meta lines:
 *   > type: bar|barh|line|area|pie|doughnut|scatter|stacked
 *   > data: <sheet-title> <A1:B9>     (live — re-renders on sheet:changed)
 *   or inline rows `> label | v1 | v2` (each `|` is another series)
 *   > colors: #hex,#hex…
 *
 * ` ```chart ` fences drive it via chartApi; `chart` slides in decks reuse
 * paintChart so a presentation can carry live sheet data. */

import { invoke } from "./ipc.js";
import { sheetApi } from "./sheet.js";

export const CHART_TYPES = [
  "bar", "barh", "line", "area", "pie", "doughnut", "scatter", "stacked",
] as const;

export interface ChartModel {
  title: string;
  type: string;
  labels: string[];
  series: number[][]; // series[k][i] aligned to labels[i]
  source: string;     // "<sheet-title> <A1:B9>" — live binding
  colors: string[];
}

export const PALETTE = [
  "#e0a458", "#7bc98f", "#5aa9e6", "#e2604c", "#b07dd0",
  "#6bc7bd", "#d4a03c", "#8fa3bf", "#c96f9a", "#9d968a",
];

const emptyModel = (title = "chart"): ChartModel => ({
  title,
  type: "bar",
  labels: [],
  series: [],
  source: "",
  colors: [],
});

/* ---------- markdown <-> model ---------- */

export function parseChart(block: string[]): ChartModel {
  if (!Array.isArray(block)) block = [];
  const head = block[0] ?? "";
  const m = emptyModel(head.replace(/^\[!\w+\]\s*/, "").trim() || "chart");
  for (const raw of block.slice(1)) {
    const t = raw.trim();
    const kv = t.match(/^(type|data|colors|labels):\s*(.*)$/i);
    if (kv) {
      const [, k, v] = kv;
      if (k === "type") m.type = v.toLowerCase();
      else if (k === "data") m.source = v;
      else if (k === "colors") m.colors = v.split(",").map((s) => s.trim()).filter(Boolean);
      else m.labels = v.split(",").map((s) => s.trim());
      continue;
    }
    // data row: `label | v1 | v2 …`
    if (t && t !== ">") {
      const parts = t.split("|").map((s) => s.trim());
      m.labels.push(parts[0]);
      for (let i = 1; i < parts.length; i++) {
        while (m.series.length < parts.length - 1) m.series.push([]);
        m.series[i - 1].push(Number(parts[i]) || 0);
      }
    }
  }
  return m;
}

export function chartToMd(card: HTMLElement): string {
  if (!card?.dataset) return "";
  const title = card.dataset.topic ?? "chart";
  const type = card.dataset.ctype ?? "bar";
  const src = card.dataset.csrc ?? "";
  const lines: string[] = [`> [!chart] ${title}`, `> type: ${type}`];
  if (src) lines.push(`> data: ${src}`);
  const colors = card.dataset.ccolors ?? "";
  if (colors) lines.push(`> colors: ${colors}`);
  // inline snapshot so the file carries the numbers even when sourced
  const labels = (card.dataset.clabels ?? "").split("\u0001").filter((s) => s !== "");
  const serJson = card.dataset.cseries ?? "[]";
  try {
    const series = JSON.parse(serJson) as number[][];
    labels.forEach((lb, i) => {
      lines.push(`> ${lb} | ${series.map((s) => s[i] ?? "").join(" | ")}`);
    });
  } catch { /* empty */ }
  return lines.join("\n");
}

/** inline `label | v | v` rows + dataset into a model (post-render replay) */
export function chartFromCard(card: HTMLElement): ChartModel {
  const m = emptyModel(card.dataset.topic ?? "chart");
  m.type = card.dataset.ctype ?? "bar";
  m.source = card.dataset.csrc ?? "";
  m.colors = (card.dataset.ccolors ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  m.labels = (card.dataset.clabels ?? "").split("\u0001").filter((s) => s !== "");
  try {
    m.series = JSON.parse(card.dataset.cseries ?? "[]") as number[][];
  } catch { m.series = []; }
  return m;
}

/* ---------- the canvas renderer ---------- */

const DPR = () => Math.min(2, window.devicePixelRatio || 1);

function setupCanvas(cv: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const w = cv.clientWidth || 560;
  const h = cv.clientHeight || 300;
  const dpr = DPR();
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const color = (m: ChartModel, i: number) => m.colors[i] ?? PALETTE[i % PALETTE.length];

const css = (name: string, fb: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;

/** draw one chart — shared by the card, deck `chart` slides, PNG export */
export function paintChart(cv: HTMLCanvasElement, m: ChartModel) {
  const ctx = setupCanvas(cv);
  if (!ctx) return;
  const W = cv.clientWidth || 560;
  const H = cv.clientHeight || 300;
  const fg = css("--fg", "#2a2620");
  const muted = css("--muted", "#8a8276");
  const line = css("--line", "#e2ddd2");
  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui, sans-serif";

  const labels = m.labels;
  const series = m.series;
  const flat = series.flat();
  const type = m.type;
  if (!labels.length || !series.length || !flat.length) {
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.fillText("no data — set a sheet range or inline rows", W / 2, H / 2);
    return;
  }

  if (type === "pie" || type === "doughnut") {
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2 - 34;
    const vals = series[0];
    const total = vals.reduce((a, b) => a + Math.abs(b), 0) || 1;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (Math.abs(v) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = color(m, i);
      ctx.fill();
      if (type === "doughnut") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // label at mid-angle
      const am = (a0 + a1) / 2;
      const lx = cx + Math.cos(am) * (R + 16);
      const ly = cy + Math.sin(am) * (R + 16);
      ctx.fillStyle = fg;
      ctx.textAlign = lx > cx ? "left" : "right";
      const pct = Math.round((Math.abs(v) / total) * 100);
      ctx.fillText(`${labels[i] ?? i + 1} ${pct}%`, lx, ly);
      a0 = a1;
    });
    return;
  }

  // cartesian types — axes + gridlines
  const padL = 46;
  const padR = 12;
  const padT = 14;
  const padB = 30;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const isBarh = type === "barh";
  const max = Math.max(...flat.map(Math.abs), 0);
  const min = Math.min(0, ...flat);
  const span = max - min || 1;
  const y0 = padT + ph - (0 - min) / span * ph; // zero line

  const nice = (v: number) => {
    const p = Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1)));
    const n = v / p;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p * Math.sign(v || 1);
  };
  const maxN = nice(max * 1.05);
  const toY = (v: number) => padT + ph - (v - min) / (maxN - min || span) * ph;

  // gridlines + y labels
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = min + ((maxN - min) / ticks) * i;
    const y = toY(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(Number.isInteger(v) ? String(v) : v.toFixed(1), padL - 6, y + 3);
  }
  // x labels
  ctx.textAlign = "center";
  const step = pw / labels.length;
  labels.forEach((lb, i) => {
    const x = isBarh ? padL + pw / 2 : padL + step * (i + 0.5);
    const y = H - 14;
    ctx.fillStyle = muted;
    if (isBarh) {
      ctx.textAlign = "right";
      ctx.fillText(lb, padL - 6, padT + (ph / labels.length) * (i + 0.55));
    } else {
      ctx.fillText(lb.length > 9 ? lb.slice(0, 8) + "…" : lb, x, y);
    }
  });

  if (type === "bar" || type === "stacked") {
    const groups = labels.length;
    const slot = pw / groups;
    if (type === "stacked") {
      // cumulative bars
      labels.forEach((_l, i) => {
        let acc = 0;
        series.forEach((s, k) => {
          const v = s[i] ?? 0;
          const y1 = toY(acc);
          const y2 = toY(acc + v);
          ctx.fillStyle = color(m, k);
          const x = padL + slot * (i + 0.2);
          ctx.fillRect(x, Math.min(y1, y2), slot * 0.6, Math.abs(y2 - y1));
          acc += v;
        });
      });
    } else {
      const bw = slot * 0.7 / series.length;
      series.forEach((s, k) => {
        ctx.fillStyle = color(m, k);
        s.forEach((v, i) => {
          const x = padL + slot * i + slot * 0.15 + bw * k;
          const y = toY(Math.max(0, v));
          const h = Math.abs(toY(v) - toY(0));
          ctx.fillRect(x, y, bw * 0.9, Math.max(h, v === 0 ? 0 : 1));
        });
      });
    }
  } else if (type === "barh") {
    const slot = ph / labels.length;
    const maxV = Math.max(...flat.map(Math.abs), 1);
    series.forEach((s, k) => {
      ctx.fillStyle = color(m, k);
      s.forEach((v, i) => {
        const bw = (Math.abs(v) / maxV) * (pw - 10);
        const y = padT + slot * i + slot * 0.15 + (slot * 0.7 / series.length) * k;
        ctx.fillRect(padL, y, bw, slot * 0.7 / series.length);
      });
    });
  } else {
    // line / area / scatter
    const toX = (i: number) => padL + (pw / Math.max(1, labels.length - 1)) * i;
    series.forEach((s, k) => {
      const pts = s.map((v, i) => [toX(i), toY(v)] as const);
      if (type === "area") {
        ctx.beginPath();
        ctx.moveTo(pts[0]?.[0] ?? padL, y0);
        pts.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(pts[pts.length - 1]?.[0] ?? padL, y0);
        ctx.closePath();
        ctx.fillStyle = color(m, k) + "33";
        ctx.fill();
      }
      if (type !== "scatter") {
        ctx.beginPath();
        ctx.strokeStyle = color(m, k);
        ctx.lineWidth = 2;
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      ctx.fillStyle = color(m, k);
      pts.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, type === "scatter" ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }
  // zero axis
  ctx.strokeStyle = muted;
  ctx.beginPath();
  if (isBarh) {
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, H - padB);
  } else {
    ctx.moveTo(padL, y0);
    ctx.lineTo(W - padR, y0);
  }
  ctx.stroke();
  // legend for multi-series
  if (series.length > 1) {
    let lx = padL;
    ctx.textAlign = "left";
    series.forEach((_s, k) => {
      ctx.fillStyle = color(m, k);
      ctx.fillRect(lx, H - 24, 8, 8);
      ctx.fillStyle = muted;
      ctx.fillText(`s${k + 1}`, lx + 11, H - 17);
      lx += 34;
    });
  }
}

/* ---------- sheet-range resolution ---------- */

/** "budget A1:B8" → labels+series pulled live off that sheet card */
export function fromSheetRange(source: string): Pick<ChartModel, "labels" | "series"> | null {
  const m = source.match(/^(.*?)\s+([A-Z]+\d+:[A-Z]+\d+|[A-Z]+:[A-Z]+|\d+:\d+)$/i);
  if (!m) return null;
  const [, title, range] = m;
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".sheet-card"));
  const card =
    cards.find((c) => (c.dataset.topic ?? "").toLowerCase() === title.trim().toLowerCase()) ??
    cards.find((c) => (c.dataset.topic ?? "").toLowerCase().includes(title.trim().toLowerCase()));
  const api = card ? sheetApi(card) : null;
  if (!api) return null;
  const read = api.read().split("\n").map((l) => l.split("\t"));
  const cellAt = (r: number, c: number) => read[r]?.[c] ?? "";
  const colNum = (s: string) => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  // A1:B8 → first col = labels, rest = series; A:C or 1:9 also work
  const rm = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  const labels: string[] = [];
  const series: number[][] = [];
  if (rm) {
    const c0 = colNum(rm[1]);
    const r0 = Number(rm[2]) - 1;
    const c1 = colNum(rm[3]);
    const r1 = Number(rm[4]) - 1;
    for (let c = c0 + 1; c <= c1; c++) series.push([]);
    for (let r = r0; r <= r1; r++) {
      labels.push(cellAt(r, c0));
      for (let c = c0 + 1; c <= c1; c++) series[c - c0 - 1].push(Number(cellAt(r, c)) || 0);
    }
    return { labels, series };
  }
  const cm = range.match(/^([A-Z]+):([A-Z]+)$/i);
  if (cm) {
    const c0 = colNum(cm[1]);
    const c1 = colNum(cm[2]);
    for (let c = c0 + 1; c <= c1; c++) series.push([]);
    for (let r = 0; r < read.length; r++) {
      if (!cellAt(r, c0) && series.every((_s, k) => !cellAt(r, c0 + 1 + k))) continue;
      labels.push(cellAt(r, c0));
      for (let c = c0 + 1; c <= c1; c++) series[c - c0 - 1].push(Number(cellAt(r, c)) || 0);
    }
    return { labels, series };
  }
  return null;
}

/* ---------- the live card ---------- */

export interface ChartApi {
  title(): string;
  read(): string;
  setType(t: string): void;
  setRows(rows: string[][]): void;   // [["label","v","v2"],…]
  setSource(sheetTitle: string, range: string): void;
  clearSource(): void;
  model(): ChartModel;
  exportPng(path?: string): Promise<string>;
}

const apis = new WeakMap<HTMLElement, ChartApi>();
export function chartApi(card: HTMLElement): ChartApi | undefined {
  return apis.get(card);
}

export function chartInnerHtml(): string {
  return (
    `<div class="chart-bar">` +
    `<select class="chart-type" contenteditable="false">` +
    CHART_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("") +
    `</select>` +
    `<span class="chart-src" title="data source — click to edit"></span>` +
    `<button class="chart-b" data-a="png" title="export as PNG">⇪ png</button>` +
    `</div>` +
    `<div class="chart-wrap"><canvas class="chart-cv"></canvas></div>`
  );
}

export function buildChartCard(title: string): HTMLElement {
  title = String(title ?? "");
  const card = document.createElement("div");
  card.className = "callout chart-card";
  card.dataset.kind = "chart";
  card.dataset.topic = title || "chart";
  card.dataset.ctype = "bar";
  card.innerHTML =
    `<div class="callout-head"><span class="callout-title">${title || "chart"}</span></div>` +
    chartInnerHtml();
  return card;
}

export function wireChart(card: HTMLElement) {
  if (!card?.dataset) return;
  if (card.dataset.chartWired) return;
  card.dataset.chartWired = "1";
  const onChange = () => card.dispatchEvent(new CustomEvent("chart:changed", { bubbles: true }));
  const cv = card.querySelector<HTMLCanvasElement>(".chart-cv");
  const sel = card.querySelector<HTMLSelectElement>(".chart-type");
  const srcEl = card.querySelector<HTMLElement>(".chart-src");
  if (!cv || !sel || !srcEl) return;

  const model = (): ChartModel => {
    const m = chartFromCard(card);
    // live binding wins — pull the range fresh each render
    if (m.source) {
      const live = fromSheetRange(m.source);
      if (live && live.labels.length) {
        m.labels = live.labels;
        m.series = live.series;
      }
    }
    return m;
  };

  const paint = () => {
    const m = model();
    paintChart(cv, m);
    sel.value = m.type;
    srcEl.textContent = m.source ? `◔ ${m.source}` : `${m.labels.length} pts inline`;
    srcEl.classList.toggle("live", !!m.source);
  };

  // live binding: any sheet edit repaints
  card.closest(".note-body, body")?.addEventListener("sheet:changed", () => {
    if (card.dataset.csrc) paint();
  });

  sel.addEventListener("change", () => {
    card.dataset.ctype = sel.value;
    paint();
    onChange();
  });

  srcEl.addEventListener("click", () => {
    const cur = card.dataset.csrc ?? "";
    const v = prompt("data source — 'sheet title A1:B9' (blank = inline data)", cur);
    if (v === null) return;
    card.dataset.csrc = v.trim();
    paint();
    onChange();
  });

  card.querySelector('[data-a="png"]')?.addEventListener("click", (e) => {
    e.stopPropagation();
    void doExportPng();
  });

  const doExportPng = async (path?: string): Promise<string> => {
    let p = path;
    if (!p) {
      p = (await (window.__TAURI__?.dialog?.save({
        filters: [{ name: "PNG image", extensions: ["png"] }],
        defaultPath: `${card.dataset.topic || "chart"}.png`,
      }) ?? Promise.resolve(null))) ?? undefined;
      if (!p) return "export cancelled";
    }
    try {
      const b64 = cv.toDataURL("image/png").split(",")[1];
      return await invoke<string>("file_write_b64", { path: p, base64: b64 });
    } catch (e) {
      return `export failed: ${String(e)}`;
    }
  };

  paint();

  apis.set(card, {
    title: () => card.dataset.topic ?? "chart",
    read: () => {
      const m = model();
      return `${m.type} chart — ${m.labels.length} points, ${m.series.length} series\n` +
        m.labels.map((l, i) => `${l}: ${m.series.map((s) => s[i] ?? "").join(", ")}`).join("\n");
    },
    setType: (t) => {
      if ((CHART_TYPES as readonly string[]).includes(t)) {
        card.dataset.ctype = t;
        paint();
        onChange();
      }
    },
    setRows: (rows) => {
      if (!Array.isArray(rows)) return;
      const labels: string[] = [];
      const series: number[][] = [];
      for (const r of rows) {
        labels.push(r[0] ?? "");
        for (let i = 1; i < r.length; i++) {
          while (series.length < r.length - 1) series.push([]);
          series[i - 1].push(Number(r[i]) || 0);
        }
      }
      card.dataset.clabels = labels.join("\u0001");
      card.dataset.cseries = JSON.stringify(series);
      card.dataset.csrc = "";
      paint();
      onChange();
    },
    setSource: (t2, range) => {
      card.dataset.csrc = `${t2} ${range}`.trim();
      paint();
      onChange();
    },
    clearSource: () => {
      card.dataset.csrc = "";
      paint();
      onChange();
    },
    model,
    exportPng: (p) => doExportPng(p),
  });
}
