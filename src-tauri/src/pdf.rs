//! Embedded PDF handling for the chat's local PDF tools.
//!
//! Text extraction is pure Rust (lopdf → pdf-extract fallback) so it needs
//! nothing installed. Page rendering uses PDFium, bound at runtime to a dynamic
//! library that ships inside the app (fetched at build time by
//! `scripts/fetch-pdfium.mjs`), so the user installs no poppler / tooling.

use std::path::{Path, PathBuf};

use pdfium_render::prelude::*;

/// Default rasterisation resolution. 150 DPI renders figures, tables and result
/// curves legibly while keeping a page PNG to a few hundred kilobytes.
pub const DEFAULT_DPI: u32 = 150;

// ── Text extraction (pure Rust) ────────────────────────────────────────────────

/// Extract the full text of a PDF. Best-effort: returns an empty string for a
/// scanned/image-only PDF rather than erroring.
pub fn extract_fulltext(pdf_path: &Path) -> String {
    // Stage 1: lopdf (fast, handles most digital PDFs).
    if let Ok(text) = extract_with_lopdf(pdf_path)
        && text.trim().chars().count() > 20
    {
        return text;
    }
    // Stage 2: pdf-extract (pure Rust) fallback.
    pdf_extract::extract_text(pdf_path).unwrap_or_default()
}

fn extract_with_lopdf(pdf_path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(pdf_path).map_err(|e| format!("读取 PDF 失败：{e}"))?;
    let doc = lopdf::Document::load_mem(&bytes).map_err(|e| format!("解析 PDF 失败：{e}"))?;
    let pages = doc.get_pages();
    let page_nums: Vec<u32> = pages.keys().copied().collect();
    Ok(doc.extract_text(&page_nums).unwrap_or_default())
}

/// Number of pages, via lopdf (no need to bind PDFium just to count).
pub fn page_count(pdf_path: &Path) -> usize {
    std::fs::read(pdf_path)
        .ok()
        .and_then(|bytes| lopdf::Document::load_mem(&bytes).ok())
        .map(|doc| doc.get_pages().len())
        .unwrap_or(0)
}

// ── Page rendering (bundled PDFium) ────────────────────────────────────────────

/// Candidate locations for the bundled PDFium dynamic library, most specific
/// first. Resolved from the running executable so it works from the packaged app
/// too, with a dev copy under `src-tauri/lib` as the last resort.
fn pdfium_lib_candidates() -> Vec<PathBuf> {
    let name = Pdfium::pdfium_platform_library_name();
    let mut cands = Vec::new();
    if let Ok(explicit) = std::env::var("NOMI_PDFIUM_LIB")
        && !explicit.is_empty()
    {
        cands.push(PathBuf::from(explicit));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        // Windows / Linux: Tauri drops bundled resources beside the exe.
        cands.push(dir.join(&name));
        cands.push(dir.join("lib").join(&name));
        // macOS .app: exe is in Contents/MacOS, resources in Resources.
        cands.push(dir.join("../Resources").join(&name));
        cands.push(dir.join("../Resources/lib").join(&name));
    }
    // Dev builds run from target/…; the fetch script drops the lib here.
    cands.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("lib")
            .join(&name),
    );
    cands
}

fn bind_pdfium() -> Result<Pdfium, String> {
    for cand in pdfium_lib_candidates() {
        if cand.is_file()
            && let Ok(bindings) = Pdfium::bind_to_library(&cand)
        {
            return Ok(Pdfium::new(bindings));
        }
    }
    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|e| format!("找不到内置的 PDFium 渲染库（也未在系统中安装）：{e}"))
}

/// Render one **1-based** page of `pdf_path` to PNG bytes at `dpi`.
pub fn render_page_png(pdf_path: &Path, page: u32, dpi: u32) -> Result<Vec<u8>, String> {
    if page == 0 {
        return Err("页码从 1 开始。".to_string());
    }
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("无法打开 PDF：{e}"))?;
    let page_obj = doc
        .pages()
        .get((page - 1) as u16)
        .map_err(|e| format!("这份 PDF 没有第 {page} 页：{e}"))?;

    // PDF user space is 72 DPI; scale up to the requested resolution.
    let config = PdfRenderConfig::new().scale_page_by_factor(dpi as f32 / 72.0);
    let bitmap = page_obj
        .render_with_config(&config)
        .map_err(|e| format!("PDFium 渲染第 {page} 页失败：{e}"))?;

    let mut buf = std::io::Cursor::new(Vec::new());
    bitmap
        .as_image()
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("第 {page} 页编码 PNG 失败：{e}"))?;
    let bytes = buf.into_inner();
    if bytes.is_empty() {
        return Err(format!("PDFium 渲染第 {page} 页得到空图。"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    /// The bundled PDFium library (src-tauri/lib, dropped by fetch-pdfium.mjs)
    /// must actually load at runtime — catching a wrong platform lib name or a
    /// broken download before it becomes a silent render failure.
    #[test]
    fn pdfium_library_binds() {
        super::bind_pdfium().expect("PDFium should bind to the bundled library");
    }
}
