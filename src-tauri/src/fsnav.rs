/* fsnav — the right rail's file browser.
 *
 * Three commands + an opener:
 *   fs_roots()          — quick locations: Downloads, Documents, Desktop…
 *   fs_list(path)       — one directory level, dirs first
 *   fs_attach(path)     — what a drag-into-chat needs: text files inline,
 *                         images as base64, folders as a listing, anything
 *                         else degrades to a path reference
 *   fs_open(path)       — open in the OS default app
 *
 * Local-first threat model: this is a single-user app and the webview is
 * our own page — same trust level as vault::reveal_note. The one real
 * constraint is we never WRITE through this surface (browse + read only). */
use serde::Serialize;

#[derive(Serialize)]
pub struct FsRoot {
    label: String,
    path: String,
}

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    dir: bool,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
pub struct FsAttach {
    name: String,
    kind: String, // "text" | "image" | "path"
    text: Option<String>,
    b64: Option<String>,
    mime: Option<String>,
}

const LIST_CAP: usize = 400;
const TEXT_CAP: usize = 96 * 1024; // inline ceiling — same order as chatplus
const IMG_CAP: u64 = 12 * 1024 * 1024;

const TEXT_EXT: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "laido", "xml",
    "yaml", "yml", "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "rs",
    "toml", "ini", "cfg", "sql", "sh", "bat", "ps1", "svg", "env", "gitignore",
];
const IMG_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"];

fn ext_of(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "image/png",
    }
}

#[tauri::command]
pub fn fs_roots() -> Vec<FsRoot> {
    let mut out: Vec<FsRoot> = Vec::new();
    let mut push = |label: &str, p: Option<std::path::PathBuf>| {
        if let Some(p) = p {
            let s = p.to_string_lossy().to_string();
            if !out.iter().any(|r: &FsRoot| r.path == s) {
                out.push(FsRoot { label: label.to_string(), path: s });
            }
        }
    };
    push("Desktop", dirs::desktop_dir());
    push("Downloads", dirs::download_dir());
    push("Documents", dirs::document_dir());
    push("Pictures", dirs::picture_dir());
    push("Music", dirs::audio_dir());
    push("Videos", dirs::video_dir());
    push("Home", dirs::home_dir());
    /* the note vault — .laido files users may want to attach */
    if let Some(d) = dirs::document_dir() {
        push("Notes", Some(d.join("Laido").join("notes")));
    }
    out
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("can't open: {e}"))?;
    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsEntry> = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        /* dotfiles + system items stay out of the browser */
        if name.starts_with('.') {
            continue;
        }
        let dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let md = ent.metadata().ok();
        let size = if dir { 0 } else { md.as_ref().map(|m| m.len()).unwrap_or(0) };
        let mtime = md
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let e = FsEntry {
            name,
            path: ent.path().to_string_lossy().to_string(),
            dir,
            size,
            mtime,
        };
        if dir {
            dirs.push(e);
        } else {
            files.push(e);
        }
        if dirs.len() + files.len() >= LIST_CAP {
            break;
        }
    }
    let key = |a: &FsEntry| a.name.to_lowercase();
    dirs.sort_by_key(&key);
    files.sort_by_key(key);
    dirs.extend(files);
    Ok(dirs)
}

#[tauri::command]
pub async fn fs_attach(path: String) -> Result<FsAttach, String> {
    let p = std::path::PathBuf::from(&path);
    let md = std::fs::metadata(&p).map_err(|e| format!("can't read: {e}"))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    if md.is_dir() {
        /* folders attach as a compact listing — enough for the AI to
         * answer "which file here is the report" without 400 tool calls */
        let mut lines = vec![format!("Directory {path}")];
        if let Ok(rd) = std::fs::read_dir(&p) {
            for ent in rd.flatten().take(120) {
                let n = ent.file_name().to_string_lossy().to_string();
                let d = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
                lines.push(if d { format!("{n}/") } else { n });
            }
        }
        return Ok(FsAttach {
            name: format!("{name}/"),
            kind: "text".into(),
            text: Some(lines.join("\n")),
            b64: None,
            mime: None,
        });
    }
    let ext = ext_of(&name);
    if IMG_EXT.contains(&ext.as_str()) {
        if md.len() > IMG_CAP {
            return Err(format!("{name} is {} MB — too big to attach", md.len() / 1_048_576));
        }
        let raw = std::fs::read(&p).map_err(|e| e.to_string())?;
        use base64::Engine;
        return Ok(FsAttach {
            name,
            kind: "image".into(),
            text: None,
            b64: Some(base64::engine::general_purpose::STANDARD.encode(raw)),
            mime: Some(mime_of(&ext).into()),
        });
    }
    if TEXT_EXT.contains(&ext.as_str()) || md.len() < 8 * 1024 {
        let raw = std::fs::read(&p).map_err(|e| e.to_string())?;
        match String::from_utf8(raw) {
            Ok(mut s) => {
                if s.len() > TEXT_CAP {
                    s.truncate(TEXT_CAP);
                    s.push_str("\n… [truncated]");
                }
                return Ok(FsAttach {
                    name,
                    kind: "text".into(),
                    text: Some(s),
                    b64: None,
                    mime: None,
                });
            }
            Err(e) => {
                if md.len() < 8 * 1024 {
                    return Err(format!("{name} isn't text — {}", e.utf8_error()));
                }
            }
        }
    }
    /* binary we can't inline — still attach a reference so the prompt
     * carries "the file at this path" (sheet/pdf/zip get real handling
     * through the library path anyway) */
    Ok(FsAttach {
        name,
        kind: "text".into(),
        text: Some(format!(
            "file: {path} ({} KB, .{ext}) — binary, not inlined",
            md.len() / 1024
        )),
        b64: None,
        mime: None,
    })
}

#[tauri::command]
pub fn fs_open(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}
