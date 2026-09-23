//! User-owned historical geography workspace.
//!
//! Nomi deliberately ships no historical boundary dataset. Users import their
//! own GeoJSON, KML or Shapefile data; we keep an untouched copy under
//! `history/imports/` and a normalized, time-aware working document in
//! `history/history.json`.

use quick_xml::{Reader as XmlReader, events::Event};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shapefile::{PolygonRing, Shape, dbase::FieldValue, record::traits::HasXY};
use std::{
    collections::BTreeSet,
    fs,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use zip::ZipArchive;

use crate::storage;

const HISTORY_DIR: &str = "history";
const IMPORTS_DIR: &str = "imports";
const DOCUMENT_FILE: &str = "history.json";
const SCHEMA_VERSION: u32 = 2;
const MIN_YEAR: i32 = -10_000;
const MAX_YEAR: i32 = 10_000;
const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_IMPORT_FEATURES: usize = 250_000;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySettings {
    #[serde(default = "default_year")]
    pub current_year: i32,
    #[serde(default = "default_basemap")]
    pub basemap: String,
}

fn default_year() -> i32 {
    200
}

fn default_basemap() -> String {
    "online".into()
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            current_year: default_year(),
            basemap: default_basemap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLayer {
    pub id: String,
    pub name: String,
    pub source_file: String,
    pub imported_at: u64,
    pub feature_count: usize,
    pub color: String,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub attribution: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFeature {
    pub id: String,
    pub region_id: String,
    pub layer_id: String,
    pub name: String,
    pub kind: String,
    pub valid_from: i32,
    pub valid_to: i32,
    pub color: String,
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_confidence")]
    pub confidence: String,
    pub geometry: Value,
    #[serde(default)]
    pub properties: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_year: i32,
    pub end_year: i32,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub region_ids: Vec<String>,
    #[serde(default)]
    pub person_ids: Vec<String>,
    #[serde(default)]
    pub people: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPerson {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub courtesy_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub birth_year: Option<i32>,
    #[serde(default)]
    pub death_year: Option<i32>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub affiliations: Vec<String>,
    #[serde(default)]
    pub biography: String,
    #[serde(default)]
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPersonRelation {
    pub id: String,
    pub from_person_id: String,
    pub to_person_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub start_year: Option<i32>,
    #[serde(default)]
    pub end_year: Option<i32>,
    #[serde(default)]
    pub event_ids: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub source: String,
    pub created_at: u64,
    pub updated_at: u64,
}

fn default_confidence() -> String {
    "unknown".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDocument {
    pub schema_version: u32,
    #[serde(default)]
    pub settings: HistorySettings,
    #[serde(default)]
    pub layers: Vec<HistoryLayer>,
    #[serde(default)]
    pub features: Vec<HistoryFeature>,
    #[serde(default)]
    pub events: Vec<HistoryEvent>,
    #[serde(default)]
    pub people: Vec<HistoryPerson>,
    #[serde(default)]
    pub relations: Vec<HistoryPersonRelation>,
}

impl Default for HistoryDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            settings: HistorySettings::default(),
            layers: Vec::new(),
            features: Vec::new(),
            events: Vec::new(),
            people: Vec::new(),
            relations: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHistoryLayerInput {
    pub id: String,
    pub name: String,
    pub color: String,
    pub visible: bool,
    #[serde(default)]
    pub attribution: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHistoryFeatureInput {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub valid_from: i32,
    pub valid_to: i32,
    pub color: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub confidence: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHistoryEventInput {
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub start_year: i32,
    pub end_year: i32,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub region_ids: Vec<String>,
    #[serde(default)]
    pub person_ids: Vec<String>,
    #[serde(default)]
    pub people: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHistoryPersonInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub courtesy_name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub birth_year: Option<i32>,
    #[serde(default)]
    pub death_year: Option<i32>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub affiliations: Vec<String>,
    #[serde(default)]
    pub biography: String,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHistoryRelationInput {
    pub id: Option<String>,
    pub from_person_id: String,
    pub to_person_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub start_year: Option<i32>,
    #[serde(default)]
    pub end_year: Option<i32>,
    #[serde(default)]
    pub event_ids: Vec<String>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryImportInspection {
    pub format: String,
    pub source_name: String,
    pub datasets: Vec<String>,
    pub selected_dataset: Option<String>,
    pub feature_count: usize,
    pub fields: Vec<String>,
    pub detected_name_field: Option<String>,
    pub detected_start_field: Option<String>,
    pub detected_end_field: Option<String>,
    pub detected_region_id_field: Option<String>,
    pub temporal_feature_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawMapFeature {
    raw_id: Option<String>,
    geometry: Value,
    properties: Map<String, Value>,
}

#[derive(Debug)]
struct LoadedMap {
    format: String,
    source_name: String,
    datasets: Vec<String>,
    selected_dataset: Option<String>,
    features: Vec<RawMapFeature>,
    warnings: Vec<String>,
}

struct ImportTempDir(PathBuf);

impl Drop for ImportTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = ID_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos:x}-{sequence:x}")
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = storage::current_root(app)?.join(HISTORY_DIR);
    fs::create_dir_all(path.join(IMPORTS_DIR))
        .map_err(|error| format!("无法创建历史资料目录：{error}"))?;
    Ok(path)
}

fn document_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(root(app)?.join(DOCUMENT_FILE))
}

fn load(app: &AppHandle) -> Result<HistoryDocument, String> {
    let path = document_path(app)?;
    if !path.exists() {
        return Ok(HistoryDocument::default());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取历史资料 {}：{error}", path.display()))?;
    let mut document: HistoryDocument = serde_json::from_str(&contents)
        .map_err(|error| format!("历史资料格式无效，为保护数据没有覆盖它：{error}"))?;
    if document.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "历史资料使用了更新的数据格式（{}），当前仅支持版本 {}。",
            document.schema_version, SCHEMA_VERSION
        ));
    }
    if document.schema_version < 2 {
        migrate_people(&mut document);
        document.schema_version = SCHEMA_VERSION;
        save(app, &document)?;
    }
    Ok(document)
}

fn save(app: &AppHandle, document: &HistoryDocument) -> Result<(), String> {
    let path = document_path(app)?;
    let mut contents = serde_json::to_string_pretty(document).map_err(|error| error.to_string())?;
    contents.push('\n');
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法保存历史资料：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法完成历史资料保存：{error}"))
}

fn migrate_people(document: &mut HistoryDocument) {
    let timestamp = now_secs();
    for event_index in 0..document.events.len() {
        let legacy_names = document.events[event_index].people.clone();
        for name in legacy_names {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                continue;
            }
            let person_id = if let Some(person) = document.people.iter().find(|person| {
                person.name == trimmed || person.aliases.iter().any(|alias| alias == trimmed)
            }) {
                person.id.clone()
            } else {
                let id = new_id("person");
                document.people.push(HistoryPerson {
                    id: id.clone(),
                    name: trimmed.chars().take(120).collect(),
                    courtesy_name: String::new(),
                    aliases: Vec::new(),
                    birth_year: None,
                    death_year: None,
                    roles: Vec::new(),
                    affiliations: Vec::new(),
                    biography: String::new(),
                    source: String::new(),
                    created_at: timestamp,
                    updated_at: timestamp,
                });
                id
            };
            if !document.events[event_index].person_ids.contains(&person_id) {
                document.events[event_index].person_ids.push(person_id);
            }
        }
    }
    sync_event_people(document);
}

fn sync_event_people(document: &mut HistoryDocument) {
    for event in &mut document.events {
        event
            .person_ids
            .retain(|id| document.people.iter().any(|person| person.id == *id));
        event.people = event
            .person_ids
            .iter()
            .filter_map(|id| document.people.iter().find(|person| person.id == *id))
            .map(|person| person.name.clone())
            .collect();
    }
}

fn safe_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|character| {
            if character.is_control()
                || character.is_whitespace()
                || "/\\:*?\"<>|.".contains(character)
            {
                '-'
            } else {
                character
            }
        })
        .collect();
    cleaned.trim_matches('-').chars().take(64).collect()
}

fn property<'a>(properties: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| {
        properties.get(*key).or_else(|| {
            properties
                .iter()
                .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                .map(|(_, value)| value)
        })
    })
}

