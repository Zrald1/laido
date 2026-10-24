#![windows_subsystem = "windows"]

mod account;
mod agent;
mod dlhttp;
mod download;
mod extensions;
mod fsnav;
mod imgpdf;
mod llm;
mod looprun;
mod pageview;
mod rag;
mod scheduler;
mod skills;
mod state;
mod term;
mod tools;
mod vault;
mod voice;
mod xfer;

#[cfg(test)]
mod sim_tests;

/// a .laido path passed on the command line (double-click / open-with) —
/// resolved to a note name when it lives inside the vault sandbox
fn pending_note_from_args() -> Option<String> {
    let arg = std::env::args().nth(1)?;
    let p = std::path::PathBuf::from(&arg);
    if !vault::is_note_file(&p) {
        return None;
    }
    let name = p.file_name()?.to_string_lossy().into_owned();
    let path = vault::note_path(&name).ok()?;
    if path.exists() {
        Some(name)
    } else {
        None
    }
}

static PENDING_OPEN: std::sync::OnceLock<std::sync::Mutex<Option<String>>> =
    std::sync::OnceLock::new();

#[tauri::command]
fn pending_open() -> Option<String> {
    PENDING_OPEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap()
        .take()
}

/* secondary windows must be built Rust-side: every WebView2 in this
 * profile shares ONE environment, created with browser extensions
 * enabled — a JS-built window (extensions off) mismatches the shared
 * env and WebView2 refuses it with ERROR_INVALID_STATE. Here the env
 * options match the main window's, and build() reports failure
 * synchronously so the caller never drops a tab on a dead spawn.
 * MUST be async: sync commands run on the main thread, and build()'s
 * internal run_on_main_thread wait would deadlock the event loop
 * (window HWND spawns, WebView2 completion never pumps → all IPC
 * replies die). Same trap pageview.rs documents for add_child.
 * And builds MUST be serialized: two WebView2 env creates racing on
 * the same user-data folder (or a create racing another window's env
 * teardown) silently fail — build() returns Ok, an HWND appears, but
 * the webview never attaches and the window stays at about:blank.
 * POP_GATE serializes construction and build() is only trusted once
 * the first navigation fires — attach failure → shell destroyed +
 * Err, so the caller never drops a tab on a dead window. */
static POP_GATE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
/* millis-since-boot of the most recent secondary-window teardown.
 * WebView2 shares one browser process per user-data folder — creating
 * an env while a dying window's env is still tearing down silently
 * fails the attach (HWND ok, webview never navigates). Every popped
 * window stamps this on Destroyed; new spawns wait out the gap. */
static LAST_DESTROY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/* millis-since-boot of the most recent webview-env CREATE anywhere in
 * the process. Engine add_child calls during note restore churn the
 * shared browser process the same way a teardown does — a popout env
 * create racing one dead-attaches exactly like creates-in-teardown.
 * Every create site stamps this; pop_window waits for it to settle */
pub(crate) static LAST_CREATE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub(crate) fn boot_ms() -> u64 {
    BOOT.get().map(|b| b.elapsed().as_millis() as u64).unwrap_or(0)
}

pub(crate) fn stamp_create() {
    LAST_CREATE.store(boot_ms(), std::sync::atomic::Ordering::Relaxed);
}

/* engine webviews carry their own env too — closing one churns the
 * shared browser process exactly like a window teardown */
pub(crate) fn stamp_destroy() {
    LAST_DESTROY.store(boot_ms(), std::sync::atomic::Ordering::Relaxed);
}

/* wait out the ~10.5s teardown tail — an env create inside a dying
 * env's window silently dead-attaches */
pub(crate) async fn wait_destroy_gap() {
    let d = boot_ms().saturating_sub(LAST_DESTROY.load(std::sync::atomic::Ordering::Relaxed));
    if d < 10_500 {
        tokio::time::sleep(std::time::Duration::from_millis(10_500 - d)).await;
    }
}

/* transient diagnostic — every spawn outcome lands in
 * appdata/pop.log so field failures are visible without a console */
