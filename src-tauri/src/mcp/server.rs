//! The MCP tool surface exposed to external agents.
//!
//! This layer is deliberately thin: it declares tool names, argument schemas and
//! descriptions, then defers to `super::tools` for every read. The security
//! argument for the whole feature lives in that module's docs — keep new tools
//! going through it rather than touching the filesystem here.
//!
//! Blocking file I/O is wrapped in `spawn_blocking` so a large scan never parks
//! one of the async runtime's workers.

use base64::Engine;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, JsonObject, ServerCapabilities, ServerInfo,
};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use super::tools;
use crate::exa;

/// How the agent is told to use this server.
const INSTRUCTIONS: &str = "\
Read-only access to the user's Nomi chat data: their AI assistants (each with its \
own system prompt) and the conversations held with each one — messages plus any \
image, audio, video and file attachments.

Start with `get_chat_overview` to see how much there is, or `list_assistants` to \
see the assistants. Each assistant has an `id`; pass it to `list_chats` to see \
that assistant's conversations (omit it to list across everyone). Each chat has \
an `id`; pass the assistant_id and chat_id to `get_chat` to read the messages.

Reading is paged on purpose — page with `offset`, continuing from the previous \
call's `offset + returned`, and check `has_more`.

`get_chat` returns each message's text plus attachment metadata only. To get the \
actual media, call `get_chat_attachment` with the attachment's id: images and \
audio come back inline; video and large files come back as an absolute path to \
open with your own file tools.

Use `web_search` when the answer needs current or external information. It \
returns source URLs and query-relevant excerpts from Exa; cite those URLs in \
the answer. The user must first add an Exa API Key in Nomi → Settings → General.

This server is read-only. It cannot reveal the user's AI provider settings or \
API keys; the Exa key is decrypted only inside Nomi for the outgoing search \
request and is never returned to the MCP client.";

/// Largest attachment inlined as base64. Bigger files (and all video) are handed
/// back as a path instead, so one attachment cannot swamp the caller's context.
const MAX_INLINE_BYTES: u64 = 10 * 1024 * 1024;

/// Cap on inlined text so a huge text file does not blow the context either.
const MAX_TEXT_CHARS: usize = 100_000;

fn bad_request(e: String) -> ErrorData {
    ErrorData::invalid_params(e, None)
}

fn internal(e: String) -> ErrorData {
    ErrorData::internal_error(e, None)
}

/// Run a blocking read on the blocking pool.
async fn blocking<T, F>(f: F) -> Result<T, ErrorData>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| internal(format!("task panicked: {e}")))?
        .map_err(bad_request)
}

// ── Argument schemas ─────────────────────────────────────────────────────────

