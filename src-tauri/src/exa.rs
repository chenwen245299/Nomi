//! Exa-backed web search shared by Nomi's in-app model tool loop and its MCP
//! stdio server. The API key stays in the existing encrypted key store and is
//! never serialized to the webview, MCP client, model request, or tool result.

use std::path::Path;
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::AppHandle;

use crate::providers;

const EXA_SEARCH_URL: &str = "https://api.exa.ai/search";
const EXA_KEY_SLOT: &str = "integration:exa-search";
const DEFAULT_RESULTS: usize = 5;
const MAX_RESULTS: usize = 10;
const MAX_HIGHLIGHT_CHARS: usize = 2_500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExaStatus {
    pub has_key: bool,
}

/// Search profiles intentionally stay on Exa's low-latency retrieval modes.
/// The model itself synthesizes the answer from the returned, cited excerpts.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum WebSearchType {
    #[default]
    Auto,
    Fast,
    Instant,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, JsonSchema)]
pub enum WebSearchCategory {
    #[serde(rename = "company")]
    Company,
    #[serde(rename = "people")]
    People,
    #[serde(rename = "publication")]
    Publication,
    #[serde(rename = "news")]
    News,
    #[serde(rename = "personal site")]
    PersonalSite,
    #[serde(rename = "financial report")]
    FinancialReport,
}

fn default_num_results() -> usize {
    DEFAULT_RESULTS
}

/// Arguments exposed to both MCP clients and Nomi's chat models.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct WebSearchParams {
    /// Natural-language web search query. Include the subject and the fact or
    /// timeframe you need instead of sending only a few keywords.
    pub query: String,
    /// Number of sources to return. Defaults to 5 and is capped at 10.
    #[serde(default = "default_num_results")]
    pub num_results: usize,
    /// Retrieval profile. `auto` is recommended; use `fast` or `instant` only
    /// when latency matters more than recall.
    #[serde(default)]
    pub search_type: WebSearchType,
    /// Optional content category such as `news` or `publication`.
    pub category: Option<WebSearchCategory>,
    /// Only return results from these domains or path prefixes.
    #[serde(default)]
    pub include_domains: Vec<String>,
    /// Exclude results from these domains or path prefixes.
    #[serde(default)]
    pub exclude_domains: Vec<String>,
    /// ISO 8601 lower publication-date bound.
    pub start_published_date: Option<String>,
    /// ISO 8601 upper publication-date bound.
    pub end_published_date: Option<String>,
    /// Force live crawling instead of accepting cached page contents. This is
    /// slower, so use it only when the answer must reflect the latest page.
    #[serde(default)]
    pub fresh: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub published_date: Option<String>,
    pub author: Option<String>,
    /// Query-relevant excerpts from the page. The answering model should cite
    /// `url` when it uses information from these excerpts.
    pub highlights: Vec<String>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct WebSearchResponse {
    pub query: String,
    pub request_id: Option<String>,
    pub search_type: Option<String>,
    pub results: Vec<WebSearchResult>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSearchResponse {
    request_id: Option<String>,
    search_type: Option<String>,
    #[serde(default)]
    results: Vec<RawSearchResult>,
    cost_dollars: Option<RawCost>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSearchResult {
    #[serde(default)]
    title: String,
    url: String,
    published_date: Option<String>,
    author: Option<String>,
    #[serde(default)]
    highlights: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawCost {
    total: f64,
}

#[tauri::command]
pub fn exa_get_status(app: AppHandle) -> Result<ExaStatus, String> {
    Ok(ExaStatus {
        has_key: stored_key(&app)?.is_some(),
    })
}

#[tauri::command]
pub fn exa_set_key(app: AppHandle, key: String) -> Result<ExaStatus, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        providers::delete_key(&app, EXA_KEY_SLOT)?;
    } else {
        providers::save_key(&app, EXA_KEY_SLOT, trimmed)?;
    }
    exa_get_status(app)
}

/// Read the key for the in-app chat runtime. Kept crate-private so plaintext can
/// never become a Tauri command result.
pub(crate) fn stored_key(app: &AppHandle) -> Result<Option<String>, String> {
    providers::read_key(app, EXA_KEY_SLOT)
}

/// Read the same encrypted slot from the standalone MCP process.
pub(crate) fn stored_key_from_data_root(data_root: &Path) -> Result<Option<String>, String> {
    providers::read_key_from_data_root(data_root, EXA_KEY_SLOT)
}

fn normalized_domains(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .take(20)
        .map(str::to_string)
        .collect()
}

fn build_request(params: &WebSearchParams) -> Result<Value, String> {
    let query = params.query.trim();
    if query.is_empty() {
        return Err("搜索关键词不能为空。".into());
    }
    if query.chars().count() > 2_000 {
        return Err("搜索关键词过长，请控制在 2000 个字符以内。".into());
    }

    if matches!(
        params.category,
        Some(WebSearchCategory::Company | WebSearchCategory::People)
    ) && (!params.exclude_domains.is_empty()
        || params.start_published_date.is_some()
        || params.end_published_date.is_some())
    {
        return Err("company / people 分类不支持排除域名或发布时间筛选。".into());
    }

    let mut contents = json!({ "highlights": true });
    if params.fresh {
        contents["maxAgeHours"] = json!(0);
    }
    let mut body = json!({
        "query": query,
        "type": params.search_type,
        "numResults": params.num_results.clamp(1, MAX_RESULTS),
        "moderation": true,
        "contents": contents,
    });

    if let Some(category) = params.category {
        body["category"] = serde_json::to_value(category).map_err(|error| error.to_string())?;
    }
    let include_domains = normalized_domains(&params.include_domains);
    if !include_domains.is_empty() {
        body["includeDomains"] = json!(include_domains);
    }
    let exclude_domains = normalized_domains(&params.exclude_domains);
    if !exclude_domains.is_empty() {
        body["excludeDomains"] = json!(exclude_domains);
    }
    if let Some(start) = params
        .start_published_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["startPublishedDate"] = json!(start);
    }
    if let Some(end) = params
        .end_published_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body["endPublishedDate"] = json!(end);
    }
    Ok(body)
}

