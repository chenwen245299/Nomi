//! MoleAPI (`api.moleapi.com`), an OpenAI-compatible relay in front of several
//! hundred models from every major vendor. Chat rides the generic
//! `/chat/completions` path unchanged (MoleAPI overrides no chat-runtime seam),
//! so this module holds only what the relay adds on top:
//!
//!   * detection ([`is_moleapi_url`]) — a relay a user added as a plain
//!     "openai"-compatible provider is still recognised by host,
//!   * the public price list (`/api/pricing`), which is where the modality tags
//!     and per-token rates live — `/v1/models` itself returns bare ids,
//!   * the per-key quota (`/api/usage/token/`), and — with the optional
//!     系统访问令牌 — the account balance (`/api/user/self`), which is what the
//!     balance tag shows.
//!
//! The site runs the open-source *new-api* gateway, so both management routes are
//! that project's, not something MoleAPI invented: the docs list them but leave
//! the response bodies blank, so the shapes below come from the gateway source
//! (`controller/token.go`, `controller/user.go`, `controller/pricing.go`).
//!
//! ## Quota is an integer, not a currency
//!
//! The gateway counts quota in its own unit and publishes the exchange rate as
//! `quota_per_unit` on `/api/status` — 500 000 per US dollar on MoleAPI, the
//! gateway default. The balance lookup reads that figure live rather than
//! hard-coding it, so a relay that changed the rate would still show the right
//! money; the default is only a fallback for when `/api/status` is unreachable.
//!
//! ## What the price list can and cannot say
//!
//! `model_ratio` is *not* the price. Every model without a billing expression
//! carries the gateway's placeholder ratio of 37.5 ($75 per million) — what a
//! model costs when nobody has priced it, not what it costs. The rates shown come
//! exclusively from `billing_expr`, the formula the relay actually bills by
//! (`tier("base", p * 3 + c * 15 + cr * 0.3)`: prompt, completion and cache-read
//! dollars per million). A model with no expression keeps no price, per the house
//! rule that a confidently wrong number is worse than none. Prices are reported
//! in USD/million; the webview converts them into its user-maintained CNY fields.
//!
//! The relay also does not say which pricing *group* a key belongs to, and groups
//! scale the bill (`discount` is 0.8×, `relay` 0.3×). The figures shown are the
//! `default` group's, i.e. the list price.
//!
//! Ported from Argus's `moleapi.rs` / `balance.rs`, adapted to Nomi's
//! [`ProviderSpec`] trait and its catalogue/balance DTOs.
//! References: <https://docs.moleapi.com/zh-CN/docs/api>.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;

use super::FetchedProviderModel;
use super::spec::{HttpError, ProviderBalance, ProviderSpec, get_json};

pub(crate) struct MoleApi;

#[async_trait]
impl ProviderSpec for MoleApi {
    async fn enrich_fetched_models(
        &self,
        base_url: &str,
        _api_key: Option<&str>,
        models: Vec<FetchedProviderModel>,
    ) -> Result<Vec<FetchedProviderModel>, String> {
        // `/api/pricing` is public — no key needed. A failure is an error, not a
        // silent fallback to bare ids: 600+ unlabelled ids can't be told apart,
        // and a background price refresh must not mistake "couldn't fetch" for
        // "no longer priced" and wipe stored prices. Both endpoints share a host,
        // so one working and the other not is vanishingly rare.
        let pricing = fetch_pricing(base_url).await?;
        Ok(enrich_models(models, &pricing))
    }

    fn supports_balance(&self) -> bool {
        true
    }

    fn supports_access_token(&self) -> bool {
        true
    }

