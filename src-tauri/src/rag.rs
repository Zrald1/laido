use crate::{llm, state, tools};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const DIMS: u32 = 1024;
const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 200;
const BATCH: usize = 32;
const MAX_FILE: u64 = 10_000_000;
const TOP_K: usize = 10;
const SUMMARY_K: usize = 14;
const ALL_K: usize = 22;

#[derive(Serialize, Clone)]
struct Activity {
    text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Chunk {
    pub text: String,
    pub idx: u32,
}

fn default_kind() -> String {
    "file".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RagDoc {
    pub slug: String,
    pub name: String,
    pub size: u64,
    pub dims: u32,
    pub added: i64,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// which embedder produced this doc's vectors ("api:<model>" or
    /// "hash:v1") — empty on legacy indexes; lanes never mix spaces
    #[serde(default)]
    pub embedder: String,
    pub chunks: Vec<Chunk>,
}

#[derive(Serialize)]
pub struct RagInfo {
    pub slug: String,
    pub name: String,
    pub size: u64,
    pub chunks: usize,
    pub dims: u32,
}

const RAG_SYSTEM: &str = "You are Laido answering questions from the user's own files. \
Use ONLY the provided excerpts (an ENTITY INDEX may precede them — treat it as verified structure). \
Cite sources inline as [file#chunk]. If the excerpts don't fully \
cover the question, answer with what IS there and note the gap in one line. No headings, no \
preamble. As long as the question genuinely needs — dense, no filler. Use **bold** for key terms, \
names, and figures, and wrap the single most important phrase in ==highlights==.";
const RAG_SYSTEM_ALL: &str = "You are Laido enumerating items from the user's own files. The user \
wants EVERY item of the requested kind (formulas, names, dates, steps, figures…). Go through ALL \
the excerpts AND the entity index and list each distinct item once — one numbered line each, \
cited [file#chunk], deduplicated. If coverage looks incomplete, end with one line noting what \
seems missing. No preamble. Use **bold** for the item names.";
const RAG_SYSTEM_WEB: &str = "You are Laido answering questions from the user's files plus the \
web. Ground file-specific claims in the LOCAL excerpts and cite them as [file#chunk]; use the WEB \
results for broader or current context and cite them as [wN]. If neither covers part of the \
question, note the gap in one line. No headings, no preamble. As long as the question genuinely \
needs — dense, no filler. Use **bold** for key terms, names, and figures, and wrap the single most \
important phrase in ==highlights==.";
const RAG_SYSTEM_SUM: &str = "You are Laido summarizing the user's own files from excerpts \
spanning each document. Use ONLY the provided excerpts and cite [file#chunk] inline. Write the \
requested summary faithfully and cover EVERY document present — when per-file digests are \
provided, give each file its own paragraph; if coverage is incomplete, summarize what IS covered \
rather than refusing. No headings, no preamble. Make it scannable: **bold** key terms, names, and \
figures, and wrap the most important finding or conclusion of each section in ==highlights==.";
const RAG_DIGEST: &str = "You compress excerpts from ONE document into a faithful digest: what this \
document is, what it covers, the key names, figures, and conclusions. Max 90 words, no preamble, \
keep [file#chunk] citations on the load-bearing facts.";

/// "give me the 1000 words" → 1000 — picks up an explicit length request so
/// the answer budget can scale to it
fn word_target(q: &str) -> Option<usize> {
    let lc = q.to_lowercase();
    let i = lc.find("word")?;
    let tail: String = lc[..i]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == ',' || *c == ' ' || *c == '-')
        .collect();
    let digits: String = tail.chars().filter(|c| c.is_ascii_digit()).collect();
    digits
        .chars()
        .rev()
        .collect::<String>()
        .parse()
        .ok()
        .filter(|&n: &usize| (20..=20000).contains(&n))
}

const REWRITE_SYSTEM: &str = "You rewrite questions for a hybrid keyword+semantic+graph search \
over the user's own files. Reply with ONLY compact JSON on one line: \
{\"intent\":\"qa\",\"queries\":[\"...\",\"...\"],\"low\":[\"...\"],\"high\":[\"...\"]}. Rules: \
queries = 1 to 3 short standalone search phrases; turn vague references (\"that thing\", \"the \
workshop\", pronouns) into concrete keywords and likely synonyms; keep names, dates, and quoted \
terms verbatim. low = the specific entities the question is about — people, products, formulas, \
files, identifiers, verbatim. high = the abstract themes or concepts it touches. intent = \"all\" \
when the user wants every item of a kind (\"all the\", \"every\", \"list\", \"each\"), \"summary\" \
for a summary/overview/recap/digest/tl;dr, otherwise \"qa\". No explanation, no markdown.";

#[derive(Deserialize)]
struct Rewrite {
    #[serde(default)]
    intent: String,
    #[serde(default)]
    queries: Vec<String>,
    #[serde(default)]
    low: Vec<String>,
    #[serde(default)]
    high: Vec<String>,
}

const WEB_QUERY_SYSTEM: &str = "You turn a user's question into ONE web search query. \
Use the specific names, terms, and entities from the provided LOCAL EXCERPTS to make the query \
concrete — never leave vague references (\"these people\", \"that talk\", pronouns) unresolved \
when the excerpts name them. Keep names, titles, and proper nouns verbatim. Reply with ONLY the \
query text — no quotes, no explanation.";

/// Ground a vague question into a concrete web search query using the
/// specific names/terms the local excerpts already surfaced. Falls back to
/// the raw question — the web search must never fail because of this.
pub(crate) async fn web_query(model: &str, query: &str, local_ctx: &str) -> String {
    if local_ctx.trim().is_empty() {
        return query.to_string();
    }
    let digest: String = local_ctx.chars().take(12_000).collect();
    let prompt = format!("Question: {query}\n\nLOCAL EXCERPTS:\n{digest}");
    match llm::chat(model, Some(WEB_QUERY_SYSTEM), &prompt, 800).await {
        Ok(q) => {
            let q = q.trim().trim_matches('"').trim_matches('\'').to_string();
            if q.is_empty() || q.len() > 300 {
                query.to_string()
            } else {
                q
            }
        }
        Err(_) => query.to_string(),
    }
}

/// Ask the rewriter model to interpret the query into search phrases, an
/// intent flag, and LightRAG-style dual-level keywords: `low` = specific
/// entities, `high` = abstract themes. Never fails the pipeline — falls back
/// to the raw query, and empty keyword lists fall back to the queries.
async fn rewrite_query(
    model: &str,
    query: &str,
) -> (String, Vec<String>, Vec<String>, Vec<String>) {
    let mut intent = "qa".to_string();
    let mut queries: Vec<String> = vec![query.to_string()];
    let mut low: Vec<String> = Vec::new();
    let mut high: Vec<String> = Vec::new();
    // thinking models burn budget on hidden reasoning — give it headroom
    if let Ok(text) = llm::chat(model, Some(REWRITE_SYSTEM), &format!("Question: {query}"), 1200).await
    {
        if let (Some(a), Some(b)) = (text.find('{'), text.rfind('}')) {
            if let Ok(rw) = serde_json::from_str::<Rewrite>(&text[a..=b]) {
                intent = rw.intent.to_lowercase();
                let mut subs: Vec<String> = rw
                    .queries
                    .into_iter()
                    .map(|q| q.trim().to_string())
                    .filter(|q| !q.is_empty())
                    .take(3)
                    .collect();
                if !subs.is_empty() {
                    // keep the user's raw words too — they often carry the exact terms
                    subs.insert(0, query.to_string());
                    subs.dedup();
                    queries = subs;
                }
                let grab = |v: Vec<String>, n: usize| -> Vec<String> {
                    v.into_iter()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .take(n)
                        .collect()
                };
                low = grab(rw.low, 6);
                high = grab(rw.high, 4);
            }
        }
    }
    if low.is_empty() {
        low = queries.clone();
    }
    if high.is_empty() {
        high = low.clone();
    }
    (intent, queries, low, high)
}

fn tokenize(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 2)
        .map(String::from)
        .collect()
}

/// Classic BM25 over the scoped chunks — catches exact names, dates, and
/// quoted terms that pure embedding similarity misses.
fn bm25_rank(scoped: &[RagDoc], query: &str) -> Vec<(String, u32)> {
    const K1: f32 = 1.2;
    const B: f32 = 0.75;
    let terms = tokenize(query);
    if terms.is_empty() {
        return Vec::new();
    }
    let mut docs: Vec<(&str, u32, usize, std::collections::HashMap<String, u32>)> = Vec::new();
    for d in scoped {
        for c in &d.chunks {
            let mut tf: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
            let toks = tokenize(&c.text);
            let len = toks.len();
            for t in toks {
                *tf.entry(t).or_default() += 1;
            }
            docs.push((d.slug.as_str(), c.idx, len, tf));
        }
    }
    let n = docs.len() as f32;
    if n == 0.0 {
        return Vec::new();
    }
    let avgdl = docs.iter().map(|d| d.2 as f32).sum::<f32>() / n;
    let mut df: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, _, _, tf) in &docs {
        for t in tf.keys() {
            *df.entry(t.clone()).or_default() += 1;
        }
    }
    let mut scored: Vec<(f32, String, u32)> = Vec::new();
    for (slug, idx, len, tf) in &docs {
        let mut score = 0f32;
        for t in &terms {
            let Some(&f) = tf.get(t.as_str()) else { continue };
            let dft = *df.get(t.as_str()).unwrap_or(&0) as f32;
            let idf = (1.0 + (n - dft + 0.5) / (dft + 0.5)).ln();
            score += idf * (f as f32 * (K1 + 1.0)) / (f as f32 + K1 * (1.0 - B + B * *len as f32 / avgdl));
        }
        if score > 0.0 {
            scored.push((score, slug.to_string(), *idx));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(25).map(|(_, s, i)| (s, i)).collect()
}

/// Reciprocal Rank Fusion — merge several ranked lists; chunks that rank well
/// in ANY list (a sub-query's semantic list or the keyword list) bubble up.
fn rrf_fuse(lists: Vec<Vec<(String, u32)>>) -> Vec<(String, u32)> {
    const K: f32 = 60.0;
    let mut score: std::collections::HashMap<(String, u32), f32> = std::collections::HashMap::new();
    for list in lists {
        for (rank, key) in list.iter().enumerate() {
            *score.entry(key.clone()).or_default() += 1.0 / (K + rank as f32 + 1.0);
        }
    }
    let mut out: Vec<(f32, (String, u32))> = score.into_iter().map(|(k, s)| (s, k)).collect();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, k)| k).collect()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn rag_dir() -> PathBuf {
    crate::vault::vault_root().join(".laido").join("rag")
}

