//! A read-only MCP server exposing the user's chat data to external agents.
//!
//! # Shape
//!
//! This is a **stdio** server. The MCP client (Claude Code, Claude Desktop,
//! Codex) launches `nomi --mcp-stdio` as a subprocess and speaks
//! newline-delimited JSON-RPC over its stdin/stdout. There is no network
//! listener, no port to configure and no token to manage — the operating
//! system's process boundary is the whole transport.
//!
//! It reads the chat folder directly, so it works whether or not the Nomi
//! window is open. The only control is the `enabled` switch below: with it off,
//! the server refuses to serve anything.
//!
//! # Concurrency with the running app
//!
//! Reads are safe alongside a running Nomi: the app writes each JSON file whole,
//! and a concurrent reader either sees the previous version or the new one, not
//! a torn file.
//!
//! Everything reachable from here goes through `tools`, which reads only the
//! `chat/` folder — never the AI provider config or the API keys in the OS
//! keychain.

pub mod server;
// The read-only data layer. `pub(crate)` so the crate can reuse it if needed,
// but never `pub` — nothing outside the crate reaches the filesystem here.
pub(crate) mod tools;

use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// CLI flag that runs the MCP server instead of the GUI.
pub const STDIO_FLAG: &str = "--mcp-stdio";

/// Bundle identifier Tauri stores app config under — must match tauri.conf.json.
const IDENTIFIER: &str = "com.nomi.desktop";
/// Where the GUI records the chosen data folder (written by `crate::storage`).
const LOCATOR_FILENAME: &str = "storage-location.json";
/// Where the MCP on/off switch is stored, next to the locator.
const SETTINGS_FILENAME: &str = "mcp.json";
/// The chat feature's folder under the data root (see `crate::chat`).
const CHAT_DIR: &str = "chat";

// ── Settings ─────────────────────────────────────────────────────────────────

/// Off by default (`enabled: false`). Exposing the user's chats — which can hold
/// personal images, audio and video — to other programs is not something to
/// switch on for them; `false` is the derived `bool` default, which is exactly
/// what we want here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub enabled: bool,
}

/// The app config directory (`…/com.nomi.desktop`), reproduced without a Tauri
/// application. The stdio process is a plain CLI invocation of the same binary,
/// so it recomputes the path Tauri would return from `app_config_dir()`.
fn app_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .map(|h| h.join("Library").join("Application Support"));

    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|h| h.join(".config"))
        });

    base.map(|b| b.join(IDENTIFIER))
}

fn settings_path() -> Option<std::path::PathBuf> {
    app_config_dir().map(|d| d.join(SETTINGS_FILENAME))
}

/// Read the MCP settings from disk. Missing / unreadable file means "off".
pub fn read_settings() -> McpSettings {
    let Some(path) = settings_path() else {
        return McpSettings::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the MCP settings, creating the config directory if needed.
pub fn write_settings(settings: &McpSettings) -> Result<(), String> {
    let dir = app_config_dir().ok_or("无法定位应用配置目录。")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用配置目录：{e}"))?;
    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("无法序列化 MCP 设置：{e}"))?;
    std::fs::write(dir.join(SETTINGS_FILENAME), json).map_err(|e| format!("无法保存 MCP 设置：{e}"))
}

fn enabled_on_disk() -> bool {
    read_settings().enabled
}

// ── Chat-folder resolution ─────────────────────────────────────────────────────

/// Resolves the `chat/` folder to serve.
///
/// A trait so `server` has no idea where the path came from — which lets the
/// tests drive the real tool surface against a temporary folder.
pub trait ChatSource: Send + Sync + 'static {
    /// The chat folder to serve, or the reason there is none — which the client
    /// shows the user verbatim, so "switched off" and "no data folder" must not
    /// read as the same thing.
    fn chat_root(&self) -> Result<String, String>;
}

/// Reads the data folder the app recorded, on every call.
///
/// Per call rather than once at startup: the user may change the data folder or
/// switch MCP off while an agent is connected, and the next tool call should
/// follow them there — or stop serving.
struct StoredChatRoot;

