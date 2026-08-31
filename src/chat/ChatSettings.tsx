import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { RiChatAiLine, RiCheckLine, RiResetLeftLine, RiSave3Line } from "@remixicon/react";
import { accentFor, cardShadow, motion, useTheme, type Accent, type Theme } from "../theme";
import { findDefaultModel, isChatModel, type Provider, type ProviderModel } from "../providers/api";
import { DEFAULT_TITLE_GENERATION_PROMPT, getChatSettings, saveChatSettings } from "./api";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };
type ModelOption = { provider: Provider; model: ProviderModel; value: string };

const DEFAULT_MODEL_VALUE = "__default__";

function modelValue(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function parseModelValue(value: string): [string | null, string | null] {
  if (value === DEFAULT_MODEL_VALUE) return [null, null];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // A malformed DOM value should simply fall back to the safe default model.
  }
  return [null, null];
}

function selectStyle(theme: Theme): CSSProperties {
  return {
    appearance: "none",
    backgroundColor: theme.t.cardSurfaceAlt,
    border: `1px solid ${theme.t.separator}`,
    borderRadius: 8,
    color: theme.t.textPrimary,
    fontFamily: "inherit",
    fontSize: 12.5,
    height: 32,
    outline: "none",
    padding: "0 30px 0 8px",
    width: "100%",
  };
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    content: {
      maxWidth: 720,
      paddingBottom: 24,
      paddingHorizontal: 14,
      paddingTop: 12,
      width: "100%",
    },
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      padding: 12,
    },
    header: { alignItems: "center", flexDirection: "row" },
    iconWrap: {
      alignItems: "center",
      backgroundColor: accent.iconBadge,
      borderRadius: 9,
      height: 32,
      justifyContent: "center",
      marginRight: 9,
      width: 32,
    },
    heading: { flex: 1, minWidth: 0 },
    title: {
      color: t.textPrimary,
      fontSize: 13.5,
      fontWeight: "700",
      letterSpacing: -0.1,
    },
    description: {
      color: t.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 2,
    },
    field: { marginTop: 12 },
    label: { color: t.textPrimary, fontSize: 12.5, fontWeight: "600", marginBottom: 4 },
    selectWrap: { position: "relative" },
    selectChevron: {
      color: t.textTertiary,
      fontSize: 12,
      pointerEvents: "none",
      position: "absolute",
      right: 10,
      top: 7,
    },
    prompt: {
      backgroundColor: t.cardSurfaceAlt,
      borderColor: t.separator,
      borderRadius: 8,
      borderWidth: 1,
      color: t.textPrimary,
      fontSize: 12.5,
      lineHeight: 18,
      minHeight: 156,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    hint: { color: t.textTertiary, fontSize: 11, lineHeight: 16, marginTop: 4 },
    actions: { alignItems: "center", flexDirection: "row", gap: 7, marginTop: 10 },
    button: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      height: 32,
      paddingHorizontal: 11,
    },
    saveButton: { backgroundColor: accent.accent },
    resetButton: {
      backgroundColor: t.controlIdle,
      borderColor: t.controlBorder,
      borderWidth: 1,
    },
    saveText: { color: t.onAccent, fontSize: 12, fontWeight: "600" },
    resetText: { color: accent.accentText, fontSize: 12, fontWeight: "600" },
    disabled: { opacity: 0.45 },
    feedback: { color: t.statusGreenText, flex: 1, fontSize: 11.5 },
    error: { color: t.errorText, fontSize: 11.5, lineHeight: 17, marginTop: 9 },
  });
}

