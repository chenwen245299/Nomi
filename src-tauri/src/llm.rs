//! OpenAI-compatible streaming chat completions for the in-app chat runtime.
//!
//! Covers the OpenAI `/chat/completions` shape (openai / deepseek / openrouter /
//! qwen / kimi / ollama-compat / custom). Anthropic-native is out of scope for
//! now. The provider's API key is read in `crate::providers` and passed in as
//! part of a [`ChatTarget`], so it never touches the webview.
//!
//! One streamed turn is accumulated into an [`AssistantTurn`]; the caller
//! (`crate::chat_agent`) decides whether the turn's `tool_calls` mean it should
//! run the tools and loop again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;

use crate::providers::ChatTarget;

/// Events streamed to the frontend over a Tauri channel as a turn is produced.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// A chunk of assistant answer text.
    Text { delta: String },
    /// A chunk of model reasoning / chain-of-thought (when the provider streams it).
    Reasoning { delta: String },
    /// A tool call has begun; its arguments follow as `ToolCallArgs`.
    ToolCallStart {
        index: u32,
        id: String,
        name: String,
    },
    /// A chunk of a tool call's JSON arguments.
    ToolCallArgs { index: u32, delta: String },
    /// A tool finished executing (emitted by the agent, not the stream parser).
    ToolResult {
        id: String,
        ok: bool,
        summary: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        images: Vec<String>,
    },
    /// Token usage for the exchange (emitted once at the end by the agent). Cache
    /// fields are present for providers that report them (e.g. DeepSeek).
    // The enum-level `rename_all` only renames the variant *tag*, not struct-variant
    // fields, so each multi-word variant needs its own `rename_all` for camelCase.
    #[serde(rename_all = "camelCase")]
    Usage {
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_hit_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_miss_tokens: Option<u64>,
        provider_name: String,
        model_id: String,
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_cny: Option<f64>,
        /// Provider-reported charge in USD (OpenRouter credits), when the provider
        /// returns one. The real charge, as opposed to `cost_cny`'s local estimate.
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pricing_period: Option<String>,
    },
    /// The `create_markdown_document` tool asks the frontend webview to render
    /// Markdown into PDF/PNG bytes (the one place with an offline, high-fidelity
    /// CJK + KaTeX + tables + code pipeline). The frontend renders off-screen and
    /// replies via the `submit_render_result` command, keyed by `render_id`.
    #[serde(rename_all = "camelCase")]
    RenderRequest {
        render_id: String,
        markdown: String,
        /// Subset of ["pdf", "png"].
        formats: Vec<String>,
        /// "a4" | "letter".
        page_size: String,
        title: String,
    },
    /// The whole exchange is finished; `message_id` identifies the saved reply.
    #[serde(rename_all = "camelCase")]
    Done { message_id: String },
    /// The exchange failed; `message` is user-facing.
    Error { message: String },
}

/// Token usage reported by the provider. DeepSeek adds `prompt_cache_hit_tokens`
/// / `prompt_cache_miss_tokens`; other providers may omit the cache fields.
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_hit_tokens: Option<u64>,
    pub cache_miss_tokens: Option<u64>,
    /// Provider-reported charge in USD, when present (OpenRouter's `usage.cost`).
    pub cost: Option<f64>,
}

fn parse_usage(u: &Value) -> Usage {
    Usage {
        prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
        completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
        total_tokens: u["total_tokens"].as_u64().unwrap_or(0),
        cache_hit_tokens: u["prompt_cache_hit_tokens"].as_u64(),
        cache_miss_tokens: u["prompt_cache_miss_tokens"].as_u64(),
        // OpenRouter reports the actual credits spent here when asked (usage.include).
        cost: u["cost"].as_f64(),
    }
}