    async fn fetch_balance(
        &self,
        base_url: &str,
        api_key: &str,
        access_token: Option<&str>,
    ) -> Result<ProviderBalance, String> {
        // The per-key quota is always needed: it carries the expiry and whether
        // the key has a ceiling of its own, both of which matter even when the
        // access token supplies the headline account balance.
        let usage = fetch_token_usage(base_url, api_key).await?;
        let per_unit = fetch_quota_per_unit(base_url).await;
        let to_usd = |quota: f64| {
            if per_unit > 0.0 {
                quota / per_unit
            } else {
                0.0
            }
        };

        let key_available = to_usd(usage.total_available);
        let key_used = to_usd(usage.total_used);
        let key_granted = to_usd(usage.total_granted);
        // The gateway rewrites its "never" sentinel (-1) to 0, so treat 0 as none.
        let expires_at = (usage.expires_at > 0).then_some(usage.expires_at);
        let expired = expires_at.is_some_and(|at| at <= now_secs());

        // With the console access token we can read the account itself — the only
        // way to put a number on a 无限额度 key, which has no quota of its own.
        if let Some(token) = access_token.map(str::trim).filter(|t| !t.is_empty()) {
            let account = fetch_account(base_url, token).await?;
            let account_balance = to_usd(account.quota);
            let account_used = to_usd(account.used_quota);
            let mut note = format!("账户已用 ${account_used:.2}");
            if !usage.unlimited_quota {
                note.push_str(&format!(" · 密钥剩余 ${key_available:.2}"));
            }
            let key_ok = usage.unlimited_quota || key_available > 0.0;
            return Ok(molebalance(
                account_balance,
                !expired && account_balance > 0.0 && key_ok,
                false,
                expires_at,
                Some(note),
            ));
        }

        // A 无限额度 key draws straight on the account and reports no ceiling, so
        // there is no remaining figure — show 不限额, not a misleading $0.
        if usage.unlimited_quota {
            let note = format!(
                "已用 ${key_used:.2} · 无限额度，直接扣账户余额。填写系统访问令牌可显示账户余额。"
            );
            return Ok(molebalance(0.0, !expired, true, expires_at, Some(note)));
        }

        let note = format!("总额度 ${key_granted:.2} · 已用 ${key_used:.2}");
        Ok(molebalance(
            key_available,
            !expired && key_available > 0.0,
            false,
            expires_at,
            Some(note),
        ))
    }
}

/// A MoleAPI balance: one USD figure plus the relay-specific flags. The
/// DeepSeek/OpenRouter breakdown fields stay empty — MoleAPI packs its detail
/// into `note` instead, so the existing balance card renders it without knowing
/// about quotas.
fn molebalance(
    remaining: f64,
    is_available: bool,
    unlimited: bool,
    expires_at: Option<i64>,
    note: Option<String>,
) -> ProviderBalance {
    ProviderBalance {
        remaining,
        currency: "USD".into(),
        granted: None,
        topped_up: None,
        total_credits: None,
        total_usage: None,
        is_available,
        other_currencies: Vec::new(),
        unlimited,
        expires_at,
        note,
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Recognise a MoleAPI relay by its host, so a provider a user added as a plain
/// "openai"-compatible endpoint still gets quota + price enrichment. Matches the
/// host only — a path or query that happens to contain "moleapi" (e.g. someone
/// else's `…/moleapi-proxy/v1`) must not be misrouted onto MoleAPI's management
/// endpoints.
pub(crate) fn is_moleapi_url(base_url: &str) -> bool {
    host_of(base_url).is_some_and(|host| host.to_ascii_lowercase().contains("moleapi"))
}

/// The host of a base URL, tolerant of a missing scheme (`api.moleapi.com/v1`)
/// and of userinfo/port. `None` when no host can be isolated.
fn host_of(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    let after_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // Drop any `user:pass@` prefix, then any `:port` suffix.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

/// The management API lives beside `/v1`, not under it: `…/v1` serves the models,
/// `…/api/...` serves everything about the account. Strip the version segment the
/// user configured to get there.
fn site_root(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.to_lowercase().ends_with("/v1") {
        trimmed[..trimmed.len() - 3]
            .trim_end_matches('/')
            .to_string()
    } else {
        trimmed.to_string()
    }
}

/// The gateway's default quota-per-dollar, used only if `/api/status` cannot be
/// read. MoleAPI runs at exactly this figure.
const DEFAULT_QUOTA_PER_UNIT: f64 = 500_000.0;

// ── Price list ───────────────────────────────────────────────────────────────

/// One row of `/api/pricing`. Only the fields read here; the endpoint returns far
/// more (descriptions in seven languages, vendor ids, icon names).
#[derive(Debug, Clone, Deserialize)]
struct PricingEntry {
    model_name: String,
    /// Comma-separated Chinese labels — `对话,工具调用,缓存` — the only place the
    /// relay states what a model can do.
    #[serde(default)]
    tags: Option<String>,
    /// 0 = billed per token, 1 = billed per request (image generation, mostly).
    #[serde(default)]
    quota_type: i64,
    /// The formula the relay bills by. Absent for models nobody has priced.
    #[serde(default)]
    billing_expr: Option<String>,
    /// Which relay endpoints accept the model. Nomi speaks only `openai`.
    #[serde(default)]
    supported_endpoint_types: Vec<String>,
}

#[derive(Deserialize)]
struct PricingEnvelope {
    #[serde(default)]
    data: Vec<PricingEntry>,
}

/// Read the public price list. No key needed — the same table backs the site's
/// pricing page. The body is close to a megabyte.
async fn fetch_pricing(base_url: &str) -> Result<Vec<PricingEntry>, String> {
    let url = format!("{}/api/pricing", site_root(base_url));
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求价目表失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("价目表接口返回 {status}：{snippet}"));
    }
    let envelope: PricingEnvelope =
        serde_json::from_str(&text).map_err(|e| format!("无法解析价目表：{e}"))?;
    Ok(envelope.data)
}

/// Dollars per million tokens for prompt and completion, read off the billing
/// expression.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TokenRates {
    input_usd_per_million: f64,
    output_usd_per_million: f64,
}

