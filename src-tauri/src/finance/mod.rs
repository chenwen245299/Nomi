//! 记账 — a ledger you fill by dropping payment screenshots into a chat.
//!
//! The flow, and where each part lives:
//!
//! 1. The user sends text, a receipt, or both into the capture conversation.
//!    [`finance_capture`] normalises and stores a picture when one is present
//!    ([`store::save_receipt`]).
//! 2. [`extract`] asks the selected model for structured entries — using text
//!    directly, reading a picture with vision, or handing it the OS recogniser's
//!    output when the model has no vision ([`ocr`]).
//! 3. The proposal comes back as *drafts* attached to an assistant message.
//!    Nothing is in the ledger yet.
//! 4. The user confirms (and edits) in a dialog; [`finance_confirm_drafts`] is
//!    what actually writes records.
//!
//! Keeping step 3 and 4 apart is the point: a model reading a screenshot is a
//! suggestion, and the ledger only ever contains numbers a human agreed to.

mod extract;
mod ocr;
mod store;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use base64::Engine;

/// The categories the model may choose from, and the ledger's canonical set.
/// The frontend maps these to colours/icons and falls back gracefully for a name
/// it does not know, so the two lists can drift without breaking.
pub(crate) const CATEGORIES: [&str; 11] = [
    "餐饮", "交通", "购物", "居住", "娱乐", "医疗", "教育", "人情", "通讯", "旅行", "其他",
];

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_CAPTURE_TEXT_CHARS: usize = 2_000;

/// One confirmed entry in the ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseRecord {
    id: String,
    /// `YYYY-MM-DD`, in the user's local calendar. Decides which month file the
    /// record lives in.
    date: String,
    /// Always positive; `direction` carries the sign.
    amount: f64,
    /// "expense" | "income".
    direction: String,
    currency: String,
    category: String,
    merchant: String,
    /// How it was paid — "招商银行储蓄卡(1234)", "微信零钱", …
    method: String,
    note: String,
    /// Path of the receipt image relative to `finance/`, when it came from one.
    #[serde(default)]
    receipt: Option<String>,
    /// "vision" | "ocr" | "text" | "manual" — how this record came to be.
    source: String,
    created_at: u64,
    updated_at: u64,
}

/// What the model proposed, before anyone agreed to it. Same shape as a record
/// minus the identity the ledger assigns on save.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpenseDraft {
    date: String,
    amount: f64,
    direction: String,
    currency: String,
    category: String,
    merchant: String,
    method: String,
    note: String,
}

/// An existing ledger row that looks like one of the drafts being reviewed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateMatch {
    draft_index: usize,
    record_id: String,
    date: String,
    amount: f64,
    direction: String,
    currency: String,
    merchant: String,
    category: String,
}

/// One turn of the capture conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureMessage {
    id: String,
    /// "user" | "assistant".
    role: String,
    text: String,
    #[serde(default)]
    receipt: Option<String>,
    /// Assistant messages only: what the model proposed. Kept after saving so the
    /// dialog can be reopened.
    #[serde(default)]
    drafts: Vec<ExpenseDraft>,
    /// Ids of the records actually written from this message. Empty until the
    /// user confirms.
    #[serde(default)]
    saved_ids: Vec<String>,
    /// "vision" | "ocr" | "text".
    #[serde(default)]
    reader: Option<String>,
    /// What the OCR read, so a wrong answer can be diagnosed.
    #[serde(default)]
    ocr_text: Option<String>,
    #[serde(default)]
    error: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceSettings {
    /// Null means "follow the global default chat model", so starring a new
    /// default model also moves the ledger over to it.
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default = "default_currency")]
    currency: String,
}

fn default_currency() -> String {
    "CNY".to_string()
}

impl Default for FinanceSettings {
    fn default() -> Self {
        Self {
            provider_id: None,
            model_id: None,
            currency: default_currency(),
        }
    }
}

/// Everything the finance UI needs to render itself in one call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceStatus {
    settings: FinanceSettings,
    categories: Vec<String>,
    /// Whether the OCR fallback can run on this machine.
    ocr_available: bool,
    ocr_engine: String,
}

