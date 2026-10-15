//! the terminal widget's shell engine: an allowlist of read-only commands
//! runs without asking, everything else needs an explicit confirm from the
//! widget, a small deny list never runs at all. Output is capped, runs time
//! out, and the working folder is locked to the notes vault.
use serde::Serialize;
use serde_json::json;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Serialize)]
pub struct TermResult {
    pub ok: bool,
    pub needs_confirm: bool,
    pub output: String,
    pub code: Option<i32>,
}

#[derive(Serialize)]
pub struct TermAi {
    pub text: String,
    pub commands: Vec<String>,
    pub laido: Vec<String>,
    pub web: Vec<String>,
    pub notes: Vec<String>,
    pub send: Vec<String>,
    pub assign: Vec<String>,
    pub spawn: Vec<String>,
    pub sheet: Vec<String>,
    pub slides: Vec<String>,
    pub todo: Vec<String>,
    pub browser: Vec<String>,
    pub chart: Vec<String>,
    pub cards: Vec<String>,
    pub maps: Vec<String>,
    pub vault: Vec<String>,
}

/// commands that never run, even with confirmation
const DENY: &[&str] = &[
    "rm -rf /",
    "rm -rf ~",
    "rm -rf /*",
    "format ",
    "diskpart",
    "shutdown",
    "restart-computer",
    "reg add",
    "reg delete",
    "regedit",
    "del /f /s /q c:\\",
    "rd /s /q c:\\",
    "mkfs",
    "dd if=",
    "chmod -r 777 /",
];

/// read-only prefixes that run without confirmation
const SAFE_AUTO: &[&str] = &[
    "ls", "dir", "get-childitem", "gci", "cat", "type", "get-content", "pwd", "echo",
    "git status", "git log", "git diff", "git branch", "git show", "git remote",
    "node -v", "node --version", "npm -v", "npm --version", "npm list", "npm ls",
    "python --version", "python3 --version", "pip --version", "cargo --version",
    "rustc --version", "whoami", "date", "hostname", "where", "which", "systeminfo",
    "ipconfig", "ping ",
];

fn classify(raw: &str) -> &'static str {
    let t = raw.trim().to_lowercase();
    if t.is_empty() {
        return "deny";
    }
    if DENY.iter().any(|d| t.starts_with(d)) {
        return "deny";
    }
    if SAFE_AUTO.iter().any(|s| t == *s || t.starts_with(&format!("{s} "))) {
        return "safe";
    }
    "confirm"
}

fn vault_cwd() -> Result<PathBuf, String> {
    crate::vault::vault_root()
        .canonicalize()
        .map_err(|e| e.to_string())
}

const TIMEOUT_SECS: u64 = 30;
const OUTPUT_CAP: usize = 8_000; // chars — the tail survives the cut