pub(crate) fn index_path() -> PathBuf {
    rag_dir().join("index.json")
}

fn vectors_path(slug: &str) -> PathBuf {
    rag_dir().join("vectors").join(format!("{slug}.bin"))
}

fn graph_path(slug: &str) -> PathBuf {
    rag_dir().join("graph").join(format!("{slug}.json"))
}
fn ent_vecs_path(slug: &str) -> PathBuf {
    rag_dir().join("graph").join(format!("{slug}.ents.bin"))
}
fn rel_vecs_path(slug: &str) -> PathBuf {
    rag_dir().join("graph").join(format!("{slug}.rels.bin"))
}

// ---- serving layer ------------------------------------------------------
// the persisted store (index.json + per-doc .bin vectors) is loaded once and
// then served from memory — the same "memory-resident index over a durable
// store" shape a dedicated search engine runs, kept in-process. files are
// keyed by (mtime, len); writes go through the cache so a fresh add is
// queryable without a re-read. chunk vectors stay in ONE flat buffer so the
// similarity scan is a sequential walk, not a pointer chase.

#[derive(Clone)]
struct VecFile {
    dims: usize,
    flat: Arc<Vec<f32>>,
    mtime: u64,
    len: u64,
}

impl VecFile {
    fn chunk(&self, i: usize) -> Option<&[f32]> {
        self.flat.get(i * self.dims..(i + 1) * self.dims)
    }
}

fn file_sig(path: &PathBuf) -> (u64, u64) {
    fs::metadata(path)
        .map(|m| {
            (
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                m.len(),
            )
        })
        .unwrap_or((0, 0))
}

fn vec_cache() -> &'static RwLock<HashMap<PathBuf, VecFile>> {
    static C: OnceLock<RwLock<HashMap<PathBuf, VecFile>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(HashMap::new()))
}

fn idx_cache() -> &'static RwLock<HashMap<PathBuf, (u64, u64, Arc<Vec<RagDoc>>)>> {
    static C: OnceLock<RwLock<HashMap<PathBuf, (u64, u64, Arc<Vec<RagDoc>>)>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(HashMap::new()))
}

