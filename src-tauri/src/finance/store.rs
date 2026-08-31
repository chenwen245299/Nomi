//! Persistence for the ledger: records, the capture conversation, settings and
//! receipt images.
//!
//! Layout under the user's data folder — plain, portable, human-readable:
//!
//! ```text
//! finance/
//!   settings.json            { schemaVersion, providerId, modelId, currency }
//!   captures.json            the capture conversation (trimmed to the last 200)
//!   ledger/
//!     2026-08.json           { schemaVersion, records: [ … ] }
//!   receipts/
//!     2026-08/<id>.png       the picture each record came from
//! ```
//!
//! One file per month keeps each file small enough to open in an editor and
//! makes "show me August" a single read. A record's month is derived from its
//! `date`, so editing a record's date moves it between files (see
//! [`update_record`]).

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use image::ImageFormat;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{CaptureMessage, ExpenseRecord, FinanceSettings, RecordPatch};
use crate::storage;

const FINANCE_DIR: &str = "finance";
const LEDGER_DIR: &str = "ledger";
const RECEIPTS_DIR: &str = "receipts";
const SETTINGS_FILE: &str = "settings.json";
const CAPTURES_FILE: &str = "captures.json";
const SCHEMA_VERSION: u32 = 1;
/// How many capture messages to keep. The ledger is the durable record; the
/// conversation is a working log, so it is trimmed rather than grown forever.
const MAX_MESSAGES: usize = 200;
/// Keep the prompt useful without letting years of one-off merchant names take
/// over the model context. Frequently confirmed names win, then recent ones.
const MAX_MERCHANT_MEMORY: usize = 120;
/// Longest edge kept for a stored receipt. Well above what any receipt needs to
/// stay readable, and far below what a phone camera produces — which keeps both
/// the data folder and the vision request small.
const MAX_EDGE: u32 = 2200;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthFile {
    schema_version: u32,
    records: Vec<ExpenseRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturesFile {
    schema_version: u32,
    messages: Vec<CaptureMessage>,
}

#[derive(Default)]
struct MerchantStats {
    uses: usize,
    updated_at: u64,
    categories: HashMap<String, CategoryStats>,
}

#[derive(Default)]
struct CategoryStats {
    uses: usize,
    updated_at: u64,
}

pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn finance_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(FINANCE_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 finance 目录：{error}"))?;
    Ok(dir)
}

/// The `YYYY-MM` a `YYYY-MM-DD` date belongs to.
pub(super) fn month_of(date: &str) -> String {
    date.chars().take(7).collect()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut contents =
        serde_json::to_string_pretty(value).map_err(|error| format!("无法序列化数据：{error}"))?;
    contents.push('\n');
    // Write-then-rename so a crash mid-write cannot truncate a month of records.
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    fs::rename(&temp, path).map_err(|error| format!("无法写入 {}：{error}", path.display()))
}

// ── Settings ─────────────────────────────────────────────────────────────────

pub(super) fn read_settings(app: &AppHandle) -> Result<FinanceSettings, String> {
    let path = finance_root(app)?.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(FinanceSettings::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取记账设置：{error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("记账设置无法解析：{error}"))
}

pub(super) fn write_settings(app: &AppHandle, settings: &FinanceSettings) -> Result<(), String> {
    write_json(&finance_root(app)?.join(SETTINGS_FILE), settings)
}

// ── Records ──────────────────────────────────────────────────────────────────

fn month_path(app: &AppHandle, month: &str) -> Result<PathBuf, String> {
    if month.len() != 7 || !month.is_char_boundary(4) {
        return Err("月份格式必须是 YYYY-MM。".into());
    }
    Ok(finance_root(app)?
        .join(LEDGER_DIR)
        .join(format!("{month}.json")))
}

fn read_month(app: &AppHandle, month: &str) -> Result<Vec<ExpenseRecord>, String> {
    let path = month_path(app, month)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取 {month} 的账目：{error}"))?;
    let file: MonthFile = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "{month} 的账目无法解析，为保护数据没有覆盖它。文件：{}；错误：{error}",
            path.display()
        )
    })?;
    if file.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "{month} 的账目使用了更新版本的格式（版本 {}），当前应用仅支持版本 {SCHEMA_VERSION}。",
            file.schema_version
        ));
    }
    Ok(file.records)
}

