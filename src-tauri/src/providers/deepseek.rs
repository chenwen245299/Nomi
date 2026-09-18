//! DeepSeek.
//!
//! Two provider-specific behaviours live here:
//!
//! * **Balance** — `GET /user/balance` returns one entry per currency, each with
//!   the remaining total already split into granted (promotional, expiring) and
//!   topped-up (prepaid) parts. Amounts arrive as strings ("110.00"); we parse to
//!   numbers for display. First currency is primary; the rest ride along as
//!   `other_currencies`.
//!
//! * **Images** — DeepSeek caps an inline (base64) image at 32 MiB and the whole
//!   request body at ~48 MiB. When a request would blow those, the offending
//!   images are uploaded to the Files API (`POST /files`, up to 64 MiB each) and
//!   swapped in the message array for `{ "type": "file", "file_id": … }` handles.
//!   Uploads are cached by payload hash so an agent's tool-loop, which replays
//!   the whole transcript each round, doesn't re-upload the same image.
//!
//! Ported from Argus's `balance.rs` and `deepseek.rs`.
//! Refs: <https://api-docs.deepseek.com/zh-cn/api/get-user-balance>,
//! <https://api-docs.deepseek.com/zh-cn/api/upload-files>
//!
//! Deliberately NOT ported (out of scope / doesn't fit Nomi): pixel-dimension
//! caps + downscaling (Nomi's `image` crate can't decode jpeg/webp to resize),
//! the 600-image count cap, and the Files CRUD commands (a separate file-manager
//! feature). Vision-capability gating already happens when messages are built.

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};

use super::spec::{CurrencyBalance, ProviderBalance, ProviderSpec, get_json};
use crate::providers::ChatTarget;

// ── Image limits (from DeepSeek's docs) ──────────────────────────────────────

/// One inline (base64) image caps here; above it the image must be uploaded.
const MAX_INLINE_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
/// One image uploaded through the Files API.
const MAX_FILE_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Combined inline image bytes before some must move to the Files API.
const MAX_TOTAL_INLINE_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// Whole request body ceiling; images are offloaded to keep the body under it.
const MAX_REQUEST_BODY_BYTES: u64 = 48 * 1024 * 1024;
/// The only `purpose` the Files API accepts.
const FILE_PURPOSE: &str = "user_data";
/// How long an auto-uploaded image lives server-side. These uploads are a
/// transport detail the user never asked for, so they expire on their own; a
/// week still covers re-asking about the same image in a follow-up turn.
const AUTO_UPLOAD_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

pub(crate) struct DeepSeek;

#[async_trait]
impl ProviderSpec for DeepSeek {
    fn configure_reasoning(&self, body: &mut Value, _target: &ChatTarget, effort: Option<&str>) {
        body["thinking"] = json!({
            "type": if effort.is_some() { "enabled" } else { "disabled" }
        });
        if let Some(effort) = effort {
            body["reasoning_effort"] = Value::String(effort.to_string());
        }
    }

    fn supports_balance(&self) -> bool {
        true
    }

    async fn fetch_balance(
        &self,
        base_url: &str,
        api_key: &str,
        _access_token: Option<&str>,
    ) -> Result<ProviderBalance, String> {
        // The balance endpoint sits at the API root, not under `/v1`, so drop a
        // trailing `/v1` if the user configured the chat base URL with one.
        let base = base_url.trim().trim_end_matches('/');
        let base = base.strip_suffix("/v1").unwrap_or(base);
        let url = format!("{base}/user/balance");

        let body: DeepSeekBalance = get_json(&url, api_key).await?;

        let mut infos = body.balance_infos.into_iter();
        let primary = infos.next().ok_or("DeepSeek 未返回任何余额信息。")?;

        Ok(ProviderBalance {
            remaining: parse_amount(&primary.total_balance),
            currency: normalise_currency(&primary.currency, "CNY"),
            granted: Some(parse_amount(&primary.granted_balance)),
            topped_up: Some(parse_amount(&primary.topped_up_balance)),
            total_credits: None,
            total_usage: None,
            is_available: body.is_available,
            other_currencies: infos
                .map(|info| CurrencyBalance {
                    currency: normalise_currency(&info.currency, "CNY"),
                    remaining: parse_amount(&info.total_balance),
                })
                .collect(),
            unlimited: false,
            expires_at: None,
            note: None,
        })
    }

