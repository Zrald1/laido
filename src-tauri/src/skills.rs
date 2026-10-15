use crate::agent;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Serialize, Clone)]
struct Activity {
    text: String,
}

#[derive(Serialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub runs: u32,
    pub steps: Vec<String>,
    /// words/questions that should make the AI reach for this skill
    pub triggers: Vec<String>,
    /// free-form knowledge + examples the AI recalls verbatim — ratios,
    /// rules, Q→A pairs (the "## Knowledge" / "## Examples" body)
    pub body: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn skills_dir() -> PathBuf {
    crate::vault::vault_root().join("skills")
}

const DEFAULTS: &[(&str, &str, &[&str])] = &[
    (
        "add-summary",
        "Summarize the current note",
        &["summary"],
    ),
    (
        "daily-brief",
        "Generate the morning brief from the last 24 hours of notes",
        &["brief"],
    ),
    (
        "weekly-review",
        "Summarize the week and suggest the next focus",
        &["review"],
    ),
    (
        "research-brief",
        "Research a topic and turn it into a short brief",
        &[
            "@research AI industry news",
            "prompt: summarize what changed and what matters this week",
        ],
    ),
    (
        "meeting-prep",
        "Prepare for a meeting from the last few days of notes",
        &[
            "prompt: list open questions, decisions and blockers from the last 3 days",
            "remind: review the meeting prep",
        ],
    ),
    (
        "end-of-day",
        "Wrap up today and set up tomorrow",
        &[
            "prompt: summarize what I completed today and what is still open",
            "remind: plan tomorrow",
        ],
    ),
    (
        "daily-standup",
        "See what's on your plate today",
        &[
            "prompt: list open tasks, blockers and priorities from the last 3 days of notes",
            "remind: start the day",
        ],
    ),
    (
        "focus-sprint",
        "Pick the one thing that matters and start a focus block",
        &[
            "prompt: pick the single most important task right now and say why in one line",
            "remind: focus block — one task, 50 minutes",
        ],
    ),
    (
        "inbox-triage",
        "Triage messages: reply now, later, or drop",
        &["prompt: triage recent notes and messages — what needs a reply now, what can wait, what to drop"],
    ),
    (
        "second-brain",
        "Turn today's notes into lasting knowledge",
        &["prompt: extract the facts, ideas and decisions from recent notes worth keeping, as short linked notes"],
    ),
    (
        "post-meeting",
        "Extract decisions and follow-ups from a meeting",
        &[
            "prompt: from the latest meeting notes, list decisions, action items with owners, and open questions",
            "remind: send the follow-up notes",
        ],
    ),
    (
        "shutdown-ritual",
        "Close the day: one win, open loops, tomorrow's first task",
        &[
            "prompt: summarize today — one win, what is still open, and the first task for tomorrow",
            "remind: shutdown — plan tomorrow's first task",
        ],
    ),
];

pub fn seed_defaults() {
    let dir = skills_dir();
    let _ = fs::create_dir_all(&dir);
    for (name, description, steps) in DEFAULTS {
        let sdir = dir.join(name);
        let file = sdir.join("SKILL.md");
        if file.exists() {
            continue;
        }
        let _ = fs::create_dir_all(&sdir);
        let body = steps
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n");
        let md = format!("---\nname: {name}\ndescription: {description}\nruns: 0\n---\n\n{body}\n");
        let _ = fs::write(file, md);
    }
}

/// a bullet is a runnable step only when it begins with a verb dispatch()
/// knows — knowledge/example bullets in the body stay knowledge, not steps
fn is_step_line(s: &str) -> bool {
    s.starts_with("loop:")
        || s.starts_with("@research")
        || s.starts_with("! ")
        || s.starts_with("prompt:")
        || s.starts_with('?')
        || s.starts_with("remind:")
        || s == "summary"
        || s.starts_with("summary:")
        || s == "brief"
        || s == "review"
}

