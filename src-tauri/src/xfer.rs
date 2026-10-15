/* ---------- xfer — import/export for the widgets ----------
 * Sheets ↔ CSV/TSV/.xlsx (calamine reads, rust_xlsxwriter writes real
 * formulas). Decks ↔ .pptx (hand-rolled OOXML over the zip crate —
 * write a minimal-but-valid package, read slides + notes back). */
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use calamine::Reader as _;
use base64::Engine as _;
use std::path::{Path, PathBuf};

/// relative paths resolve inside the vault; absolute paths pass through —
/// the file dialog hands us absolute paths the user picked on purpose
fn resolve(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    let root = crate::vault::vault_root();
    Ok(root.join(p))
}

#[tauri::command]
pub fn file_write_text(path: String, content: String) -> Result<String, String> {
    let p = resolve(&path)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, content).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

#[tauri::command]
pub fn file_read_text(path: String) -> Result<String, String> {
    fs::read_to_string(resolve(&path)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_write_b64(path: String, base64_data: String) -> Result<String, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &base64_data)
        .map_err(|e| e.to_string())?;
    let p = resolve(&path)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/* =================== XLSX =================== */

/// cells: rows of raw cell text — "=…" becomes a real Excel formula,
/// numerics write as numbers, everything else as text
#[tauri::command]
pub fn sheet_xlsx_export(path: String, cells: Vec<Vec<String>>) -> Result<String, String> {
    let p = resolve(&path)?;
    let p = if p.extension().is_some() {
        p
    } else {
        p.with_extension("xlsx")
    };
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut wb = rust_xlsxwriter::Workbook::new();
    let ws = wb.add_worksheet().set_name("Sheet").map_err(|e| e.to_string())?;
    for (r, row) in cells.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            let (r, c) = (r as u32, c as u16);
            if v.is_empty() {
                continue;
            } else if v.starts_with('=') {
                // real formula — Excel recalcs on open (no cached value needed)
                ws.write_formula(r, c, v.as_str()).map_err(|e| e.to_string())?;
            } else if let Ok(n) = v.parse::<f64>() {
                ws.write_number(r, c, n).map_err(|e| e.to_string())?;
            } else {
                ws.write_string(r, c, v.as_str()).map_err(|e| e.to_string())?;
            }
        }
    }
    wb.save(&p).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// first sheet of an .xlsx/.xls/.ods → a rectangular grid of strings
/// (calamine returns computed values — formulas don't survive import,
/// they're an Excel-runtime thing)
#[tauri::command]
pub fn sheet_xlsx_import(path: String, sheet: Option<String>) -> Result<Vec<Vec<String>>, String> {
    let p = resolve(&path)?;
    let mut wb = calamine::open_workbook_auto(&p).map_err(|e| format!("can't open: {e}"))?;
    let name = match sheet {
        Some(s) => s,
        None => wb
            .sheet_names()
            .first()
            .cloned()
            .ok_or("workbook has no sheets")?,
    };
    let range = wb
        .worksheet_range(&name)
        .map_err(|e| format!("can't read sheet \"{name}\": {e}"))?;
    let mut out: Vec<Vec<String>> = Vec::new();
    for row in range.rows() {
        out.push(
            row.iter()
                .map(|c| match c {
                    calamine::Data::Empty => String::new(),
                    calamine::Data::String(s) => s.clone(),
                    calamine::Data::Float(f) => {
                        if f.fract() == 0.0 && f.abs() < 1e15 {
                            format!("{}", *f as i64)
                        } else {
                            format!("{f}")
                        }
                    }
                    calamine::Data::Int(i) => i.to_string(),
                    calamine::Data::Bool(b) => b.to_string().to_uppercase(),
                    calamine::Data::Error(e) => format!("{e:?}"),
                    calamine::Data::DateTime(dt) => dt.to_string(),
                    calamine::Data::DateTimeIso(s) => s.clone(),
                    calamine::Data::DurationIso(s) => s.clone(),
                })
                .collect(),
        );
    }
    // trim trailing all-empty rows/cols so the grid lands tight
    while out.last().map(|r| r.iter().all(|c| c.is_empty())) == Some(true) {
        out.pop();
    }
    Ok(out)
}