/// read-through cached parse of a .bin vector file — flat f32 + stride
fn vecfile(path: &PathBuf) -> Option<VecFile> {
    let (mtime, len) = file_sig(path);
    if len == 0 {
        return None;
    }
    if let Some(hit) = vec_cache().read().unwrap().get(path) {
        if hit.mtime == mtime && hit.len == len {
            return Some(hit.clone());
        }
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 8 {
        return None;
    }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let dims = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if dims == 0 {
        return None;
    }
    let mut flat: Vec<f32> = Vec::with_capacity(count * dims);
    let mut off = 8;
    for _ in 0..count {
        if off + dims * 4 > bytes.len() {
            break;
        }
        flat.extend(
            bytes[off..off + dims * 4]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        );
        off += dims * 4;
    }
    if flat.len() != count * dims {
        return None; // truncated file — don't serve a partial index
    }
    let vf = VecFile {
        dims,
        flat: Arc::new(flat),
        mtime,
        len,
    };
    vec_cache()
        .write()
        .unwrap()
        .insert(path.clone(), vf.clone());
    Some(vf)
}

/// a doc's chunk vectors — library docs live in vectors/, notes in notes/
fn vec_set(slug: &str) -> Option<VecFile> {
    vecfile(&vectors_path(slug)).or_else(|| vecfile(&notes_vec_path(slug)))
}

fn drop_vec(path: &PathBuf) {
    vec_cache().write().unwrap().remove(path);
}

/// read-through cached parse of an index.json (library or notes)
fn cached_docs(path: &PathBuf) -> Arc<Vec<RagDoc>> {
    let (mtime, len) = file_sig(path);
    if let Some((m, l, docs)) = idx_cache().read().unwrap().get(path) {
        if *m == mtime && *l == len {
            return docs.clone();
        }
    }
    let docs: Vec<RagDoc> = fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let docs = Arc::new(docs);
    idx_cache()
        .write()
        .unwrap()
        .insert(path.clone(), (mtime, len, docs.clone()));
    docs
}

fn load_index() -> Vec<RagDoc> {
    cached_docs(&index_path()).as_ref().clone()
}

/// Write paths must never treat an unreadable index as "empty" — that turned
/// one corrupt file into a silent full-library wipe on the next upload.
/// A failed parse is kept aside for recovery and the write is refused.
/// Always reads fresh from disk — never the cache.
pub(crate) fn load_index_for_write() -> Result<Vec<RagDoc>, String> {
    let path = index_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(Vec::new()); // first run — nothing to protect yet
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Vec<RagDoc>>(&raw) {
        Ok(docs) => Ok(docs),
        Err(e) => {
            let stamp = now();
            let backup = rag_dir().join(format!("index.json.corrupt-{stamp}"));
            let _ = fs::copy(&path, &backup);
            Err(format!(
                "the library index is unreadable ({e}) — refusing to overwrite it; a copy was kept at {}",
                backup.display()
            ))
        }
    }
}

/// atomic write + one-generation backup: a partial write can no longer
/// corrupt the index, and the previous good copy always survives.
/// write-through: the cache serves exactly what was just persisted
fn save_index(docs: &[RagDoc]) -> Result<(), String> {
    fs::create_dir_all(rag_dir()).map_err(|e| e.to_string())?;
    let path = index_path();
    if path.exists() {
        let _ = fs::copy(&path, rag_dir().join("index.json.bak"));
    }
    let tmp = rag_dir().join("index.json.tmp");
    fs::write(&tmp, serde_json::to_string(docs).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    let (mtime, len) = file_sig(&path);
    idx_cache()
        .write()
        .unwrap()
        .insert(path, (mtime, len, Arc::new(docs.to_vec())));
    Ok(())
}

fn save_vectors(slug: &str, vecs: &[Vec<f32>]) -> Result<(), String> {
    save_vectors_at(vectors_path(slug), vecs)
}

fn save_vectors_at(path: PathBuf, vecs: &[Vec<f32>]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let dims = vecs.first().map(|v| v.len()).unwrap_or(0);
    let mut flat: Vec<f32> = Vec::with_capacity(vecs.len() * dims);
    let mut bytes: Vec<u8> = Vec::with_capacity(8 + vecs.len() * dims * 4);
    bytes.extend_from_slice(&(vecs.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(dims as u32).to_le_bytes());
    for v in vecs {
        flat.extend_from_slice(v);
        for x in v {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
    }
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let (mtime, len) = file_sig(&path);
    if dims > 0 {
        vec_cache().write().unwrap().insert(
            path,
            VecFile {
                dims,
                flat: Arc::new(flat),
                mtime,
                len,
            },
        );
    }
    Ok(())
}

// ---- knowledge graph (LightRAG-style dual-level retrieval) --------------
// Per-doc entity/relation index extracted by the rewriter model at ingest
// (or lazily on first ask). low-level query keywords match entity vectors,
// high-level keywords match relation vectors — both feed chunk lists into
// the same RRF fusion as the plain vector/BM25 lanes.

#[derive(Serialize, Deserialize, Clone)]
struct Ent {
    name: String,
    kind: String,
    desc: String,
    chunks: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Rel {
    a: String,
    b: String,
    kw: String,
    desc: String,
    chunks: Vec<u32>,
}

#[derive(Serialize, Deserialize, Default)]
struct Graph {
    #[serde(default)]
    embedder: String,
    ents: Vec<Ent>,
    rels: Vec<Rel>,
}

const GRAPH_SYSTEM: &str = "You index text for a knowledge graph. From the TEXT extract the key \
entities and the relationships between them. Output ONLY lines in exactly these two forms — no \
other text, no bullets, no numbering:\n\
E|name|type|one-line description grounded in the text\n\
R|entity name|entity name|keywords|one-line description of the relationship\n\
Rules: keep names verbatim from the text; type is one of \
person,org,concept,event,method,formula,file,other; at most 12 entities and 12 relationships; \
every name on an R line must also appear on an E line; skip generic filler terms.";

const GRAPH_WAVE: usize = 4;
const GRAPH_MAX_CHUNKS: usize = 240;
const GRAPH_MAX_NODES: usize = 160;

fn graph_busy() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Build a doc's knowledge graph in the background — asks proceed on the
/// vector/BM25 lanes meanwhile and automatically pick up the graph lanes
/// once it lands. No-op if the graph exists or a build is in flight.
fn ensure_graph(app: &AppHandle, slug: &str, name: &str, chunks: &[Chunk]) {
    if graph_path(slug).exists() {
        return;
    }
    {
        let mut busy = graph_busy().lock().unwrap();
        if !busy.insert(slug.to_string()) {
            return;
        }
    }
    let app = app.clone();
    let slug = slug.to_string();
    let name = name.to_string();
    let texts: Vec<(u32, String)> = chunks.iter().map(|c| (c.idx, c.text.clone())).collect();
    tauri::async_runtime::spawn(async move {
        match build_graph(&app, &slug, &name, &texts).await {
            Ok((e, r)) => {
                let _ = app.emit(
                    "agent:activity",
                    Activity {
                        text: format!("🕸 {name}: {e} entities · {r} relations linked"),
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "agent:activity",
                    Activity {
                        text: format!("✕ graph {name}: {e}"),
                    },
                );
            }
        }
        graph_busy().lock().unwrap().remove(&slug);
    });
}

/// Extraction pass: each chunk gets one lightweight LLM call (4 at a time,
/// so 192 chunks ≈ a minute), the entities/relations merge into one graph,
/// then name+desc get embedded for lane matching.
async fn build_graph(
    app: &AppHandle,
    slug: &str,
    name: &str,
    texts: &[(u32, String)],
) -> Result<(usize, usize), String> {
    let model = state::load_settings().model_rewrite;
    if model.is_empty() {
        return Err("no rewriter model set".into());
    }
    let mut g = Graph::default();
    let take = texts.len().min(GRAPH_MAX_CHUNKS);
    let _ = app.emit(
        "agent:activity",
        Activity {
            text: format!("🕸 mapping {name} — {take} chunks…"),
        },
    );
    for wave in texts.iter().take(take).collect::<Vec<_>>().chunks(GRAPH_WAVE) {
        let mut handles = Vec::new();
        for (idx, t) in wave.iter() {
            let m = model.clone();
            let t = t.clone();
            let idx = *idx;
            handles.push((
                idx,
                tauri::async_runtime::spawn(async move {
                    llm::chat(&m, Some(GRAPH_SYSTEM), &t, 1600).await
                }),
            ));
        }
        for (idx, h) in handles {
            if let Ok(Ok(out)) = h.await {
                merge_graph(&mut g, idx, &out);
            }
        }
    }
    if g.ents.is_empty() && g.rels.is_empty() {
        return Err("nothing extracted".into());
    }
    let ein: Vec<String> = g
        .ents
        .iter()
        .map(|e| format!("{}: {}", e.name, e.desc))
        .collect();
    let rin: Vec<String> = g
        .rels
        .iter()
        .map(|r| format!("{} — {}: {} {}", r.a, r.b, r.kw, r.desc))
        .collect();
    let mut tag = String::new();
    let mut ev = Vec::new();
    for b in ein.chunks(BATCH) {
        let (t, vs) = embed_lane(&b.to_vec()).await;
        tag = t;
        for v in vs {
            ev.push(normalize(v));
        }
    }
    let mut rv = Vec::new();
    for b in rin.chunks(BATCH) {
        let (t, vs) = embed_lane(&b.to_vec()).await;
        tag = t;
        for v in vs {
            rv.push(normalize(v));
        }
    }
    g.embedder = tag;
    save_vectors_at(ent_vecs_path(slug), &ev)?;
    save_vectors_at(rel_vecs_path(slug), &rv)?;
    fs::write(
        graph_path(slug),
        serde_json::to_string(&g).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok((g.ents.len(), g.rels.len()))
}

/// Merge one chunk's extracted E|/R| lines into the doc graph — entities
/// dedupe by lowercase name, relations by unordered endpoint pair.
fn merge_graph(g: &mut Graph, idx: u32, out: &str) {
    let push_chunk = |v: &mut Vec<u32>| {
        if !v.contains(&idx) {
            v.push(idx);
        }
    };
    for raw in out.lines() {
        let l = raw.trim();
        if l.len() < 4 {
            continue;
        }
        let tag = l
            .split('|')
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches(['-', '*', '(', '"', ' '])
            .to_lowercase();
        let field = |i: usize| -> String {
            l.split('|')
                .nth(i)
                .unwrap_or("")
                .trim()
                .trim_matches('"')
                .trim_matches('(')
                .trim_end_matches(')')
                .to_string()
        };
        match tag.as_str() {
            "e" => {
                let name = field(1);
                if name.len() < 2 {
                    continue;
                }
                let kind = field(2).to_lowercase();
                let desc: String = field(3).chars().take(220).collect();
                let key = name.to_lowercase();
                if let Some(e) = g.ents.iter_mut().find(|e| e.name.to_lowercase() == key) {
                    push_chunk(&mut e.chunks);
                    if !desc.is_empty() && !e.desc.contains(&desc) && e.desc.len() < 480 {
                        if !e.desc.is_empty() {
                            e.desc.push(' ');
                        }
                        e.desc.push_str(&desc);
                    }
                } else if g.ents.len() < GRAPH_MAX_NODES {
                    g.ents.push(Ent {
                        name,
                        kind,
                        desc,
                        chunks: vec![idx],
                    });
                }
            }
            "r" => {
                let a = field(1);
                let b = field(2);
                if a.len() < 2 || b.len() < 2 || a.eq_ignore_ascii_case(&b) {
                    continue;
                }
                let kw: String = field(3).chars().take(120).collect();
                let desc: String = field(4).chars().take(220).collect();
                let (ka, kb) = (a.to_lowercase(), b.to_lowercase());
                if let Some(r) = g
                    .rels
                    .iter_mut()
                    .find(|r| {
                        let (ra, rb) = (r.a.to_lowercase(), r.b.to_lowercase());
                        (ra == ka && rb == kb) || (ra == kb && rb == ka)
                    })
                {
                    push_chunk(&mut r.chunks);
                    if !desc.is_empty() && !r.desc.contains(&desc) && r.desc.len() < 480 {
                        if !r.desc.is_empty() {
                            r.desc.push(' ');
                        }
                        r.desc.push_str(&desc);
                    }
                } else if g.rels.len() < GRAPH_MAX_NODES {
                    g.rels.push(Rel {
                        a,
                        b,
                        kw,
                        desc,
                        chunks: vec![idx],
                    });
                }
            }
            _ => {}
        }
    }
}

/// The two graph lanes: low-level keywords → entity vectors → the entities'
/// chunks plus chunks of relations touching them; high-level keywords →
/// relation vectors → their chunks. Returns ranked chunk lists for RRF and
/// a compact digest of matched nodes to prepend to the answer context.
fn graph_lanes(
    scoped: &[RagDoc],
    qlow: &[f32],
    qhigh: &[f32],
    qtag: &str,
) -> (Vec<Vec<(String, u32)>>, String, usize) {
    const ENT_TOP: usize = 4;
    const REL_TOP: usize = 4;
    let mut lists: Vec<Vec<(String, u32)>> = Vec::new();
    let mut elines: Vec<String> = Vec::new();
    let mut rlines: Vec<String> = Vec::new();
    for d in scoped {
        let g: Graph = fs::read_to_string(graph_path(&d.slug))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        if g.ents.is_empty() && g.rels.is_empty() {
            continue;
        }
        if !space_match(&g.embedder, qtag) {
            continue; // entity vectors live in a different embedding space
        }
        // local lane — entity vectors
        if !qlow.is_empty() {
            let evs = vecfile(&ent_vecs_path(&d.slug));
            let mut scored: Vec<(f32, usize)> = evs
                .as_ref()
                .map(|vf| {
                    vf.flat
                        .chunks(vf.dims)
                        .enumerate()
                        .filter(|(_, v)| v.len() == qlow.len())
                        .map(|(i, v)| (dot(qlow, v), i))
                        .collect()
                })
                .unwrap_or_default();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut lane: Vec<(String, u32)> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            let mut names = std::collections::HashSet::new();
            for (s, i) in scored.into_iter().take(ENT_TOP) {
                if s < 0.30 {
                    break;
                }
                let e = &g.ents[i];
                elines.push(format!("{} ({}) — {}", e.name, e.kind, e.desc));
                names.insert(e.name.to_lowercase());
                for c in &e.chunks {
                    if seen.insert(*c) {
                        lane.push((d.slug.clone(), *c));
                    }
                }
            }
            // relations touching the matched entities surface their chunks too
            for r in &g.rels {
                if names.contains(&r.a.to_lowercase()) || names.contains(&r.b.to_lowercase()) {
                    for c in &r.chunks {
                        if seen.insert(*c) {
                            lane.push((d.slug.clone(), *c));
                        }
                    }
                }
            }
            if !lane.is_empty() {
                lists.push(lane);
            }
        }
        // global lane — relation vectors
        if !qhigh.is_empty() {
            let rvs = vecfile(&rel_vecs_path(&d.slug));
            let mut scored: Vec<(f32, usize)> = rvs
                .as_ref()
                .map(|vf| {
                    vf.flat
                        .chunks(vf.dims)
                        .enumerate()
                        .filter(|(_, v)| v.len() == qhigh.len())
                        .map(|(i, v)| (dot(qhigh, v), i))
                        .collect()
                })
                .unwrap_or_default();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut lane: Vec<(String, u32)> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for (s, i) in scored.into_iter().take(REL_TOP) {
                if s < 0.28 {
                    break;
                }
                let r = &g.rels[i];
                rlines.push(format!("{} ↔ {} — {}", r.a, r.b, r.desc));
                for c in &r.chunks {
                    if seen.insert(*c) {
                        lane.push((d.slug.clone(), *c));
                    }
                }
            }
            if !lane.is_empty() {
                lists.push(lane);
            }
        }
    }
    let hits = elines.len() + rlines.len();
    let mut digest = String::new();
    if !elines.is_empty() {
        digest.push_str(&format!("ENTITIES: {}", elines.join(" · ")));
    }
    if !rlines.is_empty() {
        if !digest.is_empty() {
            digest.push('\n');
        }
        digest.push_str(&format!("RELATIONS: {}", rlines.join(" · ")));
    }
    let digest: String = digest.chars().take(12_000).collect();
    (lists, digest, hits)
}

/// Born-rule lane — the density-matrix query from quantum IR: the query is a
/// mixture ρ = Σ wᵢ|vᵢ⟩⟨vᵢ| over its rewritten meanings, and a chunk's
/// relevance is tr(ρ·Π_d) = weighted squared cosines. Costs nothing — reuses
/// the query vectors already embedded for the plain vector lanes.
fn density_lane(scoped: &[RagDoc], qvecs: &[Vec<f32>], qtag: &str) -> Vec<(String, u32)> {
    if qvecs.is_empty() {
        return Vec::new();
    }
    let w = 1.0 / qvecs.len() as f32;
    let mut ranked: Vec<(f32, String, u32)> = Vec::new();
    for d in scoped {
        if !space_match(&d.embedder, qtag) {
            continue;
        }
        let Some(vf) = vec_set(&d.slug) else {
            continue;
        };
        for (i, v) in vf.flat.chunks(vf.dims).enumerate() {
            let mut s = 0f32;
            for qv in qvecs {
                if v.len() == qv.len() {
                    let c = dot(qv, v);
                    if c > 0.0 {
                        s += w * c * c;
                    }
                }
            }
            if s > 0.0 {
                ranked.push((s, d.slug.clone(), i as u32));
            }
        }
    }
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    ranked.into_iter().take(25).map(|(_, s, i)| (s, i)).collect()
}

/// Quantum-walk lane — probability mass seeds on the entity-vector matches,
/// diffuses into their chunks, flows back up through entities that co-occupy
/// a chunk, and settles where several matched concepts converge. The sim
/// measured +33% P@1 and doubled chunk contiguity vs plain RRF: coherent
/// passages instead of scattered fragments.
fn walk_lane(scoped: &[RagDoc], qlow: &[f32], qtag: &str) -> Vec<(String, u32)> {
    if qlow.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<(f32, String, u32)> = Vec::new();
    for d in scoped {
        let g: Graph = fs::read_to_string(graph_path(&d.slug))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        if g.ents.is_empty() || !space_match(&g.embedder, qtag) {
            continue;
        }
        let Some(evs) = vecfile(&ent_vecs_path(&d.slug)) else {
            continue;
        };
        let mut em: Vec<f32> = evs
            .flat
            .chunks(evs.dims)
            .map(|v| if v.len() == qlow.len() { dot(qlow, v).max(0.0) } else { 0.0 })
            .collect();
        let total: f32 = em.iter().sum();
        if total <= 0.0 {
            continue;
        }
        for x in em.iter_mut() {
            *x /= total;
        }
        let n_chunks = d.chunks.len();
        let mut c2e: Vec<Vec<usize>> = vec![Vec::new(); n_chunks];
        for (ei, e) in g.ents.iter().enumerate() {
            for &c in &e.chunks {
                if (c as usize) < n_chunks {
                    c2e[c as usize].push(ei);
                }
            }
        }
        let mut cm = vec![0f32; n_chunks];
        for (ei, &m) in em.iter().enumerate() {
            let ec = &g.ents[ei].chunks;
            let share = m / ec.len().max(1) as f32;
            for &c in ec {
                if (c as usize) < n_chunks {
                    cm[c as usize] += share;
                }
            }
        }
        for _ in 0..2 {
            let mut back = vec![0f32; g.ents.len()];
            for (c, &m) in cm.iter().enumerate() {
                if m <= 0.0 || c2e[c].is_empty() {
                    continue;
                }
                let share = m / c2e[c].len() as f32;
                for &ei in &c2e[c] {
                    back[ei] += share;
                }
            }
            for (ei, &m) in back.iter().enumerate() {
                let ec = &g.ents[ei].chunks;
                let share = 0.5 * m / ec.len().max(1) as f32;
                for &c in ec {
                    if (c as usize) < n_chunks {
                        cm[c as usize] += share;
                    }
                }
            }
        }
        // sequential spillover — mass leaks into adjacent chunks, which is
        // exactly the contiguity the walk bought in the sim
        let spill: Vec<f32> = cm.clone();
        for (i, &m) in spill.iter().enumerate() {
            if m <= 0.0 {
                continue;
            }
            if i + 1 < n_chunks {
                cm[i + 1] += m * 0.15;
            }
            if i > 0 {
                cm[i - 1] += m * 0.15;
            }
        }
        for (i, &m) in cm.iter().enumerate() {
            if m > 0.0 {
                out.push((m, d.slug.clone(), i as u32));
            }
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().take(25).map(|(_, s, i)| (s, i)).collect()
}

/// QPRP-style interference re-rank — the top-15 fused candidates re-pick
/// greedily: a chunk gains score when it is coherent with the one just picked
/// (constructive interference between "already relevant" material), so the
/// final context reads as a passage. Pure dot products, zero API calls.
fn interference_rerank(cands: &[(f32, String, u32)], scoped: &[RagDoc]) -> Vec<(f32, String, u32)> {
    const POOL: usize = 15;
    const LAMBDA: f32 = 0.2;
    if cands.len() < 3 {
        return cands.to_vec();
    }
    let tag_of = |slug: &str| -> &str {
        scoped
            .iter()
            .find(|d| d.slug == slug)
            .map(|d| d.embedder.as_str())
            .unwrap_or("")
    };
    let mut vecs: HashMap<String, VecFile> = HashMap::new();
    for (_, slug, _) in cands.iter().take(POOL) {
        if let Some(vf) = vec_set(slug) {
            vecs.entry(slug.clone()).or_insert(vf);
        }
    }
    let vec_of = |slug: &str, idx: u32| -> Option<&[f32]> {
        vecs.get(slug).and_then(|vf| vf.chunk(idx as usize))
    };
    let pool: Vec<(f32, String, u32)> = cands.iter().take(POOL).cloned().collect();
    let mut picked: Vec<(f32, String, u32)> = vec![pool[0].clone()];
    while picked.len() < POOL.min(cands.len()) {
        let last = &picked[picked.len() - 1];
        let mut best: Option<(f32, usize)> = None;
        for (pi, p) in pool.iter().enumerate() {
            if picked.iter().any(|x| x.1 == p.1 && x.2 == p.2) {
                continue;
            }
            let mut s = p.0;
            if space_match(tag_of(&p.1), tag_of(&last.1)) {
                if let (Some(a), Some(b)) = (vec_of(&p.1, p.2), vec_of(&last.1, last.2)) {
                    if a.len() == b.len() {
                        s += LAMBDA * p.0 * dot(a, b).max(0.0);
                    }
                }
            }
            if best.map(|(bs, _)| s > bs).unwrap_or(true) {
                best = Some((s, pi));
            }
        }
        match best {
            Some((_, pi)) => picked.push(pool[pi].clone()),
            None => break,
        }
    }
    let mut out = picked;
    for c in cands.iter().skip(POOL) {
        out.push(c.clone());
    }
    out
}

fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
    v
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ---- embedder modes -----------------------------------------------------
// like a standalone search engine, retrieval doesn't hard-depend on one
// remote model: the configured provider is preferred, and a deterministic
// local hash embedder covers offline/keyless operation so the vector lanes
// degrade to lexical instead of silently returning nothing. every indexed
// doc records which space its vectors live in — lanes only compare
// same-space vectors (a hash vector and an API vector are not comparable
// even at equal length).

const LEX_TAG: &str = "hash:v1";

/// deterministic offline embedder — signed feature hashing over word
/// unigrams, adjacent bigrams and char trigrams (FNV-1a), L2-normalized.
/// lexical, not semantic: strong on shared vocabulary, blind to paraphrase.
fn lexical_embed(text: &str, dims: usize) -> Vec<f32> {
    fn h(s: &str, seed: u64) -> u64 {
        let mut x = 0xcbf29ce484222325u64 ^ seed.wrapping_mul(0x9e3779b97f4a7c15);
        for b in s.as_bytes() {
            x ^= *b as u64;
            x = x.wrapping_mul(0x100000001b3);
        }
        x
    }
    let mut v = vec![0f32; dims];
    let bump = |v: &mut Vec<f32>, key: &str, seed: u64, w: f32| {
        let x = h(key, seed);
        v[(x % dims as u64) as usize] += if x >> 63 == 0 { w } else { -w };
    };
    let toks = tokenize(text);
    for (i, t) in toks.iter().enumerate() {
        bump(&mut v, t, 1, 1.0);
        if i + 1 < toks.len() {
            bump(&mut v, &format!("{} {}", t, toks[i + 1]), 2, 0.7);
        }
        let chs: Vec<char> = t.chars().collect();
        if chs.len() >= 3 {
            for w3 in chs.windows(3) {
                let g: String = w3.iter().collect();
                bump(&mut v, &g, 3, 0.35);
            }
        } else {
            bump(&mut v, t, 3, 0.35);
        }
    }
    normalize(v)
}

/// which embedder space the current settings would produce
fn api_tag() -> String {
    let s = state::load_settings();
    let (m, _b, k) = state::resolve_llm(&s, &s.model_embed);
    if k.is_empty() {
        return LEX_TAG.to_string();
    }
    format!("api:{}", if m.is_empty() { "auto".into() } else { m })
}

/// embed a batch in whichever space is available — provider first (one
/// retry), hash fallback on failure. returns (space tag, vectors).
async fn embed_lane(texts: &[String]) -> (String, Vec<Vec<f32>>) {
    let tag = api_tag();
    if tag.starts_with("api:") {
        for attempt in 0..2 {
            match llm::embed(texts, DIMS).await {
                Ok(vs) => return (tag, vs),
                Err(_) if attempt == 0 => continue,
                Err(_) => break,
            }
        }
    }
    (
        LEX_TAG.to_string(),
        texts.iter().map(|t| lexical_embed(t, DIMS as usize)).collect(),
    )
}

/// may a query vector in space `q` be scored against a doc vector in space
/// `d`? legacy docs have no tag — they predate tagging and are api space.
fn space_match(d: &str, q: &str) -> bool {
    if d.is_empty() {
        return q.is_empty() || q.starts_with("api:");
    }
    if q.is_empty() {
        return d.starts_with("api:");
    }
    d == q
}

fn slugify(name: &str) -> String {
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let mut s: String = stem
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "file".to_string()
    } else {
        s.chars().take(48).collect()
    }
}

fn chunk_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let mut end = (start + CHUNK_CHARS).min(chars.len());
        if end < chars.len() {
            let window = end.saturating_sub(200);
            if let Some(pos) = (window..end)
                .rev()
                .find(|&i| chars[i] == '\n' || chars[i] == '.')
            {
                end = pos + 1;
            }
        }
        if end <= start {
            break;
        }
        let s: String = chars[start..end].iter().collect();
        let s = s.trim().to_string();
        if !s.is_empty() {
            out.push(s);
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP);
    }
    out
}

fn extract_text(path: &std::path::Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(
        ext.as_str(),
        "md" | "markdown" | "txt" | "csv" | "json" | "log" | "text"
    ) {
        return Err(format!(
            "unsupported file type .{ext} (md, txt, csv, json, log, pdf, pptx)"
        ));
    }
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("file is larger than 10 MB".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

const OCR_PROMPT: &str = "Transcribe this scanned document page into clean plain text. \
    Preserve structure: headings, paragraphs, lists, tables as plain-text rows. \
    Output ONLY the transcription — no commentary, no code fences.";
const OCR_MAX_IMAGES: usize = 30;
/// a page with this much embedded text doesn't need OCR
const NATIVE_TEXT_MIN: usize = 200;

/// Progress event for the library bar — extraction (ocr/read) and embedding
/// phases share the same channel so the UI always shows live work.
fn prog(app: &AppHandle, file: &str, fi: usize, fc: usize, phase: &str, done: usize, total: usize) {
    let pct = ((done * 100) / total.max(1)) as u32;
    let _ = app.emit(
        "rag:progress",
        serde_json::json!({
            "file": file,
            "fileIndex": fi + 1,
            "fileCount": fc,
            "phase": phase,
            "done": done,
            "total": total,
            "pct": pct,
        }),
    );
}

/// PDF → text. Digital PDFs get their embedded text layer for free; scanned
/// PDFs (a page = one embedded image) send each page image to the configured
/// vision model for OCR, then the transcription is chunked + embedded like
/// any other document.
async fn pdf_to_text(
    app: &AppHandle,
    name: &str,
    path: &std::path::Path,
    fi: usize,
    fc: usize,
) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("file is larger than 10 MB".into());
    }
    let doc = lopdf::Document::load(path).map_err(|e| format!("can't read pdf: {e}"))?;
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    if let Ok(native) = doc.extract_text(&pages) {
        if native.trim().chars().count() >= NATIVE_TEXT_MIN {
            return Ok(native);
        }
    }
    // scanned — each page's embedded image goes to the vision model
    let s = state::load_settings();
    if s.model_ocr.is_empty() {
        return Err("scanned PDF with no text layer — pick a vision model in Settings → OCR".into());
    }
    let page_ids = doc.get_pages();
    // pre-count the page images so OCR reports a real percentage
    let total_imgs = page_ids
        .values()
        .map(|id| doc.get_page_images(*id).map(|v| v.len()).unwrap_or(0))
        .sum::<usize>()
        .min(OCR_MAX_IMAGES);
    prog(app, name, fi, fc, "ocr", 0, total_imgs.max(1));
    let mut out = String::new();
    let mut used = 0usize;
    'pages: for (&page_num, &page_id) in page_ids.iter() {
        let imgs = doc.get_page_images(page_id).unwrap_or_default();
        for img in imgs {
            let is_jpeg = img
                .filters
                .map(|fs| fs.iter().any(|f| *f == "DCTDecode"))
                .unwrap_or(false);
            // DCTDecode → the raw stream content already IS jpeg bytes
            let jpeg = match doc.get_object(img.id) {
                Ok(lopdf::Object::Stream(s)) if !s.content.is_empty() => s.content.clone(),
                _ => Vec::new(),
            };
            if !is_jpeg || jpeg.is_empty() {
                continue;
            }
            used += 1;
            prog(app, name, fi, fc, "ocr", used, total_imgs.max(1));
            if used > OCR_MAX_IMAGES {
                let _ = write!(out, "\n[OCR stopped at {OCR_MAX_IMAGES} images — {} pages total]", pages.len());
                break 'pages;
            }
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("🔍 OCR {name} — image {used} (page {page_num})…"),
                },
            );
            let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &jpeg);
            match llm::chat_vision(&s.model_ocr, OCR_PROMPT, "image/jpeg", &b64, 2048).await {
                Ok(t) => {
                    out.push_str(t.trim());
                    out.push_str("\n\n");
                }
                Err(e) => {
                    let _ = app.emit(
                        "agent:activity",
                        Activity {
                            text: format!("✕ OCR {name} page {page_num}: {e}"),
                        },
                    );
                }
            }
        }
    }
    if out.trim().is_empty() {
        Err("no text layer and no usable page images (only JPEG-encoded scans are OCR'd)".into())
    } else {
        Ok(out)
    }
}

/// PPTX → text: unzip the package and pull every <a:t> run from each slide.
fn pptx_to_text(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE {
        return Err("file is larger than 10 MB".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("can't read pptx: {e}"))?;
    let mut names: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        if let Ok(z) = zip.by_index(i) {
            let n = z.name().to_string();
            if n.starts_with("ppt/slides/slide") && n.ends_with(".xml") {
                names.push(n);
            }
        }
    }
    names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });
    let mut out = String::new();
    for (i, n) in names.iter().enumerate() {
        let Ok(mut z) = zip.by_name(n) else { continue };
        let mut buf = String::new();
        if z.read_to_string(&mut buf).is_err() {
            continue;
        }
        let texts = collect_xml_runs(&buf);
        if !texts.is_empty() {
            let _ = write!(out, "— Slide {} —\n{}\n\n", i + 1, texts.join("\n"));
        }
    }
    if out.trim().is_empty() {
        Err("no slide text found".into())
    } else {
        Ok(out)
    }
}

