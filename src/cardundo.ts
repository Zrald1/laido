/* ---------- card undo — a generic snapshot stack for widget cards ------
 * sheets have their own cell-level undo; every other widget (todo,
 * cards, map, deck, browser, chart, agenda…) mutates the DOM and relies
 * on the note save. This arms each card with a MutationObserver that
 * debounce-pushes its serialized markdown onto an undo stack; Ctrl+Z
 * inside the card restores the previous snapshot, Ctrl+Y/Ctrl+Shift+Z
 * re-applies. Recording pauses during a restore so undo can't feed the
 * observer. Cap: 40 snapshots — beyond that the oldest drop off. */

export interface CardUndoHost {
  serialize(card: HTMLElement): string;
  restore(card: HTMLElement, md: string): void;
}

const stacks = new WeakMap<
  HTMLElement,
  { undo: string[]; redo: string[]; last: string; restoring: boolean }
>();
const CAP = 40;

export function cardUndoSize(card: HTMLElement): number {
  return stacks.get(card)?.undo.length ?? 0;
}

/** perform one undo/redo step on the card stack — used by widgets with
 *  their own finer undo (sheets) as the fallback once that stack runs
 *  dry, and by the card keydown path. Returns whether it consumed. */
export function tryCardUndo(card: HTMLElement, redo = false): boolean {
  const stx = stacks.get(card);
  if (!stx) return false;
  const from = redo ? stx.redo : stx.undo;
  if (!from.length) return false;
  const to = redo ? stx.undo : stx.redo;
  to.push(stx.last);
  const md = from.pop()!;
  stx.restoring = true;
  stx.last = md;
  const host = hosts.get(card);
  if (!host) return false;
  try {
    host.restore(card, md);
  } finally {
    window.setTimeout(() => { stx.restoring = false; }, 60);
  }
  return true;
}

const hosts = new WeakMap<HTMLElement, CardUndoHost>();

export function armCardUndo(card: HTMLElement, host: CardUndoHost) {
  if (card.dataset.undoWired) return;
  card.dataset.undoWired = "1";
  const st = { undo: [] as string[], redo: [] as string[], last: "", restoring: false };
  stacks.set(card, st);
  hosts.set(card, host);
  try {
    st.last = host.serialize(card);
  } catch {
    /* not serializable yet — first mutation will seed it */
  }

  let deb = 0;
  const obs = new MutationObserver(() => {
    if (st.restoring) return;
    clearTimeout(deb);
    deb = window.setTimeout(() => {
      if (st.restoring) return;
      let md: string;
      try {
        md = host.serialize(card);
      } catch {
        return;
      }
      if (md === st.last) return;
      st.undo.push(st.last);
      if (st.undo.length > CAP) st.undo.shift();
      st.last = md;
      st.redo = [];
    }, 600);
  });
  obs.observe(card, { childList: true, subtree: true, characterData: true, attributes: true });

  card.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // form fields keep their native undo — only the card surface rides this
    if ((e.target as HTMLElement).closest?.("input, textarea")) return;
    const k = e.key.toLowerCase();
    const wantUndo = k === "z" && !e.shiftKey;
    const wantRedo = k === "y" || (k === "z" && e.shiftKey);
    if (!wantUndo && !wantRedo) return;
    const stx = stacks.get(card);
    if (!stx) return;
    const from = wantUndo ? stx.undo : stx.redo;
    if (!from.length) return; // let the native undo try instead
    e.preventDefault();
    e.stopPropagation();
    tryCardUndo(card, wantRedo);
  });
}
