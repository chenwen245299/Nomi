//! Papers: a research-paper planning board. Each paper is a node with a status
//! (idea · planned · writing · done), a position on a relationship graph, and a
//! Markdown body (same editor + asset scheme as the notes module). The graph
//! structure — every paper's metadata plus the directed edges between them —
//! lives in one `graph.json`; each paper's long-form body lives in its own folder
//! so its inline images travel with it.
//!
//! Layout under the user's data folder — plain, portable, human-readable:
//!
//! ```text
//! papers/
//!   graph.json            { schemaVersion, papers: [ … ], edges: [ … ] }
//!   <id>/
//!     paper.md            the Markdown body
//!     assets/pic.png      inline images, referenced as assets/pic.png
//! ```
//!
//! All graph mutations serialize through [`PapersState`] so a background autosave
//! and a node drag can never clobber one another's read-modify-write.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};

use crate::storage;

const PAPERS_DIR: &str = "papers";
const GRAPH_FILE: &str = "graph.json";
const BODY_FILE: &str = "paper.md";
const ASSETS_DIR: &str = "assets";
const SCHEMA_VERSION: u32 = 1;

/// Serializes every read-modify-write of `graph.json`. Managed by Tauri.
#[derive(Default)]
pub struct PapersState(Mutex<()>);

// ── Shared types ────────────────────────────────────────────────────────────

/// A paper node: its metadata and position. The Markdown body is stored beside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// One of: `idea` · `planned` · `writing` · `done`.
    #[serde(default)]
    pub status: String,
    /// Target venue / journal (e.g. "NeurIPS 2026"). Optional.
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Importance, 1–5 stars. 0 means unrated — which is what every paper
    /// written before this field existed deserializes to.
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub created_at: u64,
    pub updated_at: u64,
}

/// A directed relationship between two papers (from → to), with an optional label.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub label: String,
    /// Optional manual docking sides. Missing values keep legacy edges automatic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_side: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PapersGraph {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub papers: Vec<Paper>,
    #[serde(default)]
    pub edges: Vec<PaperEdge>,
}

/// The editable fields of a paper, sent whole on create and on metadata save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub venue: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

/// A stored inline image (mirrors the notes module).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub rel_path: String,
    pub data_url: String,
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn papers_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(PAPERS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 papers 目录：{error}"))?;
    Ok(dir)
}

/// An id is a random, filesystem-safe token; a paper folder is named by it.
fn safe_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err("非法的标识符。".into())
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn paper_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(papers_root(app)?.join(safe_id(id)?))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut contents =
        serde_json::to_string_pretty(value).map_err(|error| format!("无法序列化数据：{error}"))?;
    contents.push('\n');
    // Write-then-rename so a crash (or a concurrent read) never sees a torn file.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    fs::rename(&temp, path).map_err(|error| format!("无法写入 {}：{error}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

// ── Graph load / save ───────────────────────────────────────────────────────

fn load_graph(app: &AppHandle) -> Result<PapersGraph, String> {
    let path = papers_root(app)?.join(GRAPH_FILE);
    if !path.exists() {
        return Ok(PapersGraph {
            schema_version: SCHEMA_VERSION,
            papers: Vec::new(),
            edges: Vec::new(),
        });
    }
    let mut graph: PapersGraph =
        read_json(&path).map_err(|error| format!("论文数据无法解析：{error}"))?;
    graph.schema_version = SCHEMA_VERSION;
    Ok(graph)
}

fn save_graph(app: &AppHandle, graph: &PapersGraph) -> Result<(), String> {
    write_json(&papers_root(app)?.join(GRAPH_FILE), graph)
}

fn clean_status(status: &str) -> String {
    match status {
        "idea" | "planned" | "writing" | "done" | "published" => status.to_string(),
        _ => "idea".to_string(),
    }
}

fn clean_title(title: &str) -> String {
    let trimmed = title.trim();
    let limited: String = trimmed.chars().take(160).collect();
    if limited.trim().is_empty() {
        "未命名论文".to_string()
    } else {
        limited
    }
}

/// Ratings arrive from the front end, so clamp rather than trust: anything above
/// five collapses to five, and 0 stays 0 (unrated).
fn clean_rating(rating: u8) -> u8 {
    rating.min(5)
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed: String = tag.trim().chars().take(40).collect();
        if !trimmed.is_empty() && !out.iter().any(|t| t == &trimmed) {
            out.push(trimmed);
        }
        if out.len() >= 12 {
            break;
        }
    }
    out
}

// ── Papers ──────────────────────────────────────────────────────────────────