fn truncate_chars(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value
    } else {
        let mut shown: String = value.chars().take(max_chars).collect();
        shown.push('…');
        shown
    }
}

pub(crate) async fn search_with_key(
    api_key: &str,
    params: WebSearchParams,
) -> Result<WebSearchResponse, String> {
    if api_key.trim().is_empty() {
        return Err("尚未配置 Exa API Key，请前往设置 → 通用添加。".into());
    }
    let body = build_request(&params)?;
    let response = reqwest::Client::new()
        .post(EXA_SEARCH_URL)
        .bearer_auth(api_key.trim())
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(30))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Exa 搜索请求失败：{error}"))?;

    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let parsed: Value = serde_json::from_str(&response_text).unwrap_or(Value::Null);
        let message = parsed["error"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| response_text.chars().take(300).collect());
        return Err(match status.as_u16() {
            401 => "Exa API Key 无效或已失效，请在设置 → 通用中更新。".into(),
            429 => "Exa 请求频率已达上限，请稍后再试。".into(),
            _ => format!("Exa 接口返回 {status}：{message}"),
        });
    }

    let raw: RawSearchResponse = serde_json::from_str(&response_text)
        .map_err(|error| format!("无法解析 Exa 搜索结果：{error}"))?;
    let results = raw
        .results
        .into_iter()
        .map(|result| WebSearchResult {
            title: if result.title.trim().is_empty() {
                result.url.clone()
            } else {
                result.title
            },
            url: result.url,
            published_date: result.published_date,
            author: result.author,
            highlights: result
                .highlights
                .into_iter()
                .take(3)
                .map(|value| truncate_chars(value, MAX_HIGHLIGHT_CHARS))
                .collect(),
        })
        .collect();

    Ok(WebSearchResponse {
        query: params.query.trim().to_string(),
        request_id: raw.request_id,
        search_type: raw.search_type,
        results,
        cost_usd: raw.cost_dollars.map(|cost| cost.total),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> WebSearchParams {
        WebSearchParams {
            query: "latest Rust release".into(),
            num_results: 5,
            search_type: WebSearchType::Auto,
            category: Some(WebSearchCategory::News),
            include_domains: vec!["rust-lang.org".into()],
            exclude_domains: Vec::new(),
            start_published_date: None,
            end_published_date: None,
            fresh: true,
        }
    }

    #[test]
    fn request_matches_exa_search_api_shape() {
        let body = build_request(&params()).unwrap();
        assert_eq!(body["type"], "auto");
        assert_eq!(body["numResults"], 5);
        assert_eq!(body["category"], "news");
        assert_eq!(body["includeDomains"][0], "rust-lang.org");
        assert_eq!(body["contents"]["highlights"], true);
        assert_eq!(body["contents"]["maxAgeHours"], 0);
        assert!(body.get("highlights").is_none());
    }

    #[test]
    fn result_count_is_bounded() {
        let mut input = params();
        input.num_results = 999;
        assert_eq!(build_request(&input).unwrap()["numResults"], MAX_RESULTS);
    }

    #[test]
    fn company_filters_reject_unsupported_combinations() {
        let mut input = params();
        input.category = Some(WebSearchCategory::Company);
        input.exclude_domains = vec!["example.com".into()];
        assert!(build_request(&input).is_err());
    }
}
