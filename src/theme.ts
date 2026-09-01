import { createContext, useContext } from "react";
import { StyleSheet } from "react-native";
import type { ViewStyle } from "react-native";

// ── Nomi design system (light only) ─────────────────────────────────────────
// "Tahoe Liquid Glass, tastefully disciplined". Chrome & overlays are glass
// (translucent, blurred, specular-edged); content cards are opaque paper so text
// always reads at AA. The active feature accent tints only chrome/controls — a
// low-alpha wash on the collection column, a short header underline, the rail
// selection and the brand mark — never body text or card fills. Settings calms
// down to graphite. On Windows / no-blur, glass degrades to solid-ish fills via
// a per-surface alpha table while borders + shadows keep the depth intact.
//
// Nomi ships light-mode only — there is no dark palette.

export type FeatureId = "chat" | "notes" | "papers" | "todo" | "travel" | "finance";
export type SectionId = FeatureId | "settings";

/** Shared shell header height so the rail, collection and content dividers align. */
export const SHELL_HEADER_HEIGHT = 48;
/** Compact inset shared by collection headers, search controls and list content. */
export const COLLECTION_GUTTER = 10;

// ── Capability + platform (resolved once at module load) ────────────────────
export const supportsGlass =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  (CSS.supports("backdrop-filter", "blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px)"));

export const isWindows =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

// Treat Windows as a hard opaque path even if it reports blur support: WebView2
// backdrop blur is weak and expensive.
export const useSolid = !supportsGlass || isWindows;

export const reduceMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── Tokens ──────────────────────────────────────────────────────────────────
export interface Tokens {
  windowBase: string;
  washA: string;
  washB: string;
  railMaterial: string;
  collectionMaterial: string;
  mainSurface: string;
  cardSurface: string;
  cardSurfaceAlt: string;
  overlaySurface: string;
  scrim: string;
  railSolid: string;
  collectionSolid: string;
  mainSolid: string;
  overlaySolid: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  onAccent: string;
  separator: string;
  separatorStrong: string;
  rowDivider: string;
  edgeHighlight: string;
  edgeHighlightSoft: string;
  controlIdle: string;
  controlHover: string;
  controlPressed: string;
  controlBorder: string;
  searchFill: string;
  statusGreenFill: string;
  statusGreenBorder: string;
  statusGreenText: string;
  errorText: string;
  progressTrack: string;
  scrollThumb: string;
  selection: string;
  chromeSpecular: string;
  e1: string;
  e1Solid: string;
  e2: string;
  e3: string;
  e3Solid: string;
}

const LIGHT: Tokens = {
  windowBase: "#ECEFF3",
  washA: "rgba(120,172,216,0.18)",
  washB: "rgba(150,200,190,0.14)",
  railMaterial: "rgba(238,242,247,0.62)",
  collectionMaterial: "rgba(247,249,252,0.80)",
  mainSurface: "rgba(253,254,255,0.94)",
  cardSurface: "#FFFFFF",
  cardSurfaceAlt: "#F4F6F8",
  overlaySurface: "rgba(252,253,255,0.86)",
  scrim: "rgba(28,36,48,0.30)",
  railSolid: "rgba(236,240,245,0.97)",
  collectionSolid: "rgba(246,248,251,0.99)",
  mainSolid: "#FBFCFD",
  overlaySolid: "rgba(250,251,253,0.99)",
  textPrimary: "#1B2430",
  textSecondary: "#5C6673",
  textTertiary: "#98A0AC",
  onAccent: "#FFFFFF",
  separator: "rgba(60,70,85,0.10)",
  separatorStrong: "rgba(60,70,85,0.16)",
  rowDivider: "rgba(60,70,85,0.07)",
  edgeHighlight: "rgba(255,255,255,0.70)",
  edgeHighlightSoft: "rgba(255,255,255,0.45)",
  controlIdle: "rgba(118,130,148,0.08)",
  controlHover: "rgba(118,130,148,0.14)",
  controlPressed: "rgba(118,130,148,0.20)",
  controlBorder: "rgba(60,70,85,0.10)",
  searchFill: "rgba(118,130,148,0.10)",
  statusGreenFill: "rgba(48,142,120,0.12)",
  statusGreenBorder: "rgba(48,142,120,0.24)",
  statusGreenText: "#2A7A66",
  errorText: "#B24D4D",
  progressTrack: "rgba(60,70,85,0.12)",
  scrollThumb: "rgba(60,70,85,0.24)",
  selection: "rgba(47,123,230,0.20)",
  chromeSpecular: "inset 1px 1px 0 rgba(255,255,255,0.55)",
  e1: "inset 0 1px 0 rgba(255,255,255,0.85), 0 1px 2px rgba(20,28,40,0.05), 0 8px 22px rgba(20,28,40,0.06)",
  e1Solid:
    "inset 0 1px 0 rgba(255,255,255,0.85), 0 1px 2px rgba(20,28,40,0.05), 0 8px 15px rgba(20,28,40,0.06)",
  e2: "inset 0 1px 0 rgba(255,255,255,0.90), 0 4px 10px rgba(20,28,40,0.08), 0 12px 28px rgba(20,28,40,0.12)",
  e3: "inset 0 1px 0 rgba(255,255,255,0.90), 0 12px 30px rgba(16,24,36,0.16), 0 32px 64px rgba(16,24,36,0.22)",
  e3Solid:
    "inset 0 1px 0 rgba(255,255,255,0.90), 0 12px 30px rgba(16,24,36,0.16), 0 32px 45px rgba(16,24,36,0.22)",
};