impl ChatSource for StoredChatRoot {
    fn chat_root(&self) -> Result<String, String> {
        // Re-checked here, not just before `serve_stdio`: an agent that was
        // connected when the user turned MCP off would otherwise keep read
        // access until it happened to disconnect.
        if !enabled_on_disk() {
            return Err("Nomi 的 MCP 服务器已关闭。请在 Nomi → 设置 → MCP 中重新开启。".into());
        }
        let root = data_root_on_disk()
            .ok_or("Nomi 尚未选择数据文件夹。请先在应用中选择一个，然后重试。")?;
        Ok(root.join(CHAT_DIR).to_string_lossy().to_string())
    }
}

/// The data root the GUI recorded, read straight from the locator file.
fn data_root_on_disk() -> Option<std::path::PathBuf> {
    let locator = app_config_dir()?.join(LOCATOR_FILENAME);
    let raw = std::fs::read_to_string(locator).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let path = value.get("rootPath")?.as_str()?;
    let root = std::path::PathBuf::from(path);
    root.is_dir().then_some(root)
}

// ── Client configuration ───────────────────────────────────────────────────────

/// Ready-to-paste config for the clients the user is likely to connect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    /// Absolute path to this binary, which the client launches.
    pub executable: String,
    /// Shell command for `claude mcp add`.
    pub claude_code: String,
    /// Where Claude Desktop keeps its config on this platform.
    pub desktop_config_path: String,
    /// JSON block to merge into that file.
    pub desktop_snippet: String,
    /// Path to Codex's config file.
    pub codex_config_path: String,
    /// TOML block to merge into that file.
    pub codex_snippet: String,
}

/// Where Claude Desktop keeps its config, written the way documentation does.
///
/// Deliberately not expanded to an absolute path: `$HOME` would put the user's
/// account name on screen, and this panel is the first thing people screenshot
/// when asking for help.
fn desktop_config_path() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "%APPDATA%\\Claude\\claude_desktop_config.json"
    }
    #[cfg(target_os = "macos")]
    {
        "~/Library/Application Support/Claude/claude_desktop_config.json"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "~/.config/Claude/claude_desktop_config.json"
    }
}

/// Path to the running executable, which is what a client must launch. Resolved
/// at runtime: the app may be installed anywhere, and in development it is the
/// `target/debug` binary.
fn executable_path() -> String {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "nomi".to_string())
}

fn desktop_snippet(exe: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "nomi": { "command": exe, "args": [STDIO_FLAG] }
        }
    }))
    .unwrap_or_default()
}

/// Codex reads TOML rather than JSON, but wants the same command and args.
fn codex_snippet(exe: &str) -> String {
    // Escape backslashes so a Windows path stays a valid TOML basic string.
    let escaped = exe.replace('\\', "\\\\");
    format!("[mcp_servers.nomi]\ncommand = \"{escaped}\"\nargs = [\"{STDIO_FLAG}\"]\n")
}

pub fn client_config() -> ClientConfig {
    let exe = executable_path();
    ClientConfig {
        // Quote the path: application bundles live under paths with spaces.
        claude_code: format!("claude mcp add nomi \"{exe}\" {STDIO_FLAG}"),
        desktop_config_path: desktop_config_path().to_string(),
        desktop_snippet: desktop_snippet(&exe),
        codex_config_path: "~/.codex/config.toml".to_string(),
        codex_snippet: codex_snippet(&exe),
        executable: exe,
    }
}

// ── stdio server ───────────────────────────────────────────────────────────────

/// Serve MCP over stdin/stdout until the client disconnects. Returns an exit code.
pub fn run_stdio() -> i32 {
    // A terminal on stdin means someone ran the flag by hand. Explain the mode
    // rather than silently waiting for JSON-RPC that will never arrive.
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        eprintln!(
            "Nomi MCP server (stdio).\n\n\
             This is launched by an MCP client, not run directly. Add it with:\n\n  \
             {}\n\n\
             or see Nomi → Settings → MCP for the Claude Desktop config.",
            client_config().claude_code
        );
        return 2;
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[mcp] cannot start runtime: {e}");
            return 1;
        }
    };

    runtime.block_on(async {
        if !enabled_on_disk() {
            // Exit rather than serving an empty tool list: the client shows the
            // startup failure, and the message says how to fix it.
            eprintln!(
                "[mcp] The Nomi MCP server is switched off. Enable it in \
                 Nomi → Settings → MCP."
            );
            return 1;
        }
        match serve_stdio(Arc::new(StoredChatRoot)).await {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("[mcp] {e}");
                1
            }
        }
    })
}

