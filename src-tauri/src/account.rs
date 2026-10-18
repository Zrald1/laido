//! Laido account sign-in — browser-based OAuth link.
//!
//! The app can't run a full OAuth flow inside the webview, so it asks the
//! site for a one-shot `sid`, opens `…/app?sid=` in the system browser, and
//! polls `/api/app/poll` while the user signs in (Google or email) there.
//! The poll redeems a real bearer session; `finish` then pulls the first
//! dashboard API key and points the gateway settings at it.

use crate::state::{load_settings, save_settings};
use serde::Serialize;

fn site() -> String {
    std::env::var("LAIDO_SITE_URL")
        .unwrap_or_else(|_| "https://laido.zraldwebdevelopmentservices.shop".into())
        .trim_end_matches('/')
        .to_string()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AuthBegin {
    pub sid: String,
    pub url: String,
}

#[tauri::command]
pub async fn laido_auth_begin() -> Result<AuthBegin, String> {
    let r = client()?
        .post(format!("{}/api/app/begin", site()))
        .send()
        .await
        .map_err(|e| format!("can't reach the sign-in service: {e}"))?;
    let j: serde_json::Value = r.json().await.map_err(|e| e.to_string())?;
    let sid = j
        .get("sid")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if sid.is_empty() {
        return Err("sign-in service returned no session".into());
    }
    Ok(AuthBegin {
        url: format!("{}/app?sid={sid}", site()),
        sid,
    })
}

#[tauri::command]
pub async fn laido_auth_poll(sid: String) -> Result<serde_json::Value, String> {
    let r = client()?
        .get(format!("{}/api/app/poll", site()))
        .query(&[("sid", sid)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    r.json().await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct AuthFinish {
    pub email: String,
    pub plan: String,
}

#[tauri::command]
pub async fn laido_auth_finish(token: String) -> Result<AuthFinish, String> {
    let c = client()?;
    let me: serde_json::Value = c
        .get(format!("{}/api/me", site()))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let email = me
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if email.is_empty() {
        return Err("account lookup failed".into());
    }
    let plan = me
        .get("plan")
        .and_then(|v| v.as_str())
        .unwrap_or("free")
        .to_string();
    // first dashboard key — auto-minted by the site if none exists yet
    let keys: serde_json::Value = c
        .get(format!("{}/api/keys", site()))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let key = keys
        .get("keys")
        .and_then(|k| k.get(0))
        .and_then(|k| k.get("token"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if key.is_empty() {
        return Err("no API key on the account".into());
    }
    let mut s = load_settings();
    s.nebius_api_key = key;
    s.base_url = format!("{}/v1", site());
    s.laido_session = token;
    s.laido_email = email.clone();
    save_settings(&s)?;
    Ok(AuthFinish { email, plan })
}