/// the sheet names inside a workbook — the UI offers a picker when >1
#[tauri::command]
pub fn sheet_xlsx_sheets(path: String) -> Result<Vec<String>, String> {
    let wb = calamine::open_workbook_auto(resolve(&path)?).map_err(|e| format!("can't open: {e}"))?;
    Ok(wb.sheet_names())
}

/* =================== PPTX =================== */

#[derive(Serialize, Deserialize, Clone)]
pub struct SlideOut {
    pub layout: String,
    pub title: String,
    pub sub: String,
    pub bullets: Vec<String>,
    pub cols: (Vec<String>, Vec<String>),
    pub img: String,
    pub quote: String,
    pub by: String,
    pub body: String,
    pub note: String,
    pub bg: String,
}

#[derive(Serialize, Deserialize)]
pub struct DeckOut {
    pub title: String,
    pub slides: Vec<SlideOut>,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn hex6(c: &str) -> Option<String> {
    let h = c.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|x| x.is_ascii_hexdigit()) {
        Some(h.to_uppercase())
    } else if h.len() == 3 && h.chars().all(|x| x.is_ascii_hexdigit()) {
        Some(h.chars().map(|x| format!("{x}{x}")).collect::<String>().to_uppercase())
    } else {
        None
    }
}

/// shape xml: one text box at EMU coords with paragraphs
fn txbox(id: u32, name: &str, x: i64, y: i64, cx: i64, cy: i64, paras: &[String], size: u32, bold: bool, center: bool, color: &str) -> String {
    let mut body = String::new();
    for p in paras {
        let mut runs = String::new();
        for seg in p.split('\n') {
            runs.push_str(&format!(
                "<a:r><a:rPr lang=\"en-US\" sz=\"{size}\"{} dirty=\"0\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r>",
                if bold { " b=\"1\"" } else { "" },
                esc(seg)
            ));
        }
        body.push_str(&format!(
            "<a:p><a:pPr{}/><a:endParaRPr lang=\"en-US\"/>{}</a:p>",
            if center { " algn=\"ctr\"" } else { "" },
            runs
        ));
    }
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"square\" rtlCol=\"0\" anchor=\"mid\" anchorCtr=\"1\"/><a:lstStyle/>{body}</p:txBody></p:sp>",
        esc(name)
    )
}

fn bullets_xml(id: u32, name: &str, x: i64, y: i64, cx: i64, cy: i64, bullets: &[String], color: &str) -> String {
    let mut body = String::new();
    for b in bullets {
        body.push_str(&format!(
            "<a:p><a:pPr marL=\"342900\" indent=\"-342900\"><a:buChar char=\"&#8226;\"/></a:pPr>\
             <a:r><a:rPr lang=\"en-US\" sz=\"2000\" dirty=\"0\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>",
            esc(b)
        ));
    }
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>\
         <p:txBody><a:bodyPr wrap=\"square\" anchor=\"t\"/><a:lstStyle/>{body}</p:txBody></p:sp>",
        esc(name)
    )
}

