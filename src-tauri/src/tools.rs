use crate::state::load_settings;
use serde::{Deserialize, Serialize};
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

fn hits_from(v: &serde_json::Value) -> Vec<SearchHit> {
    v["results"]
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
        .unwrap_or_default()
}

/// one hit, upgraded: article urls get their real page text; pdf urls are
/// downloaded and embedded into the library so follow-up asks can cite them.
/// All hits enrich in parallel — total cost ≈ the slowest single fetch.
async fn enrich_hit(mut h: SearchHit, scope: &str) -> SearchHit {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(4))
        .user_agent("Laido/0.0.6 research fetcher")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let Ok((final_url, ctype, body)) = crate::rag::fetch_url(&client, &h.url).await else {
        return h; // keep the snippet when the page won't load
    };
    let is_pdf = ctype.contains("pdf")
        || final_url.split('?').next().unwrap_or("").to_lowercase().ends_with(".pdf");
    if is_pdf {
        let name = h
            .title
            .clone()
            .chars()
            .take(60)
            .collect::<String>();
        let name = if name.is_empty() { "web document".into() } else { name };
        match crate::rag::pdf_native_text(&body) {
            Ok(text) => {
                let head: String = text.chars().take(1500).collect();
                match crate::rag::ingest_text(
                    None,
                    name.clone(),
                    format!("SOURCE: {final_url}\n{name}\n\n{text}"),
                    "file",
                    scope.to_string(),
                    vec![crate::rag::SiteSource {
                        url: final_url.clone(),
                        title: name.clone(),
                        kind: "pdf".into(),
                        chunks: 0,
                    }],
                )
                .await
                {
                    Ok(slug) => {
                        h.content = format!(
                            "[embedded in your library as '{slug}' — cite or re-ask it with @document {slug}]\n{head}"
                        );
                    }
                    Err(_) => h.content = head,
                }
            }
            Err(_) => {} // scanned pdf — keep the snippet
        }
    } else if ctype.contains("html") || ctype.is_empty() {
        let text = crate::rag::html_to_text(&String::from_utf8_lossy(&body));
        if text.chars().count() > h.content.chars().count() {
            h.content = text.chars().take(4000).collect();
        }
    }
    h.url = final_url;
    h
}

pub async fn search(query: &str, max: u32, note: Option<&str>) -> Result<Vec<SearchHit>, String> {
    let s = load_settings();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    // managed (lk- / Laido cloud): the gateway holds the Tavily key — the
    // user never needs one and the server key is never sent to the client
    let managed = s.nebius_api_key.starts_with("lk-")
        || s.base_url.starts_with("https://laido.");
    let mut hits: Option<Vec<SearchHit>> = None;
    if managed && !s.nebius_api_key.is_empty() {
        let resp = client
            .post(format!("{}/search", s.base_url.trim_end_matches('/')))
            .bearer_auth(&s.nebius_api_key)
            .json(&json!({ "query": query, "max_results": max }))
            .send()
            .await;
        if let Ok(resp) = resp {
            if resp.status().is_success() {
                if let Ok(v) = resp.json::<serde_json::Value>().await {
                    hits = Some(hits_from(&v));
                }
            } else if s.tavily_api_key.is_empty() {
                let st = resp.status();
                let msg = resp.text().await.unwrap_or_default();
                return Err(format!("managed search failed (HTTP {st}): {msg}"));
            }
        }
        if hits.is_none() && s.tavily_api_key.is_empty() {
            return Err("managed search unreachable".into());
        }
    }
    if hits.is_none() {
        if s.tavily_api_key.is_empty() {
            return Err("no Tavily key — add one in Settings".into());
        }
        let resp = client
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
        hits = Some(hits_from(&v));
    }
    // enrich every hit in parallel: real page text replaces the snippet, and
    // pdf results are downloaded + embedded into the asking note's library
    let scope = note
        .filter(|n| !n.trim().is_empty() && *n != "sticky")
        .map(|n| format!("note:{n}"))
        .unwrap_or_else(|| "global".into());
    let hits = futures_util::future::join_all(
        hits.unwrap()
            .into_iter()
            .map(|h| enrich_hit(h, &scope)),
    )
    .await;
    Ok(hits)
}

