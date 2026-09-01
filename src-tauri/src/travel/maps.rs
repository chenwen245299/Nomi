//! Offline basemaps.
//!
//! Each offline basemap is a single [PMTiles](https://protomaps.com/) archive
//! stored under `travel/maps/<name>.pmtiles`, with an index in
//! `travel/maps/maps.json`. A map is added by importing a local `.pmtiles` file
//! or downloading one from a URL (streamed, with progress events), and updated
//! by re-downloading from its saved source URL. The frontend reads tiles
//! straight off disk through [`read_range`] (a custom PMTiles byte-range source),
//! so a selected offline map needs no network at all.

use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::storage;

const TRAVEL_DIR: &str = "travel";
const MAPS_DIR: &str = "maps";
const INDEX_FILE: &str = "maps.json";
const MAP_EXT: &str = "pmtiles";
const SCHEMA_VERSION: u32 = 1;
/// Event emitted while a download runs so the UI can show a progress bar.
pub const PROGRESS_EVENT: &str = "travel://map-progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineMap {
    /// Display name and (sanitised) file stem — unique within `maps/`.
    pub name: String,
    /// Where a downloaded map came from, so "update" can re-fetch it. Absent for
    /// maps imported from a local file.
    #[serde(default)]
    pub source_url: Option<String>,
    /// Size on disk, in bytes.
    pub bytes: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapsIndex {
    schema_version: u32,
    maps: Vec<OfflineMap>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    name: String,
    received: u64,
    total: u64,
    done: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn maps_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(TRAVEL_DIR).join(MAPS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建离线地图目录：{error}"))?;
    Ok(dir)
}

/// A display name reduced to a safe single file stem (keeps CJK, drops path- and
/// URL-unsafe characters). Empty results are rejected by the callers.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c.is_whitespace() || "/\\:*?\"<>|.".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').trim();
    trimmed.chars().take(60).collect()
}

fn map_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let stem = safe_name(name);
    if stem.is_empty() {
        return Err("离线地图名称无效。".into());
    }
    Ok(maps_root(app)?.join(format!("{stem}.{MAP_EXT}")))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(maps_root(app)?.join(INDEX_FILE))
}

fn read_index(app: &AppHandle) -> Result<Vec<OfflineMap>, String> {
    let path = index_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let index: MapsIndex = serde_json::from_str(&contents)
        .map_err(|error| format!("离线地图索引无法解析：{error}"))?;
    Ok(index.maps)
}

fn write_index(app: &AppHandle, maps: &[OfflineMap]) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(&MapsIndex {
        schema_version: SCHEMA_VERSION,
        maps: maps.to_vec(),
    })
    .map_err(|error| error.to_string())?;
    contents.push('\n');
    fs::write(index_path(app)?, contents).map_err(|error| format!("无法写入离线地图索引：{error}"))
}

fn upsert(app: &AppHandle, entry: OfflineMap) -> Result<(), String> {
    let mut maps = read_index(app)?;
    if let Some(slot) = maps.iter_mut().find(|m| m.name == entry.name) {
        *slot = entry;
    } else {
        maps.push(entry);
    }
    write_index(app, &maps)
}

/// Every known offline map. Reconciles the index against what is actually on disk
/// so a manually deleted `.pmtiles` never lingers as a ghost entry.
pub(super) fn list_maps(app: &AppHandle) -> Result<Vec<OfflineMap>, String> {
    let root = maps_root(app)?;
    let indexed = read_index(app)?;
    let mut out = Vec::new();
    // Files present on disk (a manually dropped-in .pmtiles shows up too).
    for entry in fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(MAP_EXT) {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(stem) => stem.to_string(),
            None => continue,
        };
        let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let known = indexed.iter().find(|m| m.name == stem);
        out.push(OfflineMap {
            name: stem.clone(),
            source_url: known.and_then(|m| m.source_url.clone()),
            bytes,
            updated_at: known.map(|m| m.updated_at).unwrap_or_else(now),
        });
    }
    out.sort_by_key(|map| std::cmp::Reverse(map.updated_at));
    // Keep the index in step with reality (prunes ghosts, records newcomers).
    write_index(app, &out)?;
    Ok(out)
}