/// Partial edit of a record. An absent field is left alone.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPatch {
    date: Option<String>,
    amount: Option<f64>,
    direction: Option<String>,
    currency: Option<String>,
    category: Option<String>,
    merchant: Option<String>,
    method: Option<String>,
    note: Option<String>,
}

impl RecordPatch {
    fn apply(&self, record: &mut ExpenseRecord) -> Result<(), String> {
        if let Some(date) = &self.date {
            record.date = clean_date(date)?;
        }
        if let Some(amount) = self.amount {
            record.amount = clean_amount(amount)?;
        }
        if let Some(direction) = &self.direction {
            record.direction = clean_direction(direction);
        }
        if let Some(currency) = &self.currency {
            record.currency = clamp(currency, 8);
        }
        if let Some(category) = &self.category {
            record.category = clamp(category, 20);
        }
        if let Some(merchant) = &self.merchant {
            record.merchant = clamp(merchant, 80);
        }
        if let Some(method) = &self.method {
            record.method = clamp(method, 60);
        }
        if let Some(note) = &self.note {
            record.note = clamp(note, 200);
        }
        Ok(())
    }
}

fn clamp(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn clean_date(date: &str) -> Result<String, String> {
    let date = date.trim();
    let bytes = date.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if !shaped {
        return Err("日期格式必须是 YYYY-MM-DD。".into());
    }
    Ok(date.to_string())
}

fn clean_amount(amount: f64) -> Result<f64, String> {
    if !amount.is_finite() || amount <= 0.0 {
        return Err("金额必须是大于 0 的数字。".into());
    }
    Ok((amount * 100.0).round() / 100.0)
}

fn clean_direction(direction: &str) -> String {
    if direction.eq_ignore_ascii_case("income") {
        "income".to_string()
    } else {
        "expense".to_string()
    }
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

fn record_from_draft(
    draft: &ExpenseDraft,
    receipt: Option<String>,
    source: &str,
) -> Result<ExpenseRecord, String> {
    let timestamp = store::now();
    Ok(ExpenseRecord {
        id: new_id("exp"),
        date: clean_date(&draft.date)?,
        amount: clean_amount(draft.amount)?,
        direction: clean_direction(&draft.direction),
        currency: {
            let currency = clamp(&draft.currency, 8);
            if currency.is_empty() {
                default_currency()
            } else {
                currency
            }
        },
        category: {
            let category = clamp(&draft.category, 20);
            if category.is_empty() {
                "其他".to_string()
            } else {
                category
            }
        },
        merchant: clamp(&draft.merchant, 80),
        method: clamp(&draft.method, 60),
        note: clamp(&draft.note, 200),
        receipt,
        source: source.to_string(),
        created_at: timestamp,
        updated_at: timestamp,
    })
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn finance_status(app: AppHandle) -> Result<FinanceStatus, String> {
    Ok(FinanceStatus {
        settings: store::read_settings(&app)?,
        categories: CATEGORIES.iter().map(|c| (*c).to_string()).collect(),
        ocr_available: ocr::available(),
        ocr_engine: ocr::engine_name().to_string(),
    })
}

/// Pin the model used to read receipts. Passing nulls goes back to following the
/// global default chat model.
#[tauri::command]
pub fn finance_set_model(
    app: AppHandle,
    provider_id: Option<String>,
    model_id: Option<String>,
) -> Result<FinanceSettings, String> {
    let mut settings = store::read_settings(&app)?;
    let pair = provider_id
        .filter(|value| !value.trim().is_empty())
        .zip(model_id.filter(|value| !value.trim().is_empty()));
    match pair {
        Some((provider, model)) => {
            settings.provider_id = Some(provider);
            settings.model_id = Some(model);
        }
        None => {
            settings.provider_id = None;
            settings.model_id = None;
        }
    }
    store::write_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn finance_list_months(app: AppHandle) -> Result<Vec<String>, String> {
    store::list_months(&app)
}

#[tauri::command]
pub fn finance_list_records(
    app: AppHandle,
    month: Option<String>,
) -> Result<Vec<ExpenseRecord>, String> {
    store::list_records(&app, month.as_deref())
}

#[tauri::command]
pub fn finance_list_messages(app: AppHandle) -> Result<Vec<CaptureMessage>, String> {
    store::read_messages(&app)
}

#[tauri::command]
pub fn finance_clear_messages(app: AppHandle) -> Result<(), String> {
    store::write_messages(&app, &[])
}

/// Store an optional receipt, ask the model to understand the text and/or image,
/// and return the two messages the chat should show: the user's, and the
/// assistant's proposal.
///
/// A failed extraction is *not* an error — the receipt is already saved and the
/// assistant message carries the reason, so the conversation stays honest about
/// what happened and the user can retry or fill the entry in by hand.
#[tauri::command]
pub async fn finance_capture(
    app: AppHandle,
    data_base64: Option<String>,
    mime_type: Option<String>,
    note: String,
    today: String,
) -> Result<Vec<CaptureMessage>, String> {
    let image = match (data_base64, mime_type) {
        (Some(data), Some(mime)) => Some((
            base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|error| format!("无法读取图片：{error}"))?,
            mime,
        )),
        (None, None) => None,
        _ => return Err("图片数据不完整。".into()),
    };
    capture_input(app, image, &note, &today).await
}

/// The same flow for a picture dropped onto the window, which Tauri hands over as
/// a filesystem path rather than bytes.
#[tauri::command]
pub async fn finance_capture_file(
    app: AppHandle,
    path: String,
    note: String,
    today: String,
) -> Result<Vec<CaptureMessage>, String> {
    let source = std::path::PathBuf::from(&path);
    let mime = match source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        _ => return Err("只支持 PNG 或 JPEG 图片。".into()),
    };
    let bytes = std::fs::read(&source).map_err(|error| format!("无法读取图片：{error}"))?;
    capture_input(app, Some((bytes, mime.to_string())), &note, &today).await
}

async fn capture_input(
    app: AppHandle,
    image: Option<(Vec<u8>, String)>,
    note: &str,
    today: &str,
) -> Result<Vec<CaptureMessage>, String> {
    let today = clean_date(today)?;
    let note: String = note.trim().chars().take(MAX_CAPTURE_TEXT_CHARS).collect();
    if image.is_none() && note.is_empty() {
        return Err("请输入记账信息或添加一张图片。".into());
    }
    if let Some((bytes, _)) = image.as_ref()
        && (bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES)
    {
        return Err("图片为空或超过 25 MB。".into());
    }

    let settings = store::read_settings(&app)?;
    let month = store::month_of(&today);
    let stored = if let Some((bytes, mime_type)) = image {
        let app_for_save = app.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                store::save_receipt(&app_for_save, &bytes, &mime_type, &month)
            })
            .await
            .map_err(|error| format!("保存票据失败：{error}"))??,
        )
    } else {
        None
    };
    let receipt = stored.as_ref().map(|(path, _)| path.clone());

    let user_message = store::append_message(
        &app,
        CaptureMessage {
            id: new_id("msg"),
            role: "user".into(),
            text: note,
            receipt: receipt.clone(),
            drafts: Vec::new(),
            saved_ids: Vec::new(),
            reader: None,
            ocr_text: None,
            error: None,
            created_at: store::now(),
        },
    )?;

    let receipt_abs = receipt
        .as_deref()
        .map(|path| store::receipt_path(&app, path))
        .transpose()?;
    let receipt_for_model = receipt_abs
        .as_deref()
        .zip(stored.as_ref().map(|(_, mime)| mime.as_str()));
    let outcome = extract::extract(
        &app,
        receipt_for_model,
        &user_message.text,
        &today,
        &settings.currency,
    )
    .await;

    let assistant = match outcome {
        Ok(extraction) => CaptureMessage {
            id: new_id("msg"),
            role: "assistant".into(),
            text: if extraction.drafts.is_empty() && extraction.summary.is_empty() {
                "没有识别出可记账的交易。".to_string()
            } else {
                extraction.summary
            },
            receipt: None,
            drafts: extraction.drafts,
            saved_ids: Vec::new(),
            reader: Some(extraction.reader),
            ocr_text: (!extraction.ocr_text.is_empty()).then_some(extraction.ocr_text),
            error: None,
            created_at: store::now(),
        },
        Err(error) => CaptureMessage {
            id: new_id("msg"),
            role: "assistant".into(),
            text: String::new(),
            receipt: None,
            drafts: Vec::new(),
            saved_ids: Vec::new(),
            reader: None,
            ocr_text: None,
            error: Some(error),
            created_at: store::now(),
        },
    };
    let assistant = store::append_message(&app, assistant)?;
    Ok(vec![user_message, assistant])
}

