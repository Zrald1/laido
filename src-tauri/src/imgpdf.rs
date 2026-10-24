//! Image → PDF — one page per source image, page sized to the pixels.
//! Powers the Windows Explorer "Convert to PDF" verb, the --img2pdf CLI
//! path, and the in-app tools button.

use std::path::{Path, PathBuf};

/// extensions the context-menu verb registers for + the picker accepts
const IMG_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];

fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMG_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// JPEG sources embed verbatim (lossless, no re-encode); anything else is
/// decoded, flattened onto white (JPEG has no alpha), re-encoded q92 so a
/// 40 MP PNG doesn't make a 30 MB PDF.
fn to_jpeg(path: &Path) -> Result<(Vec<u8>, u32, u32), String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "jpg" || ext == "jpeg" {
        let (w, h) = image::image_dimensions(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok((bytes, w, h));
    }
    let img = image::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (w, h) = (img.width(), img.height());
    let mut bg = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
        w,
        h,
        image::Rgb([255, 255, 255]),
    ));
    image::imageops::overlay(&mut bg, &img, 0, 0);
    let rgb = bg.to_rgb8();
    let mut buf = Vec::new();
    image::ImageEncoder::write_image(
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92),
        rgb.as_raw(),
        w,
        h,
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((buf, w, h))
}

/// convert every path to a page in one PDF — saved next to the FIRST
/// source, `<name>.pdf`; colliding names get `name-2.pdf` etc.
pub fn convert(sources: &[PathBuf]) -> Result<PathBuf, String> {
    if sources.is_empty() {
        return Err("no files".into());
    }
    for s in sources {
        if !s.exists() {
            return Err(format!("{}: not found", s.display()));
        }
        if !is_image(s) {
            return Err(format!("{}: not an image", s.display()));
        }
    }
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for s in sources {
        let (jpeg, w, h) = to_jpeg(s)?;
        let img_id = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image",
                "Width" => w as i64, "Height" => h as i64,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            jpeg,
        ));
        // px → pt at 96dpi — the page IS the image, edge to edge
        let (pw, ph) = (w as f64 * 0.75, h as f64 * 0.75);
        let contents = doc.add_object(Stream::new(
            dictionary! {},
            format!("q {pw:.2} 0 0 {ph:.2} 0 0 cm /Im1 Do Q").into_bytes(),
        ));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), pw.into(), ph.into()],
            "Contents" => contents,
            "Resources" => dictionary! { "XObject" => dictionary! { "Im1" => img_id } },
        });
        kids.push(Object::Reference(page));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids.clone(), "Count" => kids.len() as i64,
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);

    let first = &sources[0];
    let stem = first
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into());
    let dir = first.parent().unwrap_or(Path::new("."));
    let mut out = dir.join(format!("{stem}.pdf"));
    for n in 2..1000 {
        if !out.exists() {
            break;
        }
        out = dir.join(format!("{stem}-{n}.pdf"));
    }
    doc.save(&out).map_err(|e| e.to_string())?;
    Ok(out)
}

/* ---------- tauri surface ---------- */

#[tauri::command]
pub fn img_to_pdf(paths: Vec<String>) -> Result<String, String> {
    let srcs: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    convert(&srcs).map(|p| p.display().to_string())
}

/* ---------- Windows Explorer verb ---------- */

const VERB: &str = "Convert to &PDF";

#[cfg(windows)]
fn reg(args: &[&str]) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
}

#[cfg(windows)]
pub fn menu_set(on: bool) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.display().to_string();
    for ext in IMG_EXTS {
        let key =
            format!("HKCU\\Software\\Classes\\SystemFileAssociations\\{ext}\\shell\\Laido.ImgToPdf");
        if on {
            let icon = format!("\"{exe}\",0");
            let cmd = format!("\"{exe}\" --img2pdf \"%1\"");
            reg(&["add", &key, "/ve", "/d", VERB, "/f"]);
            reg(&["add", &key, "/v", "Icon", "/d", &icon, "/f"]);
            reg(&["add", &format!("{key}\\command"), "/ve", "/d", &cmd, "/f"]);
        } else {
            reg(&["delete", &key, "/f"]);
        }
    }
}

/// called on startup + after every settings save — keeps the verb in step
/// with the toggle and self-heals if the user moved the exe
#[cfg(windows)]
pub fn menu_sync() {
    menu_set(crate::state::load_settings().imgpdf_menu);
}

#[cfg(not(windows))]
pub fn menu_sync() {}

/* ---------- `--img2pdf <files…>` headless path ---------- */

/// returns Some(exit_code) when the process should convert-and-quit
/// instead of opening the app
pub fn cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a.as_str()) != Some("--img2pdf") {
        return None;
    }
    let files: Vec<PathBuf> = args[2..].iter().map(PathBuf::from).collect();
    let (msg, ok) = match convert(&files) {
        Ok(p) => (format!("Saved {}", p.display()), true),
        Err(e) => (format!("Image → PDF failed:\n{e}"), false),
    };
    notice(&msg, ok);
    Some(if ok { 0 } else { 1 })
}

#[cfg(windows)]
fn notice(msg: &str, ok: bool) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::*;
    let (text, title) = (HSTRING::from(msg), HSTRING::from("Laido"));
    unsafe {
        let _ = MessageBoxW(
            None,
            windows::core::PCWSTR(text.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            MB_OK | if ok { MB_ICONINFORMATION } else { MB_ICONERROR },
        );
    }
}

#[cfg(not(windows))]
fn notice(msg: &str, _ok: bool) {
    eprintln!("{msg}");
}
