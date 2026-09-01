import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditBoxLine,
  RiEditLine,
  RiFolderOpenLine,
  RiRefreshLine,
} from "@remixicon/react";
import {
  cardShadow,
  COLLECTION_GUTTER,
  motion,
  useTheme,
  withGlow,
  type Accent,
  type Theme,
} from "../theme";
import { EmptyIllustration } from "../illustrations";
import { BrandIcon } from "../providers/BrandIcon";
import { ConversationView } from "./Conversation";
import { findDefaultModel, isChatModel, type Provider } from "../providers/api";
import { providerIconUrl } from "../providers/icons";
import { useConversationSending } from "./useConversation";
import type { ChatData } from "./useChat";
import {
  ALL_TOOL_IDS,
  CHAT_TOOLS,
  DEFAULT_ASSISTANT_ID,
  type Assistant,
  type ConversationSummary,
} from "./api";
import { ASSISTANT_EMOJIS, assistantEmoji, badgeForEmoji, randomAssistantEmoji } from "./emoji";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function confirmConversationDelete(title: string): Promise<boolean> {
  const message = `确定删除对话「${title}」吗？该对话文件夹及其中的附件会被永久删除。`;
  try {
    if (isTauriRuntime()) {
      return await tauriConfirm(message, { title: "删除对话", kind: "warning" });
    }
  } catch {
    // Fall through to the browser dialog in local preview mode.
  }
  return typeof window !== "undefined" ? window.confirm(message) : true;
}

