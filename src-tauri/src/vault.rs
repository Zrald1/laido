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
    safe_name(name).map_err(|_| format!("invalid note name: {name}"))?;
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

/// notes are `.laido` files; `.md` stays accepted during the migration
/// window. Must be a real file — a directory named `x.laido` (sync-tool
/// junk, a stray mkdir) would otherwise ghost into every listing.
pub(crate) fn is_note_file(path: &std::path::Path) -> bool {
    path.is_file()
        && matches!(
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
    } else {
        // non-empty overwrite → stash the outgoing version first
        maybe_snapshot(&notes_dir(), &name, &content);
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// write `key: value` into a note's frontmatter — creates the `---`
/// block if absent, replaces the row if present (dropping any `- item`
/// list rows under it). Kanban drags + property edits write through
/// this; it snapshots the outgoing content so a drop is undoable.
#[tauri::command]
pub fn vault_prop_set(note: String, key: String, value: String) -> Result<(), String> {
    let path = note_path(&note)?;
    let key = key.trim();
    let value = value.trim();
    if key.is_empty()
        || key.contains(':')
        || !key.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid property name".into());
    }
    if value.contains('\n') {
        return Err("invalid property value".into());
    }
    let md = fs::read_to_string(&path).unwrap_or_default();
    let next = prop_set_md(&md, key, value);
    maybe_snapshot(&notes_dir(), &note, &next);
    fs::write(&path, next).map_err(|e| e.to_string())
}

/// the pure text transform behind vault_prop_set — testable without a vault
fn prop_set_md(md: &str, key: &str, value: &str) -> String {
    let lines: Vec<String> = md.lines().map(|l| l.to_string()).collect();
    let trail = if md.ends_with('\n') { "\n" } else { "" };
    let clearing = value.trim().is_empty();
    let row = format!("{key}: {value}");
    if lines.first().map(|l| l.trim() == "---").unwrap_or(false) {
        let mut end = None;
        for (i, l) in lines.iter().enumerate().skip(1) {
            if l.trim() == "---" {
                end = Some(i);
                break;
            }
        }
        if let Some(e) = end {
            for i in 1..e {
                let l = &lines[i];
                if l.starts_with(|c: char| c.is_whitespace()) {
                    continue; // list items / nested lines aren't key rows
                }
                if let Some((lk, _)) = l.split_once(':') {
                    if lk.trim().eq_ignore_ascii_case(key) {
                        let mut out: Vec<String> = lines[..i].to_vec();
                        if !clearing {
                            out.push(row);
                        }
                        // drop this row's `- item` continuations either way
                        let mut j = i + 1;
                        while j < e && lines[j].trim_start().starts_with("- ") {
                            j += 1;
                        }
                        out.extend_from_slice(&lines[j..]);
                        return out.join("\n") + trail;
                    }
                }
            }
            if clearing {
                return md.to_string(); // nothing to clear
            }
            // no row yet → insert just before the closing ---
            let mut out: Vec<String> = lines[..e].to_vec();
            out.push(row);
            out.extend_from_slice(&lines[e..]);
            return out.join("\n") + trail;
        }
    }
    if clearing {
        return md.to_string();
    }
    // no frontmatter block → prepend a fresh one
    format!("---\n{row}\n---\n\n{md}")
}

/// rename a property key in every note's frontmatter — values, list
/// rows, and everything outside the top `---` block stay byte-identical.
/// Returns how many notes changed. Each write snapshots first, so a bad
/// rename is `> history`-undoable per note.
#[tauri::command]
pub fn vault_prop_rename(old: String, new: String) -> Result<u32, String> {
    let old = old.trim();
    let new = new.trim();
    let valid = |k: &str| {
        !k.is_empty()
            && !k.contains(':')
            && k.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    };
    if !valid(old) || !valid(new) {
        return Err("invalid property name".into());
    }
    let dir = notes_dir();
    let mut changed = 0u32;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_note_file(&path) {
                continue;
            }
            let Ok(md) = fs::read_to_string(&path) else { continue };
            if let Some(next) = prop_rename_md(&md, old, new) {
                let name = entry.file_name().to_string_lossy().into_owned();
                maybe_snapshot(&dir, &name, &next);
                if fs::write(&path, next).is_ok() {
                    changed += 1;
                }
            }
        }
    }
    Ok(changed)
}

/// pure transform behind vault_prop_rename — `old:` row keys at column 0
/// inside the top `---` block become `new:`. None when nothing matches.
fn prop_rename_md(md: &str, old: &str, new: &str) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return None;
    }
    let mut end = None;
    for (i, l) in lines.iter().enumerate().skip(1) {
        if l.trim() == "---" {
            end = Some(i);
            break;
        }
    }
    let e = end?; // unterminated block — treat as no frontmatter
    let mut hit = false;
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    out.push(lines[0].to_string());
    for l in &lines[1..e] {
        if l.starts_with(|c: char| c.is_whitespace()) {
            out.push(l.to_string());
            continue; // list items / nested lines can't be key rows
        }
        if let Some((k, rest)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case(old) {
                hit = true;
                out.push(format!("{new}:{rest}"));
                continue;
            }
        }
        out.push(l.to_string());
    }
    if !hit {
        return None;
    }
    out.extend(lines[e..].iter().map(|l| l.to_string()));
    let mut s = out.join("\n");
    if md.ends_with('\n') {
        s.push('\n');
    }
    Some(s)
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
    // retarget inbound [[wikilinks]] vault-wide — without this, every
    // [[old]] dies and clicking one resurrects a BLANK note under the old
    // name while the real content lives at the new one
    let _ = rename_links(&old, &base);
    Ok(base)
}

/// rewrite `[[old]]` → `[[new]]` in every note — the renamed file itself
/// may carry self-links. Each write snapshots first, so a bad rewrite is
/// `> history`-undoable per note. Returns how many notes changed.
fn rename_links(old: &str, new: &str) -> u32 {
    let dir = notes_dir();
    let mut changed = 0u32;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_note_file(&path) {
                continue;
            }
            let Ok(md) = fs::read_to_string(&path) else { continue };
            if let Some(next) = link_rename_md(&md, old, new) {
                let name = entry.file_name().to_string_lossy().into_owned();
                maybe_snapshot(&dir, &name, &next);
                if fs::write(&path, next).is_ok() {
                    changed += 1;
                }
            }
        }
    }
    changed
}

