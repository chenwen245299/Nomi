//! Zhipu AI / BigModel OpenAI-compatible API.
//!
//! GLM-5.3-Flash accepts the same `image_url` content parts as OpenAI, including
//! base64 data URLs, so Nomi's default image encoder is already the correct
//! transport. The current GLM-5.3 family differs in three important ways:
//!
//! * thinking is mandatory (`thinking.type = enabled`) and supports low/high/max;
//! * tool calls in a streamed response require `tool_stream = true`;
//! * interleaved tool use must replay the assistant's `reasoning_content` before
//!   the matching tool result.
//!
//! Refs: <https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash>,
//! <https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode>,
//! <https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool>

use serde_json::{Value, json};

use super::spec::ProviderSpec;
use crate::providers::{ChatTarget, FetchedProviderModel};

pub(crate) struct Zhipu;

fn normalized_model_id(model_id: &str) -> String {
    model_id.trim().to_ascii_lowercase()
}

fn is_glm_53(model_id: &str) -> bool {
    matches!(
        normalized_model_id(model_id).as_str(),
        "glm-5.3" | "glm-5.3-flash"
    )
}

fn supports_optional_thinking(model_id: &str) -> bool {
    let model = normalized_model_id(model_id);
    model.starts_with("glm-5")
        || model.starts_with("glm-4.5")
        || model.starts_with("glm-4.6")
        || model.starts_with("glm-4.7")
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|candidate| candidate == value) {
        values.push(value.to_string());
    }
}

impl ProviderSpec for Zhipu {
    fn enrich_fetched_model(&self, mut model: FetchedProviderModel) -> FetchedProviderModel {
        let id = normalized_model_id(&model.id);
        if id == "glm-5.3-flash" {
            model.category = "vision".into();
            model.context_length.get_or_insert(1_000_000);
            for capability in ["image", "video", "tool", "reasoning"] {
                push_unique(&mut model.capabilities, capability);
            }
            for modality in ["text", "image", "video", "file"] {
                push_unique(&mut model.input_modalities, modality);
            }
            push_unique(&mut model.output_modalities, "text");
        } else if id == "glm-5.3" {
            if model.category.is_empty() {
                model.category = "text".into();
            }
            model.context_length.get_or_insert(1_000_000);
            for capability in ["tool", "reasoning"] {
                push_unique(&mut model.capabilities, capability);
            }
            push_unique(&mut model.input_modalities, "text");
            push_unique(&mut model.output_modalities, "text");
        }
        model
    }

    fn configure_reasoning(&self, body: &mut Value, target: &ChatTarget, effort: Option<&str>) {
        if is_glm_53(&target.model_id) {
            body["thinking"] = json!({
                "type": "enabled",
                "clear_thinking": false
            });
            body["reasoning_effort"] = Value::String(effort.unwrap_or("max").to_string());
            return;
        }

        // Older reasoning-capable GLM models may still be switched off. Avoid
        // sending a `thinking` object to unrelated models that do not expose it.
        if supports_optional_thinking(&target.model_id) {
            body["thinking"] = json!({
                "type": if effort.is_some() { "enabled" } else { "disabled" }
            });
            if let Some(effort) = effort {
                body["reasoning_effort"] = Value::String(effort.to_string());
            }
        }
    }

    fn decorate_body(&self, body: &mut Value, target: &ChatTarget) {
        if is_glm_53(&target.model_id)
            && body.get("tools").is_some_and(Value::is_array)
            && body.get("stream").and_then(Value::as_bool) == Some(true)
        {
            body["tool_stream"] = json!(true);
        }
    }

    fn attach_reasoning_to_assistant_message(
        &self,
        message: &mut Value,
        reasoning: &str,
        _reasoning_details: Option<&Value>,
    ) {
        if !reasoning.is_empty() {
            message["reasoning_content"] = Value::String(reasoning.to_string());
        }
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
            base_url: "https://open.bigmodel.cn/api/paas/v4".into(),
            provider_name: "智谱".into(),
            kind: "zhipu".into(),
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
    fn flash_catalogue_entry_is_enriched_as_native_multimodal() {
        let model = Zhipu.enrich_fetched_model(fetched("glm-5.3-flash"));
        assert_eq!(model.category, "vision");
        assert_eq!(model.context_length, Some(1_000_000));
        assert_eq!(model.capabilities, ["image", "video", "tool", "reasoning"]);
        assert_eq!(model.input_modalities, ["text", "image", "video", "file"]);
        assert_eq!(model.output_modalities, ["text"]);
    }

    #[test]
    fn glm_53_thinking_is_mandatory_and_defaults_to_max() {
        let mut body = json!({ "model": "glm-5.3-flash" });
        Zhipu.configure_reasoning(&mut body, &target("glm-5.3-flash"), None);
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["clear_thinking"], false);
        assert_eq!(body["reasoning_effort"], "max");
    }

    #[test]
    fn glm_53_streaming_tools_enable_tool_stream() {
        let mut body = json!({
            "model": "glm-5.3-flash",
            "stream": true,
            "tools": [{ "type": "function" }]
        });
        Zhipu.decorate_body(&mut body, &target("glm-5.3-flash"));
        assert_eq!(body["tool_stream"], true);
    }

    #[test]
    fn reasoning_is_replayed_on_assistant_tool_messages() {
        let mut message = json!({ "role": "assistant", "tool_calls": [] });
        Zhipu.attach_reasoning_to_assistant_message(&mut message, "reasoning", None);
        assert_eq!(message["reasoning_content"], "reasoning");
    }
}
