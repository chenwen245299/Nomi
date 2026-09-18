//! MiniMax OpenAI-compatible chat API.
//!
//! `MiniMax-M3` accepts text, image and video content parts. Videos may be
//! supplied inline (URL/base64, up to 50 MiB), while larger inputs must first be
//! uploaded to the Files API and referenced as `mm_file://<file_id>`. The whole
//! JSON request is capped at 64 MiB, so this implementation also moves smaller
//! videos to Files when their base64 expansion would cross a conservative body
//! budget. Uploaded handles are cached for six days (the service retains them
//! for seven), preventing every tool-loop turn from uploading the same file.
//!
//! MiniMax's Chat Completions content schema currently has no audio input part.
//! Audio is deliberately not advertised here: the platform's speech APIs are
//! generation/voice services, not an audio-understanding input for this chat
//! endpoint.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use base64::Engine;
use serde_json::{Value, json};

use super::spec::ProviderSpec;
use crate::providers::{ChatTarget, FetchedProviderModel};

const INLINE_VIDEO_FILE_LIMIT: u64 = 50 * 1024 * 1024;
const INLINE_IMAGE_FILE_LIMIT: usize = 10 * 1024 * 1024;
const SAFE_JSON_BODY_LIMIT: u64 = 60 * 1024 * 1024;
const HARD_JSON_BODY_LIMIT: usize = 64 * 1024 * 1024;
const FILES_CACHE_TTL_SECS: u64 = 6 * 24 * 60 * 60;
const VIDEO_PLACEHOLDER: &str = "_nomi_minimax_video_file";

pub(crate) struct MiniMax;

#[derive(Clone)]
struct CachedFile {
    file_id: String,
    expires_at: u64,
}

static FILE_CACHE: OnceLock<Mutex<HashMap<String, CachedFile>>> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn normalized_model_id(model_id: &str) -> String {
    model_id.trim().to_ascii_lowercase()
}

fn is_m3(model_id: &str) -> bool {
    normalized_model_id(model_id) == "minimax-m3"
}

fn is_m_series(model_id: &str) -> bool {
    normalized_model_id(model_id).starts_with("minimax-m")
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|candidate| candidate == value) {
        values.push(value.to_string());
    }
}

fn normalized_video_mime(path: &Path, mime: &str) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match (extension.as_str(), mime) {
        ("mp4", _) | (_, "video/mp4") => Ok("video/mp4"),
        ("avi", _) | (_, "video/x-msvideo") => Ok("video/avi"),
        ("mov", _) | (_, "video/quicktime" | "video/mov") => Ok("video/mov"),
        ("mkv", _) | (_, "video/x-matroska") => Ok("video/mkv"),
        _ => Err(format!(
            "MiniMax 仅支持 MP4、AVI、MOV、MKV 视频：{}",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("未知文件")
        )),
    }
}

fn cache_key(base_url: &str, path: &Path, size: u64, modified: u64) -> String {
    format!(
        "{}|{}|{size}|{modified}",
        base_url.trim().trim_end_matches('/'),
        path.to_string_lossy()
    )
}

fn cached_file_id(key: &str) -> Option<String> {
    let now = now_secs();
    let mut cache = FILE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    cache.retain(|_, value| value.expires_at > now);
    cache.get(key).map(|value| value.file_id.clone())
}

fn remember_file_id(key: String, file_id: String) {
    if let Ok(mut cache) = FILE_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        cache.insert(
            key,
            CachedFile {
                file_id,
                expires_at: now_secs() + FILES_CACHE_TTL_SECS,
            },
        );
    }
}

fn upload_file_id(value: &Value) -> Option<String> {
    let id = value
        .pointer("/file/file_id")
        .or_else(|| value.pointer("/file/id"))
        .or_else(|| value.get("file_id"))
        .or_else(|| value.get("id"))?;
    id.as_str()
        .map(str::to_string)
        .or_else(|| id.as_u64().map(|number| number.to_string()))
}

async fn upload_video(target: &ChatTarget, path: &Path) -> Result<String, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("无法读取视频信息：{error}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let key = cache_key(&target.base_url, path, metadata.len(), modified);
    if let Some(file_id) = cached_file_id(&key) {
        return Ok(file_id);
    }

    let api_key = target
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or("MiniMax Files API 需要 API Key。")?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video.mp4")
        .to_string();
    let part = reqwest::multipart::Part::file(path)
        .await
        .map_err(|error| format!("准备上传视频失败：{error}"))?
        .file_name(filename);
    let form = reqwest::multipart::Form::new()
        .text("purpose", "video_understanding")
        .part("file", part);
    let url = format!(
        "{}/files/upload",
        target.base_url.trim().trim_end_matches('/')
    );
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("上传 MiniMax 视频失败：{error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 MiniMax 视频上传结果失败：{error}"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        let text = String::from_utf8_lossy(&bytes);
        format!("MiniMax 视频上传结果无法解析：{error}；{text}")
    })?;
    if !status.is_success() {
        let message = value
            .pointer("/base_resp/status_msg")
            .or_else(|| value.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("MiniMax 视频上传失败（{status}）：{message}"));
    }
    let file_id = upload_file_id(&value).ok_or("MiniMax 视频上传成功，但响应中缺少 file_id。")?;
    remember_file_id(key, file_id.clone());
    Ok(file_id)
}

