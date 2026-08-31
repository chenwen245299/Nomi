//! OpenRouter.
//!
//! Balance: `GET /credits` returns credits *purchased* and credits *used* in USD,
//! so the remainder is subtracted out. That endpoint wants a management key, so
//! an ordinary inference key is turned away (401/403) and we ask `GET /key` about
//! itself instead — which reports the same figures from the key's point of view.
//! Both endpoints wrap the payload in `{ data: … }`.
//!
//! Ported from Argus's `balance.rs`.
//! Ref: <https://openrouter.ai/docs/api-reference/get-credits>
//!
//! OpenRouter's chat-time server tools (web_search / web_fetch, citation
//! annotations) would hang off the [`ProviderSpec`] hooks here when added.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use super::spec::{ProviderBalance, ProviderSpec, get_json};
use crate::providers::ChatTarget;

pub(crate) struct OpenRouter;

#[async_trait]
impl ProviderSpec for OpenRouter {
    fn decorate_body(&self, body: &mut Value, _target: &ChatTarget) {
        // Ask OpenRouter to account for and report the actual credits (USD) spent
        // on this request in the final usage chunk. `crate::llm` reads it back as
        // `usage.cost` and surfaces it per turn — the real charge, not an estimate.
        body["usage"] = json!({ "include": true });
    }

    fn supports_balance(&self) -> bool {
        true
    }

    async fn fetch_balance(
        &self,
        base_url: &str,
        api_key: &str,
    ) -> Result<ProviderBalance, String> {
        // OpenRouter's balance lives under the same `/api/v1` base as chat, so
        // (unlike DeepSeek) the `/v1` stays on.
        let base = base_url.trim().trim_end_matches('/');

        // `/credits` is the account-wide view and the one that can state what is
        // left outright. It is gated on a management key, so a plain inference
        // key gets turned away and we ask the key about itself instead.
        match get_json::<Envelope<Credits>>(&format!("{base}/credits"), api_key).await {
            Ok(envelope) => {
                let credits = envelope.data;
                let remaining = credits.total_credits - credits.total_usage;
                Ok(ProviderBalance {
                    remaining,
                    currency: "USD".into(),
                    granted: None,
                    topped_up: None,
                    total_credits: Some(credits.total_credits),
                    total_usage: Some(credits.total_usage),
                    is_available: remaining > 0.0,
                    other_currencies: Vec::new(),
                })
            }
            Err(e) if e.is_auth() => fetch_key(base, api_key).await,
            Err(e) => Err(e.into()),
        }
    }
}

async fn fetch_key(base: &str, api_key: &str) -> Result<ProviderBalance, String> {
    let key = get_json::<Envelope<Key>>(&format!("{base}/key"), api_key)
        .await
        .map(|e| e.data)?;

    // An uncapped key reports no remaining figure at all. Rather than invent one,
    // report zero remaining but mark it available (there is no ceiling to run
    // out of), so the UI shows the spend instead of a confidently wrong balance.
    let remaining = key
        .limit_remaining
        .or_else(|| key.limit.map(|l| l - key.usage));
    Ok(ProviderBalance {
        remaining: remaining.unwrap_or(0.0),
        currency: "USD".into(),
        granted: None,
        topped_up: None,
        total_credits: key.limit,
        total_usage: Some(key.usage),
        is_available: remaining.is_none_or(|r| r > 0.0),
        other_currencies: Vec::new(),
    })
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct Credits {
    #[serde(default)]
    total_credits: f64,
    #[serde(default)]
    total_usage: f64,
}

#[derive(Deserialize)]
struct Key {
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    limit_remaining: Option<f64>,
    #[serde(default)]
    usage: f64,
}