// ── Per-feature accents ─────────────────────────────────────────────────────
export interface Accent {
  accent: string; // fills: primary/create button, brand mark, progress bar, CTA
  accentText: string; // accent as icon/text on neutral bg (deepened for AA)
  selectedFill: string; // nav-active / menu-active bg
  iconBadge: string; // soft square behind feature/empty-state icons
  wash: string; // the low-alpha collection-column tint
  rgb: string; // triplet for composing rings / glows
}

const ACCENTS: Record<SectionId, Accent> = {
  chat: {
    accent: "#2F7BE6",
    accentText: "#1E63C4",
    selectedFill: "rgba(47,123,230,0.14)",
    iconBadge: "rgba(47,123,230,0.12)",
    wash: "rgba(47,123,230,0.07)",
    rgb: "47,123,230",
  },
  notes: {
    accent: "#E0952B",
    accentText: "#A9691C",
    selectedFill: "rgba(224,149,43,0.15)",
    iconBadge: "rgba(224,149,43,0.13)",
    wash: "rgba(224,149,43,0.07)",
    rgb: "224,149,43",
  },
  papers: {
    accent: "#4C5FB0",
    accentText: "#3A4A90",
    selectedFill: "rgba(76,95,176,0.14)",
    iconBadge: "rgba(76,95,176,0.12)",
    wash: "rgba(76,95,176,0.07)",
    rgb: "76,95,176",
  },
  todo: {
    accent: "#7059D6",
    accentText: "#54409F",
    selectedFill: "rgba(112,89,214,0.14)",
    iconBadge: "rgba(112,89,214,0.12)",
    wash: "rgba(112,89,214,0.07)",
    rgb: "112,89,214",
  },
  travel: {
    accent: "#1FA089",
    accentText: "#157A68",
    selectedFill: "rgba(31,160,137,0.15)",
    iconBadge: "rgba(31,160,137,0.13)",
    wash: "rgba(31,160,137,0.07)",
    rgb: "31,160,137",
  },
  finance: {
    accent: "#C2507A",
    accentText: "#9E3F62",
    selectedFill: "rgba(194,80,122,0.14)",
    iconBadge: "rgba(194,80,122,0.12)",
    wash: "rgba(194,80,122,0.07)",
    rgb: "194,80,122",
  },
  settings: {
    accent: "#5E6672",
    accentText: "#4A515C",
    selectedFill: "rgba(94,102,114,0.12)",
    iconBadge: "rgba(94,102,114,0.10)",
    wash: "rgba(94,102,114,0.05)",
    rgb: "94,102,114",
  },
};

export function accentFor(section: SectionId): Accent {
  return ACCENTS[section];
}

// ── Resolved theme + context ────────────────────────────────────────────────
export interface Theme {
  t: Tokens;
  useSolid: boolean;
  reduceMotion: boolean;
}

export function resolveTheme(): Theme {
  return { t: LIGHT, useSolid, reduceMotion };
}

export const ThemeContext = createContext<Theme>(resolveTheme());

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

// ── Style helpers ───────────────────────────────────────────────────────────
// Web-only props (backdropFilter / transition / animation) are passed as raw
// inline objects and cast to ViewStyle — RN-Web 0.21 forwards them to the DOM.

