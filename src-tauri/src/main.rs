#![windows_subsystem = "windows"]

mod agent;
mod llm;
mod looprun;
mod rag;
mod scheduler;
mod skills;
mod state;
mod tools;
mod vault;
mod voice;

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
            vault::vault_update_callout,
            vault::import_note,
            vault::vault_read,
            vault::vault_write,
            vault::vault_create,
            vault::vault_rename,
            vault::vault_insert,
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
            voice::voice_live_start,
            voice::voice_live_stop,
            state::settings_get,
            state::settings_set,
            state::detect_locale,
            llm::llm_ping,
            llm::llm_models,
            tools::tavily_ping,
            tools::open_url,
            agent::agent_run,
            agent::note_summary,
            pending_open,
            looprun::loop_run,
            looprun::loop_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running laido");
}
