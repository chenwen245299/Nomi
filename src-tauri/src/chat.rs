use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::{providers, storage};

const CHAT_DIR: &str = "chat";
const ASSISTANT_FILE: &str = "assistant.json";
const CONVERSATION_FILE: &str = "conversation.json";
const ASSETS_DIR: &str = "assets";
const CHAT_SETTINGS_FILE: &str = "chat-settings.json";
const UNTITLED_CONVERSATION: &str = "新对话";
const ASSISTANT_EMOJIS: [&str; 16] = [
    "✨", "🌟", "🧠", "🪄", "🦉", "🐳", "🦊", "🐼", "🌈", "🚀", "🎯", "📝", "🔭", "🎨", "🌿", "💡",
];
static EMOJI_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub const DEFAULT_TITLE_PROMPT: &str = "你是 Nomi 的对话标题生成器。根据用户发出的第一条消息，为这段对话生成一个简洁、具体、便于扫描和检索的标题。\n\n要求：\n- 准确概括用户的核心意图、对象与任务；优先保留关键专有名词。\n- 使用与用户消息相同的主要语言。\n- 中文控制在 6–18 个汉字；英文控制在 3–10 个单词。\n- 不要回答问题，不要补充消息中没有的信息。\n- 不使用“关于……”“咨询……”“用户想要……”等空泛前缀。\n- 不要输出引号、句号、冒号、Markdown、编号或解释。\n- 只输出一行标题。";

/// Reserved id/folder for the implicit "default" assistant (empty system prompt).
/// Conversations started without picking an assistant live here. Hidden from the
/// assistant switcher, but its conversations still appear in the "all chats" view.
pub(crate) const DEFAULT_ASSISTANT_ID: &str = "__default__";
const DEFAULT_ASSISTANT_NAME: &str = "默认助手";

// Data layout under the user's data folder:
//   chat/
//     <assistant-id>/
//       assistant.json                 (name, system prompt, …)
//       <conversation-id>/
//         conversation.json            (title, timestamps)
//         assets/                      (images / files / audio / video)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assistant {
    id: String,
    name: String,
    system_prompt: String,
    #[serde(default)]
    emoji: String,
    /// The assistant's default provider + model. New conversations inherit these;
    /// the composer's per-conversation picker can override them.
    #[serde(default)]
    default_provider_id: Option<String>,
    #[serde(default)]
    default_model_id: Option<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    id: String,
    title: String,
    /// The provider + model this conversation uses, remembered across sessions.
    /// Inherited from the assistant on creation; changed by the composer picker.
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    created_at: u64,
    updated_at: u64,
    /// Timestamp of the newest persisted user/assistant message. Kept separate
    /// from `updated_at`, which also changes for metadata edits.
    #[serde(default)]
    last_message_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    /// Null means “follow the global default model”. Keeping this dynamic means
    /// changing the global default also changes title generation automatically.
    #[serde(default)]
    pub(crate) title_provider_id: Option<String>,
    #[serde(default)]
    pub(crate) title_model_id: Option<String>,
    #[serde(default = "default_title_prompt")]
    pub(crate) title_prompt: String,
}

fn default_title_prompt() -> String {
    DEFAULT_TITLE_PROMPT.to_string()
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            title_provider_id: None,
            title_model_id: None,
            title_prompt: default_title_prompt(),
        }
    }
}

fn conversation_activity_at(conversation: &Conversation) -> u64 {
    conversation
        .last_message_at
        .unwrap_or(conversation.created_at)
}

fn inherited_model(app: &AppHandle, assistant: &Assistant) -> Option<(String, String)> {
    assistant
        .default_provider_id
        .clone()
        .zip(assistant.default_model_id.clone())
        .or_else(|| providers::default_chat_model(app).ok().flatten())
}

fn backfill_conversation_model(
    app: &AppHandle,
    assistant: &Assistant,
    conversation_dir: &Path,
    conversation: &mut Conversation,
) {
    if conversation.provider_id.is_some() && conversation.model_id.is_some() {
        return;
    }
    if let Some((provider_id, model_id)) = inherited_model(app, assistant) {
        conversation.provider_id = Some(provider_id);
        conversation.model_id = Some(model_id);
        let _ = write_json(&conversation_dir.join(CONVERSATION_FILE), conversation);
    }
}