fn strip_note_ext(n: &str) -> &str {
    n.strip_suffix(".laido")
        .or_else(|| n.strip_suffix(".md"))
        .unwrap_or(n)
}

fn is_note_target(t: &str) -> bool {
    t.ends_with(".laido") || t.ends_with(".md")
}

/// pure transform behind rename_links — retargets `[[old]]`, `[[old#f]]`,
/// `[[old|alias]]`, `![[old]]` (and combinations) to `new`. A target
/// matches when it equals `old` verbatim, or carries no .laido/.md
/// extension and equals old's stem — so `[[a.md]]` is never touched by a
/// rename of `a.laido`. Escaped `\[[`, fenced code, and inline code spans
/// stay literal.
fn link_rename_md(md: &str, old: &str, new: &str) -> Option<String> {
    let old_stem = strip_note_ext(old);
    let new_stem = strip_note_ext(new);
    let mut hit = false;
    let mut fence = 0usize; // backtick run of the open fence; 0 = outside
    let mut out = String::with_capacity(md.len());
    for line in md.split_inclusive('\n') {
        let (body, nl) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        let t = body.trim_start();
        if t.starts_with("```") {
            let run = t.chars().take_while(|c| *c == '`').count();
            if fence == 0 {
                fence = run;
            } else if run >= fence {
                fence = 0;
            }
            out.push_str(body);
            out.push_str(nl);
            continue;
        }
        if fence != 0 {
            out.push_str(body);
            out.push_str(nl);
            continue;
        }
        out.push_str(&link_rename_line(body, old, old_stem, new, new_stem, &mut hit));
        out.push_str(nl);
    }
    if hit {
        Some(out)
    } else {
        None
    }
}

