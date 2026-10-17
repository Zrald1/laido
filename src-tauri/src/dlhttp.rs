/* ---------- localhost bridge — the browser extension talks to the
 * segmented engine over plain HTTP on 127.0.0.1. A browser can't call
 * Tauri commands, so every engine op is mirrored here:
 *
 *   GET  /ping            → {"ok":true}              (is laido running)
 *   GET  /list            → [DlInfo]                 (poll/inspect)
 *   POST /dl     {url}    → enqueue → {id,...}       (extension hands
 *                                                        downloads off)
 *   POST /pause  {id}     → freeze, keep .part
 *   POST /resume {id}     → continue from the .part
 *   POST /cancel {id}     → abort + delete .part
 *   POST /open   {id}     → open the file
 *   POST /reveal {id}     → explorer /select
 *
 * Only loopback, only these routes. Caller gate: every request must
 * come from an extension context (Origin: *-extension://) or a local
 * tool (no Origin). Web pages always carry an http(s) Origin or a
 * cross-site/same-site Sec-Fetch-Site — denied. Otherwise any site the
 * user visits could /dl an exe then /open it — a drive-by chain. */
use std::io::{Read, Write};
use std::net::TcpListener;
use tauri::AppHandle;

const PORT: u16 = 47472;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let l = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                crate::pop_log(&format!("dlhttp bind :{PORT} failed: {e}"));
                return;
            }
        };
        crate::pop_log(&format!("dlhttp listening on :{PORT}"));
        for s in l.incoming() {
            if let Ok(mut s) = s {
                handle(&mut s, &app);
            }
        }
    });
}

fn handle(s: &mut std::net::TcpStream, app: &AppHandle) {
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(4)));
    let mut buf = vec![0u8; 8192];
    let n = match s.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    let mut lines = head.split("\r\n");
    let req = lines.next().unwrap_or("").to_string();
    let mut parts = req.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    /* origin gate — extension contexts and local tools only */
    let hdr = |name: &str| {
        lines
            .clone()
            .find_map(|l| {
                l.split_once(':')
                    .filter(|(k, _)| k.trim().eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.trim().to_string())
            })
            .unwrap_or_default()
    };
    let origin = hdr("Origin");
    let fetch_site = hdr("Sec-Fetch-Site");
    let web_caller = origin.starts_with("http://")
        || origin.starts_with("https://")
        || fetch_site == "cross-site"
        || fetch_site == "same-site";
    if web_caller && method != "OPTIONS" {
        respond(s, 403, r#"{"err":"extension callers only"}"#);
        return;
    }
    /* content-length for the body tail — it may not all be in this read */
    let clen: usize = lines
        .clone()
        .find_map(|l| l.strip_prefix("Content-Length:").or_else(|| l.strip_prefix("content-length:")))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);
    let body_start = head.find("\r\n\r\n").map(|i| i + 4).unwrap_or(n);
    let mut body = buf[body_start.min(n)..n].to_vec();
    while body.len() < clen.min(1_048_576) {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(m) => body.extend_from_slice(&buf[..m]),
        }
    }
    let jbody = |b: &[u8]| serde_json::from_slice::<serde_json::Value>(b).unwrap_or(serde_json::json!({}));

    if method == "OPTIONS" {
        respond(s, 204, "");
        return;
    }
    let (code, out): (u16, String) = match (method.as_str(), path.as_str()) {
        ("GET", "/ping") => (200, r#"{"ok":true}"#.into()),
        ("GET", "/list") => (
            200,
            tauri::async_runtime::block_on(crate::download::dl_list())
                .map(|v| serde_json::to_string(&v).unwrap_or("[]".into()))
                .unwrap_or_else(|e| serde_json::to_string(&e).unwrap_or_default()),
        ),
        ("POST", "/dl") => {
            let b = jbody(&body);
            let url = b.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                (400, r#"{"err":"not a web url"}"#.into())
            } else {
                match tauri::async_runtime::block_on(crate::download::dl_start(app.clone(), url, None)) {
                    Ok(v) => (200, v.to_string()),
                    Err(e) => (200, serde_json::json!({"err": e}).to_string()),
                }
            }
        }
        ("POST", "/pause") | ("POST", "/resume") | ("POST", "/cancel")
        | ("POST", "/open") | ("POST", "/reveal") => {
            let b = jbody(&body);
            let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let r = match path.as_str() {
                "/pause" => tauri::async_runtime::block_on(crate::download::dl_pause(id)),
                "/resume" => tauri::async_runtime::block_on(crate::download::dl_resume(app.clone(), id)),
                "/cancel" => tauri::async_runtime::block_on(crate::download::dl_cancel(id)),
                "/open" => tauri::async_runtime::block_on(crate::download::dl_open(id)),
                _ => tauri::async_runtime::block_on(crate::download::dl_reveal(id)),
            };
            match r {
                Ok(()) => (200, r#"{"ok":true}"#.into()),
                Err(e) => (200, serde_json::json!({"err": e}).to_string()),
            }
        }
        _ => (404, r#"{"err":"no route"}"#.into()),
    };
    respond(s, code, &out);
}

fn respond(s: &mut std::net::TcpStream, code: u16, body: &str) {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        _ => "Not Found",
    };
    let _ = s.write_all(
        format!(
            "HTTP/1.1 {code} {reason}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET,POST,OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}
