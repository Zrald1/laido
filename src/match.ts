
const S = (v: unknown): string => typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
/* ---------- tiny pure helpers — no DOM, unit-testable in plain node ----------
 * fuzzy() is the palette's matcher; stem() strips the note extension. */

export const stem = (n: string) => S(n).replace(/\.(laido|md)$/, "");

/** subsequence match score: letters in order, bonuses for consecutive
 *  runs and word-boundary hits; -1 when the query doesn't match at all */
export function fuzzy(q: string, s: string): number {
  q = S(q);
  s = S(s);
  if (!q) return 1;
  const Q = q.toLowerCase();
  const L = s.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let i = 0; i < L.length && qi < Q.length; i++) {
    if (L[i] !== Q[qi]) continue;
    streak = i === last + 1 ? streak + 1 : 0;
    score += 10 + streak * 8;
    if (i === 0 || /[\s\-_/]/.test(L[i - 1])) score += 12;
    last = i;
    qi++;
  }
  return qi === Q.length ? score : -1;
}