fn video_url_part(url: String) -> Value {
    json!({
        "type": "video_url",
        "video_url": {
            "url": url,
            "detail": "default",
            "fps": 1
        }
    })
}

fn decoded_data_url_size(url: &str) -> Option<usize> {
    let payload = url.strip_prefix("data:")?.split_once(",")?.1;
    let compact_len = payload
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .count();
    let padding = payload
        .trim_end()
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count();
    Some((compact_len * 3 / 4).saturating_sub(padding))
}

#[async_trait]
impl ProviderSpec for MiniMax {
    fn enrich_fetched_model(&self, mut model: FetchedProviderModel) -> FetchedProviderModel {
        if !is_m_series(&model.id) {
            return model;
        }
        model
            .context_length
            .get_or_insert(if is_m3(&model.id) { 1_000_000 } else { 204_800 });
        for capability in ["tool", "reasoning"] {
            push_unique(&mut model.capabilities, capability);
        }
        push_unique(&mut model.input_modalities, "text");
        push_unique(&mut model.output_modalities, "text");
        if is_m3(&model.id) {
            model.category = "vision".into();
            for capability in ["image", "video"] {
                push_unique(&mut model.capabilities, capability);
                push_unique(&mut model.input_modalities, capability);
            }
        } else if model.category.is_empty() {
            model.category = "text".into();
        }
        model
    }

    fn configure_reasoning(&self, _body: &mut Value, _target: &ChatTarget, _effort: Option<&str>) {
        // Deliberately a no-op — and deliberately NOT deferring to the default impl
        // (which would add `reasoning_effort`, a field MiniMax ignores).
        //
        // On MiniMax's OpenAI-compatible endpoint M3 accepts a `thinking` object
        // ({type: "disabled" | "adaptive"}), and thinking is ON when it is omitted.
        // `disabled` makes M3 skip reasoning and answer directly; `adaptive` lets the
        // model decide. But the M-series only calls tools reliably *with* its
        // interleaved thinking, so we must not send `disabled` (nor let `adaptive`
        // short-circuit it): sending `disabled` made M3 narrate "好的，我帮你生成…" and
        // never emit a tool_call. We omit the param entirely to keep full thinking
        // on, exactly like M2.x (which never received it and always think + call
        // tools). Reasoning is still split out via `reasoning_split` (decorate_body).
        //
        // Trade-off: the UI reasoning-effort switch no longer changes M3's request —
        // acceptable, since reliable tool calling is worth more than a thinking toggle.
    }

    fn requires_non_streaming_tool_calls(&self, target: &ChatTarget, has_tools: bool) -> bool {
        // M3's OpenAI-compatible *streaming* endpoint drops a large tool_calls chunk:
        // it streams a short preamble, then `finish_reason:"stop"` with the call
        // missing (yet `completion_tokens` shows it was generated). A non-streaming
        // request returns the complete `message.tool_calls`. M2.x stream tool calls
        // fine, so only M3 needs this fallback, and only when tools are offered.
        has_tools && is_m3(&target.model_id)
    }

    fn decorate_body(&self, body: &mut Value, _target: &ChatTarget) {
        body["reasoning_split"] = json!(true);
    }

    fn streaming_text_is_cumulative(&self) -> bool {
        true
    }

    fn streaming_reasoning_is_cumulative(&self) -> bool {
        true
    }

    fn attach_reasoning_to_assistant_message(
        &self,
        message: &mut Value,
        reasoning: &str,
        reasoning_details: Option<&Value>,
    ) {
        if let Some(details) = reasoning_details {
            message["reasoning_details"] = details.clone();
        } else if !reasoning.is_empty() {
            message["reasoning_content"] = Value::String(reasoning.to_string());
        }
    }

    fn video_part(&self, abs_path: &Path, mime: &str) -> Option<Value> {
        Some(json!({
            "type": VIDEO_PLACEHOLDER,
            "path": abs_path.to_string_lossy(),
            "mime": mime
        }))
    }

