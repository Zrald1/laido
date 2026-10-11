const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const katexApi = () =>
  (window as unknown as {
    katex?: { renderToString: (tex: string, opts?: object) => string };
  }).katex;

/** LaTeX → rendered HTML via KaTeX; the source rides along in data-tex so
 *  inlineToMd can round-trip it back to \[…\] / \(…\) on save */
function renderTex(tex: string, display: boolean): string {
  const meta = ` data-tex="${attr(tex)}"${display ? ' data-disp="1"' : ""}`;
  const k = katexApi();
  if (!k) return `<code class="tex"${meta}>${esc(tex)}</code>`;
  try {
    return `<span class="tex"${meta}>${k.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
    })}</span>`;
  } catch {
    return `<code class="tex"${meta}>${esc(tex)}</code>`;
  }
}

/** gather a multi-line \[ … \] block starting at lines[i]; returns
 *  { tex, end } — end is the index of the line holding \] */
function texBlock(lines: string[], i: number): { tex: string; end: number } | null {
  const buf: string[] = [];
  for (let j = i; j < lines.length; j++) {
    buf.push(lines[j]);
    if (j > i && lines[j].includes("\\]")) return { tex: unwrapTex(buf), end: j };
    if (j === i && lines[j].includes("\\]", lines[j].indexOf("\\[") + 2)) return null; // single-line — inline() covers it
    if (j - i > 40) return null;
  }
  return buf.length > 1 ? { tex: unwrapTex(buf), end: i + buf.length - 1 } : null;
}

function unwrapTex(buf: string[]): string {
  return buf
    .join("\n")
    .replace(/^[\s\S]*?\\\[/, "")
    .replace(/\\\][\s\S]*$/, "")
    .trim();
}

function inline(s: string): string {
  const links: string[] = [];
  const math: string[] = [];
  // LaTeX first — before the link esc() pass can tangle \[ \( \) with links
  let h = s.replace(
    /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$\$([\s\S]+?)\$\$/g,
    (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
      math.push(renderTex((a ?? b ?? c ?? "").trim(), a !== undefined || c !== undefined));
      return `${math.length - 1}`;
    },
  );
  h = h.replace(
    /\[((?:[^\[\]]|\[[^\]]*\])+)\]\(((?:https?:\/\/)(?:[^()\s]|\([^()\s]*\))+)\)/g,
    (_m, text: string, url: string) => {
      links.push(`<a class="lnk" data-url="${attr(url)}">${esc(text)}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    },
  );
  h = h.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/g, (_m, note: string, label?: string) => {
    const n = note.trim();
    links.push(`<a class="wikilink" data-note="${attr(n)}">${esc((label ?? n).trim())}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  h = esc(h);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  h = h.replace(
    /==(?:(\w+):)?([^=]+)==/g,
    (_m, c: string | undefined, txt: string) => `<mark${c ? ` class="mk-${c}"` : ""}>${txt}</mark>`,
  );
  h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // models often answer with literal <sub>/<sup>/<u> markup — keep those
  // three tags (and only those) so formulas and units render properly
  h = h.replace(/&lt;sub&gt;([\s\S]*?)&lt;\/sub&gt;/g, "<sub>$1</sub>");
  h = h.replace(/&lt;sup&gt;([\s\S]*?)&lt;\/sup&gt;/g, "<sup>$1</sup>");
  h = h.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, "<u>$1</u>");
  h = h.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => links[Number(n)] ?? "");
  h = h.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => math[Number(n)] ?? "");
  return h;
}

