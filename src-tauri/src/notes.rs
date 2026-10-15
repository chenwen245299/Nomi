use base64::Engine;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, ipc::Response};

use crate::storage;

const NOTES_DIR: &str = "notes";
const NOTE_EXT: &str = "md";
/// Per-folder image bucket. Reserved: never shown in the tree, never a note/folder
/// name. Images for a note live in `<the note's folder>/assets/…`.
const ASSETS_DIR: &str = "assets";

// Data layout under the user's data folder — plain, portable, human-readable:
//   notes/
//     方案.md                      (a note at the root)
//     assets/pic.png               (images for root-level notes)
//     工作/                        (a folder)
//       周报.md
//       assets/chart.png           (images for notes in 工作/)
//       归档/…                     (nested folders are supported)
//
// A "note" is a Markdown file; a "folder" is any directory except `assets`.
// Notes reference their images with portable relative paths (`assets/pic.png`),
// so a folder can be copied elsewhere and still render.

/// One entry in the notes tree returned to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    /// "folder" | "note".
    kind: String,
    /// Display name: the folder name, or the note's filename without `.md`.
    name: String,
    /// Path relative to the notes root, `/`-separated (e.g. `工作/周报.md`).
    path: String,
    created_at: u64,
    updated_at: u64,
    /// Present (possibly empty) for folders; absent for notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<NoteNode>>,
}

/// A newly stored image, reported back so the UI can both persist the portable
/// relative path and show the picture immediately.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    /// Path relative to the note (what gets written into the Markdown), e.g.
    /// `assets/pic.png`.
    rel_path: String,
    /// `data:<mime>;base64,…` for immediate in-editor display.
    data_url: String,
}

fn notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(NOTES_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 notes 目录：{error}"))?;
    Ok(dir)
}

/// Resolve a UI-supplied relative path (empty = the notes root) to an absolute
/// path under the notes root, rejecting anything that is not a plain chain of
/// path components (no `..`, absolute segments or drive prefixes).
fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            _ => return Err("非法的路径。".into()),
        }
    }
    Ok(path)
}

/// Turn a display name into a filesystem-safe single segment. Keeps CJK and most
/// characters; replaces only path-unsafe / reserved ones. Mirrors chat's rule.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(80).collect();
    let out = limited.trim().to_string();
    if out.is_empty() {
        "未命名".to_string()
    } else {
        out
    }
}

