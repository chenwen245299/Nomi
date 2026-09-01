//! Travel: geotagged Markdown trip notes (category · rating · coordinates), trip
//! plans, and downloadable offline basemaps. Persistence lives in [`store`] and
//! [`maps`]; this module owns the shared serde types and the Tauri commands.

mod maps;
mod store;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ── Shared types ──────────────────────────────────────────────────────────────

/// A travel note's metadata (the Markdown body is stored beside it). Coordinates
/// are WGS-84; `rating` is 0 (unrated) through 5.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TravelNote {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub date: String,
    pub created_at: u64,
    pub updated_at: u64,
}

/// The editable fields of a note, sent whole on create and on metadata save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub date: String,
}

/// A stored inline image (mirrors the notes module).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub rel_path: String,
    pub data_url: String,
}

/// One stop in a trip plan. Coordinates are optional so a stop can be a plain
/// to-do ("book train tickets") or a place pinned on the map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStop {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    /// 1-based day within the trip (0 = unscheduled).
    #[serde(default)]
    pub day: u32,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TravelPlan {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub stops: Vec<PlanStop>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub stops: Vec<PlanStop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TravelSettings {
    #[serde(default)]
    pub schema_version: u32,
    /// "online" (Protomaps hosted) or the name of a downloaded offline map.
    #[serde(default)]
    pub basemap: String,
    #[serde(default)]
    pub categories: Vec<String>,
}

// ── Commands: notes ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn travel_list_notes(app: AppHandle) -> Result<Vec<TravelNote>, String> {
    store::list_notes(&app)
}

#[tauri::command]
pub fn travel_create_note(app: AppHandle, input: NoteInput) -> Result<TravelNote, String> {
    store::create_note(&app, input)
}

#[tauri::command]
pub fn travel_read_note(app: AppHandle, id: String) -> Result<String, String> {
    store::read_note(&app, &id)
}

#[tauri::command]
pub fn travel_save_note(app: AppHandle, id: String, content: String) -> Result<(), String> {
    store::save_note(&app, &id, &content)
}

#[tauri::command]
pub fn travel_update_note(
    app: AppHandle,
    id: String,
    input: NoteInput,
) -> Result<TravelNote, String> {
    store::update_note(&app, &id, input)
}

#[tauri::command]
pub fn travel_delete_note(app: AppHandle, id: String) -> Result<(), String> {
    store::delete_note(&app, &id)
}

#[tauri::command]
pub fn travel_save_note_image(
    app: AppHandle,
    id: String,
    name: String,
    data_base64: String,
) -> Result<SavedImage, String> {
    store::save_note_image(&app, &id, &name, &data_base64)
}

#[tauri::command]
pub fn travel_read_note_assets(
    app: AppHandle,
    id: String,
    rel_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    store::read_note_assets(&app, &id, &rel_paths)
}

#[tauri::command]
pub fn travel_reveal(app: AppHandle, id: Option<String>) -> Result<String, String> {
    store::reveal_path(&app, id.as_deref())
}

// ── Commands: plans ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn travel_list_plans(app: AppHandle) -> Result<Vec<TravelPlan>, String> {
    store::list_plans(&app)
}

#[tauri::command]
pub fn travel_create_plan(app: AppHandle, input: PlanInput) -> Result<TravelPlan, String> {
    store::create_plan(&app, input)
}

#[tauri::command]
pub fn travel_save_plan(app: AppHandle, plan: TravelPlan) -> Result<TravelPlan, String> {
    store::save_plan(&app, plan)
}

#[tauri::command]
pub fn travel_delete_plan(app: AppHandle, id: String) -> Result<(), String> {
    store::delete_plan(&app, &id)
}

// ── Commands: settings ────────────────────────────────────────────────────────

#[tauri::command]
pub fn travel_get_settings(app: AppHandle) -> Result<TravelSettings, String> {
    store::read_settings(&app)
}

#[tauri::command]
pub fn travel_set_settings(
    app: AppHandle,
    settings: TravelSettings,
) -> Result<TravelSettings, String> {
    store::write_settings(&app, settings)
}

// ── Commands: offline maps ────────────────────────────────────────────────────

#[tauri::command]
pub fn travel_list_maps(app: AppHandle) -> Result<Vec<maps::OfflineMap>, String> {
    maps::list_maps(&app)
}

#[tauri::command]
pub fn travel_import_map(
    app: AppHandle,
    name: String,
    source_path: String,
) -> Result<maps::OfflineMap, String> {
    maps::import_map(&app, &name, &source_path)
}

#[tauri::command]
pub async fn travel_download_map(
    app: AppHandle,
    name: String,
    url: String,
) -> Result<maps::OfflineMap, String> {
    maps::download_map(app, name, url).await
}

#[tauri::command]
pub async fn travel_update_map(app: AppHandle, name: String) -> Result<maps::OfflineMap, String> {
    maps::update_map(app, name).await
}

#[tauri::command]
pub fn travel_delete_map(app: AppHandle, name: String) -> Result<(), String> {
    maps::delete_map(&app, &name)
}

#[tauri::command]
pub fn travel_map_read_range(
    app: AppHandle,
    name: String,
    offset: u64,
    length: u32,
) -> Result<String, String> {
    maps::read_range(&app, &name, offset, length)
}

#[tauri::command]
pub fn travel_reveal_maps(app: AppHandle) -> Result<String, String> {
    maps::reveal_maps(&app)
}