function callout(block: string[]): string {
  const head = block[0] ?? "";
  const marker = (head.match(/^\[!(\w+)\]/) ?? [])[1] ?? "ai";
  const sticky = marker === "sticky";
  const stickyRaw = sticky ? head.replace(/^\[!sticky\]\s*/, "").trim() : "";
  let topic = "";
  let title = "";
  let color = "yellow";
  if (sticky) {
    topic = stickyRaw.split(/\s+/)[0] ?? "";
    let rest = stickyRaw.slice(topic.length).trim();
    const cm = rest.match(/^color=(\w+)\s*/);
    if (cm) {
      color = cm[1];
      rest = rest.slice(cm[0].length).trim();
    }
    title = rest;
  } else {
    // strip the [!ai] marker plus any stacked legacy markers/prefixes
    // (older saves stored "research: [!ai] rag: name" verbatim)
    topic = head.replace(/^\[!\w+\]\s*/, "").trim();
    let prev = "";
    while (prev !== topic) {
      prev = topic;
      topic = topic.replace(/^(?:\[!\w+\]\s*|research:\s*|rag:\s*)/i, "").trim();
    }
  }
  const body: string[] = [];
  let sources: Array<{ title: string; url: string }> = [];
  for (const line of block.slice(1)) {
    const sm = line.match(/^Sources:\s*(.+)$/);
    if (sm) {
      sources = [
        ...sm[1].matchAll(
          /\[((?:[^\[\]]|\[[^\]]*\])+)\]\(((?:https?:\/\/)(?:[^()\s]|\([^()\s]*\))+)\)/g,
        ),
      ].map((x) => ({
        title: x[1],
        url: x[2],
      }));
    } else {
      body.push(line);
    }
  }
  const bodyHtml: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.trimStart().startsWith("\\[")) {
      const m = texBlock(body, i);
      if (m) {
        bodyHtml.push(`<p class="math-disp">${renderTex(m.tex, true)}</p>`);
        i = m.end;
        continue;
      }
    }
    const hm = l.match(/^#{1,4}\s+(.+)$/);
    if (hm) {
      bodyHtml.push(`<h4 class="co-h">${inline(hm[1])}</h4>`);
      continue;
    }
    if (l.trim().length) bodyHtml.push(`<p>${inline(l)}</p>`);
  }
  const srcHtml = sources
    .map((s) => {
      let host = "";
      try {
        host = new URL(s.url).hostname.replace(/^www\./, "");
      } catch {
        host = "";
      }
      return (
        `<a class="src" data-url="${attr(s.url)}">` +
        `<img class="fav" src="https://www.google.com/s2/favicons?domain=${attr(host)}&sz=64" alt="" onerror="this.style.visibility='hidden'"/>` +
        `<span class="src-site">${esc(host)}</span>` +
        `<span class="src-title">${esc(s.title)}</span>` +
        `</a>`
      );
    })
    .join("");
  const raw = "> " + block.join("\n> ");
  return (
    `<div class="callout${sticky ? " sticky" : ""}" data-kind="${marker}"${
      sticky ? ` data-color="${attr(color)}"` : ""
    } data-md="${attr(raw)}" data-topic="${attr(topic)}">` +
    `<div class="callout-head">${
      sticky
        ? `<span class="sticky-title">${esc(title)}</span>`
        : `<span class="callout-title">${esc(topic)}</span>`
    }</div>` +
    `<div class="callout-body">${bodyHtml.join("")}</div>` +
    (srcHtml ? `<div class="callout-src">${srcHtml}</div>` : "") +
    `</div>`
  );
}

export function renderCalloutMd(md: string): string {
  const block = md.split("\n").map((l) => l.trimStart().replace(/^>\s?/, ""));
  return callout(block);
}

export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (t.startsWith("> [!")) {
      flushAll();
      const block: string[] = [];
      let j = i;
      while (j < lines.length) {
        const lt = lines[j].trimStart();
        if (lt.startsWith(">")) {
          const content = lt.replace(/^>\s?/, "");
          if (block.length > 0 && content.startsWith("[!")) break;
          block.push(content);
          j++;
          continue;
        }
        if (lt.trim() === "") {
          let k = j;
          while (k < lines.length && lines[k].trim() === "") k++;
          if (k < lines.length) {
            const nxt = lines[k].trimStart();
            if (nxt.startsWith(">") && !nxt.replace(/^>\s?/, "").startsWith("[!")) {
              j++;
              continue;
            }
          }
        }
        break;
      }
      i = j - 1;
      out.push(callout(block));
      continue;
    }
    if (t.startsWith(">")) {
      flushAll();
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (t.startsWith("\\[")) {
      const m = texBlock(lines, i);
      if (m) {
        flushAll();
        out.push(`<div class="math-disp">${renderTex(m.tex, true)}</div>`);
        i = m.end;
        continue;
      }
      // single-line \[…\] — fall through; inline() renders it inline
    }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushAll();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushAll();
      out.push("<hr/>");
      continue;
    }
    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listTag !== want) {
        flushList();
        out.push(`<${want}>`);
        listTag = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    if (t === "") {
      flushAll();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return out.join("\n");
}
