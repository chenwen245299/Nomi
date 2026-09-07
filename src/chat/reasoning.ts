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

/** GLM-5.3 and GLM-5.3-Flash reject requests that disable thinking. */
export function thinkingCanBeDisabled(
  provider: Provider | undefined,
  modelId: string | null | undefined,
): boolean {
  const id = modelId?.trim() ?? "";
  if (provider?.kind === "zhipu" && /^glm-5\.3(?:-flash)?$/i.test(id)) return false;
  // M3 exposes an explicit disabled mode; M2.x always thinks.
  if (provider?.kind === "minimax" && /^minimax-m2(?:\.|$)/i.test(id)) return false;
  return true;
}

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
  if (provider?.kind === "zhipu" && /^glm-5\.3(?:-flash)?$/i.test(model.id)) {
    return ["low", "high", "max"];
  }
  if (provider?.kind === "minimax") {
    // MiniMax exposes adaptive thinking as a switch, not intensity levels.
    return /^minimax-m2(?:\.|$)/i.test(model.id) ? ["max"] : ["high"];
  }
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
