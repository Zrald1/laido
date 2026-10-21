/* chat+ — shared attachment + voice tools for every AI chat input.
 *
 * wireChatTools(input, opts) bolts three things onto a chat field:
 *   📎 attach  — file picker (images + text files) → chips under the bar
 *   🎙 voice   — record → AssemblyAI transcribe → transcript into the field
 *   paste/drop — Ctrl-V screenshots and dragged files become chips too
 *
 * Images are downscaled to ≤1600px jpeg and ride the next send as
 * {mime,b64} on term_ai's `images` arg (multimodal user message). Text
 * files inline into the prompt as fenced "attached" blocks. The caller
 * swaps its raw prompt for collect().prompt on send, then calls reset(). */
import { invoke } from "./ipc.js";

export interface ChatImage {
  mime: string;
  b64: string;
}

export interface ChatCollect {
  prompt: string;
  images: ChatImage[];
}

interface Att {
  kind: "image" | "text";
  name: string;
  /** image: final jpeg b64 + chip thumbnail; text: the file body */
  b64?: string;
  thumb?: string;
  text?: string;
  chip: HTMLElement;
}

export interface ChatTools {
  /** prompt with inlined text attachments + image payloads for the send */
  collect(prompt: string): ChatCollect;
  /** chips exist — an empty prompt still counts as a send */
  hasPending(): boolean;
  /** attachment names for echoing the user's ask in the log */
  names(): string[];
  /** drop all attachments (call after a send) */
  reset(): void;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|laido|xml|ya?ml|html?|css|js|ts|tsx|py|rs|toml|ini|cfg|sql|sh|bat|ps1|svg)$/i;
const TEXT_CAP = 32 * 1024;
const IMG_MAX = 1600;

/** a big pasted screenshot shrinks to jpeg — data-url bloat stays sane */
function shrinkImage(dataUrl: string, name: string): Promise<Att> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, IMG_MAX / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext("2d")?.drawImage(img, 0, 0, cv.width, cv.height);
      const jpeg = cv.toDataURL("image/jpeg", 0.85);
      resolve({
        kind: "image",
        name,
        b64: jpeg.split(",")[1] ?? "",
        thumb: jpeg,
        chip: document.createElement("span"),
      });
    };
    img.onerror = () => reject(new Error("unreadable image"));
    img.src = dataUrl;
  });
}

