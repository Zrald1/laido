#![windows_subsystem = "windows"]

mod agent;
mod extensions;
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
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            skills::seed_defaults();
            scheduler::start(app.handle().clone());
            if let Some(name) = pending_note_from_args() {
                *PENDING_OPEN
                    .get_or_init(|| std::sync::Mutex::new(None))
                    .lock()
                    .unwrap() = Some(name);
            }
            #[cfg(windows)]
            register_file_association();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            llm::deck_tool_gen,
            llm::sheet_tool_gen,
            tools::tavily_ping,
            tools::open_url,
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
            pageview::pv_close,
            pageview::pv_url,
            pageview::pv_eval,
            extensions::ext_list,
            extensions::ext_install_path,
            extensions::ext_install_url,
            extensions::ext_remove,
            extensions::us_list,
            extensions::us_save,
            extensions::us_toggle,
            extensions::us_remove,
            extensions::us_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running laido");
}
