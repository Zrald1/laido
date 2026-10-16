/* ---------- pageview — a REAL web engine embedded over a browser card ------
 * The iframe lane dies on X-Frame-Options / frame-ancestors, and the fetch
 * lane can't run JS. A child webview is the same WebView2 the app runs on —
 * any site loads, JS executes, logins persist in the app's user-data folder.
 * It's a window-level surface (not DOM): the frontend keeps it glued to the
 * card's viewport rect and hides it when the card is off-screen or gone.
 *
 * Events to the frontend:
 *   pv:nav   {id,url}      — every navigation (in-page clicks included)
 *   pv:load  {id,url,done} — page load started/finished (real loading state)
 *   pv:title {id,title}    — live document.title changes
 *   pv:dl    {id,url,path,done,ok} — download progress/finish
 *   pv:pop   {id,url}      — target=_blank / window.open request
 *
 * IMPORTANT: every command here is `async` — tauri runs sync commands on the
 * main thread, and add_child run_on_main_thread+recv would deadlock it.
 * Requires tauri's `unstable` feature for window.add_child. */

use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Webview, Wry};

static VIEWS: Mutex<Option<HashMap<String, Webview<Wry>>>> = Mutex::new(None);

fn with_views<T>(f: impl FnOnce(&mut HashMap<String, Webview<Wry>>) -> T) -> T {
    let mut g = VIEWS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

fn get(id: &str) -> Result<Webview<Wry>, String> {
    with_views(|m| m.get(id).cloned()).ok_or_else(|| "no page view for this card".to_string())
}

#[tauri::command]
pub async fn pv_open(
    app: AppHandle,
    id: String,
    url: String,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not a web url".into());
    }
    let pos = PhysicalPosition::new(x, y);
    let size = PhysicalSize::new(w.max(1), h.max(1));
    /* get-or-create races: two concurrent opens for the same id (restore
     * nav + user nav) would both miss the map and both add_child — and the
     * window rejects a duplicate label. VIEWS can't be held across
     * add_child (on_new_window takes it on the main thread → deadlock), so
     * the loser of the OPENING claim waits, then navigates the winner's
     * view — the later url wins, which is what the user sees */
    static OPENING: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
    let mut claimed = false;
    for _ in 0..100 {
        if let Some(wv) = with_views(|m| m.get(&id).cloned()) {
            wv.navigate(url.parse().map_err(|e| format!("bad url {e}"))?)
                .map_err(|e| e.to_string())?;
            wv.set_position(pos).ok();
            wv.set_size(size).ok();
            wv.show().ok();
            return Ok(());
        }
        {
            let mut g = OPENING.lock().unwrap_or_else(|e| e.into_inner());
            let s = g.get_or_insert_with(std::collections::HashSet::new);
            if s.insert(id.clone()) {
                claimed = true;
                break; // we create it
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    if !claimed {
        return Err("webview still opening".into());
    }
    struct OpeningGuard<'a>(&'a Mutex<Option<std::collections::HashSet<String>>>, String);
    impl Drop for OpeningGuard<'_> {
        fn drop(&mut self) {
            if let Some(s) = self.0.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                s.remove(&self.1);
            }
        }
    }
    let _guard = OpeningGuard(&OPENING, id.clone());
    let win = app.get_window("main").ok_or("no main window")?;
    let id2 = id.clone();
    let app2 = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        id.clone(),
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("bad url {e}"))?),
    )
    /* unpacked chrome extensions in app_data/extensions load into this
     * profile at webview creation — new tabs pick up freshly installed
     * ones, and "apply now" is a pv_close + re-open */
    .browser_extensions_enabled(true)
    .extensions_path(crate::extensions::ext_root(&app))
    /* hidden (parked) views keep playing media — note-switching must not
     * suspend a youtube/video the user is listening to */
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .on_navigation(move |u| {
        let _ = app2.emit_to("main", "pv:nav", json!({ "id": id2, "url": u.to_string() }));
        true
    })
    .on_page_load({
        let id = id.clone();
        let app = app.clone();
        move |_wv, payload| {
            let done = matches!(payload.event(), tauri::webview::PageLoadEvent::Finished);
            let _ = app.emit_to(
                "main",
                "pv:load",
                json!({ "id": id, "url": payload.url().to_string(), "done": done }),
            );
        }
    })
    .on_document_title_changed({
        let id = id.clone();
        let app = app.clone();
        move |_wv, title| {
            let _ = app.emit_to("main", "pv:title", json!({ "id": id, "title": title }));
        }
    })
    .on_new_window({
        let id = id.clone();
        let app = app.clone();
        move |u, _feats| {
            // no tabs in a card — popups land in the same engine; the
            // frontend may veto (e.g. external schemes later if needed)
            let _ = app.emit_to("main", "pv:pop", json!({ "id": id, "url": u.to_string() }));
            if let Ok(wv) = get(&id) {
                let _ = wv.navigate(u);
            }
            tauri::webview::NewWindowResponse::Deny
        }
    })
    .on_download({
        let id = id.clone();
        let app = app.clone();
        move |_wv, event| {
            use tauri::webview::DownloadEvent;
            match event {
                DownloadEvent::Requested { url, destination } => {
                    // real-browser behavior: save into the OS Downloads
                    // folder, keep the suggested filename when present
                    if let Some(dl) = dirs::download_dir() {
                        if destination.starts_with(&dl) == false {
                            if let Some(name) = destination.file_name().map(|n| n.to_owned()) {
                                *destination = dl.join(name);
                            }
                        }
                    }
                    let _ = app.emit_to(
                        "main",
                        "pv:dl",
                        json!({ "id": id, "url": url.to_string(), "done": false, "ok": true }),
                    );
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = app.emit_to(
                        "main",
                        "pv:dl",
                        json!({
                            "id": id, "url": url.to_string(), "done": true,
                            "ok": success,
                            "path": path.map(|p| p.to_string_lossy().to_string()),
                        }),
                    );
                    true
                }
                _ => true,
            }
        }
    });
    let wv = win
        .add_child(builder, pos, size)
        .map_err(|e| e.to_string())?;
    with_views(|m| m.insert(id, wv));
    Ok(())
}

