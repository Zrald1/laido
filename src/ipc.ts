export const invoke = <T>(cmd: string, args?: Record<string, unknown>) =>
  window.__TAURI__.core.invoke<T>(cmd, args);

export const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/* a programmatic .focus() while a child page-view owns OS keyboard focus is
 * DOM-only — keystrokes keep routing to the page (youtube hotkeys rewind the
 * video as the user "types" in the chat). Pull OS focus back into the main
 * webview first, then focus the field. */
export const refocusField = (el: HTMLElement | null | undefined) => {
  if (!el) return;
  void invoke("pv_focus_main").catch(() => {});
  el.focus({ preventScroll: true });
};
