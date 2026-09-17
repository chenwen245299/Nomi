import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import {
  RiCheckLine,
  RiFileCopyLine,
  RiShieldCheckLine,
  RiTerminalBoxLine,
} from "@remixicon/react";
import { accentFor, cardShadow, motion, useTheme, type Accent, type Theme } from "../theme";
import { copyText } from "../clipboard";
import type { McpController } from "./useMcp";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

// What the external AI can do once connected — shown so the user knows exactly
// what they are exposing before flipping the switch on.
const TOOLS: { name: string; desc: string }[] = [
  { name: "get_chat_overview", desc: "统计助手、对话、消息与各类附件的数量" },
  { name: "list_assistants", desc: "列出所有助手及其系统提示词" },
  { name: "list_chats", desc: "按助手查看对话列表（可搜索标题）" },
  { name: "get_chat", desc: "读取某个对话的消息内容（分页）" },
  { name: "get_chat_attachment", desc: "获取消息中的图片、音频、视频或文件" },
  { name: "web_search", desc: "通过 Exa 搜索互联网并返回可引用的来源与相关摘录" },
];

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    content: {
      gap: 16,
      maxWidth: 720,
      paddingBottom: 40,
      paddingHorizontal: 24,
      paddingTop: 20,
      width: "100%",
    },
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      padding: 16,
    },
    // Enable row
    toggleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
    },
    toggleIconWrap: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 10,
      height: 38,
      justifyContent: "center",
      width: 38,
    },
    toggleBody: {
      flex: 1,
      minWidth: 0,
    },
    toggleTitle: {
      color: t.textPrimary,
      fontSize: 14,
      fontWeight: "700",
    },
    toggleDesc: {
      color: t.textSecondary,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 3,
    },
    track: {
      borderRadius: 999,
      height: 26,
      width: 46,
    },
    knob: {
      backgroundColor: "#FFFFFF",
      borderRadius: 999,
      boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
      height: 22,
      position: "absolute",
      top: 2,
      width: 22,
    },
    statusPill: {
      alignSelf: "flex-start",
      borderRadius: 999,
      marginTop: 12,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    statusPillOn: {
      backgroundColor: t.statusGreenFill,
    },
    statusPillOff: {
      backgroundColor: t.controlIdle,
    },
    statusPillText: {
      fontSize: 11.5,
      fontWeight: "600",
    },
    // Section headings
    sectionTitle: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "700",
    },
    sectionHint: {
      color: t.textSecondary,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 4,
    },
    // Tool list
    toolRow: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 10,
      marginTop: 12,
    },
    toolName: {
      color: accent.accentText,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      fontWeight: "600",
      minWidth: 168,
    },
    toolDesc: {
      color: t.textSecondary,
      flex: 1,
      fontSize: 12.5,
      lineHeight: 18,
    },
    // Config snippets
    snippetBlock: {
      marginTop: 14,
    },
    snippetHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      marginBottom: 6,
    },
    snippetLabel: {
      color: t.textPrimary,
      fontSize: 12.5,
      fontWeight: "600",
    },
    snippetPath: {
      color: t.textTertiary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      marginTop: 2,
    },
    copyButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      minHeight: 28,
      paddingHorizontal: 10,
    },
    copyButtonHover: {
      backgroundColor: t.controlHover,
    },
    copyButtonText: {
      color: accent.accentText,
      fontSize: 11.5,
      fontWeight: "600",
    },
    code: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      lineHeight: 18,
      padding: 11,
    },
    // Security note
    noteRow: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: 8,
    },
    noteText: {
      color: t.textSecondary,
      flex: 1,
      fontSize: 12,
      lineHeight: 18,
    },
    errorText: {
      color: t.errorText,
      fontSize: 12,
      marginTop: 8,
    },
  });
}

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={[
        styles.track,
        motion,
        { backgroundColor: value ? accent.accent : theme.t.controlPressed },
      ]}
    >
      <View style={[styles.knob, motion, { transform: [{ translateX: value ? 22 : 2 }] }]} />
    </Pressable>
  );
}