/// Pull the per-token rates out of a billing expression.
///
/// The expressions are small arithmetic formulas over named quantities — `p`
/// prompt tokens, `c` completion tokens, `cr` cache reads, `img`/` img_o` images,
/// `ai`/`ao` audio — grouped into `tier("name", …)` calls, sometimes behind a
/// condition (`len <= 272000 ? tier("standard", …) : tier("long_context", …)`).
/// The first tier that prices `p` is the standard rate: in every conditional the
/// relay publishes the cheaper, everyday tier comes first, and the one exception
/// (`(ai > 0 || ao > 0) ? tier("audio", …) : tier("base", …)`) is handled by the
/// "prices `p`" requirement, since the audio tier bills on `max(len - ai, 0)`
/// rather than `p` and is skipped. `fixed(0.04)` tiers are per-request and yield
/// nothing.
fn parse_billing_expr(expr: &str) -> Option<TokenRates> {
    let mut search_from = 0;
    while let Some(rel) = expr[search_from..].find("tier(") {
        let open = search_from + rel + "tier(".len() - 1;
        let close = matching_paren(expr, open)?;
        let inner = &expr[open + 1..close];
        // Drop the `"name", ` prefix; the formula is whatever follows the first
        // top-level comma.
        let formula = split_top_level_comma(inner).unwrap_or(inner);
        let terms = term_coefficients(formula);
        if let Some(&p) = terms.get("p") {
            let c = terms.get("c").copied().unwrap_or(0.0);
            return Some(TokenRates {
                input_usd_per_million: p,
                output_usd_per_million: c,
            });
        }
        search_from = close;
    }
    None
}

/// Index of the `)` closing the `(` at `open`, honouring nesting.
fn matching_paren(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, ch) in s.char_indices().skip_while(|(i, _)| *i < open) {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Everything after the first comma that is not inside parentheses or quotes.
fn split_top_level_comma(s: &str) -> Option<&str> {
    let mut depth = 0i32;
    let mut in_quotes = false;
    for (i, ch) in s.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '(' if !in_quotes => depth += 1,
            ')' if !in_quotes => depth -= 1,
            ',' if !in_quotes && depth == 0 => return Some(&s[i + 1..]),
            _ => {}
        }
    }
    None
}

