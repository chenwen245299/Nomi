//! Qwen / Alibaba DashScope.
//!
//! DashScope's OpenAI-compatible endpoint rejects the standard `reasoning_effort`
//! field and gates thinking with its own `enable_thinking` boolean instead. Its
//! Qwen3 models also *default* to thinking on, so turning thinking off needs an
//! explicit `enable_thinking: false`. We therefore override `configure_reasoning`
//! (rather than let the default emit `reasoning_effort`) and always send an
//! explicit boolean: on when the user picked an effort, off otherwise. The
//! streamed reasoning comes back as `reasoning_content`, which the default
//! `reasoning_fields` already reads.
//!
//! Ported from Argus's `llm.rs` (the `is_qwen` branch of thinking handling).

use serde_json::{Value, json};

use super::spec::ProviderSpec;
use crate::providers::ChatTarget;

pub(crate) struct Qwen;

impl ProviderSpec for Qwen {
    fn configure_reasoning(&self, body: &mut Value, _target: &ChatTarget, effort: Option<&str>) {
        // Never send OpenAI's `reasoning_effort` (DashScope 400s on it); express
        // the choice as `enable_thinking`, explicitly `false` to override the
        // Qwen3 thinking-on default when the user turned thinking off.
        body["enable_thinking"] = json!(effort.is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ChatTarget {
        ChatTarget {
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            provider_name: "Qwen".into(),
            kind: "qwen".into(),
            api_key: Some("sk-test".into()),
            model_id: "qwen3-max".into(),
            supports_tools: false,
            supports_vision: false,
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
    fn an_effort_enables_thinking_and_never_sends_reasoning_effort() {
        let mut body = json!({ "model": "qwen3-max" });
        Qwen.configure_reasoning(&mut body, &target(), Some("high"));
        assert_eq!(body["enable_thinking"], json!(true));
        assert!(
            body.get("reasoning_effort").is_none(),
            "DashScope rejects reasoning_effort"
        );
    }

    #[test]
    fn no_effort_explicitly_disables_thinking() {
        let mut body = json!({ "model": "qwen3-max" });
        Qwen.configure_reasoning(&mut body, &target(), None);
        assert_eq!(body["enable_thinking"], json!(false));
        assert!(body.get("reasoning_effort").is_none());
    }
}