fn create_paper(app: &AppHandle, input: PaperInput) -> Result<Paper, String> {
    let id = new_id();
    let dir = papers_root(app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建论文：{error}"))?;
    fs::write(dir.join(BODY_FILE), "").map_err(|error| format!("无法创建论文正文：{error}"))?;

    let ts = now();
    let paper = Paper {
        id: id.clone(),
        title: clean_title(&input.title),
        status: clean_status(&input.status),
        venue: input.venue.trim().to_string(),
        tags: clean_tags(&input.tags),
        rating: clean_rating(input.rating),
        x: input.x,
        y: input.y,
        created_at: ts,
        updated_at: ts,
    };

    let mut graph = load_graph(app)?;
    graph.papers.push(paper.clone());
    save_graph(app, &graph)?;
    Ok(paper)
}

fn update_paper(app: &AppHandle, id: &str, input: PaperInput) -> Result<Paper, String> {
    let mut graph = load_graph(app)?;
    let paper = graph
        .papers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "论文不存在。".to_string())?;
    paper.title = clean_title(&input.title);
    paper.status = clean_status(&input.status);
    paper.venue = input.venue.trim().to_string();
    paper.tags = clean_tags(&input.tags);
    paper.rating = clean_rating(input.rating);
    paper.updated_at = now();
    let result = paper.clone();
    save_graph(app, &graph)?;
    Ok(result)
}

/// Persist a node's dragged position without touching `updated_at` (a drag is not
/// a content edit, so it should not reorder the list).
fn move_paper(app: &AppHandle, id: &str, x: f64, y: f64) -> Result<(), String> {
    let mut graph = load_graph(app)?;
    let paper = graph
        .papers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| "论文不存在。".to_string())?;
    paper.x = x;
    paper.y = y;
    save_graph(app, &graph)
}

