export {};

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
      event: {
        listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
        emit(event: string, payload?: unknown): Promise<void>;
      };
      window: {
        getCurrentWindow(): {
          label: string;
          minimize(): Promise<void>;
          toggleMaximize(): Promise<void>;
          close(): Promise<void>;
          startDragging(): Promise<void>;
          setFullscreen(on: boolean): Promise<void>;
        };
      };
      webviewWindow?: {
        WebviewWindow: (new (
          label: string,
          options: Record<string, unknown>,
        ) => { setFocus(): Promise<void>; close(): Promise<void> }) & {
          getByLabel(
            label: string,
          ): Promise<{ setFocus(): Promise<void>; close(): Promise<void> } | null>;
        };
      };
      dialog?: {
        open(options: Record<string, unknown>): Promise<string | string[] | null>;
        save(options: Record<string, unknown>): Promise<string | null>;
      };
    };
  }
}