fn pop_log(msg: &str) {
    if let Some(d) = dirs::data_local_dir() {
        let dir = d.join("app.laido.desktop");
        let _ = std::fs::create_dir_all(&dir);
        let ms = BOOT.get().map(|b| b.elapsed().as_millis()).unwrap_or(0);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("pop.log"))
            .map(|mut f| {
                use std::io::Write;
                let _ = writeln!(f, "{ms:>8} {msg}");
            });
    }
}

#[tauri::command]
async fn pop_window(
    app: tauri::AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    centered: Option<bool>,
    on_top: Option<bool>,
    title: Option<String>,
    init: Option<String>,
    unfocused: Option<bool>,
    skip_taskbar: Option<bool>,
    resizable: Option<bool>,
) -> Result<(), String> {
    let _gate = POP_GATE.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    let boot = BOOT.get_or_init(std::time::Instant::now);
    /* retries: a timed-out shell's label lingers in the window registry
     * while it tears down — rebuilding under the SAME label can shadow
     * the dying window and fail identically (observed: two consecutive
     * timeouts on one label, instant success on the next fresh one).
     * Each attempt gets a fresh label; the frontend matches the child
     * by the __POP_TOKEN__ carried in the init script, not the label */
    let mut last_err = String::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(38);
    for attempt in 0..3 {
        if std::time::Instant::now() > deadline {
            pop_log("pop_window deadline hit — bailing");
            break;
        }
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        }
        /* space every attempt from any recent destroy — the shared
         * browser process keeps the dying env alive for ~8-12s (ext +
         * renderer teardown) and env creates inside that tail silently
         * fail the attach. Waiting it out beats a doomed attempt —
         * and it must be rechecked per attempt: destroys can land
         * while a previous attempt was still waiting on its nav */
        let since = boot.elapsed().as_millis() as u64
            - LAST_DESTROY.load(std::sync::atomic::Ordering::Relaxed);
        if since < 10_500 {
            tokio::time::sleep(std::time::Duration::from_millis(10_500 - since)).await;
        }
        /* …and recent env CREATES — engine add_child calls during boot/
         * note-restore churn the same shared browser process; spawning a
         * top-level env inside that churn dead-attaches (observed: drags
         * in the seconds right after engine-heavy restores) */
        let since_c = boot.elapsed().as_millis() as u64
            - LAST_CREATE.load(std::sync::atomic::Ordering::Relaxed);
        if LAST_CREATE.load(std::sync::atomic::Ordering::Relaxed) > 0 && since_c < 4_000 {
            tokio::time::sleep(std::time::Duration::from_millis(4_000 - since_c)).await;
        }
        /* label charset is alphanumeric + - / : _ — no ~ */
        let try_label = if attempt == 0 {
            label.clone()
        } else {
            format!("{label}-r{attempt}")
        };
        match pop_window_once(
            &app, &try_label, &label, &url, x, y, w, h, centered, on_top,
            title.as_deref(), init.as_deref(), unfocused, skip_taskbar, resizable,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                pop_log(&format!("attempt{attempt} fail {try_label}: {e}"));
                last_err = e;
            }
        }
    }
    Err(last_err)
}

async fn pop_window_once(
    app: &tauri::AppHandle,
    label: &str,
    token: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    centered: Option<bool>,
    on_top: Option<bool>,
    title: Option<&str>,
    init: Option<&str>,
    unfocused: Option<bool>,
    skip_taskbar: Option<bool>,
    resizable: Option<bool>,
) -> Result<(), String> {
    /* stage-2 proof: the child emitting pop:ready with our token means
     * its JS actually booted — the only success signal that can't lie.
     * Registered before the build so a fast boot can't beat us to it */
    let (rdy_tx, rdy_rx) = tokio::sync::oneshot::channel::<()>();
    let rdy_tx = std::sync::Mutex::new(Some(rdy_tx));
    let want = token.to_string();
    let unl = tauri::Listener::listen(app, "pop:ready", move |e: tauri::Event| {
        if e.payload().trim_matches('"') == want {
            if let Ok(mut g) = rdy_tx.lock() {
                if let Some(tx) = g.take() {
                    let _ = tx.send(());
                }
            }
        }
    });
    let out = pop_window_inner(
        app, label, url, x, y, w, h, centered, on_top, title, init, unfocused,
        skip_taskbar, resizable,
    )
    .await;
    /* inner Ok only proves attach — stage 2 still gates the caller */
    let wv = match out {
        Ok(w) => w,
        Err(e) => {
            tauri::Listener::unlisten(app, unl);
            return Err(e);
        }
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), rdy_rx).await {
        Ok(_) => {
            tauri::Listener::unlisten(app, unl);
            pop_log(&format!("ready-ok {label}"));
            Ok(())
        }
        Err(_) => {
            tauri::Listener::unlisten(app, unl);
            pop_log(&format!("ready-timeout {label}"));
            let _ = wv.close();
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            Err("the new window couldn't finish loading — tab kept".into())
        }
    }
}

