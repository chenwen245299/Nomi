import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import {
  RiChatVoiceAiLine,
  RiCheckLine,
  RiSave3Line,
  RiStopFill,
  RiVolumeUpLine,
} from "@remixicon/react";
import { accentFor, cardShadow, motion, useTheme, type Accent, type Theme } from "../theme";
import type { Provider } from "../providers/api";
import {
  getTtsSettings,
  listMinimaxVoices,
  saveTtsSettings,
  type TtsSettings,
  type TtsVoice,
} from "./api";
import { stopSpeech, toggleSpeech, useSpeechState } from "./speech";

type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean };

const PREVIEW_ID = "__tts_preview__";
const PREVIEW_TEXT = "你好，这是语音朗读的试听效果。";
const CUSTOM_OPTION = "__custom__";

interface TtsPreset {
  /** Speech model ids suggested for this provider kind. */
  models: string[];
  /** Preset voices suggested for this provider kind. */
  voices: { id: string; label: string }[];
  /** Extra hint shown under the voice field (e.g. where to find more voices). */
  voiceHint?: string;
}

const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "nova", label: "Nova" },
  { id: "onyx", label: "Onyx" },
  { id: "shimmer", label: "Shimmer" },
];

/**
 * Per-provider-kind suggestions. Other providers still work via free text, and
 * MiniMax uses these as defaults until its account voice list is available. MiniMax uses its own
 * `t2a_v2` dialect; every other kind goes through OpenAI-compatible
 * `/audio/speech`, so the OpenAI voice set is the generic fallback.
 */
const TTS_PRESETS: Record<string, TtsPreset> = {
  minimax: {
    models: [
      "speech-2.8-hd",
      "speech-2.8-turbo",
      "speech-2.6-hd",
      "speech-2.6-turbo",
      "speech-02-hd",
      "speech-02-turbo",
      "speech-01-hd",
      "speech-01-turbo",
    ],
    voices: [
      { id: "male-qn-qingse", label: "青涩青年（男）" },
      { id: "male-qn-jingying", label: "精英青年（男）" },
      { id: "female-shaonv", label: "少女（女）" },
      { id: "female-yujie", label: "御姐（女）" },
      { id: "presenter_male", label: "男主持" },
      { id: "presenter_female", label: "女主持" },
    ],
    voiceHint: "音色来自当前 MiniMax 账号，包括系统、复刻和生成音色；也可手动填写音色 ID。",
  },
  stepfun: {
    models: ["step-tts-mini", "step-tts-2", "stepaudio-2.5-tts"],
    voices: [{ id: "cixingnansheng", label: "磁性男声" }],
    voiceHint: "更多音色请查看阶跃星辰文档的官方音色清单，把音色标识填到上方。",
  },
  openai: {
    models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
    voices: OPENAI_VOICES,
  },
  moleapi: {
    models: ["gpt-4o-mini-tts", "tts-1-hd"],
    voices: OPENAI_VOICES,
  },
};

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5];

