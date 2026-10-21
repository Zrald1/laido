use crate::{llm, rag, state, tools, vault};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Serialize, Clone)]
pub struct Activity {
    pub text: String,
}

#[derive(Serialize, Clone)]
struct ResearchDone {
    note: String,
    topic: String,
    callout: String,
    kind: String,
    quiet: bool,
    anchor: Option<String>,
}

fn inflight() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

#[tauri::command]
pub fn agent_run(app: AppHandle, name: String, text: String, anchor: Option<String>) {
    let t = text.trim();
    let Some(rest) = t.strip_prefix("@research ") else {
        return;
    };
    let topic = rest.trim();
    if topic.is_empty() {
        return;
    }
    spawn_topics(app, name, vec![topic.to_string()], false, anchor);
}

pub fn spawn_topics(
    app: AppHandle,
    name: String,
    topics: Vec<String>,
    quiet: bool,
    anchor: Option<String>,
) {
    if topics.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for topic in topics {
            let key = format!("{name}:{topic}");
            {
                let mut set = inflight().lock().unwrap();
                if set.contains(&key) {
                    continue;
                }
                set.insert(key.clone());
            }
            research_one(&app, &name, &topic, quiet, anchor.as_deref()).await;
            inflight().lock().unwrap().remove(&key);
        }
    });
}

const SYSTEM: &str = "You are Laido, a personal research agent living inside a markdown notepad. \
Given a topic, the user's current note (which may contain AI answers already generated for them), \
local library excerpts, and web results, write a synthesis that directly informs \
or answers the topic — as long as the material genuinely needs, dense, no filler. Ground the answer in the user's own note/library context when it is relevant — \
reference it explicitly; the web is for what their notes don't already cover. If the results are mostly \
noise or off-topic, say so in one short line and give the best general answer. Cite sources inline as \
[n](url). Be concrete, no filler, no preamble. Never include your analysis, planning, reasoning, or \
thinking steps — output only the final synthesis text. Markdown links allowed, no headings. Use \
**bold** for key terms, names, and figures, and wrap the single most important phrase in ==highlights==.";

const SUMMARY_SYSTEM: &str = "You summarize the user's note for them. Write a tight summary: what \
this note is about, the key facts, decisions and numbers, and any open threads or questions — as \
long as the note genuinely needs, dense, no filler. Bullets allowed. Use **bold** for key terms and wrap the single most important line in \
==highlights==. No preamble, no headings, no analysis.";

const SUMMARY_DIGEST: &str = "Compress this section of a note into 3-4 dense bullets preserving \
every fact, name and number. No preamble.";

