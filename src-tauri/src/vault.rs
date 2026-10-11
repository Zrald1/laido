use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn vault_root() -> PathBuf {
    if let Ok(p) = std::env::var("LAIDO_VAULT") {
        return PathBuf::from(p);
    }
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Laido")
}

pub fn notes_dir() -> PathBuf {
    vault_root().join("notes")
}

pub fn recent_notes(hours: u64) -> Vec<(String, String)> {
    let cutoff = SystemTime::now() - std::time::Duration::from_secs(hours * 3600);
    let mut out: Vec<(u64, String, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(notes_dir()) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_note_file(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        if modified < cutoff {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let ts = modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push((ts, name, content));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, n, c)| (n, c)).collect()
}

pub fn write_note(name: &str, md: &str) -> Result<(), String> {
    fs::write(notes_dir().join(name), md).map_err(|e| e.to_string())
}

pub fn log_activity(text: &str) {
    let dir = vault_root().join(".laido");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("activity.md");
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let line = format!("- {stamp} — {text}\n");
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

const WELCOME: &str = "# Welcome to Laido\n\n\
Write anything. Laido reads, annotates, and acts on what you write.\n\n\
## Commands — press Enter at the end of the line to run them\n\n\
- `@research <topic>` — Laido researches and writes cited findings below the line\n\
- `? <question>` — a deep answer from Nemotron 3 Ultra (coming soon)\n\
- `@schedule daily 08:00 brief` — a task Laido runs for you, on time\n\
- `@skill <name>` — run a reusable skill (type `@skill ` to pick one; five ship by default)\n\n\
Pasting text is safe: commands only run when you press Enter on their line.\n\n\
## Your data\n\n\
Notes are `.laido` files — plain markdown inside, yours forever.\n\
Delete a file and Laido forgets. Copy the folder and you moved your AI's memory.\n";

pub fn ensure_vault() -> std::io::Result<()> {
    fs::create_dir_all(notes_dir())?;
    fs::create_dir_all(vault_root().join(".laido"))?;
    // one-time migration: notes become .laido files, content untouched
    let mut migrated = 0;
    if let Ok(rd) = fs::read_dir(notes_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
                continue;
            };
            let to = notes_dir().join(format!("{stem}.laido"));
            if !to.exists() && fs::rename(&p, &to).is_ok() {
                migrated += 1;
            }
        }
    }
    if migrated > 0 {
        log_activity(&format!("📄 migrated {migrated} notes to the .laido extension"));
    }
    let welcome = notes_dir().join("welcome.laido");
    if !welcome.exists() {
        fs::write(welcome, WELCOME)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct NoteInfo {
    pub name: String,
    pub modified: u64,
}

/// notes are `.laido` files; `.md` stays accepted during the migration window
pub(crate) fn is_note_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("laido") | Some("md")
    )
}

/// The hard edge of the sandbox: every path the agent reads or writes must
/// resolve inside the vault, and this is how it can't escape — a name must
/// be a single bare path component (no separators, no `..`, no drive or
/// UNC prefix, no NTFS stream `:`), so joining it under a vault directory
/// can never point outside. The ONLY way content crosses the boundary is
/// the user's explicit file pick (`rag_add_files` / `import_note` read the
/// chosen source once; nothing references it after ingest).
pub(crate) fn safe_name(name: &str) -> Result<&str, String> {
    use std::path::{Component, Path};
    let mut it = Path::new(name).components();
    let single = matches!(it.next(), Some(Component::Normal(_))) && it.next().is_none();
    if !single
        || name.is_empty()
        || name.trim() != name
        || name.contains(':')
        || name.chars().any(char::is_control)
    {
        return Err(format!("invalid name: {name:?}"));
    }
    Ok(name)
}