fn parse_skill(content: &str) -> (String, String, u32, Vec<String>, Vec<String>, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut runs = 0u32;
    let mut triggers: Vec<String> = Vec::new();
    let mut steps = Vec::new();
    let mut in_front = false;
    let mut front_done = false;
    let mut in_steps = false;
    let mut body_lines: Vec<String> = Vec::new();
    for line in content.lines() {
        let t = line.trim();
        if t == "---" {
            if in_front {
                in_front = false;
                front_done = true;
            } else if !front_done {
                in_front = true;
            }
            continue;
        }
        if in_front {
            if let Some(v) = t.strip_prefix("name:") {
                name = v.trim().to_string();
            } else if let Some(v) = t.strip_prefix("description:") {
                description = v.trim().to_string();
            } else if let Some(v) = t.strip_prefix("runs:") {
                runs = v.trim().parse().unwrap_or(0);
            } else if let Some(v) = t.strip_prefix("triggers:") {
                triggers = v
                    .split(',')
                    .map(|x| x.trim().to_string())
                    .filter(|x| !x.is_empty())
                    .collect();
            }
            continue;
        }
        // a "## Steps" (or "## Run"/"## Actions") heading starts the runnable
        // section — its lines are steps, never part of the knowledge body
        if let Some(h) = t.strip_prefix("## ") {
            let h = h.trim().to_lowercase();
            in_steps = h == "steps" || h == "run" || h == "actions";
            if in_steps {
                continue;
            }
        }
        let stripped = t
            .trim_start_matches(|c: char| {
                c.is_ascii_digit() || c == '.' || c == '-' || c == '*' || c == ')' || c == ' '
            })
            .trim();
        if in_steps {
            if !stripped.is_empty() {
                steps.push(stripped.to_string());
            }
            continue;
        }
        // outside a steps section a known-verb line is still a step (legacy
        // files have bare `- prompt:` bullets with no heading)
        if is_step_line(stripped) {
            steps.push(stripped.to_string());
            continue;
        }
        body_lines.push(line.to_string());
    }
    let body = body_lines.join("\n").trim().to_string();
    (name, description, runs, triggers, steps, body)
}