/** Glass blur/saturate, or {} on the solid path. */
export function glass(blur: number, sat = 160): ViewStyle {
  if (useSolid) {
    return {} as ViewStyle;
  }
  return {
    backdropFilter: `blur(${blur}px) saturate(${sat}%)`,
    WebkitBackdropFilter: `blur(${blur}px) saturate(${sat}%)`,
  } as unknown as ViewStyle;
}

const MOTION_FULL = {
  transitionProperty: "background-color, border-color, transform, box-shadow, opacity",
  transitionDuration: "150ms",
  transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
} as unknown as ViewStyle;

/** Smooth transitions for interactive/tinted surfaces (disabled if reduced-motion). */
export const motion: ViewStyle = reduceMotion ? ({} as ViewStyle) : MOTION_FULL;

/** Longer cross-fade for section-switch tints (wash, underline, brand mark). */
export const motionSlow: ViewStyle = reduceMotion
  ? ({} as ViewStyle)
  : ({
      transitionProperty: "background-color, box-shadow, opacity",
      transitionDuration: "260ms",
      transitionTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
    } as unknown as ViewStyle);

// Keyframe animations MUST be registered via StyleSheet.create — react-native-web's
// inline-style compiler drops `animationKeyframes` (only the atomic compiler behind
// StyleSheet.create emits the @keyframes rules).
const ANIM = StyleSheet.create({
  enterUp: {
    animationKeyframes: {
      "0%": { opacity: 0, transform: [{ translateY: 6 }] },
      "100%": { opacity: 1, transform: [{ translateY: 0 }] },
    },
    animationDuration: "220ms",
    animationTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
  } as unknown as ViewStyle,
  enterModal: {
    animationKeyframes: {
      "0%": { opacity: 0, transform: [{ scale: 0.96 }, { translateY: 8 }] },
      "100%": { opacity: 1, transform: [{ scale: 1 }, { translateY: 0 }] },
    },
    animationDuration: "240ms",
    animationTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
  } as unknown as ViewStyle,
  enterFade: {
    animationKeyframes: {
      "0%": { opacity: 0 },
      "100%": { opacity: 1 },
    },
    animationDuration: "160ms",
    animationTimingFunction: "ease",
  } as unknown as ViewStyle,
  enterRight: {
    animationKeyframes: {
      "0%": { opacity: 0, transform: [{ translateX: 28 }] },
      "100%": { opacity: 1, transform: [{ translateX: 0 }] },
    },
    animationDuration: "240ms",
    animationTimingFunction: "cubic-bezier(0.32,0.72,0,1)",
  } as unknown as ViewStyle,
  shimmer: {
    animationKeyframes: {
      "0%": { transform: [{ translateX: -48 }] },
      "100%": { transform: [{ translateX: 360 }] },
    },
    animationDuration: "1400ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  } as unknown as ViewStyle,
});

/** Entrance keyframe for main content on section switch (key the node by section). */
export function enterUp(): ViewStyle | undefined {
  return reduceMotion ? undefined : ANIM.enterUp;
}

/** Entrance keyframe for modal / overlay cards. */
export function enterModal(): ViewStyle | undefined {
  return reduceMotion ? undefined : ANIM.enterModal;
}

/** Backdrop fade for scrims. */
export function enterFade(): ViewStyle | undefined {
  return reduceMotion ? undefined : ANIM.enterFade;
}

/** Slide-in-from-right entrance for right-edge drawers. */
export function enterRight(): ViewStyle | undefined {
  return reduceMotion ? undefined : ANIM.enterRight;
}

/** Looping specular sweep for the download progress bar. */
export const shimmerStyle: ViewStyle = ANIM.shimmer;

/** Append an accent-tinted glow term to an elevation shadow string. */
export function withGlow(base: string, accent: Accent): string {
  return `${base}, 0 6px 16px rgba(${accent.rgb},0.28)`;
}

/** A soft accent glow for icon badges (lighter than the button glow). */
export function badgeGlow(accent: Accent): string {
  return `inset 0 1px 0 rgba(255,255,255,0.80), 0 6px 16px rgba(${accent.rgb},0.14)`;
}

/** Resting-card elevation, respecting the solid path. */
export function cardShadow(t: Tokens): string {
  return useSolid ? t.e1Solid : t.e1;
}

/** Modal / overlay elevation, respecting the solid path. */
export function modalShadow(t: Tokens): string {
  return useSolid ? t.e3Solid : t.e3;
}

/** Focus-ring color for the current accent. */
export function focusRing(accent: Accent): string {
  return `rgba(${accent.rgb},0.45)`;
}