fn default_chat_limit() -> usize {
    30
}
fn default_message_limit() -> usize {
    30
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct NoParams {}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct ListChatsParams {
    /// Restrict to one assistant's conversations (its `id` from
    /// `list_assistants`). Omit to list conversations across all assistants.
    pub assistant_id: Option<String>,
    /// Case-insensitive substring match against conversation titles.
    pub query: Option<String>,
    /// Max conversations to return. Default 30.
    #[serde(default = "default_chat_limit")]
    pub limit: usize,
    /// Conversations to skip, for paging.
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct GetChatParams {
    /// The assistant that owns the conversation (`id` from `list_assistants`).
    pub assistant_id: String,
    /// The conversation id (`id` from `list_chats`).
    pub chat_id: String,
    /// Messages to skip, for paging through a long conversation.
    #[serde(default)]
    pub offset: usize,
    /// Messages to return. Default 30.
    #[serde(default = "default_message_limit")]
    pub limit: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema, Default)]
pub struct GetAttachmentParams {
    /// The assistant that owns the conversation.
    pub assistant_id: String,
    /// The conversation the attachment belongs to.
    pub chat_id: String,
    /// The attachment id from a message's `attachments` in `get_chat`.
    pub attachment_id: String,
}

// ── Schema flattening ────────────────────────────────────────────────────────
//
// `schemars` factors every nested struct out into `$defs` and points at it with
// `$ref`. That is valid JSON Schema, but MCP clients vary in whether they
// resolve references, and one that does not will drop the tool — or the whole
// `tools/list` — without saying why. Every schema here is small and
// non-recursive, so inlining the definitions removes the question entirely.

/// Depth ceiling for inlining. Nothing here is recursive; this only stops a
/// future self-referential type from expanding forever.
const MAX_INLINE_DEPTH: usize = 12;

/// Replace every `$ref` with the definition it points at and drop `$defs`.
fn inline_defs(schema: &JsonObject) -> JsonObject {
    let Some(defs) = schema.get("$defs").and_then(|d| d.as_object()).cloned() else {
        return schema.clone();
    };
    let mut root = schema.clone();
    root.remove("$defs");
    let mut value = Value::Object(root);
    resolve_refs(&mut value, &defs, 0);
    match value {
        Value::Object(o) => o,
        _ => schema.clone(),
    }
}

fn resolve_refs(value: &mut Value, defs: &serde_json::Map<String, Value>, depth: usize) {
    if depth > MAX_INLINE_DEPTH {
        return;
    }
    match value {
        Value::Object(map) => {
            let target = map
                .get("$ref")
                .and_then(|r| r.as_str())
                .and_then(|r| r.strip_prefix("#/$defs/"))
                .and_then(|name| defs.get(name))
                .cloned();

            if let Some(mut replacement) = target {
                resolve_refs(&mut replacement, defs, depth + 1);
                // A `$ref` can sit beside annotations such as `description`;
                // carry those over rather than losing the field docs.
                if let Value::Object(rep) = &mut replacement {
                    for (k, v) in map.iter() {
                        if k != "$ref" && !rep.contains_key(k) {
                            rep.insert(k.clone(), v.clone());
                        }
                    }
                }
                *value = replacement;
                return;
            }
            for child in map.values_mut() {
                resolve_refs(child, defs, depth + 1);
            }
        }
        Value::Array(items) => {
            for child in items {
                resolve_refs(child, defs, depth + 1);
            }
        }
        _ => {}
    }
}

/// Build the tool router, then flatten every schema it carries.
fn flattened_tool_router() -> ToolRouter<NomiMcpServer> {
    let mut router = NomiMcpServer::generated_tool_router();
    for route in router.map.values_mut() {
        route.attr.input_schema = Arc::new(inline_defs(&route.attr.input_schema));
        if let Some(output) = &route.attr.output_schema {
            route.attr.output_schema = Some(Arc::new(inline_defs(output)));
        }
    }
    router
}

// ── Server ───────────────────────────────────────────────────────────────────

/// One instance is constructed per incoming MCP session.
///
/// It resolves the chat folder through a `ChatSource` rather than holding a
/// path, so a data-folder switch (or MCP being turned off) is picked up by the
/// next tool call instead of serving a stale root.
#[derive(Clone)]
pub struct NomiMcpServer {
    source: Arc<dyn super::ChatSource>,
}

impl NomiMcpServer {
    pub fn new(source: Arc<dyn super::ChatSource>) -> Self {
        Self { source }
    }

    fn tool_router() -> ToolRouter<Self> {
        flattened_tool_router()
    }

    fn root(&self) -> Result<String, ErrorData> {
        self.source.chat_root().map_err(bad_request)
    }
}

#[tool_router(router = generated_tool_router)]
impl NomiMcpServer {
    /// One-call summary of the whole chat store.
    #[tool(
        name = "get_chat_overview",
        description = "Get an overview of the user's chat data in one call: how many assistants and conversations exist, the total message count, and how many image / audio / video / file attachments there are. Call this first to understand the shape of the data before drilling in.",
        annotations(title = "Chat overview", read_only_hint = true)
    )]
    async fn get_chat_overview(
        &self,
        Parameters(_): Parameters<NoParams>,
    ) -> Result<Json<tools::ChatOverview>, ErrorData> {
        let root = self.root()?;
        blocking(move || tools::chat_overview(&root))
            .await
            .map(Json)
    }

    /// List the user's AI assistants.
    #[tool(
        name = "list_assistants",
        description = "List the user's AI assistants. Each is a persona with its own system prompt, and owns a set of conversations. Returns each assistant's id (use it as assistant_id elsewhere), name, emoji, system prompt and conversation count.",
        annotations(title = "List assistants", read_only_hint = true)
    )]
    async fn list_assistants(
        &self,
        Parameters(_): Parameters<NoParams>,
    ) -> Result<Json<tools::AssistantList>, ErrorData> {
        let root = self.root()?;
        blocking(move || tools::list_assistants(&root))
            .await
            .map(Json)
    }

    /// List conversations, optionally for one assistant.
    #[tool(
        name = "list_chats",
        description = "List conversations, newest first. Pass `assistant_id` (from list_assistants) to see one assistant's conversations — the usual 'chats for this assistant' view — or omit it to list across all assistants. Pass `query` to keep only conversations whose title matches (case-insensitive). Each row carries the assistant id/name, title, message count and timestamps. `total` is the count before paging, so limit=1 is a cheap counter.",
        annotations(title = "List chats", read_only_hint = true)
    )]
    async fn list_chats(
        &self,
        Parameters(p): Parameters<ListChatsParams>,
    ) -> Result<Json<tools::ChatListPage>, ErrorData> {
        let root = self.root()?;
        blocking(move || {
            tools::list_chats(
                &root,
                p.assistant_id.as_deref(),
                p.query.as_deref(),
                p.limit.clamp(1, 200),
                p.offset,
            )
        })
        .await
        .map(Json)
    }

    /// Read one conversation's messages.
    #[tool(
        name = "get_chat",
        description = "Read the messages of one conversation, paged. Give the assistant_id and chat_id from list_chats. Each message has its role (user/assistant/system), text content, the model that produced it (for assistant replies) and attachment metadata. Attachment bytes are NOT included here — call get_chat_attachment for the actual media. Page with `offset` (continue from the previous `offset + returned`) and check `has_more`.",
        annotations(title = "Read chat", read_only_hint = true)
    )]
    async fn get_chat(
        &self,
        Parameters(p): Parameters<GetChatParams>,
    ) -> Result<Json<tools::ChatDetail>, ErrorData> {
        let root = self.root()?;
        blocking(move || {
            tools::get_chat(
                &root,
                &p.assistant_id,
                &p.chat_id,
                p.offset,
                p.limit.clamp(1, 200),
            )
        })
        .await
        .map(Json)
    }

    /// Fetch one attachment's actual content.
    #[tool(
        name = "get_chat_attachment",
        description = "Fetch the actual content of one message attachment, identified by its id (from a message's `attachments` in get_chat) together with the assistant_id and chat_id. Images and audio are returned inline so you can see/hear them. Video and large or binary files are returned as an absolute path to open with your own file tools; small text files are returned as text.",
        annotations(title = "Get chat attachment", read_only_hint = true)
    )]
    async fn get_chat_attachment(
        &self,
        Parameters(p): Parameters<GetAttachmentParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let root = self.root()?;
        let att = blocking(move || {
            tools::load_attachment(
                &root,
                &p.assistant_id,
                &p.chat_id,
                &p.attachment_id,
                MAX_INLINE_BYTES,
            )
        })
        .await?;

        let mut blocks: Vec<ContentBlock> = Vec::new();
        match att.bytes {
            Some(bytes) if att.kind == "image" => {
                blocks.push(ContentBlock::text(format!(
                    "Attachment \"{}\" — image, {}, {} bytes. Saved at: {}",
                    att.name, att.mime_type, att.size, att.abs_path
                )));
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                blocks.push(ContentBlock::image(b64, att.mime_type));
            }
            Some(bytes) if att.kind == "audio" => {
                blocks.push(ContentBlock::text(format!(
                    "Attachment \"{}\" — audio, {}, {} bytes. Saved at: {}",
                    att.name, att.mime_type, att.size, att.abs_path
                )));
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                blocks.push(ContentBlock::audio(b64, att.mime_type));
            }
            Some(bytes) => {
                // Small text-like file: hand back the text itself.
                let text = String::from_utf8_lossy(&bytes);
                let (shown, truncated) = if text.chars().count() > MAX_TEXT_CHARS {
                    (text.chars().take(MAX_TEXT_CHARS).collect::<String>(), true)
                } else {
                    (text.into_owned(), false)
                };
                let note = if truncated { " (truncated)" } else { "" };
                blocks.push(ContentBlock::text(format!(
                    "Attachment \"{}\" — {}, {} bytes{}. Saved at: {}\n\n{}",
                    att.name, att.mime_type, att.size, note, att.abs_path, shown
                )));
            }
            None => {
                // Video or a file too large / too binary to inline: give the path.
                let hint = if att.kind == "video" {
                    "Video can't be inlined over MCP — open it from this path with your own file tools:"
                } else {
                    "This file is too large or not a media type to inline — open it from this path with your own file tools:"
                };
                blocks.push(ContentBlock::text(format!(
                    "Attachment \"{}\" — {}, {}, {} bytes.\n{}\n{}",
                    att.name, att.kind, att.mime_type, att.size, hint, att.abs_path
                )));
            }
        }
        Ok(CallToolResult::success(blocks))
    }

    /// Search the public web through Exa and return cited, relevant excerpts.
    #[tool(
        name = "web_search",
        description = "Search the public web with Exa for current or external information. Returns source titles, URLs, publication dates, authors and query-relevant highlights; use the URLs as citations in the final answer. Defaults to 5 results with Exa's auto search. Set fresh=true only when live page contents are required because it is slower. Requires an Exa API Key configured in Nomi Settings → General.",
        annotations(title = "Search the web", read_only_hint = true)
    )]
    async fn web_search(
        &self,
        Parameters(params): Parameters<exa::WebSearchParams>,
    ) -> Result<Json<exa::WebSearchResponse>, ErrorData> {
        // Resolve through the same source as chat tools so the MCP on/off switch
        // and active data-folder selection are re-checked for every request.
        let chat_root = PathBuf::from(self.root()?);
        let data_root = chat_root
            .parent()
            .ok_or_else(|| bad_request("无法定位 Nomi 数据文件夹。".into()))?;
        let key = exa::stored_key_from_data_root(data_root)
            .map_err(bad_request)?
            .ok_or_else(|| {
                bad_request("尚未配置 Exa API Key，请前往 Nomi → 设置 → 通用添加。".into())
            })?;
        exa::search_with_key(&key, params)
            .await
            .map(Json)
            .map_err(bad_request)
    }
}

