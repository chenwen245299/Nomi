import { invoke } from "@tauri-apps/api/core";

export interface McpStatus {
  enabled: boolean;
}

export interface McpClientConfig {
  executable: string;
  claudeCode: string;
  desktopConfigPath: string;
  desktopSnippet: string;
  codexConfigPath: string;
  codexSnippet: string;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ── Browser-preview fallback (so `pnpm dev` works without the Rust backend) ──
const preview: { status: McpStatus } = { status: { enabled: false } };

const previewConfig: McpClientConfig = {
  executable: "/Applications/Nomi.app/Contents/MacOS/nomi",
  claudeCode: 'claude mcp add nomi "/Applications/Nomi.app/Contents/MacOS/nomi" --mcp-stdio',
  desktopConfigPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
  desktopSnippet: JSON.stringify(
    {
      mcpServers: {
        nomi: { command: "/Applications/Nomi.app/Contents/MacOS/nomi", args: ["--mcp-stdio"] },
      },
    },
    null,
    2,
  ),
  codexConfigPath: "~/.codex/config.toml",
  codexSnippet:
    '[mcp_servers.nomi]\ncommand = "/Applications/Nomi.app/Contents/MacOS/nomi"\nargs = ["--mcp-stdio"]\n',
};

export async function getMcpStatus(): Promise<McpStatus> {
  if (isTauri()) {
    return invoke<McpStatus>("mcp_get_status");
  }
  return { ...preview.status };
}

export async function setMcpEnabled(enabled: boolean): Promise<McpStatus> {
  if (isTauri()) {
    return invoke<McpStatus>("mcp_set_enabled", { enabled });
  }
  preview.status.enabled = enabled;
  return { ...preview.status };
}

export async function getMcpClientConfig(): Promise<McpClientConfig> {
  if (isTauri()) {
    return invoke<McpClientConfig>("mcp_get_client_config");
  }
  return previewConfig;
}
