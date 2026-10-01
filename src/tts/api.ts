import { invoke } from "@tauri-apps/api/core";

// ── Read-aloud (朗读) voice-model config + synthesis ──────────────────────────
// A single global voice model is configured in 设置 → 对话; synthesis resolves it
// through the backend so the provider key never reaches the webview. In plain
// `pnpm dev` (no Rust backend) an in-memory stand-in keeps the settings UI
// interactive, while synthesis simply reports that it needs the app.

/** The sentinel the backend returns when no voice model is configured yet. */
export const TTS_NOT_CONFIGURED = "TTS_NOT_CONFIGURED";

export interface TtsSettings {
  providerId: string | null;
  modelId: string | null;
  voiceId: string;
  /** Playback/synthesis rate, 0.5–2.0. */
  speed: number;
}

/** Base64-encoded audio returned by a synthesis call, ready for an `Audio` src. */
export interface TtsAudio {
  mime: string;
  base64: string;
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let previewSettings: TtsSettings = {
  providerId: null,
  modelId: null,
  voiceId: "",
  speed: 1,
};

export async function getTtsSettings(): Promise<TtsSettings> {
  if (isTauri()) {
    return invoke<TtsSettings>("tts_get_settings");
  }
  return { ...previewSettings };
}

export async function saveTtsSettings(settings: TtsSettings): Promise<TtsSettings> {
  if (isTauri()) {
    return invoke<TtsSettings>("tts_set_settings", {
      providerId: settings.providerId ?? null,
      modelId: settings.modelId ?? null,
      voiceId: settings.voiceId,
      speed: settings.speed,
    });
  }
  previewSettings = { ...settings };
  return { ...previewSettings };
}

export async function synthesizeSpeech(text: string): Promise<TtsAudio> {
  if (isTauri()) {
    return invoke<TtsAudio>("tts_synthesize", { text });
  }
  throw new Error("预览模式无法朗读，请在应用中使用。");
}

/** Whether an error thrown by {@link synthesizeSpeech} means "not configured". */
export function isNotConfigured(error: unknown): boolean {
  return String((error as { message?: string })?.message ?? error).includes(TTS_NOT_CONFIGURED);
}