#[tauri::command]
pub async fn pv_nav(id: String, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not a web url".into());
    }
    get(&id)?
        .navigate(url.parse().map_err(|e| format!("bad url {e}"))?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pv_bounds(id: String, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
    let wv = get(&id)?;
    wv.set_position(PhysicalPosition::new(x, y)).ok();
    wv.set_size(PhysicalSize::new(w.max(1), h.max(1))).ok();
    Ok(())
}

#[tauri::command]
pub async fn pv_visible(id: String, on: bool) -> Result<(), String> {
    let wv = get(&id)?;
    if on {
        wv.show().map_err(|e| e.to_string())
    } else {
        wv.hide().map_err(|e| e.to_string())
    }
}

/// live engine ids — the sound pill polls these for playing audio
#[tauri::command]
pub async fn pv_list() -> Result<Vec<String>, String> {
    Ok(with_views(|m| m.keys().cloned().collect()))
}

#[tauri::command]
pub async fn pv_close(id: String) -> Result<(), String> {
    if let Some(wv) = with_views(|m| m.remove(&id)) {
        wv.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn pv_url(id: String) -> Result<String, String> {
    Ok(get(&id)?.url().map_err(|e| e.to_string())?.to_string())
}

/// pull OS keyboard focus back into the main webview. A child view that the
/// user clicked inside keeps HWND focus until something moves it — a bare
/// DOM `.focus()` on a chat/url field then can't receive real keystrokes.
#[tauri::command]
pub async fn pv_focus_main(app: AppHandle) -> Result<(), String> {
    let wv = app.get_webview("main").ok_or("no main webview")?;
    wv.set_focus().map_err(|e| e.to_string())
}

/// eval js inside the live page — the AI's lane into the real DOM.
/// Result arrives JSON-encoded (eval_with_callback serializes it).
#[tauri::command]
pub async fn pv_eval(id: String, js: String) -> Result<String, String> {
    if js.len() > 32_000 {
        return Err("script too long".into());
    }
    let wv = get(&id)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    wv.eval_with_callback(js, move |s| {
        if let Some(tx) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(s);
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(_)) => Err("eval dropped".into()),
        Err(_) => Err("eval timed out".into()),
    }
}