/* stage 1: build + attach proof. Ok carries the live window so the
 * caller can destroy it if stage 2 (real boot) never lands */
async fn pop_window_inner(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    centered: Option<bool>,
    on_top: Option<bool>,
    title: Option<&str>,
    init: Option<&str>,
    unfocused: Option<bool>,
    skip_taskbar: Option<bool>,
    resizable: Option<bool>,
) -> Result<tauri::WebviewWindow, String> {
    /* ?query in WebviewUrl::App never resolves — the webview sits at
     * about:blank. Boot state (which note/sticky to open) goes through
     * an initialization script instead — window.__POP_* globals the
     * frontend reads on init */
    let mut b = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
        .title(title.unwrap_or("Laido"))
        .inner_size(w, h)
        .decorations(false)
        /* browser_extensions_enabled is a shared-profile env option and
         * MUST match every other env (its absence was the 0x8007139F).
         * extensions_path is deliberately NOT set: it isn't part of the
         * env-compat contract, extensions already installed live in the
         * profile, and re-scanning the dir during child boot races the
         * main window's env — observed as the document stalling at
         * about:blank for the full ready-timeout */
        .browser_extensions_enabled(true);
    if unfocused == Some(true) {
        b = b.focused(false);
    }
    if skip_taskbar == Some(true) {
        b = b.skip_taskbar(true);
    }
    if let Some(rz) = resizable {
        b = b.resizable(rz);
    }
    if let Some(js) = init {
        b = b.initialization_script(js);
    }
    b = if centered == Some(true) {
        b.center()
    } else {
        b.position(x, y)
    };
    if on_top == Some(true) {
        b = b.always_on_top(true);
    }
    /* build() Ok only proves the HWND exists — the WebView2 controller
     * attaches asynchronously and can still fail silently (env races,
     * teardown overlap). NavigationStarting is the real attach signal —
     * but it ALSO fires for the webview's stock about:blank nav, so
     * only a nav to the real app url counts: an attach that stalls at
     * about:blank must still time out and be rebuilt */
    let (nav_tx, nav_rx) = tokio::sync::oneshot::channel::<()>();
    let nav_tx = std::sync::Mutex::new(Some(nav_tx));
    let wv = match b
        .on_navigation(move |url| {
            let u = url.as_str();
            if u.contains("tauri.localhost") || u.starts_with("tauri://") {
                if let Ok(mut g) = nav_tx.lock() {
                    if let Some(tx) = g.take() {
                        let _ = tx.send(());
                    }
                }
            }
            true
        })
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            pop_log(&format!("build-err {label}: {e}"));
            return Err(e.to_string());
        }
    };
    stamp_create();
    let lab = label.to_string();
    wv.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(boot) = BOOT.get() {
                LAST_DESTROY.store(
                    boot.elapsed().as_millis() as u64,
                    std::sync::atomic::Ordering::Relaxed,
                );
                pop_log(&format!("destroyed {lab}"));
            }
        }
    });
    /* nav-wait races three outcomes: attach (Ok), timeout, and — the
     * important one — ANOTHER window's destroy landing mid-wait. A
     * destroy anywhere in the process poisons every in-flight env
     * create, so this attempt is already dead the moment one lands;
     * bail immediately instead of burning the full timeout */
    let built_ms = BOOT.get().map(|b| b.elapsed().as_millis() as u64).unwrap_or(0);
    let doomed = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            if LAST_DESTROY.load(std::sync::atomic::Ordering::Relaxed) > built_ms {
                break;
            }
        }
    };
    let attached = tokio::select! {
        r = nav_rx => r.is_ok(),
        _ = doomed => {
            pop_log(&format!("nav-doomed {label}"));
            false
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(6)) => false,
    };
    if attached {
        pop_log(&format!("nav-ok {label}"));
        Ok(wv)
    } else {
        let _ = wv.close();
        /* env teardown is async — let it settle before the gate
         * releases, or the next spawn races it */
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Err("the new window couldn't start its webview — tab kept".into())
    }
}

