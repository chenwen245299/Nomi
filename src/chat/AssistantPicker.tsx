import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { RiArrowDownSLine, RiCheckLine } from "@remixicon/react";
import { modalShadow, motion, useTheme, type Accent, type Theme } from "../theme";
import { DEFAULT_ASSISTANT_ID, type Assistant } from "./api";
import { assistantEmoji } from "./emoji";
import { useConversationSending } from "./useConversation";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
type MenuPosition = { left: number; maxHeight: number; top: number; width: number };

type AssistantOption = Pick<Assistant, "emoji" | "id" | "name">;

const DEFAULT_ASSISTANT: AssistantOption = {
  emoji: assistantEmoji(null, DEFAULT_ASSISTANT_ID),
  id: DEFAULT_ASSISTANT_ID,
  name: "默认助手",
};

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    trigger: {
      alignItems: "center",
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      height: 30,
      maxWidth: 156,
      minWidth: 108,
      paddingHorizontal: 8,
    },
    triggerHover: { backgroundColor: t.controlHover },
    triggerOpen: {
      backgroundColor: t.cardSurface,
      borderColor: accent.accent,
      boxShadow: `0 0 0 3px rgba(${accent.rgb},0.12)`,
    },
    triggerDisabled: { opacity: 0.5 },
    triggerText: {
      color: t.textPrimary,
      flex: 1,
      fontSize: 11.5,
      fontWeight: "600",
      minWidth: 0,
    },
    assistantMark: {
      alignItems: "center",
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    assistantEmoji: { fontSize: 15 },
    overlay: {
      bottom: 0,
      left: 0,
      position: "fixed",
      right: 0,
      top: 0,
      zIndex: 90,
    } as unknown as ViewStyle,
    menu: {
      backgroundColor: t.overlaySolid,
      borderColor: t.separatorStrong,
      borderRadius: 12,
      borderWidth: 1,
      overflow: "hidden",
      position: "relative",
      boxShadow: modalShadow(t),
    },
    menuHeader: {
      borderBottomColor: t.separator,
      borderBottomWidth: 1,
      paddingBottom: 8,
      paddingHorizontal: 12,
      paddingTop: 9,
    },
    menuTitle: { color: t.textPrimary, fontSize: 11.5, fontWeight: "700" },
    menuHint: { color: t.textTertiary, fontSize: 9.5, marginTop: 3 },
    menuError: { color: t.errorText, fontSize: 10.5, marginTop: 4 },
    menuScroll: { minHeight: 52 },
    menuContent: { padding: 6 },
    option: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 8,
      minHeight: 38,
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    optionHover: { backgroundColor: t.controlHover },
    optionSelected: { backgroundColor: accent.selectedFill },
    optionName: { color: t.textPrimary, flex: 1, fontSize: 11.5, fontWeight: "600" },
    selectedMark: {
      alignItems: "center",
      backgroundColor: accent.accent,
      borderRadius: 9,
      height: 16,
      justifyContent: "center",
      width: 16,
    },
  });
}

function AssistantMark({ assistant, accent }: { assistant: AssistantOption; accent: Accent }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  return (
    <View style={styles.assistantMark}>
      <Text style={styles.assistantEmoji}>{assistantEmoji(assistant.emoji, assistant.id)}</Text>
    </View>
  );
}

