//! Research loop — iterative research where every loop builds on the last:
//! refine the angle → gather evidence (arXiv + web + optional local RAG) →
//! synthesize a card → write and run a simulation script in the sandbox →
//! feed the result into the next loop. Runs N loops (max 10) or until the
//! user types `@loop stop`, then finalizes everything into one card.

use crate::{llm, rag, state, tools, vault};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const MAX_LOOPS: usize = 10;
const SIM_TIMEOUT_SECS: u64 = 60;

fn cancel_flag() -> &'static AtomicBool {
    static C: OnceLock<AtomicBool> = OnceLock::new();
    C.get_or_init(|| AtomicBool::new(false))
}

fn running() -> &'static Mutex<bool> {
    static R: OnceLock<Mutex<bool>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(false))
}

/// a stable id per run — also the sandbox folder name and the frontend's
/// handle for auto-laying-out that run's cards
pub fn run_id(note: &str, query: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in query.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let slug: String = note
        .trim_end_matches(".laido").trim_end_matches(".md")
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    format!("{slug}-{:08x}", (h & 0xffff_ffff) as u32)
}

/// every run gets its own sandbox: `.laido/loops/<run>/scripts/`
fn sandbox(note: &str, query: &str) -> PathBuf {
    vault::vault_root()
        .join(".laido")
        .join("loops")
        .join(run_id(note, query))
}

#[allow(dead_code)]
pub fn sandbox_scripts(note: &str, query: &str) -> Vec<String> {
    let dir = sandbox(note, query).join("scripts");
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub fn python_cmd() -> Option<Vec<String>> {
    for cand in [vec!["python"], vec!["python3"], vec!["py", "-3"]] {
        let mut c = std::process::Command::new(&cand[0]);
        c.args(&cand[1..]).arg("-c").arg("print('laido-ok')");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
        }
        if let Ok(out) = c.output() {
            if out.status.success() && String::from_utf8_lossy(&out.stdout).contains("laido-ok") {
                return Some(cand.iter().map(|s| s.to_string()).collect());
            }
        }
    }
    None
}

pub struct SimReport {
    pub script: String,
    pub ok: bool,
    pub secs: f32,
    pub output: String,
    pub attempts: u8,
}

/// strip invisible characters (zero-width spaces, BOMs) that sneak in from
/// note markers or model output — they crash Python's Windows console codec
fn sanitize(s: &str) -> String {
    s.replace(['\u{200b}', '\u{feff}'], "")
}

const REFINE_SYSTEM: &str = "You direct an iterative research loop. Given the topic and what has \
already been found, write ONE short search query that explores the NEXT most valuable unexplored \
angle. Reply with only the query — no quotes, no explanation.";

const LOOP_SYSTEM: &str = "You are Laido running loop {i} of {total} in an iterative research loop \
on the user's topic. Using the NEW evidence of this loop (and what was already known), write a tight \
synthesis of what THIS loop adds: new findings, numbers, mechanisms, open questions — as long as \
this loop's findings genuinely need, dense, no filler. \
Cite sources inline as [n](url) where provided. Use **bold** for key terms and ==highlight== the \
single most important phrase. No headings, no preamble, no reasoning.";

const SIM_SYSTEM: &str = "You write ONE short Python 3 script (standard library ONLY — no numpy) \
that numerically tests, simulates, or computes the central quantitative claim in the findings. \
Keep it under 40 lines. Print a compact labeled result (max ~15 lines), plain ASCII only — no \
Greek letters, symbols or emoji in printed output. Reply with ONLY the script inside a ```python \
fence.";

const FINAL_SYSTEM: &str = "You close an iterative research loop. Given every loop's findings, write \
the breakthrough summary: what was established across the loops, what the simulations showed, and \
the single most important open question — as long as the material genuinely needs. ==highlight== \
the key insight. Markdown links allowed, no headings, no preamble.";

