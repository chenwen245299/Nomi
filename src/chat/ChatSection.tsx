import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  RiFolderAddLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiInboxLine,
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
  type ChatGroup,
  type ConversationRef,
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

async function confirmConversationDeleteMany(count: number): Promise<boolean> {
  const message = `确定删除选中的 ${count} 个对话吗？这些对话文件夹及其中的附件会被永久删除。`;
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
    groupSection: {
      borderColor: "transparent",
      borderRadius: 10,
      borderWidth: 1,
      marginBottom: 4,
      overflow: "hidden",
    },
    groupSectionDrop: {
      backgroundColor: accent.wash,
      borderColor: accent.accent,
    },
    groupHeader: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 6,
      minHeight: 32,
      paddingHorizontal: 7,
    },
    groupHeaderHover: { backgroundColor: t.controlHover },
    groupChevron: {
      alignItems: "center",
      flexShrink: 0,
      height: 24,
      justifyContent: "center",
      width: 18,
    },
    groupName: {
      color: t.textSecondary,
      flex: 1,
      fontSize: 11.5,
      fontWeight: "700",
      minWidth: 0,
    },
    groupCount: { color: t.textTertiary, flexShrink: 0, fontSize: 10.5 },
    groupEmpty: {
      color: t.textTertiary,
      fontSize: 10.5,
      paddingBottom: 9,
      paddingHorizontal: 31,
    },
    ungroupedDropHint: {
      color: accent.accentText,
      fontSize: 10.5,
      paddingBottom: 8,
      paddingHorizontal: 31,
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
    convRowSelected: {
      backgroundColor: accent.selectedFill,
      boxShadow: `inset 0 0 0 1px rgba(${accent.rgb},0.35)`,
    },
    convCheck: {
      alignItems: "center",
      borderColor: t.separatorStrong,
      borderRadius: 6,
      borderWidth: 1.5,
      flexShrink: 0,
      height: 16,
      justifyContent: "center",
      marginRight: 1,
      width: 16,
    },
    convCheckOn: { backgroundColor: accent.accent, borderColor: accent.accent },
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
    groupDialog: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: "0 20px 52px rgba(16,24,36,0.24)",
      gap: 12,
      padding: 16,
      width: 320,
    },
    groupDialogTitle: { color: t.textPrimary, fontSize: 15, fontWeight: "700" },
    groupDialogHint: { color: t.textTertiary, fontSize: 11.5, lineHeight: 17 },
    groupNameInput: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 13,
      minHeight: 38,
      paddingHorizontal: 11,
      paddingVertical: 8,
    },
    groupDialogActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
    groupDialogCancel: {
      borderRadius: 8,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    groupDialogCancelText: { color: t.textSecondary, fontSize: 12, fontWeight: "600" },
    groupDialogCreate: {
      backgroundColor: accent.accent,
      borderRadius: 8,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    groupDialogCreateText: { color: t.onAccent, fontSize: 12, fontWeight: "700" },
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
    // Inline tool picker: a bordered card with a select-all header and a list that
    // scrolls internally (capped height) so long tool lists stay contained.
    toolsPanel: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 10,
      borderWidth: 1,
      marginTop: 6,
      overflow: "hidden",
    },
    toolsPanelHeader: {
      alignItems: "center",
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      flexDirection: "row",
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    toolsCount: { color: t.textSecondary, fontSize: 11.5, fontWeight: "600" },
    toolsSelectAll: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
    toolsSelectAllText: { color: accent.accentText, fontSize: 11.5, fontWeight: "700" },
    toolsList: { maxHeight: 216 },
    toolsListContent: { gap: 2, padding: 5 },
    toolsDisabledHint: { color: t.textTertiary, fontSize: 11.5, marginTop: 6 },
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
    assistantModalFooter: {
      alignItems: "center",
      backgroundColor: t.cardSurface,
      borderTopColor: t.separator,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    assistantModalError: {
      color: t.errorText,
      flexShrink: 1,
      fontSize: 11.5,
      textAlign: "right",
    },
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
  // Multi-select: ⌘/Ctrl-click toggles a row, Shift-click extends a range from the
  // last-clicked anchor. Keyed by `${assistantId}/${id}`. A plain click clears it.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [groupDialog, setGroupDialog] = useState<ConversationSummary[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const draggingRef = useRef<ConversationRef[]>([]);
  const anchorRef = useRef<string | null>(null);

  const keyOf = (c: ConversationSummary) => `${c.assistantId}/${c.id}`;

  const all = chat.conversationsFor(assistantId);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (c) => c.title.toLowerCase().includes(q) || c.assistantName.toLowerCase().includes(q),
      )
    : all;
  const knownGroupIds = new Set(chat.groups.map((group) => group.id));
  const groupedSections = chat.groups
    .map((group) => ({
      group,
      conversations: filtered.filter((conversation) => conversation.groupId === group.id),
    }))
    .filter(({ conversations }) => conversations.length > 0 || !q);
  const ungrouped = filtered.filter(
    (conversation) => !conversation.groupId || !knownGroupIds.has(conversation.groupId),
  );
  const orderedVisible = [
    ...groupedSections.flatMap(({ group, conversations }) =>
      group.collapsed ? [] : conversations,
    ),
    ...ungrouped,
  ];

  // Resolve each assistant's displayed emoji so the badge tint can pair with it.
  const emojiByAssistant = useMemo(() => {
    const map = new Map<string, string>();
    for (const assistant of chat.assistants) {
      map.set(assistant.id, assistantEmoji(assistant.emoji, assistant.id));
    }
    return map;
  }, [chat.assistants]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) setMenu(null);
      else if (selected.size) {
        setSelected(new Set());
        anchorRef.current = null;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu, selected]);

  const activate = (conversation: ConversationSummary, mods: { meta: boolean; shift: boolean }) => {
    const key = keyOf(conversation);
    if (mods.meta) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      anchorRef.current = key;
      return;
    }
    if (mods.shift && anchorRef.current) {
      const keys = orderedVisible.map(keyOf);
      const a = keys.indexOf(anchorRef.current);
      const b = keys.indexOf(key);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelected((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i += 1) next.add(keys[i]);
          return next;
        });
        return;
      }
    }
    setSelected(new Set());
    anchorRef.current = key;
    onSelectConversation(conversation.assistantId, conversation.id);
  };

  async function requestDelete(targets: ConversationSummary[]) {
    if (targets.length === 0) return;
    const confirmed =
      targets.length === 1
        ? await confirmConversationDelete(targets[0].title || "新对话")
        : await confirmConversationDeleteMany(targets.length);
    if (!confirmed) return;
    // Sequential: each delete removes a folder + reindexes; parallel risks a race.
    for (const target of targets) {
      await onDeleteConversation(target.assistantId, target.id);
    }
    setSelected(new Set());
    anchorRef.current = null;
  }

  // Only the currently-visible selected rows count: a row hidden by the search
  // filter (or a stale key left over from another assistant) is inert, so a batch
  // delete can never silently catch something off-screen.
  const visibleSelected = orderedVisible.filter((c) => selected.has(keyOf(c)));

  // The right-clicked row's delete target(s): the whole visible selection when the
  // row is part of a multi-selection, otherwise just that row.
  const menuKey = menu ? keyOf(menu.conversation) : null;
  const menuIsBatch = !!menuKey && selected.has(menuKey) && visibleSelected.length > 1;
  const menuTargets: ConversationSummary[] = menu
    ? menuIsBatch
      ? visibleSelected
      : [menu.conversation]
    : [];

  const beginPointerDragging = (conversation: ConversationSummary) => {
    const targets = selected.has(keyOf(conversation)) ? visibleSelected : [conversation];
    const refs = targets.map(({ assistantId, id }) => ({ assistantId, id }));
    draggingRef.current = refs;
  };

  const groupDropAt = (x: number, y: number): string | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chat-group-drop]");
    return element?.dataset.chatGroupDrop ?? null;
  };

  const moveDraggingTo = (groupId: string | null) => {
    const targets = draggingRef.current;
    if (targets.length === 0) return;
    void chat.moveConversationsToGroup(targets, groupId);
    draggingRef.current = [];
    setDropTarget(null);
    setSelected(new Set());
    anchorRef.current = null;
  };

  const finishPointerDragging = (x: number, y: number) => {
    const target = groupDropAt(x, y);
    if (target) {
      moveDraggingTo(target === "__ungrouped__" ? null : target);
      return;
    }
    draggingRef.current = [];
    setDropTarget(null);
  };

  const renderConversation = (conversation: ConversationSummary) => (
    <ConversationRow
      accent={accent}
      active={
        conversation.assistantId === conversationAssistantId && conversation.id === conversationId
      }
      conversation={conversation}
      emoji={emojiByAssistant.get(conversation.assistantId)}
      key={`${conversation.assistantId}/${conversation.id}`}
      onActivate={(mods) => activate(conversation, mods)}
      onContextMenu={(x, y) => {
        const key = keyOf(conversation);
        // Right-clicking outside the current selection collapses it to this row.
        if (!selected.has(key)) {
          setSelected(new Set());
          anchorRef.current = key;
        }
        setMenu({ conversation, x, y });
      }}
      onPointerDragEnd={finishPointerDragging}
      onPointerDragMove={(x, y) => setDropTarget(groupDropAt(x, y))}
      onPointerDragStart={() => beginPointerDragging(conversation)}
      selected={selected.has(keyOf(conversation))}
      selectionActive={visibleSelected.length > 0}
      showAssistant={assistantId === null}
    />
  );

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
        {groupedSections.map(({ group, conversations }) => (
          <ConversationGroupSection
            accent={accent}
            conversations={conversations}
            dropActive={dropTarget === group.id}
            group={group}
            key={group.id}
            onRename={(name) => chat.renameGroup(group.id, name)}
            onToggle={() => void chat.setGroupCollapsed(group.id, !group.collapsed)}
            renderConversation={renderConversation}
            styles={styles}
            theme={theme}
          />
        ))}
        {chat.groups.length > 0 ? (
          <UngroupedConversationSection
            conversations={ungrouped}
            dropActive={dropTarget === "__ungrouped__"}
            renderConversation={renderConversation}
            styles={styles}
            theme={theme}
          />
        ) : (
          ungrouped.map(renderConversation)
        )}
      </ScrollView>
      {menu ? (
        <ConversationContextMenu
          accent={accent}
          count={menuTargets.length}
          menu={menu}
          onClose={() => setMenu(null)}
          onCreateGroup={() => {
            const targets = menuTargets;
            setMenu(null);
            setGroupDialog(targets);
          }}
          onDelete={() => {
            const targets = menuTargets;
            setMenu(null);
            void requestDelete(targets);
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
      {groupDialog ? (
        <CreateConversationGroupDialog
          accent={accent}
          count={groupDialog.length}
          onClose={() => setGroupDialog(null)}
          onSubmit={async (name) => {
            const refs = groupDialog.map(({ assistantId, id }) => ({ assistantId, id }));
            const created = await chat.createGroup(name, refs);
            if (!created) return;
            setGroupDialog(null);
            setSelected(new Set());
            anchorRef.current = null;
          }}
          styles={styles}
          theme={theme}
        />
      ) : null}
    </>
  );
}

function ConversationGroupSection({
  accent,
  conversations,
  dropActive,
  group,
  onRename,
  onToggle,
  renderConversation,
  styles,
  theme,
}: {
  accent: Accent;
  conversations: ConversationSummary[];
  dropActive: boolean;
  group: ChatGroup;
  onRename: (name: string) => void | Promise<void>;
  onToggle: () => void;
  renderConversation: (conversation: ConversationSummary) => ReactNode;
  styles: ReturnType<typeof makeChatStyles>;
  theme: Theme;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);

  const beginRename = () => {
    setName(group.name);
    setEditing(true);
  };
  const commitRename = () => {
    const next = name.trim() || "新分组";
    setName(next);
    setEditing(false);
    if (next !== group.name) void onRename(next);
  };

  return (
    <div data-chat-group-drop={group.id} style={{ display: "flex", flexDirection: "column" }}>
      <View style={[styles.groupSection, dropActive && styles.groupSectionDrop]}>
        <View style={styles.groupHeader}>
          <Pressable
            accessibilityLabel={
              group.collapsed ? `展开分组 ${group.name}` : `折叠分组 ${group.name}`
            }
            accessibilityRole="button"
            onPress={onToggle}
            style={({ hovered }: PressState) => [
              styles.groupChevron,
              hovered && styles.groupHeaderHover,
            ]}
          >
            <RiArrowDownSLine
              color={theme.t.textTertiary}
              size={15}
              style={{ transform: group.collapsed ? "rotate(-90deg)" : "none" }}
            />
          </Pressable>
          <RiFolderLine color={accent.accentText} size={14} />
          {editing ? (
            <input
              aria-label="分组名称"
              autoFocus
              maxLength={48}
              onBlur={commitRename}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setName(group.name);
                  setEditing(false);
                }
              }}
              style={groupHeaderInputStyle(theme, accent)}
              value={name}
            />
          ) : (
            <div
              aria-label={`分组 ${group.name}，双击重命名`}
              onDoubleClick={beginRename}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "F2") beginRename();
              }}
              role="button"
              style={{ cursor: "text", flex: 1, minWidth: 0 }}
              tabIndex={0}
              title="双击重命名分组"
            >
              <Text numberOfLines={1} style={styles.groupName}>
                {group.name}
              </Text>
            </div>
          )}
          <Text style={styles.groupCount}>{conversations.length}</Text>
        </View>
        {group.collapsed ? null : conversations.length > 0 ? (
          conversations.map(renderConversation)
        ) : (
          <Text style={styles.groupEmpty}>{dropActive ? "松开即可加入此分组" : "暂无对话"}</Text>
        )}
      </View>
    </div>
  );
}