export function wireChatTools(
  input: HTMLInputElement | HTMLTextAreaElement,
  opts: {
    /** errors surface here (chat log line or status toast) */
    onErr?: (msg: string) => void;
    /** recording state change for the host (e.g. disable send) */
    onRec?: (on: boolean) => void;
    /** allow images (rag lanes only take text) */
    images?: boolean;
  } = {},
): ChatTools {
  const allowImages = opts.images !== false;
  const err = (m: string) => opts.onErr?.(m);
  const atts: Att[] = [];

  const bar = input.parentElement as HTMLElement;
  /* [📎] [input …] [🎙] [➤] — the canonical composer layout: attach left,
   * mic + accent send right, inline SVG glyphs, send lights up when
   * there's something to send */
  const ICONS = {
    attach:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    mic:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/></svg>`,
    stop:
      `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
    spin:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>`,
    send:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>`,
  };
  const mkBtn = (cls: string, icon: string, title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ct-btn ${cls}`;
    b.innerHTML = icon;
    b.title = title;
    return b;
  };
  const attachBtn = mkBtn("ct-attach", ICONS.attach, "attach a file — image or text (or paste/drop)");
  const micBtn = mkBtn("ct-mic", ICONS.mic, "record voice — click again to stop and transcribe");
  const sendBtn = mkBtn("ct-send", ICONS.send, "send");
  const left = document.createElement("span");
  left.className = "ct-tools ct-left";
  left.append(attachBtn);
  const right = document.createElement("span");
  right.className = "ct-tools ct-right";
  right.append(micBtn, sendBtn);
  if (bar) {
    bar.insertBefore(left, input);
    bar.insertBefore(right, input.nextSibling);
  } else {
    input.before(left);
    input.after(right);
  }
  /* send fires the input's own Enter handler — every surface keeps its
   * existing dispatch (commands, collect, fences) */
  sendBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const syncSend = () => {
    sendBtn.disabled = !input.value.trim() && !atts.length;
  };
  input.addEventListener("input", syncSend);

  /* multi-line composer — grows with the text up to ~6 lines, then the
   * field scrolls internally instead of pushing the card open-ended.
   * Enter sends (value cleared programmatically → a deferred pass shrinks
   * the field back to one line) and Shift+Enter is the newline. */
  const growField = () => {
    if (!(input instanceof HTMLTextAreaElement)) return;
    input.style.height = "auto";
    const lh = parseFloat(getComputedStyle(input).lineHeight) || 18;
    const max = Math.round(lh * 6 + 8);
    /* hidden parents (closed chat pane) report scrollHeight ≈ 0 — without
     * the floor the field collapses to a few px and stays clipped dead */
    input.style.height = `${Math.min(Math.max(input.scrollHeight, lh + 6), max)}px`;
    input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
  };
  if (input instanceof HTMLTextAreaElement) {
    growField();
    input.addEventListener("input", growField);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) window.setTimeout(growField, 0);
    });
  }

  /* chips + VU meter live in a strip under the input row */
  const strip = document.createElement("div");
  strip.className = "ct-strip hidden";
  if (bar) bar.after(strip);
  else input.after(strip);
  const sync = () => {
    strip.classList.toggle("hidden", !atts.length && !recording);
    syncSend();
  };
  syncSend();

  const remove = (a: Att) => {
    const i = atts.indexOf(a);
    if (i >= 0) atts.splice(i, 1);
    a.chip.remove();
    sync();
  };
  const addAtt = (a: Att) => {
    a.chip.className = `ct-att ${a.kind}`;
    const t = document.createElement(a.kind === "image" ? "img" : "i");
    if (a.kind === "image") (t as HTMLImageElement).src = a.thumb ?? "";
    else t.textContent = "≡";
    const n = document.createElement("span");
    n.className = "ct-att-name";
    n.textContent = a.name;
    n.title = a.name;
    const x = document.createElement("b");
    x.textContent = "×";
    x.title = "remove";
    x.addEventListener("click", () => remove(a));
    a.chip.append(t, n, x);
    strip.append(a.chip);
    atts.push(a);
    sync();
  };

  const addFile = async (f: File) => {
    const name = f.name || `pasted-${Date.now().toString(36)}.png`;
    try {
      if (f.type.startsWith("image/")) {
        if (!allowImages) return err("pictures attach to widget chats, not this box");
        addAtt(await shrinkImage(await fileToDataUrl(f), name));
      } else if (f.type.startsWith("text/") || TEXT_EXT.test(name) || f.type === "application/json") {
        const raw = await f.text();
        const chip = document.createElement("span");
        addAtt({ kind: "text", name, text: raw.slice(0, TEXT_CAP), chip });
      } else {
        err(`can't read “${name}” — images and text files work here`);
      }
    } catch (e) {
      err(`attach failed: ${String(e)}`);
    }
  };

  const picker = document.createElement("input");
  picker.type = "file";
  picker.className = "ct-picker";
  picker.multiple = true;
  picker.accept = allowImages
    ? "image/*,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.laido,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.py,.rs,.toml,.ini,.cfg,.sql,.sh,.bat,.ps1,.svg"
    : ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.laido,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.py,.rs,.toml,.ini,.cfg,.sql,.sh,.bat,.ps1,.svg";
  picker.hidden = true;
  left.append(picker);
  attachBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    picker.click();
  });
  picker.addEventListener("change", () => {
    for (const f of Array.from(picker.files ?? [])) void addFile(f);
    picker.value = "";
  });

  /* Ctrl-V — screenshots land as chips; text keeps pasting natively */
  input.addEventListener("paste", (e) => {
    const items = Array.from((e as ClipboardEvent).clipboardData?.items ?? []);
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) void addFile(f);
      }
    }
  });

  /* drag files anywhere onto the input row */
  if (bar) {
    bar.addEventListener("dragover", (e) => {
      e.preventDefault();
      bar.classList.add("ct-drop");
    });
    bar.addEventListener("dragleave", () => bar.classList.remove("ct-drop"));
    bar.addEventListener("drop", (e) => {
      e.preventDefault();
      bar.classList.remove("ct-drop");
      /* rail file-browser drags carry the path, not a File — fs_attach
       * reads it Rust-side (text inlines, images go as payloads, folders
       * become listings) so any file type the OS has works here */
      const laid = e.dataTransfer?.getData("application/x-laido-path");
      if (laid) {
        void (async () => {
          try {
            const a = await invoke<{
              name: string; kind: string; text?: string; b64?: string; mime?: string;
            }>("fs_attach", { path: laid });
            const chip = document.createElement("span");
            if (a.kind === "image" && a.b64) {
              if (!allowImages) return err("pictures attach to widget chats, not this box");
              addAtt({
                kind: "image", name: a.name, b64: a.b64,
                thumb: `data:${a.mime ?? "image/png"};base64,${a.b64}`, chip,
              });
            } else {
              addAtt({ kind: "text", name: a.name, text: a.text ?? "", chip });
            }
          } catch (x) {
            err(`attach failed: ${String(x)}`);
          }
        })();
      }
      for (const f of Array.from(e.dataTransfer?.files ?? [])) void addFile(f);
    });
  }

  /* ---------------- voice: live transcription → input ---------------- */
  let recording = false;
  let voicePrefix = "";
  let meterTimer = 0;
  const vu = document.createElement("div");
  vu.className = "ct-vu";
  for (let i = 0; i < 5; i++) vu.append(document.createElement("i"));
  strip.append(vu);
  const bars = Array.from(vu.querySelectorAll("i")) as HTMLElement[];
  const startMeter = () => {
    vu.classList.add("on");
    meterTimer = window.setInterval(async () => {
      let v = 0;
      try {
        v = await invoke<number>("voice_level");
      } catch {
        /* mic gone */
      }
      const amp = Math.min(1, v * 7);
      const now = performance.now() / 130;
      bars.forEach((b, i) => {
        b.style.height = `${3 + amp * (7 + 4 * Math.sin(now + i * 1.35))}px`;
      });
    }, 120);
  };
  const stopMeter = () => {
    window.clearInterval(meterTimer);
    vu.classList.remove("on");
  };
  // live transcript lands directly in the field — voicePrefix keeps whatever
  // the user typed before pressing the mic so dictation appends, not overwrites
  const liveSet = (seen: string) => {
    input.value = voicePrefix
      ? seen
        ? `${voicePrefix} ${seen}`
        : voicePrefix
      : seen;
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    sync();
  };
  const liveUiReset = () => {
    recording = false;
    opts.onRec?.(false);
    stopMeter();
    micBtn.disabled = false;
    micBtn.classList.remove("rec", "spin");
    micBtn.innerHTML = ICONS.mic;
    micBtn.title = "record voice — click again to stop";
    sync();
  };
  const vlisten = window.__TAURI__.event.listen;
  void vlisten<{ final: string; partial: string }>("voice:partial", (e) => {
    if (!recording) return;
    liveSet(`${e.payload.final}${e.payload.partial}`.trim());
  });
  void vlisten<{ error: string }>("voice:error", (e) => {
    if (!recording) return;
    err(`✕ ${e.payload.error}`);
    liveUiReset();
    void invoke("voice_live_stop").catch(() => {});
  });

  micBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!recording) {
      try {
        await invoke("voice_live_start");
      } catch (e2) {
        // a wedged live session blocks restart — drain it once and retry
        if (!String(e2).includes("already live")) {
          err(`✕ mic: ${String(e2)}`);
          return;
        }
        await invoke("voice_live_stop").catch(() => {});
        try {
          await invoke("voice_live_start");
        } catch (e3) {
          err(`✕ mic: ${String(e3)}`);
          return;
        }
      }
      recording = true;
      voicePrefix = input.value;
      opts.onRec?.(true);
      micBtn.classList.add("rec");
      micBtn.innerHTML = ICONS.stop; // a red square says "click to stop"
      micBtn.title = "listening — click to stop";
      startMeter();
      sync();
      return;
    }
    recording = false;
    opts.onRec?.(false);
    stopMeter();
    micBtn.classList.remove("rec");
    micBtn.classList.add("spin"); // live_stop flushes + terminates — brief spin
    micBtn.innerHTML = ICONS.spin;
    micBtn.disabled = true;
    micBtn.title = "finishing…";
    try {
      const text = (await invoke<string>("voice_live_stop")).trim();
      if (text) liveSet(text);
      else if (!voicePrefix) err("nothing heard — try again closer to the mic");
    } catch (e2) {
      err(`✕ ${String(e2)}`);
    }
    liveUiReset();
  });

  const tools: ChatTools = {
    collect(prompt) {
      const images: ChatImage[] = [];
      const parts: string[] = [];
      for (const a of atts) {
        if (a.kind === "image" && a.b64) images.push({ mime: "image/jpeg", b64: a.b64 });
        else if (a.kind === "text" && a.text) parts.push(a.name, a.text);
      }
      let out = prompt;
      if (parts.length) {
        const files: string[] = [];
        for (let i = 0; i < parts.length; i += 2) {
          files.push(`attached "${parts[i]}":\n\`\`\`\n${parts[i + 1]}\n\`\`\``);
        }
        out = `${out ? `${out}\n\n` : ""}${files.join("\n\n")}`;
      }
      if (!out.trim() && atts.length)
        out = images.length ? "describe this attachment" : "summarize the attached file";
      return { prompt: out, images };
    },
    hasPending: () => atts.length > 0,
    names: () => atts.map((a) => a.name),
    reset() {
      for (const a of [...atts]) remove(a);
    },
  };
  /* a CDP test can read the assembled payload straight off the field —
   * the invoke bridge itself is sealed against outside wrapping */
  (input as unknown as { __ct?: ChatTools }).__ct = tools;
  return tools;
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