/// A tool call accumulated from streamed deltas.
#[derive(Debug, Clone, Default)]
pub struct AccumulatedToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// The result of one streamed model turn.
#[derive(Debug, Clone, Default)]
pub struct AssistantTurn {
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<AccumulatedToolCall>,
    /// The provider's `finish_reason` ("stop", "tool_calls", "length", …).
    pub finish_reason: Option<String>,
    /// Token usage from the final `usage` chunk, when the provider reports it.
    pub usage: Option<Usage>,
    /// True if the caller's cancel flag was tripped mid-stream.
    pub cancelled: bool,
}

/// Stream one chat completion, emitting [`StreamEvent`]s and returning the
/// accumulated turn. `messages` and `tools` are already in OpenAI JSON shape.
pub async fn stream_chat(
    target: &ChatTarget,
    messages: &[Value],
    tools: Option<&[Value]>,
    reasoning_effort: Option<&str>,
    channel: &tauri::ipc::Channel<StreamEvent>,
    cancel: &Arc<AtomicBool>,
) -> Result<AssistantTurn, String> {
    let spec = target.spec();
    // Per-provider request rewrite before anything else is assembled — e.g.
    // DeepSeek uploads oversized inline images to its Files API and swaps them
    // for file_id handles. Default: the array comes back unchanged.
    let messages = spec.prepare_messages(target, messages.to_vec()).await?;
    let mut body = serde_json::json!({
        "model": target.model_id,
        "messages": messages,
        "stream": true,
        // Ask for a final usage chunk (prompt/completion tokens, and DeepSeek's
        // cache hit/miss counts). Standard OpenAI streaming option.
        "stream_options": { "include_usage": true },
    });
    if let Some(tools) = tools
        && !tools.is_empty()
    {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = Value::String("auto".into());
    }
    // Reasoning defaults differ by provider. Let each spec turn an explicit UI
    // selection (including "off" as `None`) into the correct request fields.
    spec.configure_reasoning(&mut body, target, reasoning_effort);
    // Other provider-specific request fields are added last so the spec sees
    // the fully assembled body.
    spec.decorate_body(&mut body, target);

    let client = reqwest::Client::new();
    let mut req = client
        .post(spec.chat_url(&target.base_url))
        .header("Content-Type", "application/json")
        .json(&body);
    if let Some(key) = target.api_key.as_deref()
        && !key.is_empty()
    {
        req = spec.apply_auth(req, key);
    }

    let resp = req.send().await.map_err(|e| format!("请求模型失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(400).collect();
        return Err(format!("模型接口返回 {status}：{snippet}"));
    }

    let mut turn = AssistantTurn::default();
    let mut started: Vec<bool> = Vec::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    let mut done = false;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            turn.cancelled = true;
            break;
        }
        let bytes = chunk.map_err(|e| format!("读取模型响应失败：{e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        // SSE frames are newline-delimited; process every complete line and keep
        // the trailing partial one in `buf` for the next chunk.
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                done = true;
                break;
            }
            let Ok(json) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(err) = json.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("未知错误");
                return Err(format!("模型返回错误：{msg}"));
            }
            // The final chunk carries `usage` (with empty `choices`); capture it.
            if let Some(u) = json.get("usage")
                && u.is_object()
            {
                turn.usage = Some(parse_usage(u));
            }
            apply_chunk(
                &json,
                &mut turn,
                &mut started,
                channel,
                spec.reasoning_fields(),
            );
        }
        if done {
            break;
        }
    }

    Ok(turn)
}

