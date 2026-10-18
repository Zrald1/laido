use crate::vault::vault_root;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_BASE_URL: &str = "https://api.tokenfactory.nebius.com/v1";
pub const DEFAULT_FAST: &str = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
pub const DEFAULT_MAIN: &str = "nvidia/nemotron-3-super-120b-a12b";
pub const DEFAULT_DEEP: &str = "nvidia/Nemotron-3-Ultra-550b-a55b";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub nebius_api_key: String,
    pub tavily_api_key: String,
    pub assemblyai_api_key: String,
    pub theme: String,
    pub base_url: String,
    pub model_fast: String,
    pub model_main: String,
    pub model_deep: String,
    pub model_rewrite: String,
    pub model_ocr: String,
    pub language: String,
    /// Laido account session from the site sign-in flow (browser-poll)
    pub laido_session: String,
    /// account email for display — the session above can be re-validated
    pub laido_email: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            nebius_api_key: String::new(),
            tavily_api_key: String::new(),
            assemblyai_api_key: String::new(),
            theme: "system".into(),
            base_url: DEFAULT_BASE_URL.into(),
            model_fast: DEFAULT_FAST.into(),
            model_main: DEFAULT_MAIN.into(),
            model_deep: DEFAULT_DEEP.into(),
            model_rewrite: DEFAULT_FAST.into(),
            model_ocr: String::new(),
            language: String::new(),
            laido_session: String::new(),
            laido_email: String::new(),
        }
    }
}

#[tauri::command]
pub fn detect_locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "en".into())
}

fn settings_path() -> PathBuf {
    vault_root().join(".laido").join("settings.json")
}

pub fn load_settings() -> Settings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[derive(Deserialize, Default)]
pub struct SettingsPatch {
    pub nebius_api_key: Option<String>,
    pub tavily_api_key: Option<String>,
    pub assemblyai_api_key: Option<String>,
    pub theme: Option<String>,
    pub base_url: Option<String>,
    pub model_fast: Option<String>,
    pub model_main: Option<String>,
    pub model_deep: Option<String>,
    pub model_rewrite: Option<String>,
    pub model_ocr: Option<String>,
    pub language: Option<String>,
    pub laido_session: Option<String>,
    pub laido_email: Option<String>,
}

#[tauri::command]
pub fn settings_get() -> Settings {
    load_settings()
}

#[tauri::command]
pub fn settings_set(patch: SettingsPatch) -> Result<Settings, String> {
    let mut s = load_settings();
    if let Some(v) = patch.nebius_api_key {
        s.nebius_api_key = v;
    }
    if let Some(v) = patch.tavily_api_key {
        s.tavily_api_key = v;
    }
    if let Some(v) = patch.assemblyai_api_key {
        s.assemblyai_api_key = v;
    }
    if let Some(v) = patch.theme.filter(|v| !v.is_empty()) {
        s.theme = v;
    }
    if let Some(v) = patch.base_url.filter(|v| !v.is_empty()) {
        s.base_url = v;
    }
    if let Some(v) = patch.model_fast.filter(|v| !v.is_empty()) {
        s.model_fast = v;
    }
    if let Some(v) = patch.model_main.filter(|v| !v.is_empty()) {
        s.model_main = v;
    }
    if let Some(v) = patch.model_deep.filter(|v| !v.is_empty()) {
        s.model_deep = v;
    }
    if let Some(v) = patch.model_rewrite.filter(|v| !v.is_empty()) {
        s.model_rewrite = v;
    }
    if let Some(v) = patch.model_ocr.filter(|v| !v.is_empty()) {
        s.model_ocr = v;
    }
    if let Some(v) = patch.language.filter(|v| !v.is_empty()) {
        s.language = v;
    }
    if let Some(v) = patch.laido_session {
        s.laido_session = v;
    }
    if let Some(v) = patch.laido_email {
        s.laido_email = v;
    }
    save_settings(&s)?;
    Ok(s)
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
