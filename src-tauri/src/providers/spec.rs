//! Per-provider behaviour, one `impl` per provider file.
//!
//! Every LLM provider Nomi talks to is *mostly* OpenAI-compatible but disagrees
//! on the edges: the auth header (MiMo wants an extra `api-key:`), extra request
//! fields (Qwen's `enable_thinking`), how a reasoning delta is
//! named, how an image attachment is encoded (inline vs a Files-API upload), and
//! whether an account balance can be queried at all — and if so, from which
//! endpoint in which shape.
//!
//! Rather than scatter `if kind == "…"` branches across [`crate::llm`],
//! [`crate::chat_agent`] and [`crate::providers`], each provider gets one module
//! that implements [`ProviderSpec`]. The shared runtime resolves the spec once
//! (via [`spec_for`], keyed off [`crate::providers::ChatTarget::spec`]) and calls
//! the hooks at each seam. Adding a provider is: add a file, add one match arm —
//! nothing else changes, so one provider can't break another.
//!
//! Anything a provider doesn't special-case inherits the trait's default, which
//! is the plain OpenAI `/chat/completions` behaviour. [`generic::OpenAiCompatible`]
//! is that default made concrete for `openai` / `kimi` / `ollama` / `custom`.

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use super::{FetchedProviderModel, deepseek, generic, mimo, openrouter, qwen};
use crate::providers::ChatTarget;

// ── Balance DTO (the shape the webview renders) ──────────────────────────────
//
// One remaining figure with a currency, plus whatever breakdown the provider
// happened to give. Optional fields are omitted from the JSON when absent, so
// the frontend can treat "DeepSeek granted/toppedUp" and "OpenRouter
// credits/usage" as the same object and just render the keys that are present.

/// What one provider says is left in the account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBalance {
    /// What is left to spend, in `currency`.
    pub remaining: f64,
    /// ISO code as the provider reports it — `CNY` for DeepSeek, `USD` for OpenRouter.
    pub currency: String,
    /// DeepSeek: the promotional (expiring) part of `remaining`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub granted: Option<f64>,
    /// DeepSeek: the paid-for part of `remaining`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topped_up: Option<f64>,
    /// OpenRouter: credits bought to date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_credits: Option<f64>,
    /// OpenRouter: credits spent to date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_usage: Option<f64>,
    /// False once the account can no longer be charged for a call.
    pub is_available: bool,
    /// Any other currencies DeepSeek reported. Empty for everyone else.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub other_currencies: Vec<CurrencyBalance>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyBalance {
    pub currency: String,
    pub remaining: f64,
}

// ── The trait ────────────────────────────────────────────────────────────────

/// One provider's deviations from the plain OpenAI-compatible baseline. Every
/// method has a default that is the baseline behaviour, so a provider module
/// overrides only the seams where it actually differs.
#[async_trait]
pub(crate) trait ProviderSpec: Send + Sync {
    /// The model-catalogue endpoint. Providers may add query parameters needed
    /// to return non-text models instead of the OpenAI-compatible default view.
    fn models_url(&self, base_url: &str) -> String {
        format!("{}/models", base_url.trim().trim_end_matches('/'))
    }

    /// Fill catalogue metadata that the provider does not return over `/models`.
    /// The generic path keeps the parsed response unchanged.
    fn enrich_fetched_model(&self, model: FetchedProviderModel) -> FetchedProviderModel {
        model
    }

    /// The chat completions endpoint. Default: `{base}/chat/completions`.
    fn chat_url(&self, base_url: &str) -> String {
        default_chat_url(base_url)
    }

    /// Attach the auth header(s). Default: `Authorization: Bearer <key>`.
    fn apply_auth(&self, req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {api_key}"))
    }

    /// Add provider-specific fields to the `/chat/completions` body just before
    /// it is sent (e.g. Qwen's `enable_thinking`). Default: leave it untouched.
    fn decorate_body(&self, _body: &mut Value, _target: &ChatTarget) {}