/// Fold one streamed `choices[0].delta` chunk into the turn, emitting events.
fn apply_chunk(
    json: &Value,
    turn: &mut AssistantTurn,
    started: &mut Vec<bool>,
    channel: &tauri::ipc::Channel<StreamEvent>,
    reasoning_fields: &[&str],
) {
    let choice = &json["choices"][0];
    if let Some(fr) = choice["finish_reason"].as_str() {
        turn.finish_reason = Some(fr.to_string());
    }
    let delta = &choice["delta"];

    if let Some(text) = delta["content"].as_str()
        && !text.is_empty()
    {
        turn.content.push_str(text);
        let _ = channel.send(StreamEvent::Text {
            delta: text.to_string(),
        });
    }

    // Reasoning delta key varies by provider (DeepSeek `reasoning_content`, some
    // gateways `reasoning`); the spec supplies the keys to try, in order.
    if let Some(r) = reasoning_fields
        .iter()
        .find_map(|field| delta[*field].as_str())
        .filter(|s| !s.is_empty())
    {
        turn.reasoning.push_str(r);
        let _ = channel.send(StreamEvent::Reasoning {
            delta: r.to_string(),
        });
    }

    if let Some(tool_calls) = delta["tool_calls"].as_array() {
        for tc in tool_calls {
            let index = tc["index"].as_u64().unwrap_or(0) as usize;
            while turn.tool_calls.len() <= index {
                turn.tool_calls.push(AccumulatedToolCall::default());
                started.push(false);
            }
            let slot = &mut turn.tool_calls[index];
            if let Some(id) = tc["id"].as_str()
                && !id.is_empty()
            {
                slot.id = id.to_string();
            }
            if let Some(name) = tc["function"]["name"].as_str()
                && !name.is_empty()
            {
                slot.name.push_str(name);
            }
            // Emit the start once we know the tool's name.
            if !started[index] && !slot.name.is_empty() {
                started[index] = true;
                let _ = channel.send(StreamEvent::ToolCallStart {
                    index: index as u32,
                    id: slot.id.clone(),
                    name: slot.name.clone(),
                });
            }
            if let Some(args) = tc["function"]["arguments"].as_str()
                && !args.is_empty()
            {
                slot.arguments.push_str(args);
                let _ = channel.send(StreamEvent::ToolCallArgs {
                    index: index as u32,
                    delta: args.to_string(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ChatTarget;
    use tauri::ipc::Channel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The frontend reads camelCase off StreamEvents, so struct-variant fields must
    /// serialise camelCase. The enum-level `rename_all` only renames the variant
    /// tag, so each multi-word variant carries its own — a miss silently sends
    /// snake_case (which broke `create_markdown_document`'s render round-trip).
    #[test]
    fn stream_events_serialize_camel_case_fields() {
        let render = serde_json::to_value(StreamEvent::RenderRequest {
            render_id: "r1".into(),
            markdown: "# hi".into(),
            formats: vec!["pdf".into()],
            page_size: "a4".into(),
            title: "t".into(),
        })
        .unwrap();
        assert_eq!(render["type"], "renderRequest");
        assert_eq!(render["renderId"], "r1");
        assert_eq!(render["pageSize"], "a4");
        assert!(render.get("render_id").is_none());

        let usage = serde_json::to_value(StreamEvent::Usage {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            cache_hit_tokens: None,
            cache_miss_tokens: None,
            provider_name: "p".into(),
            model_id: "m".into(),
            duration_ms: 4,
            cost_cny: None,
            cost_usd: None,
            pricing_period: None,
        })
        .unwrap();
        assert_eq!(usage["promptTokens"], 1);
        assert_eq!(usage["providerName"], "p");
        assert_eq!(usage["modelId"], "m");

        let done = serde_json::to_value(StreamEvent::Done {
            message_id: "msg1".into(),
        })
        .unwrap();
        assert_eq!(done["messageId"], "msg1");
    }

    /// A throwaway HTTP server that answers exactly one request with an OpenAI
    /// streaming (SSE) body. `first`/`rest` are written as two TCP writes with a
    /// pause between them, so the parser's cross-chunk buffering is exercised and
    /// a mid-stream cancel has a window to fire. Returns the bound port.
    async fn mock_sse(first: &'static str, rest: &'static str, gap_ms: u64) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut scratch = [0u8; 2048];
            let _ = socket.read(&mut scratch).await; // consume the request line/headers
            let header =
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(first.as_bytes()).await;
            let _ = socket.flush().await;
            if !rest.is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(gap_ms)).await;
                let _ = socket.write_all(rest.as_bytes()).await;
                let _ = socket.flush().await;
            }
            // Dropping the socket closes the connection → reqwest sees EOF.
        });
        port
    }

    fn target(port: u16) -> ChatTarget {
        ChatTarget {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            provider_name: "Mock".into(),
            kind: "openai".into(),
            api_key: Some("test-key".into()),
            model_id: "mock-model".into(),
            supports_tools: false,
            supports_vision: false,
            input_price: None,
            output_price: None,
            cache_hit_input_price: None,
            peak_pricing_enabled: false,
            peak_input_price: None,
            peak_output_price: None,
            peak_cache_hit_input_price: None,
            peak_start_hour: None,
            peak_end_hour: None,
        }
    }

    fn sink() -> Channel<StreamEvent> {
        // A programmatic channel with a no-op receiver: proves the turn completes
        // even when nothing is listening (the UI having navigated away).
        Channel::new(|_body| Ok(()))
    }

    #[tokio::test]
    async fn streams_a_turn_to_completion() {
        // Split mid-JSON-line so the buffer must stitch the two TCP writes together.
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel";
        let rest = "lo\"},\"finish_reason\":null}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\", world\"},\"finish_reason\":null}]}\n\n\
                    data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                    data: [DONE]\n\n";
        let port = mock_sse(first, rest, 20).await;
        let cancel = Arc::new(AtomicBool::new(false));

        let turn = stream_chat(&target(port), &[], None, None, &sink(), &cancel)
            .await
            .expect("stream should succeed");

        assert_eq!(turn.content, "Hello, world");
        assert_eq!(turn.finish_reason.as_deref(), Some("stop"));
        assert!(!turn.cancelled);
    }

    #[tokio::test]
    async fn accumulates_streamed_tool_calls() {
        let first = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_pdf_fulltext\",\"arguments\":\"{\\\"att\"}}]},\"finish_reason\":null}]}\n\n";
        let rest = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"achment_id\\\":\\\"a1\\\"}\"}}]},\"finish_reason\":null}]}\n\n\
                    data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
                    data: [DONE]\n\n";
        let port = mock_sse(first, rest, 20).await;
        let cancel = Arc::new(AtomicBool::new(false));

        let turn = stream_chat(&target(port), &[], None, None, &sink(), &cancel)
            .await
            .expect("stream should succeed");

        assert_eq!(turn.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "get_pdf_fulltext");
        assert_eq!(turn.tool_calls[0].arguments, "{\"attachment_id\":\"a1\"}");
    }

    #[tokio::test]
    async fn captures_usage_and_cache_tokens() {
        // DeepSeek emits a final chunk with empty `choices` and a `usage` object
        // carrying prompt cache hit/miss counts.
        let first =
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n";
        let rest = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                    data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"total_tokens\":120,\"prompt_cache_hit_tokens\":64,\"prompt_cache_miss_tokens\":36}}\n\n\
                    data: [DONE]\n\n";
        let port = mock_sse(first, rest, 20).await;
        let cancel = Arc::new(AtomicBool::new(false));

        let turn = stream_chat(&target(port), &[], None, None, &sink(), &cancel)
            .await
            .expect("stream should succeed");

        let usage = turn.usage.expect("usage should be captured");
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 20);
        assert_eq!(usage.cache_hit_tokens, Some(64));
        assert_eq!(usage.cache_miss_tokens, Some(36));
    }

    #[tokio::test]
    async fn cancel_flag_stops_the_stream() {
        // First token arrives immediately; the rest is delayed well past when the
        // background task trips the cancel flag.
        let first =
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n";
        let rest = "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n\
                    data: [DONE]\n\n";
        let port = mock_sse(first, rest, 400).await;
        let cancel = Arc::new(AtomicBool::new(false));

        let flag = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            flag.store(true, Ordering::Relaxed);
        });

        let turn = stream_chat(&target(port), &[], None, None, &sink(), &cancel)
            .await
            .expect("stream should return the partial turn");

        assert!(turn.cancelled, "the turn should report it was cancelled");
        assert_eq!(
            turn.content, "Hello",
            "only the pre-cancel token should be kept"
        );
    }
}
