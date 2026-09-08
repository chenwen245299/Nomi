use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use crate::storage;

// Per-provider behaviour lives one file per provider under `providers/`. This
// module stays the registry / encrypted key store / CRUD surface and dispatches
// provider-specific work (balance, and the chat-runtime seams in `crate::llm` /
// `crate::chat_agent`) through `spec::ProviderSpec`.
pub(crate) mod spec;

mod deepseek;
mod generic;
mod mimo;
mod minimax;
mod openrouter;
mod qwen;
mod zhipu;

pub(crate) use spec::{ProviderBalance, ProviderSpec, spec_for};

const CONFIG_DIR: &str = ".nomi";
const PROVIDERS_FILE: &str = "providers.json";
// API keys are encrypted (AES-256-GCM) into `.nomi/api_keys.json`, keyed by
// provider id, using a random 32-byte master key in `.nomi/.keymaster`.
const MASTER_KEY_FILE: &str = ".keymaster";
const API_KEYS_FILE: &str = "api_keys.json";

// Provider metadata lives in <data folder>/.nomi/providers.json. The API KEY is
// NEVER stored there — it is encrypted at rest into `.nomi/api_keys.json`. We use
// an app-managed encrypted file rather than the OS keychain because the keychain
// re-prompts for permission on every unsigned/dev rebuild (its ACL is bound to
// the code signature). The master key sits beside the ciphertext, so this guards
// against casually copying the data folder, not against local machine access.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PricingTimeRange {
    pub(crate) start_hour: u8,
    pub(crate) end_hour: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedProviderModel {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) category: String,
    pub(crate) context_length: Option<u64>,
    pub(crate) input_modalities: Vec<String>,
    pub(crate) output_modalities: Vec<String>,
}

impl PricingTimeRange {
    pub(crate) fn contains_hour(&self, hour: u8) -> Option<bool> {
        if self.start_hour > 23 || self.end_hour > 24 || self.start_hour == self.end_hour {
            return None;
        }
        Some(if self.start_hour < self.end_hour {
            hour >= self.start_hour && hour < self.end_hour
        } else {
            hour >= self.start_hour || hour < self.end_hour
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    id: String,
    name: String,
    #[serde(default)]
    capabilities: Vec<String>, // "audio" | "video" | "image" | "tool" | "reasoning"
    /// Primary modality: "text" | "vision" | "image" | "audio" | "video" | "embedding".
    #[serde(default)]
    category: String,
    #[serde(default)]
    size: String,
    #[serde(default)]
    starred: bool,
    #[serde(default)]
    context_length: Option<u64>,
    /// Provider-reported modalities, when its model catalogue publishes them.
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    output_modalities: Vec<String>,
    /// User-maintained CNY prices per one million tokens.
    #[serde(default)]
    input_price: Option<f64>,
    #[serde(default)]
    output_price: Option<f64>,
    #[serde(default)]
    cache_hit_input_price: Option<f64>,
    /// Optional time-of-use pricing. The base prices are the off-peak prices.
    #[serde(default)]
    peak_pricing_enabled: bool,
    #[serde(default)]
    peak_input_price: Option<f64>,
    #[serde(default)]
    peak_output_price: Option<f64>,
    #[serde(default)]
    peak_cache_hit_input_price: Option<f64>,
    /// Whole-hour windows in China Standard Time; ranges may cross midnight.
    #[serde(default)]
    peak_time_ranges: Vec<PricingTimeRange>,
    /// Legacy single-window fields, retained for existing providers.json files.
    #[serde(default)]
    peak_start_hour: Option<u8>,
    #[serde(default)]
    peak_end_hour: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    id: String,
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    models: Vec<ProviderModel>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    #[serde(flatten)]
    provider: Provider,
    has_key: bool,
    /// Whether this provider publishes an account balance, derived from its
    /// [`ProviderSpec`]. Lets the webview show/hide the balance UI without a
    /// network probe, and keeps the "which providers have a balance" answer in
    /// one place (the per-provider modules) instead of hardcoded in the frontend.
    supports_balance: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(CONFIG_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    Ok(dir)
}

fn providers_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(PROVIDERS_FILE))
}

fn read_providers(app: &AppHandle) -> Result<Vec<Provider>, String> {
    let path = providers_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| format!("无法解析 providers.json：{error}"))
}

fn write_providers(app: &AppHandle, providers: &[Provider]) -> Result<(), String> {
    let path = providers_path(app)?;
    let mut contents =
        serde_json::to_string_pretty(providers).map_err(|error| error.to_string())?;
    contents.push('\n');
    fs::write(&path, contents).map_err(|error| error.to_string())
}

fn is_chat_model(model: &ProviderModel) -> bool {
    let produces_text = model.output_modalities.is_empty()
        || model
            .output_modalities
            .iter()
            .any(|modality| modality == "text");
    produces_text && !matches!(model.category.as_str(), "embedding" | "audio" | "video" | "image")
}

/// Keep at most one starred model across every provider. With no explicit
/// target this also repairs legacy files that contain multiple starred models,
/// retaining the first one in provider/model order.
fn enforce_single_default(providers: &mut [Provider], target: Option<(&str, &str)>) -> bool {
    let mut kept_legacy_default = false;
    let mut changed = false;
    for provider in providers {
        for model in &mut provider.models {
            let should_star = match target {
                Some((provider_id, model_id)) => provider.id == provider_id && model.id == model_id,
                None => {
                    let keep = model.starred && !kept_legacy_default;
                    if keep {
                        kept_legacy_default = true;
                    }
                    keep
                }
            };
            if model.starred != should_star {
                model.starred = should_star;
                changed = true;
            }
        }
    }
    changed
}

/// Global fallback used whenever a chat/assistant scope has no model override.
pub(crate) fn default_chat_model(app: &AppHandle) -> Result<Option<(String, String)>, String> {
    let providers = read_providers(app)?;
    Ok(providers
        .iter()
        .filter(|provider| provider.enabled)
        .find_map(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.starred && is_chat_model(model))
                .map(|model| (provider.id.clone(), model.id.clone()))
        }))
}