function CopyButton({ text }: { text: string }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void copy()}
      style={({ hovered, pressed }: PressState) => [
        styles.copyButton,
        motion,
        hovered && styles.copyButtonHover,
        pressed && ({ opacity: 0.8 } as ViewStyle),
      ]}
    >
      {copied ? (
        <RiCheckLine color={theme.t.statusGreenText} size={13} />
      ) : (
        <RiFileCopyLine color={accent.accentText} size={13} />
      )}
      <Text style={[styles.copyButtonText, copied && { color: theme.t.statusGreenText }]}>
        {copied ? "已复制" : "复制"}
      </Text>
    </Pressable>
  );
}

function Snippet({ label, path, code }: { label: string; path?: string; code: string }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  return (
    <View style={styles.snippetBlock}>
      <View style={styles.snippetHeader}>
        <View style={{ flex: 1, minWidth: 0 } as ViewStyle}>
          <Text style={styles.snippetLabel}>{label}</Text>
          {path ? (
            <Text numberOfLines={1} selectable style={styles.snippetPath}>
              {path}
            </Text>
          ) : null}
        </View>
        <CopyButton text={code} />
      </View>
      <Text selectable style={styles.code}>
        {code}
      </Text>
    </View>
  );
}

export function McpSettings({ mcp }: { mcp: McpController }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const enabled = mcp.status?.enabled ?? false;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {/* Enable switch */}
      <View style={styles.card}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleIconWrap}>
            <RiTerminalBoxLine color={accent.accentText} size={20} />
          </View>
          <View style={styles.toggleBody}>
            <Text style={styles.toggleTitle}>MCP 服务器</Text>
            <Text style={styles.toggleDesc}>
              开启后，外部 AI 客户端（如 Claude Code、Claude Desktop、Codex）可通过 stdio
              只读访问你的聊天数据。无论 Nomi 是否在运行都可使用。
            </Text>
          </View>
          <Toggle onChange={(next) => void mcp.toggleEnabled(next)} value={enabled} />
        </View>
        <View style={[styles.statusPill, enabled ? styles.statusPillOn : styles.statusPillOff]}>
          <Text
            style={[
              styles.statusPillText,
              { color: enabled ? theme.t.statusGreenText : theme.t.textTertiary },
            ]}
          >
            {enabled ? "● 已开启" : "○ 已关闭"}
          </Text>
        </View>
        {mcp.error ? <Text style={styles.errorText}>{mcp.error}</Text> : null}
      </View>

      {/* What the AI can do */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>可用工具</Text>
        <Text style={styles.sectionHint}>连接后，外部 AI 可以调用以下只读工具：</Text>
        {TOOLS.map((tool) => (
          <View key={tool.name} style={styles.toolRow}>
            <Text style={styles.toolName}>{tool.name}</Text>
            <Text style={styles.toolDesc}>{tool.desc}</Text>
          </View>
        ))}
      </View>

      {/* Client configuration */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>连接方式</Text>
        <Text style={styles.sectionHint}>
          客户端会把 Nomi 作为子进程启动（{`nomi --mcp-stdio`}
          ）。将下面对应的配置添加到你的客户端即可。
        </Text>
        {mcp.config ? (
          <>
            <Snippet label="Claude Code（命令行）" code={mcp.config.claudeCode} />
            <Snippet
              label="Claude Desktop（合并到配置文件）"
              path={mcp.config.desktopConfigPath}
              code={mcp.config.desktopSnippet}
            />
            <Snippet
              label="Codex（合并到配置文件）"
              path={mcp.config.codexConfigPath}
              code={mcp.config.codexSnippet}
            />
          </>
        ) : (
          <Text style={styles.sectionHint}>{mcp.loading ? "加载中…" : "暂时无法获取配置。"}</Text>
        )}
      </View>

      {/* Security note */}
      <View style={styles.card}>
        <View style={styles.noteRow}>
          <RiShieldCheckLine color={theme.t.statusGreenText} size={18} />
          <Text style={styles.noteText}>
            该服务器为只读，可读取聊天内容并通过 Exa 搜索公开互联网。它无法读取你的 AI
            服务商设置或导出任何 API 密钥；Exa Key 仅在 Nomi 后端发起搜索请求时解密，不经过 MCP
            通道。
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