/// Older conversation files predate `lastMessageAt`. Derive it once from the
/// transcript and persist the migrated value without changing `updatedAt`.
fn backfill_last_message_at(conversation_dir: &Path, conversation: &mut Conversation) {
    if conversation.last_message_at.is_some() {
        return;
    }
    let latest = latest_message_at(&load_messages(conversation_dir));
    if latest.is_some() {
        conversation.last_message_at = latest;
        let _ = write_json(&conversation_dir.join(CONVERSATION_FILE), conversation);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn chat_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(CHAT_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 chat 目录：{error}"))?;
    Ok(dir)
}

fn chat_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = storage::current_root(app)?.join(".nomi");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    Ok(dir.join(CHAT_SETTINGS_FILE))
}

pub(crate) fn read_chat_settings(app: &AppHandle) -> Result<ChatSettings, String> {
    let path = chat_settings_path(app)?;
    if !path.exists() {
        return Ok(ChatSettings::default());
    }
    read_json(&path).map_err(|error| format!("无法读取对话设置：{error}"))
}

#[tauri::command]
pub fn get_chat_settings(app: AppHandle) -> Result<ChatSettings, String> {
    read_chat_settings(&app)
}

#[tauri::command]
pub fn set_chat_settings(
    app: AppHandle,
    title_provider_id: Option<String>,
    title_model_id: Option<String>,
    title_prompt: String,
) -> Result<ChatSettings, String> {
    let title_prompt = title_prompt.trim().to_string();
    if title_prompt.is_empty() {
        return Err("标题生成提示词不能为空。".into());
    }
    if title_prompt.chars().count() > 8_000 {
        return Err("标题生成提示词不能超过 8000 个字符。".into());
    }
    let configured_model = title_provider_id
        .filter(|value| !value.trim().is_empty())
        .zip(title_model_id.filter(|value| !value.trim().is_empty()));
    let (title_provider_id, title_model_id) = match configured_model {
        Some((provider_id, model_id)) => (Some(provider_id), Some(model_id)),
        None => (None, None),
    };
    let settings = ChatSettings {
        title_provider_id,
        title_model_id,
        title_prompt,
    };
    write_json(&chat_settings_path(&app)?, &settings)
        .map_err(|error| format!("无法保存对话设置：{error}"))?;
    Ok(settings)
}

/// Apply an automatically generated title without overwriting a title that was
/// changed while generation was in flight.
pub(crate) fn set_generated_conversation_title(
    app: &AppHandle,
    assistant_id: &str,
    id: &str,
    title: &str,
) -> Result<bool, String> {
    let config = assistant_dir(app, assistant_id)?
        .join(safe_id(id)?)
        .join(CONVERSATION_FILE);
    let mut conversation: Conversation = read_json(&config)?;
    if !conversation.title.trim().is_empty() && conversation.title != UNTITLED_CONVERSATION {
        return Ok(false);
    }
    conversation.title = title.trim().to_string();
    conversation.updated_at = now();
    write_json(&config, &conversation)?;
    Ok(true)
}

/// Turn a display name into a filesystem-safe folder name. Keeps CJK and most
/// characters (readable folders), replaces only path-unsafe / reserved ones.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let limited: String = trimmed.chars().take(48).collect();
    let out = limited.trim().to_string();
    if out.is_empty() {
        "未命名".to_string()
    } else {
        out
    }
}

/// A conversation's stable, opaque folder name / id. Deliberately independent of
/// the title: the title is generated asynchronously after the first message and
/// can be edited later, and the id is the runtime key + the MCP folder handle, so
/// it must never move. (Assistants stay name-derived — their name is user-set, not
/// async, so there is no stale-folder problem to avoid.)
fn new_conversation_id() -> String {
    format!("conv-{}", uuid::Uuid::new_v4())
}

