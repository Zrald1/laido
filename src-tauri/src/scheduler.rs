use crate::agent;
use chrono::{Datelike, Local, NaiveDate, NaiveTime, TimeZone, Timelike, Weekday};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Serialize, Clone)]
struct Activity {
    text: String,
}

#[derive(Serialize)]
pub struct SchedRow {
    pub note: String,
    pub line: String,
    pub action: String,
    pub next: i64,
    pub last: i64,
    pub paused: bool,
}

#[derive(Serialize)]
pub struct DayPin {
    pub day: u32,
    pub time: String,
    pub action: String,
    pub note: String,
    pub line: String,
    pub kind: String,
}

#[derive(Clone, PartialEq)]
enum Spec {
    Daily(u32, u32),
    Days(Vec<Weekday>, u32, u32),
    Monthly(u32, u32, u32),
    Every(i64),
    Once(i64),
}

struct Entry {
    note: String,
    line: String,
    action: String,
    spec: Spec,
    paused: bool,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_hm(s: &str) -> Option<(u32, u32)> {
    let mut it = s.split(':');
    let h: u32 = it.next()?.trim().parse().ok()?;
    let m: u32 = it.next()?.trim().parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some((h, m))
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    match s.to_lowercase().as_str() {
        "mon" => Some(Weekday::Mon),
        "tue" => Some(Weekday::Tue),
        "wed" => Some(Weekday::Wed),
        "thu" => Some(Weekday::Thu),
        "fri" => Some(Weekday::Fri),
        "sat" => Some(Weekday::Sat),
        "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_days(s: &str) -> Option<Vec<Weekday>> {
    let all = [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ];
    if let Some((a, b)) = s.split_once('-') {
        let wa = parse_weekday(a)?;
        let wb = parse_weekday(b)?;
        let start = all.iter().position(|w| *w == wa)?;
        let end = all.iter().position(|w| *w == wb)?;
        let mut out = Vec::new();
        let mut i = start;
        loop {
            out.push(all[i]);
            if i == end {
                break;
            }
            i = (i + 1) % 7;
        }
        return Some(out);
    }
    Some(vec![parse_weekday(s)?])
}

fn parse_spec(rest: &str) -> Option<(Spec, String)> {
    let mut parts = rest.splitn(3, char::is_whitespace);
    let first = parts.next()?.trim();
    let second = parts.next()?.trim();
    match first {
        "daily" => {
            let (h, m) = parse_hm(second)?;
            Some((
                Spec::Daily(h, m),
                parts.next().unwrap_or("").trim().to_string(),
            ))
        }
        "every" => {
            let n: i64 = second.trim_end_matches('h').parse().ok()?;
            Some((
                Spec::Every(n * 3600),
                parts.next().unwrap_or("").trim().to_string(),
            ))
        }
        "monthly" => {
            let d: u32 = second.parse().ok()?;
            if !(1..=31).contains(&d) {
                return None;
            }
            let third = parts.next()?;
            let mut t = third.splitn(2, char::is_whitespace);
            let (h, m) = parse_hm(t.next()?.trim())?;
            Some((
                Spec::Monthly(d, h, m),
                t.next().unwrap_or("").trim().to_string(),
            ))
        }
        "once" => {
            let date = NaiveDate::parse_from_str(second, "%Y-%m-%d").ok()?;
            let third = parts.next()?;
            let mut t = third.splitn(2, char::is_whitespace);
            let (h, m) = parse_hm(t.next()?.trim())?;
            let action = t.next().unwrap_or("").trim().to_string();
            let dt = date
                .and_hms_opt(h, m, 0)?
                .and_local_timezone(Local)
                .single()?;
            Some((Spec::Once(dt.timestamp()), action))
        }
        wd => {
            let days = parse_days(wd)?;
            let (h, m) = parse_hm(second)?;
            Some((
                Spec::Days(days, h, m),
                parts.next().unwrap_or("").trim().to_string(),
            ))
        }
    }
}

fn clean_line(line: &str) -> String {
    // zero-width markers (empty-line serialization) are not Unicode
    // whitespace — trim() keeps them, so strip them explicitly or a
    // schedule typed on a blank line would never parse
    let t = line
        .trim()
        .trim_matches(|c: char| matches!(c, '\u{200b}' | '\u{feff}' | '\u{00a0}'))
        .trim();
    if let Some(rest) = t.strip_suffix(" off") {
        rest.trim().to_string()
    } else {
        t.to_string()
    }
}

fn parse_line(t: &str) -> Option<(Spec, String, bool)> {
    let rest = t.trim().strip_prefix("@schedule ")?.trim().to_string();
    let paused = rest.ends_with(" off");
    let body = if paused {
        rest[..rest.len() - 4].trim().to_string()
    } else {
        rest
    };
    let (spec, action) = parse_spec(&body)?;
    if action.is_empty() {
        return None;
    }
    Some((spec, action, paused))
}

fn today_at(h: u32, m: u32) -> i64 {
    let now_dt = Local::now();
    let t = NaiveTime::from_hms_opt(h, m, 0).unwrap_or_default();
    now_dt
        .date_naive()
        .and_time(t)
        .and_local_timezone(Local)
        .single()
        .map(|dt| dt.timestamp())
        .unwrap_or_else(|| now_dt.timestamp())
}

fn weekday_of(ts: i64) -> Option<Weekday> {
    Local.timestamp_opt(ts, 0).single().map(|d| d.weekday())
}

fn month_shift(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let mut y = year;
    let mut m = month as i32 + delta;
    while m < 1 {
        m += 12;
        y -= 1;
    }
    while m > 12 {
        m -= 12;
        y += 1;
    }
    (y, m as u32)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = month_shift(year, month, 1);
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn month_day_ts(year: i32, month: u32, day: u32, h: u32, m: u32) -> Option<i64> {
    let day = day.min(days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(h, m, 0)?
        .and_local_timezone(Local)
        .single()
        .map(|dt| dt.timestamp())
}

fn occurrence(spec: &Spec, last: i64) -> (bool, i64, i64) {
    let n = now();
    match spec {
        Spec::Daily(h, m) => {
            let today = today_at(*h, *m);
            let occ = if today <= n { today } else { today - 86400 };
            let next = if today > n { today } else { today + 86400 };
            (occ > last && n >= occ, occ, next)
        }
        Spec::Days(days, h, m) => {
            let today = today_at(*h, *m);
            let mut occ = today;
            for _ in 0..7 {
                if weekday_of(occ).map(|w| days.contains(&w)).unwrap_or(false) {
                    break;
                }
                occ -= 86400;
            }
            let mut next = today;
            for _ in 0..8 {
                if next > n && weekday_of(next).map(|w| days.contains(&w)).unwrap_or(false) {
                    break;
                }
                next += 86400;
            }
            (occ > last && n >= occ, occ, next)
        }
        Spec::Monthly(d, h, m) => {
            let now_dt = Local::now();
            let (y, mo) = (now_dt.year(), now_dt.month());
            let this = month_day_ts(y, mo, *d, *h, *m).unwrap_or(n);
            let (py, pm) = month_shift(y, mo, -1);
            let (ny, nm) = month_shift(y, mo, 1);
            let occ = if this <= n {
                this
            } else {
                month_day_ts(py, pm, *d, *h, *m).unwrap_or(this)
            };
            let next = if this > n {
                this
            } else {
                month_day_ts(ny, nm, *d, *h, *m).unwrap_or(this)
            };
            (occ > last && n >= occ, occ, next)
        }
        Spec::Every(secs) => {
            if last == 0 {
                (false, n, n + secs)
            } else {
                (n - last >= *secs, last + secs, last + 2 * secs)
            }
        }
        Spec::Once(ts) => (*ts > last && n >= *ts, *ts, *ts),
    }
}

fn state_path() -> PathBuf {
    crate::vault::vault_root()
        .join(".laido")
        .join("schedule.json")
}

fn load_state() -> HashMap<String, i64> {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(map: &HashMap<String, i64>) {
    if let Some(dir) = state_path().parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string_pretty(map) {
        let _ = fs::write(state_path(), t);
    }
}

fn collect() -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(crate::vault::notes_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !crate::vault::is_note_file(&path) {
            continue;
        }
        let note = entry.file_name().to_string_lossy().into_owned();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for line in content.lines() {
            let t = clean_line(line);
            if let Some((spec, action, paused)) = parse_line(&t) {
                out.push(Entry {
                    note: note.clone(),
                    line: t,
                    action,
                    spec,
                    paused,
                });
            }
        }
    }
    out
}

fn action_kind(action: &str) -> String {
    if action.starts_with("@research") {
        "research".into()
    } else if action.starts_with("remind:") {
        "remind".into()
    } else if action.starts_with("prompt:") {
        "prompt".into()
    } else if action.starts_with('?') {
        "ask".into()
    } else if action == "brief" {
        "brief".into()
    } else if action == "review" {
        "review".into()
    } else {
        "other".into()
    }
}

fn notify(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("Laido")
        .body(body)
        .show();
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        tick(&app);
    });
}

fn fire(app: &AppHandle, e: &Entry) {
    let text = format!("⏰ schedule fired: {}", e.line);
    crate::vault::log_activity(&text);
    let _ = app.emit("agent:activity", Activity { text });
    if e.action == "brief" {
        notify(app, "⏰ scheduled brief is running…");
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            agent::run_brief(app2, 24, "brief.laido", "morning brief", false, None).await
        });
    } else if e.action == "review" {
        notify(app, "⏰ weekly review is running…");
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            agent::run_brief(app2, 168, "review.laido", "weekly review", false, None).await
        });
    } else if let Some(topic) = e.action.strip_prefix("@research ") {
        crate::skills::habit_track(app.clone(), e.note.clone(), format!("@research {}", topic.trim()));
        agent::spawn_topics(
            app.clone(),
            e.note.clone(),
            vec![topic.trim().to_string()],
            false,
            None,
        );
    } else if let Some(rest) = e.action.strip_prefix("@skill ") {
        let (target, query) = match rest.trim().split_once(' ') {
            Some((t, q)) => (t.to_string(), q.trim().to_string()),
            None => (rest.trim().to_string(), String::new()),
        };
        let is_rag = !query.is_empty() && (target == "all-files" || crate::rag::has_doc(&target));
        if is_rag {
            let app2 = app.clone();
            let note = e.note.clone();
            let q = query.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) =
                    crate::rag::rag_ask(app2.clone(), note, target, q, false, None, None, None, None).await
                {
                    let _ = app2.emit(
                        "agent:activity",
                        Activity {
                            text: format!("⏰ rag failed: {err}"),
                        },
                    );
                }
            });
        } else if let Err(err) =
            crate::skills::skill_run(app.clone(), e.note.clone(), target, false)
        {
            let _ = app.emit(
                "agent:activity",
                Activity {
                    text: format!("⏰ skill failed: {err}"),
                },
            );
        }
    } else if let Some(text) = e.action.strip_prefix("remind:") {
        let text = text.trim().to_string();
        notify(app, &format!("Reminder: {text}"));
        let _ = app.emit(
            "remind:fired",
            serde_json::json!({ "note": e.note, "text": text, "ts": now() }),
        );
        let app2 = app.clone();
        let note = e.note.clone();
        let action = e.action.clone();
        tauri::async_runtime::spawn(async move {
            agent::run_prompt(app2, note, action, false, None).await
        });
    } else if e.action.starts_with("prompt:") || e.action.starts_with('?') {
        let app2 = app.clone();
        let note = e.note.clone();
        let action = e.action.clone();
        tauri::async_runtime::spawn(async move {
            agent::run_prompt(app2, note, action, false, None).await
        });
    } else {
        let _ = app.emit(
            "agent:activity",
            Activity {
                text: format!("⏰ unknown schedule action: {}", e.action),
            },
        );
    }
}

