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
    /// Provider-native structured reasoning. MiniMax requires the exact value
    /// to be replayed when an assistant tool call is followed by tool results.
    pub reasoning_details: Option<Value>,
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
    let has_tools = tools.is_some_and(|t| !t.is_empty());
    if let Some(tools) = tools
        && has_tools
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

    // Some models (MiniMax-M3) drop large tool_calls over their streaming endpoint,
    // so a tool-enabled turn is sent non-streaming and parsed from one JSON body.
    if spec.requires_non_streaming_tool_calls(target, has_tools) {
        body["stream"] = Value::Bool(false);
        if let Some(object) = body.as_object_mut() {
            object.remove("stream_options");
        }
        return non_stream_chat(spec, target, &body, channel, cancel).await;
    }

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
    // Keep incomplete SSE data as bytes. A network chunk may end in the middle
    // of a multi-byte UTF-8 scalar (very common for CJK text); decoding each
    // chunk independently would replace both halves with U+FFFD and permanently
    // save visible `�` characters into the conversation.
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    let mut done = false;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            turn.cancelled = true;
            break;
        }
        let bytes = chunk.map_err(|e| format!("读取模型响应失败：{e}"))?;
        buf.extend_from_slice(&bytes);

        // SSE frames are newline-delimited; process every complete line and keep
        // the trailing partial bytes in `buf` for the next chunk. Only decode
        // after a full line has been assembled, so split UTF-8 characters remain
        // intact across arbitrary transport boundaries.
        while let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
            let mut line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            line_bytes.pop(); // `\n`
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop();
            }
            let line = std::str::from_utf8(&line_bytes)
                .map_err(|e| format!("模型响应包含无效 UTF-8 数据：{e}"))?
                .trim();
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
                spec.streaming_text_is_cumulative(),
                spec.streaming_reasoning_is_cumulative(),
            );
        }
        if done {
            break;
        }
    }

    Ok(turn)
}

/// Send one chat completion with `stream:false` and build the same
/// [`AssistantTurn`] a streamed turn would, emitting the equivalent
/// [`StreamEvent`]s so the frontend still renders content, reasoning and tool
/// calls. Used for models whose streaming endpoint drops tool calls (MiniMax-M3).
async fn non_stream_chat(
    spec: &dyn crate::providers::ProviderSpec,
    target: &ChatTarget,
    body: &Value,
    channel: &tauri::ipc::Channel<StreamEvent>,
    cancel: &Arc<AtomicBool>,
) -> Result<AssistantTurn, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .post(spec.chat_url(&target.base_url))
        .header("Content-Type", "application/json")
        .json(body);
    if let Some(key) = target.api_key.as_deref()
        && !key.is_empty()
    {
        req = spec.apply_auth(req, key);
    }
    let resp = req.send().await.map_err(|e| format!("请求模型失败：{e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取模型响应失败：{e}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(400).collect();
        return Err(format!("模型接口返回 {status}：{snippet}"));
    }
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("无法解析模型响应：{e}"))?;
    if let Some(err) = json.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("模型返回错误：{msg}"));
    }

    if cancel.load(Ordering::Relaxed) {
        return Ok(AssistantTurn {
            cancelled: true,
            ..Default::default()
        });
    }

    let turn = build_turn_from_message(&json, spec.reasoning_fields());
    // Replay the built turn as the same events a streamed turn would emit, so the
    // frontend renders reasoning, content and the tool call identically. The
    // emitted index matches the slot in `turn.tool_calls` (empty-name calls are
    // dropped before the push), so it never drifts from the accumulated list.
    if !turn.reasoning.is_empty() {
        let _ = channel.send(StreamEvent::Reasoning {
            delta: turn.reasoning.clone(),
        });
    }
    if !turn.content.is_empty() {
        let _ = channel.send(StreamEvent::Text {
            delta: turn.content.clone(),
        });
    }
    for (index, call) in turn.tool_calls.iter().enumerate() {
        let _ = channel.send(StreamEvent::ToolCallStart {
            index: index as u32,
            id: call.id.clone(),
            name: call.name.clone(),
        });
        if !call.arguments.is_empty() {
            let _ = channel.send(StreamEvent::ToolCallArgs {
                index: index as u32,
                delta: call.arguments.clone(),
            });
        }
    }

    Ok(turn)
}

