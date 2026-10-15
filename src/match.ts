/* ---------- tiny pure helpers — no DOM, unit-testable in plain node ----------
 * fuzzy() is the palette's matcher; stem() strips the note extension. */

export const stem = (n: string) => String(n ?? "").replace(/\.(laido|md)$/, "");

/** subsequence match score: letters in order, bonuses for consecutive
 *  runs and word-boundary hits; -1 when the query doesn't match at all */
export function fuzzy(q: string, s: string): number {
  q = String(q ?? "");
  s = String(s ?? "");
  if (!q) return 1;
  const Q = q.toLowerCase();
  const S = s.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let last = -2;
  for (let i = 0; i < S.length && qi < Q.length; i++) {
    if (S[i] !== Q[qi]) continue;
    streak = i === last + 1 ? streak + 1 : 0;
    score += 10 + streak * 8;
    if (i === 0 || /[\s\-_/]/.test(S[i - 1])) score += 12;
    last = i;
    qi++;
  }
  return qi === Q.length ? score : -1;
}