fn property_text(properties: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    property(properties, keys).and_then(|value| match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn parse_year_value(value: &Value) -> Option<i32> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|year| year.fract() == 0.0)
                    .map(|year| year as i64)
            })
            .and_then(|year| i32::try_from(year).ok()),
        Value::String(text) => {
            let trimmed = text.trim();
            if let Ok(year) = trimmed.parse::<i32>() {
                return Some(year);
            }
            let bytes = trimmed.as_bytes();
            let mut end = usize::from(bytes.first() == Some(&b'-'));
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            (end > usize::from(bytes.first() == Some(&b'-')))
                .then(|| trimmed[..end].parse::<i32>().ok())
                .flatten()
        }
        _ => None,
    }
}

#[cfg(test)]
fn property_year(properties: &Map<String, Value>, keys: &[&str]) -> Option<i32> {
    property(properties, keys).and_then(parse_year_value)
}

fn mapped_property<'a>(
    properties: &'a Map<String, Value>,
    selected: Option<&str>,
    fallback: &[&str],
) -> Option<&'a Value> {
    selected
        .filter(|field| !field.trim().is_empty())
        .and_then(|field| property(properties, &[field]))
        .or_else(|| {
            selected
                .is_none()
                .then(|| property(properties, fallback))
                .flatten()
        })
}

fn mapped_text(
    properties: &Map<String, Value>,
    selected: Option<&str>,
    fallback: &[&str],
) -> Option<String> {
    mapped_property(properties, selected, fallback).and_then(|value| match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn mapped_year(
    properties: &Map<String, Value>,
    selected: Option<&str>,
    fallback: &[&str],
) -> Option<i32> {
    mapped_property(properties, selected, fallback).and_then(parse_year_value)
}

const NAME_FIELDS: &[&str] = &[
    "name",
    "name_zh",
    "name_ch",
    "name_chn",
    "placename",
    "label",
    "names",
    "名称",
];
const START_FIELDS: &[&str] = &[
    "validFrom",
    "valid_from",
    "start",
    "start_year",
    "beg_yr",
    "begin",
    "start_date",
    "from_year",
];
const END_FIELDS: &[&str] = &[
    "validTo", "valid_to", "end", "end_year", "end_yr", "finish", "end_date", "to_year",
];
const REGION_ID_FIELDS: &[&str] = &[
    "regionId",
    "region_id",
    "stable_id",
    "bou_id",
    "sys_id",
    "gid",
    "id",
];

fn detect_field(fields: &[String], candidates: &[&str]) -> Option<String> {
    candidates.iter().find_map(|candidate| {
        fields
            .iter()
            .find(|field| field.eq_ignore_ascii_case(candidate))
            .cloned()
    })
}

fn valid_geometry(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| matches!(kind, "Polygon" | "MultiPolygon" | "Point"))
        && value.get("coordinates").is_some()
}

fn palette(index: usize) -> &'static str {
    const COLORS: [&str; 8] = [
        "#B65C4A", "#4F7CAC", "#4B8B72", "#A77835", "#7659A8", "#3F8792", "#9B557A", "#6C7350",
    ];
    COLORS[index % COLORS.len()]
}

fn safe_color(raw: &str, fallback: &str) -> String {
    let candidate = raw.trim();
    let hex = candidate.strip_prefix('#');
    if hex.is_some_and(|value| {
        matches!(value.len(), 3 | 6) && value.chars().all(|character| character.is_ascii_hexdigit())
    }) {
        candidate.to_string()
    } else {
        fallback.to_string()
    }
}

fn validate_declared_crs(geojson: &Value) -> Result<(), String> {
    let Some(crs) = geojson.get("crs") else {
        return Ok(());
    };
    let name = crs
        .get("properties")
        .and_then(|properties| properties.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_uppercase();
    if name.contains("4326") || name.contains("CRS84") {
        Ok(())
    } else {
        Err("该 GeoJSON 声明的坐标系不是 WGS84（EPSG:4326/CRS84）。请先转换后再导入，避免历史边界与真实底图错位。".into())
    }
}

fn validate_source_size(path: &Path) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|error| format!("无法读取地图文件信息：{error}"))?
        .len();
    if size > MAX_SOURCE_BYTES {
        return Err("地图文件超过 512 MB。请按朝代或区域拆分后再导入。".into());
    }
    Ok(())
}

fn validate_coordinate_tree(value: &Value) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    if values.len() >= 2 && values[0].is_number() && values[1].is_number() {
        let longitude = values[0].as_f64().unwrap_or(f64::INFINITY);
        let latitude = values[1].as_f64().unwrap_or(f64::INFINITY);
        return longitude.is_finite()
            && latitude.is_finite()
            && (-180.0..=180.0).contains(&longitude)
            && (-90.0..=90.0).contains(&latitude);
    }
    !values.is_empty() && values.iter().all(validate_coordinate_tree)
}

fn validate_feature_coordinates(features: &[RawMapFeature]) -> Result<(), String> {
    if features.iter().all(|feature| {
        feature
            .geometry
            .get("coordinates")
            .is_some_and(validate_coordinate_tree)
    }) {
        Ok(())
    } else {
        Err(
            "发现超出经纬度范围的坐标。请先把数据转换为 WGS84（EPSG:4326），否则会与真实底图错位。"
                .into(),
        )
    }
}

