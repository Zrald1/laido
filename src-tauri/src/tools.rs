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
    // the url lands on a `cmd /C start` line — `"` or control chars could
    // break out of the argument quoting; real http urls never need them
    if url.contains('"') || url.chars().any(|c| c.is_control()) {
        return Err("invalid url".into());
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

#[tauri::command]
pub async fn page_fetch(url: String) -> Result<PageInfo, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("not a web url".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status().as_u16();
    let blocked = frame_blocked(resp.headers());
    let final_url = resp.url().to_string();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let (title, text, links) = if ctype.contains("html") || ctype.is_empty() {
        let mut t = html_to_text(&body);
        t.truncate(t.floor_char_boundary(48_000));
        (html_title(&body), t, html_links(&body, &final_url))
    } else {
        (String::new(), String::new(), Vec::new())
    };
    Ok(PageInfo { url, final_url, title, text, links, blocked, status })
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