    /// Move oversized inline images to the Files API, largest first, until what
    /// remains inline fits both the per-image cap and the request-body budget.
    /// A request with no inline images is returned untouched — which matters for
    /// prompt caching, since reshaping the array would miss the cache.
    async fn prepare_messages(
        &self,
        target: &ChatTarget,
        mut msgs: Vec<Value>,
    ) -> Result<Vec<Value>, String> {
        // Locate every inline (data-URI) image. DeepSeek rejects images on
        // system/assistant turns, and Nomi only ever puts them on user turns, so
        // only those are considered.
        let mut inline: Vec<Slot> = Vec::new();
        for (mi, m) in msgs.iter().enumerate() {
            if m.get("role").and_then(|r| r.as_str()) != Some("user") {
                continue;
            }
            let Some(parts) = m.get("content").and_then(|c| c.as_array()) else {
                continue;
            };
            for (pi, part) in parts.iter().enumerate() {
                if part.get("type").and_then(|t| t.as_str()) != Some("image_url") {
                    continue;
                }
                let Some(url) = part.pointer("/image_url/url").and_then(|v| v.as_str()) else {
                    continue;
                };
                // A remote URL (not a data URI) never passes through here.
                let Some((_, payload)) = split_data_uri(url) else {
                    continue;
                };
                inline.push(Slot {
                    msg: mi,
                    part: pi,
                    size: base64_decoded_len(payload),
                });
            }
        }
        if inline.is_empty() {
            return Ok(msgs);
        }

        // Largest first: offloading the biggest images clears the budget fastest.
        let mut order: Vec<usize> = (0..inline.len()).collect();
        order.sort_by(|a, b| inline[*b].size.cmp(&inline[*a].size));
        let mut inline_bytes: u64 = inline.iter().map(|s| s.size).sum();

        for i in order {
            let must_upload = inline[i].size > MAX_INLINE_IMAGE_BYTES;
            let over_total = inline_bytes > MAX_TOTAL_INLINE_IMAGE_BYTES;
            let over_body = encoded_len(inline_bytes) > body_budget();
            if !(must_upload || over_total || over_body) {
                break;
            }

            let (mi, pi, size) = (inline[i].msg, inline[i].part, inline[i].size);
            // Take the payload as owned before the await + the mutation below.
            let payload = msgs[mi]["content"][pi]["image_url"]["url"]
                .as_str()
                .and_then(|u| split_data_uri(u).map(|(_, p)| p.to_string()))
                .ok_or("内部错误：待上传的图片不是 data URI。")?;

            let file_id = upload_inline_image(target, &payload, size).await?;
            msgs[mi]["content"][pi] = json!({ "type": "file", "file_id": file_id });
            inline_bytes = inline_bytes.saturating_sub(size);
        }
        Ok(msgs)
    }
}

// ── Balance response ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct DeepSeekBalance {
    #[serde(default)]
    is_available: bool,
    #[serde(default)]
    balance_infos: Vec<DeepSeekBalanceInfo>,
}

#[derive(Deserialize)]
struct DeepSeekBalanceInfo {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    total_balance: String,
    #[serde(default)]
    granted_balance: String,
    #[serde(default)]
    topped_up_balance: String,
}

fn parse_amount(raw: &str) -> f64 {
    raw.trim().replace(',', "").parse::<f64>().unwrap_or(0.0)
}

fn normalise_currency(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_uppercase()
    }
}

// ── Image upload ──────────────────────────────────────────────────────────────

/// One inline image found in the outgoing request, so the budget pass can decide
/// whether it must move to the Files API.
struct Slot {
    msg: usize,
    part: usize,
    /// Decoded size of the image itself, not of its base64 form.
    size: u64,
}

/// The one field we need from a `POST /files` response.
#[derive(Deserialize)]
struct DeepSeekFile {
    id: String,
}