fn load_geojson(path: &Path) -> Result<LoadedMap, String> {
    validate_source_size(path)?;
    let contents =
        fs::read_to_string(path).map_err(|error| format!("无法读取 GeoJSON：{error}"))?;
    let geojson: Value =
        serde_json::from_str(&contents).map_err(|error| format!("GeoJSON 无法解析：{error}"))?;
    if geojson.get("type").and_then(Value::as_str) != Some("FeatureCollection") {
        return Err("请选择顶层类型为 FeatureCollection 的 GeoJSON。".into());
    }
    validate_declared_crs(&geojson)?;
    let raw_features = geojson
        .get("features")
        .and_then(Value::as_array)
        .ok_or_else(|| "GeoJSON 缺少 features 数组。".to_string())?;
    if raw_features.len() > MAX_IMPORT_FEATURES {
        return Err("地图包含超过 25 万个要素，请拆分后再导入。".into());
    }
    let features = raw_features
        .iter()
        .filter_map(|raw| {
            let geometry = raw.get("geometry").filter(|value| valid_geometry(value))?;
            let raw_id = raw.get("id").and_then(|value| match value {
                Value::String(text) => Some(text.clone()),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            });
            Some(RawMapFeature {
                raw_id,
                geometry: geometry.clone(),
                properties: raw
                    .get("properties")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    validate_feature_coordinates(&features)?;
    Ok(LoadedMap {
        format: "GeoJSON".into(),
        source_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source.geojson")
            .to_string(),
        datasets: Vec::new(),
        selected_dataset: None,
        features,
        warnings: Vec::new(),
    })
}

fn xml_local_name(raw: &[u8]) -> String {
    let name = String::from_utf8_lossy(raw);
    name.rsplit(':').next().unwrap_or(&name).to_string()
}

fn xml_text(event: &quick_xml::events::BytesText<'_>) -> String {
    event
        .decode()
        .ok()
        .and_then(|text| {
            quick_xml::escape::unescape(&text)
                .ok()
                .map(|value| value.into_owned())
        })
        .unwrap_or_default()
}

fn parse_kml_coordinates(raw: &str) -> Vec<Vec<f64>> {
    raw.split_whitespace()
        .filter_map(|tuple| {
            let mut values = tuple.split(',');
            let longitude = values.next()?.trim().parse::<f64>().ok()?;
            let latitude = values.next()?.trim().parse::<f64>().ok()?;
            Some(vec![longitude, latitude])
        })
        .collect()
}

#[derive(Default)]
struct KmlPlacemark {
    name: String,
    properties: Map<String, Value>,
    polygons: Vec<Vec<Vec<Vec<f64>>>>,
    current_polygon: Vec<Vec<Vec<f64>>>,
    point: Option<Vec<f64>>,
    data_field: Option<String>,
}

fn load_kml(path: &Path) -> Result<LoadedMap, String> {
    validate_source_size(path)?;
    let contents = fs::read_to_string(path).map_err(|error| format!("无法读取 KML：{error}"))?;
    let mut reader = XmlReader::from_str(&contents);
    reader.config_mut().trim_text(true);
    let mut stack = Vec::<String>::new();
    let mut placemark: Option<KmlPlacemark> = None;
    let mut features = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let tag = xml_local_name(event.name().as_ref());
                if tag == "Placemark" {
                    placemark = Some(KmlPlacemark::default());
                } else if tag == "Polygon" {
                    if let Some(item) = placemark.as_mut() {
                        item.current_polygon.clear();
                    }
                } else if matches!(tag.as_str(), "Data" | "SimpleData")
                    && let Some(item) = placemark.as_mut()
                {
                    item.data_field = event
                        .attributes()
                        .flatten()
                        .find(|attribute| xml_local_name(attribute.key.as_ref()) == "name")
                        .and_then(|attribute| {
                            attribute
                                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.into_owned());
                }
                stack.push(tag);
            }
            Ok(Event::Text(event)) => {
                let text = xml_text(&event);
                let Some(item) = placemark.as_mut() else {
                    continue;
                };
                let tag = stack.last().map(String::as_str).unwrap_or_default();
                if tag == "name"
                    && stack
                        .iter()
                        .filter(|entry| entry.as_str() == "name")
                        .count()
                        == 1
                {
                    item.name = text;
                } else if tag == "value" || tag == "SimpleData" {
                    if let Some(field) = item.data_field.as_ref() {
                        item.properties.insert(field.clone(), Value::String(text));
                    }
                } else if tag == "coordinates" {
                    let coordinates = parse_kml_coordinates(&text);
                    if stack.iter().any(|entry| entry == "Point") {
                        item.point = coordinates.first().cloned();
                    } else if coordinates.len() >= 3 {
                        item.current_polygon.push(coordinates);
                    }
                }
            }
            Ok(Event::CData(event)) if stack.last().is_some_and(|tag| tag == "coordinates") => {
                if let Some(item) = placemark.as_mut() {
                    let coordinates =
                        parse_kml_coordinates(&String::from_utf8_lossy(event.as_ref()));
                    if stack.iter().any(|entry| entry == "Point") {
                        item.point = coordinates.first().cloned();
                    } else if coordinates.len() >= 3 {
                        item.current_polygon.push(coordinates);
                    }
                }
            }
            Ok(Event::End(event)) => {
                let tag = xml_local_name(event.name().as_ref());
                if tag == "Polygon" {
                    if let Some(item) = placemark.as_mut()
                        && !item.current_polygon.is_empty()
                    {
                        item.polygons
                            .push(std::mem::take(&mut item.current_polygon));
                    }
                } else if tag == "Placemark" {
                    if let Some(mut item) = placemark.take() {
                        if !item.name.is_empty() {
                            item.properties
                                .entry("name")
                                .or_insert_with(|| Value::String(item.name));
                        }
                        let geometry = if item.polygons.len() == 1 {
                            serde_json::json!({
                                "type": "Polygon",
                                "coordinates": item.polygons.remove(0),
                            })
                        } else if !item.polygons.is_empty() {
                            serde_json::json!({
                                "type": "MultiPolygon",
                                "coordinates": item.polygons,
                            })
                        } else if let Some(point) = item.point {
                            serde_json::json!({ "type": "Point", "coordinates": point })
                        } else {
                            Value::Null
                        };
                        if valid_geometry(&geometry) {
                            features.push(RawMapFeature {
                                raw_id: None,
                                geometry,
                                properties: item.properties,
                            });
                        }
                    }
                } else if matches!(tag.as_str(), "Data" | "SimpleData")
                    && let Some(item) = placemark.as_mut()
                {
                    item.data_field = None;
                }
                let _ = stack.pop();
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("KML 无法解析：{error}")),
            _ => {}
        }
    }
    if features.len() > MAX_IMPORT_FEATURES {
        return Err("地图包含超过 25 万个要素，请拆分后再导入。".into());
    }
    validate_feature_coordinates(&features)?;
    Ok(LoadedMap {
        format: "KML".into(),
        source_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source.kml")
            .to_string(),
        datasets: Vec::new(),
        selected_dataset: None,
        features,
        warnings: vec![
            "KML 坐标按 WGS84 处理；样式不会导入，只保留区域、名称和 ExtendedData 字段。".into(),
        ],
    })
}

fn dbf_value(value: FieldValue) -> Value {
    match value {
        FieldValue::Character(Some(value)) | FieldValue::Memo(value) => Value::String(value),
        FieldValue::Character(None)
        | FieldValue::Numeric(None)
        | FieldValue::Logical(None)
        | FieldValue::Date(None)
        | FieldValue::Float(None) => Value::Null,
        FieldValue::Numeric(Some(value))
        | FieldValue::Currency(value)
        | FieldValue::Double(value) => serde_json::Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        FieldValue::Float(Some(value)) => serde_json::Number::from_f64(f64::from(value))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        FieldValue::Logical(Some(value)) => Value::Bool(value),
        FieldValue::Date(Some(value)) => Value::String(value.to_string()),
        FieldValue::Integer(value) => Value::Number(value.into()),
        FieldValue::DateTime(value) => Value::String(format!("{value:?}")),
    }
}

fn polygon_geometry<PointType: HasXY>(rings: &[PolygonRing<PointType>]) -> Option<Value> {
    let mut polygons = Vec::<Vec<Vec<Vec<f64>>>>::new();
    for ring in rings {
        let coordinates = ring
            .points()
            .iter()
            .map(|point| vec![point.x(), point.y()])
            .collect::<Vec<_>>();
        if coordinates.len() < 4 {
            continue;
        }
        match ring {
            PolygonRing::Outer(_) => polygons.push(vec![coordinates]),
            PolygonRing::Inner(_) => {
                if let Some(polygon) = polygons.last_mut() {
                    polygon.push(coordinates);
                } else {
                    // Some real-world writers emit the first ring with the
                    // opposite winding order. Keeping it as an outer ring is
                    // safer than silently dropping the whole administrative area.
                    polygons.push(vec![coordinates]);
                }
            }
        }
    }
    match polygons.len() {
        0 => None,
        1 => Some(serde_json::json!({
            "type": "Polygon",
            "coordinates": polygons.remove(0),
        })),
        _ => Some(serde_json::json!({
            "type": "MultiPolygon",
            "coordinates": polygons,
        })),
    }
}

fn shape_geometry(shape: Shape) -> Option<Value> {
    match shape {
        Shape::Point(point) => Some(serde_json::json!({
            "type": "Point", "coordinates": [point.x, point.y]
        })),
        Shape::PointM(point) => Some(serde_json::json!({
            "type": "Point", "coordinates": [point.x, point.y]
        })),
        Shape::PointZ(point) => Some(serde_json::json!({
            "type": "Point", "coordinates": [point.x, point.y]
        })),
        Shape::Polygon(polygon) => polygon_geometry(polygon.rings()),
        Shape::PolygonM(polygon) => polygon_geometry(polygon.rings()),
        Shape::PolygonZ(polygon) => polygon_geometry(polygon.rings()),
        _ => None,
    }
}

fn validate_shapefile_projection(path: &Path) -> Result<Vec<String>, String> {
    let projection_path = path.with_extension("prj");
    if !projection_path.exists() {
        return Ok(vec![
            "Shapefile 没有 .prj 坐标系文件；当前按 WGS84 试读，请在预览地图上确认没有错位。"
                .into(),
        ]);
    }
    let projection = fs::read_to_string(&projection_path)
        .map_err(|error| format!("无法读取 Shapefile 的 .prj：{error}"))?
        .to_ascii_uppercase();
    let wgs84 = projection.contains("WGS_1984")
        || projection.contains("WGS 84")
        || projection.contains("WGS84")
        || projection.contains("EPSG\",4326")
        || projection.contains("EPSG:4326");
    if projection.contains("PROJCS") || !wgs84 {
        return Err(
            "Shapefile 的 .prj 不是 WGS84 经纬度坐标系。请先在 QGIS 中另存为 EPSG:4326 后再导入。"
                .into(),
        );
    }
    Ok(Vec::new())
}

fn load_shapefile(path: &Path) -> Result<LoadedMap, String> {
    validate_source_size(path)?;
    if !path.with_extension("dbf").exists() {
        return Err("Shapefile 缺少同名 .dbf 属性表；请把 .shp、.dbf、.shx、.prj 放在同一目录，或直接选择包含它们的 ZIP。".into());
    }
    let warnings = validate_shapefile_projection(path)?;
    let mut reader = shapefile::Reader::from_path(path)
        .map_err(|error| format!("无法打开 Shapefile：{error}"))?;
    let mut features = Vec::new();
    for result in reader.iter_shapes_and_records() {
        let (shape, record) = result.map_err(|error| format!("Shapefile 读取失败：{error}"))?;
        let Some(geometry) = shape_geometry(shape) else {
            continue;
        };
        let properties = record
            .into_iter()
            .map(|(name, value)| (name, dbf_value(value)))
            .collect();
        features.push(RawMapFeature {
            raw_id: None,
            geometry,
            properties,
        });
        if features.len() > MAX_IMPORT_FEATURES {
            return Err("地图包含超过 25 万个要素，请拆分后再导入。".into());
        }
    }
    validate_feature_coordinates(&features)?;
    Ok(LoadedMap {
        format: "Shapefile".into(),
        source_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source.shp")
            .to_string(),
        datasets: Vec::new(),
        selected_dataset: None,
        features,
        warnings,
    })
}

fn is_primary_dataset(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "shp" | "geojson" | "json" | "kml"
            )
        })
}