/// A folder name derived from `base`, guaranteed not to collide inside `parent`.
fn unique_dir_name(parent: &Path, base: &str) -> String {
    let base = sanitize(base);
    if !parent.join(&base).exists() {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !parent.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Reject ids that are not a single, safe path component (no traversal).
fn safe_id(id: &str) -> Result<&str, String> {
    let mut components = Path::new(id).components();
    let is_single = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if !is_single {
        return Err("非法的标识符。".into());
    }
    Ok(id)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    contents.push('\n');
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn assistant_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = chat_root(app)?.join(safe_id(id)?);
    if !dir.is_dir() {
        return Err("助手不存在。".into());
    }
    Ok(dir)
}

fn random_assistant_emoji() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = EMOJI_SEQUENCE.fetch_add(1, Ordering::Relaxed) as u128;
    ASSISTANT_EMOJIS[((nanos ^ sequence) % ASSISTANT_EMOJIS.len() as u128) as usize].to_string()
}

fn normalized_assistant_emoji(emoji: String) -> String {
    let emoji = emoji.trim();
    if emoji.is_empty() {
        random_assistant_emoji()
    } else {
        emoji.to_string()
    }
}

// ── Assistants ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_assistants(app: AppHandle) -> Result<Vec<Assistant>, String> {
    let root = chat_root(&app)?;
    let mut assistants = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let config = entry.path().join(ASSISTANT_FILE);
        if config.exists()
            && let Ok(assistant) = read_json::<Assistant>(&config)
        {
            assistants.push(assistant);
        }
    }
    assistants.sort_by_key(|assistant| assistant.created_at);
    Ok(assistants)
}

#[tauri::command]
pub fn create_assistant(
    app: AppHandle,
    name: String,
    system_prompt: String,
    emoji: Option<String>,
    default_provider_id: Option<String>,
    default_model_id: Option<String>,
) -> Result<Assistant, String> {
    let root = chat_root(&app)?;
    let id = unique_dir_name(&root, &name);
    let dir = root.join(&id);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建助手目录：{error}"))?;

    let timestamp = now();
    let assistant = Assistant {
        id,
        name: name.trim().to_string(),
        system_prompt,
        emoji: normalized_assistant_emoji(emoji.unwrap_or_default()),
        default_provider_id: default_provider_id.filter(|value| !value.is_empty()),
        default_model_id: default_model_id.filter(|value| !value.is_empty()),
        created_at: timestamp,
        updated_at: timestamp,
    };
    write_json(&dir.join(ASSISTANT_FILE), &assistant)?;
    Ok(assistant)
}

#[tauri::command]
pub fn update_assistant(
    app: AppHandle,
    id: String,
    name: String,
    system_prompt: String,
    emoji: Option<String>,
    default_provider_id: Option<String>,
    default_model_id: Option<String>,
) -> Result<Assistant, String> {
    let dir = assistant_dir(&app, &id)?;
    let config = dir.join(ASSISTANT_FILE);
    let mut assistant: Assistant = read_json(&config)?;
    assistant.name = name.trim().to_string();
    assistant.system_prompt = system_prompt;
    if let Some(emoji) = emoji {
        assistant.emoji = normalized_assistant_emoji(emoji);
    }
    // Model fields are always sent by the settings form (as null when unset), so
    // assign them directly rather than only-when-Some.
    assistant.default_provider_id = default_provider_id.filter(|s| !s.is_empty());
    assistant.default_model_id = default_model_id.filter(|s| !s.is_empty());
    assistant.updated_at = now();
    write_json(&config, &assistant)?;
    Ok(assistant)
}

#[tauri::command]
pub fn delete_assistant(app: AppHandle, id: String) -> Result<(), String> {
    let dir = assistant_dir(&app, &id)?;
    fs::remove_dir_all(&dir).map_err(|error| format!("无法删除助手：{error}"))
}

// ── Conversations ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_conversations(
    app: AppHandle,
    assistant_id: String,
) -> Result<Vec<Conversation>, String> {
    let dir = assistant_dir(&app, &assistant_id)?;
    let assistant: Assistant = read_json(&dir.join(ASSISTANT_FILE))?;
    let mut conversations = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let config = entry.path().join(CONVERSATION_FILE);
        if config.exists()
            && let Ok(mut conversation) = read_json::<Conversation>(&config)
        {
            backfill_conversation_model(&app, &assistant, &entry.path(), &mut conversation);
            backfill_last_message_at(&entry.path(), &mut conversation);
            conversations.push(conversation);
        }
    }
    conversations
        .sort_by_key(|conversation| std::cmp::Reverse(conversation_activity_at(conversation)));
    Ok(conversations)
}

/// A conversation plus the assistant it belongs to — for the flat "all chats"
/// list, where rows come from every assistant.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(flatten)]
    conversation: Conversation,
    assistant_id: String,
    assistant_name: String,
    /// Model used by the first assistant reply. Absent for a new conversation
    /// or a legacy reply that predates model metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_response_model: Option<String>,
}