// ── Encrypted key store ──────────────────────────────────────────────────────

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("十六进制长度非偶数。".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// Best-effort owner-only permissions on the key files (Unix).
fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Load (or create on first use) the random 32-byte master key.
fn master_key(app: &AppHandle) -> Result<[u8; 32], String> {
    master_key_in(&config_dir(app)?)
}

fn master_key_in(config_dir: &Path) -> Result<[u8; 32], String> {
    let path = config_dir.join(MASTER_KEY_FILE);
    if path.exists() {
        let bytes = from_hex(fs::read_to_string(&path).map_err(|e| e.to_string())?.trim())?;
        if bytes.len() != 32 {
            return Err("主密钥已损坏。".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        Ok(key)
    } else {
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        fs::write(&path, to_hex(&key)).map_err(|e| format!("写入主密钥失败：{e}"))?;
        restrict(&path);
        Ok(key)
    }
}

fn read_keys_map(app: &AppHandle) -> HashMap<String, String> {
    config_dir(app)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join(API_KEYS_FILE)).ok())
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn write_keys_map(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    let path = config_dir(app)?.join(API_KEYS_FILE);
    let contents = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    fs::write(&path, contents).map_err(|e| format!("写入密钥文件失败：{e}"))?;
    restrict(&path);
    Ok(())
}

/// Encrypt and store one provider's API key.
pub(crate) fn save_key(app: &AppHandle, id: &str, key: &str) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(&master_key(app)?).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), key.as_bytes())
        .map_err(|e| format!("加密密钥失败：{e}"))?;
    let encoded = format!("{}:{}", to_hex(&nonce_bytes), to_hex(&ciphertext));
    let mut map = read_keys_map(app);
    map.insert(id.to_string(), encoded);
    write_keys_map(app, &map)
}

/// Decrypt one provider's API key; `Ok(None)` if absent or unreadable.
pub(crate) fn read_key(app: &AppHandle, id: &str) -> Result<Option<String>, String> {
    let map = read_keys_map(app);
    let Some(encoded) = map.get(id) else {
        return Ok(None);
    };
    let Some((nonce_hex, ct_hex)) = encoded.split_once(':') else {
        return Ok(None);
    };
    let (Ok(nonce_bytes), Ok(ciphertext)) = (from_hex(nonce_hex), from_hex(ct_hex)) else {
        return Ok(None);
    };
    if nonce_bytes.len() != 12 {
        return Ok(None);
    }
    let cipher = Aes256Gcm::new_from_slice(&master_key(app)?).map_err(|e| e.to_string())?;
    let plaintext = match cipher.decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref()) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    Ok(String::from_utf8(plaintext).ok().filter(|s| !s.is_empty()))
}

