// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Launched by an MCP client as a subprocess rather than by the user: serve
    // MCP over stdin/stdout instead of opening a window. Checked before any Tauri
    // setup so no GUI machinery starts in this mode.
    if std::env::args().any(|arg| arg == nomi_lib::MCP_STDIO_FLAG) {
        std::process::exit(nomi_lib::run_mcp_stdio());
    }
    nomi_lib::run()
}
