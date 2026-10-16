/* ---------- extensions — real chrome extensions + instant userscripts -----
 * Two lanes:
 *   native:  unpacked Chrome extensions live in app_data/extensions/ and load
 *            into every page webview via the profile (builder flags). Stores:
 *            CWS detail url → update2 crx download; AMO addon url → api file.
 *            Local .crx/.xpi/.zip/folder unpack the same way.
 *   script:  userscripts ({name, matches, js, css, enabled}) stored as
 *            json files under app_data/extensions/scripts — the frontend
 *            injects them
 *            into the live page on load via pv_eval. Instant, AI-creatable,
 *            and the only lane that works on an already-open page. */

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn ext_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("extensions")
}

fn script_root(app: &AppHandle) -> PathBuf {
    ext_root(app).join("scripts")
}

fn slug(s: &str) -> String {
    let s: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

#[derive(Serialize)]
pub struct ExtInfo {
    id: String,
    name: String,
    version: String,
    desc: String,
}

#[derive(Serialize)]
pub struct ScriptInfo {
    name: String,
    enabled: bool,
    matches: Vec<String>,
    js: String,
    css: String,
}

/// crx archives are a zip after a small signed header — find the zip start.
fn zip_offset(buf: &[u8]) -> usize {
    if buf.len() > 16 && &buf[0..4] == b"Cr24" {
        let u32le = |off: usize| -> usize {
            buf.get(off..off + 4)
                .and_then(|s| s.try_into().ok())
                .map(u32::from_le_bytes)
                .unwrap_or(0) as usize
        };
        let ver = u32le(4) as u32;
        if ver == 3 {
            return 12 + u32le(8);
        }
        if ver == 2 {
            return 16 + u32le(8) + u32le(12);
        }
    }
    0
}

fn unzip_to(buf: &[u8], dest: &Path) -> Result<String, String> {
    let off = zip_offset(buf);
    let mut z = zip::ZipArchive::new(Cursor::new(&buf[off..])).map_err(|e| format!("not a zip/crx: {e}"))?;
    let mut count = 0usize;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name().map(|p| p.to_owned()) else { continue };
        let out = dest.join(rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(par) = out.parent() {
                fs::create_dir_all(par).map_err(|e| e.to_string())?;
            }
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    if count == 0 {
        return Err("archive was empty".into());
    }
    Ok(format!("{count} files"))
}

fn manifest_info(dir: &Path) -> Option<ExtInfo> {
    let m: Value = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).ok()?).ok()?;
    Some(ExtInfo {
        id: dir.file_name()?.to_string_lossy().to_string(),
        name: m["name"].as_str().unwrap_or("extension").to_string(),
        version: m["version"].as_str().unwrap_or("").to_string(),
        desc: m["description"].as_str().unwrap_or("").chars().take(120).collect(),
    })
}

#[tauri::command]
pub async fn ext_list(app: AppHandle) -> Result<Vec<ExtInfo>, String> {
    let root = ext_root(&app);
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if e.path().is_dir() && e.file_name() != "scripts" {
                if let Some(i) = manifest_info(&e.path()) {
                    out.push(i);
                }
            }
        }
    }
    Ok(out)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((a, b)) = stack.pop() {
        for e in fs::read_dir(&a).map_err(|e| e.to_string())?.flatten() {
            let t = e.file_type().map_err(|e| e.to_string())?;
            let tgt = b.join(e.file_name());
            if t.is_dir() {
                fs::create_dir_all(&tgt).map_err(|e| e.to_string())?;
                stack.push((e.path(), tgt));
            } else {
                fs::copy(e.path(), tgt).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn install_dir(app: &AppHandle, src: &Path) -> Result<String, String> {
    let info = manifest_info(src).ok_or("no manifest.json in that folder")?;
    let dest = ext_root(app).join(slug(&info.name));
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_tree(src, &dest)?;
    Ok(info.name)
}

/// install from a local path: extension folder, .crx/.xpi/.zip archive.
#[tauri::command]
pub async fn ext_install_path(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        return install_dir(&app, &p);
    }
    let buf = fs::read(&p).map_err(|e| format!("read {path}: {e}"))?;
    let tmp = ext_root(&app).join(".staging");
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    unzip_to(&buf, &tmp)?;
    let name = install_dir(&app, &tmp).or_else(|_| {
        // archive without manifest at root — keep files under the file's slug
        let s = slug(p.file_stem().and_then(|s| s.to_str()).unwrap_or("ext"));
        let dest = ext_root(&app).join(&s);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        Ok::<String, String>(s)
    })?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(name)
}

fn dl_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(6))
        .build()
        .map_err(|e| e.to_string())
}