fn tick(app: &AppHandle) {
    let mut state = load_state();
    let mut changed = false;
    for e in collect() {
        if e.paused {
            continue;
        }
        let key = format!("{}|{}", e.note, e.line);
        let last = *state.get(&key).unwrap_or(&0);
        if last == 0 && matches!(e.spec, Spec::Every(_)) {
            state.insert(key, now());
            changed = true;
            continue;
        }
        let (due, occ, _next) = occurrence(&e.spec, last);
        if !due {
            continue;
        }
        let cap = if e.action.starts_with("@research") {
            12 * 3600
        } else {
            48 * 3600
        };
        if now() - occ <= cap {
            fire(app, &e);
        } else {
            let text = format!("⏰ missed (too late, skipped): {}", e.line);
            crate::vault::log_activity(&text);
            let _ = app.emit("agent:activity", Activity { text });
        }
        state.insert(key, now());
        changed = true;
    }
    if changed {
        save_state(&state);
    }
}

#[tauri::command]
pub fn schedule_list() -> Vec<SchedRow> {
    let state = load_state();
    let mut out: Vec<SchedRow> = collect()
        .into_iter()
        .map(|e| {
            let last = *state.get(&format!("{}|{}", e.note, e.line)).unwrap_or(&0);
            let (_, _, next) = occurrence(&e.spec, last);
            SchedRow {
                note: e.note,
                line: e.line,
                action: e.action,
                next,
                last,
                paused: e.paused,
            }
        })
        .collect();
    out.sort_by(|a, b| a.next.cmp(&b.next));
    out
}