/// Upload one inline image (or reuse a cached handle) and return its `file_id`.
async fn upload_inline_image(
    target: &ChatTarget,
    payload: &str,
    size: u64,
) -> Result<String, String> {
    let key = payload_hash(&target.base_url, payload);
    if let Some(file_id) = cached_upload(key) {
        return Ok(file_id);
    }
    let api_key = target
        .api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            format!(
                "有图片达 {}，需要先上传到 DeepSeek Files API，但该服务商未配置 API Key。",
                human_size(size)
            )
        })?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.replace(['\n', '\r'], ""))
        .map_err(|e| format!("图片 base64 解码失败：{e}"))?;
    if bytes.len() as u64 > MAX_FILE_IMAGE_BYTES {
        return Err(format!(
            "单张图片 {}，超过 Files API 单文件 {} 的上限。",
            human_size(bytes.len() as u64),
            human_size(MAX_FILE_IMAGE_BYTES)
        ));
    }
    let mime = sniff_image_mime(&bytes)
        .ok_or("图片不是 DeepSeek 支持的格式（仅 JPEG / PNG / GIF / WebP）。")?;
    let filename = format!("image{}", extension_for(mime));

    let file = upload_file(&target.base_url, api_key, &filename, mime, &bytes).await?;
    remember_upload(key, &file.id);
    Ok(file.id)
}