/// Decrypt a key while running as the standalone MCP stdio process, where no
/// Tauri `AppHandle` exists. The caller supplies the same data-folder root the
/// GUI uses; only the requested slot is returned.
pub(crate) fn read_key_from_data_root(
    data_root: &Path,
    id: &str,
) -> Result<Option<String>, String> {
    let config_dir = data_root.join(CONFIG_DIR);
    let map: HashMap<String, String> = fs::read_to_string(config_dir.join(API_KEYS_FILE))
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    let Some(encoded) = map.get(id) else {
        return Ok(None);
    };
    let Some((nonce_hex, ct_hex)) = encoded.split_once(':') else {
        return Ok(None);
    };
    let (Ok(nonce_bytes), Ok(ciphertext)) = (from_hex(nonce_hex), from_hex(ct_hex)) else {
        return Ok(None);
    };
    if nonce_bytes.len() != 12 {
        return Ok(None);
    }
    let cipher = Aes256Gcm::new_from_slice(&master_key_in(&config_dir)?)
        .map_err(|error| error.to_string())?;
    let plaintext = match cipher.decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref()) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    Ok(String::from_utf8(plaintext)
        .ok()
        .filter(|value| !value.is_empty()))
}

pub(crate) fn delete_key(app: &AppHandle, id: &str) -> Result<(), String> {
    let mut map = read_keys_map(app);
    if map.remove(id).is_some() {
        return write_keys_map(app, &map);
    }
    Ok(())
}

fn to_view(app_id_key_ok: bool, provider: Provider) -> ProviderView {
    let supports_balance = spec_for(&provider.kind).supports_balance();
    ProviderView {
        provider,
        has_key: app_id_key_ok,
        supports_balance,
    }
}

fn view_list(app: &AppHandle, providers: Vec<Provider>) -> Vec<ProviderView> {
    providers
        .into_iter()
        .map(|provider| {
            let has_key = read_key(app, &provider.id).unwrap_or(None).is_some();
            to_view(has_key, provider)
        })
        .collect()
}

fn find_index(providers: &[Provider], id: &str) -> Result<usize, String> {
    providers
        .iter()
        .position(|provider| provider.id == id)
        .ok_or_else(|| "服务商不存在。".to_string())
}

/// Everything the chat runtime needs to call one provider/model, resolved in one
/// place so the API key never leaves this module until it is used. Fields stay
/// inside the crate (the webview must never see the key).
pub(crate) struct ChatTarget {
    pub base_url: String,
    pub provider_name: String,
    /// Provider kind (openai / deepseek / openrouter / qwen / …). Resolved to a
    /// [`ProviderSpec`] via [`ChatTarget::spec`] to drive per-provider behaviour
    /// (auth header, request fields, reasoning-field names, image encoding).
    pub kind: String,
    pub api_key: Option<String>,
    pub model_id: String,
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub supports_video: bool,
    pub input_price: Option<f64>,
    pub output_price: Option<f64>,
    pub cache_hit_input_price: Option<f64>,
    pub peak_pricing_enabled: bool,
    pub peak_input_price: Option<f64>,
    pub peak_output_price: Option<f64>,
    pub peak_cache_hit_input_price: Option<f64>,
    pub peak_time_ranges: Vec<PricingTimeRange>,
}

impl ChatTarget {
    /// The behaviour spec for this target's provider kind — the single dispatch
    /// point for per-provider chat-runtime seams.
    pub(crate) fn spec(&self) -> &'static dyn ProviderSpec {
        spec_for(&self.kind)
    }
}