/// `p * 3 + c * 15 + cr * 0.3` → `{p: 3, c: 15, cr: 0.3}`. Terms that are not a
/// plain `name * number` (function calls, nested arithmetic) are ignored.
fn term_coefficients(formula: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for term in split_top_level(formula, '+') {
        let mut parts = term.split('*').map(str::trim);
        let (Some(name), Some(value), None) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        if let Ok(v) = value.parse::<f64>()
            && v.is_finite()
            && v >= 0.0
        {
            out.insert(name.to_string(), v);
        }
    }
    out
}

fn split_top_level(s: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            c if c == sep && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

/// What kind of thing a price-list row describes, as far as a chat client cares.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ModelClass {
    /// Answers on `/chat/completions`; further split into text vs vision by tags.
    Chat,
    /// Vectors only — grouped under 嵌入, hidden from chat pickers.
    Embedding,
    /// Generates images ("文生图"); listed for the catalogue, not driven here.
    ImageGen,
    /// Generates video; likewise.
    VideoGen,
    /// Speech, reranking, moderation: none can take a chat turn, so they are
    /// dropped from the list entirely.
    Unusable,
}

/// Classify a row by its tags and endpoints. The tags are the relay's own
/// vocabulary, so matching is by exact label rather than substring: `多模态` on an
/// embedding model means it embeds images, not that it can see in a conversation.
fn classify(entry: &PricingEntry) -> ModelClass {
    let tags = tag_set(entry.tags.as_deref());
    let has = |t: &str| tags.contains(t);

    if has("嵌入") || has("向量检索") {
        return ModelClass::Embedding;
    }
    if has("图片生成") || has("文生图") || has("图生图") {
        return ModelClass::ImageGen;
    }
    if has("视频生成") || has("文生视频") {
        return ModelClass::VideoGen;
    }
    if has("重排序") || has("安全审核") {
        return ModelClass::Unusable;
    }
    // Speech-only: audio tags with nothing conversational beside them. The omni
    // models carry `音频` next to `对话`/`视觉`, and those chat.
    let conversational = has("对话")
        || has("工具调用")
        || has("推理")
        || has("视觉")
        || has("多模态")
        || has("代码")
        || has("代码生成");
    if (has("音频") || has("语音") || has("实时")) && !conversational {
        return ModelClass::Unusable;
    }
    // A model the relay only serves through the Responses API (o3-pro, the
    // deep-research line) cannot be reached from `/chat/completions`.
    if !entry.supported_endpoint_types.is_empty()
        && !entry.supported_endpoint_types.iter().any(|e| e == "openai")
    {
        return ModelClass::Unusable;
    }
    ModelClass::Chat
}

fn tag_set(tags: Option<&str>) -> std::collections::HashSet<&str> {
    tags.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect()
}

/// Whether a chat row can see images — becomes the `vision` category and (below)
/// the `image` capability badge.
fn is_vision(tags: Option<&str>) -> bool {
    let tags = tag_set(tags);
    tags.contains("视觉") || tags.contains("多模态")
}

/// Capability badges for a chat row, in Nomi's vocabulary
/// (`image`/`audio`/`tool`/`reasoning`). `image` marks vision here — Nomi maps
/// `vision`→`image` for display and treats the badge as an image-input gate.
fn capabilities_from_tags(tags: Option<&str>) -> Vec<String> {
    let tags = tag_set(tags);
    let mut caps: Vec<String> = Vec::new();
    let mut add = |cap: &str| {
        if !caps.iter().any(|c| c == cap) {
            caps.push(cap.to_string());
        }
    };
    if tags.contains("推理") {
        add("reasoning");
    }
    if tags.contains("视觉") || tags.contains("多模态") {
        add("image");
    }
    if tags.contains("音频") || tags.contains("语音") || tags.contains("实时") {
        add("audio");
    }
    if tags.contains("工具调用") {
        add("tool");
    }
    caps
}

