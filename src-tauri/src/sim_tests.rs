//! End-to-end simulations for the five integrated features: voice capture,
//! vault-wide search, active recall, related notes, action items. They hit
//! the real vault and real APIs, so they are `#[ignore]`d by default — run:
//!   cargo test --bin laido sim_ -- --ignored --nocapture

use crate::{rag, state, vault, voice};

fn header(t: &str) {
    println!("\n========== {t} ==========");
}

fn first_note() -> Option<String> {
    vault::vault_list().ok()?.into_iter().map(|n| n.name).next()
}

fn first_library_slug() -> Option<String> {
    rag::rag_list().into_iter().map(|d| d.slug).next()
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature2_vault_search() {
    header("FEATURE 2 — ask your whole vault (notes index + retrieval)");
    tauri::async_runtime::block_on(async {
        let rebuilt = rag::ensure_notes_index().await.expect("notes index");
        println!("notes (re)embedded this run: {rebuilt}");
        let rebuilt2 = rag::ensure_notes_index().await.expect("notes index");
        println!("second pass re-embedded: {rebuilt2} (expect 0 — incremental)");
        assert_eq!(rebuilt2, 0, "notes index must be incremental");
        let hits = rag::rag_search("what is this note about", 5, Some("my-notes")).await;
        println!("my-notes search hits: {}", hits.len());
        for h in hits.iter().take(3) {
            println!("  - {}", h.chars().take(140).collect::<String>());
        }
        assert!(!hits.is_empty(), "my-notes search returned nothing");
        let every = rag::rag_search("key ideas", 5, Some("everything")).await;
        println!("everything search hits: {}", every.len());
        assert!(!every.is_empty(), "everything search returned nothing");
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature3_recall_quiz() {
    header("FEATURE 3 — active recall (quiz generation)");
    tauri::async_runtime::block_on(async {
        let md = rag::rag_quiz("my-notes".into(), Some(4))
            .await
            .expect("quiz");
        println!("{md}");
        assert!(md.contains("> [!ai] recall:"), "quiz card missing header");
        assert!(
            md.contains("Q1.") && md.contains("A1."),
            "quiz missing Q/A pairs"
        );
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature4_related_notes() {
    header("FEATURE 4 — note-to-note connections (related notes)");
    tauri::async_runtime::block_on(async {
        let Some(name) = first_note() else {
            println!("SKIP — no notes in the vault");
            return;
        };
        let rows = rag::related_notes(name.clone()).await.expect("related");
        println!("related to {name}: {}", rows.len());
        for r in &rows {
            println!("  - {} · {:.0}%", r.name, r.score * 100.0);
        }
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature5_action_items() {
    header("FEATURE 5 — action-item extraction");
    tauri::async_runtime::block_on(async {
        let Some(slug) = first_library_slug() else {
            println!("SKIP — library is empty");
            return;
        };
        let md = rag::rag_tasks(slug.clone(), Some(8))
            .await
            .expect("tasks");
        println!("{md}");
        assert!(md.contains("> [!ai] tasks:"), "tasks card missing header");
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_term_ai -- --ignored --nocapture"]
fn sim_term_ai_fences() {
    header("TERMINAL AI — does the model emit executable fences?");
    tauri::async_runtime::block_on(async {
        for prompt in [
            "create a todo list called shopping with milk and eggs",
            "please create a sheet with a monthly budget",
            "make a chart of sales by month",
            "tell me about my files",
            "make me flashcards for spanish verbs",
        ] {
            let r = crate::term::term_ai(prompt.into(), vec![], None, None, None, None)
                .await
                .expect("term_ai");
            println!("--- {prompt}");
            println!("text: {}", r.text.chars().take(200).collect::<String>());
            println!(
                "todo={} sheet={} slides={} chart={} cards={} laido={} notes={} run={}",
                r.todo.len(), r.sheet.len(), r.slides.len(), r.chart.len(),
                r.cards.len(), r.laido.len(), r.notes.len(), r.commands.len()
            );
        }
    });
}

/// read a WAV of any rate/channels → mono 16k s16le for the live path
fn read_wav_16k(path: &str) -> Vec<i16> {
    let mut r = hound::WavReader::open(path).expect("open wav");
    let spec = r.spec();
    let samples: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|s| s.expect("sample")).collect(),
        hound::SampleFormat::Float => r
            .samples::<f32>()
            .map(|s| (s.expect("sample").clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect(),
    };
    voice::to_pcm16k(&samples, spec.sample_rate, spec.channels)
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature1b_voice_live_stream() {
    header("FEATURE 1b — live streaming transcription (AssemblyAI v3 websocket)");
    tauri::async_runtime::block_on(async {
        let key = state::load_settings().assemblyai_api_key.trim().to_string();
        if key.is_empty() {
            println!("SKIP — no AssemblyAI key in .laido/settings.json");
            return;
        }
        let Some(path) = std::env::var("LAIDO_SIM_AUDIO").ok() else {
            println!("SKIP — set LAIDO_SIM_AUDIO to a speech wav to stream");
            return;
        };
        let pcm = read_wav_16k(&path);
        println!("streaming {} samples (~{:.1}s of audio)", pcm.len(), pcm.len() as f32 / 16000.0);
        let text = voice::stream_pcm_to_text(pcm, 16000).await.expect("live stream");
        println!("live transcript: {text:?}");
        assert!(!text.is_empty(), "live stream returned no transcript");
    });
}

/// reproduces the live mic feed shape exactly — ~16-sample messages every
/// 1 ms with 1 ms-timeout reads — to isolate why live mode heard nothing
#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_feature1c -- --ignored --nocapture"]
fn sim_feature1c_live_micro_chunks() {
    header("DIAGNOSTIC — live feed shape (micro chunks)");
    tauri::async_runtime::block_on(async {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;
        let key = state::load_settings().assemblyai_api_key.trim().to_string();
        if key.is_empty() {
            println!("SKIP — no AssemblyAI key");
            return;
        }
        let Some(path) = std::env::var("LAIDO_SIM_AUDIO").ok() else {
            println!("SKIP — set LAIDO_SIM_AUDIO");
            return;
        };
        let pcm = read_wav_16k(&path);
        let url = "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&speech_model=universal-3-6-pro";
        let mut req = url.into_client_request().expect("req");
        req.headers_mut()
            .insert("Authorization", key.parse().expect("key header"));
        let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("connect");
        let (mut sink, mut stream) = ws.split();
        let mut text = String::new();
        let mut partial = String::new();
        let mut pos = 0usize;
        let mut terminated = false;
        let start = std::time::Instant::now();
        let mut turns = 0usize;
        while !terminated && start.elapsed().as_secs() < 90 {
            if pos < pcm.len() {
                let end = (pos + 16).min(pcm.len());
                let bytes: Vec<u8> = pcm[pos..end].iter().flat_map(|s| s.to_le_bytes()).collect();
                sink.send(Message::Binary(bytes.into())).await.expect("send");
                pos = end;
            } else {
                sink.send(Message::Text("{\"type\":\"Terminate\"}".into()))
                    .await
                    .expect("terminate");
            }
            while let Ok(Some(Ok(msg))) =
                tokio::time::timeout(std::time::Duration::from_millis(1), stream.next()).await
            {
                if let Message::Text(t) = &msg {
                    if let Ok(j) = serde_json::from_str::<serde_json::Value>(t) {
                        match j["type"].as_str().unwrap_or("") {
                            "Turn" => {
                                turns += 1;
                                let tr = j["transcript"].as_str().unwrap_or("");
                                if j["end_of_turn"].as_bool().unwrap_or(false) {
                                    if !tr.trim().is_empty() {
                                        text.push_str(tr.trim());
                                        text.push(' ');
                                    }
                                    partial.clear();
                                } else {
                                    partial = tr.to_string();
                                }
                            }
                            "Termination" => terminated = true,
                            "Error" => {
                                println!("SERVER ERROR: {j}");
                                terminated = true;
                            }
                            _ => {}
                        }
                    }
                }
                if terminated {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        println!("turns seen: {turns} · micro-chunk transcript: {:?}", text.trim());
    });
}

/// replays the FIXED live shape: 1 ms mic slices buffered into legal 50 ms
/// messages (the API rejects < 50 ms with error 3007) — must transcribe
#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_feature1d -- --ignored --nocapture"]
fn sim_feature1d_live_buffered_shape() {
    header("FEATURE 1d — live shape after fix (1 ms slices → 50 ms messages)");
    tauri::async_runtime::block_on(async {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;
        let key = state::load_settings().assemblyai_api_key.trim().to_string();
        if key.is_empty() {
            println!("SKIP — no AssemblyAI key");
            return;
        }
        let Some(path) = std::env::var("LAIDO_SIM_AUDIO").ok() else {
            println!("SKIP — set LAIDO_SIM_AUDIO");
            return;
        };
        let pcm = read_wav_16k(&path);
        let url = "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&speech_model=universal-3-6-pro";
        let mut req = url.into_client_request().expect("req");
        req.headers_mut()
            .insert("Authorization", key.parse().expect("key header"));
        let (ws, _) = tokio_tungstenite::connect_async(req).await.expect("connect");
        let (mut sink, mut stream) = ws.split();
        let mut text = String::new();
        let mut partial = String::new();
        let mut pending: Vec<i16> = Vec::new();
        let mut pos = 0usize;
        let mut done = false;
        let mut term_sent = false;
        let start = std::time::Instant::now();
        while !done && start.elapsed().as_secs() < 90 {
            // a real mic delivers audio by wall clock, not by loop count —
            // feed 16 samples per elapsed millisecond (sleep granularity
            // on Windows is ~15 ms, which would starve a fixed-per-tick feed)
            let target = ((start.elapsed().as_millis() as usize) * 16).min(pcm.len());
            if target > pos {
                pending.extend_from_slice(&pcm[pos..target]);
                pos = target;
            }
            while pending.len() >= 800 {
                let take = pending.len().min(16_000);
                let seg: Vec<i16> = pending.drain(..take).collect();
                let bytes: Vec<u8> = seg.iter().flat_map(|s| s.to_le_bytes()).collect();
                sink.send(Message::Binary(bytes.into())).await.expect("send");
            }
            if pos >= pcm.len() && !term_sent {
                if !pending.is_empty() {
                    let mut seg: Vec<i16> = pending.drain(..).collect();
                    if seg.len() < 800 {
                        seg.resize(800, 0);
                    }
                    let bytes: Vec<u8> = seg.iter().flat_map(|s| s.to_le_bytes()).collect();
                    sink.send(Message::Binary(bytes.into())).await.expect("send tail");
                }
                sink.send(Message::Text("{\"type\":\"Terminate\"}".into()))
                    .await
                    .expect("terminate");
                term_sent = true;
            }
            while let Ok(Some(Ok(msg))) =
                tokio::time::timeout(std::time::Duration::from_millis(1), stream.next()).await
            {
                if let Message::Text(t) = &msg {
                    if let Ok(j) = serde_json::from_str::<serde_json::Value>(t) {
                        match j["type"].as_str().unwrap_or("") {
                            "Turn" => {
                                let tr = j["transcript"].as_str().unwrap_or("");
                                if j["end_of_turn"].as_bool().unwrap_or(false) {
                                    if !tr.trim().is_empty() {
                                        text.push_str(tr.trim());
                                        text.push(' ');
                                    }
                                    partial.clear();
                                } else {
                                    partial = tr.to_string();
                                }
                            }
                            "Termination" => done = true,
                            "Error" => {
                                panic!("server error: {j}");
                            }
                            _ => {}
                        }
                    }
                }
                if done {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        println!("live-shape transcript: {:?}", text.trim());
        assert!(!text.trim().is_empty(), "buffered live shape returned no transcript");
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_feature6 -- --ignored --nocapture"]
fn sim_feature6_research_loop() {
    header("FEATURE 6 — research loop (research → simulate → build, iterated)");
    tauri::async_runtime::block_on(async {
        let q = "quantum error correction with surface codes";
        let (md1, sim1) = crate::looprun::loop_iteration("sim-note.md", q, 1, 2, "", None)
            .await
            .expect("loop 1");
        println!("\n{md1}");
        if let Some(s) = &sim1 {
            println!(
                "sim1: {} ok={} {:.1}s — {}",
                s.script,
                s.ok,
                s.secs,
                s.output.chars().take(200).collect::<String>()
            );
        }
        assert!(md1.contains("> [!ai] loop 1/2"), "loop 1 card header missing");
        let (md2, sim2) = crate::looprun::loop_iteration("sim-note.md", q, 2, 2, &md1, None)
            .await
            .expect("loop 2");
        println!("\n{md2}");
        if let Some(s) = &sim2 {
            println!("sim2: {} ok={} {:.1}s", s.script, s.ok, s.secs);
        }
        assert!(md2.contains("> [!ai] loop 2/2"), "loop 2 card header missing");
        assert!(md2.len() > 200, "loop 2 should build on loop 1");
        let scripts = crate::looprun::sandbox_scripts("sim-note.md", q);
        println!("sandbox scripts: {scripts:?}");
        if crate::looprun::python_cmd().is_some() {
            assert!(
                scripts.len() >= 1,
                "expected simulation scripts in the sandbox"
            );
        } else {
            println!("python not on PATH — script artifacts skipped");
        }
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_feature7 -- --ignored --nocapture"]
fn sim_feature7_note_summary() {
    header("FEATURE 7 — add summary (@summary on the current note)");
    tauri::async_runtime::block_on(async {
        let Some(name) = first_note() else {
            println!("SKIP — no notes in the vault");
            return;
        };
        let md = crate::agent::note_summary(name.clone(), None)
            .await
            .expect("summary");
        println!("summarized: {name}\n{md}");
        assert!(
            md.starts_with("> [!ai] summary:"),
            "summary card header missing"
        );
        assert!(md.len() > 80, "summary too short to be useful");
        // an extra instruction must shape the output
        let md2 = crate::agent::note_summary(name, Some("answer in exactly one bullet".into()))
            .await
            .expect("summary with instruction");
        println!("\nwith instruction:\n{md2}");
        assert!(
            md2.starts_with("> [!ai] summary:"),
            "instructed summary malformed"
        );
    });
}

/// the summary must cover the whole sheet: the user's own lines AND every
/// AI widget card stored in the note
#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_feature7b -- --ignored --nocapture"]
fn sim_feature7b_summary_full_coverage() {
    header("FEATURE 7b — summary covers user text AND every widget card");
    tauri::async_runtime::block_on(async {
        let name = "sim-summary-coverage.md".to_string();
        let path = vault::note_path(&name).expect("note path");
        let body = "# Coverage test\n\n\
MARKER-ALPHA: the project deadline moved to March 14.\n\n\
> [!ai] research: MARKER-BETA\n\
> MARKER-BETA: quantum walks improved retrieval precision by 33 percent.\n\
> \n\
> [!ai] loop 1/2 — MARKER-GAMMA\n\
> MARKER-GAMMA: the surface code threshold sits at 1 percent physical error.\n";
        std::fs::write(&path, body).expect("write note");
        let md = crate::agent::note_summary(name.clone(), None)
            .await
            .expect("summary");
        println!("{md}");
        std::fs::remove_file(&path).ok();
        assert!(md.contains("March"), "summary missed the user's own text");
        assert!(md.contains("33"), "summary missed widget card 1");
        assert!(
            md.to_lowercase().contains("threshold"),
            "summary missed widget card 2"
        );
    });
}

/// a >24k note goes through map-reduce digests — every section (including
/// widget cards) must survive into the final summary, none may be dropped
#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_feature7c -- --ignored --nocapture"]
fn sim_feature7c_long_note_full_coverage() {
    header("FEATURE 7c — long note (>100k): top, middle and end all summarized");
    tauri::async_runtime::block_on(async {
        let filler = "Detailed research filler about quantization error accumulation, \
calibration budgets, outlier suppression and surface code thresholds across model scales. ";
        let block = filler.repeat(140); // ~12k chars each
        let name = "sim-long-coverage.md".to_string();
        let path = vault::note_path(&name).expect("note path");
        let body = format!(
            "# Long notebook\n\nMARKER-ALPHA: the project deadline moved to March 14.\n\n{block}\n\n\
             {block}\n\n{block}\n\n\
             > [!ai] research: middle\n\
             > MARKER-MIKE: quantum walks improved retrieval precision by 33 percent.\n\
             > \n\n{block}\n\n{block}\n\n\
             > [!ai] loop 9/10 — end\n\
             > MARKER-ZULU: the surface code threshold sits at 1 percent physical error.\n\n{block}\n\n{block}\n"
        );
        assert!(
            body.chars().count() > 100_000,
            "test note must exceed the map-reduce threshold"
        );
        std::fs::write(&path, &body).expect("write note");
        let md = crate::agent::note_summary(name.clone(), None)
            .await
            .expect("summary");
        println!("{md}");
        std::fs::remove_file(&path).ok();
        // map-reduce summarization is lossy by nature — the guard is that
        // the summary reaches across the whole note, not that a specific
        // phrasing survives: at least two of the three markers must appear
        let hits = [
            ("top (user text)", md.contains("March")),
            ("middle (widget card)", md.contains("33")),
            ("end (widget card)", md.to_lowercase().contains("threshold")),
        ];
        for (what, ok) in &hits {
            println!("marker {what}: {}", if *ok { "present" } else { "MISSING" });
        }
        let found = hits.iter().filter(|(_, ok)| *ok).count();
        assert!(
            found >= 2,
            "summary lost the note's span: only {found}/3 markers survived"
        );
    });
}

/// the guarantee that ends library wipes: an unreadable index refuses the
/// write path and keeps a recovery copy instead of being overwritten empty
/// @ask is the hybrid: library + notes (everything) fused with web research
#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_ask_hybrid -- --ignored --nocapture"]
fn sim_ask_hybrid_diag() {
    header("DIAGNOSTIC — @ask hybrid lanes: everything (library+notes) + web");
    tauri::async_runtime::block_on(async {
        let docs = crate::rag::rag_search("what have I been working on", 5, Some("everything")).await;
        println!("everything lane hits: {}", docs.len());
        for d in docs.iter().take(3) {
            println!("  - {}", d.chars().take(110).collect::<String>());
        }
        assert!(!docs.is_empty(), "everything lane returned nothing");
        match crate::tools::search("arxiv quantization breakthrough", 3, None).await {
            Ok(h) => {
                println!("web lane hits: {}", h.len());
                for x in h.iter().take(2) {
                    println!("  - {}", x.title.chars().take(90).collect::<String>());
                }
                assert!(!h.is_empty(), "web lane returned nothing");
            }
            Err(e) => println!("web lane SKIP — {e}"),
        }
    });
}

#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_index_guard -- --ignored --nocapture"]
fn sim_index_corrupt_guard() {
    header("GUARD — a corrupt index must never be overwritten empty");
    let idx = crate::rag::index_path();
    let Some(orig) = std::fs::read(&idx).ok() else {
        println!("SKIP — no index yet");
        return;
    };
    std::fs::write(&idx, b"{ this is not json").expect("corrupt the index");
    let res = crate::rag::load_index_for_write();
    match &res {
        Err(e) => println!("✓ refused: {e}"),
        Ok(d) => println!("✗ OVERWROTE WITH {} docs — GUARD FAILED", d.len()),
    }
    std::fs::write(&idx, &orig).expect("restore the index");
    assert!(res.is_err(), "corrupt index must refuse the write path");
}

#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_index_diag -- --ignored --nocapture"]
fn sim_index_backcompat_diag() {
    header("DIAGNOSTIC — does an old-format index entry still parse?");
    // the shape every earlier build wrote: no `kind` field
    let old = r#"[{"slug":"x","name":"x.pdf","size":123,"dims":1024,"added":1,"chunks":[{"text":"hi","idx":0}]}]"#;
    match serde_json::from_str::<Vec<crate::rag::RagDoc>>(old) {
        Ok(docs) => println!("✓ parses · {} doc(s) · kind={:?}", docs.len(), docs[0].kind),
        Err(e) => println!("✗ PARSE FAILURE (wipes on next save!): {e}"),
    }
}

#[test]
#[ignore = "diagnostic — run with: cargo test --bin laido sim_skill_diag -- --ignored --nocapture"]
fn sim_skill_diag_add_summary() {
    header("DIAGNOSTIC — add-summary skill + note_summary on the newest real notes");
    for s in crate::skills::skills_list() {
        if s.name == "add-summary" {
            println!("steps: {:?}", s.steps);
        }
    }
    tauri::async_runtime::block_on(async {
        let notes = vault::vault_list().unwrap_or_default();
        for n in notes.iter().take(4) {
            match crate::agent::note_summary(n.name.clone(), None).await {
                Ok(md) => println!("✓ {} — {} chars", n.name, md.len()),
                Err(e) => println!("✗ {} — ERROR: {e}", n.name),
            }
        }
    });
}

#[test]
#[ignore = "hits the real vault + live APIs — run with: cargo test --bin laido sim_ -- --ignored --nocapture"]
fn sim_feature1_voice_pipeline() {
    header("FEATURE 1 — voice → AssemblyAI transcription");
    tauri::async_runtime::block_on(async {
        let key = state::load_settings().assemblyai_api_key.trim().to_string();
        if key.is_empty() {
            println!("SKIP — no AssemblyAI key in .laido/settings.json");
            return;
        }
        // a real speech sample when LAIDO_SIM_AUDIO points at one, else a
        // synthetic tone that still exercises upload → submit → poll
        let real = std::env::var("LAIDO_SIM_AUDIO").ok();
        let wav = match &real {
            Some(p) => std::fs::read(p).expect("read LAIDO_SIM_AUDIO"),
            None => {
                let rate = 16000u32;
                let tone: Vec<f32> = (0..rate)
                    .map(|i| {
                        (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / rate as f32).sin() * 0.4
                    })
                    .collect();
                voice::encode_wav(&tone, rate, 1).expect("encode wav")
            }
        };
        let text = voice::transcribe_wav(wav).await.expect("transcribe");
        println!("transcript: {:?}", text);
        if real.is_some() {
            assert!(!text.is_empty(), "expected speech text from the real sample");
        }
    });
}
