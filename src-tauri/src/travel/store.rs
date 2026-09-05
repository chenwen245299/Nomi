//! Persistence for travel: notes (Markdown + metadata + inline images), trip
//! plans, and per-feature settings.
//!
//! Layout under the user's data folder — plain, portable, human-readable:
//!
//! ```text
//! travel/
//!   notes/
//!     <id>/
//!       note.md            the Markdown body (same editor + asset scheme as notes)
//!       meta.json          { id, title, category, lat, lng, address, rating, date, … }
//!       assets/pic.png     inline images, referenced as assets/pic.png
//!   plans/
//!     <id>.json            one itinerary { id, title, dateRange, stops: [ … ] }
//!   maps/                  offline basemaps (see maps.rs)
//!   settings.json          { schemaVersion, basemap, categories }
//! ```
//!
//! A note is a folder so its images travel with it; metadata lives beside the
//! Markdown so the whole note is self-contained and can be copied elsewhere.

use base64::Engine;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use super::{NoteInput, PlanInput, SavedImage, TravelNote, TravelPlan, TravelSettings};
use crate::storage;

const TRAVEL_DIR: &str = "travel";
const NOTES_DIR: &str = "notes";
const PLANS_DIR: &str = "plans";
const ASSETS_DIR: &str = "assets";
const NOTE_FILE: &str = "note.md";
const META_FILE: &str = "meta.json";
const SETTINGS_FILE: &str = "settings.json";
const SCHEMA_VERSION: u32 = 1;

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn travel_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(TRAVEL_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 travel 目录：{error}"))?;
    Ok(dir)
}

fn notes_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = travel_root(app)?.join(NOTES_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建旅行笔记目录：{error}"))?;
    Ok(dir)
}

fn plans_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = travel_root(app)?.join(PLANS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建旅行规划目录：{error}"))?;
    Ok(dir)
}

/// An id is a random, filesystem-safe token; a note/plan folder is named by it.
/// Rejecting anything else keeps ids from escaping their root.
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

fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut contents =
        serde_json::to_string_pretty(value).map_err(|error| format!("无法序列化数据：{error}"))?;
    contents.push('\n');
    // Write-then-rename so a crash mid-write cannot corrupt the file.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    fs::rename(&temp, path).map_err(|error| format!("无法写入 {}：{error}", path.display()))
}

fn read_json<T: for<'de> serde::Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

// ── Notes ─────────────────────────────────────────────────────────────────────

fn note_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(notes_root(app)?.join(safe_id(id)?))
}

fn read_note_meta(dir: &Path) -> Option<TravelNote> {
    read_json::<TravelNote>(&dir.join(META_FILE)).ok()
}