function UngroupedConversationSection({
  conversations,
  dropActive,
  renderConversation,
  styles,
  theme,
}: {
  conversations: ConversationSummary[];
  dropActive: boolean;
  renderConversation: (conversation: ConversationSummary) => ReactNode;
  styles: ReturnType<typeof makeChatStyles>;
  theme: Theme;
}) {
  return (
    <div data-chat-group-drop="__ungrouped__" style={{ display: "flex", flexDirection: "column" }}>
      <View style={[styles.groupSection, dropActive && styles.groupSectionDrop]}>
        <View style={styles.groupHeader}>
          <View style={styles.groupChevron} />
          <RiInboxLine color={theme.t.textTertiary} size={14} />
          <Text numberOfLines={1} style={styles.groupName}>
            未分组
          </Text>
          <Text style={styles.groupCount}>{conversations.length}</Text>
        </View>
        {conversations.length > 0 ? (
          conversations.map(renderConversation)
        ) : (
          <Text style={dropActive ? styles.ungroupedDropHint : styles.groupEmpty}>
            {dropActive ? "松开即可移出当前分组" : "暂无未分组对话"}
          </Text>
        )}
      </View>
    </div>
  );
}

function CreateConversationGroupDialog({
  count,
  onClose,
  onSubmit,
  styles,
  theme,
}: {
  accent: Accent;
  count: number;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
  styles: ReturnType<typeof makeChatStyles>;
  theme: Theme;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    await onSubmit(name.trim());
    setSaving(false);
  };

  return createPortal(
    <div
      aria-label="创建对话分组"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      role="dialog"
      style={{
        alignItems: "center",
        background: "rgba(20, 27, 38, 0.30)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        position: "fixed",
        zIndex: 2200,
      }}
    >
      <View style={styles.groupDialog}>
        <Text style={styles.groupDialogTitle}>创建对话分组</Text>
        <Text style={styles.groupDialogHint}>为选中的 {count} 个对话设置一个分组名称。</Text>
        <TextInput
          accessibilityLabel="新分组名称"
          autoFocus
          editable={!saving}
          maxLength={48}
          onChangeText={setName}
          onSubmitEditing={() => void submit()}
          placeholder="例如：论文阅读"
          placeholderTextColor={theme.t.textTertiary}
          style={styles.groupNameInput}
          value={name}
        />
        <View style={styles.groupDialogActions}>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={onClose}
            style={({ hovered }: PressState) => [
              styles.groupDialogCancel,
              hovered && styles.groupHeaderHover,
            ]}
          >
            <Text style={styles.groupDialogCancelText}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!name.trim() || saving}
            onPress={() => void submit()}
            style={({ hovered }: PressState) => [
              styles.groupDialogCreate,
              (!name.trim() || saving) && { opacity: 0.45 },
              hovered && name.trim() && !saving && ({ filter: "brightness(1.06)" } as ViewStyle),
            ]}
          >
            <Text style={styles.groupDialogCreateText}>{saving ? "创建中…" : "创建"}</Text>
          </Pressable>
        </View>
      </View>
    </div>,
    document.body,
  );
}

