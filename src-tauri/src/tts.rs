//! Text-to-speech (朗读) for chat answers.
//!
//! One global voice model is configured in settings (`.nomi` data root →
//! `tts.json`): a provider + a speech model id + a voice id. Synthesis resolves
//! that provider through the same [`crate::providers::resolve_chat_target`] path
//! the chat runtime uses, so the API key never leaves the backend.
//!
//! Two provider dialects are supported:
//!   * MiniMax `t2a_v2` — bearer auth, JSON in, `data.audio` HEX-encoded out.
//!   * Everything else — the OpenAI-compatible `POST /audio/speech`, which
//!     returns the raw audio bytes directly.
//!
//! The command answers with base64 so the webview can play it via an `Audio`
//! element without touching the filesystem.

use std::{fs, path::PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::{providers, storage};

const TTS_FILE: &str = "tts.json";
/// Guards request size; comfortably above a single chat answer. MiniMax rejects
/// very long inputs, and reading a novel aloud in one shot is not the use case.
const MAX_CHARS: usize = 8_000;
/// Sentinel the frontend matches to show "configure a voice model" instead of a
/// raw error. Kept ASCII so the string compare on the UI side is unambiguous.
const NOT_CONFIGURED: &str = "TTS_NOT_CONFIGURED";

fn default_speed() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettings {
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    voice_id: String,
    #[serde(default = "default_speed")]
    speed: f64,
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            provider_id: None,
            model_id: None,
            voice_id: String::new(),
            speed: default_speed(),
        }
    }
}

/// Synthesised audio, base64-encoded so it crosses the IPC boundary as text.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAudio {
    mime: String,
    base64: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage::current_root(app)?.join(TTS_FILE))
}

fn read_settings(app: &AppHandle) -> Result<TtsSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(TtsSettings::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("无法读取朗读设置：{error}"))?;
    serde_json::from_str(&contents).map_err(|error| format!("朗读设置无法解析：{error}"))
}

fn write_settings(app: &AppHandle, settings: &TtsSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let mut contents = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("无法序列化朗读设置：{error}"))?;
    contents.push('\n');
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, contents).map_err(|error| format!("无法写入朗读设置：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法写入朗读设置：{error}"))
}

/// Keep the first `MAX_CHARS` characters (not bytes, so multibyte text is never
/// split mid-character).
fn truncate_chars(text: &str) -> String {
    text.chars().take(MAX_CHARS).collect()
}

fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.trim().as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err("语音数据长度异常。".into());
    }
    (0..bytes.len())
        .step_by(2)
        .map(|i| {
            let hi = (bytes[i] as char).to_digit(16);
            let lo = (bytes[i + 1] as char).to_digit(16);
            match (hi, lo) {
                (Some(hi), Some(lo)) => Ok((hi * 16 + lo) as u8),
                _ => Err("语音数据解析失败。".to_string()),
            }
        })
        .collect()
}

fn encode_audio(bytes: Vec<u8>, mime: &str) -> TtsAudio {
    TtsAudio {
        mime: mime.to_string(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

async fn minimax_tts(
    target: &providers::ChatTarget,
    api_key: &str,
    text: &str,
    settings: &TtsSettings,
) -> Result<TtsAudio, String> {
    let url = format!("{}/t2a_v2", target.base_url.trim().trim_end_matches('/'));
    let voice = settings.voice_id.trim();
    let voice = if voice.is_empty() {
        "male-qn-qingse"
    } else {
        voice
    };
    let body = json!({
        "model": target.model_id,
        "text": text,
        "stream": false,
        "voice_setting": {
            "voice_id": voice,
            "speed": settings.speed,
            "vol": 1.0,
            "pitch": 0
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1
        }
    });
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("请求 MiniMax 语音合成失败：{error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 MiniMax 语音结果失败：{error}"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        let text = String::from_utf8_lossy(&bytes);
        format!("MiniMax 语音结果无法解析：{error}；{text}")
    })?;
    let code = value
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if !status.is_success() || code != 0 {
        let message = value
            .pointer("/base_resp/status_msg")
            .or_else(|| value.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(format!("MiniMax 语音合成失败（{status}）：{message}"));
    }
    let hex = value
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .filter(|audio| !audio.is_empty())
        .ok_or("MiniMax 返回中缺少音频数据。")?;
    Ok(encode_audio(decode_hex(hex)?, "audio/mpeg"))
}

/// OpenAI-compatible `POST /audio/speech`, which returns raw audio bytes.
async fn openai_tts(
    target: &providers::ChatTarget,
    api_key: &str,
    text: &str,
    settings: &TtsSettings,
) -> Result<TtsAudio, String> {
    let url = format!(
        "{}/audio/speech",
        target.base_url.trim().trim_end_matches('/')
    );
    let voice = settings.voice_id.trim();
    let voice = if voice.is_empty() { "alloy" } else { voice };
    let body = json!({
        "model": target.model_id,
        "input": text,
        "voice": voice,
        "response_format": "mp3",
        "speed": settings.speed
    });
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("请求语音合成失败：{error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取语音结果失败：{error}"))?;
    if !status.is_success() {
        let message = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .or_else(|| value.pointer("/base_resp/status_msg"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(200).collect());
        return Err(format!("语音合成失败（{status}）：{message}"));
    }
    if bytes.is_empty() {
        return Err("语音服务返回了空音频。".into());
    }
    Ok(encode_audio(bytes.to_vec(), "audio/mpeg"))
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn tts_get_settings(app: AppHandle) -> Result<TtsSettings, String> {
    read_settings(&app)
}

#[tauri::command]
pub fn tts_set_settings(
    app: AppHandle,
    provider_id: Option<String>,
    model_id: Option<String>,
    voice_id: Option<String>,
    speed: Option<f64>,
) -> Result<TtsSettings, String> {
    let settings = TtsSettings {
        provider_id: provider_id.filter(|value| !value.trim().is_empty()),
        model_id: model_id.filter(|value| !value.trim().is_empty()),
        voice_id: voice_id.unwrap_or_default().trim().to_string(),
        speed: speed.unwrap_or(1.0).clamp(0.5, 2.0),
    };
    write_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn tts_synthesize(app: AppHandle, text: String) -> Result<TtsAudio, String> {
    let text = truncate_chars(text.trim());
    if text.is_empty() {
        return Err("没有可朗读的内容。".into());
    }
    let settings = read_settings(&app)?;
    let provider_id = settings
        .provider_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(NOT_CONFIGURED)?;
    let model_id = settings
        .model_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(NOT_CONFIGURED)?;
    let target = providers::resolve_chat_target(&app, &provider_id, &model_id)?;
    let api_key = target
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .ok_or("该语音服务商尚未填写 API 密钥。")?;
    match target.kind.as_str() {
        "minimax" => minimax_tts(&target, api_key, &text, &settings).await,
        _ => openai_tts(&target, api_key, &text, &settings).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_lowercase_and_uppercase() {
        assert_eq!(decode_hex("00ff1A").unwrap(), vec![0x00, 0xff, 0x1a]);
    }

    #[test]
    fn hex_rejects_odd_length() {
        assert!(decode_hex("abc").is_err());
    }

    #[test]
    fn truncate_keeps_whole_characters() {
        let text: String = "中".repeat(MAX_CHARS + 10);
        assert_eq!(truncate_chars(&text).chars().count(), MAX_CHARS);
    }
}