/// Every conversation across every assistant, newest first. Powers the "全部对话"
/// view; each row carries its owning assistant so it can be opened directly.
#[tauri::command]
pub fn list_all_conversations(app: AppHandle) -> Result<Vec<ConversationSummary>, String> {
    let root = chat_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let assistant: Assistant = match read_json(&dir.join(ASSISTANT_FILE)) {
            Ok(assistant) => assistant,
            Err(_) => continue,
        };
        for conv_entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let conv_entry = conv_entry.map_err(|error| error.to_string())?;
            if !conv_entry.path().is_dir() {
                continue;
            }
            let config = conv_entry.path().join(CONVERSATION_FILE);
            if config.exists()
                && let Ok(mut conversation) = read_json::<Conversation>(&config)
            {
                backfill_conversation_model(
                    &app,
                    &assistant,
                    &conv_entry.path(),
                    &mut conversation,
                );
                backfill_last_message_at(&conv_entry.path(), &mut conversation);
                let first_response_model = first_response_model(&load_messages(&conv_entry.path()));
                out.push(ConversationSummary {
                    conversation,
                    assistant_id: assistant.id.clone(),
                    assistant_name: assistant.name.clone(),
                    first_response_model,
                });
            }
        }
    }
    out.sort_by_key(|summary| std::cmp::Reverse(conversation_activity_at(&summary.conversation)));
    Ok(out)
}

/// Create (if missing) the reserved default assistant and return its folder.
fn ensure_default_assistant(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = chat_root(app)?.join(DEFAULT_ASSISTANT_ID);
    let config = dir.join(ASSISTANT_FILE);
    if !config.exists() {
        fs::create_dir_all(&dir).map_err(|error| format!("无法创建默认助手目录：{error}"))?;
        let timestamp = now();
        let assistant = Assistant {
            id: DEFAULT_ASSISTANT_ID.to_string(),
            name: DEFAULT_ASSISTANT_NAME.to_string(),
            system_prompt: String::new(),
            emoji: random_assistant_emoji(),
            default_provider_id: None,
            default_model_id: None,
            created_at: timestamp,
            updated_at: timestamp,
        };
        write_json(&config, &assistant)?;
    }
    Ok(dir)
}

/// Start a conversation under the implicit default assistant (empty prompt),
/// used when the user is in "全部对话" and hasn't picked a specific assistant.
#[tauri::command]
pub fn create_default_conversation(
    app: AppHandle,
    title: String,
) -> Result<ConversationSummary, String> {
    ensure_default_assistant(&app)?;
    let conversation = create_conversation(app, DEFAULT_ASSISTANT_ID.to_string(), title)?;
    Ok(ConversationSummary {
        conversation,
        assistant_id: DEFAULT_ASSISTANT_ID.to_string(),
        assistant_name: DEFAULT_ASSISTANT_NAME.to_string(),
        first_response_model: None,
    })
}

/// Configure the system prompt and model inherited by ordinary conversations
/// created from "全部对话". Null model values inherit the global default.
#[tauri::command]
pub fn set_default_conversation_settings(
    app: AppHandle,
    emoji: String,
    system_prompt: String,
    provider_id: Option<String>,
    model_id: Option<String>,
) -> Result<Assistant, String> {
    let dir = ensure_default_assistant(&app)?;
    let config = dir.join(ASSISTANT_FILE);
    let mut assistant: Assistant = read_json(&config)?;
    assistant.emoji = normalized_assistant_emoji(emoji);
    assistant.system_prompt = system_prompt;
    let configured = provider_id
        .filter(|value| !value.is_empty())
        .zip(model_id.filter(|value| !value.is_empty()));
    (assistant.default_provider_id, assistant.default_model_id) = match configured {
        Some((provider_id, model_id)) => (Some(provider_id), Some(model_id)),
        None => (None, None),
    };
    assistant.updated_at = now();
    write_json(&config, &assistant)?;
    Ok(assistant)
}