fn extract_code(raw: &str) -> Option<String> {
    if let Some((_, rest)) = raw.split_once("```python") {
        if let Some((code, _)) = rest.split_once("```") {
            return Some(code.trim().to_string());
        }
    }
    if let Some((_, rest)) = raw.split_once("```") {
        if let Some((code, _)) = rest.split_once("```") {
            let c = code.trim();
            if c.contains("print(") {
                return Some(c.to_string());
            }
        }
    }
    None
}

async fn run_script(python: &[String], dir: &std::path::Path, file: &std::path::Path) -> (bool, f32, String) {
    let mut cmd = tokio::process::Command::new(&python[0]);
    cmd.args(&python[1..])
        .arg(file)
        .current_dir(dir)
        // Python on Windows prints in cp1252 for piped stdout and dies on
        // any character outside it (σ, zero-width spaces) — force UTF-8
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(std::time::Duration::from_secs(SIM_TIMEOUT_SECS), cmd.output())
        .await;
    let secs = start.elapsed().as_secs_f32();
    match out {
        Ok(Ok(o)) => {
            let mut t = String::from_utf8_lossy(&o.stdout).to_string();
            if !o.status.success() {
                t.push_str(&String::from_utf8_lossy(&o.stderr));
            }
            (o.status.success(), secs, t)
        }
        Ok(Err(e)) => (false, secs, format!("could not run: {e}")),
        Err(_) => (false, secs, format!("timed out after {SIM_TIMEOUT_SECS}s")),
    }
}

fn tidy_output(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .take(40)
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .take(4000)
        .collect()
}

async fn simulate(
    note: &str,
    query: &str,
    iteration: usize,
    findings: &str,
    evidence: &str,
) -> Option<SimReport> {
    let Some(python) = python_cmd() else {
        return Some(SimReport {
            script: String::new(),
            ok: false,
            secs: 0.0,
            output: "python not found on PATH — install Python to run simulations".into(),
            attempts: 0,
        });
    };
    let settings = state::load_settings();
    let findings = sanitize(findings);
    let evidence = sanitize(evidence);
    let prompt = format!(
        "Findings:\n{}\n\nEvidence:\n{}",
        findings.chars().take(40_000).collect::<String>(),
        evidence.chars().take(100_000).collect::<String>()
    );
    let raw = llm::chat_retry(&settings.model_rewrite, Some(SIM_SYSTEM), &prompt, 4096)
        .await
        .ok()?;
    let mut code = sanitize(&extract_code(&raw)?);
    let dir = sandbox(note, query).join("scripts");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("loop{iteration}_sim.py"));
    let rel = format!("scripts/loop{iteration}_sim.py");

    std::fs::write(&file, &code).ok()?;
    let (mut ok, mut secs, mut text) = run_script(&python, &sandbox(note, query), &file).await;
    let mut attempts = 1u8;
    // one repair pass: feed the traceback back and rerun the fixed script
    if !ok && attempts < 2 {
        attempts = 2;
        let fix = format!(
            "This script failed:\n```python\n{code}\n```\n\nError:\n{}\n\nFix it. Reply with ONLY the corrected script in a ```python fence.",
            text.chars().take(6000).collect::<String>()
        );
        if let Ok(raw2) = llm::chat_retry(&settings.model_rewrite, Some(SIM_SYSTEM), &fix, 4096).await {
            if let Some(c2) = extract_code(&raw2) {
                code = sanitize(&c2);
                if std::fs::write(&file, &code).is_ok() {
                    let (ok2, secs2, text2) = run_script(&python, &sandbox(note, query), &file).await;
                    ok = ok2;
                    secs = secs2;
                    text = text2;
                }
            }
        }
    }
    Some(SimReport {
        script: rel,
        ok,
        secs,
        output: tidy_output(&text),
        attempts,
    })
}