#[tool_handler]
impl ServerHandler for NomiMcpServer {
    fn get_info(&self) -> ServerInfo {
        // `ServerInfo` is #[non_exhaustive], so build from Default and assign.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.server_info = Implementation::new("nomi", env!("CARGO_PKG_VERSION"));
        info.instructions = Some(INSTRUCTIONS.to_string());
        info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every tool this server exposes. A literal so adding one is a deliberate
    /// edit rather than something that slips in.
    const EXPECTED_TOOLS: &[&str] = &[
        "get_chat",
        "get_chat_attachment",
        "get_chat_overview",
        "list_assistants",
        "list_chats",
        "web_search",
    ];

    fn router() -> ToolRouter<NomiMcpServer> {
        NomiMcpServer::tool_router()
    }

    #[test]
    fn exposes_exactly_the_expected_tools() {
        let mut names: Vec<String> = router()
            .list_all()
            .iter()
            .map(|t| t.name.to_string())
            .collect();
        names.sort();
        assert_eq!(names, EXPECTED_TOOLS, "MCP tool surface changed");
    }

    /// MCP requires input schemas to describe an object.
    #[test]
    fn every_input_schema_describes_an_object() {
        for tool in router().list_all() {
            assert_eq!(
                tool.input_schema.get("type").and_then(|t| t.as_str()),
                Some("object"),
                "tool '{}' has a non-object inputSchema",
                tool.name
            );
        }
    }

    /// A tool returning a bare array emits `"type":"array"` as its outputSchema,
    /// which clients reject — taking the whole tools/list down with it.
    #[test]
    fn every_output_schema_describes_an_object() {
        for tool in router().list_all() {
            let Some(schema) = &tool.output_schema else {
                continue;
            };
            assert_eq!(
                schema.get("type").and_then(|t| t.as_str()),
                Some("object"),
                "tool '{}' has a non-object outputSchema",
                tool.name
            );
        }
    }

    /// A client that does not resolve `$ref` must still see complete schemas.
    #[test]
    fn no_schema_leaves_the_server_with_a_dangling_reference() {
        for tool in router().list_all() {
            for schema in [Some(tool.input_schema.clone()), tool.output_schema.clone()] {
                let Some(schema) = schema else { continue };
                let rendered = serde_json::to_string(&schema).unwrap();
                assert!(!rendered.contains("$ref"), "{}: dangling $ref", tool.name);
                assert!(!rendered.contains("$defs"), "{}: leaked $defs", tool.name);
            }
        }
    }

    /// Flattening must preserve content, not just remove references.
    #[test]
    fn inlining_keeps_nested_fields() {
        let tool = router()
            .list_all()
            .into_iter()
            .find(|t| t.name == "list_chats")
            .expect("list_chats missing");
        let rendered = serde_json::to_string(tool.output_schema.as_ref().unwrap()).unwrap();
        for field in ["title", "assistant_id", "message_count", "total", "offset"] {
            assert!(rendered.contains(field), "inlining dropped '{field}'");
        }
    }

    /// The whole feature is read-only; a tool that forgets the hint makes clients
    /// prompt for write consent that should never be needed.
    #[test]
    fn every_tool_is_read_only() {
        for tool in router().list_all() {
            let read_only = tool
                .annotations
                .as_ref()
                .and_then(|a| a.read_only_hint)
                .unwrap_or(false);
            assert!(read_only, "tool '{}' is not marked read_only", tool.name);
        }
    }

    #[test]
    fn every_tool_has_a_real_description() {
        for tool in router().list_all() {
            let desc = tool.description.as_deref().unwrap_or("");
            assert!(
                desc.len() > 30,
                "tool '{}' has a thin description",
                tool.name
            );
        }
    }
}

/// End-to-end tests that drive the real server over an in-memory duplex — the
/// same code path `run_stdio` uses, minus the process boundary.
#[cfg(test)]
mod protocol_tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    struct FixedRoot(Option<String>);
    impl super::super::ChatSource for FixedRoot {
        fn chat_root(&self) -> Result<String, String> {
            self.0
                .clone()
                .ok_or_else(|| "尚未选择数据文件夹。".to_string())
        }
    }