#[tauri::command]
pub fn create_conversation(
    app: AppHandle,
    assistant_id: String,
    title: String,
) -> Result<Conversation, String> {
    let dir = assistant_dir(&app, &assistant_id)?;
    // New conversations inherit the assistant's default provider + model.
    let assistant: Assistant = read_json(&dir.join(ASSISTANT_FILE))?;
    // Opaque, stable folder name so the async-generated title never has to rename
    // the folder (which would change the id the whole app + MCP key off).
    let id = new_conversation_id();
    let conversation_dir = dir.join(&id);
    fs::create_dir_all(conversation_dir.join(ASSETS_DIR))
        .map_err(|error| format!("无法创建对话目录：{error}"))?;

    let timestamp = now();
    let inherited = inherited_model(&app, &assistant);
    let (provider_id, model_id) = inherited
        .map(|(provider_id, model_id)| (Some(provider_id), Some(model_id)))
        .unwrap_or((None, None));
    let conversation = Conversation {
        id,
        title: title.trim().to_string(),
        provider_id,
        model_id,
        created_at: timestamp,
        updated_at: timestamp,
        last_message_at: None,
    };
    write_json(&conversation_dir.join(CONVERSATION_FILE), &conversation)?;
    Ok(conversation)
}

/// Move a conversation to another assistant while keeping its transcript and
/// assets intact. Existing conversations keep their explicitly selected model;
/// a still-empty conversation adopts the destination assistant's default.
#[tauri::command]
pub fn set_conversation_assistant(
    app: AppHandle,
    assistant_id: String,
    id: String,
    target_assistant_id: String,
) -> Result<ConversationSummary, String> {
    let source_parent = assistant_dir(&app, &assistant_id)?;
    let source_dir = source_parent.join(safe_id(&id)?);
    if !source_dir.is_dir() {
        return Err("对话不存在。".into());
    }
    let messages = load_messages(&source_dir);
    let first_response_model = first_response_model(&messages);

    let target_parent = if target_assistant_id == DEFAULT_ASSISTANT_ID {
        ensure_default_assistant(&app)?
    } else {
        assistant_dir(&app, &target_assistant_id)?
    };
    let target_assistant: Assistant = read_json(&target_parent.join(ASSISTANT_FILE))?;
    let original: Conversation = read_json(&source_dir.join(CONVERSATION_FILE))?;

    if assistant_id == target_assistant_id {
        return Ok(ConversationSummary {
            conversation: original,
            assistant_id: target_assistant.id,
            assistant_name: target_assistant.name,
            first_response_model,
        });
    }

    // Opaque ids don't collide across assistants, so a move keeps the id; the
    // fallback only guards a practically-impossible clash (e.g. legacy data).
    let next_id = if target_parent.join(&original.id).exists() {
        new_conversation_id()
    } else {
        original.id.clone()
    };
    let target_dir = target_parent.join(&next_id);
    let mut moved = original.clone();
    moved.id = next_id;
    moved.updated_at = now();
    if messages.is_empty() {
        let inherited = inherited_model(&app, &target_assistant);
        (moved.provider_id, moved.model_id) = inherited
            .map(|(provider_id, model_id)| (Some(provider_id), Some(model_id)))
            .unwrap_or((None, None));
    }

    let source_config = source_dir.join(CONVERSATION_FILE);
    write_json(&source_config, &moved)?;
    if let Err(error) = fs::rename(&source_dir, &target_dir) {
        let _ = write_json(&source_config, &original);
        return Err(format!("无法切换对话助手：{error}"));
    }

    Ok(ConversationSummary {
        conversation: moved,
        assistant_id: target_assistant.id,
        assistant_name: target_assistant.name,
        first_response_model,
    })
}

/// Change (and remember) which provider + model a conversation uses.
#[tauri::command]
pub fn set_conversation_model(
    app: AppHandle,
    assistant_id: String,
    id: String,
    provider_id: Option<String>,
    model_id: Option<String>,
) -> Result<Conversation, String> {
    let config = assistant_dir(&app, &assistant_id)?
        .join(safe_id(&id)?)
        .join(CONVERSATION_FILE);
    let mut conversation: Conversation = read_json(&config)?;
    conversation.provider_id = provider_id.filter(|s| !s.is_empty());
    conversation.model_id = model_id.filter(|s| !s.is_empty());
    conversation.updated_at = now();
    write_json(&config, &conversation)?;
    Ok(conversation)
}

#[tauri::command]
pub fn rename_conversation(
    app: AppHandle,
    assistant_id: String,
    id: String,
    title: String,
) -> Result<Conversation, String> {
    let config = assistant_dir(&app, &assistant_id)?
        .join(safe_id(&id)?)
        .join(CONVERSATION_FILE);
    let mut conversation: Conversation = read_json(&config)?;
    conversation.title = title.trim().to_string();
    conversation.updated_at = now();
    write_json(&config, &conversation)?;
    Ok(conversation)
}