/// Write the drafts the user confirmed (possibly after editing them) into the
/// ledger, and remember on the message which records came out of it.
#[tauri::command]
pub fn finance_confirm_drafts(
    app: AppHandle,
    message_id: String,
    drafts: Vec<ExpenseDraft>,
) -> Result<Vec<ExpenseRecord>, String> {
    if drafts.is_empty() {
        return Err("没有要保存的账目。".into());
    }
    let mut messages = store::read_messages(&app)?;
    let index = messages
        .iter()
        .position(|message| message.id == message_id)
        .ok_or("消息不存在。")?;

    // The receipt belongs only to the user turn this assistant message answered.
    // Looking farther back would attach an older image to a later text-only entry.
    let receipt = index
        .checked_sub(1)
        .and_then(|user_index| messages.get(user_index))
        .filter(|message| message.role == "user")
        .and_then(|message| message.receipt.clone());
    let source = messages[index]
        .reader
        .clone()
        .unwrap_or_else(|| "manual".into());

    let records = drafts
        .iter()
        .map(|draft| record_from_draft(draft, receipt.clone(), &source))
        .collect::<Result<Vec<_>, String>>()?;
    store::insert_records(&app, &records)?;

    messages[index].drafts = drafts;
    messages[index].saved_ids = records.iter().map(|record| record.id.clone()).collect();
    let updated = messages[index].clone();
    store::replace_message(&app, &updated)?;
    Ok(records)
}