#[tauri::command]
pub fn skills_list() -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(skills_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path().join("SKILL.md");
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let (mut name, description, runs, triggers, steps, body) = parse_skill(&content);
        if name.is_empty() {
            name = entry.file_name().to_string_lossy().into_owned();
        }
        out.push(SkillInfo {
            name,
            description,
            runs,
            steps,
            triggers,
            body,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub fn skill_read(name: String) -> Result<String, String> {
    let name = crate::vault::safe_name(&name).map_err(|_| "invalid skill name".to_string())?;
    let path = skills_dir().join(name).join("SKILL.md");
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn skill_save(
    name: String,
    description: String,
    triggers: String,
    body: String,
    steps: Vec<String>,
) -> Result<(), String> {
    let name = crate::vault::safe_name(&name).map_err(|_| "invalid skill name".to_string())?;
    let dir = skills_dir().join(name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // keep the file human-readable: frontmatter, the knowledge the user
    // wrote verbatim (## When to use / ## Knowledge / ## Examples…), then
    // runnable steps under a ## Steps heading
    let mut md = format!(
        "---\nname: {name}\ndescription: {description}\nruns: 0\ntriggers: {}\n---\n",
        triggers.trim()
    );
    let know = body.trim();
    if !know.is_empty() {
        md.push_str(&format!("\n{know}\n"));
    }
    if !steps.is_empty() {
        let list = steps
            .iter()
            .map(|s| format!("- {s}"))
            .collect::<Vec<_>>()
            .join("\n");
        md.push_str(&format!("\n## Steps\n{list}\n"));
    }
    fs::write(dir.join("SKILL.md"), md).map_err(|e| e.to_string())
}

/// the skills block injected into the chat system prompt — name + when-to-use
/// + the knowledge body, so the AI recalls and applies what the user taught it
/// instead of re-deriving it (e.g. a concrete-mix recipe becomes quantities
/// on a sheet). Capped so a big skill library can't swamp the context.
pub fn skills_digest() -> String {
    const TOTAL_CAP: usize = 6000;
    const BODY_CAP: usize = 1600;
    let mut out: Vec<String> = Vec::new();
    let mut used = 0usize;
    for s in skills_list() {
        let mut line = format!("• {}", s.name);
        if !s.description.is_empty() {
            line.push_str(&format!(" — {}", s.description));
        }
        if !s.triggers.is_empty() {
            line.push_str(&format!(" — use when: {}", s.triggers.join(", ")));
        }
        let body = s.body.trim();
        if !body.is_empty() {
            let clipped: String = body.chars().take(BODY_CAP).collect();
            line.push_str(&format!(
                "\n{}{}",
                clipped,
                if body.chars().count() > BODY_CAP { " …" } else { "" }
            ));
        }
        if used + line.len() > TOTAL_CAP {
            break;
        }
        used += line.len();
        out.push(line);
    }
    out.join("\n")
}

fn bump_runs(name: &str) {
    let path = skills_dir().join(name).join("SKILL.md");
    if let Ok(content) = fs::read_to_string(&path) {
        let updated = content
            .lines()
            .map(|l| {
                if let Some(v) = l.trim().strip_prefix("runs:") {
                    format!("runs: {}", v.trim().parse::<u32>().unwrap_or(0) + 1)
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let _ = fs::write(&path, updated);
    }
}

fn dispatch(app: &AppHandle, note: &str, step: &str, quiet: bool, anchor: &str) {
    if let Some(rest) = step.strip_prefix("loop:") {
        // "loop: [n] [@target] query" — the research loop as a skill step
        let mut rest = rest.trim().to_string();
        let mut loops: Option<usize> = None;
        if let Some(m) = rest.split_once(' ') {
            if let Ok(n) = m.0.parse::<usize>() {
                loops = Some(n.clamp(1, 10));
                rest = m.1.trim().to_string();
            }
        }
        let mut target: Option<String> = None;
        if rest.starts_with('@') {
            if let Some((tok, q)) = rest.split_once(' ') {
                let cand = tok.trim_start_matches('@');
                let pseudo = ["all-files", "my-notes", "everything"];
                let known = crate::rag::rag_list().iter().any(|d| d.slug == cand);
                if pseudo.contains(&cand) || known {
                    target = Some(cand.to_string());
                    rest = q.trim().to_string();
                }
            }
        }
        if !rest.is_empty() {
            let app2 = app.clone();
            let n = note.to_string();
            let a = anchor.to_string();
            tauri::async_runtime::spawn(async move {
                let _ = crate::looprun::loop_run(app2, n, rest, loops, target, Some(a)).await;
            });
        }
    } else if let Some(topic) = step.strip_prefix("@research ") {
        agent::spawn_topics(
            app.clone(),
            note.to_string(),
            vec![topic.trim().to_string()],
            quiet,
            Some(anchor.to_string()),
        );
    } else if let Some(cmd) = step.strip_prefix("! ") {
        // a shell step saved from the terminal widget — runs confirm-gated
        // (the author chose it) and leaves the output tail as a card
        crate::term::run_skill_step(app.clone(), note.to_string(), cmd.trim().to_string(), anchor.to_string());
    } else if step.starts_with("prompt:") || step.starts_with('?') {
        let app2 = app.clone();
        let n = note.to_string();
        let s = step.to_string();
        let a = anchor.to_string();
        tauri::async_runtime::spawn(async move { agent::run_prompt(app2, n, s, quiet, Some(a)).await });
    } else if let Some(text) = step.strip_prefix("remind:") {
        let text = text.trim().to_string();
        if quiet {
            let callout = format!("> [!ai] reminder: {text}\n> (from the skill you just ran)");
            let _ = app.emit(
                "research:done",
                serde_json::json!({
                    "note": note,
                    "topic": text,
                    "callout": callout,
                    "kind": "remind",
                    "quiet": true,
                    "anchor": anchor,
                }),
            );
        } else {
            let _ = app.emit(
                "remind:fired",
                serde_json::json!({ "note": note, "text": text, "ts": now() }),
            );
            let _ = app
                .notification()
                .builder()
                .title("Laido")
                .body(format!("Reminder: {text}"))
                .show();
            let app2 = app.clone();
            let n = note.to_string();
            let s = step.to_string();
            let a = anchor.to_string();
            tauri::async_runtime::spawn(async move { agent::run_prompt(app2, n, s, quiet, Some(a)).await });
        }
    } else if step == "summary" || step.starts_with("summary:") {
        let app2 = app.clone();
        let n = note.to_string();
        let a = anchor.to_string();
        let extra = step
            .strip_prefix("summary:")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        tauri::async_runtime::spawn(async move {
            match crate::agent::note_summary(n.clone(), extra).await {
                Ok(md) => {
                    crate::vault::log_activity(&format!("📝 summarized {n}"));
                    let _ = app2.emit(
                        "research:done",
                        serde_json::json!({
                            "note": n,
                            "topic": format!("summary: {n}"),
                            "callout": md,
                            "kind": "summary",
                            "quiet": true,
                            "anchor": a,
                        }),
                    );
                }
                Err(e) => {
                    crate::vault::log_activity(&format!("✕ summary failed: {e}"));
                    let _ = app2.emit(
                        "agent:activity",
                        serde_json::json!({ "text": format!("✕ summary failed: {e}") }),
                    );
                }
            }
        });
    } else if step == "brief" {
        let app2 = app.clone();
        let n = note.to_string();
        let a = anchor.to_string();
        tauri::async_runtime::spawn(async move {
            agent::run_brief(app2, 24, "brief.laido", "morning brief", quiet, Some((n, a))).await
        });
    } else if step == "review" {
        let app2 = app.clone();
        let n = note.to_string();
        let a = anchor.to_string();
        tauri::async_runtime::spawn(async move {
            agent::run_brief(app2, 168, "review.laido", "weekly review", quiet, Some((n, a))).await
        });
    } else {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("⚡ skipped unknown skill step: {step}"),
            },
        );
    }
}

#[tauri::command]
pub fn skill_run(app: AppHandle, note: String, name: String, quiet: bool) -> Result<(), String> {
    let info = skills_list()
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| "skill not found".to_string())?;
    // skills write into the current note — refuse loudly instead of running
    // steps against a missing or stale note name (silent no-op otherwise)
    if note.trim().is_empty() {
        return Err("open a note first — skills write their results into the current note".into());
    }
    let path = crate::vault::note_path(&note)?;
    if !path.exists() {
        return Err(format!("note not found: {note} — reopen the note and try again"));
    }
    let text = format!("⚡ running skill: {} ({} steps)", info.name, info.steps.len());
    crate::vault::log_activity(&text);
    let _ = app.emit("agent:activity", Activity { text });
    bump_runs(&name);
    let anchor = format!("@skill {}", info.name);
    for step in info.steps {
        dispatch(&app, &note, &step, quiet, &anchor);
    }
    Ok(())
}

fn habits_path() -> PathBuf {
    crate::vault::vault_root()
        .join(".laido")
        .join("habits.json")
}

#[tauri::command]
pub fn habit_track(app: AppHandle, note: String, signature: String) {
    let mut map: HashMap<String, serde_json::Value> = fs::read_to_string(habits_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let entry = map
        .entry(signature.clone())
        .or_insert(serde_json::json!({ "count": 0, "proposed": false }));
    let count = entry.get("count").and_then(|c| c.as_u64()).unwrap_or(0) + 1;
    let proposed = entry.get("proposed").and_then(|p| p.as_bool()).unwrap_or(false);
    entry["count"] = serde_json::json!(count);
    if count >= 3 && !proposed {
        entry["proposed"] = serde_json::json!(true);
        let slug: String = signature
            .trim_start_matches("@research ")
            .trim()
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string();
        let slug: String = slug.chars().take(40).collect();
        let _ = app.emit(
            "skill:proposed",
            serde_json::json!({
                "note": note,
                "name": format!("research-{slug}"),
                "description": format!("Recurring research: {}", signature.trim_start_matches("@research ").trim()),
                "steps": [signature.clone()],
                "count": count,
            }),
        );
    }
    if let Some(dir) = habits_path().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(habits_path(), t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// LAIDO_VAULT is process-global — tests that set it must serialize
    static VAULT_LOCK: Mutex<()> = Mutex::new(());

    /// a knowledge skill — triggers + a Knowledge/Examples body — round-trips
    /// through save/parse and lands in the prompt digest with its knowledge
    #[test]
    fn knowledge_skill_roundtrip() {
        let _g = VAULT_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("laido-skill-{}", now()));
        std::env::set_var("LAIDO_VAULT", &tmp);
        let body = "## When to use\nUser asks for material quantities — slabs, footings, posts.\n\n## Knowledge\n- V = L × W × thickness (m³)\n- dry = V × 1.54\n- mix 1:2:4 → cement = dry/7, sand = 2·dry/7, gravel = 4·dry/7\n- bags = cement m³ × 1440 kg/m³ ÷ 50\n\n## Examples\nQ: \"concrete for a 4×5 slab 0.1 thick\" → make a sheet: V=2 m³, dry=3.08, cement≈12.7 bags".to_string();
        skill_save(
            "concrete-estimate".into(),
            "Estimate cement, sand, gravel for concrete".into(),
            "concrete, slab, footing, cement, gravel, sand".into(),
            body.clone(),
            vec![],
        )
        .unwrap();
        let md = fs::read_to_string(tmp.join("skills/concrete-estimate/SKILL.md")).unwrap();
        let (name, desc, _runs, triggers, steps, parsed_body) = parse_skill(&md);
        assert_eq!(name, "concrete-estimate");
        assert_eq!(desc, "Estimate cement, sand, gravel for concrete");
        assert_eq!(triggers.len(), 6);
        assert!(steps.is_empty(), "knowledge bullets must not become steps");
        assert!(parsed_body.contains("dry = V × 1.54"));
        assert!(parsed_body.contains("## Examples"));

        let digest = skills_digest();
        assert!(digest.contains("concrete-estimate"));
        assert!(digest.contains("use when: concrete, slab"));
        assert!(digest.contains("1440"), "knowledge must reach the prompt");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// a classic action skill still parses its steps — and stays a one-liner
    /// in the digest (no knowledge body)
    #[test]
    fn action_skill_roundtrip() {
        let _g = VAULT_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("laido-skill-a-{}", now()));
        std::env::set_var("LAIDO_VAULT", &tmp);
        skill_save(
            "morning".into(),
            "Morning brief".into(),
            "".into(),
            "".into(),
            vec!["brief".into(), "remind: start the day".into()],
        )
        .unwrap();
        let info = skills_list().into_iter().find(|s| s.name == "morning").unwrap();
        assert_eq!(info.steps, vec!["brief", "remind: start the day"]);
        assert!(info.body.is_empty());
        let digest = skills_digest();
        assert!(digest.contains("• morning — Morning brief"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