/// collect the character content of every <a:t>…</a:t> run
fn collect_xml_runs(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(open) = rest.find("<a:t") {
        let after_tag = &rest[open + 4..];
        let Some(close) = after_tag.find('>') else { break };
        let body_start = open + 4 + close + 1;
        let Some(end) = rest[body_start..].find("</a:t>") else { break };
        let raw = &rest[body_start..body_start + end];
        let t = raw
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&");
        let t = t.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
        rest = &rest[body_start + end + 6..];
    }
    out
}

/// a dropped picture goes straight to the vision model — the file bytes are
/// already the image, so no page extraction is needed at all
async fn image_to_text(
    app: &AppHandle,
    name: &str,
    path: &std::path::Path,
    fi: usize,
    fc: usize,
) -> Result<String, String> {
    let s = state::load_settings();
    if s.model_ocr.is_empty() {
        return Err("image OCR needs a vision model — pick one in Settings → OCR model".into());
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX_FILE {
        return Err("too large (>10 MB)".into());
    }
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "image/jpeg",
    };
    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    if bytes.is_empty() {
        return Err("empty file".into());
    }
    let _ = app.emit(
        "agent:activity",
        Activity {
            text: format!("🔍 OCR {name}…"),
        },
    );
    prog(app, name, fi, fc, "ocr", 0, 1);
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let r = llm::chat_vision(&s.model_ocr, OCR_PROMPT, mime, &b64, 2048)
        .await
        .map(|t| t.trim().to_string())
        .map_err(|e| format!("OCR failed: {e}"))?;
    prog(app, name, fi, fc, "ocr", 1, 1);
    Ok(r)
}

