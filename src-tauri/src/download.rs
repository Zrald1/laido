/* ---------- download engine — IDM-style segmented parallel fetch ----------
 * the composite the sim proved: elastic in-half work-stealing across N
 * range connections (capped at the resonance point), a stall watchdog
 * that tunnels a dead stream into a fresh socket, and positional writes
 * so no assembly pass is needed. Downloads land in
 *   Downloads\Laido\<category>\  — compressed, documents, programs,
 *   video, music, images, other — the IDM folder convention.
 */
use serde::Serialize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const CHUNK: usize = 64 * 1024;
const MIN_SEG: u64 = 256 * 1024; // don't split below useful size
const MAX_CONN: usize = 8; // IDM's default
const PARALLEL_MIN: u64 = 2 * 1024 * 1024; // under 2MB a second socket costs more than it earns
const STALL_MS: u128 = 2500; // no bytes this long → tunnel re-open
const STALL_RATIO: f64 = 0.18; // or <18% of fleet median for 1.5s

#[derive(Clone, Serialize)]
pub struct DlInfo {
    pub id: String,
    pub url: String,
    pub path: String,
    pub category: String,
    pub total: u64,
    pub got: u64,
    pub segs: usize,
    pub state: String, // probing|running|done|error|canceled|partial
    pub mbps: f64,
    pub err: String,
    pub elapsed_ms: u128,
}

struct Job {
    url: String,
    path: String,
    category: String,
    total: AtomicU64,
    got: AtomicU64,
    conns: usize,
    rangeable: bool,
    state: Mutex<String>,
    err: Mutex<String>,
    cancel: AtomicBool,
    paused: AtomicBool,
    /* pause keeps these alive — resume respawns workers on the same
     * pending range queue + positional .part file */
    queue: OnceLock<std::sync::Arc<Mutex<Queue>>>,
    file: OnceLock<std::sync::Arc<std::fs::File>>,
    started: Instant,
}

static DL_SEQ: AtomicU64 = AtomicU64::new(0);
static JOBS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Job>>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, std::sync::Arc<Job>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn category_of(name: &str, mime: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let m = |list: &[&str]| list.contains(&ext.as_str());
    if m(&["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"]) || mime.contains("zip") {
        "compressed"
    } else if m(&[
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "epub", "rtf", "md", "odt",
    ]) {
        "documents"
    } else if m(&[
        "exe", "msi", "msix", "appx", "dmg", "pkg", "deb", "rpm", "apk", "bat", "ps1",
    ]) {
        "programs"
    } else if m(&[
        "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts",
    ]) || mime.starts_with("video/") {
        "video"
    } else if m(&["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus"]) || mime.starts_with("audio/") {
        "music"
    } else if m(&[
        "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic", "avif",
    ]) || mime.starts_with("image/") {
        "images"
    } else {
        "other"
    }
}

