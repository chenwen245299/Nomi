//! The read-only data layer behind the chat MCP server.
//!
//! Everything the external agent can reach goes through here, and this module
//! touches only the `chat/` folder — never `providers.json`, never the OS
//! keychain. That is the security boundary for the whole feature: an agent can
//! read the user's assistants and conversations, but not their AI provider
//! configuration or API keys.
//!
//! # On-disk layout (written by `crate::chat`)
//!
//! ```text
//! chat/
//!   <assistant-id>/
//!     assistant.json            { id, name, systemPrompt, emoji, createdAt, updatedAt }
//!     <conversation-id>/
//!       conversation.json       { id, title, createdAt, updatedAt }
//!       messages.json           { messages: [ … ] }   ← read here; see below
//!       assets/                 image / audio / video / file attachments
//! ```
//!
//! `messages.json` is the message log for one conversation. The interactive
//! chat UI is not built yet, so this is the format it is expected to write, and
//! the format this module reads. It is parsed defensively (field by field, all
//! optional) so the schema can grow without breaking the reader — and, just as
//! importantly, so that only the fields named here are ever surfaced. Anything
//! else a future writer stores next to a message (a provider id, a per-call
//! cost, raw model reasoning) is dropped simply by never being read.
//!
//! ```jsonc
//! {
//!   "messages": [
//!     {
//!       "id": "m1",
//!       "role": "user",                 // "user" | "assistant" | "system"
//!       "content": "text of the message",
//!       "createdAt": 1699999999,        // unix seconds
//!       "model": "gpt-4o",              // optional, assistant replies
//!       "attachments": [
//!         {
//!           "id": "a1",
//!           "kind": "image",            // image | audio | video | file (inferred if absent)
//!           "name": "photo.png",
//!           "mimeType": "image/png",    // optional (inferred from extension)
//!           "path": "assets/photo.png", // relative to the conversation folder
//!           "size": 20480               // optional, bytes
//!         }
//!       ]
//!     }
//!   ]
//! }
//! ```
//!
//! A top-level array (`[ … ]`) is also accepted, in case a writer stores the
//! messages without the wrapping object.

use serde::Serialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

const ASSISTANT_FILE: &str = "assistant.json";
const CONVERSATION_FILE: &str = "conversation.json";
const MESSAGES_FILE: &str = "messages.json";

// ── Defensive JSON helpers ─────────────────────────────────────────────────────

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|f| f.as_str())
        .unwrap_or_default()
        .to_string()
}

fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|f| f.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn u64_field(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|f| f.as_u64()).unwrap_or(0)
}

fn opt_u64_field(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|f| f.as_u64())
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Reject an id that is not a single, safe path component (guards traversal like
/// `../providers.json`). Returns the id unchanged when it is safe.
fn safe_component(id: &str) -> Result<&str, String> {
    let mut components = Path::new(id).components();
    let single =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if single {
        Ok(id)
    } else {
        Err(format!("非法的标识符：{id}"))
    }
}

fn assistant_display_name(dir: &Path) -> String {
    read_json(&dir.join(ASSISTANT_FILE))
        .map(|v| str_field(&v, "name"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string()
        })
}

/// Count conversations under an assistant folder (subdirs with a conversation.json).
fn count_conversations(assistant_dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(assistant_dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir() && e.path().join(CONVERSATION_FILE).is_file())
        .count()
}

// ── Assistants ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct AssistantEntry {
    /// Stable id — also the folder name. Pass it as `assistant_id` to the other tools.
    pub id: String,
    pub name: String,
    /// The assistant's system prompt (its persona / instructions).
    pub system_prompt: String,
    /// Emoji avatar, or empty.
    pub emoji: String,
    /// Number of conversations belonging to this assistant.
    pub conversation_count: usize,
    /// Unix seconds.
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct AssistantList {
    pub assistants: Vec<AssistantEntry>,
    pub total: usize,
}

/// List every assistant, oldest first. A missing `chat/` folder is not an error
/// — it just means no assistants have been created yet.
pub fn list_assistants(chat_root: &str) -> Result<AssistantList, String> {
    let root = PathBuf::from(chat_root);
    let mut assistants = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(config) = read_json(&dir.join(ASSISTANT_FILE)) else {
                continue;
            };
            let folder = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            assistants.push(AssistantEntry {
                id: folder,
                name: str_field(&config, "name"),
                system_prompt: str_field(&config, "systemPrompt"),
                emoji: str_field(&config, "emoji"),
                conversation_count: count_conversations(&dir),
                created_at: u64_field(&config, "createdAt"),
                updated_at: u64_field(&config, "updatedAt"),
            });
        }
    }
    assistants.sort_by_key(|a| a.created_at);
    let total = assistants.len();
    Ok(AssistantList { assistants, total })
}

