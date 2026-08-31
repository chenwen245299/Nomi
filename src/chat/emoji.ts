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

/** Badge tint used behind an assistant name in the conversation list. */
export interface AssistantBadgeColor {
  background: string;
  dot: string;
  text: string;
}

/**
 * Palette of polished badge tints. Each entry pairs a low-opacity background
 * with a vivid dot and a darker, high-contrast text shade.
 */
const BADGE_COLORS = {
  blue: { background: "rgba(91,143,249,0.15)", dot: "#5B8FF9", text: "#356DC5" },
  amber: { background: "rgba(240,163,58,0.16)", dot: "#F0A33A", text: "#A86618" },
  green: { background: "rgba(85,190,120,0.15)", dot: "#55BE78", text: "#338650" },
  pink: { background: "rgba(240,93,158,0.14)", dot: "#F05D9E", text: "#B33E73" },
  purple: { background: "rgba(144,103,232,0.14)", dot: "#9067E8", text: "#6845B8" },
  teal: { background: "rgba(55,174,177,0.15)", dot: "#37AEB1", text: "#277E81" },
  yellow: { background: "rgba(224,178,28,0.16)", dot: "#E0B21C", text: "#8A6A0C" },
  red: { background: "rgba(240,85,64,0.14)", dot: "#F05540", text: "#B23A2A" },
  brown: { background: "rgba(176,128,82,0.16)", dot: "#B08052", text: "#7A5433" },
  gray: { background: "rgba(138,148,166,0.16)", dot: "#8A94A6", text: "#586173" },
} satisfies Record<string, AssistantBadgeColor>;

type BadgeColorKey = keyof typeof BADGE_COLORS;

/**
 * Which badge tint each emoji in {@link ASSISTANT_EMOJIS} visually pairs with —
 * e.g. 💡/⚡ read as yellow, 🍀/🌿 as green, 🦉/🐶 as brown. Faces default to
 * yellow (their dominant glyph color). Keys may include a U+FE0F variation
 * selector; lookup normalizes it away.
 */
const EMOJI_BADGE_COLOR: Record<string, BadgeColorKey> = {
  "😀": "yellow",
  "😄": "yellow",
  "😊": "yellow",
  "🥰": "pink",
  "😎": "yellow",
  "🤓": "yellow",
  "🤔": "yellow",
  "🫡": "yellow",
  "✨": "yellow",
  "🌟": "yellow",
  "💫": "yellow",
  "🔥": "red",
  "🌈": "purple",
  "🌙": "yellow",
  "☀️": "amber",
  "⚡": "yellow",
  "🧠": "pink",
  "🪄": "purple",
  "💡": "yellow",
  "🎯": "red",
  "🚀": "red",
  "🔭": "blue",
  "🧭": "teal",
  "📝": "amber",
  "🎨": "pink",
  "🎵": "blue",
  "📚": "amber",
  "💻": "gray",
  "🧩": "blue",
  "🛠️": "gray",
  "⚙️": "gray",
  "🔑": "amber",
  "🦊": "amber",
  "🐼": "gray",
  "🦉": "brown",
  "🐳": "blue",
  "🐱": "amber",
  "🐶": "brown",
  "🐰": "pink",
  "🐯": "amber",
  "🌿": "green",
  "🌱": "green",
  "🌸": "pink",
  "🍀": "green",
  "🌊": "blue",
  "🏔️": "blue",
  "☁️": "blue",
  "❄️": "blue",
  "❤️": "red",
  "🧡": "amber",
  "💛": "yellow",
  "💚": "green",
  "💙": "blue",
  "💜": "purple",
  "🤍": "gray",
  "🖤": "gray",
  "👍": "amber",
  "🙌": "amber",
  "👏": "amber",
  "💪": "amber",
  "🤝": "amber",
  "🫶": "pink",
  "✅": "green",
  "🏆": "amber",
};

const stripVariation = (emoji: string) => emoji.replace(/\uFE0F/g, "");

const EMOJI_BADGE_COLOR_NORMALIZED: Record<string, BadgeColorKey> = {};
for (const [emoji, key] of Object.entries(EMOJI_BADGE_COLOR)) {
  EMOJI_BADGE_COLOR_NORMALIZED[stripVariation(emoji)] = key;
}

const BADGE_COLOR_LIST = Object.values(BADGE_COLORS);

/**
 * Badge tint for an assistant, chosen to match its emoji's dominant color.
 * Unknown/custom emojis still get a *stable* color derived from the glyph
 * itself (falling back to `seed` only when no emoji is present), so the badge
 * always tracks the emoji rather than the assistant id.
 */
export function badgeForEmoji(emoji: string | null | undefined, seed = ""): AssistantBadgeColor {
  const normalized = stripVariation((emoji ?? "").trim());
  const mapped = EMOJI_BADGE_COLOR_NORMALIZED[normalized];
  if (mapped) return BADGE_COLORS[mapped];
  const basis = normalized || seed;
  let hash = 0;
  for (const char of basis) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BADGE_COLOR_LIST[hash % BADGE_COLOR_LIST.length];
}

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
