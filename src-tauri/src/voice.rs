//! Voice notes: record the mic natively (cpal), encode WAV, transcribe with
//! AssemblyAI (upload → submit → poll), return the text for the sheet.
//! Native capture avoids WebView2's sticky getUserMedia permission flow.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tokio_tungstenite::tungstenite::Message;

/// cpal marks Stream !Send because a few backends are thread-bound; WASAPI /
/// CoreAudio / ALSA streams drop safely from any thread, and keeping the
/// stream in a static slot requires the marker. Drop happens on the tauri
/// runtime thread, never concurrently with the audio callback.
struct SendStream(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

struct Rec {
    stream: SendStream,
    buf: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    channels: u16,
}

fn slot() -> &'static Mutex<Option<Rec>> {
    static S: OnceLock<Mutex<Option<Rec>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn start_capture() -> Result<Rec, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("no microphone found — check Windows sound settings")?;
    let cfg = device.default_input_config().map_err(|e| e.to_string())?;
    let rate = cfg.sample_rate().0;
    let channels = cfg.channels();
    let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
    let sink = buf.clone();
    let err_fn = |e| eprintln!("mic stream error: {e}");
    let config: cpal::StreamConfig = cfg.clone().into();
    let stream = match cfg.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |d: &[f32], _| sink.lock().unwrap().extend_from_slice(d),
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |d: &[i16], _| {
                let mut b = sink.lock().unwrap();
                b.extend(d.iter().map(|s| *s as f32 / 32768.0));
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |d: &[u16], _| {
                let mut b = sink.lock().unwrap();
                b.extend(d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0));
            },
            err_fn,
            None,
        ),
        other => return Err(format!("unsupported mic sample format: {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(Rec {
        stream: SendStream(stream),
        buf,
        rate,
        channels,
    })
}

/// record mode: capture now, transcribe when the user clicks again
#[tauri::command]
pub fn voice_start() -> Result<(), String> {
    let mut guard = slot().lock().unwrap();
    if guard.is_some() {
        return Err("already recording".into());
    }
    *guard = Some(start_capture()?);
    Ok(())
}

/// current mic loudness (RMS of the last ~46ms of capture) — the widget's
/// VU meter polls this while recording; 0 when not recording
#[tauri::command]
pub fn voice_level() -> f32 {
    let guard = slot().lock().unwrap();
    let Some(rec) = guard.as_ref() else {
        return 0.0;
    };
    let buf = rec.buf.lock().unwrap();
    let n = buf.len().min(2048);
    if n == 0 {
        return 0.0;
    }
    let tail = &buf[buf.len() - n..];
    (tail.iter().map(|s| s * s).sum::<f32>() / n as f32).sqrt()
}

#[tauri::command]
pub async fn voice_stop() -> Result<String, String> {
    let Rec {
        stream,
        buf,
        rate,
        channels,
    } = slot().lock().unwrap().take().ok_or("not recording")?;
    drop(stream); // stopping the stream releases the mic
    let samples = buf.lock().unwrap().clone();
    if samples.len() < (rate as usize / 2) * channels as usize {
        return Err("recording too short — hold the mic a moment longer".into());
    }
    let wav = encode_wav(&samples, rate, channels)?;
    transcribe_wav(wav).await
}

/// downmix to mono 16-bit PCM and wrap in a RIFF/WAV container
pub fn encode_wav(samples: &[f32], rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    let mono: Vec<i16> = if channels <= 1 {
        samples
            .iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect()
    } else {
        samples
            .chunks(channels as usize)
            .map(|f| {
                let a: f32 = f.iter().sum::<f32>() / f.len() as f32;
                (a.clamp(-1.0, 1.0) * 32767.0) as i16
            })
            .collect()
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut w = hound::WavWriter::new(&mut out, spec).map_err(|e| e.to_string())?;
        for s in mono {
            w.write_sample(s).map_err(|e| e.to_string())?;
        }
        w.finalize().map_err(|e| e.to_string())?;
    }
    Ok(out.into_inner())
}

/* ---------- live transcription: AssemblyAI streaming v3 websocket ---------- */

/// managed (lk- / Laido cloud) session → (base, token): the gateway holds
/// the AssemblyAI key, the app only ever sees short-lived grants
fn managed() -> Option<(String, String)> {
    let s = crate::state::load_settings();
    let on = s.nebius_api_key.starts_with("lk-") || s.base_url.starts_with("https://laido.");
    if on && !s.nebius_api_key.is_empty() {
        Some((
            s.base_url.trim_end_matches('/').to_string(),
            s.nebius_api_key,
        ))
    } else {
        None
    }
}