fn pricing_time_ranges(model: &ProviderModel) -> Vec<PricingTimeRange> {
    let ranges: Vec<_> = model
        .peak_time_ranges
        .iter()
        .filter(|range| range.contains_hour(0).is_some())
        .cloned()
        .collect();
    if !ranges.is_empty() {
        return ranges;
    }
    match (model.peak_start_hour, model.peak_end_hour) {
        (Some(start_hour), Some(end_hour)) => {
            let legacy = PricingTimeRange {
                start_hour,
                end_hour,
            };
            legacy
                .contains_hour(0)
                .is_some()
                .then_some(legacy)
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Resolve a provider + model into a ready-to-use [`ChatTarget`], reading the API
/// key from the OS keychain. Errors if the provider is missing or disabled.
pub(crate) fn resolve_chat_target(
    app: &AppHandle,
    provider_id: &str,
    model_id: &str,
) -> Result<ChatTarget, String> {
    let providers = read_providers(app)?;
    let provider = providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or("服务商不存在，请在设置中重新选择。")?;
    if !provider.enabled {
        return Err("该服务商已被禁用，请在设置中启用后再试。".into());
    }
    if provider.base_url.trim().is_empty() {
        return Err("该服务商未填写 API 地址。".into());
    }
    let model = provider.models.iter().find(|m| m.id == model_id);
    let (supports_tools, supports_vision, supports_video) = model
        .map(|m| {
            (
                m.capabilities.iter().any(|c| c == "tool"),
                // The category keeps old data working while the explicit image
                // capability lets users correct incomplete provider catalogues.
                m.category == "vision"
                    || m.input_modalities
                        .iter()
                        .any(|modality| modality == "image")
                    || m.capabilities.iter().any(|c| c == "image" || c == "vision"),
                m.input_modalities
                    .iter()
                    .any(|modality| modality == "video")
                    || m.capabilities.iter().any(|c| c == "video"),
            )
        })
        .unwrap_or((false, false, false));
    Ok(ChatTarget {
        base_url: provider.base_url.clone(),
        provider_name: provider.name.clone(),
        kind: provider.kind.clone(),
        api_key: read_key(app, provider_id)?,
        model_id: model_id.to_string(),
        supports_tools,
        supports_vision,
        supports_video,
        input_price: model.and_then(|m| m.input_price),
        output_price: model.and_then(|m| m.output_price),
        cache_hit_input_price: model.and_then(|m| m.cache_hit_input_price),
        peak_pricing_enabled: model.is_some_and(|m| m.peak_pricing_enabled),
        peak_input_price: model.and_then(|m| m.peak_input_price),
        peak_output_price: model.and_then(|m| m.peak_output_price),
        peak_cache_hit_input_price: model.and_then(|m| m.peak_cache_hit_input_price),
        peak_time_ranges: model.map(pricing_time_ranges).unwrap_or_default(),
    })
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_providers(app: AppHandle) -> Result<Vec<ProviderView>, String> {
    let mut providers = read_providers(&app)?;
    if enforce_single_default(&mut providers, None) {
        write_providers(&app, &providers)?;
    }
    Ok(view_list(&app, providers))
}

#[tauri::command]
pub fn create_provider(
    app: AppHandle,
    name: String,
    kind: String,
    base_url: String,
) -> Result<ProviderView, String> {
    let mut providers = read_providers(&app)?;
    let timestamp = now();
    let provider = Provider {
        id: format!("provider-{}", now_nanos()),
        name: name.trim().to_string(),
        kind,
        base_url: base_url.trim().to_string(),
        enabled: true,
        models: Vec::new(),
        created_at: timestamp,
        updated_at: timestamp,
    };
    providers.push(provider.clone());
    write_providers(&app, &providers)?;
    Ok(to_view(false, provider))
}

#[tauri::command]
pub fn update_provider(
    app: AppHandle,
    id: String,
    name: String,
    kind: String,
    base_url: String,
    enabled: bool,
    models: Vec<ProviderModel>,
) -> Result<ProviderView, String> {
    let mut providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    let provider = &mut providers[index];
    provider.name = name.trim().to_string();
    provider.kind = kind;
    provider.base_url = base_url.trim().to_string();
    provider.enabled = enabled;
    provider.models = models;
    provider.updated_at = now();
    enforce_single_default(&mut providers, None);
    let updated = providers[index].clone();
    write_providers(&app, &providers)?;
    let has_key = read_key(&app, &id).unwrap_or(None).is_some();
    Ok(to_view(has_key, updated))
}

/// Atomically replace the single global default model across all providers.
#[tauri::command]
pub fn set_default_model(
    app: AppHandle,
    provider_id: String,
    model_id: String,
) -> Result<Vec<ProviderView>, String> {
    let mut providers = read_providers(&app)?;
    let provider = providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| "服务商不存在。".to_string())?;
    let model = provider
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "模型不存在。".to_string())?;
    if !is_chat_model(model) {
        return Err("只有文本或视觉模型可以设为全局默认模型。".into());
    }
    enforce_single_default(&mut providers, Some((&provider_id, &model_id)));
    write_providers(&app, &providers)?;
    Ok(view_list(&app, providers))
}

#[tauri::command]
pub fn set_provider_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let mut providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    providers[index].enabled = enabled;
    providers[index].updated_at = now();
    write_providers(&app, &providers)
}

#[tauri::command]
pub fn delete_provider(app: AppHandle, id: String) -> Result<(), String> {
    let mut providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    providers.remove(index);
    write_providers(&app, &providers)?;
    delete_key(&app, &id)
}

#[tauri::command]
pub fn set_provider_key(app: AppHandle, id: String, key: String) -> Result<(), String> {
    // Ensure the provider exists before writing the encrypted key store.
    let providers = read_providers(&app)?;
    find_index(&providers, &id)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return delete_key(&app, &id);
    }
    save_key(&app, &id, trimmed)
}