/// Build an [`AssistantTurn`] from a non-streaming `choices[0].message` body,
/// mirroring what [`apply_chunk`] accumulates from a stream: visible reasoning
/// prefers `reasoning_content` / `reasoning`, and otherwise falls back to the text
/// inside `reasoning_details` (which is also kept verbatim for replay). Pure and
/// channel-free so it can be unit-tested.
fn build_turn_from_message(json: &Value, reasoning_fields: &[&str]) -> AssistantTurn {
    let mut turn = AssistantTurn::default();
    if let Some(usage) = json.get("usage").filter(|value| value.is_object()) {
        turn.usage = Some(parse_usage(usage));
    }
    let choice = &json["choices"][0];
    turn.finish_reason = choice["finish_reason"].as_str().map(str::to_string);
    let message = &choice["message"];

    if let Some(content) = message["content"].as_str() {
        turn.content = content.to_string();
    }

    let direct_reasoning = reasoning_fields
        .iter()
        .find_map(|field| message[*field].as_str())
        .filter(|text| !text.is_empty());
    if let Some(details) = message
        .get("reasoning_details")
        .filter(|value| !value.is_null())
    {
        turn.reasoning_details = Some(details.clone());
    }
    turn.reasoning = match direct_reasoning {
        Some(text) => text.to_string(),
        None => message
            .get("reasoning_details")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<String>(),
    };

    if let Some(tool_calls) = message["tool_calls"].as_array() {
        for call in tool_calls {
            let name = call["function"]["name"].as_str().unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            turn.tool_calls.push(AccumulatedToolCall {
                id: call["id"].as_str().unwrap_or_default().to_string(),
                name: name.to_string(),
                arguments: call["function"]["arguments"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    turn
}

/// Fold one streamed `choices[0].delta` chunk into the turn, emitting events.
fn apply_chunk(
    json: &Value,
    turn: &mut AssistantTurn,
    started: &mut Vec<bool>,
    channel: &tauri::ipc::Channel<StreamEvent>,
    reasoning_fields: &[&str],
    text_is_cumulative: bool,
    reasoning_is_cumulative: bool,
) {
    let choice = &json["choices"][0];
    if let Some(fr) = choice["finish_reason"].as_str() {
        turn.finish_reason = Some(fr.to_string());
    }
    let delta = &choice["delta"];

    if let Some(text) = delta["content"].as_str()
        && !text.is_empty()
    {
        let addition = if text_is_cumulative {
            text.strip_prefix(&turn.content).unwrap_or(text)
        } else {
            text
        };
        if !addition.is_empty() {
            turn.content.push_str(addition);
            let _ = channel.send(StreamEvent::Text {
                delta: addition.to_string(),
            });
        }
    }

    // Reasoning delta key varies by provider (DeepSeek `reasoning_content`, some
    // gateways `reasoning`); the spec supplies the keys to try, in order.
    let direct_reasoning = reasoning_fields
        .iter()
        .find_map(|field| delta[*field].as_str())
        .filter(|s| !s.is_empty());
    if let Some(r) = direct_reasoning {
        let addition = if reasoning_is_cumulative {
            r.strip_prefix(&turn.reasoning).unwrap_or(r)
        } else {
            r
        };
        if !addition.is_empty() {
            turn.reasoning.push_str(addition);
            let _ = channel.send(StreamEvent::Reasoning {
                delta: addition.to_string(),
            });
        }
    }

    // MiniMax can return structured reasoning alongside interleaved tool use.
    // Keep the native object for exact replay. When it is the only reasoning
    // field, derive the visible text by taking the suffix of its cumulative
    // textual representation, avoiding duplicate UI deltas.
    if let Some(details) = delta
        .get("reasoning_details")
        .filter(|value| !value.is_null())
    {
        turn.reasoning_details = Some(details.clone());
        if direct_reasoning.is_none() {
            let text = details
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<String>();
            let addition = text.strip_prefix(&turn.reasoning).unwrap_or(&text);
            if !addition.is_empty() {
                turn.reasoning.push_str(addition);
                let _ = channel.send(StreamEvent::Reasoning {
                    delta: addition.to_string(),
                });
            }
        }
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

    #[test]
    fn cumulative_minimax_chunks_only_append_the_new_suffix() {
        let mut turn = AssistantTurn::default();
        let mut started = Vec::new();
        for (content, reasoning) in [("你", "先"), ("你好", "先想"), ("你好。", "先想好")]
        {
            apply_chunk(
                &serde_json::json!({
                    "choices": [{
                        "delta": {
                            "content": content,
                            "reasoning_content": reasoning,
                            "reasoning_details": [{ "type": "reasoning.text", "text": reasoning }]
                        },
                        "finish_reason": null
                    }]
                }),
                &mut turn,
                &mut started,
                &sink(),
                &["reasoning_content"],
                true,
                true,
            );
        }
        assert_eq!(turn.content, "你好。");
        assert_eq!(turn.reasoning, "先想好");
        assert_eq!(turn.reasoning_details.unwrap()[0]["text"], "先想好");
    }

    #[test]
    fn non_stream_message_recovers_reasoning_and_tool_calls() {
        // Mirrors MiniMax-M3's non-streaming body: reasoning only in
        // reasoning_details (no reasoning_content), and the tool call that its
        // streaming endpoint drops. finish_reason "stop" must not hide the call.
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "好的，正在为你生成 PDF。",
                    "reasoning_details": [{ "type": "reasoning.text", "text": "用户要导出 PDF，调用工具。" }],
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "create_markdown_document",
                            "arguments": "{\"markdown\":\"# 新闻\"}"
                        }
                    }]
                }
            }],
            "usage": { "prompt_tokens": 2084, "completion_tokens": 545, "total_tokens": 2629 }
        });
        let turn = build_turn_from_message(&json, &["reasoning_content", "reasoning"]);
        assert_eq!(turn.content, "好的，正在为你生成 PDF。");
        // reasoning_details-only still surfaces visible reasoning text
        assert_eq!(turn.reasoning, "用户要导出 PDF，调用工具。");
        assert!(turn.reasoning_details.is_some());
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "create_markdown_document");
        assert_eq!(turn.tool_calls[0].arguments, "{\"markdown\":\"# 新闻\"}");
        assert_eq!(turn.finish_reason.as_deref(), Some("stop"));
        assert_eq!(turn.usage.unwrap().completion_tokens, 545);
    }

    #[test]
    fn non_stream_prefers_reasoning_content_and_skips_nameless_calls() {
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "",
                    "reasoning_content": "直接推理",
                    "reasoning_details": [{ "text": "detail" }],
                    "tool_calls": [
                        { "id": "x", "function": { "name": "", "arguments": "{}" } },
                        { "id": "y", "function": { "name": "web_search", "arguments": "{\"query\":\"a\"}" } }
                    ]
                }
            }]
        });
        let turn = build_turn_from_message(&json, &["reasoning_content", "reasoning"]);
        assert_eq!(turn.reasoning, "直接推理"); // prefers reasoning_content over details
        assert_eq!(turn.tool_calls.len(), 1); // the empty-name call is dropped
        assert_eq!(turn.tool_calls[0].name, "web_search");
    }

    /// A throwaway HTTP server that answers exactly one request with an OpenAI
    /// streaming (SSE) body. `first`/`rest` are written as two TCP writes with a
    /// pause between them, so the parser's cross-chunk buffering is exercised and
    /// a mid-stream cancel has a window to fire. Returns the bound port.
    async fn mock_sse_bytes(first: Vec<u8>, rest: Vec<u8>, gap_ms: u64) -> u16 {
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
            let _ = socket.write_all(&first).await;
            let _ = socket.flush().await;
            if !rest.is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(gap_ms)).await;
                let _ = socket.write_all(&rest).await;
                let _ = socket.flush().await;
            }
            // Dropping the socket closes the connection → reqwest sees EOF.
        });
        port
    }

    async fn mock_sse(first: &'static str, rest: &'static str, gap_ms: u64) -> u16 {
        mock_sse_bytes(first.as_bytes().to_vec(), rest.as_bytes().to_vec(), gap_ms).await
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
    async fn preserves_utf8_when_a_character_is_split_between_network_chunks() {
        let mut response = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"与最小最大熵原理\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes()
        .to_vec();
        let entropy_start = response
            .windows("熵".len())
            .position(|window| window == "熵".as_bytes())
            .expect("the Chinese character should be present in the fixture");
        let rest = response.split_off(entropy_start + 1);
        let port = mock_sse_bytes(response, rest, 20).await;
        let cancel = Arc::new(AtomicBool::new(false));

        let turn = stream_chat(&target(port), &[], None, None, &sink(), &cancel)
            .await
            .expect("split UTF-8 should be reassembled before decoding");

        assert_eq!(turn.content, "与最小最大熵原理");
        assert!(!turn.content.contains('\u{fffd}'));
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