function presetFor(kind: string | undefined): TtsPreset | undefined {
  return kind ? TTS_PRESETS[kind] : undefined;
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

function inputStyle(theme: Theme): CSSProperties {
  return {
    backgroundColor: theme.t.cardSurfaceAlt,
    border: `1px solid ${theme.t.separator}`,
    borderRadius: 8,
    boxSizing: "border-box",
    color: theme.t.textPrimary,
    fontFamily: "inherit",
    fontSize: 12.5,
    height: 32,
    outline: "none",
    padding: "0 8px",
    width: "100%",
  };
}

function makeStyles(theme: Theme, accent: Accent) {
  const { t } = theme;
  return StyleSheet.create({
    card: {
      backgroundColor: t.cardSurface,
      borderColor: t.separator,
      borderRadius: 12,
      borderWidth: 1,
      boxShadow: cardShadow(t),
      marginTop: 12,
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
    title: { color: t.textPrimary, fontSize: 13.5, fontWeight: "700", letterSpacing: -0.1 },
    description: { color: t.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
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
    hint: { color: t.textTertiary, fontSize: 11, lineHeight: 16, marginTop: 4 },
    row: { flexDirection: "row", gap: 10 },
    actions: { alignItems: "center", flexDirection: "row", gap: 7, marginTop: 12 },
    button: {
      alignItems: "center",
      borderRadius: 8,
      flexDirection: "row",
      gap: 5,
      height: 32,
      paddingHorizontal: 11,
    },
    saveButton: { backgroundColor: accent.accent },
    previewButton: { backgroundColor: t.controlIdle, borderColor: t.controlBorder, borderWidth: 1 },
    saveText: { color: t.onAccent, fontSize: 12, fontWeight: "600" },
    previewText: { color: accent.accentText, fontSize: 12, fontWeight: "600" },
    disabled: { opacity: 0.45 },
    feedback: { color: t.statusGreenText, flex: 1, fontSize: 11.5 },
    error: { color: t.errorText, fontSize: 11.5, lineHeight: 17, marginTop: 9 },
  });
}

const DEFAULT_PROVIDER_VALUE = "";

export function ReadAloudSettings({ providers }: { providers: Provider[] }) {
  const theme = useTheme();
  const accent = accentFor("settings");
  const styles = useMemo(() => makeStyles(theme, accent), [theme, accent]);
  const speech = useSpeechState();

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers],
  );

  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [minimaxVoices, setMinimaxVoices] = useState<TtsVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceRefresh, setVoiceRefresh] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getTtsSettings()
      .then((settings) => {
        if (!active) return;
        setProviderId(settings.providerId ?? null);
        setModelId(settings.modelId ?? "");
        setVoiceId(settings.voiceId ?? "");
        setSpeed(settings.speed || 1);
        setVoicesLoading(Boolean(settings.providerId));
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

  // Stop any preview playback when the settings card unmounts.
  useEffect(() => () => stopSpeech(), []);

  const selectedProvider = enabledProviders.find((provider) => provider.id === providerId) ?? null;
  const isMinimax = selectedProvider?.kind === "minimax";
  const unavailableSelection = providerId != null && selectedProvider == null;
  const preset = presetFor(selectedProvider?.kind);
  const modelList = preset?.models ?? [];
  const voiceList: TtsVoice[] = isMinimax
    ? minimaxVoices.length > 0
      ? minimaxVoices
      : (preset?.voices ?? []).map((voice) => ({
          id: voice.id,
          name: voice.label,
          category: "system" as const,
          description: "",
        }))
    : [];
  const matchingVoices = voiceList.filter((voice) => {
    const query = voiceSearch.trim().toLocaleLowerCase();
    return (
      !query ||
      voice.id === voiceId ||
      `${voice.name} ${voice.id} ${voice.description}`.toLocaleLowerCase().includes(query)
    );
  });
  const canSave = loaded && !busy && providerId != null && modelId.trim().length > 0;
  const previewing = speech.playingId === PREVIEW_ID || speech.pendingId === PREVIEW_ID;

  useEffect(() => {
    if (!isMinimax || !providerId) return;
    let active = true;
    void listMinimaxVoices(providerId)
      .then((voices) => {
        if (active) {
          setMinimaxVoices(voices);
          setVoiceError(null);
        }
      })
      .catch((loadError) => {
        if (active) setVoiceError(String(loadError));
      })
      .finally(() => {
        if (active) setVoicesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isMinimax, providerId, voiceRefresh]);

  function onProviderChange(nextValue: string) {
    const next = nextValue || null;
    setProviderId(next);
    setFeedback(null);
    setMinimaxVoices([]);
    setVoiceError(null);
    setVoiceSearch("");
    setVoicesLoading(enabledProviders.find((provider) => provider.id === next)?.kind === "minimax");
    // A newly selected provider should start with its own compatible defaults.
    const nextPreset = presetFor(enabledProviders.find((provider) => provider.id === next)?.kind);
    setModelId(nextPreset?.models[0] ?? "");
    setVoiceId(nextPreset?.voices[0]?.id ?? "");
  }

  async function persist(): Promise<boolean> {
    const settings: TtsSettings = {
      providerId,
      modelId: modelId.trim(),
      voiceId: voiceId.trim(),
      speed,
    };
    const saved = await saveTtsSettings(settings);
    setProviderId(saved.providerId ?? null);
    setModelId(saved.modelId ?? "");
    setVoiceId(saved.voiceId ?? "");
    setSpeed(saved.speed || 1);
    return true;
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await persist();
      setFeedback("朗读语音已保存。现在可以在对话回答下点击朗读按钮。");
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (previewing) {
      stopSpeech();
      return;
    }
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await persist();
      void toggleSpeech(PREVIEW_ID, PREVIEW_TEXT);
    } catch (saveError) {
      setError(String(saveError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <RiChatVoiceAiLine color={accent.accentText} size={18} />
        </View>
        <View style={styles.heading}>
          <Text style={styles.title}>朗读语音</Text>
          <Text style={styles.description}>
            选择任意支持语音合成的服务商（MiniMax、阶跃星辰 StepFun、OpenAI
            等），即可在对话回答下点击朗读按钮听取内容。
          </Text>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>语音服务商</Text>
        <View style={styles.selectWrap}>
          <select
            aria-label="语音服务商"
            disabled={!loaded || busy}
            onChange={(event) => onProviderChange(event.target.value)}
            style={selectStyle(theme)}
            value={providerId ?? DEFAULT_PROVIDER_VALUE}
          >
            <option value={DEFAULT_PROVIDER_VALUE}>未选择</option>
            {unavailableSelection ? (
              <option value={providerId ?? ""}>{`已不可用：${providerId}`}</option>
            ) : null}
            {enabledProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <Text style={styles.selectChevron}>⌄</Text>
        </View>
        <Text style={styles.hint}>
          需先在「AI 服务商」里添加该服务商并填写 API 密钥。MiniMax 走其 t2a_v2
          语音接口，其余服务商（StepFun、OpenAI、MoleAPI 等）走 OpenAI 兼容的 /audio/speech
          接口。列表里没有现成建议的服务商也可手动填写其语音模型与音色。
        </Text>
      </View>

      <View style={styles.row}>
        <View style={[styles.field, { flex: 1 } as ViewStyle]}>
          <Text style={styles.label}>语音模型</Text>
          {isMinimax ? (
            <>
              <select
                aria-label="语音模型"
                disabled={!loaded || busy}
                onChange={(event) => {
                  setModelId(event.target.value === CUSTOM_OPTION ? "" : event.target.value);
                  setFeedback(null);
                }}
                style={selectStyle(theme)}
                value={modelList.includes(modelId) ? modelId : CUSTOM_OPTION}
              >
                {modelList.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                <option value={CUSTOM_OPTION}>手动填写模型 ID…</option>
              </select>
              {!modelList.includes(modelId) ? (
                <input
                  aria-label="自定义语音模型 ID"
                  disabled={!loaded || busy}
                  onChange={(event) => setModelId(event.target.value)}
                  placeholder="输入模型 ID"
                  style={{ ...inputStyle(theme), marginTop: 6 }}
                  value={modelId}
                />
              ) : null}
            </>
          ) : (
            <>
              <input
                aria-label="语音模型"
                disabled={!loaded || busy}
                list="tts-model-suggestions"
                onChange={(event) => {
                  setModelId(event.target.value);
                  setFeedback(null);
                }}
                placeholder="例如 step-tts-mini"
                style={inputStyle(theme)}
                value={modelId}
              />
              <datalist id="tts-model-suggestions">
                {modelList.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </>
          )}
        </View>
        <View style={[styles.field, { flex: 1 } as ViewStyle]}>
          <Text style={styles.label}>音色</Text>
          {isMinimax ? (
            <>
              <input
                aria-label="搜索音色"
                disabled={!loaded || busy}
                onChange={(event) => setVoiceSearch(event.target.value)}
                placeholder="搜索名称、ID 或描述"
                style={inputStyle(theme)}
                value={voiceSearch}
              />
              <select
                aria-label="音色"
                disabled={!loaded || busy}
                onChange={(event) => {
                  setVoiceId(event.target.value === CUSTOM_OPTION ? "" : event.target.value);
                  setFeedback(null);
                }}
                style={{ ...selectStyle(theme), marginTop: 6 }}
                value={
                  matchingVoices.some((voice) => voice.id === voiceId) ? voiceId : CUSTOM_OPTION
                }
              >
                {(["system", "cloned", "generated"] as const).map((category) => {
                  const items = matchingVoices.filter((voice) => voice.category === category);
                  return items.length > 0 ? (
                    <optgroup
                      key={category}
                      label={
                        { system: "系统音色", cloned: "复刻音色", generated: "生成音色" }[category]
                      }
                    >
                      {items.map((voice) => (
                        <option key={voice.id} value={voice.id} title={voice.description}>
                          {voice.name === voice.id ? voice.id : `${voice.name} · ${voice.id}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
                <option value={CUSTOM_OPTION}>手动填写音色 ID…</option>
              </select>
              {!voiceList.some((voice) => voice.id === voiceId) ? (
                <input
                  aria-label="自定义音色 ID"
                  disabled={!loaded || busy}
                  onChange={(event) => {
                    setVoiceId(event.target.value);
                    setFeedback(null);
                  }}
                  placeholder="输入音色 ID"
                  style={{ ...inputStyle(theme), marginTop: 6 }}
                  value={voiceId}
                />
              ) : null}
              {voicesLoading ? <Text style={styles.hint}>正在获取账号音色…</Text> : null}
              {voiceError ? (
                <Text style={styles.hint}>
                  获取账号音色失败：{voiceError}。可使用下拉列表中的预置音色或手动输入 ID。{" "}
                  <a
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      setVoicesLoading(true);
                      setVoiceRefresh((value) => value + 1);
                    }}
                  >
                    重试
                  </a>
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <input
                aria-label="音色"
                disabled={!loaded || busy}
                list="tts-voice-suggestions"
                onChange={(event) => {
                  setVoiceId(event.target.value);
                  setFeedback(null);
                }}
                placeholder="例如 alloy"
                style={inputStyle(theme)}
                value={voiceId}
              />
              <datalist id="tts-voice-suggestions">
                {(preset?.voices ?? []).map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </datalist>
            </>
          )}
          {preset?.voiceHint ? <Text style={styles.hint}>{preset.voiceHint}</Text> : null}
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>语速</Text>
        <View style={[styles.selectWrap, { maxWidth: 160 } as ViewStyle]}>
          <select
            aria-label="语速"
            disabled={!loaded || busy}
            onChange={(event) => {
              setSpeed(Number(event.target.value));
              setFeedback(null);
            }}
            style={selectStyle(theme)}
            value={String(speed)}
          >
            {SPEED_OPTIONS.map((value) => (
              <option key={value} value={String(value)}>
                {value === 1 ? "正常（1.0x）" : `${value}x`}
              </option>
            ))}
          </select>
          <Text style={styles.selectChevron}>⌄</Text>
        </View>
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
          disabled={!canSave && !previewing}
          onPress={() => void preview()}
          style={({ hovered, pressed }: PressState) => [
            styles.button,
            styles.previewButton,
            motion,
            hovered && ({ backgroundColor: theme.t.controlHover } as ViewStyle),
            pressed && ({ opacity: 0.75 } as ViewStyle),
            !canSave && !previewing && styles.disabled,
          ]}
        >
          {previewing ? (
            <RiStopFill color={accent.accentText} size={14} />
          ) : (
            <RiVolumeUpLine color={accent.accentText} size={14} />
          )}
          <Text style={styles.previewText}>{previewing ? "停止" : "试听"}</Text>
        </Pressable>
        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