fn link_rename_line(
    line: &str,
    old: &str,
    old_stem: &str,
    new: &str,
    new_stem: &str,
    hit: &mut bool,
) -> String {
    let b = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    while i < b.len() {
        // inline code span — a run of n backticks skips to the next
        // equal-length run (unterminated swallows the rest of the line)
        if b[i] == b'`' {
            let mut j = i;
            while j < b.len() && b[j] == b'`' {
                j += 1;
            }
            let run = j - i;
            let mut end = b.len();
            let mut k = j;
            while k < b.len() {
                if b[k] == b'`' {
                    let mut m = k;
                    while m < b.len() && b[m] == b'`' {
                        m += 1;
                    }
                    if m - k == run {
                        end = m;
                        break;
                    }
                    k = m;
                } else {
                    k += 1;
                }
            }
            out.push_str(&line[i..end]);
            i = end;
            continue;
        }
        // an escaped char is literal — copy both bytes (ASCII backslash,
        // next char may be multibyte but pushing its first byte's slice is
        // unsafe — walk one char instead)
        if b[i] == b'\\' {
            out.push('\\');
            i += 1;
            if let Some(c) = line[i..].chars().next() {
                out.push(c);
                i += c.len_utf8();
            }
            continue;
        }
        // wikilink / embed opener — `[[` or `![[`
        let embed = b[i] == b'!' && line[i + 1..].starts_with("[[");
        let plain = b[i] == b'[' && line[i..].starts_with("[[");
        if embed || plain {
            let open = if embed { i + 3 } else { i + 2 };
            if let Some(close) = line[open..].find("]]") {
                let inner = &line[open..open + close];
                match retarget_wikilink(inner, old, old_stem, new, new_stem) {
                    Some(next_inner) => {
                        *hit = true;
                        if embed {
                            out.push('!');
                        }
                        out.push_str("[[");
                        out.push_str(&next_inner);
                        out.push_str("]]");
                        i = open + close + 2;
                        continue;
                    }
                    None => {}
                }
            }
        }
        // default: copy one char (UTF-8 safe)
        let c = line[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// the inside of `[[…]]` — `target#frag|alias`. Some(next) when the target
/// names `old`; fragments and aliases ride across untouched.
fn retarget_wikilink(
    inner: &str,
    old: &str,
    old_stem: &str,
    new: &str,
    new_stem: &str,
) -> Option<String> {
    let (head, alias) = match inner.split_once('|') {
        Some((h, a)) => (h, Some(a)),
        None => (inner, None),
    };
    let (target, frag) = match head.split_once('#') {
        Some((t, f)) => (t, Some(f)),
        None => (head, None),
    };
    let matched = target == old || (!is_note_target(target) && target == old_stem);
    if !matched {
        return None;
    }
    let mut s = String::from(if is_note_target(target) { new } else { new_stem });
    if let Some(f) = frag {
        s.push('#');
        s.push_str(f);
    }
    if let Some(a) = alias {
        s.push('|');
        s.push_str(a);
    }
    Some(s)
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

/* ---------- vault link index — backlinks, headings, tags, mentions ----------
 * One pass over every note; the frontend caches it for the links strip,
 * the Ctrl+K switcher, and graph-adjacent views. Cheap enough for small
 * vaults (the design target); rebuild on save/note-switch. */

#[derive(Serialize)]
pub struct VaultIndex {
    /// every note name, newest-modified first
    pub notes: Vec<String>,
    /// (from_note, target_stem) — every `[[target]]` or `[[target|label]]`
    pub links: Vec<(String, String)>,
    /// (note, heading-text) — `#`/`##`/`###` lines for switcher matching
    pub heads: Vec<(String, String)>,
    /// (tag, note) — `#tag` tokens not part of headings or markup
    pub tags: Vec<(String, String)>,
    /// (note, stem) — another note's title appearing as BARE text
    /// (outside `[[ ]]`) — the "unlinked mentions" feed
    pub mentions: Vec<(String, String)>,
    /// (note, key, value) — frontmatter `key: value` pairs, lists joined
    /// with ", " — the `prop:` operator + base views read these
    pub props: Vec<(String, String, String)>,
    /// (note, mtime-secs) for recents ranking
    pub modified: Vec<(String, u64)>,
    /// (note, byte-size) — the `file.size` pseudo-property for bases
    pub sizes: Vec<(String, u64)>,
    /// (note, ctime-secs) — the `file.ctime` pseudo-property
    pub created: Vec<(String, u64)>,
}

/// frontmatter `key: value` scalars out of one note's top `---` block —
/// strict grammar (single-line values + `- item` lists) matching the
/// editor's properties panel; anything richer just doesn't index
fn props_of(md: &str) -> Vec<(String, String)> {
    let mut lines = md.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return Vec::new();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    let mut pending_key: Option<String> = None;
    for line in lines {
        let t = line.trim_end();
        if t.trim() == "---" {
            break;
        }
        if t.is_empty() {
            continue;
        }
        if let Some(m) = t.trim_start().strip_prefix("- ") {
            // a list item continuing the previous bare `key:` row
            if let Some(k) = pending_key.clone() {
                if let Some(last) = out.last_mut() {
                    if last.0 == k {
                        if !last.1.is_empty() {
                            last.1.push_str(", ");
                        }
                        last.1.push_str(m.trim());
                        continue;
                    }
                }
                out.push((k, m.trim().to_string()));
            }
            continue;
        }
        let ind = t.len() - t.trim_start().len();
        if let Some((k, v)) = t.split_once(':') {
            let key = k.trim();
            if ind > 0 || key.is_empty() || !key.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                pending_key = None;
                continue; // nested map line — skip
            }
            let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
            if val.is_empty() {
                pending_key = Some(key.to_string());
            } else {
                pending_key = None;
                out.push((key.to_string(), val));
            }
        } else {
            pending_key = None;
        }
    }
    out
}

/// `[[x]]` / `[[x|y]]` targets out of one note's markdown — skips code
/// fences so `[[samples]]` inside fenced examples don't index
fn links_of(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut rest = line;
        while let Some(i) = rest.find("[[") {
            let after = &rest[i + 2..];
            match after.find("]]") {
                Some(j) => {
                    let target = after[..j].split('|').next().unwrap_or("").trim();
                    if !target.is_empty() {
                        out.push(target.to_string());
                    }
                    rest = &after[j + 2..];
                }
                None => break,
            }
        }
    }
    out
}

fn headings_of(md: &str) -> Vec<String> {
    md.lines()
        .map(|l| l.trim_start())
        .filter(|l| {
            l.starts_with("# ") || l.starts_with("## ") || l.starts_with("### ") || l.starts_with("#### ")
        })
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// `#tag` tokens — must follow whitespace/start, not be a heading marker
fn tags_of(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (li, line) in md.lines().enumerate() {
        let lt = line.trim_start();
        if lt.starts_with('#') && lt.trim_start_matches('#').starts_with(' ') {
            continue; // heading line, not a tag farm
        }
        let _ = li;
        for (i, _) in line.match_indices('#') {
            let before_ok = i == 0
                || line[..i]
                    .chars()
                    .last()
                    .map(|c| c.is_whitespace() || c == '(' || c == ',')
                    .unwrap_or(true);
            if !before_ok {
                continue;
            }
            let rest = &line[i + 1..];
            let tag: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '/')
                .collect();
            if tag.len() >= 2 && !tag.chars().all(|c| c.is_ascii_digit()) {
                out.push(tag);
            }
        }
    }
    out
}

#[tauri::command]
pub fn vault_index() -> VaultIndex {
    index_in(&notes_dir())
}

/// the scan, factored so tests pass a temp dir instead of the env-gated
/// vault path (LAIDO_VAULT races would otherwise poison parallel tests)
fn index_in(dir: &std::path::Path) -> VaultIndex {
    let mut notes: Vec<(String, u64, u64, u64)> = Vec::new();
    let mut bodies: Vec<(String, String)> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_note_file(&path) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = entry.metadata().ok();
            let mt = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let sz = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let ct = meta
                .as_ref()
                .and_then(|m| m.created().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            notes.push((name.clone(), mt, sz, ct));
            if let Ok(c) = fs::read_to_string(&path) {
                bodies.push((name, c));
            }
        }
    }
    notes.sort_by(|a, b| b.1.cmp(&a.1));
    let sizes: Vec<(String, u64)> = notes.iter().map(|(n, _, s, _)| (n.clone(), *s)).collect();
    let created: Vec<(String, u64)> = notes.iter().map(|(n, _, _, c)| (n.clone(), *c)).collect();

    let stems: Vec<String> = bodies
        .iter()
        .map(|(n, _)| n.trim_end_matches(".laido").trim_end_matches(".md").to_string())
        .collect();
    let mut links = Vec::new();
    let mut heads = Vec::new();
    let mut tags = Vec::new();
    let mut mentions = Vec::new();
    let mut props = Vec::new();
    for (name, md) in &bodies {
        for (k, v) in props_of(md) {
            props.push((name.clone(), k, v));
        }
        for t in links_of(md) {
            links.push((name.clone(), t));
        }
        for h in headings_of(md) {
            heads.push((name.clone(), h));
        }
        for tg in tags_of(md) {
            tags.push((tg, name.clone()));
        }
        // unlinked mentions: another note's stem as bare text (≥4 chars,
        // word-boundary-ish, not already inside [[ ]])
        let own = name
            .trim_end_matches(".laido")
            .trim_end_matches(".md");
        // unlinked mentions must be BARE text — erase whole `[[…]]` spans
        // so a real link doesn't double-count as a mention
        let mut stripped = String::with_capacity(md.len());
        {
            let mut rest = md.as_str();
            while let Some(i) = rest.find("[[") {
                stripped.push_str(&rest[..i]);
                let after = &rest[i + 2..];
                match after.find("]]") {
                    Some(j) => {
                        stripped.push(' ');
                        rest = &after[j + 2..];
                    }
                    None => {
                        stripped.push_str(after);
                        rest = "";
                    }
                }
            }
            stripped.push_str(rest);
        }
        let lowered = stripped.to_lowercase();
        for stem in &stems {
            if stem == own || stem.len() < 4 {
                continue;
            }
            if lowered.contains(&stem.to_lowercase()) {
                mentions.push((name.clone(), stem.clone()));
            }
        }
    }
    VaultIndex {
        notes: notes.iter().map(|(n, _, _, _)| n.clone()).collect(),
        links,
        heads,
        tags,
        mentions,
        props,
        modified: notes.iter().map(|(n, m, _, _)| (n.clone(), *m)).collect(),
        sizes,
        created,
    }
}

/// one content-search hit — the note, the line, and the line itself
/// (trimmed) so the palette can show snippets without opening files
#[derive(serde::Serialize)]
pub struct FindHit {
    pub note: String,
    pub line: u32,
    pub snippet: String,
}

/// `?` in the palette searches note CONTENT — every line containing the
/// query (case-insensitive) comes back as a snippet, newest notes first
#[tauri::command]
pub fn vault_find(query: String) -> Vec<FindHit> {
    find_in(&notes_dir(), &query)
}

fn find_in(dir: &std::path::Path, query: &str) -> Vec<FindHit> {
    let qt = query.trim();
    // `prop:key[=value]` — frontmatter-scoped property search: only the
    // top `---` block is scanned, so a body line like `status: x` can't
    // false-positive a property query
    if let Some(rest) = qt.strip_prefix("prop:") {
        // `prop:key`, `prop:key=v`, `prop:key!=v`, `prop:key>v`,
        // `>=`/`<=`/`==` — key ends at the first operator char.
        let rest = rest.trim();
        let ki = rest
            .find(|c| matches!(c, '=' | '!' | '<' | '>'))
            .unwrap_or(rest.len());
        let k = rest[..ki].trim().to_lowercase();
        let tail = &rest[ki..];
        let (op, raw) = if let Some(t) = tail.strip_prefix(">=") {
            (">=", t)
        } else if let Some(t) = tail.strip_prefix("<=") {
            ("<=", t)
        } else if let Some(t) = tail.strip_prefix("!=") {
            ("!=", t)
        } else if let Some(t) = tail.strip_prefix("==") {
            ("=", t)
        } else if let Some(t) = tail.strip_prefix('=') {
            ("=", t)
        } else if let Some(t) = tail.strip_prefix('>') {
            (">", t)
        } else if let Some(t) = tail.strip_prefix('<') {
            ("<", t)
        } else {
            ("", "")
        };
        let v = raw.trim().trim_matches('"').trim_matches('\'').to_lowercase();
        if k.is_empty() {
            return Vec::new();
        }
        // numeric when both sides parse, else lexical (ISO dates sort
        // correctly as strings) — mirrors the frontend propCmp
        let cmp = |got: &str| -> bool {
            let g = got.trim().to_lowercase();
            match op {
                "" => true, // bare `prop:key` = "has the property"
                "=" => {
                    // `a|b` alternates — prop:status=wip|done is an OR
                    let parts: Vec<&str> = v.split('|').map(|s| s.trim()).collect();
                    parts
                        .iter()
                        .any(|w| g == *w || g.split(',').map(|s| s.trim()).any(|s| s == *w))
                }
                "!=" => {
                    let parts: Vec<&str> = v.split('|').map(|s| s.trim()).collect();
                    !parts
                        .iter()
                        .any(|w| g == *w || g.split(',').map(|s| s.trim()).any(|s| s == *w))
                }
                _ => {
                    let gn = g.parse::<f64>();
                    let wn = v.parse::<f64>();
                    let ord = if let (Ok(a), Ok(b)) = (gn, wn) {
                        a.partial_cmp(&b)
                    } else {
                        Some(g.cmp(&v))
                    };
                    match (op, ord) {
                        (">", Some(std::cmp::Ordering::Greater)) => true,
                        ("<", Some(std::cmp::Ordering::Less)) => true,
                        (">=", Some(o)) => o != std::cmp::Ordering::Less,
                        ("<=", Some(o)) => o != std::cmp::Ordering::Greater,
                        _ => false,
                    }
                }
            }
        };
        let mut hits = Vec::new();
        let ix = index_in(dir);
        for (name, _) in &ix.modified {
            let Ok(md) = fs::read_to_string(dir.join(name)) else {
                continue;
            };
            let mut lines = md.lines();
            if lines.next().map(|l| l.trim()) != Some("---") {
                continue;
            }
            let mut cur_key: Option<String> = None;
            for (i, line) in lines.enumerate() {
                if line.trim() == "---" {
                    break;
                }
                // `- item` continuation of a bare `key:` row
                if let Some(item) = line.trim_start().strip_prefix("- ") {
                    if cur_key.as_deref() == Some(k.as_str()) {
                        let it = item.trim().trim_matches('"').trim_matches('\'');
                        if cmp(it) {
                            hits.push(FindHit {
                                note: name.clone(),
                                line: (i + 2) as u32,
                                snippet: line.trim().chars().take(160).collect(),
                            });
                            break;
                        }
                    }
                    continue;
                }
                let Some((lk, lv)) = line.split_once(':') else {
                    cur_key = None;
                    continue;
                };
                let key = lk.trim().to_lowercase();
                cur_key = Some(key.clone());
                if key != k {
                    continue;
                }
                let val = lv.trim().trim_matches('"').trim_matches('\'');
                if cmp(val) {
                    hits.push(FindHit {
                        note: name.clone(),
                        line: (i + 2) as u32,
                        snippet: line.trim().chars().take(160).collect(),
                    });
                    break;
                }
            }
        }
        return hits;
    }
    // `/pattern/` runs as a regex (case-insensitive); anything else is a
    // plain lowercase substring — the fast path for normal queries
    let re_mode = qt.len() >= 3 && qt.starts_with('/') && qt.ends_with('/');
    let re = if re_mode {
        match regex::RegexBuilder::new(&qt[1..qt.len() - 1])
            .case_insensitive(true)
            .build()
        {
            Ok(r) => Some(r),
            Err(_) => return Vec::new(), // a bad pattern finds nothing, not garbage
        }
    } else {
        None
    };
    let q = qt.to_lowercase();
    if q.len() < 2 {
        return Vec::new();
    }
    let mut hits: Vec<FindHit> = Vec::new();
    let ix = index_in(dir);
    // modified order is already newest-first — reuse it for ranking
    for (name, _) in &ix.modified {
        let Ok(md) = fs::read_to_string(dir.join(name)) else {
            continue;
        };
        for (i, raw) in md.lines().enumerate() {
            let line = raw.trim();
            let hit = match &re {
                Some(r) => r.is_match(line),
                None => line.to_lowercase().contains(&q),
            };
            if hit {
                hits.push(FindHit {
                    note: name.clone(),
                    line: (i + 1) as u32,
                    snippet: line.chars().take(160).collect(),
                });
                if hits.len() >= 60 {
                    return hits;
                }
            }
        }
    }
    hits
}

/* ---------- attachments — pasted/dropped files live beside the vault ---- */

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// save bytes (clipboard b64, or a copied source path) into
/// `attachments/img-<ts>.<ext>` and return the vault-relative path the
/// note stores as `![](attachments/img-….png)`
#[tauri::command]
pub fn asset_save(
    b64: Option<String>,
    src: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    asset_save_in(&notes_dir(), b64, src, name)
}

/// the write, factored for tests — same `index_in` pattern
fn asset_save_in(
    root: &std::path::Path,
    b64: Option<String>,
    src: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let dir = root.join("attachments");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (bytes, ext) = if let Some(s) = src {
        let p = PathBuf::from(&s);
        let bytes = fs::read(&p).map_err(|e| e.to_string())?;
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_lowercase();
        (bytes, ext)
    } else if let Some(b) = b64 {
        // accept raw b64 or a full data url — mime drives the extension
        let (mime, raw) = if let Some(rest) = b.strip_prefix("data:") {
            let (m, d) = rest.split_once(",").unwrap_or(("application/octet-stream", ""));
            (m.split(';').next().unwrap_or("").to_string(), d.to_string())
        } else {
            (name.clone().unwrap_or_default(), b)
        };
        let ext = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/svg+xml" => "svg",
            _ => "png",
        }
        .to_string();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|e| e.to_string())?;
        (bytes, ext)
    } else {
        return Err("asset_save needs b64 or src".into());
    };
    let clean_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let fname = format!("img-{}.{}", now_millis(), if clean_ext.is_empty() { "png".into() } else { clean_ext });
    fs::write(dir.join(&fname), &bytes).map_err(|e| e.to_string())?;
    Ok(format!("attachments/{fname}"))
}