/// one slide's xml — layout decides the shape set; bg hex → slide fill
fn slide_xml(s: &SlideOut, bg: &str, fg: &str, sub: &str, accent: &str, img_rid: Option<(&str, i64, i64)>) -> String {
    let w: i64 = 12192000;
    let h: i64 = 6858000;
    let mx: i64 = 731520; // 0.8" margin
    let cw = w - 2 * mx;
    let mut shapes = String::new();
    let mut id = 2u32;
    let mut next = || {
        id += 1;
        id
    };
    match s.layout.as_str() {
        "title" => {
            shapes.push_str(&txbox(next(), "laido:title:title", mx, h / 2 - 1200000, cw, 1400000, &[s.title.clone()], 4400, true, true, fg));
            if !s.sub.is_empty() {
                shapes.push_str(&txbox(next(), "laido:title:sub", mx, h / 2 + 300000, cw, 900000, &[s.sub.clone()], 2200, false, true, sub));
            }
        }
        "section" => {
            shapes.push_str(&txbox(next(), "laido:section:title", mx, h / 2 - 700000, cw, 1400000, &[s.title.clone()], 4000, true, true, accent));
        }
        "quote" => {
            shapes.push_str(&txbox(next(), "laido:quote:quote", mx + 500000, h / 2 - 900000, cw - 1000000, 1600000, &[format!("“{}”", s.quote)], 2800, false, true, fg));
            if !s.by.is_empty() {
                shapes.push_str(&txbox(next(), "laido:quote:by", mx, h / 2 + 800000, cw, 600000, &[format!("— {}", s.by)], 1800, false, true, sub));
            }
        }
        "bigfact" => {
            shapes.push_str(&txbox(next(), "laido:bigfact:title", mx, h / 2 - 1500000, cw, 2000000, &[s.title.clone()], 9600, true, true, accent));
            if !s.sub.is_empty() {
                shapes.push_str(&txbox(next(), "laido:bigfact:sub", mx, h / 2 + 700000, cw, 800000, &[s.sub.clone()], 2000, false, true, sub));
            }
        }
        "twocol" => {
            shapes.push_str(&txbox(next(), "laido:twocol:title", mx, 365760, cw, 900000, &[s.title.clone()], 3200, true, false, fg));
            let half = cw / 2 - 150000;
            shapes.push_str(&bullets_xml(next(), "laido:twocol:colA", mx, 1500000, half, h - 1900000, &s.cols.0, fg));
            shapes.push_str(&bullets_xml(next(), "laido:twocol:colB", mx + half + 300000, 1500000, half, h - 1900000, &s.cols.1, fg));
        }
        "image" => {
            if !s.title.is_empty() {
                shapes.push_str(&txbox(next(), "laido:image:title", mx, 274320, cw, 800000, &[s.title.clone()], 3200, true, false, fg));
            }
            if let Some((rid, px, py)) = img_rid {
                shapes.push_str(&format!(
                    "<p:pic><p:nvPicPr><p:cNvPr id=\"{}\" name=\"laido:image:pic\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>\
                     <p:blipFill><a:blip r:embed=\"{}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
                     <p:spPr><a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
                    next(), rid, mx + 800000, 1300000, px, py
                ));
            }
            if !s.sub.is_empty() {
                shapes.push_str(&txbox(next(), "laido:image:sub", mx, h - 800000, cw, 500000, &[s.sub.clone()], 1600, false, true, sub));
            }
        }
        "blank" => {
            shapes.push_str(&txbox(next(), "laido:blank:body", mx, 400000, cw, h - 800000, &[s.body.clone()], 2000, false, false, fg));
        }
        _ => {
            // bullets — the workhorse
            shapes.push_str(&txbox(next(), "laido:bullets:title", mx, 274320, cw, 900000, &[s.title.clone()], 3200, true, false, fg));
            if !s.bullets.is_empty() {
                shapes.push_str(&bullets_xml(next(), "laido:bullets:list", mx, 1400000, cw, h - 1800000, &s.bullets, fg));
            }
            if !s.body.is_empty() {
                shapes.push_str(&txbox(next(), "laido:bullets:body", mx, 1400000, cw, h - 1800000, &[s.body.clone()], 2000, false, false, fg));
            }
        }
    }
    let bgxml = match hex6(bg) {
        Some(c) => format!(
            "<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>"
        ),
        None => String::new(),
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld>{bgxml}<p:spTree>\
         <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\
         {shapes}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping/></p:clrMapOvr></p:sld>"
    )
}

fn notes_xml(note: &str, slide_rid: &str) -> (String, String) {
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:notes xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld><p:spTree>\
         <p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>\
         <p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Notes\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr><p:ph type=\"body\" idx=\"2\"/></p:nvPr></p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"1371600\" y=\"4400000\"/><a:ext cx=\"5486400\" cy=\"3600000\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>\
         <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"en-US\" sz=\"1200\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>\
         </p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping/></p:clrMapOvr></p:notes>",
        esc(note)
    );
    let rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster\" Target=\"../notesMasters/notesMaster1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"../slides/{slide_rid}\"/>\
         </Relationships>"
    );
    (xml, rels)
}