/// notes are `.laido` files; `.md` stays accepted so nothing breaks during
/// the migration window
pub(crate) fn note_path(name: &str) -> Result<PathBuf, String> {
    safe_name(name).map_err(|_| format!("invalid note name: {name}"))?;
    if !name.ends_with(".laido") && !name.ends_with(".md") {
        return Err(format!("invalid note name: {name}"));
    }
    Ok(notes_dir().join(name))
}

#[tauri::command]
pub fn vault_dir() -> String {
    notes_dir().display().to_string()
}

#[tauri::command]
pub fn reveal_note(name: String) -> Result<(), String> {
    let path = note_path(&name)?;
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(format!("/select,{}", path.display()));
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&path);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(&path));
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn vault_update_callout(note: String, topic: String, callout: String) -> Result<(), String> {
    let path = note_path(&note)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    let mut replaced = false;
    while i < lines.len() {
        let t = lines[i].trim();
        if !replaced && t.starts_with("> [!ai]") && t.contains(&topic) {
            out.push(callout.clone());
            i += 1;
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                i += 1;
            }
            replaced = true;
            continue;
        }
        out.push(lines[i].to_string());
        i += 1;
    }
    if !replaced {
        return Err("callout not found".into());
    }
    let mut text = out.join("\n");
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_note(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "md" | "markdown" | "txt") {
        return Err("only markdown or text files can be opened".into());
    }
    let content = fs::read_to_string(&src).map_err(|e| e.to_string())?;
    if content.len() > 2_000_000 {
        return Err("file is too large".into());
    }
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".into());
    let mut name = format!("{stem}.laido");
    let mut i = 2;
    while notes_dir().join(&name).exists() {
        if fs::read_to_string(notes_dir().join(&name)).map(|c| c == content).unwrap_or(false) {
            return Ok(name);
        }
        name = format!("{stem}-{i}.laido");
        i += 1;
    }
    fs::write(notes_dir().join(&name), content).map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