/// install from a store page url (chrome web store detail / firefox addon)
/// or a direct .crx/.xpi/.zip link.
#[tauri::command]
pub async fn ext_install_url(app: AppHandle, url: String) -> Result<String, String> {
    let client = dl_client()?;
    let mut dl = url.clone();
    let u = url.trim_end_matches('/');
    if u.contains("chromewebstore.google.com/detail/") {
        let id = u.rsplit('/').next().unwrap_or("");
        if id.len() < 16 {
            return Err("couldn't find the extension id in that chrome store link".into());
        }
        dl = format!(
            "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx3&x=id%3D{id}%26installsource%3Dondemand%26uc"
        );
    } else if u.contains("addons.mozilla.org") && u.contains("/addon/") {
        let slug = u.split("/addon/").nth(1).and_then(|s| s.split('/').next()).unwrap_or("");
        if slug.is_empty() {
            return Err("couldn't find the addon slug in that firefox link".into());
        }
        let api: Value = client
            .get(format!("https://addons.mozilla.org/api/v5/addons/addon/{slug}/?lang=en-US"))
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| format!("bad amo reply: {e}"))?;
        dl = api["current_version"]["file"]["url"]
            .as_str()
            .ok_or("amo api didn't give a download url")?
            .to_string();
    }
    let bytes = client.get(&dl).send().await.map_err(|e| e.to_string())?;
    if !bytes.status().is_success() {
        return Err(format!("download failed: {}", bytes.status()));
    }
    let buf = bytes.bytes().await.map_err(|e| e.to_string())?;
    let tmp = ext_root(&app).join(".staging");
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    unzip_to(&buf, &tmp)?;
    let name = install_dir(&app, &tmp).or_else(|_| {
        let s = slug(u.rsplit('/').next().unwrap_or("ext"));
        let dest = ext_root(&app).join(&s);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        Ok::<String, String>(s)
    })?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(name)
}

#[tauri::command]
pub async fn ext_remove(app: AppHandle, id: String) -> Result<(), String> {
    let d = ext_root(&app).join(&id);
    if d.exists() {
        fs::remove_dir_all(&d).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------- userscript lane ---------- */

fn us_file(app: &AppHandle, name: &str) -> PathBuf {
    script_root(app).join(format!("{}.json", slug(name)))
}

fn us_read(p: &Path) -> Option<ScriptInfo> {
    let v: Value = serde_json::from_str(&fs::read_to_string(p).ok()?).ok()?;
    Some(ScriptInfo {
        name: v["name"].as_str().unwrap_or("script").to_string(),
        enabled: v["enabled"].as_bool().unwrap_or(true),
        matches: v["matches"].as_array().map(|a| {
            a.iter().filter_map(|m| m.as_str().map(String::from)).collect()
        }).unwrap_or_else(|| vec!["*://*/*".into()]),
        js: v["js"].as_str().unwrap_or("").to_string(),
        css: v["css"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub async fn us_list(app: AppHandle) -> Result<Vec<ScriptInfo>, String> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(script_root(&app)) {
        for e in rd.flatten() {
            if e.path().extension().map(|x| x == "json").unwrap_or(false) {
                if let Some(s) = us_read(&e.path()) {
                    out.push(s);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn us_save(
    app: AppHandle,
    name: String,
    js: String,
    css: String,
    matches: Vec<String>,
) -> Result<(), String> {
    fs::create_dir_all(script_root(&app)).map_err(|e| e.to_string())?;
    let prior = us_file(&app, &name);
    let enabled = us_read(&prior).map(|s| s.enabled).unwrap_or(true);
    let matches = if matches.is_empty() { vec!["*://*/*".to_string()] } else { matches };
    let v = json!({ "name": name, "enabled": enabled, "matches": matches, "js": js, "css": css });
    fs::write(prior, v.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn us_toggle(app: AppHandle, name: String, on: bool) -> Result<(), String> {
    let p = us_file(&app, &name);
    let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).map_err(|_| "no such script")?)
        .map_err(|e| e.to_string())?;
    v["enabled"] = json!(on);
    fs::write(&p, v.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn us_remove(app: AppHandle, name: String) -> Result<(), String> {
    let p = us_file(&app, &name);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// a local .js/.css/.json file → userscript. `// ==UserScript==` headers
/// (@name / @match) are honored; bare files match every page.
#[tauri::command]
pub async fn us_upload(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let text = fs::read_to_string(&p).map_err(|e| format!("read {path}: {e}"))?;
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("script").to_string();
    if p.extension().map(|e| e == "json").unwrap_or(false) {
        if let Some(s) = us_read(&p) {
            let n = s.name.clone();
            return us_save(app, s.name, s.js, s.css, s.matches).await.map(|_| n);
        }
    }
    let mut name = stem.clone();
    let mut matches: Vec<String> = Vec::new();
    for ln in text.lines().take(60) {
        let ln = ln.trim();
        if let Some(v) = ln.strip_prefix("// @name") {
            name = v.trim().to_string();
        }
        if let Some(v) = ln.strip_prefix("// @match").or_else(|| ln.strip_prefix("// @include")) {
            matches.push(v.trim().to_string());
        }
    }
    let (js, css) = if p.extension().map(|e| e == "css").unwrap_or(false) {
        (String::new(), text)
    } else {
        (text, String::new())
    };
    us_save(app, name.clone(), js, css, matches).await.map(|_| name)
}