#[tauri::command]
pub fn deck_pptx_export(path: String, deck: DeckOut, theme: Option<serde_json::Value>) -> Result<String, String> {
    let p = resolve(&path)?;
    let p = if p.extension().is_some() { p } else { p.with_extension("pptx") };
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // theme colors → pptx defaults (per-slide bg overrides)
    let (mut bg, mut fg, mut sub, mut accent) = (
        "1C1A17".to_string(),
        "ECE7DD".to_string(),
        "9D968A".to_string(),
        "E0A458".to_string(),
    );
    if let Some(t) = theme {
        let pick = |k: &str, d: &str| -> String {
            t.get(k).and_then(|v| v.as_str()).and_then(hex6).unwrap_or_else(|| d.to_string())
        };
        bg = pick("bg", &bg);
        fg = pick("fg", &fg);
        sub = pick("sub", &sub);
        accent = pick("accent", &accent);
    }
    let file = fs::File::create(&p).map_err(|e| e.to_string())?;
    let mut z = zip::ZipWriter::new(file);
    let opt = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let put = |z: &mut zip::ZipWriter<fs::File>, name: &str, body: &str| -> Result<(), String> {
        z.start_file(name, opt).map_err(|e| e.to_string())?;
        z.write_all(body.as_bytes()).map_err(|e| e.to_string())
    };

    let n = deck.slides.len();
    // [Content_Types]
    let mut ct = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>",
    );
    // image media types actually used get Defaults below
    let mut media: Vec<(String, Vec<u8>)> = Vec::new(); // (name.ext, bytes)
    let mut used_ext: Vec<String> = Vec::new();
    for s in &deck.slides {
        if !s.img.is_empty() {
            let imgp = resolve(&s.img).unwrap_or_else(|_| Path::new(&s.img).to_path_buf());
            if let Ok(bytes) = fs::read(&imgp) {
                let ext = imgp
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("png")
                    .to_lowercase();
                let ext = if ext == "jpeg" { "jpg".into() } else { ext };
                media.push((format!("image{}.{}", media.len() + 1, ext), bytes));
                if !used_ext.contains(&ext) {
                    used_ext.push(ext);
                }
            }
        }
    }
    for e in &used_ext {
        let mime = match e.as_str() {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "webp" => "image/webp",
            _ => "application/octet-stream",
        };
        ct.push_str(&format!("<Default Extension=\"{e}\" ContentType=\"{mime}\"/>"));
    }
    ct.push_str(
        "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
         <Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
         <Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
         <Override PartName=\"/ppt/notesMasters/notesMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml\"/>\
         <Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
         <Override PartName=\"/ppt/theme/theme2.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
         <Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/>\
         <Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/>\
         <Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/>\
         <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
         <Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>",
    );
    for i in 1..=n {
        ct.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
        ));
        if !deck.slides[i - 1].note.is_empty() {
            ct.push_str(&format!(
                "<Override PartName=\"/ppt/notesSlides/notesSlide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml\"/>"
            ));
        }
    }
    ct.push_str("</Types>");
    put(&mut z, "[Content_Types].xml", &ct)?;

    put(&mut z, "_rels/.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
         <Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>\
         </Relationships>")?;

    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    put(&mut z, "docProps/core.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\
         <dc:title>{}</dc:title><dc:creator>Laido</dc:creator>\
         <dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created>\
         <dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified></cp:coreProperties>",
        esc(&deck.title)))?;
    put(&mut z, "docProps/app.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">\
         <Application>Laido</Application><Slides>{n}</Slides></Properties>"))?;

    // presentation + its rels
    let mut sld_ids = String::new();
    let mut pres_rels = String::new();
    for i in 1..=n {
        sld_ids.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 255 + i, 3 + i));
        pres_rels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{i}.xml\"/>",
            3 + i));
    }
    pres_rels.push_str(
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster\" Target=\"notesMasters/notesMaster1.xml\"/>\
         <Relationship Id=\"rId900\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>\
         <Relationship Id=\"rId901\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps\" Target=\"presProps.xml\"/>\
         <Relationship Id=\"rId902\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps\" Target=\"viewProps.xml\"/>\
         <Relationship Id=\"rId903\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles\" Target=\"tableStyles.xml\"/>");
    put(&mut z, "ppt/presentation.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
         <p:notesMasterIdLst><p:notesMasterId r:id=\"rId2\"/></p:notesMasterIdLst>\
         <p:sldIdLst>{sld_ids}</p:sldIdLst>\
         <p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"))?;
    put(&mut z, "ppt/_rels/presentation.xml.rels", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{pres_rels}</Relationships>"))?;

    put(&mut z, "ppt/presProps.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:presentationPr xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>")?;
    put(&mut z, "ppt/viewProps.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:viewPr xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:normalViewPr><p:restoredLeft sz=\"15620\"/><p:restoredTop sz=\"94660\"/></p:normalViewPr></p:viewPr>")?;
    put(&mut z, "ppt/tableStyles.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <a:tblStyleLst xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" def=\"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}\"/>")?;

    // theme (both theme1 and the notes theme2 share the palette)
    let theme = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"{}\">\
         <a:themeElements><a:clrScheme name=\"Laido\">\
         <a:dk1><a:srgbClr val=\"{fg}\"/></a:dk1><a:lt1><a:srgbClr val=\"{bg}\"/></a:lt1>\
         <a:dk2><a:srgbClr val=\"{sub}\"/></a:dk2><a:lt2><a:srgbClr val=\"{bg}\"/></a:lt2>\
         <a:accent1><a:srgbClr val=\"{accent}\"/></a:accent1><a:accent2><a:srgbClr val=\"{accent}\"/></a:accent2>\
         <a:accent3><a:srgbClr val=\"{sub}\"/></a:accent3><a:accent4><a:srgbClr val=\"{accent}\"/></a:accent4>\
         <a:accent5><a:srgbClr val=\"{fg}\"/></a:accent5><a:accent6><a:srgbClr val=\"{sub}\"/></a:accent6>\
         <a:hlink><a:srgbClr val=\"{accent}\"/></a:hlink><a:folHlink><a:srgbClr val=\"{sub}\"/></a:folHlink></a:clrScheme>\
         <a:fontScheme name=\"Laido\"><a:majorFont><a:latin typeface=\"Segoe UI\"/></a:majorFont><a:minorFont><a:latin typeface=\"Segoe UI\"/></a:minorFont></a:fontScheme>\
         <a:fmtScheme name=\"Laido\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst>\
         <a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst>\
         <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
         <a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>\
         </a:themeElements></a:theme>",
        esc(&deck.title));
    put(&mut z, "ppt/theme/theme1.xml", &theme)?;
    put(&mut z, "ppt/theme/theme2.xml", &theme)?;

    // minimal master + layout (blank layout — our slides carry their own shapes)
    put(&mut z, "ppt/slideMasters/slideMaster1.xml", &format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{bg}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>\
         <p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>\
         <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
         <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>"))?;
    put(&mut z, "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
         <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>\
         </Relationships>")?;
    put(&mut z, "ppt/slideLayouts/slideLayout1.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" type=\"blank\" preserve=\"1\">\
         <p:cSld name=\"Blank\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>\
         <p:clrMapOvr><a:overrideClrMapping/></p:clrMapOvr></p:sldLayout>")?;
    put(&mut z, "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>\
         </Relationships>")?;

    // notes master
    put(&mut z, "ppt/notesMasters/notesMaster1.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <p:notesMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
         <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>\
         <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/></p:notesMaster>")?;
    put(&mut z, "ppt/notesMasters/_rels/notesMaster1.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme2.xml\"/>\
         </Relationships>")?;

    // slides + optional notes + media
    let mut media_i = 0;
    for (i, s) in deck.slides.iter().enumerate() {
        let n = i + 1;
        let mut img_rid: Option<(&str, i64, i64)> = None;
        let mut srels_extra = String::new();
        if !s.img.is_empty() {
            media_i += 1;
            if let Some((name, _bytes)) = media.get(media_i - 1) {
                // only embed when the file actually loaded
                let imgp = resolve(&s.img).unwrap_or_else(|_| Path::new(&s.img).to_path_buf());
                if imgp.exists() {
                    img_rid = Some(("rId2", 9600000, 4200000));
                    srels_extra = format!(
                        "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"../media/{name}\"/>");
                }
            }
        }
        let slide_bg = if s.bg.is_empty() { bg.as_str() } else { s.bg.as_str() };
        put(&mut z, &format!("ppt/slides/slide{n}.xml"), &slide_xml(s, slide_bg, &fg, &sub, &accent, img_rid))?;
        let mut srels = format!(
            "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>");
        srels.push_str(&srels_extra);
        if !s.note.is_empty() {
            srels.push_str(&format!(
                "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide\" Target=\"../notesSlides/notesSlide{n}.xml\"/>"));
        }
        put(&mut z, &format!("ppt/slides/_rels/slide{n}.xml.rels"), &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{srels}</Relationships>"))?;
        if !s.note.is_empty() {
            let (nx, nrels) = notes_xml(&s.note, &format!("slide{n}.xml"));
            put(&mut z, &format!("ppt/notesSlides/notesSlide{n}.xml"), &nx)?;
            put(&mut z, &format!("ppt/notesSlides/_rels/notesSlide{n}.xml.rels"), &nrels)?;
        }
    }
    for (name, bytes) in &media {
        z.start_file(format!("ppt/media/{name}"), opt).map_err(|e| e.to_string())?;
        z.write_all(bytes).map_err(|e| e.to_string())?;
    }
    z.finish().map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// .pptx → deck JSON: slide order, placeholder-aware text, speaker notes
#[tauri::command]
pub fn deck_pptx_import(path: String) -> Result<DeckOut, String> {
    let p = resolve(&path)?;
    let file = fs::File::open(&p).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("can't read pptx: {e}"))?;
    let mut names: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        if let Ok(zf) = zip.by_index(i) {
            let n = zf.name().to_string();
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
    let read = |zip: &mut zip::ZipArchive<fs::File>, name: &str| -> Option<String> {
        let mut z = zip.by_name(name).ok()?;
        let mut buf = String::new();
        z.read_to_string(&mut buf).ok()?;
        Some(buf)
    };

    let mut slides: Vec<SlideOut> = Vec::new();
    for name in &names {
        let Some(xml) = read(&mut zip, name) else { continue };
        let idx: String = name
            .trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .to_string();
        let mut s = SlideOut {
            layout: "bullets".into(),
            title: String::new(),
            sub: String::new(),
            bullets: Vec::new(),
            cols: (vec![], vec![]),
            img: String::new(),
            quote: String::new(),
            by: String::new(),
            body: String::new(),
            note: String::new(),
            bg: String::new(),
        };
        // slide background
        if let Some(bgm) = xml.find("<p:bg>") {
            let tail = &xml[bgm..];
            if let Some(cl) = tail.find("<a:srgbClr val=\"") {
                let v = &tail[cl + 16..];
                if let Some(e) = v.find('"') {
                    s.bg = format!("#{}", &v[..e]);
                }
            }
        }
        // rels for this slide (pictures embed by rId → ../media/…)
        let rels_xml = read(&mut zip, &format!("ppt/slides/_rels/slide{idx}.xml.rels")).unwrap_or_default();
        let rid_target = |rid: &str| -> Option<String> {
            let m = format!("Id=\"{rid}\"");
            let i = rels_xml.find(&m)?;
            let t = rels_xml[i..].find("Target=\"")?;
            let v = &rels_xml[i + t + 8..];
            let e = v.find('"')?;
            Some(v[..e].replace("../", "ppt/"))
        };

        // split into <p:sp>…</p:sp> shape blocks; our own exports carry
        // name="laido:LAYOUT:ROLE" for a lossless round-trip, foreign files
        // fall back to <p:ph type> heuristics
        let mut rest = xml.as_str();
        let mut body_paras: Vec<String> = Vec::new();
        // pictures first — pull media bytes into data urls
        let mut prest = xml.as_str();
        while let Some(a) = prest.find("<p:pic>") {
            let Some(b) = prest[a..].find("</p:pic>") else { break };
            let pic = &prest[a..a + b];
            prest = &prest[a + b..];
            if let Some(rm) = pic.find("r:embed=\"") {
                let v = &pic[rm + 9..];
                if let Some(e) = v.find('"') {
                    if let Some(target) = rid_target(&v[..e]) {
                        if let Some(mut zf) = zip.by_name(&target).ok() {
                            let mut bytes = Vec::new();
                            if zf.read_to_end(&mut bytes).is_ok() {
                                let mime = match target.rsplit('.').next().unwrap_or("png") {
                                    "jpg" | "jpeg" => "image/jpeg",
                                    "gif" => "image/gif",
                                    "svg" => "image/svg+xml",
                                    "webp" => "image/webp",
                                    _ => "image/png",
                                };
                                s.img = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
                            }
                        }
                    }
                }
            }
        }
        while let Some(a) = rest.find("<p:sp>") {
            let Some(b) = rest[a..].find("</p:sp>") else { break };
            let sp = &rest[a..a + b];
            rest = &rest[a + b..];
            let spname = sp
                .find("<p:cNvPr")
                .and_then(|i| sp[i..].find("name=\"").map(|j| i + j + 6))
                .and_then(|i| sp[i..].find('"').map(|e| unesc(&sp[i..i + e])))
                .unwrap_or_default();
            let ph = sp
                .find("<p:ph ")
                .and_then(|i| sp[i..].find("type=\"").map(|j| &sp[i + j + 6..]))
                .and_then(|v| v.find('"').map(|e| v[..e].to_string()))
                .unwrap_or_default();
            // paragraphs in this shape
            let mut paras: Vec<String> = Vec::new();
            let mut r2 = sp;
            while let Some(pa) = r2.find("<a:p>") {
                let Some(pb) = r2[pa..].find("</a:p>") else { break };
                let para = &r2[pa..pa + pb];
                r2 = &r2[pa + pb..];
                let mut text = String::new();
                let mut r3 = para;
                while let Some(t) = r3.find("<a:t>") {
                    let Some(te) = r3[t..].find("</a:t>") else { break };
                    text.push_str(&r3[t + 5..t + te]);
                    r3 = &r3[t + te..];
                }
                let text = unesc(&text);
                if !text.trim().is_empty() {
                    paras.push(text.trim().to_string());
                }
            }
            // laido:LAYOUT:ROLE marker → exact round-trip
            if let Some(tag) = spname.strip_prefix("laido:") {
                let mut it = tag.split(':');
                let lay = it.next().unwrap_or("");
                let role = it.next().unwrap_or("");
                if s.layout == "bullets" {
                    s.layout = lay.to_string();
                }
                let flat = paras.join(" ");
                match role {
                    "title" => s.title = flat,
                    "sub" => s.sub = flat,
                    "quote" => s.quote = flat.trim_matches('“').trim_matches('”').to_string(),
                    "by" => s.by = flat.trim_start_matches('—').trim().to_string(),
                    "colA" => s.cols.0 = paras,
                    "colB" => s.cols.1 = paras,
                    "list" => s.bullets.extend(paras),
                    "body" => s.body = paras.join("\n"),
                    _ => body_paras.extend(paras),
                }
                continue;
            }
            match ph.as_str() {
                "title" | "ctrTitle" => {
                    if s.title.is_empty() {
                        s.title = paras.join(" ");
                        if ph == "ctrTitle" {
                            s.layout = "title".into();
                        }
                    } else {
                        body_paras.extend(paras);
                    }
                }
                "subTitle" => s.sub = paras.join(" "),
                _ => body_paras.extend(paras),
            }
        }
        if s.layout == "title" && s.sub.is_empty() && !body_paras.is_empty() {
            s.sub = body_paras.remove(0);
        }
        s.bullets.append(&mut body_paras);
        if s.layout != "title" && s.title.is_empty() && !s.bullets.is_empty() {
            s.title = s.bullets.remove(0);
        }
        if s.title.is_empty() && s.bullets.is_empty() {
            s.layout = "blank".into();
        } else if s.title.is_empty() {
            s.layout = "section".into();
        }
        // speaker notes
        let nname = format!("ppt/notesSlides/notesSlide{idx}.xml");
        if let Some(nxml) = read(&mut zip, &nname) {
            let mut nt = String::new();
            let mut r = nxml.as_str();
            while let Some(t) = r.find("<a:t>") {
                let Some(te) = r[t..].find("</a:t>") else { break };
                nt.push_str(&unesc(&r[t + 5..t + te]));
                nt.push(' ');
                r = &r[t + te..];
            }
            s.note = nt.trim().to_string();
        }
        slides.push(s);
    }
    if slides.is_empty() {
        return Err("no slides found in that file".into());
    }
    Ok(DeckOut {
        title: p.file_stem().and_then(|s| s.to_str()).unwrap_or("deck").to_string(),
        slides,
    })
}

fn unesc(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_round_trip() {
        let dir = std::env::temp_dir().join("laido-xfer-x");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.xlsx");
        let p = path.to_string_lossy().to_string();
        let cells = vec![
            vec!["Item".into(), "Qty".into(), "Cost".into()],
            vec!["Cement".into(), "2".into(), "=B2*10".into()],
            vec!["Sand & gravel".into(), "4".into(), "15.5".into()],
        ];
        sheet_xlsx_export(p.clone(), cells.clone()).unwrap();
        let back = sheet_xlsx_import(p.clone(), None).unwrap();
        assert_eq!(back[0], cells[0]);
        assert_eq!(back[1][0..2], cells[1][0..2]);
        assert_eq!(back[2][1], "4");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn pptx_round_trip() {
        let dir = std::env::temp_dir().join("laido-xfer-p");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.pptx");
        let p = path.to_string_lossy().to_string();
        let slides = vec![
            SlideOut {
                layout: "title".into(),
                title: "Q3 <Report> & plan".into(),
                sub: "FY26".into(),
                bullets: vec![],
                body: "".into(),
                img: "".into(),
                note: "open strong".into(),
                bg: "".into(),
                cols: (vec![], vec![]),
                quote: "".into(),
                by: "".into(),
            },
            SlideOut {
                layout: "bullets".into(),
                title: "Numbers".into(),
                sub: "".into(),
                bullets: vec!["sales <up> 20%".into(), "costs & flat".into()],
                body: "".into(),
                img: "".into(),
                note: "mention region split".into(),
                bg: "#20303A".into(),
                cols: (vec![], vec![]),
                quote: "".into(),
                by: "".into(),
            },
            SlideOut {
                layout: "twocol".into(),
                title: "Compare".into(),
                sub: "".into(),
                bullets: vec![],
                body: "".into(),
                img: "".into(),
                note: "".into(),
                bg: "".into(),
                cols: (vec!["left a".into(), "left b".into()], vec!["right 1".into()]),
                quote: "".into(),
                by: "".into(),
            },
            SlideOut {
                layout: "quote".into(),
                title: "".into(),
                sub: "".into(),
                bullets: vec![],
                body: "".into(),
                img: "".into(),
                note: "".into(),
                bg: "".into(),
                cols: (vec![], vec![]),
                quote: "Ship it".into(),
                by: "CEO".into(),
            },
        ];
        let theme = serde_json::json!({"bg":"#F4F1EA","fg":"#1C1A17","sub":"#7A7165","accent":"#B05C4A"});
        deck_pptx_export(p.clone(), DeckOut { title: "Q3".into(), slides }, Some(theme)).unwrap();
        let back = deck_pptx_import(p.clone()).unwrap();
        assert_eq!(back.slides.len(), 4);
        assert_eq!(back.slides[0].title, "Q3 <Report> & plan");
        assert_eq!(back.slides[0].sub, "FY26");
        assert_eq!(back.slides[0].note, "open strong");
        assert_eq!(back.slides[1].bullets, vec!["sales <up> 20%", "costs & flat"]);
        assert_eq!(back.slides[1].bg, "#20303A");
        assert_eq!(back.slides[2].cols.0, vec!["left a", "left b"]);
        assert_eq!(back.slides[2].cols.1, vec!["right 1"]);
        assert_eq!(back.slides[3].quote, "Ship it");
        fs::remove_file(&path).ok();
    }
}