/// `POST /files` — upload one image and get back a `file-…` handle. The multipart
/// body is assembled by hand (three fixed fields) to avoid pulling in reqwest's
/// `multipart` feature.
async fn upload_file(
    base_url: &str,
    api_key: &str,
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<DeepSeekFile, String> {
    let boundary = format!("----NomiFormBoundary{:016x}", rand_u64());
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    };
    field("purpose", FILE_PURPOSE);
    field("expires_after[anchor]", "created_at");
    field(
        "expires_after[seconds]",
        &AUTO_UPLOAD_TTL_SECONDS.to_string(),
    );

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\n",
            escape_quoted(filename)
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let files_url = format!("{}/files", base_url.trim().trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(files_url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传图片失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("Files API 返回 {status}：{snippet}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("无法解析 Files API 响应：{e}"))
}

// ── Upload cache ───────────────────────────────────────────────────────────────

/// Handles minted by [`DeepSeek::prepare_messages`], keyed by a hash of the image
/// payload. An agent run replays its whole transcript each round, so without this
/// the same oversized image would be uploaded again every turn. Entries are
/// dropped well before the upload's own expiry so a stale handle is never reused.
static UPLOAD_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u64, (String, std::time::Instant)>>,
> = std::sync::OnceLock::new();

const UPLOAD_CACHE_TTL: std::time::Duration =
    std::time::Duration::from_secs(AUTO_UPLOAD_TTL_SECONDS - 24 * 60 * 60);

fn payload_hash(namespace: &str, payload: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    namespace.hash(&mut hasher);
    payload.len().hash(&mut hasher);
    payload.hash(&mut hasher);
    hasher.finish()
}

fn cached_upload(key: u64) -> Option<String> {
    let map = UPLOAD_CACHE.get_or_init(Default::default).lock().ok()?;
    map.get(&key)
        .filter(|(_, at)| at.elapsed() < UPLOAD_CACHE_TTL)
        .map(|(id, _)| id.clone())
}

fn remember_upload(key: u64, file_id: &str) {
    if let Ok(mut map) = UPLOAD_CACHE.get_or_init(Default::default).lock() {
        map.retain(|_, (_, at)| at.elapsed() < UPLOAD_CACHE_TTL);
        map.insert(key, (file_id.to_string(), std::time::Instant::now()));
    }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/// Media type read from the leading magic bytes, so a PNG named `.jpg` — or a
/// data URI that mislabels its payload — is judged on the bytes, like DeepSeek.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        _ => ".jpg",
    }
}

/// Decoded byte length of a base64 payload, ignoring whitespace and padding.
fn base64_decoded_len(payload: &str) -> u64 {
    let len = payload.chars().filter(|c| !c.is_whitespace()).count() as u64;
    let padding = payload
        .trim_end()
        .chars()
        .rev()
        .take_while(|c| *c == '=')
        .count() as u64;
    len.saturating_mul(3) / 4 - padding.min(2)
}

/// Split `data:<mime>;base64,<payload>` into its media type and payload.
fn split_data_uri(uri: &str) -> Option<(&str, &str)> {
    let rest = uri.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    Some((
        meta.split(';').next().unwrap_or("application/octet-stream"),
        payload,
    ))
}

/// Size of `raw` bytes once base64-encoded.
fn encoded_len(raw: u64) -> u64 {
    raw.div_ceil(3).saturating_mul(4)
}

/// Leave a megabyte of the body budget for text, tool defs and JSON scaffolding.
fn body_budget() -> u64 {
    MAX_REQUEST_BODY_BYTES.saturating_sub(1024 * 1024)
}

fn escape_quoted(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n'], "_")
}

fn rand_u64() -> u64 {
    use rand::RngCore;
    rand::rngs::OsRng.next_u64()
}

fn human_size(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const KIB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.0} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ChatTarget {
        ChatTarget {
            base_url: "https://api.deepseek.com/v1".into(),
            provider_name: "DeepSeek".into(),
            kind: "deepseek".into(),
            api_key: Some("sk-test".into()),
            model_id: "deepseek-v4-flash-vision-exp".into(),
            supports_tools: false,
            supports_vision: true,
            supports_video: false,
            input_price: None,
            output_price: None,
            cache_hit_input_price: None,
            peak_pricing_enabled: false,
            peak_input_price: None,
            peak_output_price: None,
            peak_cache_hit_input_price: None,
            peak_time_ranges: Vec::new(),
        }
    }

    #[test]
    fn amounts_arrive_as_strings() {
        assert_eq!(parse_amount("110.00"), 110.0);
        assert_eq!(parse_amount(" 1,234.50 "), 1234.5);
        assert_eq!(parse_amount("nonsense"), 0.0);
    }

    #[test]
    fn a_missing_currency_falls_back_rather_than_showing_blank() {
        assert_eq!(normalise_currency("cny", "USD"), "CNY");
        assert_eq!(normalise_currency("  ", "CNY"), "CNY");
    }

    #[test]
    fn explicitly_disables_default_thinking() {
        let mut body = json!({ "model": "deepseek-v4-flash" });
        DeepSeek.configure_reasoning(&mut body, &target(), None);
        assert_eq!(body["thinking"]["type"], json!("disabled"));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn enables_thinking_with_the_selected_effort() {
        let mut body = json!({ "model": "deepseek-v4-flash" });
        DeepSeek.configure_reasoning(&mut body, &target(), Some("max"));
        assert_eq!(body["thinking"]["type"], json!("enabled"));
        assert_eq!(body["reasoning_effort"], json!("max"));
    }

    #[test]
    fn sniffs_formats_from_magic_bytes() {
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(
            sniff_image_mime(b"\x89PNG\r\n\x1a\n...."),
            Some("image/png")
        );
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF????WEBP...."), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"not an image"), None);
    }

    #[test]
    fn base64_len_ignores_whitespace_and_padding() {
        // "AAAA" -> 3 bytes; "AAA=" -> 2 bytes; "AA==" -> 1 byte.
        assert_eq!(base64_decoded_len("AAAA"), 3);
        assert_eq!(base64_decoded_len("AA A A"), 3);
        assert_eq!(base64_decoded_len("AAA="), 2);
        assert_eq!(base64_decoded_len("AA=="), 1);
    }

    #[test]
    fn splits_a_data_uri() {
        let (mime, payload) = split_data_uri("data:image/png;base64,AAAA").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(payload, "AAAA");
        assert!(split_data_uri("https://example.com/a.png").is_none());
    }

    #[tokio::test]
    async fn small_inline_images_are_left_untouched() {
        // A tiny inline PNG is well under every cap, so the budget pass makes no
        // upload (no network) and returns the message array unchanged.
        let msgs = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "hi" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ]
        })];
        let out = DeepSeek
            .prepare_messages(&target(), msgs.clone())
            .await
            .unwrap();
        assert_eq!(out, msgs, "small inline images must not be rewritten");
    }

    #[tokio::test]
    async fn text_only_requests_pass_through() {
        let msgs = vec![json!({ "role": "user", "content": "just text" })];
        let out = DeepSeek
            .prepare_messages(&target(), msgs.clone())
            .await
            .unwrap();
        assert_eq!(out, msgs);
    }
}