async fn serve_stdio(source: Arc<dyn ChatSource>) -> Result<(), String> {
    use rmcp::ServiceExt;

    let service = server::NomiMcpServer::new(source)
        .serve(rmcp::transport::io::stdio())
        .await
        .map_err(|e| format!("failed to start MCP server: {e}"))?;

    service
        .waiting()
        .await
        .map_err(|e| format!("MCP server stopped: {e}"))?;
    Ok(())
}

// ── Tauri commands (GUI side) ──────────────────────────────────────────────────
//
// The server itself runs as a separate stdio process the client launches
// (`nomi --mcp-stdio`); these commands only report and flip the on/off switch it
// reads from disk, and hand the settings tab a ready-to-paste client config.
// They deliberately share `read_settings`/`write_settings` with the CLI so the
// GUI and the subprocess can never disagree about where the switch lives.

#[tauri::command]
pub fn mcp_get_status() -> McpSettings {
    read_settings()
}

#[tauri::command]
pub fn mcp_set_enabled(enabled: bool) -> Result<McpSettings, String> {
    let settings = McpSettings { enabled };
    write_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub fn mcp_get_client_config() -> ClientConfig {
    client_config()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_by_default() {
        assert!(
            !McpSettings::default().enabled,
            "the server must not be on without consent"
        );
    }

    #[test]
    fn config_dir_targets_the_apps_own_identifier() {
        let dir = app_config_dir().expect("no config dir");
        assert!(dir.ends_with(IDENTIFIER), "{dir:?}");
    }

    /// The path shown to the user must be the file Claude Desktop reads, and must
    /// not carry their account name, since this panel gets screenshotted.
    #[test]
    fn desktop_config_path_is_generic_and_correct() {
        let p = desktop_config_path();
        assert!(p.ends_with("claude_desktop_config.json"), "{p}");
        assert!(p.contains("Claude"), "{p}");
        if let Ok(home) = std::env::var("HOME") {
            assert!(!p.contains(&home), "the path leaks the home directory: {p}");
        }
    }

    /// Both snippets must launch the same binary with the same flag, or one of
    /// the two clients silently gets a different server.
    #[test]
    fn client_configs_agree_on_how_to_launch() {
        let exe = "/Applications/Nomi.app/Contents/MacOS/nomi";
        let snippet = desktop_snippet(exe);
        let parsed: serde_json::Value = serde_json::from_str(&snippet).unwrap();
        let server = &parsed["mcpServers"]["nomi"];
        assert_eq!(server["command"], exe);
        assert_eq!(server["args"], serde_json::json!([STDIO_FLAG]));
        assert!(server.get("env").is_none(), "stdio config needs no env");
        assert!(server.get("url").is_none(), "stdio config needs no url");
    }

    /// A bundle path contains spaces, so the shell command has to quote it.
    #[test]
    fn claude_code_command_quotes_the_executable() {
        let cfg = client_config();
        assert!(cfg.claude_code.starts_with("claude mcp add nomi \""));
        assert!(cfg.claude_code.ends_with(&format!("\" {STDIO_FLAG}")));
    }

    /// Codex must launch the same binary the others do, with TOML that survives
    /// backslashes (Windows) and spaces (app bundles).
    #[test]
    fn codex_snippet_is_valid_toml_for_awkward_paths() {
        let snippet = codex_snippet("/Applications/My App/nomi");
        assert!(snippet.contains("[mcp_servers.nomi]"));
        assert!(snippet.contains("command = \"/Applications/My App/nomi\""));
        assert!(snippet.contains(&format!("args = [\"{STDIO_FLAG}\"]")));
        let windows = codex_snippet("C:\\Program Files\\Nomi\\nomi.exe");
        assert!(
            windows.contains("C:\\\\Program Files\\\\Nomi\\\\nomi.exe"),
            "backslashes must be escaped for TOML: {windows}"
        );
    }
}