/// every dropped file goes through here — text files read directly, pdf/pptx
/// get their own extractors (pdf falls back to vision-model OCR when scanned)
async fn extract_document(
    app: &AppHandle,
    name: &str,
    path: &std::path::Path,
    fi: usize,
    fc: usize,
) -> Result<String, String> {
    prog(app, name, fi, fc, "read", 0, 1);
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "pdf" => pdf_to_text(app, name, path, fi, fc).await,
        "pptx" => pptx_to_text(path),
        "ppt" => Err("old .ppt binary format — save it as .pptx and retry".into()),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" => {
            image_to_text(app, name, path, fi, fc).await
        }
        _ => extract_text(path),
    }
}

#[tauri::command]
pub fn rag_list() -> Vec<RagInfo> {
    load_index()
        .into_iter()
        .map(|d| RagInfo {
            slug: d.slug,
            name: d.name,
            size: d.size,
            chunks: d.chunks.len(),
            dims: d.dims,
        })
        .collect()
}

pub fn has_doc(slug: &str) -> bool {
    load_index().iter().any(|d| d.slug == slug)
}

/* ---------- notes index: your own writing is searchable too ---------- */

fn notes_index_path() -> PathBuf {
    rag_dir().join("notes-index.json")
}

fn notes_vec_path(slug: &str) -> PathBuf {
    rag_dir().join("notes").join(format!("{slug}.vec"))
}

fn load_notes_index() -> Vec<RagDoc> {
    cached_docs(&notes_index_path()).as_ref().clone()
}