fn write_month(app: &AppHandle, month: &str, records: &[ExpenseRecord]) -> Result<(), String> {
    let path = month_path(app, month)?;
    if records.is_empty() {
        // An emptied month leaves no file behind, so the month list stays honest.
        if path.exists() {
            fs::remove_file(&path).map_err(|error| format!("无法删除 {month} 的账目：{error}"))?;
        }
        return Ok(());
    }
    write_json(
        &path,
        &MonthFile {
            schema_version: SCHEMA_VERSION,
            records: records.to_vec(),
        },
    )
}

/// Every `YYYY-MM` that has a ledger file, newest first.
pub(super) fn list_months(app: &AppHandle) -> Result<Vec<String>, String> {
    let dir = finance_root(app)?.join(LEDGER_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut months: Vec<String> = fs::read_dir(&dir)
        .map_err(|error| format!("无法读取账目目录：{error}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".json").map(str::to_string)
        })
        .filter(|month| month.len() == 7)
        .collect();
    months.sort();
    months.reverse();
    Ok(months)
}

/// Records for one month, or — when `month` is `None` — every record there is.
/// Sorted newest first (by date, then by when it was captured).
pub(super) fn list_records(
    app: &AppHandle,
    month: Option<&str>,
) -> Result<Vec<ExpenseRecord>, String> {
    let mut records = match month {
        Some(month) => read_month(app, month)?,
        None => {
            let mut all = Vec::new();
            for month in list_months(app)? {
                all.extend(read_month(app, &month)?);
            }
            all
        }
    };
    records.sort_by(|a, b| b.date.cmp(&a.date).then(b.created_at.cmp(&a.created_at)));
    Ok(records)
}

/// Canonical merchant names and their usual categories learned from the confirmed
/// ledger. The ledger is the source of truth, so manual edits immediately teach
/// the next extraction and deleted/renamed merchants cannot leave stale memory.
pub(super) fn merchant_memory(app: &AppHandle) -> Result<Vec<(String, String, usize)>, String> {
    let mut stats: HashMap<String, MerchantStats> = HashMap::new();
    for record in list_records(app, None)? {
        let name = record.merchant.trim();
        if name.is_empty() {
            continue;
        }
        let merchant = stats.entry(name.to_string()).or_default();
        merchant.uses += 1;
        merchant.updated_at = merchant.updated_at.max(record.updated_at);

        let category = merchant
            .categories
            .entry(record.category.trim().to_string())
            .or_default();
        category.uses += 1;
        category.updated_at = category.updated_at.max(record.updated_at);
    }

    let mut merchants: Vec<(String, String, usize, u64)> = stats
        .into_iter()
        .map(|(name, stats)| {
            let mut categories: Vec<(String, CategoryStats)> =
                stats.categories.into_iter().collect();
            categories.sort_by(|left, right| {
                right
                    .1
                    .uses
                    .cmp(&left.1.uses)
                    .then(right.1.updated_at.cmp(&left.1.updated_at))
                    .then(left.0.cmp(&right.0))
            });
            let category = categories
                .into_iter()
                .next()
                .map(|(category, _)| category)
                .unwrap_or_else(|| "其他".into());
            (name, category, stats.uses, stats.updated_at)
        })
        .collect();
    merchants.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then(right.3.cmp(&left.3))
            .then(left.0.cmp(&right.0))
    });
    merchants.truncate(MAX_MERCHANT_MEMORY);
    Ok(merchants
        .into_iter()
        .map(|(name, category, uses, _)| (name, category, uses))
        .collect())
}

/// Append records, grouped into their months in as few writes as possible.
pub(super) fn insert_records(app: &AppHandle, records: &[ExpenseRecord]) -> Result<(), String> {
    let mut months: Vec<String> = records.iter().map(|r| month_of(&r.date)).collect();
    months.sort();
    months.dedup();
    for month in months {
        let mut existing = read_month(app, &month)?;
        existing.extend(
            records
                .iter()
                .filter(|record| month_of(&record.date) == month)
                .cloned(),
        );
        write_month(app, &month, &existing)?;
    }
    Ok(())
}

