use crate::state::load_settings;
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
pub struct PingResult {
    pub model: String,
    pub reply: String,
}

fn strip_thinking(s: &str) -> String {
    let mut t = s.to_string();
    while let (Some(a), Some(b)) = (t.find(" thinking"), t.find("</think>")) {
        if a < b {
            t.replace_range(a..b + " response".len(), "");
        } else {
            break;
        }
    }
    let lower = t.to_lowercase();
    if lower.contains("thinking process") || lower.contains("analyze user input") {
        for marker in ["final answer", "synthesis:", "summary:", "in summary", "answer:"] {
            if let Some(i) = lower.rfind(marker) {
                let cut = i + marker.len();
                t = t[cut..].trim_start_matches([':', ' ', '\n', '*']).to_string();
                break;
            }
        }
    }
    t.trim().to_string()
}

/// The only real ceiling is the model's context window. Prompt builders
/// clamp to this generous cap instead of the old small truncations — the
/// user has full authority over how much context and how long a reply.
pub const PROMPT_CAP: usize = 200_000; // chars ≈ 50k tokens, fits every Nemotron
/// default reply headroom when the user hasn't asked for a specific length
pub const MAX_REPLY: u32 = 8192;

/// thinking models can burn a tight budget on hidden reasoning and return
/// nothing — retry once at double budget when the reply comes back empty
pub async fn chat_retry(
    model: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let mut out = chat(model, system, user, max_tokens).await?;
    if out.trim().is_empty() {
        out = chat(model, system, user, max_tokens.saturating_mul(2)).await?;
    }
    Ok(out)
}

pub async fn chat(
    model: &str,
    system: Option<&str>,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let mut messages = Vec::new();
    if let Some(sys) = system {
        messages.push(json!({ "role": "system", "content": sys }));
    }
    messages.push(json!({ "role": "user", "content": user }));
    send(model, messages, max_tokens).await
}

/// vision-model call: one text prompt + one base64 image (OpenAI-compatible
/// multipart content) — used by the library OCR path for scanned PDFs
pub async fn chat_vision(
    model: &str,
    prompt: &str,
    mime: &str,
    image_b64: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": prompt },
            { "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{image_b64}") } }
        ]
    })];
    send(model, messages, max_tokens).await
}

async fn send(model: &str, messages: Vec<serde_json::Value>, max_tokens: u32) -> Result<String, String> {
    let s = load_settings();
    if s.nebius_api_key.is_empty() {
        return Err("no Nebius API key — open Settings and add one".into());
    }
    let url = format!("{}/chat/completions", s.base_url.trim_end_matches('/'));

    let base = json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "store": false
    });

    let client = reqwest::Client::new();
    let mut with_kwargs = true;
    let mut tries = 0u8;
    let text = loop {
        tries += 1;
        let mut body = base.clone();
        if with_kwargs {
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        }
        match client
            .post(&url)
            .bearer_auth(&s.nebius_api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.map_err(|e| e.to_string())?;
                if status.is_success() {
                    break text;
                }
                if with_kwargs && status.as_u16() == 400 {
                    with_kwargs = false;
                    continue;
                }
                let snippet: String = text.chars().take(300).collect();
                let hint = if status.as_u16() == 400 || status.as_u16() == 404 {
                    " — model name issue? try nvidia/Nemotron-3_5-Lightning in settings.json → model_fast"
                } else {
                    ""
                };
                return Err(format!("HTTP {status}: {snippet}{hint}"));
            }
            Err(e) => {
                if tries < 2 {
                    continue;
                }
                return Err(format!("network error: {e}"));
            }
        }
    };

    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    Ok(strip_thinking(&content))
}

#[tauri::command]
pub async fn llm_ping(message: String) -> Result<PingResult, String> {
    let s = load_settings();
    let reply = chat(&s.model_fast, None, &message, 64).await?;
    Ok(PingResult {
        model: s.model_fast.clone(),
        reply,
    })
}

#[tauri::command]
pub async fn llm_models() -> Result<Vec<String>, String> {
    let s = load_settings();
    if s.nebius_api_key.is_empty() {
        return Err("no Nebius API key".into());
    }
    let url = format!("{}/models", s.base_url.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&s.nebius_api_key)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}

pub async fn embed(texts: &[String], dims: u32) -> Result<Vec<Vec<f32>>, String> {
    let s = load_settings();
    if s.nebius_api_key.is_empty() {
        return Err("no Nebius API key — open Settings and add one".into());
    }
    let url = format!("{}/embeddings", s.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": "Qwen/Qwen3-Embedding-8B",
        "input": texts,
        "encoding_format": "float",
        "dimensions": dims,
    });
    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&s.nebius_api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let head: String = text.chars().take(300).collect();
        return Err(format!("embeddings {status}: {head}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = v["data"].as_array() {
        for item in arr {
            if let Some(vec) = item["embedding"].as_array() {
                let mut f: Vec<f32> = vec.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
                if f.len() > dims as usize {
                    f.truncate(dims as usize);
                }
                out.push(f);
            }
        }
    }
    if out.is_empty() {
        return Err("no embeddings returned".into());
    }
    Ok(out)
}