/// Fold the price list into what `/v1/models` returned.
///
/// `/v1/models` is the authority on which ids *this key* may call — it is
/// filtered by the key's group and model allow-list — so nothing is added from
/// the price list, only overlaid: tags become the category + capabilities, the
/// billing expression becomes a USD price, and rows that cannot chat are dropped.
/// An id the price list does not know (newer than the list, or renamed) is kept
/// as it came, category/capabilities unknown, exactly as a plain
/// OpenAI-compatible provider would show it.
fn enrich_models(
    fetched: Vec<FetchedProviderModel>,
    pricing: &[PricingEntry],
) -> Vec<FetchedProviderModel> {
    let by_name: HashMap<&str, &PricingEntry> =
        pricing.iter().map(|e| (e.model_name.as_str(), e)).collect();

    fetched
        .into_iter()
        .filter_map(|mut m| {
            let Some(entry) = by_name.get(m.id.as_str()) else {
                return Some(m);
            };
            match classify(entry) {
                ModelClass::Unusable => return None,
                ModelClass::Embedding => m.category = "embedding".into(),
                ModelClass::ImageGen => m.category = "image".into(),
                ModelClass::VideoGen => m.category = "video".into(),
                ModelClass::Chat => {
                    m.category = if is_vision(entry.tags.as_deref()) {
                        "vision".into()
                    } else {
                        "text".into()
                    };
                    for cap in capabilities_from_tags(entry.tags.as_deref()) {
                        if !m.capabilities.contains(&cap) {
                            m.capabilities.push(cap);
                        }
                    }
                }
            }
            // Per-request rows (quota_type 1: image generation) bill by the call,
            // not by tokens, so they carry no token price.
            if entry.quota_type == 0
                && let Some(rates) = entry.billing_expr.as_deref().and_then(parse_billing_expr)
            {
                m.input_price_usd_per_million = Some(rates.input_usd_per_million);
                m.output_price_usd_per_million = Some(rates.output_usd_per_million);
                // Free only when both directions are zero — free to read but
                // charged to write is not free.
                m.is_free =
                    rates.input_usd_per_million == 0.0 && rates.output_usd_per_million == 0.0;
            }
            Some(m)
        })
        .collect()
}

// ── Quota / account ──────────────────────────────────────────────────────────

/// `data` of `GET /api/usage/token/`. Quota figures are in gateway units.
#[derive(Debug, Clone, Deserialize)]
struct TokenUsage {
    /// Remaining plus used — what the key was issued with.
    #[serde(default)]
    total_granted: f64,
    #[serde(default)]
    total_used: f64,
    #[serde(default)]
    total_available: f64,
    /// A key with no cap of its own; it draws on the account balance, which the
    /// key cannot read about itself, so no remaining figure exists.
    #[serde(default)]
    unlimited_quota: bool,
    /// Unix seconds; the gateway rewrites its "never" sentinel (-1) to 0.
    #[serde(default)]
    expires_at: i64,
}

#[derive(Deserialize)]
struct UsageEnvelope {
    #[serde(default)]
    data: Option<TokenUsage>,
    #[serde(default)]
    message: Option<String>,
}

/// `data` of `GET /api/user/self`: the account behind the key. Only the fields
/// read here — the endpoint also returns the profile, permissions and affiliate
/// figures.
#[derive(Debug, Clone, Deserialize)]
struct AccountInfo {
    /// What is left in the account, in gateway units.
    #[serde(default)]
    quota: f64,
    #[serde(default)]
    used_quota: f64,
}

#[derive(Deserialize)]
struct AccountEnvelope {
    #[serde(default)]
    data: Option<AccountInfo>,
    #[serde(default)]
    message: Option<String>,
}

/// Fields of `GET /api/status` that turn quota into money.
#[derive(Debug, Clone, Deserialize)]
struct SiteStatus {
    #[serde(default)]
    quota_per_unit: Option<f64>,
}

#[derive(Deserialize)]
struct StatusEnvelope {
    #[serde(default)]
    data: Option<SiteStatus>,
}

/// The key's quota, as the gateway reports it. Note the trailing slash — the
/// route really is `/api/usage/token/`.
async fn fetch_token_usage(base_url: &str, api_key: &str) -> Result<TokenUsage, String> {
    let url = format!("{}/api/usage/token/", site_root(base_url));
    let UsageEnvelope { data, message } =
        get_json(&url, api_key).await.map_err(|e: HttpError| {
            if e.is_auth() {
                "MoleAPI 拒绝了 API 密钥（无效的令牌）。".to_string()
            } else {
                e.message
            }
        })?;
    data.ok_or_else(|| {
        message
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "MoleAPI 未返回额度信息。".to_string())
    })
}