async fn ws_request(
    rate: u32,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let url = format!(
        "wss://streaming.assemblyai.com/v3/ws?sample_rate={rate}&encoding=pcm_s16le&speech_model=universal-3-6-pro"
    );
    // managed: mint a temporary realtime token via the gateway and put it in
    // the url — no AssemblyAI key is held (or sent) by the client at all
    if let Some((base, lk)) = managed() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        if let Ok(resp) = client
            .post(format!("{base}/realtime-token"))
            .bearer_auth(&lk)
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(j) = resp.json::<serde_json::Value>().await {
                    if let Some(tok) = j["token"].as_str() {
                        return format!("{url}&token={tok}")
                            .into_client_request()
                            .map_err(|e| e.to_string());
                    }
                }
            }
        }
        // gateway unreachable / token mint failed — BYOK fallback if the user
        // pasted their own key, else surface the real error
        if crate::state::load_settings()
            .assemblyai_api_key
            .trim()
            .is_empty()
        {
            return Err("voice service unreachable — check your connection".into());
        }
    }
    let key = crate::state::load_settings()
        .assemblyai_api_key
        .trim()
        .to_string();
    if key.is_empty() {
        return Err("add your AssemblyAI key in Settings (gear icon)".into());
    }
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    req.headers_mut().insert(
        "Authorization",
        key.parse().map_err(|_| "invalid AssemblyAI key".to_string())?,
    );
    Ok(req)
}

enum WsOutcome {
    Continue,
    Done,
    Err(String),
}

/// the streaming API requires every audio message to carry 50–1000 ms of
/// audio (error 3007 otherwise) — 50 ms at 16 kHz is 800 samples
const WS_MIN_SAMPLES: usize = 800;
const WS_MAX_SAMPLES: usize = 16_000;

fn handle_ws_msg(msg: &Message, final_text: &mut String, partial: &mut String) -> WsOutcome {
    match msg {
        Message::Text(t) => {
            let Ok(j) = serde_json::from_str::<serde_json::Value>(t) else {
                return WsOutcome::Continue;
            };
            match j["type"].as_str().unwrap_or("") {
                "Turn" => {
                    let tr = j["transcript"].as_str().unwrap_or("");
                    if j["end_of_turn"].as_bool().unwrap_or(false) {
                        if !tr.trim().is_empty() {
                            final_text.push_str(tr.trim());
                            final_text.push(' ');
                        }
                        partial.clear();
                    } else {
                        *partial = tr.to_string();
                    }
                    WsOutcome::Continue
                }
                "Termination" => WsOutcome::Done,
                "Error" => WsOutcome::Err(
                    j["error"]
                        .as_str()
                        .unwrap_or("streaming session error")
                        .to_string(),
                ),
                _ => WsOutcome::Continue,
            }
        }
        Message::Close(_) => WsOutcome::Done,
        _ => WsOutcome::Continue,
    }
}

/// pad a final sub-50 ms tail with silence so the last message stays legal
fn padded(mut seg: Vec<i16>) -> Vec<i16> {
    if seg.len() < WS_MIN_SAMPLES {
        seg.resize(WS_MIN_SAMPLES, 0);
    }
    seg
}

/// interleaved i16 frames → mono 16k s16le (nearest-neighbour)
#[allow(dead_code)]
pub fn to_pcm16k(samples: &[i16], rate: u32, channels: u16) -> Vec<i16> {
    let ch = channels.max(1) as usize;
    let ratio = (rate as f64 / 16000.0).max(1.0);
    let mut out = Vec::new();
    let mut next_at = 0.0f64;
    for (i, frame) in samples.chunks_exact(ch).enumerate() {
        let mono = frame.iter().map(|s| *s as f32 / 32768.0).sum::<f32>() / ch as f32;
        if i as f64 >= next_at {
            out.push((mono.clamp(-1.0, 1.0) * 32767.0) as i16);
            next_at += ratio;
        }
    }
    out
}

