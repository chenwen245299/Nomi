import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import {
  RiAddLine,
  RiChatHistoryLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiSparkling2Line,
} from "@remixicon/react";
import { modalShadow, motion, useTheme, type Accent, type SectionId, type Theme } from "../theme";
import { EmptyIllustration } from "../illustrations";
import { ConversationView } from "./Conversation";
import { ConversationModelPicker } from "./ModelPicker";
import { useSidebarChat } from "./useSidebarChat";
import { DEFAULT_ASSISTANT_ID, listMessages } from "./api";
import type { Conversation } from "./api";
import type { Provider, ProviderBalance } from "../providers/api";

type PressState = { pressed: boolean; hovered?: boolean };

/**
 * The per-tab AI chat sidebar. Reuses the main chat's {@link ConversationView}
 * (message history, thinking control, tool calls, action buttons — minus the
 * 👍/👎 feedback) against a scope-isolated conversation store, wrapped in a
 * compact header + a slide-over conversation-history card.
 */
export function AiChatPanel({
  scope,
  accent,
  providers,
  onBalance,
}: {
  /** The active tab id — routes this panel to `<tab>/ai-sidebar/…`. */
  scope: SectionId;
  accent: Accent;
  providers: Provider[];
  onBalance: (providerId: string) => Promise<ProviderBalance>;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const sidebar = useSidebarChat(scope);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Question counts for the history subtitles ("N 问"). Loaded lazily each time
  // the panel opens so the flat conversation list stays a single cheap call.
  const [counts, setCounts] = useState<Record<string, number>>({});
  const conversationsRef = useRef(sidebar.conversations);
  useEffect(() => {
    conversationsRef.current = sidebar.conversations;
  }, [sidebar.conversations]);
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        conversationsRef.current.map(async (conversation) => {
          try {
            const messages = await listMessages(DEFAULT_ASSISTANT_ID, conversation.id, scope);
            return [conversation.id, messages.filter((m) => m.role === "user").length] as const;
          } catch {
            return [conversation.id, 0] as const;
          }
        }),
      );
      if (!cancelled) setCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [historyOpen, scope]);

  const active = sidebar.active;
  const activeProvider = providers.find((provider) => provider.id === active?.providerId);
  const title = active?.title?.trim() || "新对话";

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <RiSparkling2Line color={accent.accent} size={16} />
        <Text numberOfLines={1} style={styles.headerTitle}>
          {title}
        </Text>
        <View style={styles.headerActions}>
          <HeaderButton
            accent={accent}
            icon={<RiAddLine color={theme.t.textSecondary} size={17} />}
            label="新对话"
            onPress={() => {
              setHistoryOpen(false);
              void sidebar.newConversation();
            }}
            styles={styles}
          />
          <HeaderButton
            accent={accent}
            active={historyOpen}
            icon={
              <RiChatHistoryLine
                color={historyOpen ? accent.accentText : theme.t.textSecondary}
                size={17}
              />
            }
            label="对话历史"
            onPress={() => setHistoryOpen((open) => !open)}
            styles={styles}
          />
        </View>
      </View>

      <View style={styles.modelRow}>
        <ConversationModelPicker
          accent={accent}
          menuTitle="选择模型"
          modelId={active?.modelId ?? null}
          onBalance={onBalance}
          onSelect={(providerId, modelId) => sidebar.setModel(providerId, modelId)}
          providerId={active?.providerId ?? null}
          providers={providers}
        />
      </View>

      <View style={styles.body}>
        <View style={styles.bodyPad}>
          {active ? (
            <ConversationView
              accent={accent}
              assistantId={DEFAULT_ASSISTANT_ID}
              assistantName="AI 助手"
              conversation={active}
              hideFeedback
              key={active.id}
              onNewConversation={() => void sidebar.newConversation()}
              providerKind={activeProvider?.kind ?? null}
              providerName={activeProvider?.name ?? null}
              providers={providers}
              scope={scope}
            />
          ) : (
            <View style={styles.empty}>
              <EmptyIllustration color={accent.accent} section={scope} size={96} />
              <Text style={styles.emptyTitle}>开始新对话</Text>
              <Text style={styles.emptyHint}>随时向 AI 提问，与当前页面的工作并排进行。</Text>
            </View>
          )}
        </View>

        {historyOpen ? (
          <HistoryPanel
            accent={accent}
            conversations={sidebar.conversations}
            activeId={sidebar.activeId}
            counts={counts}
            onClose={() => setHistoryOpen(false)}
            onDelete={(id) => void sidebar.removeConversation(id)}
            onNew={() => {
              setHistoryOpen(false);
              void sidebar.newConversation();
            }}
            onSelect={(id) => {
              sidebar.select(id);
              setHistoryOpen(false);
            }}
            styles={styles}
            theme={theme}
          />
        ) : null}
      </View>
      {sidebar.error ? <Text style={styles.error}>{sidebar.error}</Text> : null}
    </View>
  );
}