/// Add a record by hand, with no receipt behind it.
#[tauri::command]
pub fn finance_add_record(app: AppHandle, draft: ExpenseDraft) -> Result<ExpenseRecord, String> {
    let record = record_from_draft(&draft, None, "manual")?;
    store::insert_records(&app, std::slice::from_ref(&record))?;
    Ok(record)
}

#[tauri::command]
pub fn finance_update_record(
    app: AppHandle,
    id: String,
    patch: RecordPatch,
) -> Result<ExpenseRecord, String> {
    store::update_record(&app, &id, patch)
}

#[tauri::command]
pub fn finance_delete_record(app: AppHandle, id: String) -> Result<(), String> {
    store::delete_record(&app, &id)
}

/// Find likely duplicates across the complete ledger, not just the month that is
/// currently visible. Editing can exclude the record being edited from matching
/// itself.
#[tauri::command]
pub fn finance_find_duplicates(
    app: AppHandle,
    drafts: Vec<ExpenseDraft>,
    exclude_record_id: Option<String>,
) -> Result<Vec<DuplicateMatch>, String> {
    let records = store::list_records(&app, None)?;
    Ok(find_duplicate_records(
        &records,
        &drafts,
        exclude_record_id.as_deref(),
    ))
}

/// A stored receipt as a `data:` URL, for display in the chat and the dialog.
#[tauri::command]
pub fn finance_read_receipt(app: AppHandle, path: String) -> Result<String, String> {
    let absolute = store::receipt_path(&app, &path)?;
    let mime = match absolute.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "image/png",
    };
    let bytes = std::fs::read(&absolute).map_err(|error| format!("无法读取票据图片：{error}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Absolute path of the finance data folder, for "reveal in Finder / Explorer".
#[tauri::command]
pub fn finance_reveal_path(app: AppHandle) -> Result<String, String> {
    Ok(crate::storage::current_root(&app)?
        .join("finance")
        .to_string_lossy()
        .into_owned())
}

fn merchant_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn looks_like_same_transaction(record: &ExpenseRecord, draft: &ExpenseDraft) -> bool {
    let merchant = merchant_key(&draft.merchant);
    let currency = if draft.currency.trim().is_empty() {
        "CNY"
    } else {
        draft.currency.trim()
    };
    !merchant.is_empty()
        && merchant == merchant_key(&record.merchant)
        && record.date == draft.date.trim()
        && (record.amount - draft.amount).abs() < 0.005
        && record.direction == clean_direction(&draft.direction)
        && record.currency.eq_ignore_ascii_case(currency)
}

fn find_duplicate_records(
    records: &[ExpenseRecord],
    drafts: &[ExpenseDraft],
    exclude_record_id: Option<&str>,
) -> Vec<DuplicateMatch> {
    drafts
        .iter()
        .enumerate()
        .filter_map(|(draft_index, draft)| {
            records
                .iter()
                .find(|record| {
                    Some(record.id.as_str()) != exclude_record_id
                        && looks_like_same_transaction(record, draft)
                })
                .map(|record| DuplicateMatch {
                    draft_index,
                    record_id: record.id.clone(),
                    date: record.date.clone(),
                    amount: record.amount,
                    direction: record.direction.clone(),
                    currency: record.currency.clone(),
                    merchant: record.merchant.clone(),
                    category: record.category.clone(),
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> ExpenseDraft {
        ExpenseDraft {
            date: "2026-08-28".into(),
            amount: 68.499,
            direction: "支出".into(),
            currency: String::new(),
            category: String::new(),
            merchant: "  瑞幸咖啡  ".into(),
            method: String::new(),
            note: String::new(),
        }
    }

    #[test]
    fn a_draft_becomes_a_normalised_record() {
        let record = record_from_draft(&draft(), Some("receipts/2026-08/a.png".into()), "vision")
            .expect("record");
        assert_eq!(record.amount, 68.5);
        // Anything that is not "income" is a spend.
        assert_eq!(record.direction, "expense");
        assert_eq!(record.currency, "CNY");
        assert_eq!(record.category, "其他");
        assert_eq!(record.merchant, "瑞幸咖啡");
        assert_eq!(record.source, "vision");
    }

    #[test]
    fn rejects_impossible_amounts_and_dates() {
        let mut zero = draft();
        zero.amount = 0.0;
        assert!(record_from_draft(&zero, None, "manual").is_err());

        let mut bad_date = draft();
        bad_date.date = "2026/08/28".into();
        assert!(record_from_draft(&bad_date, None, "manual").is_err());
    }

    #[test]
    fn a_patch_only_touches_the_fields_it_carries() {
        let mut record = record_from_draft(&draft(), None, "manual").unwrap();
        let patch = RecordPatch {
            category: Some("餐饮".into()),
            amount: Some(12.0),
            ..RecordPatch::default()
        };
        patch.apply(&mut record).unwrap();
        assert_eq!(record.category, "餐饮");
        assert_eq!(record.amount, 12.0);
        assert_eq!(record.merchant, "瑞幸咖啡");
        assert_eq!(record.date, "2026-08-28");
    }

    #[test]
    fn duplicate_matching_normalises_merchant_punctuation_and_can_exclude_self() {
        let mut existing = record_from_draft(&draft(), None, "manual").unwrap();
        existing.merchant = "瑞幸 咖啡".into();
        let mut repeated = draft();
        repeated.amount = 68.5;
        repeated.merchant = "瑞幸咖啡".into();

        let matches = find_duplicate_records(&[existing.clone()], &[repeated.clone()], None);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].record_id, existing.id);
        assert!(
            find_duplicate_records(&[existing.clone()], &[repeated], Some(&existing.id)).is_empty()
        );
    }
}