/// A child name (for `base` = "周报.md" or "工作") guaranteed not to collide in
/// `parent`. Keeps any extension when disambiguating (周报-2.md, not 周报.md-2).
fn unique_name(parent: &Path, base: &str) -> String {
    if !parent.join(base).exists() {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (base.to_string(), String::new()),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem}-{n}{ext}");
        if !parent.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Filesystem- AND URL-safe name for a stored image. On top of `sanitize` it also
/// removes characters that would break a Markdown `![](url)` link — spaces (which
/// end a URL) and `()[]` etc. Keeps CJK, alphanumerics, `.`, `-`, `_`.
fn asset_file_name(name: &str) -> String {
    let base = sanitize(name);
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_whitespace() || "()[]{}<>#?%&+ ".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = safe.trim_matches('-').trim();
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn file_times(path: &Path) -> (u64, u64) {
    let to_secs = |time: SystemTime| {
        time.duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    match fs::metadata(path) {
        Ok(meta) => {
            let modified = meta.modified().map(to_secs).unwrap_or(0);
            let created = meta.created().map(to_secs).unwrap_or(modified);
            (created, modified)
        }
        Err(_) => (0, 0),
    }
}

/// Read one directory into tree nodes (folders first, then notes; each group
/// sorted case-insensitively). `rel` is the directory's path relative to root.
fn read_tree(dir: &Path, rel: &str) -> Vec<NoteNode> {
    let mut folders: Vec<NoteNode> = Vec::new();
    let mut notes: Vec<NoteNode> = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let (created_at, updated_at) = file_times(&path);

        if path.is_dir() {
            if name.eq_ignore_ascii_case(ASSETS_DIR) {
                continue;
            }
            let child_rel = join_rel(rel, &name);
            folders.push(NoteNode {
                kind: "folder".into(),
                name,
                path: child_rel.clone(),
                created_at,
                updated_at,
                children: Some(read_tree(&path, &child_rel)),
            });
        } else if path.extension().and_then(|e| e.to_str()) == Some(NOTE_EXT) {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.clone());
            notes.push(NoteNode {
                kind: "note".into(),
                name: stem,
                path: join_rel(rel, &name),
                created_at,
                updated_at,
                children: None,
            });
        }
    }

    folders.sort_by_key(|node| node.name.to_lowercase());
    notes.sort_by_key(|node| node.name.to_lowercase());
    folders.extend(notes);
    folders
}

fn node_for(root: &Path, rel: &str, kind: &str) -> Result<NoteNode, String> {
    let path = resolve(root, rel)?;
    let (created_at, updated_at) = file_times(&path);
    let name = if kind == "note" {
        path.file_stem().map(|s| s.to_string_lossy().into_owned())
    } else {
        path.file_name().map(|s| s.to_string_lossy().into_owned())
    }
    .ok_or_else(|| "无法解析名称。".to_string())?;
    Ok(NoteNode {
        kind: kind.into(),
        name,
        path: rel.to_string(),
        created_at,
        updated_at,
        children: if kind == "folder" {
            Some(read_tree(&path, rel))
        } else {
            None
        },
    })
}

fn require_dir(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let dir = resolve(root, rel)?;
    if rel.is_empty() {
        return Ok(dir);
    }
    if !dir.is_dir() {
        return Err("目标文件夹不存在。".into());
    }
    Ok(dir)
}

fn check_folder_name(name: &str) -> Result<String, String> {
    let clean = sanitize(name);
    // Case-insensitive: on macOS/Windows "Assets" maps to the same on-disk dir as
    // the reserved per-folder image bucket.
    if clean.eq_ignore_ascii_case(ASSETS_DIR) {
        return Err("assets 是保留名称，请换一个文件夹名。".into());
    }
    Ok(clean)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn notes_tree(app: AppHandle) -> Result<Vec<NoteNode>, String> {
    let root = notes_root(&app)?;
    Ok(read_tree(&root, ""))
}

#[tauri::command]
pub fn create_note(app: AppHandle, parent: String, name: String) -> Result<NoteNode, String> {
    let root = notes_root(&app)?;
    let dir = require_dir(&root, &parent)?;
    let base = format!("{}.{}", sanitize(&name), NOTE_EXT);
    let file = unique_name(&dir, &base);
    fs::write(dir.join(&file), "").map_err(|error| format!("无法创建笔记：{error}"))?;
    node_for(&root, &join_rel(&parent, &file), "note")
}

#[tauri::command]
pub fn create_folder(app: AppHandle, parent: String, name: String) -> Result<NoteNode, String> {
    let root = notes_root(&app)?;
    let dir = require_dir(&root, &parent)?;
    let base = check_folder_name(&name)?;
    let folder = unique_name(&dir, &base);
    fs::create_dir_all(dir.join(&folder)).map_err(|error| format!("无法创建文件夹：{error}"))?;
    node_for(&root, &join_rel(&parent, &folder), "folder")
}

#[tauri::command]
pub fn read_note(app: AppHandle, path: String) -> Result<String, String> {
    let root = notes_root(&app)?;
    let file = resolve(&root, &path)?;
    if !file.is_file() {
        return Err("笔记不存在。".into());
    }
    fs::read_to_string(&file).map_err(|error| format!("无法读取笔记：{error}"))
}

#[tauri::command]
pub fn save_note(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let root = notes_root(&app)?;
    let file = resolve(&root, &path)?;
    if file.extension().and_then(|e| e.to_str()) != Some(NOTE_EXT) {
        return Err("非法的笔记路径。".into());
    }
    // Only ever overwrite an existing note. A note is created empty first, so this
    // always holds in normal use — and it stops a late autosave (e.g. flushed while
    // unmounting) from resurrecting a note the user just deleted or moved.
    if !file.is_file() {
        return Err("笔记不存在。".into());
    }
    fs::write(&file, content).map_err(|error| format!("无法保存笔记：{error}"))
}

#[tauri::command]
pub fn rename_note(app: AppHandle, path: String, name: String) -> Result<NoteNode, String> {
    let root = notes_root(&app)?;
    let file = resolve(&root, &path)?;
    if !file.is_file() {
        return Err("笔记不存在。".into());
    }
    let parent = file
        .parent()
        .ok_or_else(|| "无法定位笔记目录。".to_string())?;
    let base = format!("{}.{}", sanitize(&name), NOTE_EXT);
    let target = unique_name(parent, &base);
    fs::rename(&file, parent.join(&target)).map_err(|error| format!("无法重命名笔记：{error}"))?;
    let parent_rel = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    node_for(&root, &join_rel(parent_rel, &target), "note")
}

#[tauri::command]
pub fn rename_folder(app: AppHandle, path: String, name: String) -> Result<NoteNode, String> {
    let root = notes_root(&app)?;
    let dir = resolve(&root, &path)?;
    if !dir.is_dir() {
        return Err("文件夹不存在。".into());
    }
    let parent = dir
        .parent()
        .ok_or_else(|| "无法定位上级目录。".to_string())?;
    let base = check_folder_name(&name)?;
    let target = unique_name(parent, &base);
    fs::rename(&dir, parent.join(&target)).map_err(|error| format!("无法重命名文件夹：{error}"))?;
    let parent_rel = path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    node_for(&root, &join_rel(parent_rel, &target), "folder")
}

#[tauri::command]
pub fn delete_note(app: AppHandle, path: String) -> Result<(), String> {
    let root = notes_root(&app)?;
    let file = resolve(&root, &path)?;
    if !file.is_file() {
        return Err("笔记不存在。".into());
    }
    fs::remove_file(&file).map_err(|error| format!("无法删除笔记：{error}"))
}

#[tauri::command]
pub fn delete_folder(app: AppHandle, path: String) -> Result<(), String> {
    let root = notes_root(&app)?;
    if path.is_empty() {
        return Err("无法删除根目录。".into());
    }
    let dir = resolve(&root, &path)?;
    if !dir.is_dir() {
        return Err("文件夹不存在。".into());
    }
    fs::remove_dir_all(&dir).map_err(|error| format!("无法删除文件夹：{error}"))
}

/// Move a note or folder into `new_parent` (empty = root). Rejects moving a
/// folder into itself or one of its descendants.
#[tauri::command]
pub fn move_node(app: AppHandle, path: String, new_parent: String) -> Result<NoteNode, String> {
    let root = notes_root(&app)?;
    move_node_under(&root, &path, &new_parent)
}

fn move_node_under(root: &Path, path: &str, new_parent: &str) -> Result<NoteNode, String> {
    let source = resolve(root, path)?;
    if source == root || !source.exists() {
        return Err("要移动的项目不存在。".into());
    }
    let is_dir = source.is_dir();
    let dest_dir = require_dir(root, new_parent)?;

    if is_dir && dest_dir.starts_with(&source) {
        return Err("无法把文件夹移动到它自身或子目录中。".into());
    }
    let file_name = source
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| "无法解析名称。".to_string())?;
    // Re-dropping an item into its current parent is a no-op — don't let unique_name
    // collide the item with itself and append a spurious "-2".
    if source.parent() == Some(dest_dir.as_path()) {
        return node_for(
            root,
            &join_rel(new_parent, &file_name),
            if is_dir { "folder" } else { "note" },
        );
    }
    let target = unique_name(&dest_dir, &file_name);
    let destination = dest_dir.join(&target);
    if is_dir {
        fs::rename(&source, &destination).map_err(|error| format!("无法移动：{error}"))?;
    } else {
        move_note_file(&source, &destination)?;
    }
    node_for(
        root,
        &join_rel(new_parent, &target),
        if is_dir { "folder" } else { "note" },
    )
}

/// Match the inline images supported by the editor's asset bridge. Preserve alt
/// text, angle brackets, whitespace and titles while replacing only image URLs.
fn map_image_urls(
    markdown: &str,
    mut map: impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let mut output = String::with_capacity(markdown.len());
    let mut remaining = markdown;
    while let Some(start) = remaining.find("![") {
        output.push_str(&remaining[..start + 2]);
        remaining = &remaining[start + 2..];
        let Some(alt_end) = remaining.find(']') else {
            break;
        };
        if !remaining[alt_end..].starts_with("](") {
            continue;
        }
        let inner_start = alt_end + 2;
        let Some(end) = remaining[inner_start..].find(')') else {
            break;
        };
        let inner = &remaining[inner_start..inner_start + end];
        let trimmed = inner.trim_start();
        let leading = inner.len() - trimmed.len();
        let (url_start, url_end) = if let Some(angled) = trimmed.strip_prefix('<') {
            let Some(end) = angled.find('>') else {
                output.push_str(&remaining[..inner_start + end + 1]);
                remaining = &remaining[inner_start + end + 1..];
                continue;
            };
            (leading + 1, leading + 1 + end)
        } else {
            (
                leading,
                leading + trimmed.find(char::is_whitespace).unwrap_or(trimmed.len()),
            )
        };
        output.push_str(&remaining[..inner_start + url_start]);
        output.push_str(&map(&inner[url_start..url_end])?);
        output.push_str(&remaining[inner_start + url_end..inner_start + end + 1]);
        remaining = &remaining[inner_start + end + 1..];
    }
    output.push_str(remaining);
    Ok(output)
}

/// Images are shared by sibling notes. Copy the moved note's images, leaving
/// originals for the remaining notes, and disambiguate names at the destination.
/// A failed copy/write leaves the original note intact and removes partial files.
fn move_note_file(source: &Path, destination: &Path) -> Result<(), String> {
    let original = fs::read_to_string(source).map_err(|error| format!("无法读取笔记：{error}"))?;
    let source_dir = source.parent().ok_or("无法解析笔记目录。")?;
    let assets = destination
        .parent()
        .ok_or("无法解析目标目录。")?
        .join(ASSETS_DIR);
    let mut copied = Vec::new();
    let mut mapped = HashMap::<String, String>::new();
    let mut created_note = false;
    let result = (|| {
        let updated = map_image_urls(&original, |url| {
            if let Some(saved) = mapped.get(url) {
                return Ok(saved.clone());
            }
            if url.is_empty() || url.contains(':') || url.starts_with('/') {
                return Ok(url.to_string());
            }
            let image = match resolve(source_dir, url) {
                Ok(image) if image.is_file() => image,
                _ => return Ok(url.to_string()),
            };
            fs::create_dir_all(&assets).map_err(|error| format!("无法创建图片目录：{error}"))?;
            let name = image
                .file_name()
                .ok_or("无法解析图片名称。")?
                .to_string_lossy();
            let target = unique_name(&assets, &asset_file_name(&name));
            let target_path = assets.join(&target);
            copied.push(target_path.clone());
            fs::copy(image, target_path).map_err(|error| format!("无法复制笔记图片：{error}"))?;
            let rel = format!("{ASSETS_DIR}/{target}");
            mapped.insert(url.to_string(), rel.clone());
            Ok(rel)
        })?;
        if updated == original {
            fs::rename(source, destination).map_err(|error| format!("无法移动：{error}"))?;
        } else {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|error| format!("无法创建目标笔记：{error}"))?;
            created_note = true;
            file.write_all(updated.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|error| format!("无法保存目标笔记：{error}"))?;
            fs::remove_file(source).map_err(|error| format!("无法移动原笔记：{error}"))?;
        }
        Ok(())
    })();
    if result.is_err() {
        if created_note {
            let _ = fs::remove_file(destination);
        }
        for path in copied {
            let _ = fs::remove_file(path);
        }
    }
    result
}