/// split into paragraph-aligned sections of roughly `target` chars
fn split_sections(text: &str, target: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for para in text.split("\n\n") {
        if !cur.is_empty() && cur.len() + para.len() + 2 > target {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// @summary — summarize the current note. Long notes map-reduce through
/// section digests first so nothing gets dropped.
#[tauri::command]
pub async fn note_summary(name: String, instruction: Option<String>) -> Result<String, String> {
    let path = vault::note_path(&name)?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Err("the note is empty — nothing to summarize".into());
    }
    let settings = state::load_settings();
    let mut body = text.clone();
    if text.chars().count() > 100_000 {
        let sections = split_sections(&text, 24_000);
        let mut digests: Vec<String> = Vec::new();
        for wave in sections.chunks(4) {
            let mut handles = Vec::new();
            for s in wave {
                let m = settings.model_rewrite.clone();
                let part = s.clone();
                handles.push(tauri::async_runtime::spawn(async move {
                    let digest = llm::chat_retry(&m, Some(SUMMARY_DIGEST), &part, 2000).await;
                    (part, digest)
                }));
            }
            for h in handles {
                if let Ok((raw, res)) = h.await {
                    let t = res.unwrap_or_default().trim().to_string();
                    // never drop a section: a starved digest falls back to
                    // the raw text so the summary still covers everything
                    digests.push(if t.is_empty() {
                        raw.chars().take(8000).collect::<String>()
                    } else {
                        t
                    });
                }
            }
        }
        if !digests.is_empty() {
            body = digests.join("\n\n");
        }
    }
    let extra = instruction
        .filter(|i| !i.trim().is_empty())
        .map(|i| format!("\n\nExtra instruction from the user: {i}"))
        .unwrap_or_default();
    // the only ceiling is the context window itself
    let body: String = body.chars().take(llm::PROMPT_CAP).collect();
    let prompt = format!("Note \"{name}\":\n\n{body}{extra}");
    let answer = llm::chat_retry(&settings.model_main, Some(SUMMARY_SYSTEM), &prompt, llm::MAX_REPLY).await?;
    if answer.trim().is_empty() {
        return Err("the model returned an empty summary — try again".into());
    }
    let md = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("> [!ai] summary: {name}\n{md}"))
}

const BRIEF_SYSTEM: &str = "You are Laido's brief writer. Given notes from a recent period, \
write a brief: one bullet per distinct thing that matters — what happened, open tasks or questions, \
and one suggested focus. Markdown bullets only, no headings, no preamble, no analysis. Use **bold** for key terms and \
wrap the suggested focus in ==highlights==.";

const ASK_SYSTEM: &str = "You are Laido, a personal assistant inside a markdown notepad. Answer the \
user's question using the recent notes as context when useful — as long as the question genuinely \
needs, dense, no filler. Cite sources inline as \
[n](url) when provided. Markdown links allowed — no headings, no preamble, no analysis. Use **bold** \
for key terms and wrap the single most important phrase in ==highlights==.";

const PROMPT_SYSTEM: &str = "You are Laido, a personal assistant inside a markdown notepad. Execute the \
user's scheduled instruction using the recent notes as context. Output tight markdown bullets or \
paragraphs — as long as the task genuinely needs. No preamble, no analysis. Use **bold** for key terms and \
==highlight== the most important one.";

pub async fn run_brief(
    app: AppHandle,
    hours: u64,
    file: &str,
    title: &str,
    quiet: bool,
    inline: Option<(String, String)>,
) {
    let notes = crate::vault::recent_notes(hours);
    let mut ctx = String::new();
    for (name, content) in notes.iter().take(60) {
        let trimmed: String = content.chars().take(8000).collect();
        ctx.push_str(&format!("## {name}\n{trimmed}\n\n"));
    }
    if ctx.trim().is_empty() {
        ctx = "(no notes written recently)".into();
    }
    let model = state::load_settings().model_main;
    let prompt = format!("Notes from the recent period:\n\n{ctx}");
    let answer = match llm::chat_retry(&model, Some(BRIEF_SYSTEM), &prompt, llm::MAX_REPLY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ {title} failed: {e}"),
                },
            );
            return;
        }
    };
    let date = chrono::Local::now().format("%a %b %d, %H:%M").to_string();
    let md = format!("# {title} — {date}\n\n{answer}\n");
    if let Err(e) = crate::vault::write_note(file, &md) {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("✕ {title} write failed: {e}"),
            },
        );
        return;
    }
    if let Some((note, anchor)) = inline {
        let body = answer
            .trim()
            .lines()
            .map(|l| format!("> {l}"))
            .collect::<Vec<_>>()
            .join("\n");
        let callout = format!("> [!ai] {title}: {date}\n{body}");
        let _ = app.emit(
            "research:done",
            ResearchDone {
                note,
                topic: title.to_string(),
                callout,
                kind: if file == "review.laido" { "review".into() } else { "brief".into() },
                quiet,
                anchor: Some(anchor),
            },
        );
    } else {
        let _ = app.emit("brief:done", serde_json::json!({ "name": file, "quiet": quiet }));
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("✓ {title} delivered → {file}"),
            },
        );
    }
    if !quiet {
        let _ = app
            .notification()
            .builder()
            .title("Laido")
            .body(format!("✓ {title} ready → {file}"))
            .show();
    }
}