export function ChatSettings({ providers }: { providers: Provider[] }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      providers.flatMap((provider) =>
        provider.enabled
          ? provider.models
              .filter(isChatModel)
              .map((model) => ({ provider, model, value: modelValue(provider.id, model.id) }))
          : [],
      ),
    [providers],
  );
  const defaultModel = useMemo(
    () => findDefaultModel(providers.filter((provider) => provider.enabled)),
    [providers],
  );
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_TITLE_GENERATION_PROMPT);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getChatSettings()
      .then((settings) => {
        if (!active) return;
        setProviderId(settings.titleProviderId ?? null);
        setModelId(settings.titleModelId ?? null);
        setPrompt(settings.titlePrompt || DEFAULT_TITLE_GENERATION_PROMPT);
      })
      .catch((loadError) => {
        if (active) setError(String(loadError));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedValue =
    providerId && modelId ? modelValue(providerId, modelId) : DEFAULT_MODEL_VALUE;
  const selectionUnavailable =
    selectedValue !== DEFAULT_MODEL_VALUE &&
    !modelOptions.some((option) => option.value === selectedValue);
  const defaultLabel = defaultModel
    ? `默认模型（${defaultModel.provider.name} · ${defaultModel.model.name}）`
    : "默认模型（尚未设置）";
  const canSave = loaded && !busy && prompt.trim().length > 0;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const saved = await saveChatSettings({
        titleProviderId: providerId,
        titleModelId: modelId,
        titlePrompt: prompt,
      });
      setProviderId(saved.titleProviderId ?? null);
      setModelId(saved.titleModelId ?? null);
      setPrompt(saved.titlePrompt);
      setFeedback("对话标题设置已保存。新对话会从下一条首消息开始使用。");
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} style={{ flex: 1 } as ViewStyle}>
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <RiChatAiLine color={accent.accentText} size={18} />
          </View>
          <View style={styles.heading}>
            <Text style={styles.title}>自动生成对话标题</Text>
            <Text style={styles.description}>
              根据第一条用户消息生成一次简洁标题；失败时仍保留“新对话”，不会影响正常回复。
            </Text>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>标题生成模型</Text>
          <View style={styles.selectWrap}>
            <select
              aria-label="标题生成模型"
              disabled={!loaded || busy}
              onChange={(event) => {
                const [nextProviderId, nextModelId] = parseModelValue(event.target.value);
                setProviderId(nextProviderId);
                setModelId(nextModelId);
                setFeedback(null);
              }}
              style={selectStyle(theme)}
              value={selectedValue}
            >
              <option value={DEFAULT_MODEL_VALUE}>{defaultLabel}</option>
              {selectionUnavailable ? (
                <option value={selectedValue}>{`已不可用：${providerId} · ${modelId}`}</option>
              ) : null}
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.provider.name} · {option.model.name}
                </option>
              ))}
            </select>
            <Text style={styles.selectChevron}>⌄</Text>
          </View>
          <Text style={styles.hint}>
            选择“默认模型”会始终跟随 AI 服务商页面中标记为默认的模型。
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>标题生成提示词</Text>
          <TextInput
            accessibilityLabel="标题生成提示词"
            editable={loaded && !busy}
            maxLength={8_000}
            multiline
            onChangeText={(value) => {
              setPrompt(value);
              setFeedback(null);
            }}
            placeholder="输入标题生成提示词"
            placeholderTextColor={theme.t.textTertiary}
            style={styles.prompt}
            textAlignVertical="top"
            value={prompt}
          />
          <Text style={styles.hint}>
            Nomi 会把这里的内容作为系统提示词，并将用户的第一条消息单独交给模型。
          </Text>
        </View>

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
            ) : feedback ? (
              <RiCheckLine color={theme.t.onAccent} size={14} />
            ) : (
              <RiSave3Line color={theme.t.onAccent} size={14} />
            )}
            <Text style={styles.saveText}>保存</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!loaded || busy}
            onPress={() => {
              setPrompt(DEFAULT_TITLE_GENERATION_PROMPT);
              setFeedback(null);
            }}
            style={({ hovered, pressed }: PressState) => [
              styles.button,
              styles.resetButton,
              motion,
              hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
              pressed && ({ opacity: 0.75 } as ViewStyle),
              (!loaded || busy) && styles.disabled,
            ]}
          >
            <RiResetLeftLine color={accent.accentText} size={14} />
            <Text style={styles.resetText}>恢复默认提示词</Text>
          </Pressable>
          {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}