#[tauri::command]
pub fn delete_conversation(app: AppHandle, assistant_id: String, id: String) -> Result<(), String> {
    let dir = assistant_dir(&app, &assistant_id)?.join(safe_id(&id)?);
    if !dir.is_dir() {
        return Err("对话不存在。".into());
    }
    fs::remove_dir_all(&dir).map_err(|error| format!("无法删除对话：{error}"))
}

/// Reveal a conversation's own folder in Finder / Explorer. Both ids pass
/// through the same safe-component validation used by every chat file access.
#[tauri::command]
pub fn reveal_conversation(app: AppHandle, assistant_id: String, id: String) -> Result<(), String> {
    let dir = conversation_dir(&app, &assistant_id, &id)?;
    app.opener()
        .reveal_item_in_dir(dir)
        .map_err(|error| format!("无法在文件管理器中显示对话：{error}"))
}

// ── Messages ──────────────────────────────────────────────────────────────────
//
// Persisted to `<conversation>/messages.json` in the same shape the MCP server
// reads (see src/mcp/tools.rs). Fields are additive: `toolCalls` and richer
// attachment metadata are ignored by the MCP reader's allowlist, so they never
// break it.

const MESSAGES_FILE: &str = "messages.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    /// "image" | "audio" | "video" | "file" (PDFs are "file", mime application/pdf).
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    /// Path relative to the conversation folder, e.g. `assets/report.pdf`.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// For PDFs: "processing" while text is being extracted, then "ready" / "none".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments string as produced by the model.
    #[serde(default)]
    pub arguments: String,
    /// Human-readable summary of the result shown in the UI.
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub ok: bool,
    /// Rendered images saved relative to the conversation folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

/// Token usage for one assistant reply. Cache fields are present only for
/// providers that report them (e.g. DeepSeek's prompt cache hit/miss counts).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_hit_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Estimated charge in CNY. This is informational, not billing data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_cny: Option<f64>,
    /// Provider-reported charge in USD (OpenRouter credits), when the provider
    /// returns one — the real charge, unlike `cost_cny`'s local estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// "peak" | "offPeak" when time-of-use pricing was enabled for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing_period: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    /// "user" | "assistant" | "system" | "context_marker".
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reasoning: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<MessageUsage>,
    /// Assistant answers that respond to the same user turn share this id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_group_id: Option<String>,
    /// Only the selected answer in a response group is sent back as history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_for_context: Option<bool>,
    /// "tabs" | "split"; repeated on group members for simple persistence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_layout: Option<String>,
    /// "good" | "bad".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesDoc {
    #[serde(default)]
    messages: Vec<ChatMessage>,
}

/// Absolute path to a conversation folder, validating both ids as safe single
/// components. Shared with the chat runtime (`chat_agent`).
pub(crate) fn conversation_dir(
    app: &AppHandle,
    assistant_id: &str,
    conversation_id: &str,
) -> Result<PathBuf, String> {
    let dir = assistant_dir(app, assistant_id)?.join(safe_id(conversation_id)?);
    if !dir.is_dir() {
        return Err("对话不存在。".into());
    }
    Ok(dir)
}

/// Load a conversation's messages (empty when none saved yet).
pub(crate) fn load_messages(conversation_dir: &Path) -> Vec<ChatMessage> {
    let path = conversation_dir.join(MESSAGES_FILE);
    read_json::<MessagesDoc>(&path)
        .map(|d| d.messages)
        .unwrap_or_default()
}

fn latest_message_at(messages: &[ChatMessage]) -> Option<u64> {
    messages
        .iter()
        .filter(|message| message.role == "user" || message.role == "assistant")
        .map(|message| message.created_at)
        .filter(|timestamp| *timestamp > 0)
        .max()
}

/// Preserve the identity of a conversation: its list icon is based on the
/// model that answered first, not whichever model happens to be selected now.
fn first_response_model(messages: &[ChatMessage]) -> Option<String> {
    let first_reply = messages
        .iter()
        .find(|message| message.role == "assistant")?;
    first_reply
        .model
        .as_deref()
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            first_reply
                .usage
                .as_ref()
                .and_then(|usage| usage.model_id.as_deref())
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
        })
}