function formatConversationActivity(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date >= today && date < tomorrow) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (date >= yesterday && date < today) return "昨天";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function makeChatStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    // ── Collection: assistant switcher + conversation list ──
    switcherRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      justifyContent: "space-between",
    },
    switcherSelect: {
      flex: 1,
      minWidth: 0,
      position: "relative",
      zIndex: 50,
    },
    switcherTrigger: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      minHeight: 32,
      paddingHorizontal: 7,
    },
    switcherTriggerHover: { backgroundColor: t.controlHover },
    switcherTriggerText: {
      color: t.textPrimary,
      flexShrink: 1,
      fontSize: 15,
      fontWeight: "700",
      letterSpacing: -0.2,
      minWidth: 0,
      textAlign: "left",
    },
    switcherMenu: {
      backgroundColor: t.collectionSolid,
      borderColor: t.separatorStrong,
      borderRadius: 10,
      borderWidth: 1,
      boxShadow: "0 12px 30px rgba(31,39,52,0.16)",
      left: 0,
      maxHeight: 330,
      overflow: "auto" as unknown as ViewStyle["overflow"],
      padding: 5,
      position: "absolute",
      top: 36,
      width: 200,
      zIndex: 60,
    },
    switcherMenuTint: {
      backgroundColor: accent.wash,
      borderRadius: 9,
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    switcherMenuRow: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 9,
      minHeight: 34,
      paddingHorizontal: 9,
    },
    switcherMenuRowHover: { backgroundColor: t.controlHover },
    switcherMenuRowActive: { backgroundColor: accent.selectedFill },
    switcherMenuText: { color: t.textSecondary, flex: 1, fontSize: 12.5, textAlign: "left" },
    switcherMenuTextActive: { color: accent.accentText, fontWeight: "600" },
    switcherDot: { borderRadius: 999, flexShrink: 0, height: 8, width: 8 },
    switcherEmoji: { flexShrink: 0, fontSize: 14, textAlign: "center", width: 16 },
    switcherEdit: {
      alignItems: "center",
      borderRadius: 6,
      height: 26,
      justifyContent: "center",
      width: 26,
    },
    switcherEditHover: { backgroundColor: t.controlPressed },
    switcherDivider: {
      backgroundColor: t.separator,
      height: 1,
      marginHorizontal: 7,
      marginVertical: 5,
    },
    newConvBtn: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    newConvBtnHover: { backgroundColor: t.controlHover },
    list: {
      paddingHorizontal: COLLECTION_GUTTER,
      paddingTop: 2,
      paddingBottom: 12,
    },
    hint: {
      alignItems: "center",
      flex: 1,
      gap: 4,
      justifyContent: "center",
      paddingVertical: 40,
      paddingHorizontal: 20,
    },
    hintTitle: { color: t.textSecondary, fontSize: 12.5, fontWeight: "600" },
    hintText: { color: t.textTertiary, fontSize: 11.5, textAlign: "center" },
    convRow: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      minHeight: 42,
      paddingHorizontal: 10,
      paddingVertical: 6,
      position: "relative",
    },
    convRowHover: { backgroundColor: t.controlHover },
    convRowActive: { backgroundColor: accent.selectedFill },
    convActivitySlot: {
      alignItems: "center",
      flexShrink: 0,
      height: 18,
      justifyContent: "center",
      width: 34,
    },
    convBody: { flex: 1, minWidth: 0 },
    convTitleRow: { alignItems: "center", flexDirection: "row", gap: 5, minWidth: 0 },
    convTitle: { color: t.textPrimary, flex: 1, fontSize: 13, fontWeight: "500", minWidth: 0 },
    convDate: { color: t.textTertiary, flexShrink: 0, fontSize: 10.5 },
    convAssistantBadge: {
      borderRadius: 5,
      flexShrink: 0,
      maxWidth: 68,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    convAssistantBadgeText: { fontSize: 10.5, fontWeight: "600" },
    convContextMenu: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 12px 32px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.10)",
      padding: 5,
      width: 188,
    },
    convContextMenuItem: {
      alignItems: "center",
      borderRadius: 7,
      flexDirection: "row",
      gap: 9,
      minHeight: 34,
      paddingHorizontal: 9,
    },
    convContextMenuItemHover: { backgroundColor: t.controlHover },
    convContextMenuItemDangerHover: { backgroundColor: "rgba(178,77,77,0.10)" },
    convContextMenuText: { color: t.textPrimary, fontSize: 12.5, fontWeight: "500" },
    convContextMenuDanger: { color: t.errorText, fontSize: 12.5, fontWeight: "500" },
    convContextMenuDivider: {
      backgroundColor: t.separator,
      height: 1,
      marginHorizontal: 8,
      marginVertical: 4,
    },
    // ── Main body: assistant editor ──
    body: { gap: 16, maxWidth: 640, width: "100%" },
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      padding: 16,
    },
    fieldLabel: {
      color: t.textSecondary,
      fontSize: 11,
      fontWeight: "600",
      letterSpacing: 0.3,
      marginBottom: 6,
    },
    nameInput: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      minHeight: 36,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    emojiRow: { alignItems: "center", flexDirection: "row", gap: 8, zIndex: 20 },
    emojiSelect: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      height: 36,
      paddingHorizontal: 11,
    },
    emojiSelectHover: { backgroundColor: t.controlHover },
    emojiPreviewText: { fontSize: 18, width: 24 },
    emojiSelectText: { color: t.textSecondary, flex: 1, fontSize: 12.5, fontWeight: "500" },
    emojiPicker: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 14px 36px rgba(24,32,44,0.20)",
      left: 0,
      padding: 10,
      position: "absolute",
      top: 42,
      width: 304,
      zIndex: 40,
    },
    emojiPickerTitle: {
      color: t.textSecondary,
      fontSize: 10.5,
      fontWeight: "700",
      marginBottom: 8,
    },
    emojiOption: {
      alignItems: "center",
      borderRadius: 7,
      height: 32,
      justifyContent: "center",
      minWidth: 0,
      width: "100%",
    },
    emojiOptionHover: { backgroundColor: t.controlHover },
    emojiOptionActive: { backgroundColor: accent.selectedFill },
    emojiOptionText: { fontSize: 18 },
    emojiRandomButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 5,
      height: 36,
      paddingHorizontal: 10,
    },
    emojiRandomButtonHover: { backgroundColor: t.controlHover },
    emojiRandomButtonText: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    promptInput: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      lineHeight: 20,
      minHeight: 120,
      paddingHorizontal: 11,
      paddingVertical: 10,
    },
    inputFocused: {
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.25)`,
    },
    actions: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 14 },
    toolsHeaderRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    toolsSwitch: {
      backgroundColor: t.controlBorder,
      borderRadius: 999,
      height: 20,
      justifyContent: "center",
      marginBottom: 6,
      padding: 2,
      width: 36,
    },
    toolsSwitchKnob: {
      backgroundColor: "#FFFFFF",
      borderRadius: 999,
      boxShadow: "0 1px 2px rgba(20,28,40,0.25)",
      height: 16,
      width: 16,
    },
    toolsSelect: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 40,
      paddingHorizontal: 11,
    },
    toolsSelectText: { color: t.textPrimary, flex: 1, fontSize: 13, minWidth: 0 },
    toolsMenu: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 11,
      borderWidth: 1,
      boxShadow: "0 14px 36px rgba(16,24,36,0.18), 0 2px 8px rgba(16,24,36,0.08)",
      marginTop: 6,
      overflow: "hidden",
      padding: 5,
      position: "absolute",
      top: "100%",
      width: "100%",
      zIndex: 40,
    },
    toolsMenuItem: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 9,
      paddingVertical: 8,
    },
    toolsCheckbox: {
      alignItems: "center",
      borderColor: t.controlBorder,
      borderRadius: 6,
      borderWidth: 1.5,
      height: 18,
      justifyContent: "center",
      width: 18,
    },
    toolsItemName: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600" },
    toolsItemDesc: { color: t.textTertiary, fontSize: 11, marginTop: 1 },
    primaryButton: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      boxShadow: withGlow("inset 0 1px 0 rgba(255,255,255,0.22)", accent),
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 14,
    },
    primaryButtonText: { color: t.onAccent, fontSize: 12.5, fontWeight: "600" },
    primaryPressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
    savedFlash: { color: t.statusGreenText, fontSize: 11.5, fontWeight: "500" },
    dangerButton: {
      alignItems: "center",
      borderRadius: 9,
      flexDirection: "row",
      gap: 6,
      marginLeft: "auto",
      minHeight: 34,
      paddingHorizontal: 12,
    },
    dangerButtonHover: { backgroundColor: "rgba(178,77,77,0.10)" },
    dangerButtonText: { color: t.errorText, fontSize: 12.5, fontWeight: "600" },
    assistantModal: {
      backgroundColor: t.cardSurface,
      borderColor: t.separatorStrong,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: "0 22px 70px rgba(24,32,44,0.24)",
      overflow: "hidden",
      width: "100%",
    },
    assistantModalHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      minHeight: 48,
      paddingHorizontal: 16,
    },
    assistantModalTitle: { color: t.textPrimary, fontSize: 14, fontWeight: "700" },
    assistantModalClose: {
      alignItems: "center",
      borderRadius: 7,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    assistantModalBody: { padding: 16 },
    assistantModalError: { color: t.errorText, fontSize: 11.5, marginTop: 10 },
    // ── Welcome / empty main states ──
    welcome: { alignItems: "center", flexGrow: 1, justifyContent: "center" },
    welcomeArt: { alignItems: "center", marginBottom: 20 },
    welcomeTitle: {
      color: t.textPrimary,
      fontSize: 16,
      fontWeight: "700",
      letterSpacing: -0.3,
      textAlign: "center",
    },
    welcomeText: {
      color: t.textSecondary,
      fontSize: 13,
      lineHeight: 20,
      marginTop: 7,
      maxWidth: 340,
      textAlign: "center",
    },
    welcomeActions: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 18 },
    ghostButton: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 34,
      paddingHorizontal: 13,
    },
    ghostButtonHover: { backgroundColor: t.controlHover },
    ghostButtonText: { color: accent.accentText, fontSize: 12.5, fontWeight: "600" },
  });
}

function useChatStyles(accent: Accent) {
  const theme = useTheme();
  const styles = useMemo(() => makeChatStyles(theme, accent), [theme, accent]);
  return { styles, theme };
}

/** A compact native select styled to match the rest of the desktop controls. */
function selectStyle(theme: Theme, muted: boolean): React.CSSProperties {
  return {
    appearance: "none",
    WebkitAppearance: "none",
    backgroundColor: theme.t.cardSurfaceAlt,
    border: `1px solid ${theme.t.separator}`,
    borderRadius: 9,
    color: muted ? theme.t.textTertiary : theme.t.textPrimary,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    height: 36,
    minHeight: 36,
    maxWidth: "100%",
    outline: "none",
    padding: "0 38px 0 11px",
    textOverflow: "ellipsis",
    width: "100%",
  };
}

// ── Collection header: assistant switcher + new-conversation ──────────────────
export function AssistantSwitcher({
  accent,
  chat,
  assistantId,
  onEditDefaultConversation,
  onEditAssistant,
  onSelectAssistant,
  onNewAssistant,
  onNewConversation,
}: {
  accent: Accent;
  chat: ChatData;
  assistantId: string | null;
  onEditDefaultConversation: () => void;
  onEditAssistant: (id: string) => void;
  onSelectAssistant: (id: string | null) => void;
  onNewAssistant: () => void;
  onNewConversation: () => void;
}) {
  const { styles, theme } = useChatStyles(accent);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedAssistant = assistantId
    ? (chat.assistants.find((assistant) => assistant.id === assistantId) ?? null)
    : null;
  const selectedName = selectedAssistant?.name ?? (assistantId ? "未命名助手" : "全部对话");

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const root = menuRef.current;
      if (root && !event.composedPath().includes(root)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const selectAssistant = (id: string | null) => {
    setOpen(false);
    onSelectAssistant(id);
  };

  return (
    <View style={styles.switcherRow}>
      <div ref={menuRef} style={{ flex: 1, minWidth: 0, position: "relative", zIndex: 50 }}>
        <View style={styles.switcherSelect}>
          <Pressable
            accessibilityLabel="切换助手"
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen((value) => !value)}
            style={({ hovered, pressed }: PressState) => [
              styles.switcherTrigger,
              motion,
              (hovered || pressed || open) && styles.switcherTriggerHover,
            ]}
          >
            {selectedAssistant ? (
              <Text style={styles.switcherEmoji}>
                {assistantEmoji(selectedAssistant.emoji, selectedAssistant.id)}
              </Text>
            ) : null}
            <Text numberOfLines={1} style={styles.switcherTriggerText}>
              {selectedName}
            </Text>
            <RiArrowDownSLine
              color={theme.t.textSecondary}
              size={16}
              style={{
                transform: open ? "rotate(180deg)" : undefined,
                transition: "transform 0.15s",
              }}
            />
          </Pressable>

          {open ? (
            <View style={styles.switcherMenu}>
              <View pointerEvents="none" style={styles.switcherMenuTint} />
              <Pressable
                accessibilityLabel="查看全部对话"
                accessibilityRole="button"
                accessibilityState={{ selected: assistantId == null }}
                onPress={() => selectAssistant(null)}
                style={({ hovered, pressed }: PressState) => [
                  styles.switcherMenuRow,
                  motion,
                  assistantId == null && styles.switcherMenuRowActive,
                  (hovered || pressed) && styles.switcherMenuRowHover,
                ]}
              >
                <View style={[styles.switcherDot, { backgroundColor: theme.t.textTertiary }]} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.switcherMenuText,
                    assistantId == null && styles.switcherMenuTextActive,
                  ]}
                >
                  全部对话
                </Text>
                <div title="编辑全部对话设置">
                  <Pressable
                    accessibilityLabel="编辑全部对话设置"
                    accessibilityRole="button"
                    onPress={(event) => {
                      event.stopPropagation();
                      setOpen(false);
                      onEditDefaultConversation();
                    }}
                    style={({ hovered, pressed }: PressState) => [
                      styles.switcherEdit,
                      motion,
                      (hovered || pressed) && styles.switcherEditHover,
                    ]}
                  >
                    <RiEditLine color={theme.t.textTertiary} size={13} />
                  </Pressable>
                </div>
              </Pressable>

              {chat.assistants.length > 0 ? <View style={styles.switcherDivider} /> : null}

              {chat.assistants.map((assistant) => {
                const active = assistant.id === assistantId;
                const name = assistant.name || "未命名助手";
                return (
                  <Pressable
                    accessibilityLabel={`切换到助手 ${name}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    key={assistant.id}
                    onPress={() => selectAssistant(assistant.id)}
                    style={({ hovered, pressed }: PressState) => [
                      styles.switcherMenuRow,
                      motion,
                      active && styles.switcherMenuRowActive,
                      (hovered || pressed) && styles.switcherMenuRowHover,
                    ]}
                  >
                    <Text style={styles.switcherEmoji}>
                      {assistantEmoji(assistant.emoji, assistant.id)}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.switcherMenuText, active && styles.switcherMenuTextActive]}
                    >
                      {name}
                    </Text>
                    <div title={`编辑 ${name}`}>
                      <Pressable
                        accessibilityLabel={`编辑助手 ${name}`}
                        accessibilityRole="button"
                        onPress={(event) => {
                          event.stopPropagation();
                          setOpen(false);
                          onEditAssistant(assistant.id);
                        }}
                        style={({ hovered, pressed }: PressState) => [
                          styles.switcherEdit,
                          motion,
                          (hovered || pressed) && styles.switcherEditHover,
                        ]}
                      >
                        <RiEditLine color={theme.t.textTertiary} size={13} />
                      </Pressable>
                    </div>
                  </Pressable>
                );
              })}

              <View style={styles.switcherDivider} />
              <Pressable
                accessibilityLabel="新建助手"
                accessibilityRole="button"
                onPress={() => {
                  setOpen(false);
                  onNewAssistant();
                }}
                style={({ hovered, pressed }: PressState) => [
                  styles.switcherMenuRow,
                  motion,
                  (hovered || pressed) && styles.switcherMenuRowHover,
                ]}
              >
                <RiAddLine color={theme.t.textTertiary} size={14} />
                <Text style={styles.switcherMenuText}>新建助手</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </div>
      <Pressable
        accessibilityLabel="新建对话"
        accessibilityRole="button"
        onPress={onNewConversation}
        style={({ hovered, pressed }: PressState) => [
          styles.newConvBtn,
          motion,
          hovered && styles.newConvBtnHover,
          pressed && styles.primaryPressed,
        ]}
      >
        <RiEditBoxLine color={accent.accentText} size={18} />
      </Pressable>
    </View>
  );
}