/* tiny percent-decoder — enough for Content-Disposition + url filenames */
fn pct_dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if b[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(b[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn filename_of(url: &str, cd: Option<&str>) -> String {
    if let Some(cd) = cd {
        for part in cd.split(';') {
            let p = part.trim();
            if let Some(f) = p.strip_prefix("filename*=") {
                let f = f.trim().trim_matches('"');
                let f = f.rsplit("''").next().unwrap_or(f);
                let dec = pct_dec(f);
                if !dec.is_empty() {
                    return dec;
                }
            }
        }
        for part in cd.split(';') {
            let p = part.trim();
            if let Some(f) = p.strip_prefix("filename=") {
                let f = f.trim().trim_matches('"');
                if !f.is_empty() {
                    return f.rsplit(['/', '\\']).next().unwrap_or(f).to_string();
                }
            }
        }
    }
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or("");
    let last = pct_dec(last);
    if last.is_empty() || !last.contains('.') {
        format!("download-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"))
    } else {
        last
    }
}

fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    for i in 1..999 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}

/* ---- the work queue: unclaimed ranges + live in-flight ranges that can
 * still be halved — the elastic steal that kills the straggler tail ---- */
struct Live {
    pos: AtomicU64,
    end: AtomicU64,
    _rate: AtomicU64, // reserved for finer stall telemetry
}
struct Queue {
    pending: VecDeque<(u64, u64)>,
    live: HashMap<usize, std::sync::Arc<Live>>,
}
impl Queue {
    fn take(q: &Mutex<Self>, wid: usize) -> Option<(u64, u64, std::sync::Arc<Live>)> {
        let mut q = q.lock().unwrap();
        if let Some((a, b)) = q.pending.pop_front() {
            let live = std::sync::Arc::new(Live {
                pos: AtomicU64::new(a),
                end: AtomicU64::new(b),
                _rate: AtomicU64::new(0),
            });
            q.live.insert(wid, live.clone());
            return Some((a, b, live));
        }
        /* nothing queued — halve the largest in-flight range (in-half
         * steal, splitting queued AND active work like real IDM) */
        let (victim, rem) = q
            .live
            .iter()
            .filter(|(_, l)| l.end.load(Ordering::Relaxed) > l.pos.load(Ordering::Relaxed))
            .map(|(i, l)| (*i, l.end.load(Ordering::Relaxed) - l.pos.load(Ordering::Relaxed)))
            .max_by_key(|(_, r)| *r)
            .map(|(i, r)| (i, r))?;
        if rem < MIN_SEG * 2 {
            return None;
        }
        let vl = q.live.get(&victim)?.clone();
        let pos = vl.pos.load(Ordering::Relaxed);
        let end = vl.end.load(Ordering::Relaxed);
        let mid = pos + (end - pos) / 2;
        vl.end.store(mid, Ordering::Relaxed); // victim shrinks; loop re-reads
        let live = std::sync::Arc::new(Live {
            pos: AtomicU64::new(mid),
            end: AtomicU64::new(end),
            _rate: AtomicU64::new(0),
        });
        q.live.insert(wid, live.clone());
        Some((mid, end, live))
    }
    fn requeue(q: &Mutex<Self>, wid: usize) {
        /* a dead/tunneled worker gives its remaining range back */
        let mut q = q.lock().unwrap();
        if let Some(l) = q.live.remove(&wid) {
            let pos = l.pos.load(Ordering::Relaxed);
            let end = l.end.load(Ordering::Relaxed);
            if end > pos {
                q.pending.push_front((pos, end));
            }
        }
    }
    fn done_seg(q: &Mutex<Self>, wid: usize) {
        q.lock().unwrap().live.remove(&wid);
    }
}

/* url → (job id, when) — intercepts the same click arriving through two
 * lanes (webview on_download AND the extension's POST) and user double-
 * clicks: the second caller gets the live job back, not a second file */
fn recent() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static R: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn dl_start(app: tauri::AppHandle, url: String, conns: Option<u8>) -> Result<serde_json::Value, String> {
    {
        let mut r = recent().lock().unwrap();
        r.retain(|_, (_, at)| at.elapsed().as_secs() < 8);
        if let Some((id, _)) = r.get(&url) {
            let j = jobs().lock().unwrap().get(id).cloned();
            if let Some(j) = j {
                ensure_toast(&app);
                return Ok(serde_json::json!({
                    "id": id, "path": j.path, "category": j.category,
                    "total": j.total.load(Ordering::Relaxed), "dedupe": true,
                }));
            }
        }
    }
    let client = reqwest::Client::builder()
        .user_agent("Laido/0.3 (segmented downloader)")
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    /* probe — ranges? size? real filename? mime? */
    let head = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("probe failed: {e}"))?;
    let h = head.headers();
    let total = h
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let rangeable = h
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("bytes"))
        .unwrap_or(false);
    let mime = h
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cd = h
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let final_url = head.url().to_string();
    let name = filename_of(&final_url, cd.as_deref());
    let category = category_of(&name, &mime);

    let base = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or("no Downloads folder")?;
    let dir = base.join("Laido").join(category);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_path(&dir, &name);

    let id = format!(
        "dl-{:x}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        DL_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let job = std::sync::Arc::new(Job {
        url: final_url.clone(),
        path: path.to_string_lossy().to_string(),
        category: category.into(),
        total: AtomicU64::new(total),
        got: AtomicU64::new(0),
        conns: if rangeable && total >= PARALLEL_MIN {
            conns
                .map(|c| (c as usize).clamp(1, 16))
                .unwrap_or_else(|| MAX_CONN.min(((total / (MIN_SEG * 2)).max(1)) as usize))
        } else {
            1
        },
        rangeable,
        state: Mutex::new("running".into()),
        err: Mutex::new(String::new()),
        cancel: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        queue: OnceLock::new(),
        file: OnceLock::new(),
        started: Instant::now(),
    });
    /* an identical url mid-flight is the same download — webview
     * on_download + extension can both forward one click */
    {
        let mut r = recent().lock().unwrap();
        r.retain(|_, (_, at)| at.elapsed().as_secs() < 8);
        r.insert(url.clone(), (id.clone(), Instant::now()));
    }
    jobs().lock().unwrap().insert(id.clone(), job.clone());

    ensure_toast(&app);
    {
        use tauri::Emitter;
        let _ = app.emit("dl:prog", info_of(&id, &job));
    }
    tauri::async_runtime::spawn(run_job(app, id.clone(), job, client));
    Ok(serde_json::json!({
        "id": id, "path": path.to_string_lossy(), "category": category,
        "name": name, "total": total, "rangeable": rangeable,
        "conns": jobs().lock().unwrap().get(&id).map(|j| j.conns).unwrap_or(1),
    }))
}