/// Persist a conversation's messages, and bump the conversation's `updated_at`
/// so it sorts to the top of the list after activity.
pub(crate) fn save_messages(
    conversation_dir: &Path,
    messages: &[ChatMessage],
) -> Result<(), String> {
    write_json(
        &conversation_dir.join(MESSAGES_FILE),
        &MessagesDoc {
            messages: messages.to_vec(),
        },
    )?;
    let config = conversation_dir.join(CONVERSATION_FILE);
    if let Ok(mut conversation) = read_json::<Conversation>(&config) {
        conversation.updated_at = now();
        conversation.last_message_at = latest_message_at(messages);
        let _ = write_json(&config, &conversation);
    }
    Ok(())
}

/// Ensure the conversation's `assets/` folder exists and return it.
pub(crate) fn assets_dir(conversation_dir: &Path) -> Result<PathBuf, String> {
    let dir = conversation_dir.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建 assets 目录：{error}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn list_messages(
    app: AppHandle,
    assistant_id: String,
    id: String,
) -> Result<Vec<ChatMessage>, String> {
    Ok(load_messages(&conversation_dir(&app, &assistant_id, &id)?))
}

#[tauri::command]
pub fn add_context_marker(
    app: AppHandle,
    assistant_id: String,
    chat_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let dir = conversation_dir(&app, &assistant_id, &chat_id)?;
    let mut messages = load_messages(&dir);
    let has_active_context = messages
        .iter()
        .rev()
        .take_while(|message| message.role != "context_marker")
        .any(|message| message.role == "user" || message.role == "assistant");
    if !has_active_context {
        return Ok(messages);
    }
    messages.push(ChatMessage {
        id: format!("context-{}", uuid::Uuid::new_v4()),
        role: "context_marker".into(),
        content: String::new(),
        model: None,
        reasoning: String::new(),
        attachments: Vec::new(),
        tool_calls: Vec::new(),
        usage: None,
        response_group_id: None,
        selected_for_context: None,
        response_layout: None,
        feedback: None,
        created_at: now_secs(),
    });
    save_messages(&dir, &messages)?;
    Ok(messages)
}

fn response_group_id(message: &ChatMessage) -> &str {
    message.response_group_id.as_deref().unwrap_or(&message.id)
}

#[tauri::command]
pub fn edit_chat_message(
    app: AppHandle,
    assistant_id: String,
    chat_id: String,
    message_id: String,
    content: String,
) -> Result<Vec<ChatMessage>, String> {
    let dir = conversation_dir(&app, &assistant_id, &chat_id)?;
    let mut messages = load_messages(&dir);
    let message = messages
        .iter_mut()
        .find(|message| {
            message.id == message_id && (message.role == "user" || message.role == "assistant")
        })
        .ok_or_else(|| "消息不存在。".to_string())?;
    message.content = content;
    save_messages(&dir, &messages)?;
    Ok(messages)
}

#[tauri::command]
pub fn set_chat_message_feedback(
    app: AppHandle,
    assistant_id: String,
    chat_id: String,
    message_id: String,
    feedback: Option<String>,
) -> Result<Vec<ChatMessage>, String> {
    if !matches!(feedback.as_deref(), None | Some("good") | Some("bad")) {
        return Err("不支持的评价。".into());
    }
    let dir = conversation_dir(&app, &assistant_id, &chat_id)?;
    let mut messages = load_messages(&dir);
    let message = messages
        .iter_mut()
        .find(|message| message.id == message_id && message.role == "assistant")
        .ok_or_else(|| "回复不存在。".to_string())?;
    message.feedback = feedback;
    save_messages(&dir, &messages)?;
    Ok(messages)
}

#[tauri::command]
pub fn set_response_group_state(
    app: AppHandle,
    assistant_id: String,
    chat_id: String,
    group_id: String,
    selected_message_id: String,
    layout: String,
) -> Result<Vec<ChatMessage>, String> {
    if layout != "tabs" && layout != "split" {
        return Err("不支持的回答布局。".into());
    }
    let dir = conversation_dir(&app, &assistant_id, &chat_id)?;
    let mut messages = load_messages(&dir);
    let selected_is_member = messages.iter().any(|message| {
        message.role == "assistant"
            && message.id == selected_message_id
            && response_group_id(message) == group_id
    });
    if !selected_is_member {
        return Err("所选回答不在该回答组中。".into());
    }
    for message in &mut messages {
        if message.role == "assistant" && response_group_id(message) == group_id {
            message.response_group_id = Some(group_id.clone());
            message.selected_for_context = Some(message.id == selected_message_id);
            message.response_layout = Some(layout.clone());
        }
    }
    save_messages(&dir, &messages)?;
    Ok(messages)
}

#[tauri::command]
pub fn delete_chat_message(
    app: AppHandle,
    assistant_id: String,
    chat_id: String,
    message_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let dir = conversation_dir(&app, &assistant_id, &chat_id)?;
    let mut messages = load_messages(&dir);
    let removed = messages
        .iter()
        .find(|message| message.id == message_id)
        .cloned()
        .ok_or_else(|| "消息不存在。".to_string())?;
    let group_id = response_group_id(&removed).to_string();
    let removed_was_selected = removed.selected_for_context.unwrap_or(true);
    messages.retain(|message| message.id != message_id);
    if removed.role == "assistant" && removed_was_selected {
        let mut group = messages
            .iter_mut()
            .filter(|message| message.role == "assistant" && response_group_id(message) == group_id)
            .peekable();
        if let Some(next) = group.peek_mut() {
            next.selected_for_context = Some(true);
        }
    }
    save_messages(&dir, &messages)?;
    Ok(messages)
}

pub(crate) fn now_secs() -> u64 {
    now()
}

/// The assistant's display name + system prompt, for the chat runtime.
pub(crate) fn assistant_profile(
    app: &AppHandle,
    assistant_id: &str,
) -> Result<(String, String), String> {
    let dir = assistant_dir(app, assistant_id)?;
    let assistant: Assistant = read_json(&dir.join(ASSISTANT_FILE))?;
    Ok((assistant.name, assistant.system_prompt))
}

/// Resolve a conversation's model through conversation → assistant scope →
/// global starred model.
pub(crate) fn conversation_model(
    app: &AppHandle,
    assistant_id: &str,
    conversation_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let config = conversation_dir(app, assistant_id, conversation_id)?.join(CONVERSATION_FILE);
    let conversation: Conversation = read_json(&config)?;
    if conversation.provider_id.is_some() && conversation.model_id.is_some() {
        return Ok((conversation.provider_id, conversation.model_id));
    }
    let assistant_dir = assistant_dir(app, assistant_id)?;
    let assistant: Assistant = read_json(&assistant_dir.join(ASSISTANT_FILE))?;
    Ok(inherited_model(app, &assistant)
        .map(|(provider_id, model_id)| (Some(provider_id), Some(model_id)))
        .unwrap_or((None, None)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, created_at: u64) -> ChatMessage {
        ChatMessage {
            id: format!("{role}-{created_at}"),
            role: role.into(),
            content: String::new(),
            model: None,
            reasoning: String::new(),
            attachments: Vec::new(),
            tool_calls: Vec::new(),
            usage: None,
            response_group_id: None,
            selected_for_context: None,
            response_layout: None,
            feedback: None,
            created_at,
        }
    }

    #[test]
    fn latest_message_time_ignores_markers_and_missing_legacy_timestamps() {
        let messages = vec![
            message("user", 100),
            message("context_marker", 300),
            message("assistant", 200),
            message("user", 0),
        ];
        assert_eq!(latest_message_at(&messages), Some(200));
    }

    #[test]
    fn conversation_activity_uses_creation_time_until_first_message() {
        let mut conversation = Conversation {
            id: "chat".into(),
            title: "Chat".into(),
            provider_id: None,
            model_id: None,
            created_at: 100,
            updated_at: 500,
            last_message_at: None,
        };
        assert_eq!(conversation_activity_at(&conversation), 100);
        conversation.last_message_at = Some(300);
        assert_eq!(conversation_activity_at(&conversation), 300);
    }

    #[test]
    fn assistant_emoji_keeps_a_choice_and_fills_an_empty_value() {
        assert_eq!(normalized_assistant_emoji("  🦊  ".into()), "🦊");
        let generated = normalized_assistant_emoji(String::new());
        assert!(ASSISTANT_EMOJIS.contains(&generated.as_str()));
    }

    #[test]
    fn first_response_model_uses_only_the_first_assistant_reply() {
        let mut first_reply = message("assistant", 200);
        first_reply.model = Some("deepseek-v4-flash".into());
        let mut later_reply = message("assistant", 300);
        later_reply.model = Some("gpt-5".into());

        assert_eq!(
            first_response_model(&[message("user", 100), first_reply, later_reply]),
            Some("deepseek-v4-flash".into())
        );

        assert_eq!(
            first_response_model(&[
                message("user", 100),
                message("assistant", 200),
                message("assistant", 300),
            ]),
            None
        );
    }
}