    /// A throwaway chat store with one assistant, one conversation and one
    /// message carrying a field that must be redacted.
    struct TempChat(PathBuf);
    impl TempChat {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nomi-mcp-proto-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            let conv = dir.join("helper").join("chat-1");
            std::fs::create_dir_all(conv.join("assets")).unwrap();
            std::fs::write(
                dir.join("helper").join("assistant.json"),
                serde_json::json!({
                    "id": "helper", "name": "Helper", "systemPrompt": "You help.",
                    "emoji": "🤖", "createdAt": 1, "updatedAt": 2
                })
                .to_string(),
            )
            .unwrap();
            std::fs::write(
                conv.join("conversation.json"),
                serde_json::json!({ "id": "chat-1", "title": "Hello", "createdAt": 3, "updatedAt": 4 })
                    .to_string(),
            )
            .unwrap();
            std::fs::write(
                conv.join("messages.json"),
                serde_json::json!({ "messages": [{
                    "id": "m1", "role": "assistant", "content": "Hi there",
                    "model": "gpt-4o", "createdAt": 5, "providerId": "SECRET-PROVIDER"
                }]})
                .to_string(),
            )
            .unwrap();
            TempChat(dir)
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }
    impl Drop for TempChat {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn exchange(root: Option<String>, requests: Vec<Value>) -> Vec<Value> {
        use rmcp::ServiceExt;
        use std::time::Duration;