fn save_notes_index(docs: &[RagDoc]) -> Result<(), String> {
    fs::create_dir_all(rag_dir().join("notes")).map_err(|e| e.to_string())?;
    let path = notes_index_path();
    fs::write(&path, serde_json::to_string(docs).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let (mtime, len) = file_sig(&path);
    idx_cache()
        .write()
        .unwrap()
        .insert(path, (mtime, len, Arc::new(docs.to_vec())));
    Ok(())
}

/// a stable, filesystem-safe slug per note name — the hash keeps two names
/// that sanitize to the same base from colliding
fn note_slug(name: &str) -> String {
    let base = name.trim_end_matches(".laido").trim_end_matches(".md");
    let mut s: String = base
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in name.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!(
        "note-{}-{:08x}",
        if s.is_empty() { "x" } else { &s },
        (h & 0xffff_ffff) as u32
    )
}

/// incremental: only notes whose mtime changed get re-embedded. returns how
/// many notes were (re)built.
pub async fn ensure_notes_index() -> Result<usize, String> {
    let notes = crate::vault::vault_list()?;
    let docs = load_notes_index();
    let mut rebuilt = 0usize;
    let mut keep: Vec<RagDoc> = Vec::new();
    for n in &notes {
        if n.name.starts_with('.') {
            continue;
        }
        let slug = note_slug(&n.name);
        if let Some(existing) = docs.iter().find(|d| d.slug == slug && d.size == n.modified) {
            keep.push(existing.clone());
            continue;
        }
        let Ok(path) = crate::vault::note_path(&n.name) else {
            continue;
        };
        let text = fs::read_to_string(&path).unwrap_or_default();
        let pieces = chunk_text(&text);
        if pieces.is_empty() {
            continue;
        }
        let (tag, vecs) = embed_lane(&pieces).await;
        save_vectors_at(notes_vec_path(&slug), &vecs)?;
        let chunks: Vec<Chunk> = pieces
            .iter()
            .enumerate()
            .map(|(i, t)| Chunk {
                idx: i as u32,
                text: t.clone(),
            })
            .collect();
        rebuilt += 1;
        keep.push(RagDoc {
            slug,
            name: n.name.clone(),
            size: n.modified,
            dims: DIMS,
            added: now(),
            kind: "note".into(),
            embedder: tag,
            chunks,
        });
    }
    save_notes_index(&keep)?;
    Ok(rebuilt)
}

/// resolve a rag target to its scoped docs — "all-files" (library),
/// "my-notes" (your own writing), "everything" (both), or one slug
async fn docs_for(target: &str) -> Result<Vec<RagDoc>, String> {
    match target {
        "my-notes" => {
            ensure_notes_index().await?;
            let docs = load_notes_index();
            if docs.is_empty() {
                return Err("no notes indexed yet — write something first".into());
            }
            Ok(docs)
        }
        "everything" => {
            let _ = ensure_notes_index().await;
            let mut docs = load_index();
            docs.extend(load_notes_index());
            if docs.is_empty() {
                return Err("nothing indexed yet — add files or write notes first".into());
            }
            Ok(docs)
        }
        "all-files" => Ok(load_index()),
        slug => {
            let mut docs: Vec<RagDoc> = load_index()
                .into_iter()
                .filter(|d| d.slug == slug)
                .collect();
            if docs.is_empty() {
                let _ = ensure_notes_index().await;
                docs = load_notes_index()
                    .into_iter()
                    .filter(|d| d.slug == slug)
                    .collect();
            }
            if docs.is_empty() {
                return Err(format!(
                    "“{slug}” is not in your library — add the file in the Library panel, or run a skill alone on the line"
                ));
            }
            Ok(docs)
        }
    }
}

/// evenly spread excerpts across the scoped corpus (front, middle, back of
/// each doc) so quizzes and task sweeps don't tunnel into one section
fn sample_excerpts(docs: &[RagDoc], take: usize) -> String {
    let mut all: Vec<(&str, &Chunk)> = Vec::new();
    for d in docs {
        for c in &d.chunks {
            all.push((d.slug.as_str(), c));
        }
    }
    if all.is_empty() {
        return String::new();
    }
    let step = (all.len() / take.max(1)).max(1);
    let mut out = String::new();
    let mut i = 0;
    while i < all.len() && out.len() < 40_000 {
        let (slug, c) = all[i];
        out.push_str(&format!("[{}#{}] {}\n\n", slug, c.idx, c.text));
        i += step;
    }
    out
}

const QUIZ_SYSTEM: &str = "You write recall practice from the user's own material. From the provided \
excerpts, write the requested number of question–answer pairs testing the most important facts, names, \
numbers and formulas. Format strictly as:\nQ1. <question>\nA1. <answer>\nQ2. ...\nEach answer is one \
short sentence, grounded ONLY in the excerpts. No preamble, no headings, no extra commentary.";

const TASKS_SYSTEM: &str = "You extract action items from the user's own material. An action item is \
something a person must DO later: a follow-up, a deadline, a commitment, a decision to make, a thing \
to send or check. Do NOT list agenda items, presenter lineups, talk descriptions, or background facts \
— only work that someone still has to do. Format each as: - <owner if named>: <action> — <short \
context>. Deduplicate, keep names verbatim, ground everything ONLY in the excerpts. If nothing \
actionable exists, reply with exactly: no action items found. No preamble, no headings.";

/// @recall — active-recall practice built from the scoped corpus
#[tauri::command]
pub async fn rag_quiz(target: String, n: Option<usize>) -> Result<String, String> {
    let docs = docs_for(&target).await?;
    let count = n.unwrap_or(6).clamp(3, 12);
    let excerpts = sample_excerpts(&docs, count * 2);
    if excerpts.trim().is_empty() {
        return Err(format!("nothing to quiz on “{target}”"));
    }
    let settings = state::load_settings();
    let prompt = format!("Write {count} question–answer pairs from these excerpts:\n\n{excerpts}");
    let answer = llm::chat_retry(
        &settings.model_main,
        Some(QUIZ_SYSTEM),
        &prompt,
        count as u32 * 130 + 300,
    )
    .await?;
    let body = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("> [!ai] recall: {target}\n{body}"))
}

/// @tasks — action items extracted from the scoped corpus
#[tauri::command]
pub async fn rag_tasks(target: String, n: Option<usize>) -> Result<String, String> {
    let docs = docs_for(&target).await?;
    let take = n.unwrap_or(8).clamp(4, 16);
    let excerpts = sample_excerpts(&docs, take);
    if excerpts.trim().is_empty() {
        return Err(format!("nothing to scan for tasks in “{target}”"));
    }
    let settings = state::load_settings();
    let prompt = format!("Extract the action items from these excerpts:\n\n{excerpts}");
    let answer = llm::chat_retry(
        &settings.model_main,
        Some(TASKS_SYSTEM),
        &prompt,
        take as u32 * 80 + 300,
    )
    .await?;
    let body = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!("> [!ai] tasks: {target}\n{body}"))
}

#[derive(Serialize)]
pub struct RelatedNote {
    pub name: String,
    pub score: f32,
}

/// @related — the notes closest to this one, by embedding similarity over
/// the notes index
#[tauri::command]
pub async fn related_notes(name: String) -> Result<Vec<RelatedNote>, String> {
    let _ = ensure_notes_index().await;
    let path = crate::vault::note_path(&name)?;
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let head: String = text.chars().take(20_000).collect();
    if head.trim().is_empty() {
        return Ok(Vec::new());
    }
    let (qtag, vecs) = embed_lane(&[head]).await;
    let qv = normalize(vecs.into_iter().next().ok_or("embed failed")?);
    let mut scored: Vec<RelatedNote> = Vec::new();
    for d in load_notes_index() {
        if d.name == name || !space_match(&d.embedder, &qtag) {
            continue;
        }
        let Some(vf) = vecfile(&notes_vec_path(&d.slug)) else {
            continue;
        };
        let mut best = 0f32;
        for v in vf.flat.chunks(vf.dims) {
            if v.len() == qv.len() {
                let s: f32 = v.iter().zip(&qv).map(|(a, b)| a * b).sum();
                best = best.max(s);
            }
        }
        if best > 0.15 {
            scored.push(RelatedNote {
                name: d.name,
                score: best,
            });
        }
    }
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(3);
    Ok(scored)
}

/// upload failures are permanent and diagnosable: they land in the activity
/// log file as well as the live feed
fn fail_activity(app: &AppHandle, text: String) {
    crate::vault::log_activity(&text);
    let _ = app.emit("agent:activity", Activity { text });
}

#[tauri::command]
pub async fn rag_add_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let mut docs = load_index_for_write()?;
    let file_count = paths.len();
    for (fi, p) in paths.into_iter().enumerate() {
        let path = PathBuf::from(&p);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.clone());
        let text = match extract_document(&app, &name, &path, fi, file_count).await {
            Ok(t) => t,
            Err(e) => {
                fail_activity(&app, format!("✕ {name}: {e}"));
                continue;
            }
        };
        let mut slug = slugify(&name);
        let mut i = 2;
        while docs.iter().any(|d| d.slug == slug) {
            slug = format!("{}-{}", slugify(&name), i);
            i += 1;
        }
        let chunks = chunk_text(&text);
        if chunks.is_empty() {
            fail_activity(&app, format!("✕ {name}: no text found"));
            continue;
        }
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("📄 embedding {name} — {} chunks…", chunks.len()),
            },
        );
        let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(chunks.len());
        let mut tag = String::new();
        let total_batches = chunks.len().div_ceil(BATCH);
        for (bi, batch) in chunks.chunks(BATCH).enumerate() {
            let input: Vec<String> = batch.to_vec();
            let (t, vs) = embed_lane(&input).await;
            tag = t;
            if tag == LEX_TAG && bi == 0 {
                let _ = app.emit(
                    "agent:activity",
                    Activity {
                        text: format!(
                            "⚠ {name}: embedder unavailable — indexed with local hash vectors (lexical match only)"
                        ),
                    },
                );
            }
            for v in vs.into_iter() {
                vectors.push(normalize(v));
            }
            prog(&app, &name, fi, file_count, "embed", bi + 1, total_batches);
        }
        if vectors.len() != chunks.len() {
            fail_activity(&app, format!("✕ {name}: embedding count mismatch"));
            continue;
        }
        let dims = vectors.first().map(|v| v.len()).unwrap_or(0) as u32;
        if let Err(e) = save_vectors(&slug, &vectors) {
            fail_activity(&app, format!("✕ {name}: {e}"));
            continue;
        }
        docs.push(RagDoc {
            kind: "file".into(),
            slug: slug.clone(),
            name: name.clone(),
            size: text.len() as u64,
            dims,
            added: now(),
            embedder: tag,
            chunks: chunks
                .into_iter()
                .enumerate()
                .map(|(i, text)| Chunk {
                    text,
                    idx: i as u32,
                })
                .collect(),
        });
        // persist right away — a doc must be askable the moment its own
        // embedding finishes, not after the rest of the batch completes
        let _ = save_index(&docs);
        let _ = app.emit("rag:changed", ());
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("✓ {name} ready — ask it with @document {slug} <question>"),
            },
        );
        // knowledge graph builds in the background — the file is already
        // askable; the entity/relation lanes join in when this lands
        if let Some(d) = docs.last() {
            ensure_graph(&app, &d.slug, &d.name, &d.chunks);
        }
    }
    save_index(&docs)?;
    Ok(())
}