// ── Collection list: conversations ────────────────────────────────────────────
export function ChatCollection({
  accent,
  chat,
  query,
  assistantId,
  conversationAssistantId,
  conversationId,
  onSelectConversation,
  onDeleteConversation,
}: {
  accent: Accent;
  chat: ChatData;
  query: string;
  assistantId: string | null;
  conversationAssistantId: string | null;
  conversationId: string | null;
  onSelectConversation: (assistantId: string, id: string) => void;
  onDeleteConversation: (assistantId: string, id: string) => void | Promise<void>;
}) {
  const { styles, theme } = useChatStyles(accent);
  const [menu, setMenu] = useState<{
    conversation: ConversationSummary;
    x: number;
    y: number;
  } | null>(null);

  const all = chat.conversationsFor(assistantId);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (c) => c.title.toLowerCase().includes(q) || c.assistantName.toLowerCase().includes(q),
      )
    : all;

  // Resolve each assistant's displayed emoji so the badge tint can pair with it.
  const emojiByAssistant = useMemo(() => {
    const map = new Map<string, string>();
    for (const assistant of chat.assistants) {
      map.set(assistant.id, assistantEmoji(assistant.emoji, assistant.id));
    }
    return map;
  }, [chat.assistants]);

  useEffect(() => {
    if (!menu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menu]);

  async function requestDelete(conversation: ConversationSummary) {
    const confirmed = await confirmConversationDelete(conversation.title || "新对话");
    if (!confirmed) return;
    await onDeleteConversation(conversation.assistantId, conversation.id);
  }

  if (filtered.length === 0) {
    return (
      <View style={styles.hint}>
        <Text style={styles.hintTitle}>{q ? "没有匹配的对话" : "还没有对话"}</Text>
        <Text style={styles.hintText}>
          {q ? "换个关键词试试。" : "点击右上角的新建对话按钮开始一段新的对话。"}
        </Text>
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.list} style={{ flex: 1 } as ViewStyle}>
        {filtered.map((conversation) => (
          <ConversationRow
            accent={accent}
            active={
              conversation.assistantId === conversationAssistantId &&
              conversation.id === conversationId
            }
            conversation={conversation}
            emoji={emojiByAssistant.get(conversation.assistantId)}
            key={`${conversation.assistantId}/${conversation.id}`}
            onContextMenu={(x, y) => {
              setMenu({ conversation, x, y });
            }}
            onPress={() => onSelectConversation(conversation.assistantId, conversation.id)}
            showAssistant={assistantId === null}
          />
        ))}
      </ScrollView>
      {menu ? (
        <ConversationContextMenu
          accent={accent}
          menu={menu}
          onClose={() => setMenu(null)}
          onDelete={() => {
            const target = menu.conversation;
            setMenu(null);
            void requestDelete(target);
          }}
          onReveal={() => {
            const target = menu.conversation;
            setMenu(null);
            void chat.revealConversation(target.assistantId, target.id).catch(() => undefined);
          }}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </>
  );
}

function ConversationContextMenu({
  accent,
  menu,
  onClose,
  onDelete,
  onReveal,
  styles,
  theme,
}: {
  accent: Accent;
  menu: { conversation: ConversationSummary; x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
  onReveal: () => void;
  styles: ReturnType<typeof makeChatStyles>;
  theme: Theme;
}) {
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 104));
  return createPortal(
    <div
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ inset: 0, position: "fixed", zIndex: 2000 }}
    >
      <div
        aria-label={`对话菜单：${menu.conversation.title || "新对话"}`}
        onClick={(event) => event.stopPropagation()}
        role="menu"
        style={{ left, position: "fixed", top }}
      >
        <View style={styles.convContextMenu}>
          <Pressable
            accessibilityLabel="在访达中查看对话"
            accessibilityRole="button"
            onPress={onReveal}
            style={({ hovered, pressed }: PressState) => [
              styles.convContextMenuItem,
              motion,
              (hovered || pressed) && styles.convContextMenuItemHover,
            ]}
          >
            <RiFolderOpenLine color={accent.accentText} size={15} />
            <Text style={styles.convContextMenuText}>在访达中查看</Text>
          </Pressable>
          <View style={styles.convContextMenuDivider} />
          <Pressable
            accessibilityLabel="从菜单删除对话"
            accessibilityRole="button"
            onPress={onDelete}
            style={({ hovered, pressed }: PressState) => [
              styles.convContextMenuItem,
              motion,
              (hovered || pressed) && styles.convContextMenuItemDangerHover,
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={15} />
            <Text style={styles.convContextMenuDanger}>删除对话</Text>
          </Pressable>
        </View>
      </div>
    </div>,
    document.body,
  );
}

function ConversationRow({
  accent,
  active,
  conversation,
  emoji,
  onContextMenu,
  onPress,
  showAssistant,
}: {
  accent: Accent;
  active: boolean;
  conversation: ConversationSummary;
  emoji?: string;
  onContextMenu: (x: number, y: number) => void;
  onPress: () => void;
  showAssistant: boolean;
}) {
  const { styles } = useChatStyles(accent);
  const generating = useConversationSending(conversation.assistantId, conversation.id);
  const assistantBadge = badgeForEmoji(emoji, conversation.assistantId);
  const activityTime = conversation.lastMessageAt ?? conversation.createdAt;
  const activityLabel = formatConversationActivity(activityTime);
  return (
    <div
      data-conversation-row
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      style={{ display: "flex", flexDirection: "column" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        onPress={onPress}
        style={({ hovered, pressed }: PressState) => [
          styles.convRow,
          motion,
          hovered && !active && styles.convRowHover,
          active && styles.convRowActive,
          pressed && ({ opacity: 0.9 } as ViewStyle),
        ]}
      >
        <View style={styles.convBody}>
          <View style={styles.convTitleRow}>
            {showAssistant && conversation.assistantId !== DEFAULT_ASSISTANT_ID ? (
              <View
                style={[styles.convAssistantBadge, { backgroundColor: assistantBadge.background }]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.convAssistantBadgeText, { color: assistantBadge.text }]}
                >
                  {conversation.assistantName}
                </Text>
              </View>
            ) : null}
            <Text numberOfLines={1} style={styles.convTitle}>
              {conversation.title}
            </Text>
            {generating ? (
              <ConversationActivityDot accent={accent} />
            ) : (
              <Text style={styles.convDate}>{activityLabel}</Text>
            )}
          </View>
        </View>
      </Pressable>
    </div>
  );
}

function ConversationActivityDot({ accent }: { accent: Accent }) {
  const { styles } = useChatStyles(accent);

  return (
    <View aria-hidden style={styles.convActivitySlot}>
      <div
        className="nomi-conversation-generating-dot"
        style={
          {
            "--nomi-conversation-rgb": accent.rgb,
            backgroundColor: accent.accent,
          } as CSSProperties
        }
      />
    </View>
  );
}

// ── Main body ─────────────────────────────────────────────────────────────────
export function ChatMainBody({
  accent,
  chat,
  assistantId,
  conversationId,
  conversationAssistantId,
  onNewConversation,
  providers,
}: {
  accent: Accent;
  chat: ChatData;
  assistantId: string | null;
  conversationId: string | null;
  conversationAssistantId: string | null;
  onNewConversation: () => void;
  providers: Provider[];
}) {
  // An open conversation wins over everything else.
  if (conversationId && conversationAssistantId) {
    const conversation = chat.conversationById(conversationAssistantId, conversationId);
    if (conversation) {
      const conversationProvider = providers.find(
        (provider) => provider.id === conversation.providerId,
      );
      return (
        <ConversationView
          accent={accent}
          assistantId={conversationAssistantId}
          assistantName={chat.assistantName(conversationAssistantId)}
          conversation={conversation}
          key={`${conversationAssistantId}/${conversationId}`}
          onNewConversation={onNewConversation}
          providerKind={conversationProvider?.kind ?? null}
          providerName={conversationProvider?.name ?? null}
          providers={providers}
        />
      );
    }
  }

  // A specific assistant selected (no conversation open) gets a start screen.
  // Editing lives exclusively in the assistant switcher's standalone modal.
  if (assistantId) {
    const assistant = chat.assistantById(assistantId);
    if (assistant) {
      return (
        <AssistantWelcomeView
          accent={accent}
          assistant={assistant}
          key={assistant.id}
          onNewConversation={onNewConversation}
        />
      );
    }
  }

  // "全部对话" (or nothing selected) → a welcome / new-chat prompt.
  return <WelcomeView accent={accent} onNewConversation={onNewConversation} />;
}

function WelcomeView({
  accent,
  onNewConversation,
}: {
  accent: Accent;
  onNewConversation: () => void;
}) {
  const { styles, theme } = useChatStyles(accent);
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeArt}>
        <EmptyIllustration color={theme.t.textPrimary} section="chat" size={110} />
      </View>
      <Text style={styles.welcomeTitle}>开始一段对话</Text>
      <Text style={styles.welcomeText}>直接新建普通对话，或从左侧下拉框切换到专属助手。</Text>
      <View style={styles.welcomeActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onNewConversation}
          style={({ pressed, hovered }: PressState) => [
            styles.primaryButton,
            motion,
            hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
            pressed && styles.primaryPressed,
          ]}
        >
          <RiAddLine color={theme.t.onAccent} size={16} />
          <Text style={styles.primaryButtonText}>新建对话</Text>
        </Pressable>
      </View>
    </View>
  );
}