    /// Apply the user's explicit reasoning selection. The generic OpenAI shape
    /// only sends `reasoning_effort` when thinking is enabled; providers whose
    /// models default to thinking must override this hook and send an explicit
    /// disabled value when `effort` is `None`.
    fn configure_reasoning(&self, body: &mut Value, _target: &ChatTarget, effort: Option<&str>) {
        if let Some(effort) = effort {
            body["reasoning_effort"] = Value::String(effort.to_string());
        }
    }

    /// The delta keys that carry streamed reasoning / chain-of-thought, tried in
    /// order. Default covers DeepSeek's `reasoning_content` and the `reasoning`
    /// some gateways use.
    fn reasoning_fields(&self) -> &'static [&'static str] {
        &["reasoning_content", "reasoning"]
    }

    /// Turn one image attachment into an OpenAI content part at build time.
    /// Default inlines it as a `data:` URL. This is the *per-image* seam; the
    /// *request-level* one below can then rewrite the finished array.
    fn image_part(&self, abs_path: &Path, mime: &str) -> Option<Value> {
        inline_image_part(abs_path, mime)
    }

    /// Rewrite the fully-assembled OpenAI `messages` array just before it is
    /// sent, once per request (so cross-message/budget decisions are possible).
    /// Default: return it untouched. DeepSeek overrides this to move oversized
    /// inline images to its Files API and swap them for `file_id` handles — a
    /// decision that depends on the *total* image budget, not one image, which
    /// is why it lives here rather than in [`image_part`](Self::image_part).
    async fn prepare_messages(
        &self,
        _target: &ChatTarget,
        messages: Vec<Value>,
    ) -> Result<Vec<Value>, String> {
        Ok(messages)
    }

    /// Look up the account balance. Default: this provider publishes none.
    async fn fetch_balance(
        &self,
        _base_url: &str,
        _api_key: &str,
    ) -> Result<ProviderBalance, String> {
        Err("该服务商不提供余额查询。".into())
    }

    /// Whether [`fetch_balance`](Self::fetch_balance) will return a figure. Used
    /// to gate the balance UI without making a request. Default: false.
    fn supports_balance(&self) -> bool {
        false
    }
}

/// Resolve a provider `kind` to its spec. Unknown / plain kinds fall back to the
/// OpenAI-compatible baseline. Returned reference is `'static` (each spec is a
/// zero-sized unit struct promoted to a constant).
pub(crate) fn spec_for(kind: &str) -> &'static dyn ProviderSpec {
    match kind {
        "deepseek" => &deepseek::DeepSeek,
        "openrouter" => &openrouter::OpenRouter,
        "qwen" => &qwen::Qwen,
        "mimo" => &mimo::Mimo,
        _ => &generic::OpenAiCompatible,
    }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

pub(crate) fn default_chat_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim().trim_end_matches('/'))
}

/// Read an image file and wrap it as an inline `image_url` data URL part.
pub(crate) fn inline_image_part(abs_path: &Path, mime: &str) -> Option<Value> {
    let bytes = std::fs::read(abs_path).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(
        json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{b64}") } }),
    )
}

/// A failed balance HTTP call, carrying the status so callers can branch on auth
/// failures (OpenRouter falls back from `/credits` to `/key` on 401/403).
pub(crate) struct HttpError {
    pub status: Option<u16>,
    pub message: String,
}

impl HttpError {
    /// Statuses that mean "this key may not ask this question" — the signal to
    /// fall back rather than give up.
    pub fn is_auth(&self) -> bool {
        matches!(self.status, Some(401 | 403))
    }
}

impl From<HttpError> for String {
    fn from(err: HttpError) -> String {
        err.message
    }
}

/// GET a JSON body with bearer auth and a 20s timeout. Balance responses are
/// tiny, so the whole body is read; a non-2xx becomes an [`HttpError`] that
/// keeps the status code for auth-fallback decisions.
pub(crate) async fn get_json<T: DeserializeOwned>(
    url: &str,
    api_key: &str,
) -> Result<T, HttpError> {
    let resp = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| HttpError {
            status: None,
            message: format!("请求失败：{e}"),
        })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(HttpError {
            status: Some(status.as_u16()),
            message: format!("接口返回 {status}：{snippet}"),
        });
    }
    serde_json::from_str(&text).map_err(|e| HttpError {
        status: Some(status.as_u16()),
        message: format!("无法解析余额响应：{e}"),
    })
}