#[allow(dead_code)]
/// stream a PCM buffer through the v3 websocket in ~50 ms chunks (real-time
/// pacing) and return the final transcript — the same session logic the live
/// mic uses, feedable from a file so it can be simulated end to end
pub async fn stream_pcm_to_text(pcm: Vec<i16>, rate: u32) -> Result<String, String> {
    let (ws, _) = tokio_tungstenite::connect_async(ws_request(rate).await?)
        .await
        .map_err(|e| format!("streaming connect failed: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    let mut final_text = String::new();
    let mut partial = String::new();
    let chunk = (rate as usize / 20).max(WS_MIN_SAMPLES); // 50 ms
    let mut pos = 0usize;
    let mut terminated = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
    while tokio::time::Instant::now() < deadline {
        if pos < pcm.len() {
            let end = (pos + chunk).min(pcm.len());
            let seg = padded(pcm[pos..end].to_vec());
            let bytes: Vec<u8> = seg.iter().flat_map(|s| s.to_le_bytes()).collect();
            sink.send(Message::Binary(bytes.into()))
                .await
                .map_err(|e| e.to_string())?;
            pos = end;
        } else if !terminated {
            sink.send(Message::Text("{\"type\":\"Terminate\"}".into()))
                .await
                .map_err(|e| e.to_string())?;
        }
        // drain whatever the server has said so far without stalling the feed
        while let Ok(Some(Ok(msg))) =
            tokio::time::timeout(std::time::Duration::from_millis(1), stream.next()).await
        {
            match handle_ws_msg(&msg, &mut final_text, &mut partial) {
                WsOutcome::Continue => {}
                WsOutcome::Done => terminated = true,
                WsOutcome::Err(e) => return Err(e),
            }
        }
        if terminated {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(final_text.trim().to_string())
}

struct Live {
    stop: Arc<AtomicBool>,
    text: Arc<Mutex<String>>,
    join: tauri::async_runtime::JoinHandle<()>,
}

fn live_slot() -> &'static Mutex<Option<Live>> {
    static S: OnceLock<Mutex<Option<Live>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// live mode: the mic feeds the websocket continuously and partial text is
/// emitted as it is recognized; clicking the mic again stops and finalizes
#[tauri::command]
pub async fn voice_live_start(app: tauri::AppHandle) -> Result<(), String> {
    if live_slot().lock().unwrap().is_some() {
        return Err("already live".into());
    }
    let rec = start_capture()?;
    let (rate, channels) = (rec.rate, rec.channels);
    *slot().lock().unwrap() = Some(rec);
    let stop = Arc::new(AtomicBool::new(false));
    let text = Arc::new(Mutex::new(String::new()));
    let (s_flag, s_text) = (stop.clone(), text.clone());
    let app2 = app.clone();
    let join = tauri::async_runtime::spawn(async move {
        if let Err(e) = live_loop(&app2, &s_flag, &s_text, rate, channels).await {
            let _ = app2.emit("voice:error", serde_json::json!({ "error": e }));
        }
    });
    *live_slot().lock().unwrap() = Some(Live { stop, text, join });
    Ok(())
}

#[tauri::command]
pub async fn voice_live_stop() -> Result<String, String> {
    let Some(live) = live_slot().lock().unwrap().take() else {
        return Err("not live".into());
    };
    live.stop.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let _ = live.join.await;
    })
    .await;
    slot().lock().unwrap().take(); // release the mic
    let text = live.text.lock().unwrap().trim().to_string();
    Ok(text)
}

async fn live_loop(
    app: &tauri::AppHandle,
    stop: &AtomicBool,
    text: &Mutex<String>,
    mic_rate: u32,
    channels: u16,
) -> Result<(), String> {
    let (ws, _) = tokio_tungstenite::connect_async(ws_request(16000).await?)
        .await
        .map_err(|e| format!("streaming connect failed: {e}"))?;
    let (mut sink, mut stream) = ws.split();
    let ch = channels.max(1) as usize;
    let ratio = (mic_rate as f64 / 16000.0).max(1.0);
    let mut frames_consumed: u64 = 0;
    let mut next_at = 0.0f64;
    let mut partial = String::new();
    let mut pending: Vec<i16> = Vec::new();
    loop {
        tokio::select! {
            // audio tick: drain the mic, resample, ship legal 50–1000 ms
            // messages — the streaming API rejects anything shorter (3007)
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                let drained: Vec<f32> = {
                    let guard = slot().lock().unwrap();
                    match guard.as_ref() {
                        Some(r) => {
                            let mut b = r.buf.lock().unwrap();
                            std::mem::take(&mut *b)
                        }
                        None => break,
                    }
                };
                let frames = drained.len() / ch;
                for (j, frame) in drained.chunks_exact(ch).enumerate() {
                    let g = (frames_consumed + j as u64) as f64;
                    if g >= next_at {
                        let mono = frame.iter().sum::<f32>() / ch as f32;
                        pending.push((mono.clamp(-1.0, 1.0) * 32767.0) as i16);
                        next_at += ratio;
                    }
                }
                frames_consumed += frames as u64;
                while pending.len() >= WS_MIN_SAMPLES {
                    let take = pending.len().min(WS_MAX_SAMPLES);
                    let seg: Vec<i16> = pending.drain(..take).collect();
                    let bytes: Vec<u8> = seg.iter().flat_map(|s| s.to_le_bytes()).collect();
                    sink.send(Message::Binary(bytes.into()))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
            }
            // server messages are handled the moment they arrive — never
            // through a polling timeout that could drop them
            msg = stream.next() => {
                match msg {
                    Some(Ok(m)) => {
                        match handle_ws_msg(&m, &mut text.lock().unwrap(), &mut partial) {
                            WsOutcome::Continue => {}
                            WsOutcome::Done => return Ok(()),
                            WsOutcome::Err(e) => {
                                let _ = app.emit("voice:error", serde_json::json!({ "error": e }));
                                return Ok(());
                            }
                        }
                        let _ = app.emit(
                            "voice:partial",
                            serde_json::json!({
                                "final": text.lock().unwrap().clone(),
                                "partial": partial,
                            }),
                        );
                    }
                    Some(Err(e)) => {
                        let _ = app.emit("voice:error", serde_json::json!({ "error": e.to_string() }));
                        return Ok(());
                    }
                    None => return Ok(()),
                }
            }
        }
    }
    // flush whatever audio is still pending — padded so it stays legal
    if !pending.is_empty() {
        let seg = padded(std::mem::take(&mut pending));
        let bytes: Vec<u8> = seg.iter().flat_map(|s| s.to_le_bytes()).collect();
        let _ = sink.send(Message::Binary(bytes.into())).await;
    }
    let _ = sink.send(Message::Text("{\"type\":\"Terminate\"}".into())).await;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_millis(500), stream.next()).await {
            Ok(Some(Ok(msg))) => {
                match handle_ws_msg(&msg, &mut text.lock().unwrap(), &mut partial) {
                    WsOutcome::Continue => {}
                    WsOutcome::Done => break,
                    WsOutcome::Err(e) => {
                        let _ = app.emit("voice:error", serde_json::json!({ "error": e }));
                        break;
                    }
                }
                let _ = app.emit(
                    "voice:partial",
                    serde_json::json!({
                        "final": text.lock().unwrap().clone(),
                        "partial": "",
                    }),
                );
            }
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => {}
        }
    }
    Ok(())
}

