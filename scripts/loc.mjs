import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const counted = new Set([".rs", ".ts", ".css", ".html", ".mjs"]);
const skipDirs = new Set(["node_modules", "target", ".git", "gen"]);
let total = 0;
const rows = [];

(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (skipDirs.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    const ext = extname(e);
    if (!counted.has(ext) || ext === ".js") continue; // .js is generated output
    const n = readFileSync(p, "utf8").split("\n").length;
    rows.push([p.replaceAll("\\", "/"), n]);
    total += n;
  }
})(".");

rows.sort((a, b) => b[1] - a[1]);
for (const [p, n] of rows) console.log(String(n).padStart(6), p);
console.log(String(total).padStart(6), "TOTAL");
