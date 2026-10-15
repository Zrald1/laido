/* ---------- section/block slicing + splicing — pure markdown ranges ----
 * `![[note#frag]]` embeds and the peek popover slice a note to one
 * section/block; the peek editor writes edits back by splicing over the
 * same range. All functions are pure string ops — no DOM. */

/** `[start, end)` line range of the `head` section — heading included,
 *  ends at the next same-or-higher heading or EOF */
export function sectionRange(md: string, head: string): [number, number] | null {
  const lines = md.split("\n");
  const target = head.trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,3})\s+(.*)$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === target) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return [start, i];
    }
  }
  return start < 0 ? null : [start, lines.length];
}

export function sliceSection(md: string, head: string): string {
  const r = sectionRange(md, head);
  if (!r) return `*(no section "${head}")*`;
  return md.split("\n").slice(r[0], r[1]).join("\n");
}

/** `{s, e, trailing}` — the `^id` block's line range. `trailing` means
 *  the id shares the block's last line (editors must re-append it);
 *  when false the `^id` sits alone on the line right after `e`. */
export function blockRange(
  md: string,
  id: string,
): { s: number; e: number; trailing: boolean } | null {
  const lines = md.split("\n");
  const re = new RegExp(`\\s?\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  let j = -1;
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { j = i; break; }
  if (j < 0) return null;
  const indentOf = (s: string) => s.match(/^\s*/)![0].replace(/\t/g, "  ").length;
  const isItem = (s: string) => /^\s*([-*]|\d+[.)])\s/.test(s);
  const idAlone = lines[j].replace(re, "").trim() === "";
  if (idAlone && j === 0) return null;
  const end = idAlone ? j - 1 : j;
  let start = end;
  if (!idAlone && isItem(lines[end])) {
    start = end; // a list item's block is the item alone
  } else if (idAlone && isItem(lines[end])) {
    // standalone ^id after a list subtree → climb to its parent item
    const endInd = indentOf(lines[end]);
    while (start > 0 && lines[start - 1].trim() !== "") {
      const pi = indentOf(lines[start - 1]);
      start--;
      if (isItem(lines[start]) && pi < endInd) break; // absorbed the parent — stop
    }
  } else {
    while (start > 0 && lines[start - 1].trim() !== "") start--;
  }
  return { s: start, e: end, trailing: !idAlone };
}

/** `![[note#^id]]` — slice `md` to the block carrying `^id`; the id is
 *  stripped from the returned text. */
export function sliceBlock(md: string, id: string): string {
  const r = blockRange(md, id);
  if (!r) return `*(no block "^${id}")*`;
  const lines = md.split("\n").slice(r.s, r.e + 1);
  if (r.trailing) {
    const re = new RegExp(`\\s?\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    lines[lines.length - 1] = lines[lines.length - 1].replace(re, "");
  }
  const block = lines.join("\n").trim();
  return block === "" ? `*(empty block "^${id}")*` : block;
}

/** replace a section's lines with `text`; returns null when absent */
export function spliceSection(md: string, head: string, text: string): string | null {
  const r = sectionRange(md, head);
  if (!r) return null;
  const lines = md.split("\n");
  // trailing blank lines inside the range belong to the gap *after* the
  // section — keep them so a splice doesn't fuse neighbours together
  let trailingBlanks = 0;
  for (let i = r[1] - 1; i > r[0] && lines[i].trim() === ""; i--) trailingBlanks++;
  lines.splice(
    r[0],
    r[1] - r[0],
    ...text.replace(/\n+$/, "").split("\n"),
    ...Array<string>(trailingBlanks).fill(""),
  );
  return lines.join("\n");
}

/** replace a `^id` block's text; preserves the id (trailing ids re-append
 *  to the new last line, standalone ids' line is outside the range) */
export function spliceBlock(md: string, id: string, text: string): string | null {
  const r = blockRange(md, id);
  if (!r) return null;
  const lines = md.split("\n");
  const newLines = text.replace(/\n+$/, "").split("\n");
  if (r.trailing) {
    const re = new RegExp(`\\s?\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    const last = newLines.length - 1;
    newLines[last] = `${newLines[last].replace(re, "")} ^${id}`;
  }
  lines.splice(r.s, r.e - r.s + 1, ...newLines);
  return lines.join("\n");
}