function groupHeaderInputStyle(theme: Theme, accent: Accent): CSSProperties {
  return {
    background: "transparent",
    border: 0,
    borderBottom: `1px solid ${accent.accentText}`,
    color: theme.t.textPrimary,
    flex: 1,
    fontFamily: "inherit",
    fontSize: 11.5,
    fontWeight: 700,
    minWidth: 0,
    outline: "none",
    padding: "2px 0",
  };
}

function ConversationContextMenu({
  accent,
  count,
  menu,
  onClose,
  onCreateGroup,
  onDelete,
  onReveal,
  styles,
  theme,
}: {
  accent: Accent;
  count: number;
  menu: { conversation: ConversationSummary; x: number; y: number };
  onClose: () => void;
  onCreateGroup: () => void;
  onDelete: () => void;
  onReveal: () => void;
  styles: ReturnType<typeof makeChatStyles>;
  theme: Theme;
}) {
  const batch = count > 1;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 152));
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
        aria-label={
          batch
            ? `批量对话菜单：${count} 个对话`
            : `对话菜单：${menu.conversation.title || "新对话"}`
        }
        onClick={(event) => event.stopPropagation()}
        role="menu"
        style={{ left, position: "fixed", top }}
      >
        <View style={styles.convContextMenu}>
          <Pressable
            accessibilityLabel={batch ? `将选中的 ${count} 个对话创建分组` : "将对话创建分组"}
            accessibilityRole="button"
            onPress={onCreateGroup}
            style={({ hovered, pressed }: PressState) => [
              styles.convContextMenuItem,
              motion,
              (hovered || pressed) && styles.convContextMenuItemHover,
            ]}
          >
            <RiFolderAddLine color={accent.accentText} size={15} />
            <Text style={styles.convContextMenuText}>
              {batch ? `创建分组（${count}）` : "创建分组"}
            </Text>
          </Pressable>
          <View style={styles.convContextMenuDivider} />
          {/* Revealing in Finder only makes sense for a single conversation folder. */}
          {batch ? null : (
            <>
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
            </>
          )}
          <Pressable
            accessibilityLabel={batch ? `删除选中的 ${count} 个对话` : "从菜单删除对话"}
            accessibilityRole="button"
            onPress={onDelete}
            style={({ hovered, pressed }: PressState) => [
              styles.convContextMenuItem,
              motion,
              (hovered || pressed) && styles.convContextMenuItemDangerHover,
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={15} />
            <Text style={styles.convContextMenuDanger}>
              {batch ? `删除选中的 ${count} 个对话` : "删除对话"}
            </Text>
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
  onActivate,
  onContextMenu,
  onPointerDragEnd,
  onPointerDragMove,
  onPointerDragStart,
  selected,
  selectionActive,
  showAssistant,
}: {
  accent: Accent;
  active: boolean;
  conversation: ConversationSummary;
  emoji?: string;
  onActivate: (mods: { meta: boolean; shift: boolean }) => void;
  onContextMenu: (x: number, y: number) => void;
  onPointerDragEnd: (x: number, y: number) => void;
  onPointerDragMove: (x: number, y: number) => void;
  onPointerDragStart: () => void;
  selected: boolean;
  selectionActive: boolean;
  showAssistant: boolean;
}) {
  const { styles, theme } = useChatStyles(accent);
  const generating = useConversationSending(conversation.assistantId, conversation.id);
  const assistantBadge = badgeForEmoji(emoji, conversation.assistantId);
  const activityTime = conversation.lastMessageAt ?? conversation.createdAt;
  const activityLabel = formatConversationActivity(activityTime);
  // Modifier keys of the click that becomes Pressable's onPress. Captured on the
  // wrapping div's pointerdown, which fires before the press resolves.
  const modRef = useRef<{ meta: boolean; shift: boolean }>({ meta: false, shift: false });
  const suppressPressRef = useRef(false);
  return (
    <div
      data-conversation-row
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event.clientX, event.clientY);
      }}
      onPointerDownCapture={(event) => {
        modRef.current = {
          meta: event.metaKey || event.ctrlKey,
          shift: event.shiftKey,
        };

        if (event.button !== 0 || modRef.current.meta || modRef.current.shift) return;
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startY = event.clientY;
        const previousUserSelect = document.body.style.userSelect;
        const previousCursor = document.body.style.cursor;
        let started = false;

        const cleanup = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", cancel);
          document.body.style.userSelect = previousUserSelect;
          document.body.style.cursor = previousCursor;
        };
        const move = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
          if (!started && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 7) {
            return;
          }
          if (!started) {
            started = true;
            suppressPressRef.current = true;
            document.body.style.userSelect = "none";
            document.body.style.cursor = "grabbing";
            onPointerDragStart();
          }
          moveEvent.preventDefault();
          onPointerDragMove(moveEvent.clientX, moveEvent.clientY);
        };
        const finish = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return;
          cleanup();
          if (!started) return;
          upEvent.preventDefault();
          onPointerDragEnd(upEvent.clientX, upEvent.clientY);
          window.setTimeout(() => {
            suppressPressRef.current = false;
          }, 0);
        };
        const cancel = (cancelEvent: PointerEvent) => {
          if (cancelEvent.pointerId !== pointerId) return;
          cleanup();
          suppressPressRef.current = false;
          onPointerDragEnd(-1, -1);
        };

        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", cancel);
      }}
      style={{ cursor: "grab", display: "flex", flexDirection: "column" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active || selected }}
        onPress={() => {
          if (suppressPressRef.current) {
            suppressPressRef.current = false;
            return;
          }
          onActivate(modRef.current);
        }}
        style={({ hovered, pressed }: PressState) => [
          styles.convRow,
          motion,
          hovered && !active && !selected && styles.convRowHover,
          (active || selected) && styles.convRowActive,
          selected && styles.convRowSelected,
          pressed && ({ opacity: 0.9 } as ViewStyle),
        ]}
      >
        <View style={styles.convBody}>
          <View style={styles.convTitleRow}>
            {selectionActive ? (
              <View style={[styles.convCheck, selected && styles.convCheckOn]}>
                {selected ? <RiCheckLine color={theme.t.onAccent} size={11} /> : null}
              </View>
            ) : null}
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
  const allToolsSelected = enabledToolIds.length === CHAT_TOOLS.length;
  const toggleAllTools = () => setEnabledToolIds(allToolsSelected ? [] : [...ALL_TOOL_IDS]);
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
          <div style={{ maxHeight: "calc(100vh - 174px)", overflowY: "auto" }}>
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

              {/* Tools: whether this assistant offers tools, and which ones. The
                  list is inline with its own scroll + a select-all toggle, so many
                  tools never push the (sticky) save button out of reach. */}
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
              {toolsEnabled ? (
                <View style={styles.toolsPanel}>
                  <View style={styles.toolsPanelHeader}>
                    <Text style={styles.toolsCount}>
                      {enabledToolIds.length === 0
                        ? "未选择工具"
                        : allToolsSelected
                          ? `全部工具 · ${CHAT_TOOLS.length}`
                          : `已选 ${enabledToolIds.length} / ${CHAT_TOOLS.length}`}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Pressable
                      accessibilityRole="button"
                      onPress={toggleAllTools}
                      style={({ hovered }: PressState) => [
                        styles.toolsSelectAll,
                        motion,
                        hovered && ({ backgroundColor: `rgba(${accent.rgb},0.12)` } as ViewStyle),
                      ]}
                    >
                      <Text style={styles.toolsSelectAllText}>
                        {allToolsSelected ? "取消全选" : "全选"}
                      </Text>
                    </Pressable>
                  </View>
                  <ScrollView
                    style={styles.toolsList}
                    contentContainerStyle={styles.toolsListContent}
                  >
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
                  </ScrollView>
                </View>
              ) : (
                <Text style={styles.toolsDisabledHint}>已关闭 — 不向模型提供工具</Text>
              )}
            </View>
          </div>
          {/* Sticky footer: the save button stays reachable no matter how long the
              body (e.g. a large tool list) gets. */}
          <View style={styles.assistantModalFooter}>
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
            <View style={{ flex: 1, minWidth: 8 }} />
            {error ? (
              <Text numberOfLines={2} style={styles.assistantModalError}>
                {error}
              </Text>
            ) : null}
          </View>
        </View>
      </div>
    </div>,
    document.body,
  );
}