/// one loop: refine → evidence → synthesize → simulate → card markdown
pub async fn loop_iteration(
    note: &str,
    query: &str,
    iteration: usize,
    total: usize,
    prior: &str,
    target: Option<&str>,
) -> Result<(String, Option<SimReport>), String> {
    let settings = state::load_settings();
    let refined = if prior.trim().is_empty() {
        query.to_string()
    } else {
        let prompt = format!(
            "Research topic: {query}\n\nFindings so far:\n{}\n\nWrite the next query.",
            prior.chars().take(60_000).collect::<String>()
        );
        llm::chat_retry(&settings.model_rewrite, Some(REFINE_SYSTEM), &prompt, 2000)
            .await
            .map(|s| {
                s.trim()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_string()
            })
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| query.to_string())
    };

    let arxiv = tools::arxiv(&refined, 4).await;
    let web = tools::search(&refined, 5, Some(note)).await.unwrap_or_default();
    let local = match target {
        Some(t) => rag::rag_search(&refined, 5, Some(t)).await,
        None => Vec::new(),
    };

    let mut evidence = String::new();
    for (i, h) in arxiv.iter().enumerate() {
        evidence.push_str(&format!("[{}] arXiv — {} — {}\n{}\n\n", i + 1, h.title, h.url, h.content));
    }
    let off = arxiv.len();
    for (i, h) in web.iter().enumerate() {
        evidence.push_str(&format!(
            "[{}] {} — {}\n{}\n\n",
            off + i + 1,
            h.title,
            h.url,
            h.content.chars().take(4000).collect::<String>()
        ));
    }
    for l in &local {
        evidence.push_str(&format!("[local] {}\n\n", l.chars().take(4000).collect::<String>()));
    }
    if evidence.trim().is_empty() {
        evidence.push_str("(no external evidence found this pass)");
    }

    let prompt = format!(
        "Topic: {query}\nThis is loop {iteration} of {total}. Search angle used: {refined}\n\n\
         What earlier loops established:\n{}\n\nNew evidence this loop:\n{evidence}",
        prior.chars().take(60_000).collect::<String>()
    );
    let system = LOOP_SYSTEM
        .replace("{i}", &iteration.to_string())
        .replace("{total}", &total.to_string());
    let synthesis = llm::chat_retry(&settings.model_main, Some(&system), &prompt, llm::MAX_REPLY).await?;
    if synthesis.trim().is_empty() {
        return Err(format!("loop {iteration} returned an empty synthesis"));
    }

    let sim = simulate(note, query, iteration, &synthesis, &evidence).await;

    let mut md = format!("> [!ai] loop {iteration}/{total} — {query}\n");
    for l in synthesis.trim().lines() {
        md.push_str(&format!("> {l}\n"));
    }
    if let Some(s) = &sim {
        let status = if s.ok {
            if s.attempts > 1 {
                format!("✅ ran in {:.1}s (after 1 repair)", s.secs)
            } else {
                format!("✅ ran in {:.1}s", s.secs)
            }
        } else {
            "✗ failed after repair".to_string()
        };
        let out = if s.output.is_empty() { String::new() } else { format!(" — {}", s.output) };
        let script = if s.script.is_empty() { "no script".to_string() } else { format!("`{}`", s.script) };
        md.push_str(&format!("> **Simulation.** {script} · {status}{out}\n"));
    }
    let mut srcs: Vec<String> = Vec::new();
    for h in arxiv.iter().take(2) {
        srcs.push(format!("[{}]({})", h.title.replace(['[', ']'], ""), h.url));
    }
    for h in web.iter().take(2) {
        srcs.push(format!("[{}]({})", h.title.replace(['[', ']'], ""), h.url));
    }
    if !srcs.is_empty() {
        md.push_str(&format!("> **Sources.** {}", srcs.join(" · ")));
    }
    Ok((md, sim))
}