// ── Chats (conversations) ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ChatEntry {
    /// Conversation id — also the folder name. Pass it as `chat_id` to `get_chat`.
    pub id: String,
    /// The assistant this conversation belongs to.
    pub assistant_id: String,
    pub assistant_name: String,
    pub title: String,
    /// How many messages the conversation holds (0 if none logged yet).
    pub message_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
    /// Newest user/assistant message timestamp; `None` for an empty chat.
    pub last_message_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ChatListPage {
    pub chats: Vec<ChatEntry>,
    /// Total matches before paging — so `limit: 1` is a cheap counter.
    pub total: usize,
    pub offset: usize,
    pub returned: usize,
}

/// Collect a conversation's `ChatEntry`, or `None` if it has no conversation.json.
fn read_chat_entry(assistant_id: &str, assistant_name: &str, conv_dir: &Path) -> Option<ChatEntry> {
    let config = read_json(&conv_dir.join(CONVERSATION_FILE))?;
    let messages = read_messages(conv_dir);
    let last_message_at = opt_u64_field(&config, "lastMessageAt").or_else(|| {
        messages
            .iter()
            .filter(|message| message.role == "user" || message.role == "assistant")
            .map(|message| message.created_at)
            .filter(|timestamp| *timestamp > 0)
            .max()
    });
    let folder = conv_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    Some(ChatEntry {
        id: folder,
        assistant_id: assistant_id.to_string(),
        assistant_name: assistant_name.to_string(),
        title: str_field(&config, "title"),
        message_count: messages.len(),
        created_at: u64_field(&config, "createdAt"),
        updated_at: u64_field(&config, "updatedAt"),
        last_message_at,
    })
}

/// List conversations, newest first. `assistant_id` restricts to one assistant
/// (the usual "chats for this assistant" view); omit it to list across all of
/// them. `query` keeps only conversations whose title contains it
/// (case-insensitive).
pub fn list_chats(
    chat_root: &str,
    assistant_id: Option<&str>,
    query: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<ChatListPage, String> {
    let root = PathBuf::from(chat_root);
    let needle = query.map(|q| q.to_lowercase());

    // The assistant folders to scan: one, or all of them.
    let assistant_dirs: Vec<PathBuf> = match assistant_id {
        Some(id) => {
            let dir = root.join(safe_component(id)?);
            if !dir.is_dir() {
                return Err(format!("助手不存在：{id}"));
            }
            vec![dir]
        }
        None => std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.join(ASSISTANT_FILE).is_file())
            .collect(),
    };

    let mut chats = Vec::new();
    for adir in assistant_dirs {
        let aid = adir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let aname = assistant_display_name(&adir);
        let Ok(entries) = std::fs::read_dir(&adir) else {
            continue;
        };
        for entry in entries.flatten() {
            let cdir = entry.path();
            if !cdir.is_dir() {
                continue;
            }
            if let Some(chat) = read_chat_entry(&aid, &aname, &cdir) {
                if let Some(n) = &needle
                    && !chat.title.to_lowercase().contains(n.as_str())
                {
                    continue;
                }
                chats.push(chat);
            }
        }
    }

    chats.sort_by_key(|chat| std::cmp::Reverse(chat.last_message_at.unwrap_or(chat.created_at)));
    let total = chats.len();
    let page: Vec<ChatEntry> = chats.into_iter().skip(offset).take(limit).collect();
    let returned = page.len();
    Ok(ChatListPage {
        chats: page,
        total,
        offset,
        returned,
    })
}