/// Every travel note's metadata, newest trip first (then most recently updated).
pub(super) fn list_notes(app: &AppHandle) -> Result<Vec<TravelNote>, String> {
    let root = notes_root(app)?;
    let mut notes: Vec<TravelNote> = fs::read_dir(&root)
        .map_err(|error| format!("无法读取旅行笔记目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| read_note_meta(&entry.path()))
        .collect();
    notes.sort_by(|a, b| {
        b.date
            .cmp(&a.date)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(b.created_at.cmp(&a.created_at))
    });
    Ok(notes)
}

pub(super) fn create_note(app: &AppHandle, input: NoteInput) -> Result<TravelNote, String> {
    let id = new_id();
    let dir = notes_root(app)?.join(&id);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建旅行笔记：{error}"))?;
    let ts = now();
    let note = TravelNote {
        id: id.clone(),
        title: clean_title(&input.title),
        category: input.category.trim().to_string(),
        lat: input.lat,
        lng: input.lng,
        address: input.address.trim().to_string(),
        rating: input.rating.min(5),
        date: clean_date(&input.date),
        created_at: ts,
        updated_at: ts,
    };
    write_json(&dir.join(META_FILE), &note)?;
    fs::write(dir.join(NOTE_FILE), "").map_err(|error| format!("无法创建笔记正文：{error}"))?;
    Ok(note)
}

pub(super) fn read_note(app: &AppHandle, id: &str) -> Result<String, String> {
    let file = note_dir(app, id)?.join(NOTE_FILE);
    if !file.is_file() {
        return Ok(String::new());
    }
    fs::read_to_string(&file).map_err(|error| format!("无法读取笔记正文：{error}"))
}

pub(super) fn save_note(app: &AppHandle, id: &str, content: &str) -> Result<(), String> {
    let dir = note_dir(app, id)?;
    if !dir.is_dir() {
        return Err("旅行笔记不存在。".into());
    }
    fs::write(dir.join(NOTE_FILE), content)
        .map_err(|error| format!("无法保存笔记正文：{error}"))?;
    // Touch updatedAt so the note bubbles up and the list stays honest.
    if let Some(mut meta) = read_note_meta(&dir) {
        meta.updated_at = now();
        write_json(&dir.join(META_FILE), &meta)?;
    }
    Ok(())
}

/// Replace a note's editable metadata wholesale (the editor always sends the full
/// current values). `id` and `createdAt` are preserved; a `null` lat/lng clears
/// the coordinate. Taking the whole object sidesteps double-`Option` patching.
pub(super) fn update_note(
    app: &AppHandle,
    id: &str,
    input: NoteInput,
) -> Result<TravelNote, String> {
    let dir = note_dir(app, id)?;
    let mut meta = read_note_meta(&dir).ok_or_else(|| "旅行笔记不存在。".to_string())?;
    meta.title = clean_title(&input.title);
    meta.category = input.category.trim().to_string();
    meta.lat = input.lat;
    meta.lng = input.lng;
    meta.address = input.address.trim().to_string();
    meta.rating = input.rating.min(5);
    meta.date = clean_date(&input.date);
    meta.updated_at = now();
    write_json(&dir.join(META_FILE), &meta)?;
    Ok(meta)
}

pub(super) fn delete_note(app: &AppHandle, id: &str) -> Result<(), String> {
    let dir = note_dir(app, id)?;
    if !dir.is_dir() {
        return Err("旅行笔记不存在。".into());
    }
    fs::remove_dir_all(&dir).map_err(|error| format!("无法删除旅行笔记：{error}"))
}

fn clean_title(title: &str) -> String {
    let trimmed = title.trim();
    let limited: String = trimmed.chars().take(120).collect();
    if limited.trim().is_empty() {
        "未命名旅行".to_string()
    } else {
        limited
    }
}

/// Keep a YYYY-MM-DD date, or fall back to today when the input is malformed.
fn clean_date(date: &str) -> String {
    let trimmed = date.trim();
    let valid = trimmed.len() == 10
        && trimmed.as_bytes()[4] == b'-'
        && trimmed.as_bytes()[7] == b'-'
        && trimmed
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if valid { trimmed.to_string() } else { today() }
}

fn today() -> String {
    // A dependency-free local date is not available here; the frontend always
    // supplies one, so this fallback (epoch-derived UTC) is only a safety net.
    let secs = now();
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-from-civil, inverted. Good for the safety-net date above.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ── Inline images (per-note assets/, mirrors the notes module) ────────────────

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

fn store_note_image_bytes(
    app: &AppHandle,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let dir = note_dir(app, id)?;
    if !dir.is_dir() {
        return Err("旅行笔记不存在。".into());
    }
    let assets = dir.join(ASSETS_DIR);
    fs::create_dir_all(&assets).map_err(|error| format!("无法创建 assets 目录：{error}"))?;

    let cleaned = sanitize_asset(name);
    let base = if Path::new(&cleaned).extension().is_some() {
        cleaned
    } else {
        format!("{cleaned}.png")
    };
    let file = unique_name(&assets, &base);
    fs::write(assets.join(&file), bytes).map_err(|error| format!("无法保存图片：{error}"))?;

    Ok(format!("{ASSETS_DIR}/{file}"))
}

pub(super) fn save_note_image(
    app: &AppHandle,
    id: &str,
    name: &str,
    data_base64: &str,
) -> Result<SavedImage, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("图片数据无法解码：{error}"))?;
    let rel_path = store_note_image_bytes(app, id, name, &bytes)?;

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

pub(super) fn save_note_image_bytes(
    app: &AppHandle,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    store_note_image_bytes(app, id, name, bytes)
}

pub(super) fn read_note_assets(
    app: &AppHandle,
    id: &str,
    rel_paths: &[String],
) -> Result<Vec<String>, String> {
    let dir = note_dir(app, id)?;
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

pub(super) fn read_note_asset_bytes(
    app: &AppHandle,
    id: &str,
    rel_path: &str,
) -> Result<Vec<u8>, String> {
    let dir = note_dir(app, id)?;
    let path = resolve_under(&dir, rel_path)?;
    fs::read(path).map_err(|error| format!("无法读取图片：{error}"))
}

/// Resolve a note-relative asset path, rejecting anything that would escape the
/// note's own folder.
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

/// Absolute path of a note folder (or the travel root when `id` is empty), for
/// "reveal in Finder".
pub(super) fn reveal_path(app: &AppHandle, id: Option<&str>) -> Result<String, String> {
    let target = match id {
        Some(id) if !id.is_empty() => note_dir(app, id)?,
        _ => travel_root(app)?,
    };
    if !target.exists() {
        return Err("路径不存在。".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

// ── Plans ─────────────────────────────────────────────────────────────────────

pub(super) fn list_plans(app: &AppHandle) -> Result<Vec<TravelPlan>, String> {
    let root = plans_root(app)?;
    let mut plans: Vec<TravelPlan> = fs::read_dir(&root)
        .map_err(|error| format!("无法读取旅行规划目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|entry| read_json::<TravelPlan>(&entry.path()).ok())
        .collect();
    plans.sort_by_key(|plan| std::cmp::Reverse(plan.updated_at));
    Ok(plans)
}

fn plan_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(plans_root(app)?.join(format!("{}.json", safe_id(id)?)))
}

pub(super) fn create_plan(app: &AppHandle, input: PlanInput) -> Result<TravelPlan, String> {
    let ts = now();
    let plan = TravelPlan {
        id: new_id(),
        title: clean_title(&input.title),
        start_date: input.start_date.trim().to_string(),
        end_date: input.end_date.trim().to_string(),
        notes: input.notes,
        stops: input.stops,
        created_at: ts,
        updated_at: ts,
    };
    write_json(&plan_path(app, &plan.id)?, &plan)?;
    Ok(plan)
}

pub(super) fn save_plan(app: &AppHandle, mut plan: TravelPlan) -> Result<TravelPlan, String> {
    let path = plan_path(app, &plan.id)?;
    if !path.is_file() {
        return Err("旅行规划不存在。".into());
    }
    plan.title = clean_title(&plan.title);
    plan.updated_at = now();
    write_json(&path, &plan)?;
    Ok(plan)
}

pub(super) fn delete_plan(app: &AppHandle, id: &str) -> Result<(), String> {
    let path = plan_path(app, id)?;
    if !path.is_file() {
        return Err("旅行规划不存在。".into());
    }
    fs::remove_file(&path).map_err(|error| format!("无法删除旅行规划：{error}"))
}

// ── Settings ──────────────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: [&str; 8] = [
    "城市", "自然", "美食", "住宿", "文化", "购物", "海岛", "其他",
];

pub(super) fn read_settings(app: &AppHandle) -> Result<TravelSettings, String> {
    let path = travel_root(app)?.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(TravelSettings {
            schema_version: SCHEMA_VERSION,
            basemap: "online".into(),
            categories: DEFAULT_CATEGORIES.iter().map(|s| s.to_string()).collect(),
        });
    }
    read_json(&path).map_err(|error| format!("旅行设置无法解析：{error}"))
}

pub(super) fn write_settings(
    app: &AppHandle,
    mut settings: TravelSettings,
) -> Result<TravelSettings, String> {
    settings.schema_version = SCHEMA_VERSION;
    if settings.categories.is_empty() {
        settings.categories = DEFAULT_CATEGORIES.iter().map(|s| s.to_string()).collect();
    }
    write_json(&travel_root(app)?.join(SETTINGS_FILE), &settings)?;
    Ok(settings)
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
    fn keeps_valid_dates_and_replaces_bad_ones() {
        assert_eq!(clean_date("2026-09-01"), "2026-09-01");
        assert_eq!(clean_date("nope").len(), 10);
    }

    #[test]
    fn civil_from_days_round_trips_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }
}