fn is_extractable_map_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "shp" | "shx" | "dbf" | "prj" | "cpg" | "sbn" | "sbx" | "geojson" | "json" | "kml"
            )
        })
}

fn zip_datasets(path: &Path) -> Result<Vec<String>, String> {
    validate_source_size(path)?;
    let file = File::open(path).map_err(|error| format!("无法打开 ZIP：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("ZIP 无法解析：{error}"))?;
    let mut datasets = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 ZIP 条目：{error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        if !entry.is_dir() && is_primary_dataset(&enclosed) {
            datasets.push(enclosed.to_string_lossy().replace('\\', "/"));
        }
    }
    datasets.sort_by_key(|name| {
        let extension = Path::new(name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let priority = match extension.as_str() {
            "shp" => 0,
            "geojson" => 1,
            "kml" => 2,
            "json" => 3,
            _ => 4,
        };
        (priority, name.to_ascii_lowercase())
    });
    datasets.dedup();
    if datasets.is_empty() {
        return Err("ZIP 中没有可导入的 .shp、.geojson、.json 或 .kml 数据集。".into());
    }
    Ok(datasets)
}

fn load_zip(path: &Path, requested_dataset: Option<&str>) -> Result<LoadedMap, String> {
    let datasets = zip_datasets(path)?;
    if let Some(requested) = requested_dataset
        && !datasets.iter().any(|candidate| candidate == requested)
    {
        return Err("ZIP 中找不到所选数据集，请重新选择。".into());
    }
    let temp_path = std::env::temp_dir().join(new_id("nomi-history-import"));
    fs::create_dir_all(&temp_path).map_err(|error| format!("无法创建地图转换临时目录：{error}"))?;
    let _guard = ImportTempDir(temp_path.clone());
    let file = File::open(path).map_err(|error| format!("无法打开 ZIP：{error}"))?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("ZIP 无法解析：{error}"))?;
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 ZIP 条目：{error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        if entry.is_dir() || !is_extractable_map_file(&enclosed) {
            continue;
        }
        extracted_bytes = extracted_bytes.saturating_add(entry.size());
        if extracted_bytes > MAX_SOURCE_BYTES {
            return Err("ZIP 解压后的地图文件超过 512 MB，已停止导入。".into());
        }
        let output_path = temp_path.join(&enclosed);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 ZIP 临时目录：{error}"))?;
        }
        let mut output = File::create(&output_path)
            .map_err(|error| format!("无法转换 ZIP 内的地图文件：{error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("无法解压地图文件：{error}"))?;
        output
            .flush()
            .map_err(|error| format!("无法写入地图临时文件：{error}"))?;
    }
    let candidates = requested_dataset
        .map(|selected| vec![selected.to_string()])
        .unwrap_or_else(|| datasets.clone());
    let mut selected_map = None;
    let mut failures = Vec::new();
    for candidate in candidates {
        match load_non_zip(&temp_path.join(Path::new(&candidate))) {
            Ok(candidate_map) => {
                selected_map = Some((candidate, candidate_map));
                break;
            }
            Err(error) => failures.push(error),
        }
    }
    let (selected, mut loaded) = selected_map.ok_or_else(|| {
        failures
            .into_iter()
            .next()
            .unwrap_or_else(|| "ZIP 中没有可读取的地图数据集。".into())
    })?;
    loaded.format = format!("ZIP · {}", loaded.format);
    loaded.source_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source.zip")
        .to_string();
    loaded.datasets = datasets;
    loaded.selected_dataset = Some(selected);
    Ok(loaded)
}

fn load_non_zip(path: &Path) -> Result<LoadedMap, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "geojson" | "json" => load_geojson(path),
        "kml" => load_kml(path),
        "shp" => load_shapefile(path),
        "gpkg" => Err(
            "暂不直接支持 GeoPackage；请在 QGIS 中导出为 WGS84 GeoJSON，或导出为 Shapefile ZIP。"
                .into(),
        ),
        "tab" => Err(
            "暂不直接支持 MapInfo TAB；请在 QGIS 中导出为 WGS84 GeoJSON，或导出为 Shapefile ZIP。"
                .into(),
        ),
        _ => Err("不支持该地图格式。请选择 GeoJSON、KML、Shapefile（.shp）或 ZIP。".into()),
    }
}

fn load_map_source(path: &Path, dataset: Option<&str>) -> Result<LoadedMap, String> {
    if !path.is_file() {
        return Err("找不到所选地图文件。".into());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        load_zip(path, dataset)
    } else {
        load_non_zip(path)
    }
}

fn field_names(features: &[RawMapFeature]) -> Vec<String> {
    let mut names = BTreeSet::new();
    for feature in features.iter().take(2_000) {
        names.extend(feature.properties.keys().cloned());
    }
    names.into_iter().collect()
}

fn inspect_loaded(loaded: LoadedMap) -> HistoryImportInspection {
    let fields = field_names(&loaded.features);
    let detected_name_field = detect_field(&fields, NAME_FIELDS);
    let detected_start_field = detect_field(&fields, START_FIELDS);
    let detected_end_field = detect_field(&fields, END_FIELDS);
    let detected_region_id_field = detect_field(&fields, REGION_ID_FIELDS);
    let temporal_feature_count = loaded
        .features
        .iter()
        .filter(|feature| {
            detected_start_field
                .as_deref()
                .is_some_and(|field| mapped_year(&feature.properties, Some(field), &[]).is_some())
                || detected_end_field.as_deref().is_some_and(|field| {
                    mapped_year(&feature.properties, Some(field), &[]).is_some()
                })
        })
        .count();
    HistoryImportInspection {
        format: loaded.format,
        source_name: loaded.source_name,
        datasets: loaded.datasets,
        selected_dataset: loaded.selected_dataset,
        feature_count: loaded.features.len(),
        fields,
        detected_name_field,
        detected_start_field,
        detected_end_field,
        detected_region_id_field,
        temporal_feature_count,
        warnings: loaded.warnings,
    }
}

fn preserve_source(
    app: &AppHandle,
    source: &Path,
    layer_name: &str,
    id: &str,
) -> Result<String, String> {
    let imports = root(app)?.join(IMPORTS_DIR);
    let suffix = &id[id.len().saturating_sub(8)..];
    let base = format!("{}-{suffix}", safe_stem(layer_name));
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("data")
        .to_ascii_lowercase();
    if extension == "shp" {
        let destination = imports.join(&base);
        fs::create_dir_all(&destination)
            .map_err(|error| format!("无法保存 Shapefile 源文件：{error}"))?;
        for sidecar in ["shp", "shx", "dbf", "prj", "cpg", "sbn", "sbx"] {
            let candidate = source.with_extension(sidecar);
            if candidate.is_file() {
                let file_name = candidate
                    .file_name()
                    .ok_or_else(|| "Shapefile 文件名无效。".to_string())?;
                fs::copy(&candidate, destination.join(file_name))
                    .map_err(|error| format!("无法保存 Shapefile 源文件：{error}"))?;
            }
        }
        Ok(base)
    } else {
        let stored_name = format!("{base}.{extension}");
        fs::copy(source, imports.join(&stored_name))
            .map_err(|error| format!("无法保存导入源文件：{error}"))?;
        Ok(stored_name)
    }
}

#[tauri::command]
pub fn history_load(app: AppHandle) -> Result<HistoryDocument, String> {
    load(&app)
}

#[tauri::command]
pub fn history_inspect_import(
    source_path: String,
    dataset: Option<String>,
) -> Result<HistoryImportInspection, String> {
    let source = PathBuf::from(source_path.trim());
    let loaded = load_map_source(&source, dataset.as_deref())?;
    if loaded.features.is_empty() {
        return Err("文件中没有可用的 Polygon、MultiPolygon 或 Point 要素。".into());
    }
    Ok(inspect_loaded(loaded))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn history_import_map(
    app: AppHandle,
    source_path: String,
    dataset: Option<String>,
    layer_name: String,
    default_from: Option<i32>,
    default_to: Option<i32>,
    attribution: String,
    name_field: Option<String>,
    start_field: Option<String>,
    end_field: Option<String>,
    region_id_field: Option<String>,
) -> Result<HistoryDocument, String> {
    let source = PathBuf::from(source_path.trim());
    let loaded = load_map_source(&source, dataset.as_deref())?;

    let mut document = load(&app)?;
    let id = new_id("layer");
    let name = if layer_name.trim().is_empty() {
        source
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("历史区域")
            .to_string()
    } else {
        layer_name.trim().chars().take(80).collect()
    };
    let color = palette(document.layers.len()).to_string();
    let from_fallback = default_from.unwrap_or(MIN_YEAR).clamp(MIN_YEAR, MAX_YEAR);
    let to_fallback = default_to.unwrap_or(MAX_YEAR).clamp(MIN_YEAR, MAX_YEAR);
    if from_fallback > to_fallback {
        return Err("默认开始年份不能晚于结束年份。".into());
    }

    let mut imported = Vec::new();
    for (index, raw) in loaded.features.into_iter().enumerate() {
        let properties = raw.properties;
        let feature_id = new_id("feature");
        let region_id = raw
            .raw_id
            .or_else(|| mapped_text(&properties, region_id_field.as_deref(), REGION_ID_FIELDS))
            .unwrap_or_else(|| format!("{id}:{index}"));
        let feature_name = mapped_text(&properties, name_field.as_deref(), NAME_FIELDS)
            .unwrap_or_else(|| format!("未命名区域 {}", index + 1));
        let valid_from = mapped_year(&properties, start_field.as_deref(), START_FIELDS)
            .unwrap_or(from_fallback)
            .clamp(MIN_YEAR, MAX_YEAR);
        let valid_to = mapped_year(&properties, end_field.as_deref(), END_FIELDS)
            .unwrap_or(to_fallback)
            .clamp(MIN_YEAR, MAX_YEAR);
        if valid_from > valid_to {
            continue;
        }
        imported.push(HistoryFeature {
            id: feature_id,
            region_id,
            layer_id: id.clone(),
            name: feature_name,
            kind: property_text(
                &properties,
                &[
                    "kind",
                    "type_name",
                    "feature_type",
                    "type_py",
                    "type_zh",
                    "ftype",
                    "type",
                ],
            )
            .unwrap_or_else(|| "行政区域".into()),
            valid_from,
            valid_to,
            color: safe_color(
                property_text(&properties, &["color", "fill", "fill_color"])
                    .as_deref()
                    .unwrap_or_default(),
                &color,
            ),
            source: property_text(
                &properties,
                &["source", "citation", "reference", "geo_src", "bou_source"],
            )
            .unwrap_or_else(|| attribution.trim().to_string()),
            confidence: property_text(&properties, &["confidence", "certainty"])
                .unwrap_or_else(default_confidence),
            geometry: raw.geometry,
            properties,
        });
    }
    if imported.is_empty() {
        return Err("文件中没有可用的 Polygon、MultiPolygon 或 Point 要素。".into());
    }

    let stored_name = preserve_source(&app, &source, &name, &id)?;
    document.layers.push(HistoryLayer {
        id: id.clone(),
        name,
        source_file: format!("{} · {stored_name}", loaded.source_name),
        imported_at: now_secs(),
        feature_count: imported.len(),
        color,
        visible: true,
        attribution: attribution.trim().to_string(),
    });
    document.features.extend(imported);
    if document.layers.len() == 1 {
        let first_year = document
            .features
            .iter()
            .map(|feature| feature.valid_from)
            .filter(|year| *year > MIN_YEAR)
            .min()
            .unwrap_or(default_year());
        document.settings.current_year = first_year;
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_update_layer(
    app: AppHandle,
    input: UpdateHistoryLayerInput,
) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    let layer = document
        .layers
        .iter_mut()
        .find(|layer| layer.id == input.id)
        .ok_or_else(|| "历史图层不存在。".to_string())?;
    let old_color = layer.color.clone();
    let next_color = safe_color(&input.color, &old_color);
    layer.name = input.name.trim().chars().take(80).collect();
    layer.color = next_color.clone();
    layer.visible = input.visible;
    layer.attribution = input.attribution.trim().to_string();
    for feature in document
        .features
        .iter_mut()
        .filter(|feature| feature.layer_id == input.id)
    {
        if feature.color.is_empty() || feature.color == old_color {
            feature.color = next_color.clone();
        }
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_update_feature(
    app: AppHandle,
    input: UpdateHistoryFeatureInput,
) -> Result<HistoryDocument, String> {
    if input.valid_from > input.valid_to {
        return Err("开始年份不能晚于结束年份。".into());
    }
    let mut document = load(&app)?;
    let feature = document
        .features
        .iter_mut()
        .find(|feature| feature.id == input.id)
        .ok_or_else(|| "历史区域不存在。".to_string())?;
    feature.name = input.name.trim().chars().take(100).collect();
    feature.kind = input.kind.trim().chars().take(60).collect();
    feature.valid_from = input.valid_from.clamp(MIN_YEAR, MAX_YEAR);
    feature.valid_to = input.valid_to.clamp(MIN_YEAR, MAX_YEAR);
    feature.color = safe_color(&input.color, &feature.color);
    feature.source = input.source.trim().chars().take(500).collect();
    feature.confidence = input.confidence.trim().chars().take(30).collect();
    save(&app, &document)?;
    Ok(document)
}

fn clean_list(values: Vec<String>, max_items: usize, max_chars: usize) -> Vec<String> {
    let mut cleaned = Vec::new();
    for value in values {
        let value = value.trim().chars().take(max_chars).collect::<String>();
        if !value.is_empty() && !cleaned.contains(&value) {
            cleaned.push(value);
        }
        if cleaned.len() >= max_items {
            break;
        }
    }
    cleaned
}

#[tauri::command]
pub fn history_save_event(
    app: AppHandle,
    input: SaveHistoryEventInput,
) -> Result<HistoryDocument, String> {
    let title = input.title.trim().chars().take(120).collect::<String>();
    if title.is_empty() {
        return Err("事件标题不能为空。".into());
    }
    let start_year = input.start_year.clamp(MIN_YEAR, MAX_YEAR);
    let end_year = input.end_year.clamp(MIN_YEAR, MAX_YEAR);
    if start_year > end_year {
        return Err("事件开始年份不能晚于结束年份。".into());
    }
    let mut document = load(&app)?;
    let timestamp = now_secs();
    let mut person_ids = clean_list(input.person_ids, 200, 160);
    person_ids.retain(|id| document.people.iter().any(|person| person.id == *id));
    for legacy_name in clean_list(input.people, 100, 120) {
        let person_id = if let Some(person) = document.people.iter().find(|person| {
            person.name == legacy_name || person.aliases.iter().any(|alias| alias == &legacy_name)
        }) {
            person.id.clone()
        } else {
            let id = new_id("person");
            document.people.push(HistoryPerson {
                id: id.clone(),
                name: legacy_name,
                courtesy_name: String::new(),
                aliases: Vec::new(),
                birth_year: None,
                death_year: None,
                roles: Vec::new(),
                affiliations: Vec::new(),
                biography: String::new(),
                source: String::new(),
                created_at: timestamp,
                updated_at: timestamp,
            });
            id
        };
        if !person_ids.contains(&person_id) {
            person_ids.push(person_id);
        }
    }
    let event = HistoryEvent {
        id: input.id.clone().unwrap_or_else(|| new_id("event")),
        title,
        summary: input.summary.trim().chars().take(4_000).collect(),
        start_year,
        end_year,
        location: input.location.trim().chars().take(160).collect(),
        region_ids: clean_list(input.region_ids, 100, 160),
        person_ids,
        people: Vec::new(),
        tags: clean_list(input.tags, 30, 50),
        source: input.source.trim().chars().take(2_000).collect(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    if let Some(id) = input.id {
        let existing = document
            .events
            .iter_mut()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| "历史事件不存在。".to_string())?;
        let created_at = existing.created_at;
        *existing = HistoryEvent {
            created_at,
            ..event
        };
    } else {
        document.events.push(event);
    }
    document
        .events
        .sort_by_key(|candidate| (candidate.start_year, candidate.end_year));
    sync_event_people(&mut document);
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_delete_event(app: AppHandle, id: String) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    let before = document.events.len();
    document.events.retain(|event| event.id != id);
    if document.events.len() == before {
        return Err("历史事件不存在。".into());
    }
    for relation in &mut document.relations {
        relation.event_ids.retain(|event_id| event_id != &id);
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_save_person(
    app: AppHandle,
    input: SaveHistoryPersonInput,
) -> Result<HistoryDocument, String> {
    let name = input.name.trim().chars().take(120).collect::<String>();
    if name.is_empty() {
        return Err("人物姓名不能为空。".into());
    }
    let birth_year = input.birth_year.map(|year| year.clamp(MIN_YEAR, MAX_YEAR));
    let death_year = input.death_year.map(|year| year.clamp(MIN_YEAR, MAX_YEAR));
    if birth_year
        .zip(death_year)
        .is_some_and(|(birth, death)| birth > death)
    {
        return Err("人物生年不能晚于卒年。".into());
    }
    let mut document = load(&app)?;
    if document
        .people
        .iter()
        .any(|person| person.name == name && input.id.as_ref().is_none_or(|id| person.id != *id))
    {
        return Err("人物库中已经有同名人物；可在别名中补充字号，或编辑已有档案。".into());
    }
    let timestamp = now_secs();
    let person = HistoryPerson {
        id: input.id.clone().unwrap_or_else(|| new_id("person")),
        name,
        courtesy_name: input.courtesy_name.trim().chars().take(120).collect(),
        aliases: clean_list(input.aliases, 30, 120),
        birth_year,
        death_year,
        roles: clean_list(input.roles, 50, 120),
        affiliations: clean_list(input.affiliations, 50, 120),
        biography: input.biography.trim().chars().take(8_000).collect(),
        source: input.source.trim().chars().take(4_000).collect(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    if let Some(id) = input.id {
        let existing = document
            .people
            .iter_mut()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| "人物不存在。".to_string())?;
        let created_at = existing.created_at;
        *existing = HistoryPerson {
            created_at,
            ..person
        };
    } else {
        document.people.push(person);
    }
    document
        .people
        .sort_by(|left, right| left.name.cmp(&right.name));
    sync_event_people(&mut document);
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_delete_person(app: AppHandle, id: String) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    let before = document.people.len();
    document.people.retain(|person| person.id != id);
    if document.people.len() == before {
        return Err("人物不存在。".into());
    }
    document
        .relations
        .retain(|relation| relation.from_person_id != id && relation.to_person_id != id);
    sync_event_people(&mut document);
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_save_relation(
    app: AppHandle,
    input: SaveHistoryRelationInput,
) -> Result<HistoryDocument, String> {
    if input.from_person_id == input.to_person_id {
        return Err("人物关系的两端不能是同一个人。".into());
    }
    let mut document = load(&app)?;
    if !document
        .people
        .iter()
        .any(|person| person.id == input.from_person_id)
        || !document
            .people
            .iter()
            .any(|person| person.id == input.to_person_id)
    {
        return Err("关系中的人物不存在。".into());
    }
    let start_year = input.start_year.map(|year| year.clamp(MIN_YEAR, MAX_YEAR));
    let end_year = input.end_year.map(|year| year.clamp(MIN_YEAR, MAX_YEAR));
    if start_year
        .zip(end_year)
        .is_some_and(|(start, end)| start > end)
    {
        return Err("关系开始年份不能晚于结束年份。".into());
    }
    let mut event_ids = clean_list(input.event_ids, 200, 160);
    event_ids.retain(|id| document.events.iter().any(|event| event.id == *id));
    let timestamp = now_secs();
    let relation = HistoryPersonRelation {
        id: input.id.clone().unwrap_or_else(|| new_id("relation")),
        from_person_id: input.from_person_id,
        to_person_id: input.to_person_id,
        kind: input.kind.trim().chars().take(80).collect(),
        label: input.label.trim().chars().take(120).collect(),
        start_year,
        end_year,
        event_ids,
        summary: input.summary.trim().chars().take(4_000).collect(),
        source: input.source.trim().chars().take(4_000).collect(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    if let Some(id) = input.id {
        let existing = document
            .relations
            .iter_mut()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| "人物关系不存在。".to_string())?;
        let created_at = existing.created_at;
        *existing = HistoryPersonRelation {
            created_at,
            ..relation
        };
    } else {
        document.relations.push(relation);
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_delete_relation(app: AppHandle, id: String) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    let before = document.relations.len();
    document.relations.retain(|relation| relation.id != id);
    if document.relations.len() == before {
        return Err("人物关系不存在。".into());
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_create_version(
    app: AppHandle,
    feature_id: String,
    effective_year: i32,
) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    let index = document
        .features
        .iter()
        .position(|feature| feature.id == feature_id)
        .ok_or_else(|| "历史区域不存在。".to_string())?;
    let current = document.features[index].clone();
    if effective_year <= current.valid_from || effective_year > current.valid_to {
        return Err("新版本年份必须位于当前版本的有效期内，并晚于开始年份。".into());
    }
    document.features[index].valid_to = effective_year - 1;
    let mut next = current;
    next.id = new_id("feature");
    next.valid_from = effective_year;
    next.properties.insert(
        "nomi_version_created".into(),
        Value::String("manual".into()),
    );
    document.features.push(next);
    if let Some(layer) = document
        .layers
        .iter_mut()
        .find(|layer| layer.id == document.features[index].layer_id)
    {
        layer.feature_count += 1;
    }
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_delete_layer(app: AppHandle, id: String) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    if !document.layers.iter().any(|layer| layer.id == id) {
        return Err("历史图层不存在。".into());
    }
    document.layers.retain(|layer| layer.id != id);
    document.features.retain(|feature| feature.layer_id != id);
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_set_settings(
    app: AppHandle,
    settings: HistorySettings,
) -> Result<HistoryDocument, String> {
    let mut document = load(&app)?;
    document.settings = HistorySettings {
        current_year: settings.current_year.clamp(MIN_YEAR, MAX_YEAR),
        basemap: settings.basemap,
    };
    save(&app, &document)?;
    Ok(document)
}

#[tauri::command]
pub fn history_reveal(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(new_id(&format!("nomi-history-test-{label}")));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_common_temporal_fields() {
        let mut properties = Map::new();
        properties.insert("start_date".into(), Value::String("-0207-01-01".into()));
        properties.insert("end_year".into(), Value::Number(220.into()));
        assert_eq!(property_year(&properties, &["start_date"]), Some(-207));
        assert_eq!(property_year(&properties, &["end_year"]), Some(220));
    }

    #[test]
    fn safe_import_names_cannot_escape_the_workspace() {
        assert_eq!(safe_stem("../扬州 map"), "扬州-map");
    }

    #[test]
    fn imported_colors_are_restricted_to_plain_hex() {
        assert_eq!(safe_color("#aB12ef", "#000000"), "#aB12ef");
        assert_eq!(safe_color("red\" onload=\"alert(1)", "#123456"), "#123456");
    }

    #[test]
    fn rejects_a_declared_non_wgs84_projection() {
        let geojson = serde_json::json!({
            "crs": { "properties": { "name": "EPSG:3857" } }
        });
        assert!(validate_declared_crs(&geojson).is_err());
    }

    #[test]
    fn older_history_documents_gain_empty_people_and_relation_lists() {
        let document: HistoryDocument = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "settings": { "currentYear": 200, "basemap": "online" },
            "layers": [],
            "features": []
        }))
        .unwrap();
        assert!(document.events.is_empty());
        assert!(document.people.is_empty());
        assert!(document.relations.is_empty());
    }

    #[test]
    fn legacy_event_names_migrate_to_reusable_people() {
        let mut document: HistoryDocument = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "settings": { "currentYear": 200, "basemap": "online" },
            "layers": [],
            "features": [],
            "events": [{
                "id": "event-1",
                "title": "官渡之战",
                "summary": "",
                "startYear": 200,
                "endYear": 200,
                "location": "官渡",
                "regionIds": [],
                "people": ["曹操", "袁绍", "曹操"],
                "tags": [],
                "source": "",
                "createdAt": 1,
                "updatedAt": 1
            }]
        }))
        .unwrap();
        migrate_people(&mut document);
        assert_eq!(document.people.len(), 2);
        assert_eq!(document.events[0].person_ids.len(), 2);
        assert_eq!(document.events[0].people, vec!["曹操", "袁绍"]);
    }

    #[test]
    fn reads_kml_extended_time_fields() {
        let directory = temp_test_dir("kml");
        let path = directory.join("yangzhou.kml");
        fs::write(
            &path,
            r#"<?xml version="1.0" encoding="UTF-8"?>
            <kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
              <name>扬州</name><ExtendedData>
                <Data name="beg_yr"><value>194</value></Data>
                <Data name="end_yr"><value>280</value></Data>
              </ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>
                118,31 120,31 120,33 118,31
              </coordinates></LinearRing></outerBoundaryIs></Polygon>
            </Placemark></Document></kml>"#,
        )
        .unwrap();
        let inspection = inspect_loaded(load_kml(&path).unwrap());
        assert_eq!(inspection.feature_count, 1);
        assert_eq!(inspection.detected_start_field.as_deref(), Some("beg_yr"));
        assert_eq!(inspection.detected_end_field.as_deref(), Some("end_yr"));
        assert_eq!(inspection.temporal_feature_count, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reads_wgs84_shapefile_and_dbf_fields() {
        use shapefile::{Point, Polygon, Writer, dbase::TableWriterBuilder};

        let directory = temp_test_dir("shapefile");
        let path = directory.join("boundaries.shp");
        let table = TableWriterBuilder::new()
            .add_character_field("name".try_into().unwrap(), 40)
            .add_numeric_field("beg_yr".try_into().unwrap(), 8, 0)
            .add_numeric_field("end_yr".try_into().unwrap(), 8, 0);
        let polygon = Polygon::new(PolygonRing::Outer(vec![
            Point::new(118.0, 31.0),
            Point::new(120.0, 31.0),
            Point::new(120.0, 33.0),
            Point::new(118.0, 31.0),
        ]));
        let mut record = shapefile::dbase::Record::default();
        record.insert(
            "name".into(),
            FieldValue::Character(Some("Yangzhou".into())),
        );
        record.insert("beg_yr".into(), FieldValue::Numeric(Some(194.0)));
        record.insert("end_yr".into(), FieldValue::Numeric(Some(280.0)));
        {
            let mut writer = Writer::from_path(&path, table).unwrap();
            writer.write_shape_and_record(&polygon, &record).unwrap();
        }
        fs::write(
            path.with_extension("prj"),
            r#"GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984"],UNIT["Degree",0.0174532925199433]]"#,
        )
        .unwrap();
        let inspection = inspect_loaded(load_shapefile(&path).unwrap());
        assert_eq!(inspection.feature_count, 1);
        assert_eq!(inspection.detected_name_field.as_deref(), Some("name"));
        assert_eq!(inspection.detected_start_field.as_deref(), Some("beg_yr"));
        assert_eq!(inspection.temporal_feature_count, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn zip_import_prefers_geojson_over_unrelated_json() {
        use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

        let directory = temp_test_dir("zip");
        let path = directory.join("download.zip");
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        {
            let mut writer = ZipWriter::new(File::create(&path).unwrap());
            writer.start_file("metadata.json", options).unwrap();
            writer.write_all(br#"{"title":"not a map"}"#).unwrap();
            writer.start_file("maps/regions.geojson", options).unwrap();
            writer
                .write_all(
                    r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"扬州","beg_yr":194},"geometry":{"type":"Point","coordinates":[119,32]}}]}"#
                        .as_bytes(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        let loaded = load_zip(&path, None).unwrap();
        assert_eq!(
            loaded.selected_dataset.as_deref(),
            Some("maps/regions.geojson")
        );
        assert_eq!(loaded.datasets.len(), 2);
        assert_eq!(loaded.features.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