pub fn vault_list() -> Result<Vec<NoteInfo>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(notes_dir()).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !is_note_file(&path) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(NoteInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn vault_read(name: String) -> Result<String, String> {
    fs::read_to_string(note_path(&name)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write(name: String, content: String) -> Result<(), String> {
    let path = note_path(&name)?;
    if content.trim().is_empty() {
        if let Ok(old) = fs::read_to_string(&path) {
            if !old.trim().is_empty() {
                let trash = vault_root().join(".laido").join("trash");
                let _ = fs::create_dir_all(&trash);
                let stamp = std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = fs::write(trash.join(format!("{stamp}-{name}")), old);
            }
        }
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_create() -> Result<String, String> {
    for i in 1..10_000 {
        let name = format!("untitled-{i}.laido");
        let path = notes_dir().join(&name);
        if !path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
            return Ok(name);
        }
    }
    Err("too many untitled notes".into())
}

#[tauri::command]
pub fn vault_rename(old: String, next: String) -> Result<String, String> {
    let mut base = next.trim().to_string();
    if base.is_empty() {
        return Err("name cannot be empty".into());
    }
    if !base.ends_with(".laido") && !base.ends_with(".md") {
        base.push_str(".laido");
    }
    safe_name(&base).map_err(|_| "invalid name".to_string())?;
    let from = note_path(&old)?;
    let to = notes_dir().join(&base);
    if to != from && to.exists() {
        return Err("a note with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(base)
}

#[derive(Serialize)]
pub struct StickyInfo {
    pub note: String,
    pub id: String,
    pub title: String,
    pub color: String,
}

fn stickies_dir() -> PathBuf {
    vault_root().join("stickies")
}

#[tauri::command]
pub fn sticky_save(id: String, md: String) -> Result<(), String> {
    let id = safe_name(&id).map_err(|_| "invalid sticky id".to_string())?;
    let dir = stickies_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.md")), md).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sticky_read(id: String) -> Result<String, String> {
    let id = safe_name(&id).map_err(|_| "invalid sticky id".to_string())?;
    fs::read_to_string(stickies_dir().join(format!("{id}.md"))).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sticky_lift(note: String, id: String) -> Result<(), String> {
    let id = safe_name(&id).map_err(|_| "invalid sticky id".to_string())?;
    let path = note_path(&note)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let head = format!("[!sticky] {id}");
    let mut block: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    let mut lifted = false;
    while i < lines.len() {
        let stripped = lines[i].trim_start().trim_start_matches('>').trim();
        if !lifted && (stripped == head || stripped.starts_with(&format!("{head} "))) {
            block.push(lines[i].to_string());
            i += 1;
            while i < lines.len() && lines[i].trim_start().starts_with('>') {
                block.push(lines[i].to_string());
                i += 1;
            }
            lifted = true;
            continue;
        }
        out.push(lines[i].to_string());
        i += 1;
    }
    if !lifted {
        return Err("sticky not found".into());
    }
    let dir = stickies_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut md = block.join("\n");
    md.push('\n');
    fs::write(dir.join(format!("{id}.md")), md).map_err(|e| e.to_string())?;
    let mut text = out.join("\n").trim_end().to_string();
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())
}

fn parse_stickies(content: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for line in content.lines() {
        let stripped = line.trim_start().trim_start_matches('>').trim();
        let Some(rest) = stripped.strip_prefix("[!sticky]") else {
            continue;
        };
        let mut it = rest.trim().splitn(3, char::is_whitespace);
        let id = it.next().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let (mut color, mut title) = ("yellow".to_string(), String::new());
        if let Some(t2) = it.next() {
            if let Some(c) = t2.strip_prefix("color=") {
                color = c.to_string();
                title = it.next().unwrap_or("").to_string();
            } else {
                title = it.next().map_or_else(|| t2.to_string(), |t3| format!("{t2} {t3}"));
            }
        }
        out.push((id, title, color));
    }
    out
}

#[tauri::command]
pub fn vault_stickies() -> Result<Vec<StickyInfo>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(notes_dir()).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !is_note_file(&path) {
            continue;
        }
        let note = entry.file_name().to_string_lossy().into_owned();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (id, title, color) in parse_stickies(&content) {
            out.push(StickyInfo {
                note: note.clone(),
                id,
                title,
                color,
            });
        }
    }
    if let Ok(entries) = fs::read_dir(stickies_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let id = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let (title, color) = parse_stickies(&content)
                .into_iter()
                .next()
                .map(|(_, t, c)| (t, c))
                .unwrap_or_default();
            out.push(StickyInfo {
                note: String::new(),
                id,
                title,
                color,
            });
        }
    }
    out.sort_by(|a, b| a.note.cmp(&b.note).then(a.id.cmp(&b.id)));
    Ok(out)
}

#[tauri::command]
pub fn vault_insert(
    name: String,
    topic: String,
    callout: String,
    anchor: Option<String>,
) -> Result<(), String> {
    let path = note_path(&name)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let needle = format!("@research {topic}");
    let anchor = anchor
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty());
    let mut out: Vec<String> = Vec::new();
    let mut inserted = false;
    for line in &lines {
        let cleaned = line
            .trim()
            .trim_matches(|c: char| matches!(c, '*' | '=' | '`' | '>' | '\u{200b}' | '\u{feff}' | '\u{00a0}'))
            .trim();
        if !inserted && (cleaned == needle || anchor.as_deref() == Some(cleaned)) {
            // a typed command line is a receipt — the card replaces it; a
            // plain-text anchor (selection ask) keeps its line
            let is_cmd = ["@document", "@ask", "@skill", "@research", "@recall", "@tasks", "@related", "@loop", "@summary"]
                .iter()
                .any(|t| cleaned.contains(t));
            if !is_cmd {
                out.push(line.to_string());
            }
            out.push(String::new());
            out.push(callout.clone());
            inserted = true;
            continue;
        }
        out.push(line.to_string());
    }
    if !inserted {
        out.push(String::new());
        out.push(callout);
    }
    let mut text = out.join("\n");
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())
}