async fn run_job(app: tauri::AppHandle, id: String, job: std::sync::Arc<Job>, client: reqwest::Client) {
    use tauri::Emitter;
    let res = run_inner(&app, &id, &job, &client).await;
    if job.paused.load(Ordering::Relaxed) {
        *job.state.lock().unwrap() = "paused".into();
        let _ = app.emit("dl:prog", info_of(&id, &job));
        return;
    }
    match res {
        Ok(()) => *job.state.lock().unwrap() = "done".into(),
        Err(e) => {
            let mut st = job.state.lock().unwrap();
            if *st == "canceled" {
                /* keep canceled */
            } else {
                *job.err.lock().unwrap() = e;
                *st = "error".into();
            }
        }
    }
    let _ = app.emit("dl:prog", info_of(&id, &job));
}

async fn run_inner(
    app: &tauri::AppHandle,
    id: &str,
    job: &std::sync::Arc<Job>,
    client: &reqwest::Client,
) -> Result<(), String> {
    let total = job.total.load(Ordering::Relaxed);
    /* temp .part file pre-sized — workers seek_write into it; renamed on
     * completion so a half file never impersonates a finished one */
    let final_path = std::path::PathBuf::from(&job.path);
    let tmp = final_path.with_extension("laido-part");
    {
        let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        if total > 0 {
            f.set_len(total).map_err(|e| e.to_string())?;
        }
    }
    let file = std::sync::Arc::new(std::fs::File::options().write(true).open(&tmp).map_err(|e| e.to_string())?);
    let _ = job.file.set(file.clone());

    let queue = std::sync::Arc::new(Mutex::new(Queue {
        pending: VecDeque::from([(0u64, if total > 0 { total } else { u64::MAX })]),
        live: HashMap::new(),
    }));
    let _ = job.queue.set(queue.clone());
    let mut handles = spawn_workers(&job, &client, &file, &queue);
    let prog = spawn_prog(app, id, &job);
    let mut first_err = String::new();
    for h in handles.drain(..) {
        match h.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                if first_err.is_empty() {
                    first_err = e;
                }
            }
            Err(e) => {
                if first_err.is_empty() {
                    first_err = e.to_string();
                }
            }
        }
    }
    prog.abort();
    if job.cancel.load(Ordering::Relaxed) {
        *job.state.lock().unwrap() = "canceled".into();
        let _ = std::fs::remove_file(&tmp);
        return Err("canceled".into());
    }
    if job.paused.load(Ordering::Relaxed) {
        /* workers requeued their ranges into job.queue — keep the .part,
         * keep the queue; dl_resume respawns from here */
        return Ok(());
    }
    finalize_tail(&final_path, &tmp, total, &job, first_err)
}