/// Absolute directory that holds a note (its `assets/` sibling lives here).
fn note_dir(root: &Path, note_path: &str) -> Result<PathBuf, String> {
    let file = resolve(root, note_path)?;
    // An empty / dot-only note_path resolves to the notes root itself, whose parent
    // is OUTSIDE the notes tree — reject it so images can't escape the sandbox.
    if file == *root {
        return Err("非法的笔记路径。".into());
    }
    file.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位笔记目录。".to_string())
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

fn store_note_image_bytes(
    app: &AppHandle,
    note_path: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let root = notes_root(app)?;
    // Mirror save_note's guard: never recreate the folder of a note that was just
    // deleted/moved (a late flush persisting an inline image would otherwise leave a
    // half-resurrected directory with an orphan image and no note).
    let file = resolve(&root, note_path)?;
    if !file.is_file() {
        return Err("笔记不存在。".into());
    }
    let dir = note_dir(&root, note_path)?;
    let assets = dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets).map_err(|error| format!("无法创建 assets 目录：{error}"))?;

    let cleaned = asset_file_name(name);
    let base = if Path::new(&cleaned).extension().is_some() {
        cleaned
    } else {
        format!("{cleaned}.png")
    };
    let file = unique_name(&assets, &base);
    fs::write(assets.join(&file), bytes).map_err(|error| format!("无法保存图片：{error}"))?;

    Ok(format!("{ASSETS_DIR}/{file}"))
}