/// The account's own balance, which needs the console's 系统访问令牌 rather than
/// an API key. The gateway reads it from the same `Authorization: Bearer` header,
/// so the request looks like the quota one with a different secret.
async fn fetch_account(base_url: &str, access_token: &str) -> Result<AccountInfo, String> {
    let url = format!("{}/api/user/self", site_root(base_url));
    let AccountEnvelope { data, message } =
        get_json(&url, access_token).await.map_err(|e: HttpError| {
            if e.is_auth() {
                // The generic 401 text blames the API key, the wrong secret here.
                "MoleAPI 拒绝了系统访问令牌，请到控制台安全页重新生成后填入。".to_string()
            } else {
                e.message
            }
        })?;
    data.ok_or_else(|| {
        message
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "MoleAPI 未返回账户信息。".to_string())
    })
}

/// How many quota units make one US dollar on this relay. Falls back to the
/// gateway default when `/api/status` cannot be read — the status page being down
/// is no reason to hide the balance.
async fn fetch_quota_per_unit(base_url: &str) -> f64 {
    let url = format!("{}/api/status", site_root(base_url));
    let Ok(resp) = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
    else {
        return DEFAULT_QUOTA_PER_UNIT;
    };
    if !resp.status().is_success() {
        return DEFAULT_QUOTA_PER_UNIT;
    }
    let Ok(text) = resp.text().await else {
        return DEFAULT_QUOTA_PER_UNIT;
    };
    serde_json::from_str::<StatusEnvelope>(&text)
        .ok()
        .and_then(|e| e.data)
        .and_then(|d| d.quota_per_unit)
        .filter(|q| q.is_finite() && *q > 0.0)
        .unwrap_or(DEFAULT_QUOTA_PER_UNIT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, tags: Option<&str>, expr: Option<&str>) -> PricingEntry {
        PricingEntry {
            model_name: name.into(),
            tags: tags.map(str::to_string),
            quota_type: 0,
            billing_expr: expr.map(str::to_string),
            supported_endpoint_types: vec!["openai".into()],
        }
    }

    fn bare(id: &str) -> FetchedProviderModel {
        FetchedProviderModel {
            id: id.into(),
            name: id.into(),
            capabilities: vec![],
            category: String::new(),
            context_length: None,
            input_modalities: vec![],
            output_modalities: vec![],
            input_price_usd_per_million: None,
            output_price_usd_per_million: None,
            is_free: false,
        }
    }

    #[test]
    fn detected_by_host() {
        assert!(is_moleapi_url("https://api.moleapi.com/v1"));
        assert!(is_moleapi_url("https://API.MoleAPI.com/v1/"));
        // Scheme-less input still resolves a host.
        assert!(is_moleapi_url("api.moleapi.com/v1"));
        assert!(!is_moleapi_url("https://api.openai.com/v1"));
        // Only the host counts — "moleapi" in a path/query must not match, or an
        // unrelated relay would be routed onto MoleAPI's management endpoints.
        assert!(!is_moleapi_url("https://api.example.com/moleapi-proxy/v1"));
        assert!(!is_moleapi_url("https://api.example.com/v1?tag=moleapi"));
    }

    #[test]
    fn management_api_sits_beside_v1() {
        assert_eq!(
            site_root("https://api.moleapi.com/v1"),
            "https://api.moleapi.com"
        );
        assert_eq!(
            site_root("https://api.moleapi.com/v1/"),
            "https://api.moleapi.com"
        );
        assert_eq!(
            site_root("https://api.moleapi.com"),
            "https://api.moleapi.com"
        );
        assert_eq!(
            site_root("https://api.moleapi.com/V1"),
            "https://api.moleapi.com"
        );
    }

    #[test]
    fn plain_tier_reads_prompt_and_completion() {
        let r = parse_billing_expr(
            r#"tier("base", p * 3 + c * 15 + cr * 0.29999999999999997 + cc * 3.75 + cc1h * 6)"#,
        )
        .unwrap();
        assert_eq!(r.input_usd_per_million, 3.0);
        assert_eq!(r.output_usd_per_million, 15.0);
    }

    #[test]
    fn term_order_does_not_matter() {
        let r = parse_billing_expr(
            r#"tier("standard", p * 5 + cr * 1.25 + img * 8 + img_cr * 2 + c * 30)"#,
        )
        .unwrap();
        assert_eq!(
            (r.input_usd_per_million, r.output_usd_per_million),
            (5.0, 30.0)
        );
    }

    /// The conditional forms put the everyday tier first; the long-context
    /// surcharge must not be the one quoted.
    #[test]
    fn conditional_quotes_the_first_tier() {
        let r = parse_billing_expr(
            r#"len <= 272000 ? tier("standard", p * 0.2 + c * 1.2 + cr * 0.02 + cc * 0.25) : tier("long_context", p * 0.4 + c * 1.8 + cr * 0.04 + cc * 0.5 + img * 8 + img_o * 30)"#,
        )
        .unwrap();
        assert_eq!(
            (r.input_usd_per_million, r.output_usd_per_million),
            (0.2, 1.2)
        );
    }

    /// The audio form is the one conditional whose first tier is not the standard
    /// one — and it does not price `p`, which is what skips it.
    #[test]
    fn audio_tier_is_skipped_for_the_text_tier() {
        let r = parse_billing_expr(
            r#"(ai > 0 || ao > 0) ? tier("audio", max(len - ai, 0) * 0.15 + c * 0.6 + ai * 3.75 + ao * 3.75) : tier("base", p * 0.15 + c * 0.6 + cr * 0.075)"#,
        )
        .unwrap();
        assert_eq!(
            (r.input_usd_per_million, r.output_usd_per_million),
            (0.15, 0.6)
        );
    }

    #[test]
    fn per_request_and_empty_expressions_price_nothing() {
        assert_eq!(
            parse_billing_expr(r#"tier("image", fixed(0.04)) * image_count"#),
            None
        );
        assert_eq!(parse_billing_expr(r#"tier("request", fixed(0.5))"#), None);
        assert_eq!(parse_billing_expr(""), None);
        assert_eq!(parse_billing_expr("tier("), None);
    }

    /// The time-of-day multiplier form wraps the tier in more parentheses; the
    /// base rate is still the one inside.
    #[test]
    fn multiplied_tier_still_parses() {
        let r = parse_billing_expr(
            r#"(tier("base", p * 0.28 + c * 0.42 + cr * 0.028 + cc * 0.28)) * (weekday("Asia/Shanghai") >= 1 && hour("Asia/Shanghai") >= 0 ? 0.5 : 1)"#,
        )
        .unwrap();
        assert_eq!(
            (r.input_usd_per_million, r.output_usd_per_million),
            (0.28, 0.42)
        );
    }

    #[test]
    fn tags_map_to_nomi_capabilities() {
        assert_eq!(
            capabilities_from_tags(Some("推理,对话,工具调用,缓存")),
            vec!["reasoning", "tool"]
        );
        assert_eq!(
            capabilities_from_tags(Some("视觉,多模态,音频,语音,对话,开源权重")),
            vec!["image", "audio"]
        );
        assert!(capabilities_from_tags(None).is_empty());
        assert!(capabilities_from_tags(Some("对话")).is_empty());
    }

    #[test]
    fn classes_follow_the_relay_vocabulary() {
        assert_eq!(
            classify(&entry("gpt", Some("对话,工具调用"), None)),
            ModelClass::Chat
        );
        assert_eq!(classify(&entry("gpt-5-all", None, None)), ModelClass::Chat);
        assert_eq!(
            classify(&entry("kimi-code", Some("代码,代码生成"), None)),
            ModelClass::Chat
        );
        assert_eq!(
            classify(&entry(
                "qwen3-vl-embedding-8b",
                Some("嵌入,多模态,向量检索"),
                None
            )),
            ModelClass::Embedding
        );
        assert_eq!(
            classify(&entry("qwen-image", Some("图片生成,文生图,高质量"), None)),
            ModelClass::ImageGen
        );
        assert_eq!(
            classify(&entry("seedance", Some("视频生成,文生视频,音频"), None)),
            ModelClass::VideoGen
        );
        assert_eq!(
            classify(&entry("tts-1", Some("音频,语音"), None)),
            ModelClass::Unusable
        );
        assert_eq!(
            classify(&entry("bge-reranker", Some("重排序,排序优化"), None)),
            ModelClass::Unusable
        );
        // Omni models carry audio tags but chat.
        assert_eq!(
            classify(&entry(
                "qwen3-omni",
                Some("视觉,多模态,音频,语音,对话"),
                None
            )),
            ModelClass::Chat
        );
        // Responses-only models are out of reach of /chat/completions.
        let mut o3 = entry("o3-pro", Some("推理,对话,工具调用"), None);
        o3.supported_endpoint_types = vec!["openai-response".into()];
        assert_eq!(classify(&o3), ModelClass::Unusable);
    }

    #[test]
    fn enrichment_overlays_and_filters_but_never_adds() {
        let pricing = vec![
            entry(
                "claude-sonnet-4.6",
                Some("视觉,对话,工具调用,缓存"),
                Some(r#"tier("base", p * 3 + c * 15 + cr * 0.3)"#),
            ),
            entry(
                "bge-reranker-v2-m3",
                Some("重排序"),
                Some(r#"tier("base", p * 0.01 + c * 0)"#),
            ),
            entry(
                "free-thing",
                Some("对话"),
                Some(r#"tier("base", p * 0 + c * 0)"#),
            ),
            // Unpriced: no expression, so no price — not the 37.5 placeholder.
            entry("doubao-lite", Some("对话"), None),
            entry(
                "not-fetched",
                Some("对话"),
                Some(r#"tier("base", p * 1 + c * 1)"#),
            ),
        ];
        let fetched = vec![
            bare("claude-sonnet-4.6"),
            bare("bge-reranker-v2-m3"),
            bare("free-thing"),
            bare("doubao-lite"),
            bare("brand-new-model"),
        ];
        let out = enrich_models(fetched, &pricing);
        let ids: Vec<&str> = out.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "claude-sonnet-4.6",
                "free-thing",
                "doubao-lite",
                "brand-new-model"
            ]
        );

        let claude = &out[0];
        assert_eq!(claude.category, "vision");
        assert_eq!(claude.capabilities, vec!["image", "tool"]);
        assert_eq!(claude.input_price_usd_per_million, Some(3.0));
        assert_eq!(claude.output_price_usd_per_million, Some(15.0));
        assert!(!claude.is_free);

        // free-thing: text chat, priced 0/0.
        assert_eq!(out[1].category, "text");
        assert!(out[1].is_free);
        // doubao-lite: chat but unpriced — no number invented.
        assert_eq!(out[2].category, "text");
        assert_eq!(out[2].input_price_usd_per_million, None);
        // brand-new-model: not in the price list, kept untouched.
        assert!(out[3].category.is_empty());
        assert!(out[3].capabilities.is_empty());
    }

    #[test]
    fn per_request_rows_keep_no_token_price() {
        let mut img = entry(
            "qwen-image",
            Some("图片生成"),
            Some(r#"tier("image", fixed(0.04)) * image_count"#),
        );
        img.quota_type = 1;
        let out = enrich_models(vec![bare("qwen-image")], &[img]);
        assert_eq!(out[0].category, "image");
        assert_eq!(out[0].input_price_usd_per_million, None);
    }

    #[test]
    fn usage_envelope_matches_the_gateway() {
        let text = r#"{"code":true,"message":"ok","data":{"object":"token_usage","name":"nomi","total_granted":5000000,"total_used":1234567,"total_available":3765433,"unlimited_quota":false,"model_limits":{},"model_limits_enabled":false,"expires_at":0}}"#;
        let env: UsageEnvelope = serde_json::from_str(text).unwrap();
        let u = env.data.unwrap();
        assert_eq!(u.total_available, 3_765_433.0);
        assert!(!u.unlimited_quota);
        assert_eq!(u.expires_at, 0);
    }
}