// ── Messages ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct AttachmentMeta {
    /// Pass this to `get_chat_attachment` (with the same assistant_id / chat_id)
    /// to fetch the actual image, audio, video or file.
    pub id: String,
    /// "image" | "audio" | "video" | "file".
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    /// Size in bytes, if known.
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ChatMessage {
    pub id: String,
    /// "user" | "assistant" | "system".
    pub role: String,
    /// The text of the message (may be empty when the message is media-only).
    pub content: String,
    /// Model that produced an assistant message, when recorded.
    pub model: Option<String>,
    /// Media / files on this message — metadata only. Fetch the bytes with
    /// `get_chat_attachment`.
    pub attachments: Vec<AttachmentMeta>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ChatDetail {
    pub chat_id: String,
    pub assistant_id: String,
    pub title: String,
    pub messages: Vec<ChatMessage>,
    /// Total messages before paging.
    pub total: usize,
    pub offset: usize,
    pub returned: usize,
    pub has_more: bool,
}

/// Infer an attachment kind from an explicit field, its mime type, or its name.
fn attachment_kind(explicit: Option<&str>, mime: &str, name: &str) -> String {
    if let Some(k) = explicit {
        let k = k.trim();
        if !k.is_empty() {
            return k.to_string();
        }
    }
    if mime.starts_with("image/") {
        return "image".to_string();
    }
    if mime.starts_with("audio/") {
        return "audio".to_string();
    }
    if mime.starts_with("video/") {
        return "video".to_string();
    }
    match mime_from_name(name).split('/').next() {
        Some("image") => "image".to_string(),
        Some("audio") => "audio".to_string(),
        Some("video") => "video".to_string(),
        _ => "file".to_string(),
    }
}

/// Best-effort MIME type from a file extension. Covers the media the chat
/// composer accepts; anything else falls back to a generic binary type.
fn mime_from_name(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    };
    mime.to_string()
}

fn parse_attachment(v: &Value) -> Option<AttachmentMeta> {
    let name = str_field(v, "name");
    let mime = opt_str_field(v, "mimeType").unwrap_or_else(|| mime_from_name(&name));
    let kind = attachment_kind(v.get("kind").and_then(|k| k.as_str()), &mime, &name);
    let id = opt_str_field(v, "id")?; // an attachment with no id can't be fetched
    Some(AttachmentMeta {
        id,
        kind,
        name,
        mime_type: mime,
        size: opt_u64_field(v, "size"),
    })
}

fn parse_message(v: &Value, index: usize) -> ChatMessage {
    let attachments = v
        .get("attachments")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(parse_attachment).collect())
        .unwrap_or_default();
    let id = opt_str_field(v, "id").unwrap_or_else(|| format!("msg-{index}"));
    let role = opt_str_field(v, "role").unwrap_or_else(|| "user".to_string());
    ChatMessage {
        id,
        role,
        content: str_field(v, "content"),
        model: opt_str_field(v, "model"),
        attachments,
        created_at: u64_field(v, "createdAt"),
    }
}