pub async fn run_prompt(
    app: AppHandle,
    note: String,
    action: String,
    quiet: bool,
    anchor: Option<String>,
) {
    let is_ask = action.starts_with('?');
    let text = action
        .trim_start_matches('?')
        .trim_start_matches("prompt:")
        .trim()
        .to_string();
    if text.is_empty() {
        return;
    }
    let notes = crate::vault::recent_notes(48);
    let mut ctx = String::new();
    for (name, content) in notes.iter().take(60) {
        if name == &note {
            continue;
        }
        let trimmed: String = content.chars().take(8000).collect();
        ctx.push_str(&format!("## {name}\n{trimmed}\n\n"));
    }
    let settings = state::load_settings();
    let model = if is_ask {
        settings.model_deep
    } else {
        settings.model_main
    };
    let system = if is_ask { ASK_SYSTEM } else { PROMPT_SYSTEM };
    // user-taught skills apply here too — a "how much cement for…" prompt
    // should use the recipe they saved, not a generic guess
    let mut sys = system.to_string();
    let skills = crate::skills::skills_digest();
    if !skills.is_empty() {
        sys.push_str("\n\nUSER'S SAVED SKILLS — knowledge the user taught you. When the instruction matches a skill's \"use when\", APPLY its knowledge and examples directly:\n");
        sys.push_str(&skills);
    }
    let prompt = format!("Instruction: {text}\n\nRecent notes:\n{ctx}");
    let answer = match llm::chat_retry(&model, Some(&sys), &prompt, llm::MAX_REPLY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ scheduled task failed: {e}"),
                },
            );
            return;
        }
    };
    let label = if is_ask { "answer" } else { "scheduled" };
    let body = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    let callout = format!("> [!ai] {label}: {text}\n{body}");
    let _ = app.emit(
        "research:done",
        ResearchDone {
            note: note.clone(),
            topic: text.clone(),
            callout,
            kind: if is_ask { "ask".into() } else { "scheduled".into() },
            quiet,
            anchor,
        },
    );
    if !quiet {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("✓ {label} delivered → {note}"),
            },
        );
    }
    if !quiet && !action.starts_with("remind:") {
        let _ = app
            .notification()
            .builder()
            .title("Laido")
            .body(format!("✓ {label} ready — {note}"))
            .show();
    }
}

async fn research_one(
    app: &AppHandle,
    name: &str,
    topic: &str,
    quiet: bool,
    anchor: Option<&str>,
) {
    // "@research @<file> <topic>" scopes local retrieval to one library file —
    // the @slug is stripped from the topic before web search + prompting
    let mut target: Option<String> = None;
    let mut topic_owned = topic.to_string();
    if let Some(rest) = topic.strip_prefix('@') {
        let mut it = rest.splitn(2, ' ');
        let slug = it.next().unwrap_or("").trim();
        if !slug.is_empty() {
            target = Some(slug.to_string());
            topic_owned = it
                .next()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from)
                .unwrap_or_else(|| format!("key content of {slug}"));
        }
    }
    let topic = topic_owned.as_str();
    let _ = app.emit(
        "agent:activity",
        Activity {
            text: format!("🔎 researching “{topic}”"),
        },
    );

    // local context first: the note itself (its AI callouts are the user's
    // generated answers) plus the top local-library excerpts — the names and
    // terms they carry sharpen the web query below
    let note_md = vault::note_path(name)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let note_excerpt: String = note_md.chars().take(60_000).collect();
    let local = rag::rag_search(topic, 5, target.as_deref()).await.join("\n\n");

    let settings = state::load_settings();
    let search_q = rag::web_query(&settings.model_rewrite, topic, &local).await;
    let hits = match tools::search(&search_q, 5, Some(name)).await {
        Ok(h) => h,
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ research failed: {e}"),
                },
            );
            return;
        }
    };

    let context = hits
        .iter()
        .enumerate()
        .map(|(i, h)| format!("[{}] {} — {}\n{}", i + 1, h.title, h.url, h.content))
        .collect::<Vec<_>>()
        .join("\n\n");

    let prompt = format!(
        "Topic: {topic}\n\n\
         Current note (the user's own notes, including AI answers so far):\n{note_excerpt}\n\n\
         Local library excerpts:\n{local}\n\n\
         Web results:\n{context}"
    );
    let answer = match llm::chat_retry(&settings.model_main, Some(SYSTEM), &prompt, llm::MAX_REPLY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ synthesis failed: {e}"),
                },
            );
            return;
        }
    };

    let sources = hits
        .iter()
        .take(3)
        .map(|h| format!("[{}]({})", h.title.replace(['[', ']'], ""), h.url))
        .collect::<Vec<_>>()
        .join(" · ");
    let body = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    let callout = format!("> [!ai] research: {topic}\n{body}\n> Sources: {sources}");

    let _ = app.emit(
        "research:done",
        ResearchDone {
            note: name.into(),
            topic: topic.into(),
            callout,
            kind: "research".into(),
            quiet,
            anchor: anchor.map(str::to_string),
        },
    );
    let _ = app.emit(
        "agent:activity",
        Activity {
            text: format!("✓ research delivered → {name}"),
        },
    );
}
