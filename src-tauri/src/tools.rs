use crate::state::load_settings;
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
pub struct TavilyPing {
    pub results: usize,
    pub first_title: String,
}

#[derive(Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub content: String,
}

/// arXiv Atom API — free, no key. Returns [] on any failure so callers can
/// treat it as an optional evidence lane.
pub async fn arxiv(query: &str, max: u32) -> Vec<SearchHit> {
    let q: String = query.chars().take(200).collect();
    let mut enc = String::new();
    for b in q.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            enc.push(b as char);
        } else {
            enc.push_str(&format!("%{b:02X}"));
        }
    }
    let url = format!(
        "http://export.arxiv.org/api/query?search_query=all:{enc}&start=0&max_results={max}&sortBy=relevance"
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();
    let Ok(resp) = client.get(&url).send().await else {
        return Vec::new();
    };
    let Ok(text) = resp.text().await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in text.split("<entry>").skip(1) {
        let pick = |tag: &str| -> String {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            block
                .split_once(&open)
                .and_then(|(_, r)| r.split_once(&close))
                .map(|(v, _)| v.split_whitespace().collect::<Vec<_>>().join(" "))
                .unwrap_or_default()
        };
        let title = pick("title");
        if title.is_empty() {
            continue;
        }
        let mut summary = pick("summary");
        summary.truncate(summary.floor_char_boundary(600));
        out.push(SearchHit {
            title,
            url: pick("id"),
            content: summary,
        });
    }
    out
}

pub async fn search(query: &str, max: u32) -> Result<Vec<SearchHit>, String> {
    let s = load_settings();
    if s.tavily_api_key.is_empty() {
        return Err("no Tavily key — add one in Settings".into());
    }
    let resp = reqwest::Client::new()
        .post("https://api.tavily.com/search")
        .bearer_auth(&s.tavily_api_key)
        .json(&json!({
            "query": query,
            "max_results": max,
            "search_depth": "basic"
        }))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v["results"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| SearchHit {
                    title: r["title"].as_str().unwrap_or("").to_string(),
                    url: r["url"].as_str().unwrap_or("").to_string(),
                    content: r["content"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn tavily_ping() -> Result<TavilyPing, String> {
    let hits = search("personal ai notepad", 3).await?;
    Ok(TavilyPing {
        results: hits.len(),
        first_title: hits
            .first()
            .map(|h| h.title.clone())
            .unwrap_or_else(|| "(none)".into()),
    })
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http(s) links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    let (program, args): (&str, Vec<&str>) = ("cmd", vec!["/C", "start", "", &url]);
    #[cfg(target_os = "macos")]
    let (program, args): (&str, Vec<&str>) = ("open", vec![&url]);
    #[cfg(target_os = "linux")]
    let (program, args): (&str, Vec<&str>) = ("xdg-open", vec![&url]);
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