#[tauri::command]
pub async fn tavily_ping() -> Result<TavilyPing, String> {
    let hits = search("personal ai notepad", 3, None).await?;
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
    // the url lands on a `cmd /C start` line — `"` or control chars could
    // break out of the argument quoting; real http urls never need them
    if url.contains('"') || url.chars().any(|c| c.is_control()) {
        return Err("invalid url".into());
    }
    // cmd /C start needs a console host — CREATE_NO_WINDOW keeps it hidden
    // so sign-in/plan links open the browser without a console flash
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string());
    #[cfg(all(unix, not(target_os = "macos")))]
    return std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string());
}

/* ---------- page fetch — the browser widget's reader lane + AI page context ------
 * Downloads a page, reports whether a <iframe> could render it (X-Frame-Options /
 * frame-ancestors), and extracts readable text so the AI can answer questions
 * about the page. */

#[derive(Serialize, Deserialize, Clone)]
pub struct PageInfo {
    pub url: String,        // requested
    pub final_url: String,  // after redirects
    pub title: String,
    pub text: String,       // readable extraction (capped)
    pub links: Vec<(String, String)>, // (text, absolute url) — top nav targets
    pub blocked: bool,      // XFO / frame-ancestors says no iframes
    pub walled: bool,       // login / bot wall — reader shows the sign-in lane
    pub status: u16,
}

/// <title> or og:title
fn html_title(html: &str) -> String {
    let low = html.to_lowercase();
    if let Some(i) = low.find("<title") {
        if let Some(g) = low[i..].find('>') {
            if let Some(e) = low[i + g..].find("</title") {
                let t = &html[i + g + 1..i + g + e];
                let t = decode_entities(t).trim().to_string();
                if !t.is_empty() {
                    return t;
                }
            }
        }
    }
    // og:title fallback
    if let Some(i) = low.find("property=\"og:title\"").or_else(|| low.find("name=\"og:title\"")) {
        let seg = &html[i..html.len().min(i + 400)];
        if let Some(c) = seg.find("content=\"") {
            let v = &seg[c + 9..];
            if let Some(e) = v.find('"') {
                return decode_entities(&v[..e]).trim().to_string();
            }
        }
    }
    String::new()
}

/// strip one html block -> readable text; block tags break lines.
/// Byte-walked: UTF-8 multibyte never contains ASCII < > so indexing is safe.
/// script/style/svg content is cut by scanning for its close tag directly --
/// script code can legally contain a bare < (var x = 1<2).
fn html_to_text(html: &str) -> String {
    const SKIP: &[&str] = &["script", "style", "svg", "noscript", "template"];
    const BREAK: &[&str] = &[
        "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "article", "header", "footer", "blockquote", "td", "th",
    ];
    let mut out: Vec<u8> = Vec::with_capacity(html.len() / 2);
    let mut i = 0usize;
    let mut skip: Option<String> = None;
    while i < html.len() {
        let rest = &html[i..];
        if let Some(sk) = &skip {
            // find </sk> -- nothing else inside counts
            let needle = format!("</{}", sk);
            match rest.to_lowercase().find(&needle) {
                Some(e) => {
                    let close_end = rest[e..].find('>').map(|g| e + g + 1).unwrap_or(rest.len());
                    i += close_end;
                    skip = None;
                }
                None => break,
            }
            continue;
        }
        if rest.starts_with("<!--") {
            match rest.find("-->") {
                Some(e) => {
                    i += e + 3;
                    continue;
                }
                None => break,
            }
        }
        if rest.starts_with('<') {
            let Some(g) = rest.find('>') else { break };
            let tag = &rest[..g];
            let name = tag
                .trim_start_matches('<')
                .trim_start_matches('/')
                .split(|ch: char| ch.is_whitespace() || ch == '/' || ch == '>')
                .next()
                .unwrap_or("")
                .to_lowercase();
            if !tag.starts_with("</") && SKIP.contains(&name.as_str()) {
                skip = Some(name);
            } else if BREAK.contains(&name.as_str()) && !out.ends_with(b"\n") && !out.is_empty() {
                out.push(b'\n');
            }
            i += g + 1;
            continue;
        }
        // text byte up to the next <
        let e = rest.find('<').unwrap_or(rest.len());
        out.extend_from_slice(&rest.as_bytes()[..e]);
        i += e;
    }
    let decoded = decode_entities(&String::from_utf8_lossy(&out));
    let mut lines: Vec<String> = Vec::new();
    for l in decoded.lines() {
        let t = l.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() {
            if lines.last().map(|p| !p.is_empty()) == Some(true) {
                lines.push(String::new());
            }
        } else {
            lines.push(t);
        }
    }
    lines.join("\n").trim().to_string()
}

pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(e) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        let ent = &rest[1..e.min(12)];
        match ent {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" | "39" => out.push('\''),
            "nbsp" => out.push(' '),
            "mdash" => out.push('—'),
            "ndash" => out.push('–'),
            "hellip" => out.push('…'),
            "lsquo" | "rsquo" => out.push('\''),
            "ldquo" | "rdquo" => out.push('"'),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                if let Ok(n) = u32::from_str_radix(&ent[2..], 16) {
                    out.push(char::from_u32(n).unwrap_or('?'));
                }
            }
            _ if ent.starts_with('#') => {
                if let Ok(n) = ent[1..].parse::<u32>() {
                    out.push(char::from_u32(n).unwrap_or('?'));
                }
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
                continue;
            }
        }
        rest = &rest[e + 1..];
    }
    out.push_str(rest);
    out
}

/// next `<a ` tag start — case-insensitive, byte-exact (lowercasing whole
/// haystacks would shift indices on non-ASCII pages)
fn find_anchor(rest: &str, mut from: usize) -> Option<usize> {
    loop {
        let i = rest[from..].find("<a")? + from;
        let tag = &rest[i..];
        if tag.len() > 2 && (tag.as_bytes()[2].is_ascii_whitespace() || tag.as_bytes()[2] == b'>') {
            return Some(i);
        }
        from = i + 2;
    }
}

/// <a href> harvest — nav targets for the reader view (relative → absolute)
fn html_links(html: &str, base: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut rest = html;
    while let Some(i) = find_anchor(rest, 0) {
        let seg = &rest[i..];
        let Some(e) = seg.find('>') else { break };
        let tag = &seg[..e];
        let tail = &rest[i + e..];
        let he = tail
            .find("</a>")
            .or_else(|| tail.find("</A>"))
            .unwrap_or(usize::MAX);
        if he == usize::MAX {
            break;
        }
        let body = &tail[1..he];
        rest = &tail[he..];
        let href = if let Some(h) = tag.find("href=\"") {
            tag[h + 6..].find('"').map(|e2| tag[h + 6..h + 6 + e2].to_string())
        } else if let Some(h) = tag.find("href='") {
            tag[h + 6..].find('\'').map(|e2| tag[h + 6..h + 6 + e2].to_string())
        } else {
            None
        };
        let _ = href;
        let Some(href) = href else { continue };
        let text = html_to_text(body).split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() || href.starts_with('#') || href.to_lowercase().starts_with("javascript:") {
            continue;
        }
        let abs = absolutize(base, &href);
        if !abs.is_empty() && out.iter().all(|(_, u)| u != &abs) {
            out.push((text.chars().take(80).collect(), abs));
        }
        if out.len() >= 60 {
            break;
        }
    }
    out
}

/// relative href → absolute against the page url
pub fn absolutize(base: &str, href: &str) -> String {
    let h = href.trim();
    if h.starts_with("http://") || h.starts_with("https://") || h.starts_with("data:") {
        return h.to_string();
    }
    if h.starts_with("//") {
        let scheme = base.split(':').next().unwrap_or("https");
        return format!("{scheme}:{h}");
    }
    let b = base.trim_end_matches('/');
    let scheme_auth_end = b.find("://").map(|i| i + 3).unwrap_or(0);
    let after = &b[scheme_auth_end..];
    let host_end = after.find('/').map(|i| scheme_auth_end + i).unwrap_or(b.len());
    let origin = &b[..host_end];
    if h.starts_with('/') {
        return format!("{origin}{h}");
    }
    // relative to the page's directory
    let dir = match b[host_end.min(b.len())..].rfind('/') {
        Some(i) => &b[..host_end.min(b.len()) + i + 1],
        None => &format!("{origin}/")[..],
    };
    format!("{dir}{h}")
}