/// Windows: give .laido files the Laido icon and open-with behaviour.
/// Per-user (HKCU) so no admin is needed; skipped once registered.
#[cfg(windows)]
fn register_file_association() {
    use std::os::windows::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.display().to_string();
    let has = std::process::Command::new("reg")
        .args(["query", "HKCU\\Software\\Classes\\.laido"])
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if has {
        return;
    }
    let icon = format!("{exe},0");
    let open = format!("\"{exe}\" \"%1\"");
    let cmds: Vec<Vec<&str>> = vec![
        vec!["add", "HKCU\\Software\\Classes\\.laido", "/ve", "/d", "Laido.Note", "/f"],
        vec!["add", "HKCU\\Software\\Classes\\Laido.Note", "/ve", "/d", "Laido note", "/f"],
        vec!["add", "HKCU\\Software\\Classes\\Laido.Note\\DefaultIcon", "/ve", "/d", &icon, "/f"],
        vec![
            "add",
            "HKCU\\Software\\Classes\\Laido.Note\\shell\\open\\command",
            "/ve",
            "/d",
            &open,
            "/f",
        ],
    ];
    for args in cmds {
        let _ = std::process::Command::new("reg")
            .args(&args)
            .creation_flags(0x0800_0000)
            .output();
    }
}

fn main() {
    /* panics on the GUI path are otherwise invisible — a windows-subsystem
     * exe has no console, so the panic message would die with the process.
     * Write every panic to appdata/crash.log before the default hook runs */
    /* Explorer "Convert to PDF" verb hands us --img2pdf <files> — convert
     * headless and exit instead of booting the whole app */
    if let Some(code) = imgpdf::cli() {
        std::process::exit(code);
    }
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("panic: {info}\n{:?}", std::backtrace::Backtrace::capture());
        if let Some(d) = dirs::data_local_dir() {
            let dir = d.join("app.laido.desktop");
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("crash.log"), &msg);
        }
        eprintln!("{msg}");
    }));
    /* GPU: WebView2 already composites on GPU by default, but Chromium
     * silently falls back to software raster when a driver lands on its
     * blocklist — that IS the "super lag" feel on marginal hardware.
     * These flags force GPU rasterization anyway; the env var MERGES
     * with wry's options-level args (unlike with_additional_browser_args,
     * which would clobber wry's autoplay + msWebOOUI defaults), and we
     * append so a dev's --remote-debugging-port on the same var survives */
    #[cfg(windows)]
    {
        const GPU_ARGS: &str =
            "--ignore-gpu-blocklist --enable-gpu-rasterization --enable-accelerated-2d-canvas";
        let cur = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !cur.contains("--ignore-gpu-blocklist") {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("{cur} {GPU_ARGS}").trim(),
            );
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = BOOT.set(std::time::Instant::now());
            vault::ensure_vault()?;
            /* the WebView2 environment is created by the FIRST webview —
             * extensions must be enabled here or the child page-views can
             * never load them. The conf file only declares size/chrome;
             * the window itself is built in code so the env options land */
            #[cfg(windows)]
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                let ext_dir = extensions::ext_root(app.handle());
                let _ = std::fs::create_dir_all(&ext_dir);
                /* seed BEFORE the env exists — extensions are scanned
                 * once when the first webview spins up the shared env */
                extensions::seed_bridge(app.handle());
                WebviewWindowBuilder::new(
                    app.handle(),
                    "main",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Laido")
                .inner_size(1180.0, 760.0)
                .min_inner_size(720.0, 460.0)
                .decorations(false)
                .center()
                .browser_extensions_enabled(true)
                .extensions_path(&ext_dir)
                .build()?;
            }
            #[cfg(not(windows))]
            {
                use tauri::{WebviewUrl, WebviewWindowBuilder};
                // same window, minus the WebView2-only extension options
                WebviewWindowBuilder::new(
                    app.handle(),
                    "main",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Laido")
                .inner_size(1180.0, 760.0)
                .min_inner_size(720.0, 460.0)
                .decorations(false)
                .center()
                .build()?;
            }
            skills::seed_defaults();
            #[cfg(not(windows))]
            extensions::seed_bridge(app.handle());
            dlhttp::start(app.handle().clone());
            scheduler::start(app.handle().clone());
            if let Some(name) = pending_note_from_args() {
                *PENDING_OPEN
                    .get_or_init(|| std::sync::Mutex::new(None))
                    .lock()
                    .unwrap() = Some(name);
            }
            #[cfg(windows)]
            register_file_association();
            imgpdf::menu_sync();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pop_window,
            vault::vault_list,
            vault::vault_dir,
            vault::reveal_note,
            vault::vault_index,
            vault::vault_find,
            vault::vault_agenda,
            vault::vault_history,
            vault::vault_snapshot_read,
            vault::asset_save,
            vault::asset_list,
            vault::asset_data_url,
            vault::vault_update_callout,
            vault::import_note,
            fsnav::fs_roots,
            fsnav::fs_list,
            fsnav::fs_attach,
            fsnav::fs_open,
            vault::vault_read,
            vault::vault_write,
            vault::vault_create,
            vault::vault_rename,
            vault::vault_insert,
            vault::vault_prop_set,
            vault::vault_prop_rename,
            vault::vault_stickies,
            vault::sticky_save,
            vault::sticky_read,
            vault::sticky_lift,
            scheduler::schedule_list,
            scheduler::schedule_run_now,
            scheduler::schedule_toggle,
            scheduler::schedule_create,
            scheduler::schedule_remove,
            scheduler::schedule_month,
            skills::skills_list,
            skills::skill_read,
            skills::skill_save,
            skills::skill_run,
            skills::habit_track,
            rag::rag_list,
            rag::rag_add_files,
            rag::rag_add_site,
            imgpdf::img_to_pdf,
            rag::rag_remove,
            rag::rag_ask,
            rag::rag_quiz,
            rag::rag_tasks,
            rag::related_notes,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_level,
            voice::voice_live_start,
            voice::voice_live_stop,
            state::settings_get,
            state::settings_set,
            state::detect_locale,
            llm::llm_ping,
            llm::llm_models,
            state::llm_models_all,
            llm::deck_tool_gen,
            llm::sheet_tool_gen,
            tools::tavily_ping,
            tools::open_url,
            account::laido_auth_begin,
            account::laido_auth_poll,
            account::laido_auth_finish,
            agent::agent_run,
            agent::note_summary,
            term::term_run,
            term::term_ai,
            term::term_web,
            term::term_notes,
            pending_open,
            looprun::loop_run,
            looprun::loop_stop,
            xfer::file_write_text,
            xfer::file_write_b64,
            xfer::file_read_text,
            xfer::sheet_xlsx_export,
            xfer::sheet_xlsx_import,
            xfer::sheet_xlsx_sheets,
            xfer::deck_pptx_export,
            xfer::deck_pptx_import,
            tools::page_fetch,
            pageview::pv_open,
            pageview::pv_nav,
            pageview::pv_bounds,
            pageview::pv_visible,
            pageview::pv_sync,
            pageview::pv_close,
            pageview::pv_list,
            pageview::pv_url,
            pageview::pv_eval,
            pageview::pv_suspend,
            pageview::pv_resume,
            pageview::pv_memlevel,
            pageview::pv_focus_main,
            pageview::wv_open,
            pageview::wv_doc,
            download::dl_start,
            download::dl_info,
            download::dl_list,
            download::dl_cancel,
            download::dl_pause,
            download::dl_resume,
            download::dl_open,
            download::dl_reveal,
            extensions::ext_list,
            extensions::ext_install_path,
            extensions::ext_install_url,
            extensions::ext_remove,
            extensions::ext_toggle,
            extensions::us_list,
            extensions::us_save,
            extensions::us_toggle,
            extensions::us_remove,
            extensions::us_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running laido");
}