#[tauri::command]
pub fn schedule_month(year: i32, month: u32) -> Vec<DayPin> {
    let state = load_state();
    let mut out: Vec<DayPin> = Vec::new();
    for e in collect() {
        if e.paused {
            continue;
        }
        let kind = action_kind(&e.action);
        let mut push = |day: u32, h: u32, m: u32| {
            out.push(DayPin {
                day,
                time: format!("{:02}:{:02}", h, m),
                action: e.action.clone(),
                note: e.note.clone(),
                line: e.line.clone(),
                kind: kind.clone(),
            });
        };
        match &e.spec {
            Spec::Daily(h, m) => {
                for day in 1..=days_in_month(year, month) {
                    push(day, *h, *m);
                }
            }
            Spec::Days(days, h, m) => {
                for day in 1..=days_in_month(year, month) {
                    if let Some(ts) = month_day_ts(year, month, day, *h, *m) {
                        if weekday_of(ts).map(|w| days.contains(&w)).unwrap_or(false) {
                            push(day, *h, *m);
                        }
                    }
                }
            }
            Spec::Monthly(d, h, m) => {
                push((*d).min(days_in_month(year, month)), *h, *m);
            }
            Spec::Once(ts) => {
                if let Some(dt) = Local.timestamp_opt(*ts, 0).single() {
                    if dt.year() == year && dt.month() == month {
                        push(dt.day(), dt.hour(), dt.minute());
                    }
                }
            }
            Spec::Every(_) => {
                let last = *state.get(&format!("{}|{}", e.note, e.line)).unwrap_or(&0);
                let (_, _, next) = occurrence(&e.spec, last);
                if let Some(dt) = Local.timestamp_opt(next, 0).single() {
                    if dt.year() == year && dt.month() == month {
                        push(dt.day(), dt.hour(), dt.minute());
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.day.cmp(&b.day).then(a.time.cmp(&b.time)));
    out
}

#[tauri::command]
pub fn schedule_run_now(app: AppHandle, note: String, line: String) -> Result<(), String> {
    let cleaned = clean_line(&line);
    let entry = collect()
        .into_iter()
        .find(|e| e.note == note && e.line == cleaned)
        .ok_or_else(|| "schedule not found".to_string())?;
    fire(&app, &entry);
    let mut state = load_state();
    state.insert(format!("{}|{}", note, cleaned), now());
    save_state(&state);
    Ok(())
}

fn write_note_lines(name: &str, lines: Vec<String>) -> Result<(), String> {
    let path = crate::vault::note_path(name)?;
    let mut text = lines.join("\n");
    text.push('\n');
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn schedule_toggle(note: String, line: String) -> Result<(), String> {
    let cleaned = clean_line(&line);
    let path = crate::vault::note_path(&note)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut lines: Vec<String> = Vec::new();
    let mut found = false;
    for l in content.lines() {
        if clean_line(l) == cleaned {
            found = true;
            if l.trim().ends_with(" off") {
                lines.push(cleaned.clone());
            } else {
                lines.push(format!("{} off", cleaned));
            }
        } else {
            lines.push(l.to_string());
        }
    }
    if !found {
        return Err("schedule not found".into());
    }
    write_note_lines(&note, lines)
}

#[tauri::command]
pub fn schedule_remove(note: String, line: String) -> Result<(), String> {
    let cleaned = clean_line(&line);
    let path = crate::vault::note_path(&note)?;
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<String> = content
        .lines()
        .filter(|l| clean_line(l) != cleaned)
        .map(|l| l.to_string())
        .collect();
    write_note_lines(&note, lines)
}

#[tauri::command]
pub fn schedule_create(note: String, spec: String, action: String) -> Result<String, String> {
    let line = format!("@schedule {} {}", spec.trim(), action.trim());
    if parse_line(&line).is_none() {
        return Err("invalid schedule".into());
    }
    let path = crate::vault::note_path(&note)?;
    if !path.exists() {
        fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    if !content.is_empty() {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push('\n');
    }
    content.push_str(&line);
    content.push('\n');
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(line)
}