/// iframe-hostile?  X-Frame-Options or frame-ancestors in CSP
fn frame_blocked(map: &reqwest::header::HeaderMap) -> bool {
    if let Some(xfo) = map.get("x-frame-options").and_then(|v| v.to_str().ok()) {
        let v = xfo.to_lowercase();
        if v.contains("deny") || v.contains("sameorigin") {
            return true;
        }
    }
    if let Some(csp) = map.get("content-security-policy").and_then(|v| v.to_str().ok()) {
        if let Some(i) = csp.to_lowercase().find("frame-ancestors") {
            let seg = &csp[i..csp.len().min(i + 300)];
            let seg = seg.split(';').next().unwrap_or(seg);
            if seg.contains("'none'") || seg.contains("'self'") {
                return true;
            }
        }
    }
    false
}

/// One client for the whole app — the cookie store makes consent walls
/// resolve the way a real browser does (first hit sets the cookie, the
/// retry passes it), and pooled connections keep nav snappy.
fn page_client() -> &'static reqwest::Client {
    use reqwest::header::{HeaderMap, HeaderValue};
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut heads = HeaderMap::new();
        heads.insert("accept", HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"));
        heads.insert("accept-language", HeaderValue::from_static("en-US,en;q=0.9"));
        heads.insert("upgrade-insecure-requests", HeaderValue::from_static("1"));
        heads.insert("sec-fetch-dest", HeaderValue::from_static("document"));
        heads.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
        heads.insert("sec-fetch-site", HeaderValue::from_static("none"));
        heads.insert("sec-fetch-user", HeaderValue::from_static("?1"));
        heads.insert("sec-ch-ua", HeaderValue::from_static("\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\""));
        heads.insert("sec-ch-ua-mobile", HeaderValue::from_static("?0"));
        heads.insert("sec-ch-ua-platform", HeaderValue::from_static("\"Windows\""));
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .default_headers(heads)
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// bytes → text honoring the response's declared charset, else a
/// `<meta charset>` sniff, else UTF-8. Fixes mojibake on windows-1252 /
/// Shift-JIS pages that don't send a charset header.
fn decode_body(bytes: &[u8], ctype: &str) -> String {
    let mut label = ctype
        .split(';')
        .find_map(|p| p.trim().strip_prefix("charset="))
        .map(|s| s.trim_matches('"').to_string());
    if label.is_none() {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_lowercase();
        if let Some(i) = head.find("charset") {
            let seg = &head[i + 7..head.len().min(i + 40)];
            let seg = seg.trim_start_matches([' ', '=', '"', '\'']);
            let end = seg
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .unwrap_or(seg.len());
            let l = seg[..end].to_string();
            if !l.is_empty() {
                label = Some(l);
            }
        }
    }
    let enc = label
        .as_deref()
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    enc.decode(bytes).0.into_owned()
}

/// `<meta http-equiv=refresh content="0;url=…">` — the last redirect lane
/// servers use when they can't send a 3xx (consent gates, region hops).
fn meta_refresh_url(html: &str, base: &str) -> Option<String> {
    let low = html.to_lowercase();
    let m = low.find("http-equiv=\"refresh\"").or_else(|| low.find("http-equiv='refresh'"))?;
    let seg = &low[m..low.len().min(m + 500)];
    let c = seg.find("content=")?;
    let val = &seg[c + 8..];
    let q = val.chars().next()?;
    let end = val[1..].find(q)? + 1;
    let content = &val[1..end];
    let (_, u) = content.split_once("url=")?;
    let abs = absolutize(base, u.trim());
    (abs.starts_with("http")).then_some(abs)
}

/// A page that says "log in / enable js / something went wrong" instead of
/// content. Only flagged on thin pages — real articles mention these words.
fn is_wall(status: u16, title: &str, text: &str) -> bool {
    if matches!(status, 401 | 403) && text.len() < 4_000 {
        return true;
    }
    if text.len() > 2_000 {
        return false;
    }
    let hay = format!("{title}\n{}", &text[..text.len().min(2_000)]).to_lowercase();
    const SIGNS: &[&str] = &[
        "log in to", "log into", "login to", "sign in to", "sign into",
        "you must log in", "please log in", "forgot password",
        "forgotten your password", "create an account", "create new account",
        "enable javascript", "javascript is disabled", "javascript is required",
        "just a moment", "checking your browser", "verify you are",
        "are you a robot", "something went wrong", "unusual traffic",
        "access denied", "prove you're not a robot", "captcha",
    ];
    SIGNS.iter().any(|s| hay.contains(s))
}

#[tauri::command]
pub async fn page_fetch(url: String) -> Result<PageInfo, String> {
    let mut url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not a web url".into());
    }
    let client = page_client();
    let (mut status, mut blocked, mut final_url, mut body) = (0u16, false, String::new(), String::new());
    // meta-refresh hops ride on top of reqwest's 3xx following
    for _ in 0..3 {
        let resp = client.get(&url).send().await.map_err(|e| format!("fetch failed: {e}"))?;
        status = resp.status().as_u16();
        blocked = frame_blocked(resp.headers());
        final_url = resp.url().to_string();
        let ctype = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if !(ctype.contains("html") || ctype.is_empty()) {
            body = String::new();
            break;
        }
        body = decode_body(&bytes, &ctype);
        match meta_refresh_url(&body, &final_url) {
            Some(next) if next != final_url => url = next,
            _ => break,
        }
    }
    let (title, text, links) = if !body.is_empty() {
        let mut t = html_to_text(&body);
        t.truncate(t.floor_char_boundary(48_000));
        (html_title(&body), t, html_links(&body, &final_url))
    } else {
        (String::new(), String::new(), Vec::new())
    };
    let walled = is_wall(status, &title, &text);
    Ok(PageInfo { url, final_url, title, text, links, blocked, walled, status })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
<html><head><title>Concrete &amp; Co — Prices</title>
<style>body{color:red}</style><script>var x=1<2;</script></head>
<body>
<header><a href="/home">Home</a><a href="about.html">About us</a></header>
<h1>Cement &amp; Supplies</h1>
<p>A bag of <b>cement</b> costs $14.50 &mdash; delivered.</p>
<div>Line one</div><div>Line&nbsp;two &#8212; more</div>
<!-- a comment with <b>fake</b> -->
<ul><li>first</li><li>second &lt;item&gt;</li></ul>
<svg><text>hidden</text></svg>
<a href="https://x.test/dup">dup</a><a href="https://x.test/dup">dup</a>
</body></html>"#;

    #[test]
    fn text_extracts_readable() {
        let t = html_to_text(FIXTURE);
        assert!(t.contains("Cement & Supplies"));
        assert!(t.contains("bag of cement costs $14.50 — delivered"));
        assert!(t.contains("first\nsecond <item>") || t.contains("second <item>"));
        assert!(!t.contains("color:red"));
        assert!(!t.contains("var x"));
        assert!(!t.contains("hidden"));
        assert!(!t.contains("fake"));
    }

    #[test]
    fn title_prefers_tag() {
        assert_eq!(html_title(FIXTURE), "Concrete & Co — Prices");
        assert_eq!(html_title("<p>no title</p>"), "");
    }

    #[test]
    fn links_resolve_and_dedupe() {
        let ls = html_links(FIXTURE, "https://x.test/pages/index.html");
        assert!(ls.iter().any(|(t, u)| t == "Home" && u == "https://x.test/home"));
        assert!(ls.iter().any(|(t, u)| t == "About us" && u == "https://x.test/pages/about.html"));
        assert_eq!(ls.iter().filter(|(_, u)| u == "https://x.test/dup").count(), 1);
    }

    #[test]
    fn absolutize_paths() {
        assert_eq!(absolutize("https://a.b/c/d.html", "/x"), "https://a.b/x");
        assert_eq!(absolutize("https://a.b/c/d.html", "e.html"), "https://a.b/c/e.html");
        assert_eq!(absolutize("https://a.b", "e.html"), "https://a.b/e.html");
        assert_eq!(absolutize("https://a.b/", "//c.d/x"), "https://c.d/x");
    }

    #[tokio::test]
    #[ignore] // live network — run with: cargo test live_page_fetch -- --ignored
    async fn live_page_fetch() {
        let p = page_fetch("https://example.com".into()).await.unwrap();
        assert_eq!(p.status, 200);
        assert!(p.title.to_lowercase().contains("example"));
        assert!(!p.text.is_empty());
        assert!(p.text.to_lowercase().contains("domain"));
        println!("title={} text={}chars links={}", p.title, p.text.len(), p.links.len());
    }

    #[test]
    fn entities_decode() {
        assert_eq!(decode_entities("a &amp; b &#65; &#x41; &nbsp;c"), "a & b A A  c");
    }
}