fn delete_paper(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut graph = load_graph(app)?;
    graph.papers.retain(|p| p.id != id);
    graph.edges.retain(|e| e.from != id && e.to != id);
    save_graph(app, &graph)?;
    // Remove the body folder last; a stray folder is harmless, a stray graph entry is not.
    let dir = paper_dir(app, id)?;
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

fn read_body(app: &AppHandle, id: &str) -> Result<String, String> {
    let file = paper_dir(app, id)?.join(BODY_FILE);
    if !file.is_file() {
        return Ok(String::new());
    }
    fs::read_to_string(&file).map_err(|error| format!("无法读取论文正文：{error}"))
}

fn save_body(app: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let dir = paper_dir(app, id)?;
    if !dir.is_dir() {
        return Err("论文不存在。".into());
    }
    fs::write(dir.join(BODY_FILE), content)
        .map_err(|error| format!("无法保存论文正文：{error}"))?;
    // Touch updated_at so the paper bubbles up in its status group.
    let mut graph = load_graph(app)?;
    if let Some(paper) = graph.papers.iter_mut().find(|p| p.id == id) {
        paper.updated_at = now();
        save_graph(app, &graph)?;
    }
    Ok(())
}

// ── Edges ───────────────────────────────────────────────────────────────────

fn clean_label(label: &str) -> String {
    label.trim().chars().take(40).collect()
}

fn clean_edge_side(side: Option<&str>) -> Option<String> {
    side.filter(|value| matches!(*value, "top" | "right" | "bottom" | "left"))
        .map(str::to_string)
}

fn add_edge(
    app: &AppHandle,
    from: &str,
    to: &str,
    label: &str,
    from_side: Option<&str>,
    to_side: Option<&str>,
) -> Result<PaperEdge, String> {
    if from == to {
        return Err("不能连接到论文自身。".into());
    }
    let mut graph = load_graph(app)?;
    let has = |id: &str| graph.papers.iter().any(|p| p.id == id);
    if !has(from) || !has(to) {
        return Err("论文不存在。".into());
    }
    // Collapse a duplicate in either direction onto the existing edge.
    if let Some(existing) = graph
        .edges
        .iter()
        .find(|e| (e.from == from && e.to == to) || (e.from == to && e.to == from))
    {
        return Ok(existing.clone());
    }
    let edge = PaperEdge {
        id: new_id(),
        from: from.to_string(),
        to: to.to_string(),
        label: clean_label(label),
        from_side: clean_edge_side(from_side),
        to_side: clean_edge_side(to_side),
    };
    graph.edges.push(edge.clone());
    save_graph(app, &graph)?;
    Ok(edge)
}

fn update_edge(app: &AppHandle, id: &str, label: &str) -> Result<(), String> {
    let mut graph = load_graph(app)?;
    let edge = graph
        .edges
        .iter_mut()
        .find(|e| e.id == id)
        .ok_or_else(|| "关系不存在。".to_string())?;
    edge.label = clean_label(label);
    save_graph(app, &graph)
}

fn delete_edge(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut graph = load_graph(app)?;
    graph.edges.retain(|e| e.id != id);
    save_graph(app, &graph)
}

// ── Inline images (per-paper assets/, mirrors the notes module) ─────────────

fn sanitize_asset(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c.is_whitespace() || "/\\:*?\"<>|()[]{}#?%&+".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').trim();
    let limited: String = trimmed.chars().take(80).collect();
    if limited.trim().is_empty() {
        "image".to_string()
    } else {
        limited
    }
}

fn unique_name(dir: &Path, base: &str) -> String {
    if !dir.join(base).exists() {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem}-{n}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

fn mime_for(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn save_image(
    app: &AppHandle,
    id: &str,
    name: &str,
    data_base64: &str,
) -> Result<SavedImage, String> {
    let dir = paper_dir(app, id)?;
    if !dir.is_dir() {
        return Err("论文不存在。".into());
    }
    let assets = dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets).map_err(|error| format!("无法创建 assets 目录：{error}"))?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("图片数据无法解码：{error}"))?;

    let cleaned = sanitize_asset(name);
    let base = if Path::new(&cleaned).extension().is_some() {
        cleaned
    } else {
        format!("{cleaned}.png")
    };
    let file = unique_name(&assets, &base);
    fs::write(assets.join(&file), &bytes).map_err(|error| format!("无法保存图片：{error}"))?;

    let ext = Path::new(&file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let data_url = format!(
        "data:{};base64,{}",
        mime_for(ext),
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    Ok(SavedImage {
        rel_path: format!("{ASSETS_DIR}/{file}"),
        data_url,
    })
}

/// Resolve a paper-relative asset path, rejecting anything that would escape the
/// paper's own folder.
fn resolve_under(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = base.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            _ => return Err("非法的路径。".into()),
        }
    }
    Ok(path)
}

fn read_assets(app: &AppHandle, id: &str, rel_paths: &[String]) -> Result<Vec<String>, String> {
    let dir = paper_dir(app, id)?;
    let mut out = Vec::with_capacity(rel_paths.len());
    for rel in rel_paths {
        let resolved = match resolve_under(&dir, rel) {
            Ok(path) => path,
            Err(_) => {
                out.push(String::new());
                continue;
            }
        };
        match fs::read(&resolved) {
            Ok(bytes) => {
                let ext = resolved
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("png");
                out.push(format!(
                    "data:{};base64,{}",
                    mime_for(ext),
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                ));
            }
            Err(_) => out.push(String::new()),
        }
    }
    Ok(out)
}

/// Absolute path of a paper folder (or the papers root when `id` is empty), for
/// "reveal in Finder".
fn reveal_path(app: &AppHandle, id: Option<&str>) -> Result<String, String> {
    let target = match id {
        Some(id) if !id.is_empty() => paper_dir(app, id)?,
        _ => papers_root(app)?,
    };
    if !target.exists() {
        return Err("路径不存在。".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn papers_load_graph(app: AppHandle) -> Result<PapersGraph, String> {
    load_graph(&app)
}

#[tauri::command]
pub fn papers_create_paper(
    app: AppHandle,
    state: State<'_, PapersState>,
    input: PaperInput,
) -> Result<Paper, String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    create_paper(&app, input)
}

#[tauri::command]
pub fn papers_update_paper(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
    input: PaperInput,
) -> Result<Paper, String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    update_paper(&app, &id, input)
}

#[tauri::command]
pub fn papers_move_paper(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    move_paper(&app, &id, x, y)
}

#[tauri::command]
pub fn papers_delete_paper(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    delete_paper(&app, &id)
}

#[tauri::command]
pub fn papers_read_body(app: AppHandle, id: String) -> Result<String, String> {
    read_body(&app, &id)
}

#[tauri::command]
pub fn papers_save_body(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
    content: String,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    save_body(&app, &id, &content)
}

#[tauri::command]
pub fn papers_add_edge(
    app: AppHandle,
    state: State<'_, PapersState>,
    from: String,
    to: String,
    label: String,
    from_side: Option<String>,
    to_side: Option<String>,
) -> Result<PaperEdge, String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    add_edge(
        &app,
        &from,
        &to,
        &label,
        from_side.as_deref(),
        to_side.as_deref(),
    )
}

#[tauri::command]
pub fn papers_update_edge(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
    label: String,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    update_edge(&app, &id, &label)
}

#[tauri::command]
pub fn papers_delete_edge(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
) -> Result<(), String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    delete_edge(&app, &id)
}

#[tauri::command]
pub fn papers_save_image(
    app: AppHandle,
    state: State<'_, PapersState>,
    id: String,
    name: String,
    data_base64: String,
) -> Result<SavedImage, String> {
    let _guard = state.0.lock().map_err(|_| "论文数据被占用。".to_string())?;
    save_image(&app, &id, &name, &data_base64)
}

#[tauri::command]
pub fn papers_read_assets(
    app: AppHandle,
    id: String,
    rel_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    read_assets(&app, &id, &rel_paths)
}

#[tauri::command]
pub fn papers_reveal(app: AppHandle, id: Option<String>) -> Result<String, String> {
    reveal_path(&app, id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_ids() {
        assert!(safe_id("abc123").is_ok());
        assert!(safe_id("../etc").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
    }

    #[test]
    fn normalizes_status() {
        assert_eq!(clean_status("writing"), "writing");
        assert_eq!(clean_status("nonsense"), "idea");
    }

    #[test]
    fn dedupes_and_caps_tags() {
        let tags = clean_tags(&["  a ".into(), "a".into(), "".into(), "b".into()]);
        assert_eq!(tags, vec!["a".to_string(), "b".to_string()]);
    }
}
