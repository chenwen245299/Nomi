export const ASSISTANT_EMOJIS = [
  "😀",
  "😄",
  "😊",
  "🥰",
  "😎",
  "🤓",
  "🤔",
  "🫡",
  "✨",
  "🌟",
  "💫",
  "🔥",
  "🌈",
  "🌙",
  "☀️",
  "⚡",
  "🧠",
  "🪄",
  "💡",
  "🎯",
  "🚀",
  "🔭",
  "🧭",
  "📝",
  "🎨",
  "🎵",
  "📚",
  "💻",
  "🧩",
  "🛠️",
  "⚙️",
  "🔑",
  "🦊",
  "🐼",
  "🦉",
  "🐳",
  "🐱",
  "🐶",
  "🐰",
  "🐯",
  "🌿",
  "🌱",
  "🌸",
  "🍀",
  "🌊",
  "🏔️",
  "☁️",
  "❄️",
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🤍",
  "🖤",
  "👍",
  "🙌",
  "👏",
  "💪",
  "🤝",
  "🫶",
  "✅",
  "🏆",
] as const;

/** Pick once for newly-created assistants. Persistence keeps it stable. */
export function randomAssistantEmoji(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return ASSISTANT_EMOJIS[value[0] % ASSISTANT_EMOJIS.length];
  }
  return ASSISTANT_EMOJIS[Math.floor(Math.random() * ASSISTANT_EMOJIS.length)];
}

/** Stable safety fallback for legacy assistant files whose emoji is empty. */
export function assistantEmoji(value: string | null | undefined, id: string): string {
  const configured = value?.trim();
  if (configured) return configured;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ASSISTANT_EMOJIS[hash % ASSISTANT_EMOJIS.length];
}