#[tauri::command]
pub fn provider_has_key(app: AppHandle, id: String) -> Result<bool, String> {
    let providers = read_providers(&app)?;
    find_index(&providers, &id)?;
    Ok(read_key(&app, &id)?.is_some())
}

#[derive(Default, Deserialize)]
struct ModelArchitecture {
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    output_modalities: Vec<String>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    architecture: ModelArchitecture,
    #[serde(default)]
    supported_parameters: Vec<String>,
    #[serde(default)]
    context_length: Option<u64>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

fn contains_modality(modalities: &[String], wanted: &str) -> bool {
    modalities
        .iter()
        .any(|modality| modality.eq_ignore_ascii_case(wanted))
}

fn fetched_model(entry: ModelEntry) -> FetchedProviderModel {
    let inputs = entry.architecture.input_modalities;
    let outputs = entry.architecture.output_modalities;
    let has_modality =
        |wanted| contains_modality(&inputs, wanted) || contains_modality(&outputs, wanted);
    let mut capabilities = Vec::new();
    for (modality, capability) in [("image", "image"), ("audio", "audio"), ("video", "video")] {
        if has_modality(modality) {
            capabilities.push(capability.to_string());
        }
    }
    if entry.supported_parameters.iter().any(|parameter| {
        matches!(
            parameter.as_str(),
            "tools" | "tool_choice" | "parallel_tool_calls"
        )
    }) {
        capabilities.push("tool".into());
    }
    if entry
        .supported_parameters
        .iter()
        .any(|parameter| matches!(parameter.as_str(), "reasoning" | "include_reasoning"))
    {
        capabilities.push("reasoning".into());
    }

    let category = if inputs.is_empty() && outputs.is_empty() {
        ""
    } else if contains_modality(&outputs, "embeddings") || contains_modality(&outputs, "embedding")
    {
        "embedding"
    } else if contains_modality(&outputs, "video") {
        "video"
    } else if contains_modality(&outputs, "audio") {
        "audio"
    } else if contains_modality(&outputs, "image") {
        // A model whose output is images is a generator ("文生图"); one that also
        // emits text is still a (visual) chat model, so only pure image output
        // gets the standalone image category.
        if contains_modality(&outputs, "text") {
            "vision"
        } else {
            "image"
        }
    } else if contains_modality(&inputs, "image") || contains_modality(&inputs, "video") {
        // Image/video understanding models still answer with text and remain
        // eligible for conversations, so they share the visual category.
        "vision"
    } else if contains_modality(&inputs, "audio") {
        "audio"
    } else {
        "text"
    };

    FetchedProviderModel {
        name: if entry.name.trim().is_empty() {
            entry.id.clone()
        } else {
            entry.name
        },
        id: entry.id,
        capabilities,
        category: category.into(),
        context_length: entry.context_length,
        input_modalities: inputs,
        output_modalities: outputs,
    }
}

async fn fetch_models_raw(
    base_url: &str,
    key: Option<&str>,
    kind: &str,
) -> Result<Vec<FetchedProviderModel>, String> {
    if base_url.trim().is_empty() {
        return Err("请先填写 API 地址。".into());
    }
    let spec = spec_for(kind);
    let client = reqwest::Client::new();
    let mut request = client.get(spec.models_url(base_url));
    if let Some(key) = key {
        request = spec.apply_auth(request, key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("接口返回 {status}：{snippet}"));
    }

    let parsed: ModelsResponse = response
        .json()
        .await
        .map_err(|error| format!("无法解析模型列表：{error}"))?;
    Ok(parsed
        .data
        .into_iter()
        .map(fetched_model)
        .map(|model| spec.enrich_fetched_model(model))
        .collect())
}

/// Query a provider's account balance, dispatched to its [`ProviderSpec`]. Only
/// providers that publish one (DeepSeek's `/user/balance`, OpenRouter's
/// `/credits`) return a figure; the rest report they have none. Requires a key.
#[tauri::command]
pub async fn provider_balance(app: AppHandle, id: String) -> Result<ProviderBalance, String> {
    let providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    let base_url = providers[index].base_url.clone();
    let kind = providers[index].kind.clone();
    if base_url.trim().is_empty() {
        return Err("请先填写 API 地址。".into());
    }
    let key = read_key(&app, &id)?.ok_or("请先填写 API 密钥。")?;
    spec_for(&kind).fetch_balance(base_url.trim(), &key).await
}

#[tauri::command]
pub async fn test_provider(app: AppHandle, id: String) -> Result<String, String> {
    let providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    let base_url = providers[index].base_url.clone();
    let kind = providers[index].kind.clone();
    let key = read_key(&app, &id)?;
    let models = fetch_models_raw(&base_url, key.as_deref(), &kind).await?;
    Ok(format!("连接成功，可用模型 {} 个", models.len()))
}

#[tauri::command]
pub async fn fetch_provider_models(
    app: AppHandle,
    id: String,
) -> Result<Vec<FetchedProviderModel>, String> {
    let providers = read_providers(&app)?;
    let index = find_index(&providers, &id)?;
    let base_url = providers[index].base_url.clone();
    let kind = providers[index].kind.clone();
    let key = read_key(&app, &id)?;
    fetch_models_raw(&base_url, key.as_deref(), &kind).await
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn providers_with_two_defaults() -> Vec<Provider> {
        serde_json::from_value(serde_json::json!([
            {
                "id": "one",
                "name": "One",
                "enabled": true,
                "models": [
                    { "id": "one-a", "name": "One A", "starred": true },
                    { "id": "one-b", "name": "One B", "starred": false }
                ],
                "createdAt": 1,
                "updatedAt": 1
            },
            {
                "id": "two",
                "name": "Two",
                "enabled": true,
                "models": [
                    { "id": "two-a", "name": "Two A", "starred": true }
                ],
                "createdAt": 2,
                "updatedAt": 2
            }
        ]))
        .unwrap()
    }

    #[test]
    fn hex_roundtrips() {
        let bytes = [0u8, 1, 2, 250, 255, 16];
        assert_eq!(from_hex(&to_hex(&bytes)).unwrap(), bytes);
        assert!(from_hex("abc").is_err()); // odd length rejected
        assert!(from_hex("zz").is_err()); // non-hex rejected
    }

    #[test]
    fn aes_gcm_roundtrips_in_the_key_store_format() {
        // Exercises the exact encode/decode `save_key`/`read_key` use, with a
        // fixed master key so no AppHandle/filesystem is needed.
        let master = [7u8; 32];
        let cipher = Aes256Gcm::new_from_slice(&master).unwrap();
        let mut nonce_bytes = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), b"sk-secret-123".as_ref())
            .unwrap();
        let encoded = format!("{}:{}", to_hex(&nonce_bytes), to_hex(&ciphertext));