fn run_shell(cmd: &str, cwd: &PathBuf) -> Result<(bool, Option<i32>, String), String> {
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", cmd]);
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut out_pipe = child.stdout.take().expect("stdout piped");
    let mut err_pipe = child.stderr.take().expect("stderr piped");
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(TIMEOUT_SECS);
    let code = loop {
        match child.try_wait() {
            Ok(Some(c)) => break c.code(),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    break Some(-1);
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let out = out_t.join().unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    let mut all = if err.trim().is_empty() {
        out
    } else {
        format!("{out}\n{err}")
    };
    if all.len() > OUTPUT_CAP {
        let cut = all.len() - OUTPUT_CAP;
        let start = all[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
        all = format!("…(trimmed)\n{}", &all[start..]);
    }
    Ok((code.map(|c| c == 0).unwrap_or(false), code, all))
}

#[tauri::command]
pub async fn term_run(cmd: String, confirm: Option<bool>) -> Result<TermResult, String> {
    let confirm = confirm.unwrap_or(false);
    let kind = classify(&cmd);
    if kind == "deny" {
        return Ok(TermResult {
            ok: false,
            needs_confirm: false,
            output: "✕ blocked — this command is never allowed in the terminal".into(),
            code: None,
        });
    }
    if kind == "confirm" && !confirm {
        return Ok(TermResult {
            ok: false,
            needs_confirm: true,
            output: String::new(),
            code: None,
        });
    }
    let cwd = vault_cwd()?;
    tauri::async_runtime::spawn_blocking(move || run_shell(&cmd, &cwd))
        .await
        .map_err(|e| e.to_string())?
        .map(|(ok, code, output)| TermResult {
            ok,
            needs_confirm: false,
            output,
            code,
        })
}

const TERM_SYSTEM: &str = "You are Laido's terminal assistant, living in a small terminal widget on the user's notepad. The working folder is the user's notes vault. You remember the whole conversation.\n\nENVIRONMENT: you run on WINDOWS — the shell is PowerShell. The aliases `dir`, `ls`, `cat`, `type`, `pwd` work, but there are NO unix tools: never emit `find`, `grep`, `/usr/bin/*`, `~/` paths, `2>/dev/null`, or unix flags — they all fail. PowerShell equivalents: list/find files → `Get-ChildItem -Recurse -Filter *.txt | Select-Object -First 20`; search text → `Select-String -Pattern \"x\" -Path *.txt`; read a file → `Get-Content file.txt`; mkdir → `New-Item -ItemType Directory -Name x`; env var → `$env:NAME`. Laido actions (research, summary, skill…) go in ```laido``` fences — never type them into the shell.\n\nMOST IMPORTANT: when the user is chatting, asking a question, or thinking out loud, just ANSWER them right here in the widget — 1-3 short lines, like handwritten note lines. Do NOT propose commands for ordinary questions.\n\nThe user's own world — never answer \"I don't have access\" or \"I'd need to search first\": you DO. Question about note CONTENT → ```notes\n<query>\n```. Question about which FILES exist → the indexed library list is already provided below — answer from it directly; for on-disk vault files → ```run\nGet-ChildItem | Select-Object -ExpandProperty Name\n```. Question about the OPEN chat widgets → the \"Other chat sessions\" list already names them — answer directly from it.\n\nQuestion about a SPECIFIC document → ```notes\n<slug> <question>\n``` — the slug is the [bracketed] name in the library list; the excerpts come back scoped to that document and you answer right here. When they want the answer saved as a card on the note → ```laido\ndocument <slug> <question>\n```.\n\nUse a tool only when it is genuinely needed:\n1. ```web\n<search query>\n```\n— fresh facts from the internet would help. Results come back to you; then answer in the widget.\n2. ```notes\n<search query>\n```\n— the user's own notes or library files would help. Excerpts come back; then answer in the widget.\n3. ```run\n<one shell command>\n```\n— a real shell action is needed. The user confirms before it runs.\n4. ```laido\n<one command>\n```\n— ONLY when the user explicitly wants a Laido action (research a topic into a card, run a skill, summarize the note, start a loop). research and loop are long and costly — propose them only when asked. These run in the app and drop result cards onto the note.\n5. Control the OTHER chats — pick exactly one:
  ```send
<chat id> <message>
``` — a plain message to an open chat (conversation only, no report-back).
  ```assign
<chat id> <task>
``` — delegate a TASK to a chat that is ALREADY OPEN (its id is listed under \"Other chat sessions\"). It does the work with its own tools and its result reports back here automatically. This is the answer to \"delegate / assign / have chat X do / send this task to chat X\".
  ```spawn
<task>
``` — ONLY to create a BRAND-NEW chat widget. One task per line; each becomes a new chat numbered under this one (1.1, 1.2…) that works and reports back. Never use spawn when the user means a chat that already exists — use assign.
Emitting the fence is the only way the action happens — if you describe it in prose the user sees nothing.

SHEETS — spreadsheet widgets live on this note (listed as sheet \"title\" in the widgets list). ```sheet``` fences read and edit them:
  ```sheet
new <rows>x<cols> <title>
``` — create a new sheet card.
  ```sheet
read <title>
``` — EVERY cell comes back as TSV, raw formulas included — always read before editing.
  ```sheet
set <title>
<REF>=<value>
<REF>=<value>
``` — write cells. A formula is a value starting with = (B2=5, C1==SUM(B2:B4)).
  ```sheet
append <title>
<cell>|<cell>|<cell>
``` — add rows; cells split by | or tab.
  ```sheet
addrow <title>
``` / ```sheet
addcol <title>
``` — grow the grid.
  ```sheet
delrow <title> <n>
``` / ```sheet
delcol <title> <A>
``` — remove a row/column.
  ```sheet
clear <title> [A1:B2]
``` — empty a range, or the whole sheet.
  ```sheet
sort <title> <A> [desc]
``` — reorder rows by a column.
  ```sheet
format <title> <range|col> <fmt>
``` — number format cells: general, n0, n2, comma, cur, pct, pct0, date, time, text.
  ```sheet
dedupe <title> <col>
``` — remove rows with duplicate values in that column.
  ```sheet
freeze <title> <r1|cA|rc|off>
``` — freeze the first row, column A, both, or neither.
  ```sheet
hide <title> <r3|cB>
``` / ```sheet
unhide <title>
``` — hide/show rows and columns.
  ```sheet
cf <title> <col> <op> <val> <#color>
``` — conditional highlight: ops >, <, >=, <=, =, !=, contains, between a,b, top N, dup; \"cf <title> <col> clear\" removes.
  ```sheet
filter <title> <col> <v1|v2>
``` — show only rows matching those values; \"filter <title> <col> off\" clears; \"filter <title>\" reports state.
  ```sheet
export <title> [path|xlsx|csv|tsv]
``` — write the sheet to a file. A bare format word saves vault-relative under exports/; a real path writes there; no arg opens a save dialog for the user.
  ```sheet
import <title> [path] [sheet=<name>]
``` — load .xlsx/.xls/.ods/.csv/.tsv data into the sheet (replaces its cells); no path opens a file dialog. If no sheet by that title exists, one is created.
  ```sheet
view <title> kanban <col>
view <title> calendar <col>
view <title> grid
``` — switch how the sheet shows itself: a kanban board grouped by that column's values, a month calendar plotted on a date column (dragging reschedules — the cell is written), or back to the grid. \"view <title>\" reports the current view.
Use the exact title from the widgets list. To answer \"what's in my sheet\" — read it, then answer from the TSV. To fill it — set cells directly; formulas calculate on their own.\n\nDECKS — presentation widgets live on this note (listed as deck \"title\" in the widgets list). ```slides``` fences build and edit them. Slide numbers are 1-based. Layouts: title, section, bullets, twocol, image, quote, bigfact, blank. Themes: light, dark, navy, forest, sunset, mono, paper, coral. Transitions: none, fade, push, wipe, zoom.\n  ```slides\nnew <title> [theme]\n``` — create a deck card on the note.\n  ```slides\noutline <title>\nlayout | field | field\nlayout | field | field\n``` — append whole slides at once. Field order: `title | T | Sub`, `section/bigfact | T | Sub`, `quote | text | by`, `image | T | img-path | caption`, `twocol | T | a ; b | c ; d`, `bullets | T | item | item ...`. THE way to make a deck: `new` then one `outline`.\n  ```slides\nread <title>\n``` — every slide's fields come back as text — always read before editing.\n  ```slides\nset <title> <n>\n# title\n## sub\n- bullet\n- bullet\n~ speaker note\n``` — replace slide n's content. Body lines also take `img: path | caption`, `bg: #hex`, `> quote`, `by: name`, `col: a ; b ;; c ; d`, `layout: <name>`.\n  ```slides\naddslide <title> [layout]\n``` / ```slides\ndelslide <title> <n>\n``` / ```slides\nduplicate <title> <n>\n``` / ```slides\nmove <title> <n> <m>\n``` / ```slides\nlayout <title> <n> <layout>\n``` / ```slides\nappend <title> <n> <bullet text>\n``` / ```slides\ntheme <title> <theme>\n``` / ```slides\ntransition <title> <fx>\n``` / ```slides\nbg <title> <n> <color>\n``` / ```slides\nnote <title> <n> <text>\n``` — structural edits, one fence each.\n  ```slides\nexport <title> [path|pptx|md]\n``` — write the deck to a real .pptx (opens in PowerPoint) or .md. Bare format word → exports/<title>.<fmt>; real path → written there; no arg → save dialog for the user.\n  ```slides\nimport <title> <path>\n``` — load a .pptx into the deck (title, bullets, notes, images, backgrounds all come through); no path opens a file dialog. Creates the deck if needed.\nWhen the user asks for a presentation, pitch deck, slides, or powerpoint — emit `new` + one `outline` fence with the full deck. Do NOT describe slides in prose; the fence IS the deck.\n\nTASKS — todo-list widgets live on this note (listed as todo \"title\" in the widgets list). ```todo``` fences manage them; task numbers are 1-based:\n  ```todo\nnew <title>\n<task text>\n<task text>\n``` — create a task list; each body line becomes a task.\n  ```todo\nadd <title> <task text> [@when]\n``` — add a task. Optional due: @today @tomorrow @+3d @fri @2026-02-10.\n  ```todo\nlist [title]\n``` — every task back as text; no title = all lists.\n  ```todo\ndone <title> <n>\n``` / ```todo\nopen <title> <n>\n``` / ```todo\ndel <title> <n>\n``` / ```todo\nclear <title>\n``` — check off, reopen, delete, clear done.\n  ```todo\ntoday\n``` — everything due today or overdue across all lists.\nWhen the user says \"remind me\", \"add to my list\", \"I need to\", \"to-do\", \"tasks\" — emit a `todo` fence, not prose.\n\nBROWSER — web pages live in browser cards on this note (listed as browser \"title\" in the widgets list). ```browser``` fences navigate them and read page text:\n  ```browser\nopen <url-or-search> [title]\n``` — spawn a browser card and navigate it. Search phrases go through DuckDuckGo.\n  ```browser\nread <title-or-url>\n``` — THE way to read a page: the card's extracted text comes back (title, headings, paragraphs). A bare url fetches without a card. Use this whenever the user asks about a website, asks you to summarize/explain/quote a page, or asks \"what does this site say\".\n  ```browser\nnavigate <title> <url>\n``` / ```browser\nback <title>\n``` / ```browser\nforward <title>\n``` / ```browser\nlist\n``` — move existing cards.\n  ```browser\nclip <title> [sel|today]\n``` — CAPTURE the page into the note: quote lines + a `— [title](url)` source link get appended (sel = the reader selection only; today = append to the daily note instead). Use this when the user wants to keep, save, remember, quote, or cite a page/passage — not just read it.\n  ```browser\nbookmark <title>\n``` — save the page as a `- [ ]` link inside bookmarks.laido.\nWhen the user pastes a url and asks about it, asks \"open X\", \"what's on X\", \"summarize this page\", or wants to keep a page on the note — emit a `browser` fence (`open` to place it, `read` to answer from it). Never claim you can't see websites — read returns the text.\n\nCHARTS — data-viz widgets live on this note (listed as chart \"title\" in the widgets list). ```chart``` fences draw them; types: bar, barh, line, area, pie, doughnut, scatter, stacked.\n  ```chart\nnew <title> [type]\nlabel | v1 | v2\nlabel | v1 | v2\n``` — create a chart card with inline data. Each `|` after the label is another series (multi-series bar/line).\n  ```chart\nset <title>\nlabel | v\n...\n``` — replace a chart's data.\n  ```chart\nsource <title> <sheet-title> <A1:B9>\n``` — bind LIVE to a sheet range: first column = labels, rest = series; edits to the sheet repaint the chart instantly.\n  ```chart\ntype <title> <type>\n``` / ```chart\nread <title>\n``` / ```chart\nunbind <title>\n``` / ```chart\nexport <title> [path.png]\n``` — switch viz, read data back, freeze a live binding to a snapshot, write a PNG.\nWhen the user asks to visualize, chart, plot, or graph data — especially numbers they just put in a sheet — emit a `chart` fence: `new` + rows for fresh data, `source` when a sheet already holds it.\n\nFLASHCARDS — spaced-repetition decks live on this note (listed as cards \"title\" in the widgets list). ```cards``` fences build and quiz them; card lines are `front :: back`:\n  ```cards\nnew <title>\nfront :: back\nfront :: back\n``` — create a deck; each body row is one card.\n  ```cards\nadd <title> [front :: back]\n``` — add cards; the row may ride the same line or come as body rows.\n  ```cards\nlist <title>\n``` / ```cards\ndue <title>\n``` / ```cards\ndel <title> <front-prefix>\n``` — inspect, see what's due, drop a card.\n  ```cards\nrate <title> <front-prefix> <again|hard|good|easy>\n``` — record a rating; scheduling is SM-2-lite (due dates land on the card rows).\nWhen the user wants to study, memorize, make quiz cards, be quizzed, or \"make cards from this note/page/sheet\" — generate `front :: back` rows yourself (pull facts from the note, a sheet's read output, or a browser read) and emit a `cards` fence.\n\nMAPS — mind-map widgets live on this note (listed as map \"title\" in the widgets list). ```map``` fences grow trees from indented `- ` bullets (2 spaces = one level deeper):\n  ```map\nnew <title>\n- root\n  - branch\n    - leaf\n``` — create a map card; each indented row is a node.\n  ```map\nadd <title>\n- new branch\n``` / ```map\nlist <title>\n``` / ```map\ndel <title> <node-prefix>\n``` / ```map\nrename <title> <prefix> -> <new text>\n``` — grow, inspect, prune, relabel.\nWhen the user wants to brainstorm, outline, break a topic down, or \"map out\" ideas — emit a `map` fence with a real tree, not prose.\n\nVAULT — you can create and read vault notes yourself with ```vault``` fences:
  ```vault
new <name>
# markdown body…
``` — write a whole note (reports, briefings, saved research).
  ```vault
append <name>
<lines>
``` / ```vault
read <name>
``` / ```vault
list
``` / ```vault
open <name>
``` — add to, read, enumerate, or open notes. Use `new` for briefing docs, study guides, FAQs, timelines, and anything the user asks you to \"write up\" or \"save as a note\" — a real file lands in the vault, not just chat text.

LINKING & DAILY NOTES — notes interlink with `[[note name]]` (click opens, missing notes auto-create); write them when relating one note to another. A bottom strip shows backlinks and bare mentions for the open note. `@today` on a line, or the `today` palette command, opens/creates the YYYY-MM-DD daily note — suggest it when the user wants to journal, log, or plan the day.\n\nWhen you see command or search output, interpret it briefly in the widget. Never propose destructive shell commands (deleting files, installing, network writes) unless the user asked for exactly that.

DELEGATED WORK: a message beginning with \"(task from chat X)\" is a task a sibling chat assigned to you — DO it now: use your tools (notes/web research, shell, laido commands) and produce the actual result in this widget. Never reply by asking the requester to send you the material — the task itself is the material. And do the task YOURSELF — do not spawn or message other chats to finish it for you.";

/// one turn of the terminal AI: the reply text plus any ```run``` / ```laido```
/// / ```web``` / ```notes``` / ```send``` proposals — the history rides as
/// real multi-turn messages
#[tauri::command]
pub async fn term_ai(
    prompt: String,
    history: Vec<serde_json::Value>,
    others: Option<String>,
    model: Option<String>,
    persona: Option<String>,
) -> Result<TermAi, String> {
    let s = crate::state::load_settings();
    let chosen = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| s.model_main.clone());
    let mut sys = TERM_SYSTEM.to_string();
    // a persona = a vault note `persona-<name>` — its body joins the
    // system prompt so the chat adopts the role (Cursor-rules-style,
    // markdown-defined)
    if let Some(p) = persona.filter(|p| !p.trim().is_empty()) {
        let slug: String = p
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        let body = std::fs::read_to_string(
            crate::vault::notes_dir().join(format!("persona-{slug}.laido")),
        )
        .unwrap_or_default();
        // the role applies even without a note — the name alone is enough
        // for the model to role-play; a persona-<name> note deepens it
        sys.push_str(&format!(
            "\n\nPERSONA — for this chat you are \"{p}\". Adopt this role and voice.{}",
            if body.trim().is_empty() { String::new() } else { format!("\n{body}") }
        ));
    }
    // the real library inventory — "what documents do I have" becomes a
    // direct answer instead of a guessed search
    let inv = crate::rag::rag_list();
    if !inv.is_empty() {
        // name plus slug — the slug is what `document`/`notes` fences target
        let names: Vec<String> = inv
            .iter()
            .take(40)
            .map(|d| format!("{} [{}]", d.name, d.slug))
            .collect();
        let extra = inv.len() - names.len();
        sys.push_str(&format!(
            "\n\nThe user's indexed library ({} document{}): {}{}",
            inv.len(),
            if inv.len() == 1 { "" } else { "s" },
            names.join(", "),
            if extra > 0 {
                format!(", …+{extra} more")
            } else {
                String::new()
            },
        ));
    }
    if let Some(o) = others.filter(|o| !o.trim().is_empty()) {
        // the other live chat widgets on this sheet — consult only if relevant
        sys.push_str("\n\nWidgets currently open on this note — chat ids are what you use in send/assign, sheet titles in ```sheet``` fences, deck titles in ```slides``` fences:\n");
        sys.push_str(&o);
    }
    // user-taught skills — the knowledge they saved (ratios, rules, examples)
    // so a request like "estimate concrete for my slab" applies THEIR recipe
    // instead of a generic guess
    let skills = crate::skills::skills_digest();
    if !skills.is_empty() {
        sys.push_str("\n\nUSER'S SAVED SKILLS — knowledge the user taught you. When the request matches a skill's \"use when\", APPLY its knowledge and examples directly — compute it, usually into a ```sheet``` fence or a short answer. Follow its examples' shape. Do not re-derive or ask for the recipe — you already have it:\n");
        sys.push_str(&skills);
    }
    let mut messages: Vec<serde_json::Value> = Vec::new();
    for m in history.iter().rev().take(10).rev() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
        if content.is_empty() {
            continue;
        }
        messages.push(json!({
            "role": if role == "assistant" { "assistant" } else { "user" },
            "content": content,
        }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));
    // 4096: a reply is text plus tool fences — 2048 truncated often enough
    // that a half-written ```sheet fence arrived as raw text (looking like
    // the AI described the widget instead of creating it)
    let reply = crate::llm::chat_messages(&chosen, Some(&sys), messages, 4096).await?;
    Ok(TermAi {
        text: strip_fences(&reply),
        commands: extract_proposals(&reply, "run"),
        laido: extract_proposals(&reply, "laido"),
        web: extract_proposals(&reply, "web"),
        notes: extract_proposals(&reply, "notes"),
        send: extract_proposals(&reply, "send"),
        assign: extract_many(&reply, &["assign", "delegate-to", "delegateto", "handoff", "hand-off"]),
        spawn: extract_many(&reply, &["spawn", "delegate", "sub-ai", "subai", "worker", "agent"]),
        sheet: extract_many(&reply, &["sheet", "table", "spreadsheet"]),
        slides: extract_many(&reply, &["slides", "deck", "powerpoint", "ppt"]),
        todo: extract_many(&reply, &["todo", "todos", "tasklist"]),
        browser: extract_many(&reply, &["browser", "browse", "webpage", "page"]),
        chart: extract_many(&reply, &["chart", "charts", "graph", "plot", "viz"]),
        cards: extract_many(&reply, &["cards", "flashcards", "quiz", "deck-cards"]),
        maps: extract_many(&reply, &["map", "mindmap", "mind-map"]),
        vault: extract_many(&reply, &["vault", "writefile", "note-write"]),
    })
}

/// web search for the terminal AI — Tavily hits as readable evidence
#[tauri::command]
pub async fn term_web(query: String) -> Result<String, String> {
    let hits = crate::tools::search(&query, 5).await?;
    if hits.is_empty() {
        return Ok("(no web results)".into());
    }
    Ok(hits
        .iter()
        .map(|h| format!("[{}] {}\n{}", h.url, h.title, h.content))
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// notes/library retrieval for the terminal AI — hybrid search excerpts
#[tauri::command]
pub async fn term_notes(query: String, target: Option<String>) -> Result<String, String> {
    let chunks = crate::rag::rag_search(&query, 6, target.as_deref()).await;
    if chunks.is_empty() {
        return Ok("(nothing found in your notes or library)".into());
    }
    Ok(chunks.join("\n"))
}

/// the visible text without the proposal fences (they became action rows)
fn strip_fences(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(a) = rest.find("```") {
        out.push_str(&rest[..a]);
        let after = &rest[a + 3..];
        let Some(b) = after.find("```") else {
            // unclosed trailing fence — a truncated reply. Its body was
            // still executed by extract_proposals; showing "```todo …" as
            // chat text would look like the AI described the tool instead
            // of running it
            rest = "";
            break;
        };
        rest = &after[b + 3..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// pull the bodies of ```<kind> … ``` fences out of a reply — the fence name
/// matches case-insensitively so "```Run" still counts
fn extract_proposals(reply: &str, kind: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = reply;
    let needle = format!("```{kind}");
    while let Some(a) = rest.to_lowercase().find(&needle) {
        let after = &rest[a + needle.len()..];
        // the fence name must end at the kind — ` ```delegate ` must not
        // swallow a ` ```delegate-to ` fence as a mangled body
        if after.starts_with(|c: char| c.is_alphanumeric() || c == '-' || c == '_') {
            rest = &after[1.min(after.len())..];
            continue;
        }
        let Some(b) = after.find("```") else {
            // truncated reply — an unclosed fence at the tail still
            // executes when its body has a real command line in it
            let body = after.trim();
            if body.contains('\n') && !body.is_empty() {
                out.push(body.to_string());
            }
            break;
        };
        let body = after[..b].trim();
        if !body.is_empty() {
            out.push(body.to_string());
        }
        rest = &after[b + 3..];
    }
    out
}

/// merge several fence names — the small models improvise on the fence label
fn extract_many(reply: &str, kinds: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for k in kinds {
        out.extend(extract_proposals(reply, k));
    }
    out
}

/// a `! <command>` step inside a skill — runs confirm-gated (the skill's
/// author already chose it) and leaves the output tail as a card trace
pub fn run_skill_step(app: tauri::AppHandle, note: String, cmd: String, anchor: String) {
    tauri::async_runtime::spawn(async move {
        let r = term_run(cmd.clone(), Some(true)).await;
        match r {
            Ok(res) => {
                let lines: Vec<&str> = res.output.lines().filter(|l| !l.trim().is_empty()).collect();
                let tail = lines
                    .iter()
                    .rev()
                    .take(6)
                    .rev()
                    .map(|l| *l)
                    .collect::<Vec<&str>>()
                    .join("\n");
                let callout = format!(
                    "> [!ai] shell: {cmd}\n> {}",
                    tail.split('\n').collect::<Vec<_>>().join("\n> ")
                );
                let _ = app.emit(
                    "research:done",
                    json!({
                        "note": note,
                        "topic": format!("shell: {cmd}"),
                        "callout": callout,
                        "kind": "rag",
                        "quiet": true,
                        "anchor": anchor,
                    }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "agent:activity",
                    serde_json::json!({ "text": format!("✕ shell step failed: {e}") }),
                );
            }
        }
    });
}