/// poll a transcript until AssemblyAI reports done — `auth` is the full
/// Authorization header value (raw key for BYOK, "Bearer lk-…" for managed)
async fn wait_transcript(
    client: &reqwest::Client,
    url: &str,
    auth: &str,
) -> Result<String, String> {
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let poll = client
            .get(url)
            .header("authorization", auth)
            .send()
            .await
            .map_err(|e| format!("poll failed: {e}"))?;
        let j: serde_json::Value = poll.json().await.map_err(|e| e.to_string())?;
        match j["status"].as_str().unwrap_or("") {
            "completed" => return Ok(j["text"].as_str().unwrap_or("").trim().to_string()),
            "error" => {
                return Err(j["error"].as_str().unwrap_or("transcription failed").to_string())
            }
            _ => {}
        }
    }
    Err("transcription timed out".into())
}

/// the AssemblyAI flow: upload bytes → submit transcript → poll until done
pub async fn transcribe_wav(wav: Vec<u8>) -> Result<String, String> {
    let key = crate::state::load_settings().assemblyai_api_key.trim().to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    // managed: the gateway performs upload+submit server-side and we poll it
    // back through the same proxy — the real key never leaves the server
    if let Some((base, lk)) = managed() {
        let sub = client
            .post(format!("{base}/transcribe"))
            .bearer_auth(&lk)
            .header("content-type", "application/octet-stream")
            .body(wav.clone())
            .send()
            .await;
        if let Ok(sub) = sub {
            if sub.status().is_success() {
                if let Ok(subj) = sub.json::<serde_json::Value>().await {
                    if let Some(id) = subj["id"].as_str() {
                        return wait_transcript(
                            &client,
                            &format!("{base}/transcript/{id}"),
                            &format!("Bearer {lk}"),
                        )
                        .await;
                    }
                }
            }
        }
        if key.is_empty() {
            return Err("voice service unreachable — check your connection".into());
        }
    }
    if key.is_empty() {
        return Err("add your AssemblyAI key in Settings (gear icon)".into());
    }
    let up = client
        .post("https://api.assemblyai.com/v2/upload")
        .header("authorization", &key)
        .header("content-type", "application/octet-stream")
        .body(wav)
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    if !up.status().is_success() {
        return Err(format!("assemblyai upload → {}", up.status()));
    }
    let upj: serde_json::Value = up.json().await.map_err(|e| e.to_string())?;
    let upload_url = upj["upload_url"]
        .as_str()
        .ok_or("assemblyai returned no upload_url")?
        .to_string();
    let sub = client
        .post("https://api.assemblyai.com/v2/transcript")
        .header("authorization", &key)
        .json(&serde_json::json!({ "audio_url": upload_url }))
        .send()
        .await
        .map_err(|e| format!("submit failed: {e}"))?;
    let subj: serde_json::Value = sub.json().await.map_err(|e| e.to_string())?;
    let id = subj["id"]
        .as_str()
        .ok_or("assemblyai returned no transcript id")?
        .to_string();
    wait_transcript(
        &client,
        &format!("https://api.assemblyai.com/v2/transcript/{id}"),
        &key,
    )
    .await
}