function AssistantWelcomeView({
  accent,
  assistant,
  onNewConversation,
}: {
  accent: Accent;
  assistant: Assistant;
  onNewConversation: () => void;
}) {
  const { styles, theme } = useChatStyles(accent);
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeArt}>
        <EmptyIllustration color={theme.t.textPrimary} section="chat" size={110} />
      </View>
      <Text style={styles.welcomeTitle}>开始和「{assistant.name || "未命名助手"}」对话</Text>
      <Text style={styles.welcomeText}>助手设置可通过左侧下拉框中的铅笔按钮修改。</Text>
      <View style={styles.welcomeActions}>
        <Pressable
          accessibilityRole="button"
          onPress={onNewConversation}
          style={({ pressed, hovered }: PressState) => [
            styles.primaryButton,
            motion,
            hovered && ({ filter: "brightness(1.06)" } as ViewStyle),
            pressed && styles.primaryPressed,
          ]}
        >
          <RiAddLine color={theme.t.onAccent} size={16} />
          <Text style={styles.primaryButtonText}>新建对话</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function AssistantEditorModal({
  accent,
  assistant,
  chat,
  defaultConversation = false,
  onClose,
  onCreated,
  onDeleted,
  providers,
}: {
  accent: Accent;
  assistant: Assistant | null;
  chat: ChatData;
  defaultConversation?: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  providers: Provider[];
}) {
  const { styles, theme } = useChatStyles(accent);
  const [name, setName] = useState(assistant?.name ?? "");
  const [emoji, setEmoji] = useState(() =>
    defaultConversation
      ? assistantEmoji(chat.defaultConversationEmoji, DEFAULT_ASSISTANT_ID)
      : assistant
        ? assistantEmoji(assistant.emoji, assistant.id)
        : randomAssistantEmoji(),
  );
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState(
    defaultConversation ? chat.defaultConversationSystemPrompt : (assistant?.systemPrompt ?? ""),
  );
  const [providerId, setProviderId] = useState<string | null>(
    defaultConversation
      ? chat.defaultConversationProviderId
      : (assistant?.defaultProviderId ?? null),
  );
  const [modelId, setModelId] = useState<string | null>(
    defaultConversation ? chat.defaultConversationModelId : (assistant?.defaultModelId ?? null),
  );
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(
    defaultConversation ? chat.defaultConversationToolsEnabled : (assistant?.toolsEnabled ?? true),
  );
  // Which tool ids are checked; `null` from storage means "all tools".
  const [enabledToolIds, setEnabledToolIds] = useState<string[]>(
    () =>
      (defaultConversation ? chat.defaultConversationToolIds : assistant?.toolIds) ?? ALL_TOOL_IDS,
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsPickerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<"name" | "prompt" | "model" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (emojiOpen) setEmojiOpen(false);
      else onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [emojiOpen, onClose]);

  useEffect(() => {
    if (!emojiOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!emojiPickerRef.current?.contains(event.target as Node)) setEmojiOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [emojiOpen]);

  useEffect(() => {
    if (!toolsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!toolsPickerRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [toolsOpen]);

  // A stable signature of the tool choice, for the dirty check. `null` toolIds
  // (from storage) means "all tools", so normalise both sides to the full list.
  const toolSig = (enabled: boolean, ids: string[] | null | undefined) =>
    `${enabled}|${[...(ids ?? ALL_TOOL_IDS)].sort().join(",")}`;
  const currentToolSig = toolSig(toolsEnabled, enabledToolIds);
  const toggleTool = (id: string) =>
    setEnabledToolIds((prev) =>
      prev.includes(id)
        ? prev.filter((t) => t !== id)
        : ALL_TOOL_IDS.filter((t) => prev.includes(t) || t === id),
    );
  // Persist `null` when every tool is on (future-proof: new tools auto-enable).
  const toolIdsToSave = enabledToolIds.length === CHAT_TOOLS.length ? null : enabledToolIds;

  const enabledProviders = providers.filter((provider) => provider.enabled);
  const dirty = defaultConversation
    ? emoji !== chat.defaultConversationEmoji ||
      prompt !== chat.defaultConversationSystemPrompt ||
      (providerId ?? null) !== (chat.defaultConversationProviderId ?? null) ||
      (modelId ?? null) !== (chat.defaultConversationModelId ?? null) ||
      currentToolSig !==
        toolSig(chat.defaultConversationToolsEnabled, chat.defaultConversationToolIds)
    : assistant
      ? name !== assistant.name ||
        emoji !== assistantEmoji(assistant.emoji, assistant.id) ||
        prompt !== assistant.systemPrompt ||
        (providerId ?? null) !== (assistant.defaultProviderId ?? null) ||
        (modelId ?? null) !== (assistant.defaultModelId ?? null) ||
        currentToolSig !== toolSig(assistant.toolsEnabled ?? true, assistant.toolIds)
      : Boolean(name.trim() || prompt || emoji || providerId || modelId);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (defaultConversation) {
        await chat.saveDefaultConversationSettings(
          emoji,
          prompt,
          providerId,
          modelId,
          toolsEnabled,
          toolIdsToSave,
        );
        onClose();
      } else if (assistant) {
        await chat.saveAssistant(
          assistant.id,
          name,
          prompt,
          emoji,
          providerId,
          modelId,
          toolsEnabled,
          toolIdsToSave,
        );
        onClose();
      } else {
        const id = await chat.createAssistant(
          name,
          prompt,
          emoji,
          providerId,
          modelId,
          toolsEnabled,
          toolIdsToSave,
        );
        if (!id) throw new Error("无法创建助手");
        onCreated(id);
        onClose();
      }
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!assistant) return;
    setSaving(true);
    setError(null);
    try {
      await chat.removeAssistant(assistant.id);
      onDeleted();
      onClose();
    } catch (removeError) {
      setError(String(removeError));
    } finally {
      setSaving(false);
    }
  }

  const modelValue = providerId && modelId ? `${providerId}::${modelId}` : "";
  const globalDefault = findDefaultModel(enabledProviders);
  const globalDefaultLabel = globalDefault
    ? `继承全局默认（${globalDefault.provider.name} · ${globalDefault.model.name || globalDefault.model.id}）`
    : "继承全局默认（尚未设置）";
  const selectedModelProvider =
    (providerId ? enabledProviders.find((provider) => provider.id === providerId) : null) ??
    globalDefault?.provider ??
    null;

  const saveDisabled =
    saving ||
    (!defaultConversation && !assistant && !name.trim()) ||
    Boolean((defaultConversation || assistant) && !dirty);

  const dialogTitle = defaultConversation ? "全部对话设置" : assistant ? "编辑助手" : "新建助手";

  return createPortal(
    <div
      aria-label={`${dialogTitle}弹窗`}
      aria-modal="true"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      style={{
        alignItems: "center",
        background: "rgba(31, 39, 52, 0.22)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 32,
        position: "fixed",
        zIndex: 2000,
      }}
    >
      <div
        onPointerDown={(event) => event.stopPropagation()}
        style={{ maxWidth: 600, width: "100%" }}
      >
        <View style={styles.assistantModal}>
          <View style={styles.assistantModalHeader}>
            <Text style={styles.assistantModalTitle}>{dialogTitle}</Text>
            <Pressable
              accessibilityLabel="关闭"
              accessibilityRole="button"
              onPress={onClose}
              style={({ hovered, pressed }: PressState) => [
                styles.assistantModalClose,
                motion,
                (hovered || pressed) && styles.ghostButtonHover,
              ]}
            >
              <RiCloseLine color={theme.t.textSecondary} size={17} />
            </Pressable>
          </View>
          <div style={{ maxHeight: "calc(100vh - 114px)", overflowY: "auto" }}>
            <View style={styles.assistantModalBody}>
              {!defaultConversation ? (
                <>
                  <Text style={styles.fieldLabel}>助手名称</Text>
                  <TextInput
                    onBlur={() => setFocused(null)}
                    onChangeText={setName}
                    onFocus={() => setFocused("name")}
                    placeholder="给助手起个名字"
                    placeholderTextColor={theme.t.textTertiary}
                    style={[styles.nameInput, focused === "name" && styles.inputFocused]}
                    value={name}
                  />
                </>
              ) : null}
              <Text
                style={[
                  styles.fieldLabel,
                  !defaultConversation && ({ marginTop: 14 } as ViewStyle),
                ]}
              >
                助手 Emoji
              </Text>
              <View style={styles.emojiRow}>
                <div ref={emojiPickerRef} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                  <Pressable
                    accessibilityLabel="选择助手 Emoji"
                    accessibilityRole="button"
                    accessibilityState={{ expanded: emojiOpen }}
                    onPress={() => setEmojiOpen((open) => !open)}
                    style={({ hovered, pressed }: PressState) => [
                      styles.emojiSelect,
                      motion,
                      (hovered || pressed || emojiOpen) && styles.emojiSelectHover,
                      emojiOpen && styles.inputFocused,
                    ]}
                  >
                    <Text style={styles.emojiPreviewText}>
                      {emoji || assistantEmoji(null, assistant?.id ?? DEFAULT_ASSISTANT_ID)}
                    </Text>
                    <Text style={styles.emojiSelectText}>选择 Emoji</Text>
                    <RiArrowDownSLine
                      color={theme.t.textTertiary}
                      size={16}
                      style={{
                        transform: emojiOpen ? "rotate(180deg)" : undefined,
                        transition: "transform 0.15s",
                      }}
                    />
                  </Pressable>
                  {emojiOpen ? (
                    <View style={styles.emojiPicker}>
                      <Text style={styles.emojiPickerTitle}>选择一个助手 Emoji</Text>
                      <div
                        style={{
                          display: "grid",
                          gap: 4,
                          gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
                          maxHeight: 212,
                          overflowX: "hidden",
                          overflowY: "auto",
                        }}
                      >
                        {ASSISTANT_EMOJIS.map((option) => (
                          <Pressable
                            accessibilityLabel={`选择 ${option}`}
                            accessibilityRole="button"
                            accessibilityState={{ selected: option === emoji }}
                            key={option}
                            onPress={() => {
                              setEmoji(option);
                              setEmojiOpen(false);
                            }}
                            style={({ hovered, pressed }: PressState) => [
                              styles.emojiOption,
                              motion,
                              (hovered || pressed) && styles.emojiOptionHover,
                              option === emoji && styles.emojiOptionActive,
                            ]}
                          >
                            <Text style={styles.emojiOptionText}>{option}</Text>
                          </Pressable>
                        ))}
                      </div>
                    </View>
                  ) : null}
                </div>
                <Pressable
                  accessibilityLabel="随机选择助手 Emoji"
                  accessibilityRole="button"
                  onPress={() => {
                    setEmoji(randomAssistantEmoji());
                    setEmojiOpen(false);
                  }}
                  style={({ hovered, pressed }: PressState) => [
                    styles.emojiRandomButton,
                    motion,
                    hovered && styles.emojiRandomButtonHover,
                    pressed && ({ opacity: 0.75 } as ViewStyle),
                  ]}
                >
                  <RiRefreshLine color={theme.t.textTertiary} size={14} />
                  <Text style={styles.emojiRandomButtonText}>随机</Text>
                </Pressable>
              </View>
              <Text style={[styles.fieldLabel, { marginTop: 14 } as ViewStyle]}>
                System Prompt（系统提示词）
              </Text>
              <TextInput
                multiline
                onBlur={() => setFocused(null)}
                onChangeText={setPrompt}
                onFocus={() => setFocused("prompt")}
                placeholder={
                  defaultConversation
                    ? "可选；默认为空。用于所有普通对话。"
                    : "描述这个助手的身份、语气和职责…"
                }
                placeholderTextColor={theme.t.textTertiary}
                style={[styles.promptInput, focused === "prompt" && styles.inputFocused]}
                textAlignVertical="top"
                value={prompt}
              />
              <Text style={[styles.fieldLabel, { marginTop: 14 } as ViewStyle]}>默认模型</Text>
              <div style={{ position: "relative", width: "100%" }}>
                {selectedModelProvider ? (
                  <div
                    aria-hidden="true"
                    style={{
                      left: 10,
                      pointerEvents: "none",
                      position: "absolute",
                      top: "50%",
                      transform: "translateY(-50%)",
                      zIndex: 1,
                    }}
                  >
                    <BrandIcon
                      accent={accent}
                      fallback={selectedModelProvider.name.trim().slice(0, 1).toUpperCase() || "M"}
                      size={22}
                      url={providerIconUrl(selectedModelProvider.name, selectedModelProvider.kind)}
                    />
                  </div>
                ) : null}
                <select
                  aria-label={defaultConversation ? "选择普通对话默认模型" : "选择助手默认模型"}
                  onBlur={() => setFocused(null)}
                  onChange={(event) => {
                    const [p, m] = event.target.value
                      ? event.target.value.split("::")
                      : [null, null];
                    setProviderId(p);
                    setModelId(m);
                  }}
                  onFocus={() => setFocused("model")}
                  style={{
                    ...selectStyle(theme, !modelValue),
                    paddingLeft: selectedModelProvider ? 41 : 11,
                    ...(focused === "model"
                      ? {
                          borderColor: accent.accent,
                          boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
                        }
                      : null),
                  }}
                  value={modelValue}
                >
                  <option value="">{globalDefaultLabel}</option>
                  {enabledProviders.map((p) => {
                    const models = p.models.filter(isChatModel);
                    if (models.length === 0) return null;
                    return (
                      <optgroup key={p.id} label={p.name || "未命名"}>
                        {models.map((m) => (
                          <option key={m.id} value={`${p.id}::${m.id}`}>
                            {p.name || "未命名服务商"} · {m.name || m.id}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
                <RiArrowDownSLine
                  aria-hidden="true"
                  color={theme.t.textTertiary}
                  size={17}
                  style={{
                    pointerEvents: "none",
                    position: "absolute",
                    right: 11,
                    top: "50%",
                    transform: "translateY(-50%)",
                  }}
                />
              </div>

              {/* Tools: whether this assistant offers tools, and which ones. */}
              <div ref={toolsPickerRef} style={{ width: "100%" }}>
                <View style={[styles.toolsHeaderRow, { marginTop: 14 } as ViewStyle]}>
                  <Text style={styles.fieldLabel}>工具</Text>
                  <Pressable
                    accessibilityLabel={toolsEnabled ? "关闭工具" : "启用工具"}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: toolsEnabled }}
                    onPress={() => setToolsEnabled((value) => !value)}
                    style={[styles.toolsSwitch, toolsEnabled && { backgroundColor: accent.accent }]}
                  >
                    <View
                      style={[
                        styles.toolsSwitchKnob,
                        toolsEnabled && { transform: [{ translateX: 16 }] },
                      ]}
                    />
                  </Pressable>
                </View>
                <div style={{ position: "relative", width: "100%" }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !toolsEnabled, expanded: toolsOpen }}
                    disabled={!toolsEnabled}
                    onPress={() => setToolsOpen((open) => !open)}
                    style={({ hovered }: PressState) => [
                      styles.toolsSelect,
                      motion,
                      !toolsEnabled && ({ opacity: 0.5 } as ViewStyle),
                      hovered && toolsEnabled && ({ borderColor: accent.accent } as ViewStyle),
                      toolsOpen && {
                        borderColor: accent.accent,
                        boxShadow: `0 0 0 3px rgba(${accent.rgb},0.16)`,
                      },
                    ]}
                  >
                    <Text style={styles.toolsSelectText} numberOfLines={1}>
                      {!toolsEnabled
                        ? "已关闭 — 不向模型提供工具"
                        : enabledToolIds.length === 0
                          ? "未选择工具"
                          : enabledToolIds.length === CHAT_TOOLS.length
                            ? "全部工具"
                            : `已选 ${enabledToolIds.length} / ${CHAT_TOOLS.length} 项工具`}
                    </Text>
                    <RiArrowDownSLine color={theme.t.textTertiary} size={17} />
                  </Pressable>
                  {toolsOpen && toolsEnabled ? (
                    <View style={styles.toolsMenu}>
                      {CHAT_TOOLS.map((tool) => {
                        const checked = enabledToolIds.includes(tool.id);
                        return (
                          <Pressable
                            accessibilityRole="checkbox"
                            accessibilityState={{ checked }}
                            key={tool.id}
                            onPress={() => toggleTool(tool.id)}
                            style={({ hovered }: PressState) => [
                              styles.toolsMenuItem,
                              hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
                            ]}
                          >
                            <View
                              style={[
                                styles.toolsCheckbox,
                                checked && {
                                  backgroundColor: accent.accent,
                                  borderColor: accent.accent,
                                },
                              ]}
                            >
                              {checked ? <RiCheckLine color={theme.t.onAccent} size={13} /> : null}
                            </View>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Text style={styles.toolsItemName}>{tool.name}</Text>
                              <Text style={styles.toolsItemDesc} numberOfLines={1}>
                                {tool.description}
                                {tool.requires ? ` · ${tool.requires}` : ""}
                              </Text>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </div>
              </div>

              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={saveDisabled}
                  onPress={() => void save()}
                  style={({ pressed, hovered }: PressState) => [
                    styles.primaryButton,
                    motion,
                    hovered && !saveDisabled && ({ filter: "brightness(1.06)" } as ViewStyle),
                    pressed && styles.primaryPressed,
                    saveDisabled && ({ opacity: 0.5 } as ViewStyle),
                  ]}
                >
                  <Text style={styles.primaryButtonText}>{saving ? "保存中…" : "保存"}</Text>
                </Pressable>
                {assistant ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={saving}
                    onPress={() => void remove()}
                    style={({ pressed, hovered }: PressState) => [
                      styles.dangerButton,
                      motion,
                      hovered && styles.dangerButtonHover,
                      pressed && ({ opacity: 0.7 } as ViewStyle),
                    ]}
                  >
                    <RiDeleteBinLine color={theme.t.errorText} size={15} />
                    <Text style={styles.dangerButtonText}>删除助手</Text>
                  </Pressable>
                ) : null}
              </View>
              {error ? <Text style={styles.assistantModalError}>{error}</Text> : null}
            </View>
          </div>
        </View>
      </div>
    </div>,
    document.body,
  );
}