/* the tail shared by run_inner and a resume: learn total for chunked
 * streams, guard materially-incomplete files, then .part → rename */
fn finalize_tail(
    final_path: &std::path::Path,
    tmp: &std::path::Path,
    total: u64,
    job: &std::sync::Arc<Job>,
    mut first_err: String,
) -> Result<(), String> {
    if total == 0 {
        job.total.store(job.got.load(Ordering::Relaxed), Ordering::Relaxed);
    }
    let want = job.total.load(Ordering::Relaxed);
    let got = job.got.load(Ordering::Relaxed);
    if want > 0 && got + CHUNK as u64 * 2 < want {
        /* materially incomplete — keep the .part so a resume can pick up */
        if first_err.is_empty() {
            first_err = format!("incomplete: {got}/{want} bytes");
        }
        return Err(first_err);
    }
    if !first_err.is_empty() && got == 0 {
        let _ = std::fs::remove_file(&tmp);
        return Err(first_err);
    }
    std::fs::rename(tmp, final_path).map_err(|e| format!("finalize: {e}"))?;
    /* windows file manager refresh */
    let _ = std::fs::File::open(final_path);
    Ok(())
}

fn mbps(job: &Job) -> f64 {
    let el = job.started.elapsed().as_secs_f64().max(0.05);
    job.got.load(Ordering::Relaxed) as f64 / 1048576.0 / el
}

fn spawn_workers(
    job: &std::sync::Arc<Job>,
    client: &reqwest::Client,
    file: &std::sync::Arc<std::fs::File>,
    queue: &std::sync::Arc<Mutex<Queue>>,
) -> Vec<tokio::task::JoinHandle<Result<(), String>>> {
    (0..job.conns.max(1))
        .map(|wid| {
            tokio::spawn(worker(
                wid,
                job.clone(),
                client.clone(),
                file.clone(),
                queue.clone(),
            ))
        })
        .collect()
}

fn spawn_prog(app: &tauri::AppHandle, id: &str, job: &std::sync::Arc<Job>) -> tokio::task::JoinHandle<()> {
    use tauri::Emitter;
    let job = job.clone();
    let app = app.clone();
    let id = id.to_string();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if job.state.lock().unwrap().as_str() != "running" {
                break;
            }
            let _ = app.emit(
                "dl:prog",
                serde_json::json!({
                    "id": id,
                    "got": job.got.load(Ordering::Relaxed),
                    "total": job.total.load(Ordering::Relaxed),
                    "mbps": mbps(&job),
                    "state": "running",
                    "path": job.path,
                    "url": job.url,
                }),
            );
        }
    })
}