export function ConversationAssistantPicker({
  accent,
  assistantId,
  assistants,
  conversationId,
  defaultAssistantEmoji,
  onSelect,
}: {
  accent: Accent;
  assistantId: string;
  assistants: Assistant[];
  conversationId: string;
  defaultAssistantEmoji: string;
  onSelect: (assistantId: string) => Promise<void>;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const sending = useConversationSending(assistantId, conversationId);
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectError, setSelectError] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const options = useMemo<AssistantOption[]>(
    () => [
      { ...DEFAULT_ASSISTANT, emoji: defaultAssistantEmoji || DEFAULT_ASSISTANT.emoji },
      ...assistants.map(({ emoji, id, name }) => ({ emoji: assistantEmoji(emoji, id), id, name })),
    ],
    [assistants, defaultAssistantEmoji],
  );
  const selected = options.find((assistant) => assistant.id === assistantId) ?? DEFAULT_ASSISTANT;
  const disabled = sending || selecting;

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(220, window.innerWidth - 24);
    const top = rect.bottom + 6;
    setPosition({
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      maxHeight: Math.max(160, window.innerHeight - top - 12),
      top,
      width,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, updatePosition]);

  async function choose(nextAssistantId: string) {
    if (nextAssistantId === assistantId) {
      setOpen(false);
      return;
    }
    setSelectError("");
    setSelecting(true);
    try {
      await onSelect(nextAssistantId);
      setOpen(false);
    } catch (error) {
      setSelectError(String(error));
    } finally {
      setSelecting(false);
    }
  }

  return (
    <>
      <div
        ref={triggerRef}
        style={{ flexShrink: 0 }}
        title={sending ? "生成过程中不能切换助手" : undefined}
      >
        <Pressable
          accessibilityLabel="选择助手"
          accessibilityRole="button"
          accessibilityState={{ disabled, expanded: open && !sending }}
          disabled={disabled}
          onPress={() => {
            setOpen((current) => {
              if (!current) requestAnimationFrame(updatePosition);
              return !current;
            });
          }}
          style={({ hovered, pressed }: PressState) => [
            styles.trigger,
            motion,
            hovered && !open && !disabled && styles.triggerHover,
            open && styles.triggerOpen,
            disabled && styles.triggerDisabled,
            pressed && ({ opacity: 0.82 } as ViewStyle),
          ]}
        >
          <AssistantMark accent={accent} assistant={selected} />
          <Text numberOfLines={1} style={styles.triggerText}>
            {selected.name}
          </Text>
          <RiArrowDownSLine
            color={theme.t.textTertiary}
            size={14}
            style={{
              transform: open ? "rotate(180deg)" : undefined,
              transition: "transform 0.15s",
            }}
          />
        </Pressable>
      </div>

      {open && !sending && position
        ? createPortal(
            <div
              onMouseDown={() => setOpen(false)}
              style={{ inset: 0, position: "fixed", zIndex: 90 }}
            >
              <View style={styles.overlay} />
              <div
                aria-label="选择助手"
                onMouseDown={(event) => event.stopPropagation()}
                role="dialog"
                style={{
                  left: position.left,
                  maxHeight: position.maxHeight,
                  position: "fixed",
                  top: position.top,
                  width: position.width,
                  zIndex: 91,
                }}
              >
                <View
                  style={[styles.menu, { maxHeight: position.maxHeight, width: position.width }]}
                >
                  <View style={styles.menuHeader}>
                    <Text style={styles.menuTitle}>选择助手</Text>
                    <Text style={styles.menuHint}>切换仅影响后续回复</Text>
                    {selectError ? (
                      <Text numberOfLines={2} style={styles.menuError}>
                        {selectError}
                      </Text>
                    ) : null}
                  </View>
                  <ScrollView
                    contentContainerStyle={styles.menuContent}
                    style={[styles.menuScroll, { maxHeight: position.maxHeight - 54 }]}
                  >
                    {options.map((assistant) => {
                      const active = assistant.id === assistantId;
                      return (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          key={assistant.id}
                          onPress={() => void choose(assistant.id)}
                          style={({ hovered, pressed }: PressState) => [
                            styles.option,
                            motion,
                            hovered && !active && styles.optionHover,
                            active && styles.optionSelected,
                            pressed && ({ opacity: 0.8 } as ViewStyle),
                          ]}
                        >
                          <AssistantMark accent={accent} assistant={assistant} />
                          <Text numberOfLines={1} style={styles.optionName}>
                            {assistant.name}
                          </Text>
                          {active ? (
                            <View style={styles.selectedMark}>
                              <RiCheckLine color={theme.t.onAccent} size={11} />
                            </View>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