/// Copy a local `.pmtiles` into the maps folder under `name`.
pub(super) fn import_map(
    app: &AppHandle,
    name: &str,
    source_path: &str,
) -> Result<OfflineMap, String> {
    let source = PathBuf::from(source_path);
    if source.extension().and_then(|e| e.to_str()) != Some(MAP_EXT) {
        return Err("请选择一个 .pmtiles 文件。".into());
    }
    if !source.is_file() {
        return Err("找不到所选文件。".into());
    }
    let dest = map_path(app, name)?;
    fs::copy(&source, &dest).map_err(|error| format!("无法导入离线地图：{error}"))?;
    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let entry = OfflineMap {
        name: safe_name(name),
        source_url: None,
        bytes,
        updated_at: now(),
    };
    upsert(app, entry.clone())?;
    Ok(entry)
}

/// Stream a `.pmtiles` archive from `url` into `travel/maps/<name>.pmtiles`,
/// emitting [`PROGRESS_EVENT`] as it goes. Writes to a temp file first, then
/// renames, so an interrupted download never replaces a working map.
pub(super) async fn download_map(
    app: AppHandle,
    name: String,
    url: String,
) -> Result<OfflineMap, String> {
    let stem = safe_name(&name);
    if stem.is_empty() {
        return Err("离线地图名称无效。".into());
    }
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("下载地址必须是 http(s) 链接。".into());
    }

    let dest = map_path(&app, &stem)?;
    let temp = dest.with_extension("pmtiles.part");

    let client = reqwest::Client::builder()
        .user_agent("Nomi/0.1 (+travel offline maps)")
        .build()
        .map_err(|error| format!("无法创建下载器：{error}"))?;
    let response = client
        .get(trimmed)
        .send()
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：服务器返回 {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&temp)
        .await
        .map_err(|error| format!("无法写入下载文件：{error}"))?;
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("无法写入下载文件：{error}"))?;
        received += chunk.len() as u64;
        // Throttle events to ~every 512 KiB so the UI stays smooth.
        if received - last_emit >= 512 * 1024 {
            last_emit = received;
            let _ = app.emit(
                PROGRESS_EVENT,
                Progress {
                    name: stem.clone(),
                    received,
                    total,
                    done: false,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("无法完成写入：{error}"))?;
    drop(file);
    tokio::fs::rename(&temp, &dest)
        .await
        .map_err(|error| format!("无法保存离线地图：{error}"))?;

    let entry = OfflineMap {
        name: stem.clone(),
        source_url: Some(trimmed.to_string()),
        bytes: received,
        updated_at: now(),
    };
    upsert(&app, entry.clone())?;
    let _ = app.emit(
        PROGRESS_EVENT,
        Progress {
            name: stem,
            received,
            total,
            done: true,
        },
    );
    Ok(entry)
}

/// Re-download a previously downloaded map from its saved source URL.
pub(super) async fn update_map(app: AppHandle, name: String) -> Result<OfflineMap, String> {
    let url = read_index(&app)?
        .into_iter()
        .find(|m| m.name == safe_name(&name))
        .and_then(|m| m.source_url)
        .ok_or_else(|| "这张离线地图没有可更新的来源（可重新导入文件）。".to_string())?;
    download_map(app, name, url).await
}

pub(super) fn delete_map(app: &AppHandle, name: &str) -> Result<(), String> {
    let path = map_path(app, name)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|error| format!("无法删除离线地图：{error}"))?;
    }
    let maps: Vec<OfflineMap> = read_index(app)?
        .into_iter()
        .filter(|m| m.name != safe_name(name))
        .collect();
    write_index(app, &maps)
}

/// Read `length` bytes at `offset` from an offline map, returned as base64. This
/// backs the frontend's PMTiles byte-range source, so tiles are served straight
/// off disk. Reads that run past EOF return the available bytes (which the
/// PMTiles reader tolerates).
pub(super) fn read_range(
    app: &AppHandle,
    name: &str,
    offset: u64,
    length: u32,
) -> Result<String, String> {
    let path = map_path(app, name)?;
    let mut file = fs::File::open(&path).map_err(|error| format!("无法打开离线地图：{error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("无法定位离线地图：{error}"))?;
    let mut buf = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) => return Err(format!("无法读取离线地图：{error}")),
        }
    }
    buf.truncate(filled);
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

pub(super) fn reveal_maps(app: &AppHandle) -> Result<String, String> {
    Ok(maps_root(app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(safe_name("华东 China/中国"), "华东-China-中国");
        assert_eq!(safe_name("../evil"), "evil");
        assert!(safe_name("   ").is_empty());
    }

    #[test]
    fn a_dotdot_name_collapses_to_a_plain_stem() {
        assert_eq!(safe_name(".."), "");
    }
}
