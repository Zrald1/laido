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
    /** where the 📎/🎙 buttons land — default: right after the input */
    buttonHost?: HTMLElement | null;
    /** errors surface here (chat log line or status toast) */
    onErr?: (msg: string) => void;
    /** recording state change for the host (e.g. disable send) */
    onRec?: (on: boolean) => void;
    /** a send may be in flight — transcript still lands afterwards */
    intoInput?: (text: string) => void;
    /** allow images (rag lanes only take text) */
    images?: boolean;
  } = {},
): ChatTools {
  const allowImages = opts.images !== false;
  const err = (m: string) => opts.onErr?.(m);
  const atts: Att[] = [];

  const bar = input.parentElement as HTMLElement;
  const buttons = document.createElement("span");
  buttons.className = "ct-tools";
  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "ct-btn ct-attach";
  attachBtn.title = "attach a file — screenshot, photo, text (or paste/drop)";
  attachBtn.textContent = "📎";
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "ct-btn ct-mic";
  micBtn.title = "voice — click to record, click again to transcribe";
  micBtn.textContent = "🎙";
  buttons.append(attachBtn, micBtn);
  const btnHost = opts.buttonHost ?? bar;
  if (btnHost) btnHost.insertBefore(buttons, input.nextSibling);
  else input.after(buttons);

  /* chips + VU meter live in a strip under the input row */
  const strip = document.createElement("div");
  strip.className = "ct-strip hidden";
  if (bar) bar.after(strip);
  else input.after(strip);
  const sync = () => strip.classList.toggle("hidden", !atts.length && !recording);

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
  picker.multiple = true;
  picker.accept = allowImages
    ? "image/*,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.laido,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.py,.rs,.toml,.ini,.cfg,.sql,.sh,.bat,.ps1,.svg"
    : ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.laido,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.py,.rs,.toml,.ini,.cfg,.sql,.sh,.bat,.ps1,.svg";
  picker.hidden = true;
  buttons.append(picker);
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
      for (const f of Array.from(e.dataTransfer?.files ?? [])) void addFile(f);
    });
  }

  /* ---------------- voice: record → AssemblyAI → transcript ---------------- */
  let recording = false;
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
  const putText = (t: string) =>
    opts.intoInput
      ? opts.intoInput(t)
      : ((input.value = (input.value ? `${input.value} ` : "") + t), input.focus());

  micBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!recording) {
      try {
        await invoke("voice_start");
        recording = true;
        opts.onRec?.(true);
        micBtn.classList.add("rec");
        micBtn.title = "recording — click to stop and transcribe";
        startMeter();
        sync();
      } catch (e2) {
        err(`✕ mic: ${String(e2)}`);
      }
      return;
    }
    recording = false;
    opts.onRec?.(false);
    stopMeter();
    micBtn.classList.remove("rec");
    micBtn.textContent = "⏳"; // voice_stop uploads + polls — show the wait
    micBtn.disabled = true;
    micBtn.title = "transcribing…";
    try {
      const text = (await invoke<string>("voice_stop")).trim();
      if (text) putText(text);
      else err("nothing heard — try again closer to the mic");
    } catch (e2) {
      err(`✕ ${String(e2)}`);
    }
    micBtn.disabled = false;
    micBtn.textContent = "🎙";
    micBtn.title = "voice — click to record, click again to transcribe";
    sync();
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
