use crate::agent::Activity;
use crate::state::load_settings;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

#[derive(Serialize)]
pub struct PingResult {
    pub model: String,
    pub reply: String,
}

fn strip_thinking(s: &str) -> String {
    let mut t = s.to_string();
    // <think>…</think> blocks — reasoning models leak them into content
    // when the thinking-disable kwarg isn't honored (400-retry path, or a
    // model that ignores it). Left in, the reasoning shows as the reply.
    while let (Some(a), Some(b)) = (t.find("<think>"), t.find("</think>")) {
        if a < b {
            t.replace_range(a..b + "</think>".len(), "");
        } else {
            break;
        }
    }
    // an unclosed <think> means the reply was cut mid-reasoning —
    // everything from the tag onward is thinking, not the answer
    if let Some(a) = t.find("<think>") {
        t.truncate(a);
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

/// real multi-turn chat — the terminal widget's session history rides as
/// proper role/content messages so the model actually remembers the thread
pub async fn chat_messages(
    model: &str,
    system: Option<&str>,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
) -> Result<String, String> {
    let mut all = Vec::new();
    if let Some(sys) = system {
        all.push(json!({ "role": "system", "content": sys }));
    }
    all.extend(messages);
    send(model, all, max_tokens).await
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

/// system prompt for `deck_tool_gen` — the AI invents a reusable slide
/// tool as a stamp of one or more elements. The reply is strict JSON the
/// frontend validates field-by-field before it ever reaches a slide.
const DECK_TOOL_SYSTEM: &str = "You design reusable tools for a slide editor's toolbar. \
The user describes a tool; you reply with ONE JSON object — no prose, no markdown fences.\n\
Schema: {\"name\":\"short label\",\"icon\":\"one glyph like ▲ or ✚\",\"els\":[<element>,...]}\n\
Each element: {\"kind\":\"shape|text|img\",\"shape\":\"<gallery key>\",\"x\":0-100,\"y\":0-100,\
\"w\":1-100,\"h\":1-100,\"text\":\"label\",\"fill\":\"#hex\",\"line\":\"#hex\",\"color\":\"#hex\",\
\"size\":<font px>,\"bold\":false,\"ital\":false,\"align\":\"l|c|r\",\"rot\":<deg>,\"src\":\"<image path or https url>\"}.\n\
x/y/w/h are PERCENT of the box the user will drag — compose elements inside a 0-100 canvas. \
Omit empty fields.\n\
Shape keys: rect round pill ellipse line tri rtri diamond pent hex star arrow darrow uarrow chevron banner callout.\n\
Rules: 1-8 elements; prefer shapes with text inside; tasteful fills (muted colors, one accent); \
keep text short (a word or two); text-only tools are fine (kind \"text\" with styled text).\n\
Examples — \"kpi card\": rounded rect + big centered text; \"process arrow\": chevron; \
\"warning stamp\": triangle + short label; \"rating\": five stars in a row; \
\"divider\": a line + small diamond at center.";

/// generate a reusable deck tool spec from a natural-language description —
/// returns the model's raw reply; the deck validates/sanitizes it client-side.
/// Leaves the mandatory activity trace either way.
#[tauri::command]
pub async fn deck_tool_gen(app: AppHandle, prompt: String) -> Result<String, String> {
    let p = prompt.trim();
    if p.is_empty() {
        return Err("describe the tool first".into());
    }
    let p: String = p.chars().take(600).collect();
    let model = load_settings().model_rewrite;
    match chat_retry(&model, Some(DECK_TOOL_SYSTEM), &p, 1600).await {
        Ok(raw) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✦ deck tool drafted — {}", p.chars().take(48).collect::<String>()),
                },
            );
            Ok(raw)
        }
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ deck tool failed: {e}"),
                },
            );
            Err(e)
        }
    }
}

/// system prompt for `sheet_tool_gen` — the AI invents a reusable sheet
/// tool as a sequence of steps applied to the current selection. Strict
/// JSON the frontend validates field-by-field before it runs.
const SHEET_TOOL_SYSTEM: &str = "You design reusable tools for a spreadsheet's toolbar. \
The user describes a tool; you reply with ONE JSON object — no prose, no markdown fences.\n\
Schema: {\"name\":\"short label\",\"icon\":\"one glyph like Σ or ✚\",\"steps\":[<step>,...]}\n\
Each step is one of:\n\
 {\"do\":\"formula\",\"formula\":\"=EXPR\",\"each\":true|false} — write a formula. Placeholders: \
{r} this row number, {c} this column letter, {r1}{c1} selection top-left, {r2}{c2} selection \
bottom-right, {R} row count, {C} col count. each=true stamps every selected cell; false writes \
only the anchor cell.\n\
 {\"do\":\"fmt\",\"fmt\":\"general|n0|n2|comma|cur|pct|pct0|date|time|text\"} — number format.\n\
 {\"do\":\"style\",\"style\":\"b,i,u,s,f:#fill,k:#ink,a:l|c|r\"} — bold/ital/underline/strike + \
fill/ink/align; any subset.\n\
 {\"do\":\"fill\",\"dir\":\"down|right|up|left\"} — extend the edge cell's formula over the range.\n\
 {\"do\":\"sort\",\"dir\":\"asc|desc\"} — sort by the selection's first column.\n\
 {\"do\":\"sum\"} — AutoSum each selected cell. {\"do\":\"clear\"} — empty the selection.\n\
Rules: 1-8 steps; pick steps that actually accomplish the described task; formulas must be valid \
Excel syntax the sheet supports (SUM AVERAGE IF COUNT MIN MAX ROUND VLOOKUP INDEX MATCH etc).\n\
CRITICAL: {r} is only the ROW NUMBER — ={r}*1.1 computes \"row×1.1\", nonsense. To transform each \
cell's own value, reference the cell itself as {c}{r} (column letter + row): \
\"add 10%\" → ={c}{r}*1.1, \"double it\" → ={c}{r}*2, \"flag low numbers\" → =IF({c}{r}<10,\"low\",\"ok\").\n\
Examples — \"running total\": formula =SUM(A$1:A{r}) each=true on a new column; \
\"mark overdue red\": style f:#ffc9c9; \"row totals\": formula =SUM({c1}{r}:{c2}{r}); \
\"percent of total\": formula ={c}{r}/SUM({c}$1:{c}${R}) + fmt pct.";

/// generate a reusable sheet tool spec from a natural-language description —
/// returns the model's raw reply; the sheet validates/sanitizes it client-side.
/// Leaves the mandatory activity trace either way.
#[tauri::command]
pub async fn sheet_tool_gen(app: AppHandle, prompt: String) -> Result<String, String> {
    let p = prompt.trim();
    if p.is_empty() {
        return Err("describe the tool first".into());
    }
    let p: String = p.chars().take(600).collect();
    let model = load_settings().model_rewrite;
    match chat_retry(&model, Some(SHEET_TOOL_SYSTEM), &p, 1600).await {
        Ok(raw) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✦ sheet tool drafted — {}", p.chars().take(48).collect::<String>()),
                },
            );
            Ok(raw)
        }
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("✕ sheet tool failed: {e}"),
                },
            );
            Err(e)
        }
    }
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
    // managed gateway picks the embed model server-side; direct BYOK needs a
    // concrete model id
    let model = if s.base_url.starts_with("https://laido.") {
        "auto"
    } else {
        "Qwen/Qwen3-Embedding-8B"
    };
    let body = serde_json::json!({
        "model": model,
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
