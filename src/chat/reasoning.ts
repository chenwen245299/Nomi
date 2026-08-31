// Reasoning-effort tiers differ per provider — DeepSeek exposes high/max, OpenAI
// minimal…high, everyone else low…high — so the composer shows the tiers of the
// *selected* model, and when a different model answers the same turn (an `@`
// multi-model variant) the chosen effort is mapped onto that model's own scale.

import type { Provider } from "../providers/api";

export type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "max";

export const THINKING_LABEL: Record<ThinkingEffort, string> = {
  off: "关闭",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

/**
 * The reasoning-effort tiers a model exposes, ascending. Empty when the model
 * has no reasoning capability (the composer then hides the thinking control).
 * Provider-specific because the scales genuinely differ.
 */
export function effortScaleFor(
  provider: Provider | undefined,
  modelId: string | null | undefined,
): ThinkingEffort[] {
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  if (!model?.capabilities.includes("reasoning")) return [];
  if (provider?.kind === "deepseek") return ["high", "max"];
  if (provider?.kind === "openai" || /(?:^|[-_])(gpt|o\d)/i.test(model.id)) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["low", "medium", "high"];
}

// A canonical intensity for each named tier, so an effort picked on one
// provider's scale maps to the *nearest* tier on another's — e.g. DeepSeek `max`
// → any provider's top tier, `high` → a comparable `high` elsewhere.
const EFFORT_INTENSITY: Record<ThinkingEffort, number> = {
  off: 0,
  minimal: 0.15,
  low: 0.35,
  medium: 0.55,
  high: 0.8,
  max: 1.0,
};

/**
 * Map an effort onto a target model's scale by nearest intensity. Returns "off"
 * when thinking is off or the target model has no reasoning tiers (so a
 * non-reasoning model in an `@` group simply answers without thinking).
 */
export function mapEffort(effort: ThinkingEffort, toScale: ThinkingEffort[]): ThinkingEffort {
  if (effort === "off" || toScale.length === 0) return "off";
  const want = EFFORT_INTENSITY[effort];
  let best = toScale[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const tier of toScale) {
    const dist = Math.abs(EFFORT_INTENSITY[tier] - want);
    if (dist < bestDist) {
      bestDist = dist;
      best = tier;
    }
  }
  return best;
}