/// Find `id` across months and apply `patch`. A date change that crosses a month
/// boundary moves the record to the other file.
pub(super) fn update_record(
    app: &AppHandle,
    id: &str,
    patch: RecordPatch,
) -> Result<ExpenseRecord, String> {
    for month in list_months(app)? {
        let mut records = read_month(app, &month)?;
        let Some(index) = records.iter().position(|record| record.id == id) else {
            continue;
        };
        let mut record = records[index].clone();
        patch.apply(&mut record)?;
        record.updated_at = now();

        let new_month = month_of(&record.date);
        if new_month == month {
            records[index] = record.clone();
            write_month(app, &month, &records)?;
        } else {
            records.remove(index);
            write_month(app, &month, &records)?;
            let mut target = read_month(app, &new_month)?;
            target.push(record.clone());
            write_month(app, &new_month, &target)?;
        }
        return Ok(record);
    }
    Err("账目不存在。".into())
}

/// Delete a record and, with it, the receipt image nothing else points at.
pub(super) fn delete_record(app: &AppHandle, id: &str) -> Result<(), String> {
    for month in list_months(app)? {
        let mut records = read_month(app, &month)?;
        let Some(index) = records.iter().position(|record| record.id == id) else {
            continue;
        };
        let removed = records.remove(index);
        write_month(app, &month, &records)?;
        if let Some(receipt) = removed.receipt.as_deref()
            && !receipt_in_use(app, receipt)?
            && let Ok(path) = receipt_path(app, receipt)
        {
            let _ = fs::remove_file(path);
        }
        return Ok(());
    }
    Err("账目不存在。".into())
}

/// Whether any record still references this receipt — several records extracted
/// from one screenshot share its image.
fn receipt_in_use(app: &AppHandle, receipt: &str) -> Result<bool, String> {
    Ok(list_records(app, None)?
        .iter()
        .any(|record| record.receipt.as_deref() == Some(receipt)))
}

// ── Capture conversation ─────────────────────────────────────────────────────

pub(super) fn read_messages(app: &AppHandle) -> Result<Vec<CaptureMessage>, String> {
    let path = finance_root(app)?.join(CAPTURES_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取记账对话：{error}"))?;
    let file: CapturesFile =
        serde_json::from_str(&contents).map_err(|error| format!("记账对话无法解析：{error}"))?;
    Ok(file.messages)
}

pub(super) fn write_messages(app: &AppHandle, messages: &[CaptureMessage]) -> Result<(), String> {
    let start = messages.len().saturating_sub(MAX_MESSAGES);
    write_json(
        &finance_root(app)?.join(CAPTURES_FILE),
        &CapturesFile {
            schema_version: SCHEMA_VERSION,
            messages: messages[start..].to_vec(),
        },
    )
}

pub(super) fn append_message(
    app: &AppHandle,
    message: CaptureMessage,
) -> Result<CaptureMessage, String> {
    let mut messages = read_messages(app)?;
    messages.push(message.clone());
    write_messages(app, &messages)?;
    Ok(message)
}

/// Replace one message in place (used to attach the saved record ids once the
/// user confirms a draft).
pub(super) fn replace_message(app: &AppHandle, message: &CaptureMessage) -> Result<(), String> {
    let mut messages = read_messages(app)?;
    let Some(slot) = messages.iter_mut().find(|item| item.id == message.id) else {
        return Err("消息不存在。".into());
    };
    *slot = message.clone();
    write_messages(app, &messages)
}

// ── Receipts ─────────────────────────────────────────────────────────────────

/// Store a receipt image under `receipts/<month>/`, normalising it first.
/// Returns the path relative to `finance/`, which is what a record carries.
pub(super) fn save_receipt(
    app: &AppHandle,
    bytes: &[u8],
    mime: &str,
    month: &str,
) -> Result<(String, String), String> {
    let (bytes, mime) = normalize_image(bytes, mime)?;
    let extension = if mime == "image/jpeg" { "jpg" } else { "png" };
    let name = format!("{}.{extension}", uuid::Uuid::new_v4());
    let relative = format!("{RECEIPTS_DIR}/{month}/{name}");
    let path = finance_root(app)?
        .join(RECEIPTS_DIR)
        .join(month)
        .join(&name);
    fs::create_dir_all(path.parent().unwrap_or(&path))
        .map_err(|error| format!("无法创建票据目录：{error}"))?;
    fs::write(&path, &bytes).map_err(|error| format!("无法保存票据图片：{error}"))?;
    Ok((relative, mime))
}

/// Resolve a stored receipt's relative path to an absolute one, rejecting
/// anything that is not a plain chain of components under `finance/`.
pub(super) fn receipt_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let mut path = finance_root(app)?;
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            _ => return Err("非法的票据路径。".into()),
        }
    }
    if !path.is_file() {
        return Err("票据图片不存在。".into());
    }
    Ok(path)
}