async fn worker(
    wid: usize,
    job: std::sync::Arc<Job>,
    client: reqwest::Client,
    file: std::sync::Arc<std::fs::File>,
    queue: std::sync::Arc<Mutex<Queue>>,
) -> Result<(), String> {
    loop {
        if job.cancel.load(Ordering::Relaxed) || job.paused.load(Ordering::Relaxed) {
            return Ok(());
        }
        let Some((_, _, live)) = Queue::take(&queue, wid) else {
            return Ok(()); // no queued or splittable work left — stand down
        };
        let mut tries = 0u32;
        'segment: loop {
            if job.cancel.load(Ordering::Relaxed) || job.paused.load(Ordering::Relaxed) {
                Queue::requeue(&queue, wid);
                return Ok(());
            }
            let pos = live.pos.load(Ordering::Relaxed);
            let end = live.end.load(Ordering::Relaxed);
            if pos >= end {
                Queue::done_seg(&queue, wid);
                break 'segment; // segment finished — steal again
            }
            /* fallback path: a server that answered no Accept-Ranges (or a
             * stream of unknown length) gets a plain GET — a bogus range
             * header would just buy a 416 */
            let mut r = client.get(&job.url);
            if job.rangeable && end != u64::MAX {
                let range = format!("bytes={}-{}", pos, end.saturating_sub(1));
                r = r.header(reqwest::header::RANGE, &range);
            }
            /* the stall watchdog covers chunks, not the request itself —
             * a server that accepts the socket but never answers (common
             * right after a pause/reconnect storm) would hang the worker
             * forever and freeze the job at "running" with zero bytes */
            let req = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                r.send(),
            )
            .await;
            let mut resp = match req {
                Ok(Ok(r)) if r.status().is_success() || r.status() == reqwest::StatusCode::PARTIAL_CONTENT => {
                    tries = 0;
                    r
                }
                /* 429/5xx + transient connect fails — the range isn't dead,
                 * the server is rate-limiting; honor Retry-After, else
                 * exponential backoff, bounded */
                Ok(Ok(r)) if (r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || r.status().is_server_error())
                    && tries < 6 =>
                {
                    let wait = r
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(|s| s * 1000)
                        .unwrap_or(700 * tries as u64 + 400);
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                    continue 'segment;
                }
                Ok(Ok(r)) => return Err(format!("http {}", r.status())),
                Ok(Err(e)) if tries < 6 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(500 * tries as u64)).await;
                    let _ = e;
                    continue 'segment;
                }
                Ok(Err(e)) => {
                    Queue::requeue(&queue, wid);
                    return Err(format!("connect: {e}"));
                }
                /* send() itself timed out — same as a connect failure:
                 * brief backoff then another socket */
                Err(_) if tries < 6 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(500 * tries as u64)).await;
                    continue 'segment;
                }
                Err(_) => {
                    Queue::requeue(&queue, wid);
                    return Err("request timed out".into());
                }
            };
            let mut cursor = pos;
            let mut window = 0u64;
            let mut window_at = Instant::now();
            /* stream the range; per-chunk stall watchdog — a dead pipe
             * tunnels: remaining range requeues, a fresh socket takes it */
            while cursor < live.end.load(Ordering::Relaxed) {
                if job.paused.load(Ordering::Relaxed) || job.cancel.load(Ordering::Relaxed) {
                    live.pos.store(cursor, Ordering::Relaxed);
                    Queue::requeue(&queue, wid);
                    return Ok(());
                }
                let item = tokio::time::timeout(
                    std::time::Duration::from_millis(STALL_MS as u64 * 2),
                    resp.chunk(),
                )
                .await;
                let chunk = match item {
                    Ok(Ok(Some(b))) => b,
                    Ok(Err(e)) => {
                        live.pos.store(cursor, Ordering::Relaxed);
                        Queue::requeue(&queue, wid);
                        return Err(format!("stream: {e}"));
                    }
                    Ok(Ok(None)) => break, // server closed early
                    Err(_) => {
                        live.pos.store(cursor, Ordering::Relaxed);
                        Queue::requeue(&queue, wid);
                        return Err("stalled".into());
                    }
                };
                /* write at the exact offset — positional writes mean no
                 * assembly pass when the last segment lands. Truncate at
                 * live.end: a split can shrink our range mid-chunk, and
                 * bytes past it belong to the new owner — writing them
                 * anyway double-counts `got` (the owner re-writes them) */
                let lim = live.end.load(Ordering::Relaxed);
                let take = ((lim - cursor).min(chunk.len() as u64)) as usize;
                if take == 0 {
                    Queue::done_seg(&queue, wid);
                    break 'segment;
                }
                write_at(&file, cursor, &chunk[..take]).map_err(|e| e.to_string())?;
                cursor += take as u64;
                live.pos.store(cursor, Ordering::Relaxed);
                job.got.fetch_add(take as u64, Ordering::Relaxed);
                window += take as u64;
                /* slow-lane check: <18% of 2MB/s baseline for 1.5s+ → tunnel */
                if window_at.elapsed().as_millis() > STALL_MS {
                    let rate = window as f64 / window_at.elapsed().as_secs_f64();
                    if rate < 2_000_000.0 * STALL_RATIO
                        && live.end.load(Ordering::Relaxed).saturating_sub(cursor) > MIN_SEG
                    {
                        live.pos.store(cursor, Ordering::Relaxed);
                        Queue::requeue(&queue, wid);
                        break 'segment; // requeue + retake = fresh socket
                    }
                    window = 0;
                    window_at = Instant::now();
                }
            }
            live.pos.store(cursor, Ordering::Relaxed);
            if cursor >= live.end.load(Ordering::Relaxed) {
                Queue::done_seg(&queue, wid);
            } else {
                /* fell out mid-range (server closed early / stalled) —
                 * remaining bytes go back so any worker reopens them */
                Queue::requeue(&queue, wid);
            }
            break 'segment;
        }
    }
}

