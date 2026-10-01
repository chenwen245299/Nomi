import { useSyncExternalStore } from "react";
import { showToast } from "../toast";
import { isNotConfigured, synthesizeSpeech } from "./api";

// Global read-aloud playback. One <Audio> element plays at a time; components
// read `playingId` / `pendingId` to light up the message they triggered. State
// lives outside React so every 朗读 button shares it without prop threading.

export interface SpeechState {
  /** Message id whose audio is currently playing, if any. */
  playingId: string | null;
  /** Message id we're synthesising audio for (pre-playback), if any. */
  pendingId: string | null;
}

let state: SpeechState = { playingId: null, pendingId: null };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: Partial<SpeechState>): void {
  state = { ...state, ...next };
  emit();
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.onended = () => setState({ playingId: null });
    audio.onerror = () => {
      if (state.playingId) {
        setState({ playingId: null });
        showToast("无法播放语音。");
      }
    };
  }
  return audio;
}

function stopPlayback(): void {
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
}

export function stopSpeech(): void {
  stopPlayback();
  setState({ playingId: null, pendingId: null });
}

/**
 * Toggle read-aloud for one message. Clicking the message that's already
 * playing (or being fetched) stops it; otherwise any current playback is
 * replaced by this one.
 */
export async function toggleSpeech(id: string, text: string): Promise<void> {
  if (state.playingId === id || state.pendingId === id) {
    stopSpeech();
    return;
  }
  stopPlayback();
  const trimmed = text.trim();
  if (!trimmed) {
    setState({ playingId: null, pendingId: null });
    showToast("这条回答没有可朗读的文字。");
    return;
  }
  setState({ playingId: null, pendingId: id });
  try {
    const { mime, base64 } = await synthesizeSpeech(trimmed);
    // Another message may have been started while this one was synthesising.
    if (state.pendingId !== id) return;
    const player = ensureAudio();
    player.src = `data:${mime};base64,${base64}`;
    setState({ pendingId: null, playingId: id });
    await player.play();
  } catch (error) {
    if (state.pendingId === id || state.playingId === id) {
      setState({ playingId: null, pendingId: null });
    }
    if (isNotConfigured(error)) {
      showToast("还没有配置朗读语音模型。请到「设置 → 对话」里选择一个语音模型。");
    } else {
      showToast(String((error as { message?: string })?.message ?? error));
    }
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): SpeechState {
  return state;
}

export function useSpeechState(): SpeechState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