/// Legacy Base64 command kept for compatibility with already-open older windows.
#[tauri::command]
pub fn save_note_image(
    app: AppHandle,
    note_path: String,
    name: String,
    data_base64: String,
) -> Result<SavedImage, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("图片数据无法解码：{error}"))?;
    let rel_path = store_note_image_bytes(&app, &note_path, &name, &bytes)?;

    let ext = Path::new(&rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let data_url = format!(
        "data:{};base64,{}",
        mime_for(ext),
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    Ok(SavedImage { rel_path, data_url })
}

/// Fast path used by every Markdown editor: raw bytes in, only a short relative
/// path out. This avoids Base64 expansion and a second encode on the return trip.
#[tauri::command]
pub fn save_note_image_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let (note_path, name, bytes) = crate::markdown_assets::parse_write_request(&request)?;
    store_note_image_bytes(&app, &note_path, &name, bytes)
}

/// Resolve note-relative image paths (e.g. `assets/pic.png`) to data URLs so the
/// editor can display them. Missing/unreadable entries come back as empty strings
/// (same length/order as the input) so the caller can map them 1:1.
#[tauri::command]
pub fn read_note_assets(
    app: AppHandle,
    note_path: String,
    rel_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = notes_root(&app)?;
    let dir = note_dir(&root, &note_path)?;
    let mut out = Vec::with_capacity(rel_paths.len());
    for rel in &rel_paths {
        let resolved = match resolve(&dir, rel) {
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

#[tauri::command]
pub fn read_note_asset_bytes(
    app: AppHandle,
    note_path: String,
    rel_path: String,
) -> Result<Response, String> {
    let root = notes_root(&app)?;
    let dir = note_dir(&root, &note_path)?;
    let path = resolve(&dir, &rel_path)?;
    let bytes = fs::read(path).map_err(|error| format!("无法读取图片：{error}"))?;
    Ok(Response::new(bytes))
}

/// Absolute filesystem path of an existing note or folder, for "reveal in Finder".
#[tauri::command]
pub fn note_reveal_path(app: AppHandle, path: String) -> Result<String, String> {
    let root = notes_root(&app)?;
    let target = resolve(&root, &path)?;
    if target == root || !target.exists() {
        return Err("路径不存在。".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestNotes(PathBuf);

    impl TestNotes {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("nomi-notes-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, path: &str, content: &str) {
            let file = self.0.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }

        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.0.join(path)).unwrap()
        }
    }

    impl Drop for TestNotes {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn moves_note_to_folder_and_back_to_root_without_renaming_on_noop() {
        let notes = TestNotes::new();
        notes.write("工作/周报.md", "最新编辑的内容");
        let unchanged = move_node_under(&notes.0, "工作/周报.md", "工作").unwrap();
        assert_eq!(unchanged.path, "工作/周报.md");
        let moved = move_node_under(&notes.0, &unchanged.path, "").unwrap();
        assert_eq!(moved.path, "周报.md");
        assert_eq!(notes.read(&moved.path), "最新编辑的内容");
        assert!(!notes.0.join("工作/周报.md").exists());
        let moved_back = move_node_under(&notes.0, &moved.path, "工作").unwrap();
        assert_eq!(moved_back.path, "工作/周报.md");
        assert_eq!(notes.read(&moved_back.path), "最新编辑的内容");
    }

    #[test]
    fn disambiguates_notes_without_overwriting_existing_content() {
        let notes = TestNotes::new();
        notes.write("工作/周报.md", "移动的内容");
        notes.write("归档/周报.md", "原有内容");
        let moved = move_node_under(&notes.0, "工作/周报.md", "归档").unwrap();
        assert_eq!(moved.path, "归档/周报-2.md");
        assert_eq!(notes.read("归档/周报.md"), "原有内容");
        assert_eq!(notes.read(&moved.path), "移动的内容");
    }

    #[test]
    fn moves_folder_descendants_and_assets_together_and_rejects_cycles() {
        let notes = TestNotes::new();
        notes.write("研究/资料/论文.md", "![图](assets/chart.png)");
        notes.write("研究/资料/assets/chart.png", "图片数据");
        notes.write("工作/占位.md", "");
        for parent in ["研究", "研究/资料"] {
            assert!(move_node_under(&notes.0, "研究", parent).is_err());
        }
        assert!(move_node_under(&notes.0, "", "工作").is_err());
        let moved = move_node_under(&notes.0, "研究", "工作").unwrap();
        assert_eq!(moved.path, "工作/研究");
        assert_eq!(
            notes.read("工作/研究/资料/论文.md"),
            "![图](assets/chart.png)"
        );
        assert_eq!(notes.read("工作/研究/资料/assets/chart.png"), "图片数据");
        assert!(!notes.0.join("研究").exists());
    }

    #[test]
    fn copies_shared_images_and_rewrites_collisions_once_while_preserving_titles() {
        let notes = TestNotes::new();
        let original = "正文\n![图](assets/chart.png \"标题\")\n![重复](<assets/chart.png>)\n![空格](<pictures/my photo.png> '照片')\n![远程](https://example.com/a.png)\n![缺失](assets/missing.png)";
        notes.write("工作/周报.md", original);
        notes.write("工作/保留.md", "![共用](assets/chart.png)");
        notes.write("工作/assets/chart.png", "移动的图片");
        notes.write("工作/pictures/my photo.png", "带空格的图片");
        notes.write("归档/assets/chart.png", "目标原有图片");
        let moved = move_node_under(&notes.0, "工作/周报.md", "归档").unwrap();
        let content = notes.read(&moved.path);
        assert!(content.contains("![图](assets/chart-2.png \"标题\")"));
        assert!(content.contains("![重复](<assets/chart-2.png>)"));
        assert!(content.contains("![空格](<assets/my-photo.png> '照片')"));
        assert!(content.contains("![远程](https://example.com/a.png)"));
        assert!(content.contains("![缺失](assets/missing.png)"));
        assert_eq!(notes.read("归档/assets/chart.png"), "目标原有图片");
        assert_eq!(notes.read("归档/assets/chart-2.png"), "移动的图片");
        assert_eq!(notes.read("归档/assets/my-photo.png"), "带空格的图片");
        assert_eq!(notes.read("工作/assets/chart.png"), "移动的图片");
        assert_eq!(notes.read("工作/保留.md"), "![共用](assets/chart.png)");
        assert!(!notes.0.join("归档/assets/chart-3.png").exists());
    }

    #[test]
    fn failed_move_preserves_original_and_cleans_up_copied_images() {
        let notes = TestNotes::new();
        notes.write("工作/周报.md", "![图](pictures/chart.png)");
        notes.write("工作/pictures/chart.png", "图片数据");
        notes.write("归档/周报.md", "不能覆盖");
        assert!(
            move_note_file(&notes.0.join("工作/周报.md"), &notes.0.join("归档/周报.md")).is_err()
        );
        assert_eq!(notes.read("工作/周报.md"), "![图](pictures/chart.png)");
        assert_eq!(notes.read("工作/pictures/chart.png"), "图片数据");
        assert_eq!(notes.read("归档/周报.md"), "不能覆盖");
        assert!(!notes.0.join("归档/assets/chart.png").exists());
    }
}