/// The raw message array for a conversation, tolerating both `{ "messages": [] }`
/// and a bare `[]`. Returns empty when the file is absent or unreadable.
fn read_message_values(conversation_dir: &Path) -> Vec<Value> {
    let Some(doc) = read_json(&conversation_dir.join(MESSAGES_FILE)) else {
        return Vec::new();
    };
    match doc {
        Value::Array(arr) => arr,
        Value::Object(mut obj) => match obj.remove("messages") {
            Some(Value::Array(arr)) => arr,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

fn read_messages(conversation_dir: &Path) -> Vec<ChatMessage> {
    read_message_values(conversation_dir)
        .iter()
        .enumerate()
        .map(|(i, v)| parse_message(v, i))
        .collect()
}

fn conversation_dir(chat_root: &str, assistant_id: &str, chat_id: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(chat_root)
        .join(safe_component(assistant_id)?)
        .join(safe_component(chat_id)?);
    if !dir.is_dir() {
        return Err(format!("对话不存在：{chat_id}"));
    }
    Ok(dir)
}

/// Read one conversation's messages, paged. Attachments come back as metadata
/// only; fetch their bytes with `get_chat_attachment`.
pub fn get_chat(
    chat_root: &str,
    assistant_id: &str,
    chat_id: &str,
    offset: usize,
    limit: usize,
) -> Result<ChatDetail, String> {
    let dir = conversation_dir(chat_root, assistant_id, chat_id)?;
    let title = read_json(&dir.join(CONVERSATION_FILE))
        .map(|v| str_field(&v, "title"))
        .unwrap_or_default();

    let all = read_messages(&dir);
    let total = all.len();
    let messages: Vec<ChatMessage> = all.into_iter().skip(offset).take(limit).collect();
    let returned = messages.len();
    Ok(ChatDetail {
        chat_id: chat_id.to_string(),
        assistant_id: assistant_id.to_string(),
        title,
        messages,
        total,
        offset,
        returned,
        has_more: offset + returned < total,
    })
}

// ── Attachment loading ─────────────────────────────────────────────────────────

/// One attachment resolved to disk, ready to hand to the agent.
pub struct LoadedAttachment {
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    /// Absolute path — always returned, so the client can open large media with
    /// its own file tools even when the bytes are not inlined.
    pub abs_path: String,
    /// Bytes to inline, present only for images / audio / small text files that
    /// fit under the caller's cap. `None` for video and anything too large.
    pub bytes: Option<Vec<u8>>,
}

/// Whether a mime type is text we can safely inline as a string.
fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/xml"
        || mime == "application/x-yaml"
}

/// Resolve an attachment's on-disk path, guarding against traversal out of the
/// conversation folder (including via symlinks).
fn resolve_attachment_path(conv_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("附件缺少路径。".into());
    }
    let rel_path = Path::new(rel);
    // Only ordinary path segments — no `..`, no absolute roots.
    if !rel_path
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("不安全的附件路径：{rel}"));
    }
    let joined = conv_dir.join(rel_path);
    let canonical = joined
        .canonicalize()
        .map_err(|_| format!("附件文件不存在：{rel}"))?;
    let base = conv_dir
        .canonicalize()
        .map_err(|e| format!("无法解析对话目录：{e}"))?;
    if !canonical.starts_with(&base) {
        return Err(format!("附件路径越界：{rel}"));
    }
    Ok(canonical)
}

/// Load one attachment by id. `max_inline` caps how many bytes are read into
/// memory for inlining; larger files (and all video) come back as a path only.
pub fn load_attachment(
    chat_root: &str,
    assistant_id: &str,
    chat_id: &str,
    attachment_id: &str,
    max_inline: u64,
) -> Result<LoadedAttachment, String> {
    let dir = conversation_dir(chat_root, assistant_id, chat_id)?;

    // Find the attachment record in the message log.
    let record = read_message_values(&dir)
        .into_iter()
        .filter_map(|m| m.get("attachments").and_then(|a| a.as_array()).cloned())
        .flatten()
        .find(|a| opt_str_field(a, "id").as_deref() == Some(attachment_id))
        .ok_or_else(|| format!("附件不存在：{attachment_id}"))?;

    let name = str_field(&record, "name");
    let rel = str_field(&record, "path");
    let abs = resolve_attachment_path(&dir, &rel)?;

    let mime = opt_str_field(&record, "mimeType").unwrap_or_else(|| mime_from_name(&name));
    let kind = attachment_kind(record.get("kind").and_then(|k| k.as_str()), &mime, &name);
    let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);

    // Inline images, audio and small text; hand back a path for video and
    // anything over the cap (base64 of a large file would swamp the context).
    let inlineable = matches!(kind.as_str(), "image" | "audio") || is_text_mime(&mime);
    let bytes = if inlineable && size <= max_inline {
        std::fs::read(&abs).ok()
    } else {
        None
    };

    Ok(LoadedAttachment {
        kind,
        name,
        mime_type: mime,
        size,
        abs_path: abs.to_string_lossy().to_string(),
        bytes,
    })
}