function HeaderButton({
  accent,
  active,
  icon,
  label,
  onPress,
  styles,
}: {
  accent: Accent;
  active?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.headerBtn,
        motion,
        active && { backgroundColor: accent.selectedFill },
        hovered && !active && styles.headerBtnHover,
        pressed && ({ opacity: 0.85 } as ViewStyle),
      ]}
    >
      {icon}
    </Pressable>
  );
}

function HistoryPanel({
  accent,
  conversations,
  activeId,
  counts,
  onClose,
  onDelete,
  onNew,
  onSelect,
  styles,
  theme,
}: {
  accent: Accent;
  conversations: Conversation[];
  activeId: string | null;
  counts: Record<string, number>;
  onClose: () => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  styles: Styles;
  theme: Theme;
}) {
  return (
    <View style={styles.historyCard}>
      <View style={styles.historyHeader}>
        <View>
          <Text style={styles.historyTitle}>对话历史</Text>
          <Text style={styles.historyCount}>{conversations.length} 个历史对话</Text>
        </View>
        <Pressable
          accessibilityLabel="关闭对话历史"
          accessibilityRole="button"
          onPress={onClose}
          style={({ hovered, pressed }: PressState) => [
            styles.headerBtn,
            motion,
            hovered && styles.headerBtnHover,
            pressed && ({ opacity: 0.85 } as ViewStyle),
          ]}
        >
          <RiCloseLine color={theme.t.textSecondary} size={19} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onNew}
        style={({ hovered, pressed }: PressState) => [
          styles.newConvBtn,
          motion,
          hovered && styles.newConvBtnHover,
          pressed && ({ opacity: 0.9 } as ViewStyle),
        ]}
      >
        <RiAddLine color={accent.accentText} size={17} />
        <Text style={styles.newConvLabel}>新对话</Text>
      </Pressable>

      <ScrollView contentContainerStyle={styles.historyList} style={{ flex: 1 } as ViewStyle}>
        {conversations.map((conversation) => (
          <HistoryRow
            accent={accent}
            active={conversation.id === activeId}
            conversation={conversation}
            count={counts[conversation.id]}
            key={conversation.id}
            onDelete={() => onDelete(conversation.id)}
            onSelect={() => onSelect(conversation.id)}
            styles={styles}
            theme={theme}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function HistoryRow({
  active,
  conversation,
  count,
  onDelete,
  onSelect,
  styles,
  theme,
}: {
  accent: Accent;
  active: boolean;
  conversation: Conversation;
  count?: number;
  onDelete: () => void;
  onSelect: () => void;
  styles: Styles;
  theme: Theme;
}) {
  const [hovered, setHovered] = useState(false);
  const date = formatHistoryDate(conversation);
  const meta = count != null ? `${count} 问 · ${date}` : date;
  return (
    <Pressable
      accessibilityRole="button"
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onSelect}
      style={({ pressed }: PressState) => [
        styles.historyRow,
        motion,
        active && styles.historyRowActive,
        hovered && !active && styles.historyRowHover,
        pressed && ({ opacity: 0.9 } as ViewStyle),
      ]}
    >
      <View style={{ flex: 1, minWidth: 0 } as ViewStyle}>
        <Text numberOfLines={1} style={styles.historyRowTitle}>
          {conversation.title?.trim() || "新对话"}
        </Text>
        <Text style={styles.historyRowMeta}>{meta}</Text>
      </View>
      {hovered ? (
        <div
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <View style={styles.historyDelete}>
            <RiDeleteBinLine color={theme.t.textTertiary} size={15} />
          </View>
        </div>
      ) : null}
    </Pressable>
  );
}

function formatHistoryDate(conversation: Conversation): string {
  const seconds = conversation.lastMessageAt ?? conversation.createdAt;
  const date = new Date(seconds * 1000);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme, accent: Accent) {
  const t = theme.t;
  return StyleSheet.create({
    panel: {
      flex: 1,
      minWidth: 0,
      backgroundColor: t.cardSurface,
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: 48,
      paddingHorizontal: 12,
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerTitle: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 14,
      fontWeight: "600",
    },
    headerActions: { alignItems: "center", flexDirection: "row", gap: 4 },
    headerBtn: {
      alignItems: "center",
      borderRadius: 8,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    headerBtnHover: { backgroundColor: t.controlHover },
    modelRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "center",
      paddingVertical: 8,
      borderBottomColor: t.separator,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    body: { flex: 1, minHeight: 0, position: "relative" },
    // Mirror the main chat's chatMainContent padding so the composer + messages
    // get the same breathing room from the panel edges and window bottom.
    bodyPad: { flex: 1, minHeight: 0, paddingBottom: 12, paddingHorizontal: 10 },
    empty: {
      alignItems: "center",
      flex: 1,
      gap: 8,
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    emptyTitle: { color: t.textPrimary, fontSize: 15, fontWeight: "600" },
    emptyHint: { color: t.textTertiary, fontSize: 12.5, textAlign: "center" },
    error: {
      color: "#C2413B",
      fontSize: 12,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    // ── Conversation history: a floating card that slides over the thread. ──
    historyCard: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      bottom: 10,
      boxShadow: modalShadow(t),
      left: 10,
      position: "absolute",
      right: 10,
      top: 10,
      zIndex: 5,
    } as ViewStyle,
    historyHeader: {
      alignItems: "flex-start",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingTop: 16,
    },
    historyTitle: { color: t.textPrimary, fontSize: 16, fontWeight: "700" },
    historyCount: { color: t.textTertiary, fontSize: 12.5, marginTop: 3 },
    newConvBtn: {
      alignItems: "center",
      backgroundColor: accent.selectedFill,
      borderColor: accent.wash,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 7,
      justifyContent: "center",
      marginHorizontal: 16,
      marginTop: 14,
      paddingVertical: 13,
    },
    newConvBtnHover: { backgroundColor: accent.iconBadge },
    newConvLabel: { color: accent.accentText, fontSize: 14, fontWeight: "600" },
    historyList: { gap: 4, paddingHorizontal: 10, paddingTop: 12, paddingBottom: 14 },
    historyRow: {
      alignItems: "center",
      borderRadius: 10,
      flexDirection: "row",
      gap: 8,
      minHeight: 52,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    historyRowActive: { backgroundColor: accent.selectedFill },
    historyRowHover: { backgroundColor: t.controlIdle },
    historyRowTitle: { color: t.textPrimary, fontSize: 14, fontWeight: "600" },
    historyRowMeta: { color: t.textTertiary, fontSize: 12, marginTop: 4 },
    historyDelete: {
      alignItems: "center",
      borderRadius: 7,
      height: 28,
      justifyContent: "center",
      width: 28,
    },
  });
}
