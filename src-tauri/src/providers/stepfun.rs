//! StepFun's OpenAI-compatible Chat Completions API.
//!
//! Its model catalogue returns bare ids, so enrich the documented chat models
//! for Nomi's model picker. The documented streaming response already includes
//! usage in each chunk; `stream_options` is not a documented request parameter.
//!
//! Refs: <https://platform.stepfun.ai/docs/en/api-reference/chat/chat-completion-create>,
//! <https://platform.stepfun.ai/docs/en/api-reference/models/list>

use serde_json::Value;

use super::spec::ProviderSpec;
use crate::providers::{ChatTarget, FetchedProviderModel};

pub(crate) struct StepFun;

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|candidate| candidate == value) {
        values.push(value.to_string());
    }
}

impl ProviderSpec for StepFun {
    fn enrich_fetched_model(&self, mut model: FetchedProviderModel) -> FetchedProviderModel {
        let id = model.id.to_ascii_lowercase();
        let (context, vision) = match id.as_str() {
            "step-5-preview" => (1_000_000, true),
            "step-3.7-flash" => (256_000, true),
            "step-3.5-flash" | "step-3.5-flash-2603" => (256_000, false),
            _ => return model,
        };

        model.context_length.get_or_insert(context);
        model.category = if vision { "vision" } else { "text" }.into();
        for capability in ["tool", "reasoning"] {
            push_unique(&mut model.capabilities, capability);
        }
        push_unique(&mut model.input_modalities, "text");
        if vision {
            push_unique(&mut model.capabilities, "image");
            push_unique(&mut model.input_modalities, "image");
        }
        push_unique(&mut model.output_modalities, "text");
        model
    }

    fn configure_reasoning(&self, body: &mut Value, target: &ChatTarget, effort: Option<&str>) {
        // The base Step 3.5 Flash model does not document effort control. Its
        // 2603 variant accepts low/high; the other documented models accept all
        // three tiers. Never pass an unsupported value through from the UI.
        let allowed = match target.model_id.to_ascii_lowercase().as_str() {
            "step-5-preview" | "step-3.7-flash" => &["low", "medium", "high"][..],
            "step-3.5-flash-2603" => &["low", "high"][..],
            _ => &[][..],
        };
        if let Some(effort) = effort.filter(|effort| allowed.contains(effort)) {
            body["reasoning_effort"] = Value::String(effort.to_string());
        }
    }

    fn decorate_body(&self, body: &mut Value, _target: &ChatTarget) {
        if let Some(object) = body.as_object_mut() {
            object.remove("stream_options");
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::providers::spec::spec_for;

    fn bare_model(id: &str) -> FetchedProviderModel {
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
            base_url: "https://api.stepfun.com/v1".into(),
            provider_name: "阶跃星辰".into(),
            kind: "stepfun".into(),
            api_key: Some("sk-test".into()),
            model_id: model_id.into(),
            supports_tools: true,
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
    fn bare_catalogue_ids_get_documented_chat_capabilities() {
        let spec = spec_for("stepfun");
        let step_5 = spec.enrich_fetched_model(bare_model("step-5-preview"));
        assert_eq!(step_5.category, "vision");
        assert_eq!(step_5.context_length, Some(1_000_000));
        assert_eq!(step_5.capabilities, ["tool", "reasoning", "image"]);

        let step_37 = spec.enrich_fetched_model(bare_model("step-3.7-flash"));
        assert_eq!(step_37.category, "vision");
        assert_eq!(step_37.context_length, Some(256_000));

        let step_35 = spec.enrich_fetched_model(bare_model("step-3.5-flash-2603"));
        assert_eq!(step_35.category, "text");
        assert_eq!(step_35.capabilities, ["tool", "reasoning"]);
    }

    #[test]
    fn chat_body_uses_only_documented_stepfun_fields() {
        let spec = spec_for("stepfun");
        let mut body = json!({"stream": true, "stream_options": {"include_usage": true}});
        spec.configure_reasoning(&mut body, &target("step-5-preview"), Some("medium"));
        spec.decorate_body(&mut body, &target("step-5-preview"));
        assert_eq!(body["reasoning_effort"], "medium");
        assert!(body.get("stream_options").is_none());

        let mut base = json!({});
        spec.configure_reasoning(&mut base, &target("step-3.5-flash"), Some("high"));
        assert!(base.get("reasoning_effort").is_none());

        let mut variant = json!({});
        spec.configure_reasoning(&mut variant, &target("step-3.5-flash-2603"), Some("medium"));
        assert!(variant.get("reasoning_effort").is_none());
    }
}