/// Flatten transparency onto white and cap the longest edge.
///
/// Both matter downstream: macOS Vision returns *nothing* for an image with a
/// transparent background, and an un-resized phone photo costs several times the
/// image tokens it needs to. An image that is already opaque and small enough is
/// returned untouched, so a pasted screenshot keeps its exact pixels.
pub(super) fn normalize_image(bytes: &[u8], mime: &str) -> Result<(Vec<u8>, String), String> {
    let decoded = image::load_from_memory(bytes)
        .map_err(|error| format!("无法读取图片（仅支持 PNG / JPEG）：{error}"))?;
    let (width, height) = (decoded.width(), decoded.height());
    let needs_resize = width.max(height) > MAX_EDGE;
    let has_alpha = decoded.color().has_alpha();
    let jpeg = mime.eq_ignore_ascii_case("image/jpeg") || mime.eq_ignore_ascii_case("image/jpg");

    if !needs_resize && !has_alpha {
        let mime = if jpeg { "image/jpeg" } else { "image/png" };
        return Ok((bytes.to_vec(), mime.to_string()));
    }

    let resized = if needs_resize {
        decoded.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };
    // `to_rgb8` drops the alpha channel by compositing onto black, which turns
    // dark receipt text invisible — so blend onto white explicitly instead.
    let rgba = resized.to_rgba8();
    let mut flat = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = f32::from(pixel[3]) / 255.0;
        let blend = |channel: u8| (f32::from(channel) * alpha + 255.0 * (1.0 - alpha)) as u8;
        flat.put_pixel(
            x,
            y,
            image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }

    let format = if jpeg {
        ImageFormat::Jpeg
    } else {
        ImageFormat::Png
    };
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(flat)
        .write_to(&mut out, format)
        .map_err(|error| format!("无法处理图片：{error}"))?;
    let mime = if jpeg { "image/jpeg" } else { "image/png" };
    Ok((out.into_inner(), mime.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_alpha(width: u32, height: u32) -> Vec<u8> {
        let mut image = image::RgbaImage::new(width, height);
        for pixel in image.pixels_mut() {
            // Fully transparent black — what a PDF-derived screenshot looks like.
            *pixel = image::Rgba([0, 0, 0, 0]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn flattens_transparency_onto_white() {
        let (bytes, mime) = normalize_image(&png_with_alpha(8, 8), "image/png").unwrap();
        assert_eq!(mime, "image/png");
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert!(!decoded.color().has_alpha());
        assert_eq!(
            decoded.to_rgb8().get_pixel(0, 0),
            &image::Rgb([255, 255, 255])
        );
    }

    #[test]
    fn caps_the_longest_edge() {
        let mut image = image::RgbImage::new(MAX_EDGE + 800, 100);
        image.put_pixel(0, 0, image::Rgb([1, 2, 3]));
        let mut source = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut source, ImageFormat::Png)
            .unwrap();

        let (bytes, _) = normalize_image(&source.into_inner(), "image/png").unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(decoded.width(), MAX_EDGE);
    }

    #[test]
    fn leaves_a_small_opaque_image_untouched() {
        let mut source = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(40, 40))
            .write_to(&mut source, ImageFormat::Png)
            .unwrap();
        let original = source.into_inner();

        let (bytes, mime) = normalize_image(&original, "image/png").unwrap();
        assert_eq!(bytes, original);
        assert_eq!(mime, "image/png");
    }

    #[test]
    fn derives_the_month_from_a_date() {
        assert_eq!(month_of("2026-08-28"), "2026-08");
    }
}