// ── Overview ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct ChatOverview {
    pub assistant_count: usize,
    pub chat_count: usize,
    pub message_count: usize,
    pub image_count: usize,
    pub audio_count: usize,
    pub video_count: usize,
    pub file_count: usize,
}

/// A one-call summary of the whole chat store — call it first to understand the
/// shape of the data before drilling in.
pub fn chat_overview(chat_root: &str) -> Result<ChatOverview, String> {
    let root = PathBuf::from(chat_root);
    let mut o = ChatOverview {
        assistant_count: 0,
        chat_count: 0,
        message_count: 0,
        image_count: 0,
        audio_count: 0,
        video_count: 0,
        file_count: 0,
    };
    let Ok(assistants) = std::fs::read_dir(&root) else {
        return Ok(o);
    };
    for entry in assistants.flatten() {
        let adir = entry.path();
        if !adir.is_dir() || !adir.join(ASSISTANT_FILE).is_file() {
            continue;
        }
        o.assistant_count += 1;
        let Ok(convs) = std::fs::read_dir(&adir) else {
            continue;
        };
        for conv in convs.flatten() {
            let cdir = conv.path();
            if !cdir.is_dir() || !cdir.join(CONVERSATION_FILE).is_file() {
                continue;
            }
            o.chat_count += 1;
            for msg in read_messages(&cdir) {
                o.message_count += 1;
                for att in &msg.attachments {
                    match att.kind.as_str() {
                        "image" => o.image_count += 1,
                        "audio" => o.audio_count += 1,
                        "video" => o.video_count += 1,
                        _ => o.file_count += 1,
                    }
                }
            }
        }
    }
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway chat store laid out the way `crate::chat` writes it, with one
    /// assistant, one conversation, a text message and an image attachment — plus
    /// a decoy field that must never be surfaced.
    struct TempChat(PathBuf);

    impl TempChat {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nomi-mcp-tools-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            let conv = dir.join("helper").join("first-chat");
            std::fs::create_dir_all(conv.join("assets")).unwrap();

            std::fs::write(
                dir.join("helper").join(ASSISTANT_FILE),
                serde_json::json!({
                    "id": "helper", "name": "Helper", "systemPrompt": "You help.",
                    "emoji": "🤖", "createdAt": 100, "updatedAt": 200
                })
                .to_string(),
            )
            .unwrap();
            std::fs::write(
                conv.join(CONVERSATION_FILE),
                serde_json::json!({
                    "id": "first-chat", "title": "Trip planning",
                    "createdAt": 300, "updatedAt": 400
                })
                .to_string(),
            )
            .unwrap();
            // A real 1x1 PNG so the bytes round-trip.
            let png = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAYE2z2XwAAAAAElFTkSuQmCC",
            )
            .unwrap();
            std::fs::write(conv.join("assets").join("pic.png"), &png).unwrap();
            std::fs::write(
                conv.join(MESSAGES_FILE),
                serde_json::json!({
                    "messages": [
                        {
                            "id": "m1", "role": "user", "content": "Look at this",
                            "createdAt": 310,
                            "attachments": [{
                                "id": "a1", "kind": "image", "name": "pic.png",
                                "mimeType": "image/png", "path": "assets/pic.png", "size": png.len()
                            }]
                        },
                        {
                            "id": "m2", "role": "assistant", "content": "Nice photo.",
                            "model": "gpt-4o", "createdAt": 320,
                            "providerId": "SECRET-PROVIDER", "costUsd": 0.01
                        }
                    ]
                })
                .to_string(),
            )
            .unwrap();
            TempChat(dir)
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }
    impl Drop for TempChat {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_assistants_with_conversation_counts() {
        let c = TempChat::new("assistants");
        let list = list_assistants(&c.root()).unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.assistants[0].id, "helper");
        assert_eq!(list.assistants[0].name, "Helper");
        assert_eq!(list.assistants[0].conversation_count, 1);
    }

    #[test]
    fn missing_chat_root_is_empty_not_an_error() {
        let list = list_assistants("/no/such/nomi/chat/root").unwrap();
        assert_eq!(list.total, 0);
    }

    #[test]
    fn lists_and_filters_chats() {
        let c = TempChat::new("chats");
        let all = list_chats(&c.root(), Some("helper"), None, 20, 0).unwrap();
        assert_eq!(all.total, 1);
        assert_eq!(all.chats[0].title, "Trip planning");
        assert_eq!(all.chats[0].message_count, 2);

        let hit = list_chats(&c.root(), None, Some("trip"), 20, 0).unwrap();
        assert_eq!(hit.total, 1, "case-insensitive title search should match");
        let miss = list_chats(&c.root(), None, Some("zzz"), 20, 0).unwrap();
        assert_eq!(miss.total, 0);
    }

    #[test]
    fn get_chat_returns_messages_without_leaking_extra_fields() {
        let c = TempChat::new("messages");
        let detail = get_chat(&c.root(), "helper", "first-chat", 0, 20).unwrap();
        assert_eq!(detail.total, 2);
        assert_eq!(detail.messages[0].attachments[0].id, "a1");
        assert_eq!(detail.messages[0].attachments[0].kind, "image");
        assert_eq!(detail.messages[1].model.as_deref(), Some("gpt-4o"));

        // Allowlisted parsing must drop provider id and cost even though they sit
        // right next to the message content on disk.
        let rendered = serde_json::to_string(&detail).unwrap();
        assert!(
            !rendered.contains("SECRET-PROVIDER"),
            "provider id leaked: {rendered}"
        );
        assert!(!rendered.contains("costUsd"), "cost leaked: {rendered}");
    }

    #[test]
    fn get_chat_paging_reports_has_more() {
        let c = TempChat::new("paging");
        let page = get_chat(&c.root(), "helper", "first-chat", 0, 1).unwrap();
        assert_eq!(page.returned, 1);
        assert!(page.has_more);
        let last = get_chat(&c.root(), "helper", "first-chat", 1, 1).unwrap();
        assert!(!last.has_more);
    }

    #[test]
    fn loads_an_image_attachment_inline() {
        let c = TempChat::new("attach");
        let att =
            load_attachment(&c.root(), "helper", "first-chat", "a1", 10 * 1024 * 1024).unwrap();
        assert_eq!(att.kind, "image");
        assert_eq!(att.mime_type, "image/png");
        assert!(att.bytes.is_some(), "small image should be inlined");
        assert!(att.abs_path.ends_with("pic.png"));
    }

    #[test]
    fn large_attachment_comes_back_as_path_only() {
        let c = TempChat::new("attach-big");
        // A 1-byte cap forces the path-only branch.
        let att = load_attachment(&c.root(), "helper", "first-chat", "a1", 1).unwrap();
        assert!(att.bytes.is_none(), "over-cap file must not be inlined");
        assert!(!att.abs_path.is_empty());
    }

    #[test]
    fn traversal_ids_and_paths_are_rejected() {
        let c = TempChat::new("safety");
        assert!(get_chat(&c.root(), "../helper", "first-chat", 0, 10).is_err());
        assert!(list_chats(&c.root(), Some(".."), None, 10, 0).is_err());

        // An attachment whose path escapes the conversation folder is refused.
        let conv = PathBuf::from(c.root()).join("helper").join("evil");
        std::fs::create_dir_all(&conv).unwrap();
        std::fs::write(
            conv.join(CONVERSATION_FILE),
            serde_json::json!({ "id": "evil", "title": "x", "createdAt": 1, "updatedAt": 1 })
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            conv.join(MESSAGES_FILE),
            serde_json::json!({ "messages": [{
                "id": "m", "role": "user", "content": "",
                "attachments": [{ "id": "bad", "name": "p.json", "path": "../../../providers.json" }]
            }]})
            .to_string(),
        )
        .unwrap();
        assert!(load_attachment(&c.root(), "helper", "evil", "bad", 1024).is_err());
    }

    #[test]
    fn overview_counts_media() {
        let c = TempChat::new("overview");
        let o = chat_overview(&c.root()).unwrap();
        assert_eq!(o.assistant_count, 1);
        assert_eq!(o.chat_count, 1);
        assert_eq!(o.message_count, 2);
        assert_eq!(o.image_count, 1);
    }
}
