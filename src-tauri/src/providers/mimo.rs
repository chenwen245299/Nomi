//! Xiaomi MiMo.
//!
//! Two OpenAI-compatible deviations, both ported from Argus's `mimo.rs` /
//! `llm.rs`:
//!   * Auth — MiMo's gateway reads the key from an `api-key:` header, but also
//!     tolerates the standard `Authorization: Bearer`. We send both so the same
//!     provider config works whichever the gateway happens to read.
//!   * Thinking — gated by `thinking: { "type": "enabled" | "disabled" }`,
//!     not OpenAI's `reasoning_effort`; the reasoning streams back as
//!     `reasoning_content` and must be replayed before tool results.
//!
//! MiMo's built-in `web_search` server tool is intentionally not used (web
//! search is provider-agnostic here). `/models` capability enrichment lives in
//! this spec because Xiaomi's compatible response publishes ids only.

use serde_json::{Value, json};

use super::spec::ProviderSpec;
use crate::providers::{ChatTarget, FetchedProviderModel};

pub(crate) struct Mimo;

impl ProviderSpec for Mimo {
    fn enrich_fetched_model(&self, mut model: FetchedProviderModel) -> FetchedProviderModel {
        // MiMo's OpenAI-compatible `/models` response currently contains only
        // id/object/owned_by. Enrich the official families from Xiaomi's model
        // table, while leaving unknown future ids available to the generic
        // frontend fallback rather than hiding them.
        let id = model.id.to_ascii_lowercase();
        if id.contains("-asr") {
            model.category = "audio".into();
            model.capabilities = vec!["audio".into()];
            model.input_modalities = vec!["audio".into()];
            model.output_modalities = vec!["text".into()];
            model.context_length = model.context_length.or(Some(8_000));
        } else if id.contains("-tts") {
            model.category = "audio".into();
            model.capabilities = vec!["audio".into()];
            model.input_modalities = vec!["text".into()];
            model.output_modalities = vec!["audio".into()];
            model.context_length = model.context_length.or(Some(8_000));
        } else if id.starts_with("mimo-v2.6-") || id == "mimo-v2.5" || id.contains("omni") {
            model.category = "vision".into();
            model.capabilities = vec![
                "image".into(),
                "audio".into(),
                "video".into(),
                "tool".into(),
                "reasoning".into(),
            ];
            model.input_modalities = vec![
                "text".into(),
                "image".into(),
                "audio".into(),
                "video".into(),
            ];
            model.output_modalities = vec!["text".into()];
            model.context_length = model.context_length.or(Some(1_000_000));
        } else if id.contains("mimo-v2") {
            model.category = "text".into();
            model.capabilities = vec!["tool".into(), "reasoning".into()];
            model.input_modalities = vec!["text".into()];
            model.output_modalities = vec!["text".into()];
            model.context_length = model.context_length.or(Some(1_000_000));
        }
        model
    }

    fn apply_auth(&self, req: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {api_key}"))
            .header("api-key", api_key)
    }

    fn configure_reasoning(&self, body: &mut Value, _target: &ChatTarget, effort: Option<&str>) {
        // MiMo 2.5/2.6 default to thinking enabled. Always send the explicit
        // state so Nomi's off switch really disables it. MiMo currently treats
        // all non-off effort levels alike, so do not send `reasoning_effort`.
        body["thinking"] = json!({
            "type": if effort.is_some() { "enabled" } else { "disabled" }
        });
    }

    fn attach_reasoning_to_assistant_message(
        &self,
        message: &mut Value,
        reasoning: &str,
        _reasoning_details: Option<&Value>,
    ) {
        // Xiaomi recommends replaying reasoning_content on assistant tool-call
        // messages during a thinking turn so the next tool result has the same
        // chain-of-thought context.
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

    fn target() -> ChatTarget {
        ChatTarget {
            base_url: "https://api.xiaomimimo.com/v1".into(),
            provider_name: "MiMo".into(),
            kind: "mimo".into(),
            api_key: Some("sk-test".into()),
            model_id: "mimo-v2.5".into(),
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

    #[test]
    fn an_effort_enables_thinking_the_mimo_way() {
        let mut body = json!({ "model": "mimo-v2.5" });
        Mimo.configure_reasoning(&mut body, &target(), Some("high"));
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn no_effort_explicitly_disables_default_thinking() {
        let mut body = json!({ "model": "mimo-v2.5" });
        Mimo.configure_reasoning(&mut body, &target(), None);
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn official_catalogue_ids_are_enriched_by_capability() {
        let omni = Mimo.enrich_fetched_model(fetched("mimo-v2.5"));
        assert_eq!(omni.category, "vision");
        assert_eq!(
            omni.capabilities,
            vec!["image", "audio", "video", "tool", "reasoning"]
        );
        assert_eq!(omni.output_modalities, vec!["text"]);

        let pro = Mimo.enrich_fetched_model(fetched("mimo-v2.5-pro"));
        assert_eq!(pro.category, "text");
        assert_eq!(pro.capabilities, vec!["tool", "reasoning"]);

        for id in [
            "mimo-v2.6-flash",
            "mimo-v2.6-pro",
            "mimo-v2.6-pro-ultraspeed",
        ] {
            let model = Mimo.enrich_fetched_model(fetched(id));
            assert_eq!(model.category, "vision");
            assert_eq!(
                model.capabilities,
                vec!["image", "audio", "video", "tool", "reasoning"]
            );
            assert_eq!(
                model.input_modalities,
                vec!["text", "image", "audio", "video"]
            );
            assert_eq!(model.context_length, Some(1_000_000));
        }

        let asr = Mimo.enrich_fetched_model(fetched("mimo-v2.5-asr"));
        assert_eq!(asr.category, "audio");
        assert_eq!(asr.input_modalities, vec!["audio"]);
        assert_eq!(asr.output_modalities, vec!["text"]);

        let tts = Mimo.enrich_fetched_model(fetched("mimo-v2.5-tts-voiceclone"));
        assert_eq!(tts.category, "audio");
        assert_eq!(tts.input_modalities, vec!["text"]);
        assert_eq!(tts.output_modalities, vec!["audio"]);
    }

    #[test]
    fn thinking_is_replayed_on_assistant_tool_messages() {
        let mut message = json!({ "role": "assistant", "tool_calls": [] });
        Mimo.attach_reasoning_to_assistant_message(&mut message, "reasoning", None);
        assert_eq!(message["reasoning_content"], "reasoning");
    }
}
