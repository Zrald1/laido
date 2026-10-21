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
    /// BYOK Voyage AI key — rerank stage in retrieval; unused when managed
    pub voyage_api_key: String,
    pub theme: String,
    pub base_url: String,
    pub model_fast: String,
    pub model_main: String,
    pub model_deep: String,
    pub model_rewrite: String,
    pub model_ocr: String,
    /// BYOK embedding model — RAG index; "auto" under the managed gateway
    pub model_embed: String,
    /// extra providers the user keeps alongside the active key/base —
    /// JSON [{id,label,key,base}]; a chat picks one via "prov::<id>::<model>"
    pub providers_json: String,
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
            voyage_api_key: String::new(),
            theme: "system".into(),
            base_url: DEFAULT_BASE_URL.into(),
            model_fast: DEFAULT_FAST.into(),
            model_main: DEFAULT_MAIN.into(),
            model_deep: DEFAULT_DEEP.into(),
            model_rewrite: DEFAULT_FAST.into(),
            model_ocr: String::new(),
            model_embed: String::new(),
            providers_json: "[]".into(),
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
    pub voyage_api_key: Option<String>,
    pub theme: Option<String>,
    pub base_url: Option<String>,
    pub model_fast: Option<String>,
    pub model_main: Option<String>,
    pub model_deep: Option<String>,
    pub model_rewrite: Option<String>,
    pub model_ocr: Option<String>,
    pub model_embed: Option<String>,
    pub providers_json: Option<String>,
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
    if let Some(v) = patch.voyage_api_key {
        s.voyage_api_key = v;
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
    if let Some(v) = patch.model_ocr {
        s.model_ocr = v;
    }
    if let Some(v) = patch.model_embed {
        s.model_embed = v;
    }
    if let Some(v) = patch.providers_json {
        s.providers_json = v;
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

/* ---- multi-provider routing ----
 *
 * Any LLM call can be addressed to a specific provider by prefixing the
 * model spec: "prov::<id>::<model>". Bare model names keep hitting the
 * active key/base pair (nebius_api_key + base_url) exactly as before.
 */

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct ProviderCfg {
    /// stable id — a PROVIDERS preset name or "custom"
    pub id: String,
    /// display label shown next to this provider's models
    pub label: String,
    pub key: String,
    pub base: String,
}

impl Default for ProviderCfg {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            key: String::new(),
            base: String::new(),
        }
    }
}

pub fn providers(s: &Settings) -> Vec<ProviderCfg> {
    serde_json::from_str(&s.providers_json).unwrap_or_default()
}

/// credentials + concrete model for an LLM call. Returns (model, base, key).
/// spec "prov::<id>::<model>" routes to that provider; anything else uses the
/// active pair. "laido" as an id maps to the managed gateway — it needs the
/// active lk- key (managed mode already means the pair IS the gateway).
pub fn resolve_llm(s: &Settings, spec: &str) -> (String, String, String) {
    if let Some(rest) = spec.strip_prefix("prov::") {
        if let Some((id, model)) = rest.split_once("::") {
            for p in providers(s) {
                if p.id == id {
                    return (model.to_string(), p.base.trim_end_matches('/').to_string(), p.key);
                }
            }
            // unknown provider id → fall through to the active pair
            return (model.to_string(), s.base_url.trim_end_matches('/').to_string(), s.nebius_api_key.clone());
        }
    }
    (
        spec.to_string(),
        s.base_url.trim_end_matches('/').to_string(),
        s.nebius_api_key.clone(),
    )
}

/// per-provider model catalog entry for the pickers
#[derive(Serialize)]
pub struct ProvModels {
    pub id: String,
    pub label: String,
    /// managed gateway — the server owns model choice; only "auto" is valid
    pub managed: bool,
    pub has_key: bool,
    pub models: Vec<String>,
    pub error: String,
}

/// one catalog entry per configured provider — active pair first, then the
/// extra providers list. Managed pairs skip the HTTP fetch entirely.
pub async fn models_all() -> Vec<ProvModels> {
    let s = load_settings();
    let mut provs: Vec<(String, String, String, String)> = Vec::new(); // id,label,base,key
    let managed_active = s.nebius_api_key.starts_with("lk-")
        || s.base_url.starts_with("https://laido.");
    provs.push((
        "active".into(),
        if managed_active { "Laido cloud".into() } else { s.base_url.clone() },
        s.base_url.trim_end_matches('/').to_string(),
        s.nebius_api_key.clone(),
    ));
    for p in providers(&s) {
        provs.push((p.id.clone(), p.label.clone(), p.base.trim_end_matches('/').to_string(), p.key));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut out = Vec::new();
    for (id, label, base, key) in provs {
        let managed = key.starts_with("lk-") || base.starts_with("https://laido.");
        if managed {
            out.push(ProvModels {
                id, label, managed: true, has_key: !key.is_empty(),
                models: vec!["auto".into()], error: String::new(),
            });
            continue;
        }
        if key.is_empty() {
            out.push(ProvModels {
                id, label, managed: false, has_key: false,
                models: vec![], error: "no API key".into(),
            });
            continue;
        }
        let url = format!("{base}/models");
        match client.get(&url).bearer_auth(&key).send().await {
            Ok(resp) => {
                let status = resp.status();
                match resp.text().await {
                    Ok(text) if status.is_success() => {
                        let v: serde_json::Value =
                            serde_json::from_str(&text).unwrap_or_default();
                        let mut ids: Vec<String> = v["data"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        ids.sort();
                        out.push(ProvModels {
                            id, label, managed: false, has_key: true,
                            models: ids, error: String::new(),
                        });
                    }
                    Ok(text) => out.push(ProvModels {
                        id, label, managed: false, has_key: true,
                        models: vec![],
                        error: format!("HTTP {status}: {}", text.chars().take(120).collect::<String>()),
                    }),
                    Err(e) => out.push(ProvModels {
                        id, label, managed: false, has_key: true,
                        models: vec![], error: format!("network: {e}"),
                    }),
                }
            }
            Err(e) => out.push(ProvModels {
                id, label, managed: false, has_key: true,
                models: vec![], error: format!("network: {e}"),
            }),
        }
    }
    out
}

#[tauri::command]
pub async fn llm_models_all() -> Vec<ProvModels> {
    models_all().await
}