#[cfg(windows)]
fn write_at(f: &std::fs::File, off: u64, buf: &[u8]) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    f.seek_write(buf, off).map(|_| ())
}
#[cfg(unix)]
fn write_at(f: &std::fs::File, off: u64, buf: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_all_at(buf, off).map(|_| ())
}

#[tauri::command]
pub async fn dl_info(id: String) -> Result<DlInfo, String> {
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    Ok(info_of(&id, &job))
}

#[tauri::command]
pub async fn dl_list() -> Result<Vec<DlInfo>, String> {
    let m = jobs().lock().unwrap();
    Ok(m.iter().map(|(id, j)| info_of(id, j)).collect())
}

#[tauri::command]
pub async fn dl_cancel(id: String) -> Result<(), String> {
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    job.cancel.store(true, Ordering::Relaxed);
    *job.state.lock().unwrap() = "canceled".into();
    Ok(())
}

#[tauri::command]
pub async fn dl_pause(id: String) -> Result<(), String> {
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    if job.state.lock().unwrap().as_str() != "running" {
        return Err("not running".into());
    }
    /* workers drain: each requeues its in-flight range then exits —
     * run_inner sees `paused` and parks the .part + queue for resume */
    job.paused.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn dl_resume(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Emitter;
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    if job.state.lock().unwrap().as_str() != "paused" {
        return Err("not paused".into());
    }
    let (Some(queue), Some(file)) = (job.queue.get().cloned(), job.file.get().cloned()) else {
        return Err("nothing to resume".into());
    };
    /* a non-rangeable stream can't seek — its remaining range is
     * meaningless, restart from byte 0 (part file is overwritten) */
    if !job.rangeable {
        job.got.store(0, Ordering::Relaxed);
        let mut q = queue.lock().unwrap();
        q.pending.clear();
        q.live.clear();
        q.pending.push_back((0u64, u64::MAX));
    }
    job.paused.store(false, Ordering::Relaxed);
    *job.state.lock().unwrap() = "running".into();
    let _ = app.emit("dl:prog", info_of(&id, &job));
    let client = reqwest::Client::builder()
        .user_agent("Laido/0.3 (segmented downloader)")
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let mut handles = spawn_workers(&job, &client, &file, &queue);
        let prog = spawn_prog(&app2, &id, &job);
        let mut first_err = String::new();
        for h in handles.drain(..) {
            match h.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_err.is_empty() {
                        first_err = e;
                    }
                }
                Err(e) => {
                    if first_err.is_empty() {
                        first_err = e.to_string();
                    }
                }
            }
        }
        prog.abort();
        if job.paused.load(Ordering::Relaxed) {
            *job.state.lock().unwrap() = "paused".into();
            let _ = app2.emit("dl:prog", info_of(&id, &job));
            return;
        }
        if job.cancel.load(Ordering::Relaxed) {
            *job.state.lock().unwrap() = "canceled".into();
            let tmp = std::path::PathBuf::from(&job.path).with_extension("laido-part");
            let _ = std::fs::remove_file(&tmp);
            let _ = app2.emit("dl:prog", info_of(&id, &job));
            return;
        }
        let final_path = std::path::PathBuf::from(&job.path);
        let tmp = final_path.with_extension("laido-part");
        let res = finalize_tail(&final_path, &tmp, job.total.load(Ordering::Relaxed), &job, first_err);
        match res {
            Ok(()) => *job.state.lock().unwrap() = "done".into(),
            Err(e) => {
                *job.err.lock().unwrap() = e;
                *job.state.lock().unwrap() = "error".into();
            }
        }
        let _ = app2.emit("dl:prog", info_of(&id, &job));
    });
    Ok(())
}

