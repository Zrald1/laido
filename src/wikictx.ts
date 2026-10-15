/* ---------- `[[` autocomplete context — pure text helpers -------------
 * Kept DOM-free so the suggester's query grammar is unit-testable. */

/** the `[[…` context in `before` (text up to the caret), or null.
 *  `embed` marks a `![[…` (the `!` is included in `start` so replacing
 *  the range removes the whole trigger). */
export function matchWikiCtx(
  before: string,
): { start: number; q: string; embed: boolean } | null {
  before = String(before ?? "");
  const m = before.match(/!?\[\[([^\[\]]*)$/);
  if (!m) return null;
  const open = m[0].indexOf("[[");
  const embed = open > 0 && m[0][0] === "!";
  return {
    start: before.length - m[0].length + (embed ? 0 : open),
    q: m[1],
    embed,
  };
}

/** split a `[[…` query into note-part vs heading-part —
 *  `[[stem#partial` → {stem:"stem", head:"partial"}; `[[#h` → stem "" */
export function splitWikiQuery(q: string): { stem: string; head: string } | null {
  const m = String(q ?? "").match(/^([^#]*)#(.*)$/);
  if (!m) return null;
  return { stem: m[1].trim(), head: m[2] };
}