async fn finalize(query: &str, prior: &str, ledger: &[String], done: usize, total: usize, stopped: bool) -> String {
    let mut md = if stopped {
        format!("> [!ai] research loop — stopped after {done}/{total} loops\n")
    } else {
        format!("> [!ai] research loop complete — {done}/{total} loops\n")
    };
    if prior.trim().is_empty() {
        md.push_str("> every loop failed — check the activity feed for the reason\n");
        return md;
    }
    let settings = state::load_settings();
    let prompt = format!(
        "Topic: {query}\n\nLoop findings:\n{}",
        prior.chars().take(llm::PROMPT_CAP).collect::<String>()
    );
    let summary = llm::chat_retry(&settings.model_main, Some(FINAL_SYSTEM), &prompt, llm::MAX_REPLY)
        .await
        .unwrap_or_default();
    for l in summary.trim().lines() {
        if !l.trim().is_empty() {
            md.push_str(&format!("> {l}\n"));
        }
    }
    md.push_str(&format!("> **Loop ledger.** {}\n", ledger.join(" · ")));
    md.push_str(&format!(
        "> **Artifacts.** `.laido/loops/` — every simulation script kept in its sandbox"
    ));
    md
}

/// `@loop [n] [@target] <query>` — run the loop in the background
#[tauri::command]
pub async fn loop_run(
    app: AppHandle,
    note: String,
    query: String,
    loops: Option<usize>,
    target: Option<String>,
    anchor: Option<String>,
) -> Result<(), String> {
    let total = loops.unwrap_or(3).clamp(1, MAX_LOOPS);
    if query.trim().is_empty() {
        return Err("give the loop a research query".into());
    }
    {
        let mut r = running().lock().unwrap();
        if *r {
            return Err("a research loop is already running — type @loop stop to end it".into());
        }
        *r = true;
    }
    cancel_flag().store(false, Ordering::SeqCst);
    let q = query.trim().to_string();
    let run = run_id(&note, &q);
    tauri::async_runtime::spawn(async move {
        let mut prior = String::new();
        let mut ledger: Vec<String> = Vec::new();
        let mut done = 0usize;
        for i in 1..=total {
            if cancel_flag().load(Ordering::SeqCst) {
                break;
            }
            let _ = app.emit(
                "agent:activity",
                serde_json::json!({ "text": format!("🔁 loop {i}/{total} — researching…") }),
            );
            match loop_iteration(&note, &q, i, total, &prior, target.as_deref()).await {
                Ok((md, sim)) => {
                    prior.push_str(&format!("\n— loop {i}:\n{}\n", md.chars().take(30_000).collect::<String>()));
                    // the next loop must see what the simulation actually
                    // produced, even when the card text got truncated
                    if let Some(s) = &sim {
                        prior.push_str(&format!(
                            "— loop {i} simulation ({}): {}\n",
                            if s.ok { "ran" } else { "failed" },
                            s.output
                        ));
                    }
                    ledger.push(format!(
                        "L{i} ✓{}",
                        sim.map(|s| if s.ok { " sim ✓" } else { " sim ✗" }).unwrap_or("")
                    ));
                    done = i;
                    let _ = app.emit(
                        "research:done",
                        serde_json::json!({
                            "note": note,
                            "topic": format!("loop {i}/{total} — {q}"),
                            "callout": md,
                            "kind": "loop",
                            "quiet": true,
                            "anchor": if i == 1 { anchor.clone() } else { None },
                            "loop": i,
                            "total": total,
                            "run": run,
                        }),
                    );
                }
                Err(e) => {
                    ledger.push(format!("L{i} ✗"));
                    let _ = app.emit(
                        "agent:activity",
                        serde_json::json!({ "text": format!("✕ loop {i} failed: {e}") }),
                    );
                }
            }
        }
        let stopped = cancel_flag().load(Ordering::SeqCst);
        let final_md = finalize(&q, &prior, &ledger, done, total, stopped).await;
        let _ = app.emit(
            "research:done",
            serde_json::json!({
                "note": note,
                "topic": format!("research loop — {q}"),
                "callout": final_md,
                "kind": "loop-final",
                "quiet": true,
                "anchor": null,
                "loop": done,
                "total": total,
                "run": run,
            }),
        );
        *running().lock().unwrap() = false;
    });
    Ok(())
}

#[tauri::command]
pub fn loop_stop() -> Result<(), String> {
    if !*running().lock().unwrap() {
        return Err("no research loop is running".into());
    }
    cancel_flag().store(true, Ordering::SeqCst);
    Ok(())
}