/// every embeddable file under `attachments/`, vault-relative — the
/// `![[` suggester offers these alongside notes.
#[tauri::command]
pub fn asset_list() -> Vec<String> {
    asset_list_in(&notes_dir())
}

fn asset_list_in(root: &std::path::Path) -> Vec<String> {
    const IMG: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
    let dir = root.join("attachments");
    let mut out: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let ok = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| IMG.contains(&x.to_lowercase().as_str()))
                .unwrap_or(false);
            if ok {
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    out.push(format!("attachments/{name}"));
                }
            }
        }
    }
    out.sort();
    out
}

/// vault-relative file → `data:` url for <img> display. `..`/absolute
/// paths are refused — attachments stay inside the vault.
#[tauri::command]
pub fn asset_data_url(path: String) -> Result<String, String> {
    asset_data_url_in(&notes_dir(), path)
}

fn asset_data_url_in(root: &std::path::Path, path: String) -> Result<String, String> {
    use base64::Engine;
    let rel = path.trim().replace('\\', "/");
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || rel.starts_with('~') || rel.contains(':') {
        return Err("refusing path outside the vault".into());
    }
    let p = root.join(&rel);
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// the whole link index on a 3-note vault: links, headings, tags,
    /// unlinked mentions (linked text must NOT count as a mention)
    #[test]
    fn index_links_mentions_tags() {
        let tmp = std::env::temp_dir().join(format!("laido-idx-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("alpha.laido"),
            "# Alpha\nSee [[Beta]] and [[gamma|G]].\nAlso the word delta here. #proj\n",
        )
        .unwrap();
        fs::write(
            tmp.join("beta.laido"),
            "## Beta head\nRefers to alpha in prose — no brackets.\n",
        )
        .unwrap();
        fs::write(tmp.join("gamma.laido"), "# Gamma\n").unwrap();

        let ix = index_in(&tmp);
        assert_eq!(ix.notes.len(), 3);
        // alpha's two links
        assert!(ix.links.iter().any(|(f, t)| f == "alpha.laido" && t == "Beta"));
        assert!(ix.links.iter().any(|(f, t)| f == "alpha.laido" && t == "gamma"));
        // [[gamma|G]] resolves to stem "gamma", not the alias "G"
        assert!(!ix.links.iter().any(|(_, t)| t == "G"));
        // headings
        assert!(ix.heads.iter().any(|(n, h)| n == "beta.laido" && h == "Beta head"));
        // tags
        assert!(ix.tags.iter().any(|(t, n)| t == "proj" && n == "alpha.laido"));
        // mentions: beta mentions "alpha" bare → (beta.laido, alpha)
        assert!(ix.mentions.iter().any(|(n, s)| n == "beta.laido" && s == "alpha"));
        // alpha links [[Beta]] — that must NOT count as a mention of beta
        assert!(!ix.mentions.iter().any(|(n, s)| n == "alpha.laido" && s == "Beta"));
        // ...but alpha's bare "delta" doesn't match any existing stem (delta.laido missing)
        assert!(!ix.mentions.iter().any(|(_, s)| s == "delta"));

        let _ = fs::remove_dir_all(&tmp);
    }

    /// `?` content search — matching lines come back as snippets, and
    /// queries under 2 chars return nothing
    #[test]
    fn find_hits_and_minlen() {
        let tmp = std::env::temp_dir().join(format!("laido-find-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("alpha.laido"),
            "# Alpha\nbuy cement and gravel\nnothing else\n",
        )
        .unwrap();
        fs::write(tmp.join("beta.laido"), "gravel pit notes\nplain\n").unwrap();

        let hits = find_in(&tmp, "gravel");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.snippet.contains("gravel")));
        assert!(hits.iter().any(|h| h.note == "alpha.laido" && h.line == 2));
        assert!(hits.iter().any(|h| h.note == "beta.laido" && h.line == 1));
        // short queries refused
        assert!(find_in(&tmp, "x").is_empty());
        assert!(find_in(&tmp, "  ").is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_regex_mode() {
        let tmp = std::env::temp_dir().join(format!("laido-findre-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.laido"),
            "call 555-1234 soon\nno digits here\n",
        )
        .unwrap();
        fs::write(tmp.join("b.laido"), "order #42 shipped\n").unwrap();

        // /re/ runs a case-insensitive regex
        let hits = find_in(&tmp, "/\\d{3}-\\d{4}/");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note, "a.laido");
        assert_eq!(hits[0].line, 1);
        // substring mode still treats slashes literally
        assert!(find_in(&tmp, "#42").iter().any(|h| h.note == "b.laido"));
        // a broken pattern finds nothing rather than garbage
        assert!(find_in(&tmp, "/[/").is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_prop_mode() {
        let tmp = std::env::temp_dir().join(format!("laido-prop-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("a.laido"),
            "---\nstatus: done\nrating: 4\n---\nbody status: wip\n",
        )
        .unwrap();
        fs::write(tmp.join("b.laido"), "status: done but only in the body\n").unwrap();
        fs::write(
            tmp.join("c.laido"),
            "---\ntags:\n  - alpha\n  - beta\n---\nx\n",
        )
        .unwrap();

        // frontmatter hit — body `status:` lines don't count
        let hits = find_in(&tmp, "prop:status=done");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note, "a.laido");
        // bare key → "has the property"
        assert_eq!(find_in(&tmp, "prop:rating").len(), 1);
        // value inside a YAML list row hits via comma-split
        assert_eq!(find_in(&tmp, "prop:tags=beta").len(), 1);
        // wrong value → nothing
        assert!(find_in(&tmp, "prop:status=wip").is_empty());
        // comparisons — numeric when both sides parse
        assert_eq!(find_in(&tmp, "prop:rating>3").len(), 1);
        assert_eq!(find_in(&tmp, "prop:rating>=4").len(), 1);
        assert!(find_in(&tmp, "prop:rating>4").is_empty());
        assert_eq!(find_in(&tmp, "prop:rating<5").len(), 1);
        // != hits notes whose property differs (key must exist)
        assert!(find_in(&tmp, "prop:status!=wip").len() == 1);
        assert!(find_in(&tmp, "prop:status!=done").is_empty());
        // `a|b` alternates — prop:status=done|wip is an OR group
        assert_eq!(find_in(&tmp, "prop:status=done|wip").len(), 1);
        assert_eq!(find_in(&tmp, "prop:tags=gamma|beta").len(), 1);
        // and props land on the index for base views
        let ix = index_in(&tmp);
        assert!(ix.props.iter().any(|(n, k, v)| n == "a.laido" && k == "status" && v == "done"));
        assert!(ix.props.iter().any(|(n, k, v)| n == "c.laido" && k == "tags" && v == "alpha, beta"));
        // sizes + created ride the index too
        assert!(ix.sizes.iter().any(|(n, s)| n == "a.laido" && *s > 0));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// prop_set_md — replace an existing row, insert into a block, create
    /// the block from nothing, and never touch body text below `---`
    #[test]
    fn prop_set_transform() {
        // replace keeps order + surrounding rows
        let md = "---\nstatus: wip\ntags:\n  - a\n  - b\n---\nbody status: wip\n";
        let out = prop_set_md(md, "status", "done");
        assert!(out.contains("status: done"));
        assert!(out.contains("tags:\n  - a\n  - b\n"));
        assert!(out.contains("body status: wip"));
        // inserting adds the row before the closing ---
        let out2 = prop_set_md(md, "due", "2025-03-04");
        assert!(out2.contains("due: 2025-03-04\n---"));
        // no block → a fresh one is prepended, body untouched
        let out3 = prop_set_md("# hi\nbody\n", "status", "done");
        assert!(out3.starts_with("---\nstatus: done\n---\n\n# hi"));
        // replacing a bare `key:` row drops its list items
        let out4 = prop_set_md("---\ntags:\n  - a\n  - b\n---\nx\n", "tags", "solo");
        assert!(out4.contains("tags: solo"));
        assert!(!out4.contains("  - a"));
        // empty value clears the key — row + list continuations go away
        let out5 = prop_set_md("---\ndue: 2025-01-01\nkeep: y\n---\nx\n", "due", "");
        assert_eq!(out5, "---\nkeep: y\n---\nx\n");
        let out6 = prop_set_md("---\ntags:\n  - a\n  - b\n---\nx\n", "tags", "");
        assert!(!out6.contains("tags:") && !out6.contains("- a"));
        // clearing a missing key / no block is a no-op
        assert_eq!(prop_set_md("---\na: 1\n---\nx\n", "due", ""), "---\na: 1\n---\nx\n");
        assert_eq!(prop_set_md("no fm\n", "due", ""), "no fm\n");
    }

    /// prop_rename_md — key rows inside `---` rename; values, list items,
    /// body text and notes without a block stay identical
    #[test]
    fn prop_rename_transform() {
        let md = "---\nstatus: wip\nstatuslog: keep\n---\nbody status: x\nstatus: body\n";
        let out = prop_rename_md(md, "status", "state").unwrap();
        assert_eq!(out, "---\nstate: wip\nstatuslog: keep\n---\nbody status: x\nstatus: body\n");
        // case-insensitive key match
        let out2 = prop_rename_md("---\nStatus: done\n---\nx", "status", "state").unwrap();
        assert!(out2.contains("state: done"));
        // a `key:` row keeps its following list items under the new name
        let out3 = prop_rename_md("---\ntags:\n  - a\n---\nx", "tags", "labels").unwrap();
        assert!(out3.contains("labels:\n  - a\n"));
        // no match / no block → None, no write
        assert!(prop_rename_md(md, "nope", "x").is_none());
        assert!(prop_rename_md("status: body-only\n", "status", "state").is_none());
        // unterminated block → None
        assert!(prop_rename_md("---\nstatus: x\nno close\n", "status", "state").is_none());
    }

    /// link_rename_md — every inbound form retargets; escapes, code, other
    /// stems, and explicit other-extension targets stay byte-identical
    #[test]
    fn link_rename_transform() {
        let out = link_rename_md("see [[a]] and [[a|the label]]", "a.laido", "b.laido").unwrap();
        assert_eq!(out, "see [[b]] and [[b|the label]]");
        // fragments + embeds ride across
        let out2 = link_rename_md("[[a#Sec]] ![[a]] ![[a#^blk]]", "a.laido", "b.laido").unwrap();
        assert_eq!(out2, "[[b#Sec]] ![[b]] ![[b#^blk]]");
        // an explicit-extension link retargets keeping the ext
        let out3 = link_rename_md("[[a.laido]]", "a.laido", "b.laido").unwrap();
        assert_eq!(out3, "[[b.laido]]");
        // a.md is a DIFFERENT note — renaming a.laido must not touch it
        assert!(link_rename_md("[[a.md]]", "a.laido", "b.laido").is_none());
        // a different stem doesn't collide — [[ab]] survives renaming a
        assert!(link_rename_md("[[ab]] [[a-b]]", "a.laido", "b.laido").is_none());
        // escaped \[[a]] is literal text, not a link
        assert!(link_rename_md("\\[[a]]", "a.laido", "b.laido").is_none());
        // fenced code stays literal
        let fenced = "```\n[[a]]\n```\n[[a]]\n";
        let out4 = link_rename_md(fenced, "a.laido", "b.laido").unwrap();
        assert_eq!(out4, "```\n[[a]]\n```\n[[b]]\n");
        // inline code span stays literal too
        let out5 = link_rename_md("`[[a]]` and [[a]]", "a.laido", "b.laido").unwrap();
        assert_eq!(out5, "`[[a]]` and [[b]]");
        // no match → None (no write, no snapshot)
        assert!(link_rename_md("no links here", "a.laido", "b.laido").is_none());
    }

    /// the history/snapshot entry points apply the same safe_name edge as
    /// note_path — a `../..` name can't list or read outside the vault
    #[test]
    fn history_and_snapshot_refuse_traversal() {
        assert!(vault_history("../../outside".into()).is_empty());
        assert!(vault_history("a/b".into()).is_empty());
        assert!(vault_snapshot_read("../../outside".into(), 0).is_err());
        assert!(vault_snapshot_read("x\\y".into(), 0).is_err());
        // a well-formed name still reaches the (empty) snapshot dir fine
        assert!(vault_history("never-heard.laido".into()).is_empty());
    }

    #[test]
    fn asset_list_finds_images_only() {
        let tmp = std::env::temp_dir().join(format!("laido-assetlist-{}", now_secs()));
        let dir = tmp.join("attachments");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.png"), b"x").unwrap();
        fs::write(dir.join("a.JPG"), b"x").unwrap();
        fs::write(dir.join("doc.pdf"), b"x").unwrap();
        let list = asset_list_in(&tmp);
        assert_eq!(list, vec!["attachments/a.JPG", "attachments/b.png"]);
        // no attachments dir → empty, not an error
        let tmp2 = std::env::temp_dir().join(format!("laido-assetlist2-{}", now_secs()));
        fs::create_dir_all(&tmp2).unwrap();
        assert!(asset_list_in(&tmp2).is_empty());
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&tmp2);
    }

    /// asset_save → asset_data_url round-trip, mime detection, and the
    /// traversal guard (no `..`/absolute/colon paths out of the vault)
    #[test]
    fn asset_roundtrip_and_guard() {
        let tmp = std::env::temp_dir().join(format!("laido-asset-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        // a tiny fake png (signature bytes are enough for our mime sniff)
        use base64::Engine;
        let b64png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfake");
        let rel = asset_save_in(&tmp, Some(format!("data:image/png;base64,{b64png}")), None, None)
            .unwrap();
        assert!(rel.starts_with("attachments/img-"));
        assert!(rel.ends_with(".png"));
        assert!(tmp.join(&rel).exists());
        let url = asset_data_url_in(&tmp, rel.clone()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // traversal refused
        assert!(asset_data_url_in(&tmp, "../alpha.laido".into()).is_err());
        assert!(asset_data_url_in(&tmp, "C:/x.png".into()).is_err());
        assert!(asset_data_url_in(&tmp, "~/x.png".into()).is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// agenda_in scans every note for dated `- [ ] x @YYYY-MM-DD` tasks
    /// and `sched:` flashcard lines, counting what's due as of today
    #[test]
    fn agenda_collects_tasks_and_cards() {
        let tmp = std::env::temp_dir().join(format!("laido-ag-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        let today = today_iso();
        fs::write(
            tmp.join("work.laido"),
            format!(
                "# Work\n- [ ] ship v2 @{today}\n- [x] done already @{today}\n- [ ] no date here\n- [ ] late task @2000-01-01\n"
            ),
        )
        .unwrap();
        fs::write(
            tmp.join("cards.laido"),
            format!("> [!cards] spanish\n> a :: b\n> sched: ab {today} 2.5 1 1\n> c :: d\n"),
        )
        .unwrap();
        fs::write(tmp.join("quiet.laido"), "# Quiet\nnothing\n").unwrap();

        let out = agenda_in(&tmp);
        let work = out.iter().find(|n| n.note == "work.laido").unwrap();
        assert_eq!(work.tasks.len(), 2); // open tasks only — the [x] row is skipped
        assert!(work.tasks.iter().any(|t| t.text == "ship v2" && t.due == today));
        assert!(work.tasks.iter().any(|t| t.due == "2000-01-01")); // overdue kept
        let cards = out.iter().find(|n| n.note == "cards.laido").unwrap();
        assert_eq!(cards.cards_total, 1);
        assert_eq!(cards.cards_due, 1);
        // a note with no tasks/cards doesn't appear
        assert!(!out.iter().any(|n| n.note == "quiet.laido"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// snapshots: a write stashes the old content under .history/<stem>/,
    /// throttled to ≥5min apart, and vault_history lists newest-first
    #[test]
    fn snapshot_write_and_list() {
        let tmp = std::env::temp_dir().join(format!("laido-snap-{}", now_secs()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("n.laido"), "v1 content").unwrap();
        // simulate a write: maybe_snapshot stashes "v1 content"
        maybe_snapshot(&tmp, "n.laido", "v2 content");
        let hd = snapshot_dir_for(&tmp, "n.laido");
        let snaps: Vec<_> = fs::read_dir(&hd).unwrap().flatten().collect();
        assert_eq!(snaps.len(), 1);
        assert_eq!(fs::read_to_string(snaps[0].path()).unwrap(), "v1 content");
        // a second write within the throttle window adds nothing
        fs::write(tmp.join("n.laido"), "v2 content").unwrap();
        maybe_snapshot(&tmp, "n.laido", "v3 content");
        let snaps2: Vec<_> = fs::read_dir(&hd).unwrap().flatten().collect();
        assert_eq!(snaps2.len(), 1);
        // identical content → no snapshot churn
        maybe_snapshot(&tmp, "n.laido", "v2 content");
        let snaps3: Vec<_> = fs::read_dir(&hd).unwrap().flatten().collect();
        assert_eq!(snaps3.len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/* ---------- the agenda — vault-wide due surfacing ----------
 * one scan → dated tasks (`- [ ] x @YYYY-MM-DD`) + flashcard due counts
 * (`sched: h8 ISO …`) per note. Today/overdue/upcoming all flow from it. */
#[derive(serde::Serialize)]
pub struct AgendaTask {
    pub text: String,
    pub due: String,
    pub line: u32,
}
#[derive(serde::Serialize)]
pub struct AgendaNote {
    pub note: String,
    pub tasks: Vec<AgendaTask>,
    pub cards_due: u32,
    pub cards_total: u32,
}

fn today_iso() -> String {
    // local date — sufficient precision for due checks
    let secs = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // civil-from-days (Howard Hinnant)
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", yy, m, d)
}

fn agenda_in(dir: &std::path::Path) -> Vec<AgendaNote> {
    let today = today_iso();
    let mut out: Vec<AgendaNote> = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.ends_with(".laido") || name.ends_with(".md")) {
            continue;
        }
        let Ok(md) = fs::read_to_string(e.path()) else { continue };
        let mut tasks: Vec<AgendaTask> = Vec::new();
        let mut due = 0u32;
        let mut total = 0u32;
        for (i, raw) in md.lines().enumerate() {
            let l = raw.trim().trim_start_matches('>').trim();
            // task: "- [ ] text @2025-10-15"
            if let Some(rest) = l.strip_prefix("- [ ]") {
                if let Some(at) = rest.rfind('@') {
                    let when = rest[at + 1..].trim();
                    if when.len() == 10 && when.chars().nth(4) == Some('-') {
                        tasks.push(AgendaTask {
                            text: rest[..at].trim().to_string(),
                            due: when.to_string(),
                            line: (i + 1) as u32,
                        });
                    }
                }
            }
            // flashcard state: "sched: h8 ISO ease ivl reps"
            if let Some(rest) = l.strip_prefix("sched:") {
                total += 1;
                let mut it = rest.split_whitespace();
                let _h = it.next();
                if let Some(d) = it.next() {
                    if d.len() == 10 && d <= today.as_str() {
                        due += 1;
                    }
                }
            }
        }
        if !tasks.is_empty() || due > 0 || total > 0 {
            out.push(AgendaNote { note: name, tasks, cards_due: due, cards_total: total });
        }
    }
    // notes with the most urgent work first: earliest due task wins
    out.sort_by_key(|n| {
        n.tasks
            .iter()
            .map(|t| t.due.clone())
            .min()
            .unwrap_or_else(|| "9999".into())
    });
    out
}

#[tauri::command]
pub fn vault_agenda() -> Vec<AgendaNote> {
    agenda_in(&notes_dir())
}

/* ---------- snapshots — file recovery the local-first way ----------
 * every vault_write first stashes the OLD content under
 * .history/<stem>/<unix>.laido (≥5min apart, ≤40 kept) — restores are
 * plain reads + a vault_write (which itself snapshots first). */
fn snapshot_dir_for(dir: &std::path::Path, name: &str) -> PathBuf {
    let stem = name.trim_end_matches(".laido").trim_end_matches(".md");
    dir.join(".history").join(stem)
}

fn maybe_snapshot(dir: &std::path::Path, name: &str, new: &str) {
    let p = dir.join(name);
    let Ok(old) = fs::read_to_string(&p) else { return };
    if old == new {
        return;
    }
    let hd = snapshot_dir_for(dir, name);
    // throttle: skip if a snapshot younger than 5min exists
    if let Ok(rd) = fs::read_dir(&hd) {
        let newest = rd
            .flatten()
            .filter_map(|f| f.metadata().ok()?.modified().ok())
            .max();
        if let Some(m) = newest {
            if m.elapsed().map(|e| e.as_secs() < 300).unwrap_or(false) {
                return;
            }
        }
    }
    let _ = fs::create_dir_all(&hd);
    let _ = fs::write(hd.join(format!("{}.laido", now_millis())), &old);
    // cap at 40 snapshots — drop oldest
    if let Ok(rd) = fs::read_dir(&hd) {
        let mut snaps: Vec<_> = rd.flatten().collect();
        if snaps.len() > 40 {
            snaps.sort_by_key(|f| f.file_name());
            for f in snaps.iter().take(snaps.len() - 40) {
                let _ = fs::remove_file(f.path());
            }
        }
    }
}

#[derive(serde::Serialize)]
pub struct SnapInfo {
    pub ts: u128,
    pub size: u64,
    pub preview: String,
}

#[tauri::command]
pub fn vault_history(name: String) -> Vec<SnapInfo> {
    // same hard edge as note_path — without it a `../..` name would read
    // directory listings + first lines of files anywhere on disk
    if safe_name(&name).is_err() {
        return Vec::new();
    }
    let hd = snapshot_dir_for(&notes_dir(), &name);
    let mut out: Vec<SnapInfo> = Vec::new();
    if let Ok(rd) = fs::read_dir(&hd) {
        for f in rd.flatten() {
            let ts = f
                .file_name()
                .to_string_lossy()
                .trim_end_matches(".laido")
                .parse::<u128>()
                .unwrap_or(0);
            let md = fs::read_to_string(f.path()).unwrap_or_default();
            out.push(SnapInfo {
                ts,
                size: f.metadata().map(|m| m.len()).unwrap_or(0),
                preview: md.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(80).collect(),
            });
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

#[tauri::command]
pub fn vault_snapshot_read(name: String, ts: u128) -> Result<String, String> {
    safe_name(&name).map_err(|_| "invalid note name".to_string())?;
    let p = snapshot_dir_for(&notes_dir(), &name).join(format!("{}.laido", ts));
    fs::read_to_string(p).map_err(|e| e.to_string())
}