        let (client_side, server_side) = tokio::io::duplex(1 << 20);
        let (read_half, mut write_half) = tokio::io::split(client_side);

        let expected = requests.iter().filter(|r| r.get("id").is_some()).count();
        for req in &requests {
            write_half
                .write_all(format!("{req}\n").as_bytes())
                .await
                .unwrap();
        }
        write_half.flush().await.unwrap();

        let (server_read, server_write) = tokio::io::split(server_side);
        let service = NomiMcpServer::new(Arc::new(FixedRoot(root)))
            .serve((server_read, server_write))
            .await
            .expect("server failed to start");
        let handle = tokio::spawn(async move {
            let _ = service.waiting().await;
        });

        let mut lines = BufReader::new(read_half).lines();
        let mut out = Vec::new();
        while out.len() < expected {
            match tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await {
                Ok(Ok(Some(line))) if !line.trim().is_empty() => {
                    out.push(serde_json::from_str(&line).expect("server emitted non-JSON"))
                }
                Ok(Ok(Some(_))) => continue,
                _ => break,
            }
        }
        drop(write_half);
        handle.abort();
        out
    }

    fn initialize() -> Value {
        serde_json::json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": { "name": "nomi-test", "version": "0.0.0" }
            }
        })
    }
    fn initialized() -> Value {
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
    }

    #[tokio::test]
    async fn handshake_reports_this_server() {
        let out = exchange(None, vec![initialize()]).await;
        assert_eq!(out.len(), 1, "no response to initialize: {out:?}");
        assert_eq!(out[0]["result"]["serverInfo"]["name"], "nomi");
        assert!(out[0]["result"]["instructions"].is_string());
    }

    #[tokio::test]
    async fn tools_list_survives_the_wire() {
        let out = exchange(
            None,
            vec![
                initialize(),
                initialized(),
                serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
            ],
        )
        .await;
        let listing = out
            .iter()
            .find(|m| m["id"] == 1)
            .expect("no tools/list response");
        let tools = listing["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 6, "unexpected tool count");
        let wire = listing["result"].to_string();
        assert!(!wire.contains("$ref"), "a dangling $ref reached the client");
        assert!(!wire.contains("$defs"), "$defs reached the client");
    }

    #[tokio::test]
    async fn reads_real_chat_data_and_redacts() {
        let c = TempChat::new("read");
        let out = exchange(
            Some(c.path()),
            vec![
                initialize(),
                initialized(),
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "list_assistants", "arguments": {} }
                }),
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": { "name": "get_chat",
                                "arguments": { "assistant_id": "helper", "chat_id": "chat-1" } }
                }),
            ],
        )
        .await;

        let assistants = out
            .iter()
            .find(|m| m["id"] == 1)
            .expect("no list_assistants response");
        assert_eq!(assistants["result"]["structuredContent"]["total"], 1);
        assert_eq!(
            assistants["result"]["structuredContent"]["assistants"][0]["id"],
            "helper"
        );

        let chat = out
            .iter()
            .find(|m| m["id"] == 2)
            .expect("no get_chat response");
        assert_eq!(chat["result"]["structuredContent"]["total"], 1);
        assert_eq!(
            chat["result"]["structuredContent"]["messages"][0]["model"],
            "gpt-4o"
        );
        assert!(
            !chat.to_string().contains("SECRET-PROVIDER"),
            "provider id leaked over the wire: {chat}"
        );
    }

    #[tokio::test]
    async fn a_missing_data_folder_is_explained_not_swallowed() {
        let out = exchange(
            None,
            vec![
                initialize(),
                initialized(),
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "list_assistants", "arguments": {} }
                }),
            ],
        )
        .await;
        let reply = out.iter().find(|m| m["id"] == 1).expect("no response");
        assert!(
            reply.to_string().contains("数据文件夹"),
            "unhelpful response with no data folder: {reply}"
        );
    }

    #[tokio::test]
    async fn web_search_explains_when_exa_key_is_missing() {
        let chats = TempChat::new("web-search-no-key");
        let out = exchange(
            Some(chats.path()),
            vec![
                initialize(),
                initialized(),
                serde_json::json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "web_search", "arguments": { "query": "Nomi" } }
                }),
            ],
        )
        .await;
        let reply = out
            .iter()
            .find(|message| message["id"] == 1)
            .expect("no response");
        assert!(
            reply.to_string().contains("Exa API Key"),
            "missing-key response was not actionable: {reply}"
        );
    }
}