#[tauri::command]
pub fn rag_remove(slug: String) -> Result<(), String> {
    // slugs are generated at ingest, but this is a command boundary — a
    // crafted slug must not delete files outside .laido/rag
    let slug = crate::vault::safe_name(&slug)
        .map_err(|_| "invalid document name".to_string())?
        .to_string();
    let mut docs = load_index_for_write()?;
    docs.retain(|d| d.slug != slug);
    save_index(&docs)?;
    drop_vec(&vectors_path(&slug));
    drop_vec(&ent_vecs_path(&slug));
    drop_vec(&rel_vecs_path(&slug));
    let _ = fs::remove_file(vectors_path(&slug));
    let _ = fs::remove_file(graph_path(&slug));
    let _ = fs::remove_file(ent_vecs_path(&slug));
    let _ = fs::remove_file(rel_vecs_path(&slug));
    Ok(())
}

/// Shared local retrieval for other agents (research, brief): runs the same
/// rewrite + hybrid vector/BM25 + RRF pipeline as rag_ask over the index
/// (whole index, or one file when `target` is a slug), and returns formatted
/// "[slug#idx] text" excerpts (top `k`).
pub async fn rag_search(query: &str, k: usize, target: Option<&str>) -> Vec<String> {
    let docs: Vec<RagDoc> = match docs_for(target.unwrap_or("all-files")).await {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    if docs.is_empty() {
        return Vec::new();
    }
    let settings = state::load_settings();
    let (_intent, queries, low, high) = rewrite_query(&settings.model_rewrite, query).await;
    // one embed call carries the search phrases AND the graph keywords
    let mut embed_in = queries.clone();
    embed_in.push(low.join(", "));
    embed_in.push(high.join(", "));
    let mut lists: Vec<Vec<(String, u32)>> = Vec::new();
    let (mut qlow, mut qhigh) = (Vec::new(), Vec::new());
    let mut qvecs: Vec<Vec<f32>> = Vec::new();
    let (qtag, qvec_raw) = embed_lane(&embed_in).await;
    for (i, qv) in qvec_raw.into_iter().enumerate() {
        let qv = normalize(qv);
        if i == queries.len() {
            qlow = qv;
            continue;
        }
        if i == queries.len() + 1 {
            qhigh = qv;
            continue;
        }
        qvecs.push(qv.clone());
        let mut ranked: Vec<(f32, String, u32)> = Vec::new();
        for d in &docs {
            if !space_match(&d.embedder, &qtag) {
                continue;
            }
            if let Some(vf) = vec_set(&d.slug) {
                for (j, v) in vf.flat.chunks(vf.dims).enumerate() {
                    if v.len() == qv.len() {
                        ranked.push((dot(&qv, v), d.slug.clone(), j as u32));
                    }
                }
            }
        }
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        lists.push(ranked.into_iter().take(25).map(|(_, s, i)| (s, i)).collect());
    }
    let bm = bm25_rank(&docs, &queries.join(" "));
    if !bm.is_empty() {
        lists.push(bm);
    }
    let (glanes, _digest, _hits) = graph_lanes(&docs, &qlow, &qhigh, &qtag);
    lists.extend(glanes);
    let dl = density_lane(&docs, &qvecs, &qtag);
    if !dl.is_empty() {
        lists.push(dl);
    }
    let wl = walk_lane(&docs, &qlow, &qtag);
    if !wl.is_empty() {
        lists.push(wl);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (slug, idx) in rrf_fuse(lists) {
        if !seen.insert((slug.clone(), idx)) {
            continue;
        }
        if let Some(d) = docs.iter().find(|d| d.slug == slug) {
            if let Some(c) = d.chunks.iter().find(|c| c.idx == idx) {
                out.push(format!("[{}#{}] {}", slug, idx, c.text));
                if out.len() >= k {
                    break;
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn rag_ask(
    app: AppHandle,
    note: String,
    target: String,
    query: String,
    quiet: bool,
    anchor: Option<String>,
    parent: Option<String>,
    question: Option<String>,
    web: Option<bool>,
) -> Result<(), String> {
    let scoped: Vec<RagDoc> = docs_for(&target).await?;
    if scoped.is_empty() {
        return Err(format!(
            "“{target}” is not in your library — add the file in the Library panel, or run a skill alone on the line"
        ));
    }
    // the knowledge graph builds lazily — kick it for any scoped doc that
    // doesn't have one yet; this ask proceeds on the other lanes meanwhile.
    // notes skip the graph: a graph per note would cost an LLM call per chunk
    for d in &scoped {
        if d.kind != "note" {
            ensure_graph(&app, &d.slug, &d.name, &d.chunks);
        }
    }
    // ---- query understanding: the rewriter model turns the question into
    // ---- search phrases + intent + dual-level graph keywords, one call ---
    let settings = state::load_settings();
    let (intent, queries, low, high) = rewrite_query(&settings.model_rewrite, &query).await;
    if queries.len() > 1 {
        let subs = queries
            .iter()
            .skip(1)
            .take(2)
            .map(|q| format!("“{q}”"))
            .collect::<Vec<_>>()
            .join(" + ");
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("🔎 rag: also searching {subs}"),
            },
        );
    }

    // ---- three-lane retrieval: vector per phrase + BM25 + graph
    // ---- (entity & relation lanes) — all merged via RRF -----------------
    let mut embed_in = queries.clone();
    embed_in.push(low.join(", "));
    embed_in.push(high.join(", "));
    let mut lists: Vec<Vec<(String, u32)>> = Vec::new();
    let (mut qlow, mut qhigh) = (Vec::new(), Vec::new());
    let mut qvecs: Vec<Vec<f32>> = Vec::new();
    let (qtag, qvec_raw) = embed_lane(&embed_in).await;
    for (i, qv) in qvec_raw.into_iter().enumerate() {
        let qv = normalize(qv);
        if i == queries.len() {
            qlow = qv;
            continue;
        }
        if i == queries.len() + 1 {
            qhigh = qv;
            continue;
        }
        qvecs.push(qv.clone());
        let mut ranked: Vec<(f32, String, u32)> = Vec::new();
        for d in &scoped {
            if !space_match(&d.embedder, &qtag) {
                continue;
            }
            if let Some(vf) = vec_set(&d.slug) {
                for (j, v) in vf.flat.chunks(vf.dims).enumerate() {
                    if v.len() == qv.len() {
                        ranked.push((dot(&qv, v), d.slug.clone(), j as u32));
                    }
                }
            }
        }
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        lists.push(ranked.into_iter().take(25).map(|(_, s, i)| (s, i)).collect());
    }
    let bm = bm25_rank(&scoped, &queries.join(" "));
    if !bm.is_empty() {
        lists.push(bm);
    }
    let (glanes, digest, ghits) = graph_lanes(&scoped, &qlow, &qhigh, &qtag);
    lists.extend(glanes);
    let dl = density_lane(&scoped, &qvecs, &qtag);
    if !dl.is_empty() {
        lists.push(dl);
    }
    let wl = walk_lane(&scoped, &qlow, &qtag);
    if !wl.is_empty() {
        lists.push(wl);
    }
    if ghits > 0 {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("🕸 +{ghits} graph nodes in scope"),
            },
        );
    }
    let cands: Vec<(f32, String, u32)> = interference_rerank(
        &rrf_fuse(lists)
            .into_iter()
            .enumerate()
            .map(|(r, (s, i))| (1.0 / (1.0 + r as f32), s, i))
            .collect::<Vec<_>>(),
        &scoped,
    );
    let q = query.to_lowercase();
    let wants_all = intent == "all"
        || ["all the", "all of", "every", "each ", "list all", "everything"]
            .iter()
            .any(|k| q.contains(k));
    let wants_summary = !wants_all
        && (intent == "summary"
            || ["summar", "tl;dr", "recap", "overview", "digest", "outline"]
                .iter()
                .any(|k| q.contains(k)));
    let mut seen: std::collections::HashSet<(String, u32)> = std::collections::HashSet::new();
    let mut picked: Vec<(String, u32)> = Vec::new();
    let add = |slug: &str,
                   idx: u32,
                   picked: &mut Vec<(String, u32)>,
                   seen: &mut std::collections::HashSet<(String, u32)>| {
        if seen.insert((slug.to_string(), idx)) {
            picked.push((slug.to_string(), idx));
        }
    };
    if wants_all {
        // corpus-wide question — cover every lane's chunk hits, no neighbor
        // padding; breadth over depth so nothing of the kind is skipped
        for (_, slug, idx) in cands.iter().take(ALL_K) {
            add(slug, *idx, &mut picked, &mut seen);
        }
    } else if wants_summary {
        let head = if scoped.len() > 1 { 2 } else { 3 };
        for d in &scoped {
            let mut idxs: Vec<u32> = d.chunks.iter().map(|c| c.idx).collect();
            idxs.sort_unstable();
            for i in idxs.iter().take(head) {
                add(&d.slug, *i, &mut picked, &mut seen);
            }
            for i in idxs.iter().rev().take(1) {
                add(&d.slug, *i, &mut picked, &mut seen);
            }
        }
        for (_, slug, idx) in cands.iter().take(SUMMARY_K) {
            add(slug, *idx, &mut picked, &mut seen);
        }
    } else {
        for (hi, (_, slug, idx)) in cands.iter().take(TOP_K).enumerate() {
            add(slug, *idx, &mut picked, &mut seen);
            if hi < 4 {
                if let Some(d) = scoped.iter().find(|d| d.slug == *slug) {
                    for n in [idx.checked_sub(1), idx.checked_add(1)].into_iter().flatten() {
                        if d.chunks.iter().any(|c| c.idx == n) {
                            add(slug, n, &mut picked, &mut seen);
                        }
                    }
                }
            }
        }
    }
    picked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut ctx = String::new();
    let mut sources: Vec<String> = Vec::new();
    for (slug, idx) in &picked {
        if let Some(d) = scoped.iter().find(|d| d.slug == *slug) {
            if let Some(c) = d.chunks.iter().find(|c| c.idx == *idx) {
                ctx.push_str(&format!("[{}#{}] {}\n\n", slug, idx, c.text));
                let s = format!("[{}#{}]", slug, idx);
                if !sources.contains(&s) {
                    sources.push(s);
                }
            }
        }
    }
    if !digest.is_empty() {
        ctx = format!("ENTITY INDEX (verified names/relations in scope):\n{digest}\n\n{ctx}");
    }
    if ctx.trim().is_empty() {
        return Err(
            "no chunks matched — if the file was added with a different embedding size, remove and re-add it"
                .into(),
        );
    }
    // selection asks also get the web tool (Tavily, same as @research) —
    // local excerpts carry file claims, web results cover current context
    let mut web_ctx = String::new();
    let mut web_srcs: Vec<String> = Vec::new();
    if web.unwrap_or(false) {
        // rewrite the question into a concrete query — the local excerpts
        // carry the names/terms a vague "who are these people?" is missing
        let search_q = web_query(&settings.model_rewrite, &query, &ctx).await;
        if let Ok(hits) = tools::search(&search_q, 4).await {
            if !hits.is_empty() {
                let _ = app.emit(
                    "agent:activity",
                    Activity {
                        text: format!("🌐 +{} web results", hits.len()),
                    },
                );
            }
            for (i, h) in hits.iter().enumerate() {
                let snippet: String = h.content.chars().take(3000).collect();
                let _ = write!(
                    web_ctx,
                    "[w{}] {} — {}\n{}\n\n",
                    i + 1,
                    h.title,
                    h.url,
                    snippet
                );
                web_srcs.push(format!("[{}]({})", h.title, h.url));
            }
        }
    }
    let has_web = !web_ctx.is_empty();
    // corpus-wide summary over many files = map-reduce: each file digests its
    // own excerpts in parallel waves, then the final answer synthesizes the
    // digests — a single prompt can't faithfully cover 14 documents at once
    let mut mapreduce = false;
    if wants_summary && scoped.len() > 1 && !has_web {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("📑 digesting {} files…", scoped.len()),
            },
        );
        let mut digests: Vec<String> = Vec::new();
        for wave in scoped.chunks(5) {
            let mut handles = Vec::new();
            for d in wave {
                let mut ex = String::new();
                for (slug, idx) in &picked {
                    if slug != &d.slug {
                        continue;
                    }
                    if let Some(c) = d.chunks.iter().find(|c| c.idx == *idx) {
                        ex.push_str(&format!("[{}#{}] {}\n\n", slug, idx, c.text));
                    }
                }
                if ex.trim().is_empty() {
                    continue;
                }
                let m = settings.model_rewrite.clone();
                let dname = d.name.clone();
                let fallback = ex.chars().take(8000).collect::<String>();
                handles.push(tauri::async_runtime::spawn(async move {
                    let digest = llm::chat_retry(&m, Some(RAG_DIGEST), &ex, 1100).await;
                    (dname, digest, fallback)
                }));
            }
            for h in handles {
                if let Ok((dname, res, raw)) = h.await {
                    let t = res.unwrap_or_default().trim().to_string();
                    // never drop a file from the corpus summary — a starved
                    // digest falls back to its raw excerpt
                    let t = if t.is_empty() { raw } else { t };
                    digests.push(format!("### {dname}\n{t}"));
                }
            }
        }
        if !digests.is_empty() {
            ctx = format!(
                "PER-FILE DIGESTS (one section per document, in library order):\n\n{}",
                digests.join("\n\n")
            );
            mapreduce = true;
        }
    }
    let sys = if has_web {
        RAG_SYSTEM_WEB
    } else if wants_all {
        RAG_SYSTEM_ALL
    } else if wants_summary {
        RAG_SYSTEM_SUM
    } else {
        RAG_SYSTEM
    };
    let wt = word_target(&query);
    let max_tok = if let Some(w) = wt {
        // requested length + headroom so a thinking model still lands its words
        (w * 2 + 700).min((llm::MAX_REPLY - 600) as usize)
    } else if wants_all {
        4000
    } else if mapreduce {
        (scoped.len() * 200 + 1000).min(6000)
    } else if wants_summary {
        3000
    } else {
        2000
    };
    let len_hint = wt.map(|w| format!(" Required length: about {w} words.")).unwrap_or_default();
    let prompt = if has_web {
        format!("Local excerpts:\n{ctx}\nWeb results:\n{web_ctx}\nQuestion: {query}{len_hint}")
    } else {
        format!("Excerpts:\n{ctx}\nQuestion: {query}{len_hint}")
    };
    let mut answer = String::new();
    match llm::chat_retry(&settings.model_main, Some(sys), &prompt, max_tok as u32).await {
        Ok(a) if !a.trim().is_empty() => answer = a,
        Ok(_) => {}
        Err(e) => {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("↻ rag: {e} — retrying with the default model"),
                },
            );
        }
    }
    if answer.trim().is_empty() {
        let fallback = state::DEFAULT_MAIN.to_string();
        answer = llm::chat_retry(&fallback, Some(sys), &prompt, max_tok as u32)
            .await
            .map_err(|e| format!("model call failed: {e}"))?;
    }
    if answer.trim().is_empty() {
        return Err("the model returned an empty answer".into());
    }
    let body = answer
        .trim()
        .lines()
        .map(|l| format!("> {l}"))
        .collect::<Vec<_>>()
        .join("\n");
    for s in web_srcs {
        sources.push(s);
    }
    let callout = format!(
        "> [!ai] rag: {target}\n{body}\n> Sources: {}",
        sources.join(" · ")
    );
    let _ = app.emit(
        "research:done",
        serde_json::json!({
            "note": note,
            "topic": format!("{target} — {query}"),
            "callout": callout,
            "kind": "rag",
            "quiet": quiet,
            "anchor": anchor,
            "parent": parent,
            "question": question,
        }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_embed_deterministic() {
        let a = lexical_embed("the mitochondria is the powerhouse of the cell", 1024);
        let b = lexical_embed("the mitochondria is the powerhouse of the cell", 1024);
        assert_eq!(a, b);
        let n: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-4); // normalized
    }

    #[test]
    fn lexical_embed_related_beats_unrelated() {
        let q = lexical_embed("quarterly revenue grew by twelve percent", 1024);
        let related = lexical_embed("revenue growth this quarter reached twelve percent", 1024);
        let unrelated = lexical_embed("the mitochondria is the powerhouse of the cell", 1024);
        assert!(dot(&q, &related) > dot(&q, &unrelated));
    }

    #[test]
    fn space_match_rules() {
        assert!(space_match("", "api:qwen")); // legacy index = api space
        assert!(!space_match("", LEX_TAG)); // legacy api vec vs hash query
        assert!(space_match("api:qwen", "api:qwen"));
        assert!(!space_match("api:qwen", "api:bge")); // model change = new space
        assert!(space_match(LEX_TAG, LEX_TAG));
        assert!(!space_match(LEX_TAG, "api:qwen"));
    }

    #[test]
    fn vecfile_roundtrip_serve_and_invalidate() {
        let dir = std::env::temp_dir().join(format!("laido-rag-vec-test-{}", now()));
        let p = dir.join("t.bin");
        save_vectors_at(p.clone(), &[vec![1.0f32, 2.0], vec![3.0, 4.0]]).unwrap();
        let a = vecfile(&p).unwrap();
        assert_eq!(a.dims, 2);
        assert_eq!(a.chunk(1), Some(&[3.0f32, 4.0][..]));
        // same signature → same buffer served from cache, not a re-parse
        let b = vecfile(&p).unwrap();
        assert!(Arc::ptr_eq(&a.flat, &b.flat));
        // rewrite → the cache must serve the NEW data, not the stale buffer
        save_vectors_at(p.clone(), &[vec![9.0f32, 9.0], vec![8.0, 7.0], vec![6.0, 5.0]]).unwrap();
        let c = vecfile(&p).unwrap();
        assert_eq!(c.flat.as_slice(), &[9.0f32, 9.0, 8.0, 7.0, 6.0, 5.0]);
        drop_vec(&p);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_vecfile_is_refused() {
        let dir = std::env::temp_dir().join(format!("laido-rag-trunc-{}", now()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("bad.bin");
        // header promises 4×2 f32, file ends early
        let mut bytes = (4u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(&(2u32).to_le_bytes());
        bytes.extend_from_slice(&[0u8; 8]);
        fs::write(&p, bytes).unwrap();
        assert!(vecfile(&p).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