#[tauri::command]
pub async fn dl_open(id: String) -> Result<(), String> {
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    #[cfg(windows)]
    {
        let p = job.path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(&p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(&job.path).spawn()
            .or_else(|_| std::process::Command::new("open").arg(&job.path).spawn());
    }
    Ok(())
}

#[tauri::command]
pub async fn dl_reveal(id: String) -> Result<(), String> {
    let job = jobs().lock().unwrap().get(&id).cloned().ok_or("no download")?;
    #[cfg(windows)]
    {
        let p = job.path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{p}"))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let dir = std::path::Path::new(&job.path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn()
            .or_else(|_| std::process::Command::new("open").arg(&dir).spawn());
    }
    Ok(())
}

/* ---------- the toast — a small always-on-top surface pinned to the
 * bottom-right of the work area; every download shows speed + pause/
 * cancel there instead of a shelf. Spawned lazily on the first job and
 * re-spawned any time it was closed — webview creation goes through the
 * same env-churn gate as popouts/engines. */
static TOAST_SPAWNING: AtomicBool = AtomicBool::new(false);
pub fn ensure_toast(app: &tauri::AppHandle) {
    use tauri::Manager;
    /* retries relabel the toast (dl-toast, -r1, -r2) — the "exists"
     * check scans by prefix so a recovered attempt still counts */
    if app
        .webview_windows()
        .keys()
        .any(|l| l.starts_with("dl-toast"))
    {
        return;
    }
    if TOAST_SPAWNING.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        /* bottom-right of the primary monitor's work area */
        let mut x = 100.0f64;
        let mut y = 100.0f64;
        const W: f64 = 372.0;
        const H: f64 = 236.0;
        if let Ok(Some(mon)) = app.primary_monitor() {
            let wa = mon.work_area();
            x = wa.position.x as f64 + wa.size.width as f64 - W - 14.0;
            y = wa.position.y as f64 + wa.size.height as f64 - H - 14.0;
        }
        /* same spawn path as note popouts: env-churn gates, fresh-label
         * retries, nav + ready proofs — a stalled about:blank gets torn
         * down and rebuilt instead of sticking as a black shell */
        let _ = crate::pop_window(
            app.clone(),
            "dl-toast".into(),
            "dltoast.html".into(),
            x,
            y,
            W,
            H,
            None,
            Some(true),
            Some("Downloads".into()),
            None,
            Some(true),
            Some(true),
            Some(false),
        )
        .await;
        TOAST_SPAWNING.store(false, Ordering::Relaxed);
    });
}

fn info_of(id: &str, job: &std::sync::Arc<Job>) -> DlInfo {
    DlInfo {
        id: id.into(),
        url: job.url.clone(),
        path: job.path.clone(),
        category: job.category.clone(),
        total: job.total.load(Ordering::Relaxed),
        got: job.got.load(Ordering::Relaxed),
        segs: job.conns,
        state: job.state.lock().unwrap().clone(),
        mbps: mbps(job),
        err: job.err.lock().unwrap().clone(),
        elapsed_ms: job.started.elapsed().as_millis(),
    }
}