        let (nonce_hex, ct_hex) = encoded.split_once(':').unwrap();
        let nb = from_hex(nonce_hex).unwrap();
        let cb = from_hex(ct_hex).unwrap();
        let plaintext = cipher.decrypt(Nonce::from_slice(&nb), cb.as_ref()).unwrap();
        assert_eq!(plaintext, b"sk-secret-123");

        // Wrong master key must fail to decrypt (authentication tag mismatch).
        let wrong = Aes256Gcm::new_from_slice(&[9u8; 32]).unwrap();
        assert!(wrong.decrypt(Nonce::from_slice(&nb), cb.as_ref()).is_err());
    }

    #[test]
    fn fetched_models_keep_provider_modalities_and_capabilities() {
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vendor/omni",
            "name": "Omni",
            "context_length": 262144,
            "architecture": {
                "input_modalities": ["text", "image", "audio", "video"],
                "output_modalities": ["text"]
            },
            "supported_parameters": ["tools", "reasoning"]
        }))
        .unwrap();
        let model = fetched_model(entry);
        assert_eq!(model.category, "vision");
        assert_eq!(model.context_length, Some(262_144));
        assert_eq!(
            model.capabilities,
            vec!["image", "audio", "video", "tool", "reasoning"]
        );
        assert_eq!(
            model.input_modalities,
            vec!["text", "image", "audio", "video"]
        );
        assert_eq!(model.output_modalities, vec!["text"]);

        let video: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vendor/video-generator",
            "architecture": {
                "input_modalities": ["text", "image"],
                "output_modalities": ["video"]
            }
        }))
        .unwrap();
        let video = fetched_model(video);
        assert_eq!(video.category, "video");
        assert_eq!(video.capabilities, vec!["image", "video"]);
    }

    #[test]
    fn image_only_output_is_a_generator_while_text_plus_image_stays_visual() {
        let generator: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vendor/text-to-image",
            "architecture": { "input_modalities": ["text"], "output_modalities": ["image"] }
        }))
        .unwrap();
        assert_eq!(fetched_model(generator).category, "image");

        // A model that also emits text remains a (visual) chat model.
        let multimodal: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vendor/text-and-image",
            "architecture": { "input_modalities": ["text"], "output_modalities": ["text", "image"] }
        }))
        .unwrap();
        assert_eq!(fetched_model(multimodal).category, "vision");
    }

    #[test]
    fn id_only_catalogues_are_left_for_the_frontend_fallback() {
        let entry: ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vendor/future-audio-model"
        }))
        .unwrap();
        let model = fetched_model(entry);
        assert!(model.category.is_empty());
        assert!(model.capabilities.is_empty());
        assert_eq!(model.name, model.id);
    }

    #[test]
    fn pricing_ranges_support_multiple_windows_and_legacy_data() {
        let multiple: ProviderModel = serde_json::from_value(serde_json::json!({
            "id": "priced",
            "name": "Priced",
            "peakTimeRanges": [
                { "startHour": 9, "endHour": 12 },
                { "startHour": 14, "endHour": 18 }
            ]
        }))
        .unwrap();
        let ranges = pricing_time_ranges(&multiple);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].contains_hour(9), Some(true));
        assert_eq!(ranges[0].contains_hour(12), Some(false));
        assert_eq!(ranges[1].contains_hour(14), Some(true));
        assert_eq!(ranges[1].contains_hour(18), Some(false));

        let legacy: ProviderModel = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "peakStartHour": 22,
            "peakEndHour": 2
        }))
        .unwrap();
        let ranges = pricing_time_ranges(&legacy);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].contains_hour(23), Some(true));
        assert_eq!(ranges[0].contains_hour(1), Some(true));
        assert_eq!(ranges[0].contains_hour(2), Some(false));
    }

    #[test]
    fn global_default_is_unique_and_can_be_replaced_atomically() {
        let mut providers = providers_with_two_defaults();
        assert!(enforce_single_default(&mut providers, None));
        let starred: Vec<_> = providers
            .iter()
            .flat_map(|provider| {
                provider.models.iter().filter_map(move |model| {
                    model
                        .starred
                        .then_some((provider.id.as_str(), model.id.as_str()))
                })
            })
            .collect();
        assert_eq!(starred, vec![("one", "one-a")]);

        assert!(enforce_single_default(
            &mut providers,
            Some(("two", "two-a"))
        ));
        let starred: Vec<_> = providers
            .iter()
            .flat_map(|provider| {
                provider.models.iter().filter_map(move |model| {
                    model
                        .starred
                        .then_some((provider.id.as_str(), model.id.as_str()))
                })
            })
            .collect();
        assert_eq!(starred, vec![("two", "two-a")]);
    }
}
