import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import {
  RiCheckLine,
  RiDeleteBinLine,
  RiKey2Line,
  RiSave3Line,
  RiSearchAiLine,
} from "@remixicon/react";
import { accentFor, cardShadow, motion, useTheme, type Accent, type Theme } from "../theme";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
type ExaStatus = { hasKey: boolean };

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 14,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      maxWidth: 680,
      padding: 18,
      width: "100%",
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
    },
    iconWrap: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 10,
      height: 38,
      justifyContent: "center",
      marginRight: 12,
      width: 38,
    },
    heading: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "600",
      letterSpacing: -0.1,
    },
    description: {
      color: t.textSecondary,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 4,
    },
    statusPill: {
      borderRadius: 999,
      marginLeft: 10,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    statusReady: {
      backgroundColor: t.statusGreenFill,
    },
    statusEmpty: {
      backgroundColor: t.controlIdle,
    },
    statusText: {
      fontSize: 11,
      fontWeight: "600",
    },
    inputWrap: {
      alignItems: "center",
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 9,
      borderWidth: 1,
      flexDirection: "row",
      gap: 8,
      marginTop: 16,
      paddingHorizontal: 11,
    },
    input: {
      color: t.textPrimary,
      flex: 1,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      height: 38,
      minHeight: 38,
      paddingHorizontal: 0,
      paddingVertical: 0,
    },
    securityHint: {
      color: t.textTertiary,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 8,
    },
    actions: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginTop: 12,
    },
    button: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      height: 32,
      paddingHorizontal: 11,
    },
    saveButton: {
      backgroundColor: accent.accent,
    },
    removeButton: {
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderWidth: 1,
    },
    saveText: {
      color: t.onAccent,
      fontSize: 12,
      fontWeight: "600",
    },
    removeText: {
      color: t.errorText,
      fontSize: 12,
      fontWeight: "600",
    },
    disabled: {
      opacity: 0.45,
    },
    feedback: {
      color: t.statusGreenText,
      flex: 1,
      fontSize: 11.5,
    },
    error: {
      color: t.errorText,
      fontSize: 11.5,
      lineHeight: 17,
      marginTop: 8,
    },
  });
}

export function ExaSettings() {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const [status, setStatus] = useState<ExaStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const next = isTauriRuntime()
          ? await invoke<ExaStatus>("exa_get_status")
          : { hasKey: false };
        if (active) setStatus(next);
      } catch (loadError) {
        if (active) setError(String(loadError));
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  async function save() {
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const next = isTauriRuntime()
        ? await invoke<ExaStatus>("exa_set_key", { key: trimmed })
        : { hasKey: true };
      setStatus(next);
      setKey("");
      setFeedback("已保存，支持工具调用的模型现在可以使用 web_search。");
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !status?.hasKey) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("移除 Exa API Key？联网搜索将立即停用。")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const next = isTauriRuntime()
        ? await invoke<ExaStatus>("exa_set_key", { key: "" })
        : { hasKey: false };
      setStatus(next);
      setKey("");
      setFeedback("Exa API Key 已移除。");
    } catch (removeError) {
      setError(String(removeError));
    } finally {
      setBusy(false);
    }
  }

  const hasKey = status?.hasKey ?? false;
  const canSave = key.trim().length > 0 && !busy;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <RiSearchAiLine color={accent.accentText} size={20} />
        </View>
        <View style={styles.heading}>
          <Text style={styles.title}>Exa 联网搜索</Text>
          <Text style={styles.description}>
            配置后，支持工具调用的模型可以通过 web_search 搜索互联网并引用来源。
          </Text>
        </View>
        <View style={[styles.statusPill, hasKey ? styles.statusReady : styles.statusEmpty]}>
          <Text
            style={[
              styles.statusText,
              { color: hasKey ? theme.t.statusGreenText : theme.t.textTertiary },
            ]}
          >
            {status === null ? "读取中" : hasKey ? "已配置" : "未配置"}
          </Text>
        </View>
      </View>

      <View style={styles.inputWrap}>
        <RiKey2Line color={theme.t.textTertiary} size={16} />
        <TextInput
          accessibilityLabel="Exa API Key"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onChangeText={setKey}
          onSubmitEditing={() => void save()}
          placeholder={hasKey ? "输入新的 Key 可替换当前配置" : "输入 Exa API Key"}
          placeholderTextColor={theme.t.textTertiary}
          secureTextEntry
          style={styles.input}
          value={key}
        />
      </View>
      <Text style={styles.securityHint}>
        Key 会加密保存在 Nomi 数据目录中，仅由后端向 Exa 发起请求时解密；不会发送给聊天模型或 MCP
        客户端。
      </Text>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={!canSave}
          onPress={() => void save()}
          style={({ hovered, pressed }: PressState) => [
            styles.button,
            styles.saveButton,
            motion,
            hovered && canSave && ({ filter: "brightness(1.06)" } as ViewStyle),
            pressed && ({ opacity: 0.9 } as ViewStyle),
            !canSave && styles.disabled,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={theme.t.onAccent} size="small" />
          ) : feedback && hasKey ? (
            <RiCheckLine color={theme.t.onAccent} size={14} />
          ) : (
            <RiSave3Line color={theme.t.onAccent} size={14} />
          )}
          <Text style={styles.saveText}>{hasKey ? "更新 Key" : "保存 Key"}</Text>
        </Pressable>
        {hasKey ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void remove()}
            style={({ hovered, pressed }: PressState) => [
              styles.button,
              styles.removeButton,
              motion,
              hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
              pressed && ({ opacity: 0.75 } as ViewStyle),
              busy && styles.disabled,
            ]}
          >
            <RiDeleteBinLine color={theme.t.errorText} size={14} />
            <Text style={styles.removeText}>移除</Text>
          </Pressable>
        ) : null}
        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
