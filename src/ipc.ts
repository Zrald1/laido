export const invoke = <T>(cmd: string, args?: Record<string, unknown>) =>
  window.__TAURI__.core.invoke<T>(cmd, args);

export const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;