    async fn prepare_messages(
        &self,
        target: &ChatTarget,
        mut messages: Vec<Value>,
    ) -> Result<Vec<Value>, String> {
        let mut estimated_body_size = serde_json::to_vec(&messages)
            .map_err(|error| format!("无法计算 MiniMax 请求大小：{error}"))?
            .len() as u64;

        for message in &mut messages {
            let Some(parts) = message.get_mut("content").and_then(Value::as_array_mut) else {
                continue;
            };
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("image_url")
                    && let Some(url) = part.pointer("/image_url/url").and_then(Value::as_str)
                    && decoded_data_url_size(url).is_some_and(|size| size > INLINE_IMAGE_FILE_LIMIT)
                {
                    return Err("MiniMax 单张图片不能超过 10 MiB。请压缩图片后重试。".into());
                }
                if part.get("type").and_then(Value::as_str) != Some(VIDEO_PLACEHOLDER) {
                    continue;
                }
                let path = PathBuf::from(
                    part.get("path")
                        .and_then(Value::as_str)
                        .ok_or("MiniMax 视频附件缺少本地路径。")?,
                );
                let mime = normalized_video_mime(
                    &path,
                    part.get("mime").and_then(Value::as_str).unwrap_or_default(),
                )?;
                let size = tokio::fs::metadata(&path)
                    .await
                    .map_err(|error| format!("无法读取视频附件：{error}"))?
                    .len();
                if size > 512 * 1024 * 1024 {
                    return Err(format!(
                        "视频 {} 超过 MiniMax Files API 的 512 MiB 上限。",
                        path.file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("未知文件")
                    ));
                }

                let base64_size = size.div_ceil(3) * 4 + 160;
                let can_inline = size <= INLINE_VIDEO_FILE_LIMIT
                    && estimated_body_size + base64_size <= SAFE_JSON_BODY_LIMIT;
                if can_inline {
                    let bytes = tokio::fs::read(&path)
                        .await
                        .map_err(|error| format!("读取视频附件失败：{error}"))?;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                    *part = video_url_part(format!("data:{mime};base64,{encoded}"));
                    estimated_body_size += base64_size;
                } else {
                    let file_id = upload_video(target, &path).await?;
                    *part = video_url_part(format!("mm_file://{file_id}"));
                }
            }
        }
        let body_size = serde_json::to_vec(&messages)
            .map_err(|error| format!("无法检查 MiniMax 请求大小：{error}"))?
            .len();
        if body_size > HARD_JSON_BODY_LIMIT {
            return Err("MiniMax 请求体超过 64 MiB，请减少本次发送的图片或视频数量。".into());
        }
        Ok(messages)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetched(id: &str) -> FetchedProviderModel {
        FetchedProviderModel {
            id: id.into(),
            name: id.into(),
            capabilities: Vec::new(),
            category: String::new(),
            context_length: None,
            input_modalities: Vec::new(),
            output_modalities: Vec::new(),
            input_price_usd_per_million: None,
            output_price_usd_per_million: None,
            is_free: false,
        }
    }

    fn target(model_id: &str) -> ChatTarget {
        ChatTarget {
            base_url: "https://api.minimax.cn/v1".into(),
            provider_name: "MiniMax".into(),
            kind: "minimax".into(),
            api_key: Some("test-key".into()),
            model_id: model_id.into(),
            supports_tools: true,
            supports_vision: true,
            supports_video: true,
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
    fn m3_is_enriched_as_image_and_video_chat() {
        let model = MiniMax.enrich_fetched_model(fetched("MiniMax-M3"));
        assert_eq!(model.category, "vision");
        assert_eq!(model.context_length, Some(1_000_000));
        assert_eq!(model.input_modalities, ["text", "image", "video"]);
        assert_eq!(model.output_modalities, ["text"]);
        assert!(model.capabilities.contains(&"tool".into()));
        assert!(model.capabilities.contains(&"reasoning".into()));
    }

    #[test]
    fn m3_never_sends_a_thinking_param_so_tool_calls_survive() {
        // Thinking must stay ON (the endpoint default) for M3 to emit tool_calls,
        // so configure_reasoning adds neither an Anthropic-style `thinking` field
        // nor `reasoning_effort`, in either UI switch position.
        let mut off = json!({});
        MiniMax.configure_reasoning(&mut off, &target("MiniMax-M3"), None);
        assert!(off.get("thinking").is_none());
        assert!(off.get("reasoning_effort").is_none());

        let mut on = json!({});
        MiniMax.configure_reasoning(&mut on, &target("MiniMax-M3"), Some("high"));
        assert!(on.get("thinking").is_none());
        assert!(on.get("reasoning_effort").is_none());
    }

    #[test]
    fn data_url_size_accounts_for_base64_padding() {
        assert_eq!(
            decoded_data_url_size("data:image/png;base64,dGVzdA=="),
            Some(4)
        );
    }

    #[tokio::test]
    async fn small_video_is_inlined_as_a_native_video_part() {
        let path =
            std::env::temp_dir().join(format!("nomi-minimax-video-{}.mp4", std::process::id()));
        std::fs::write(&path, b"test-video").unwrap();
        let messages = vec![json!({
            "role": "user",
            "content": [MiniMax.video_part(&path, "video/mp4").unwrap()]
        })];
        let prepared = MiniMax
            .prepare_messages(&target("MiniMax-M3"), messages)
            .await
            .unwrap();
        let part = &prepared[0]["content"][0];
        assert_eq!(part["type"], "video_url");
        assert!(
            part["video_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:video/mp4;base64,")
        );
        let _ = std::fs::remove_file(path);
    }
}
