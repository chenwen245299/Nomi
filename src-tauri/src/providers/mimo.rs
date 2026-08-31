//! Xiaomi MiMo.
//!
//! Two OpenAI-compatible deviations, both ported from Argus's `mimo.rs` /
//! `llm.rs`:
//!   * Auth — MiMo's gateway reads the key from an `api-key:` header, but also
//!     tolerates the standard `Authorization: Bearer`. We send both so the same
//!     provider config works whichever the gateway happens to read.
//!   * Thinking — gated by `thinking: { "type": "enabled" }` (like DeepSeek),
//!     not OpenAI's `reasoning_effort`; the reasoning streams back as
//!     `reasoning_content`, which the default `reasoning_fields` already reads.
//!
//! Not ported: MiMo's built-in `web_search` server tool (web search is a
//! provider-agnostic tool here), and the `/models` capability/param-count
//! enrichment (a separate model-listing concern).

use serde_json::{Value, json};

use super::spec::ProviderSpec;
use crate::providers::ChatTarget;

pub(crate) struct Mimo;

impl ProviderSpec for Mimo {
    fn apply_auth(&self, req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("api-key", api_key)
    }

    fn configure_reasoning(&self, body: &mut Value, _target: &ChatTarget, effort: Option<&str>) {
        // MiMo defaults to non-thinking, so only turn it on when asked; no
        // explicit disable is needed. `reasoning_effort` is not its dialect.
        if effort.is_some() {
            body["thinking"] = json!({ "type": "enabled" });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ChatTarget {
        ChatTarget {
            base_url: "https://api.xiaomimimo.com/v1".into(),
            provider_name: "MiMo".into(),
            kind: "mimo".into(),
            api_key: Some("sk-test".into()),
            model_id: "mimo-v2.5".into(),
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

    #[test]
    fn an_effort_enables_thinking_the_mimo_way() {
        let mut body = json!({ "model": "mimo-v2.5" });
        Mimo.configure_reasoning(&mut body, &target(), Some("high"));
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn no_effort_leaves_thinking_off() {
        let mut body = json!({ "model": "mimo-v2.5" });
        Mimo.configure_reasoning(&mut body, &target(), None);
        assert!(body.get("thinking").is_none());
    }
}
