import { invoke } from "@tauri-apps/api/core";

export interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[]; // "audio" | "video" | "image" | "tool" | "reasoning"
  category: string; // "text" | "vision" | "embedding" | "audio"
  size: string;
  starred: boolean;
  contextLength?: number | null;
  /** Prices are user-maintained CNY amounts per one million tokens. */
  inputPrice?: number | null;
  outputPrice?: number | null;
  cacheHitInputPrice?: number | null;
  /** Optional time-of-use prices. Base prices above are the off-peak prices. */
  peakPricingEnabled?: boolean;
  peakInputPrice?: number | null;
  peakOutputPrice?: number | null;
  peakCacheHitInputPrice?: number | null;
  /** Whole hours in China Standard Time; ranges may cross midnight. */
  peakStartHour?: number | null;
  peakEndHour?: number | null;
}

export type PricingPeriod = "peak" | "offPeak";

/** Resolve the configured time-of-use period in China Standard Time. */
export function currentPricingPeriod(
  model: ProviderModel | null | undefined,
  now = new Date(),
): PricingPeriod | null {
  if (!model?.peakPricingEnabled) return null;
  const start = model.peakStartHour;
  const end = model.peakEndHour;
  if (start == null || end == null || start === end) return null;
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Shanghai",
  }).format(now);
  const hour = Number.parseInt(formatted, 10);
  const peak = start < end ? hour >= start && hour < end : hour >= start || hour < end;
  return peak ? "peak" : "offPeak";
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  models: ProviderModel[];
  createdAt: number;
  updatedAt: number;
  hasKey: boolean;
  /** Whether this provider publishes an account balance (from the backend spec).
   * Drives the balance UI; absent in browser-preview mode. */
  supportsBalance?: boolean;
}

export interface DefaultModelRef {
  provider: Provider;
  model: ProviderModel;
}

export function findDefaultModel(providers: Provider[]): DefaultModelRef | null {
  for (const provider of providers) {
    const model = provider.models.find((item) => item.starred && isChatModel(item));
    if (model) return { provider, model };
  }
  return null;
}

export const PROVIDER_KINDS: { value: string; label: string }[] = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "qwen", label: "千问 / DashScope" },
  { value: "mimo", label: "小米 MiMo" },
  { value: "kimi", label: "Kimi / Moonshot" },
  { value: "ollama", label: "Ollama" },
  { value: "anthropic", label: "Anthropic Claude" },
  { value: "custom", label: "自定义" },
];

export const CAPABILITIES: { value: string; label: string }[] = [
  { value: "audio", label: "音频" },
  { value: "video", label: "视频" },
  { value: "image", label: "图像" },
  { value: "tool", label: "工具调用" },
  { value: "reasoning", label: "推理" },
];

/** Primary model modality, used to group the model lists. */
export const MODEL_CATEGORIES: { value: string; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "vision", label: "视觉" },
  { value: "embedding", label: "嵌入" },
  { value: "audio", label: "音频" },
];

export function kindLabel(kind: string): string {
  return PROVIDER_KINDS.find((item) => item.value === kind)?.label ?? "OpenAI 兼容";
}

export function categoryLabel(value: string): string {
  return MODEL_CATEGORIES.find((item) => item.value === value)?.label ?? "文本";
}

/** Coerce a possibly-empty/unknown category to a valid one ("text" default). */
export function normalizeCategory(value: string | undefined | null): string {
  return value && MODEL_CATEGORIES.some((item) => item.value === value) ? value : "text";
}

/** Whether a model can drive a conversation (text or vision, not embedding/audio). */
export function isChatModel(model: ProviderModel): boolean {
  const category = normalizeCategory(model.category);
  return category === "text" || category === "vision";
}

/**
 * Whether a model can read images. Mirrors the backend's gate in providers.rs:
 * the category keeps older catalogues working while the explicit capability lets
 * users correct a provider list that under-reports.
 */
export function supportsVision(model: ProviderModel): boolean {
  return (
    normalizeCategory(model.category) === "vision" ||
    model.capabilities.some((capability) => capability === "image" || capability === "vision")
  );
}

/** Best-guess a model's category from its id (for the fetched-model picker). */
export function inferModelCategory(id: string): string {
  const s = id.toLowerCase();
  if (/embed|bge|gte|e5|rerank/.test(s)) return "embedding";
  if (/whisper|tts|audio|voice|speech|transcrib|realtime|sensevoice|cosyvoice|sovits/.test(s)) {
    return "audio";
  }
  // Note: no bare "-v" version-suffix rule — it never matches "-v1/-v2" (word
  // boundary) yet false-positives ids ending in "-v", wrongly flagging vision.
  if (/vision|-vl|vl-|vl$|multimodal|omni|gpt-4o|pixtral|glm-4v|internvl/.test(s)) {
    return "vision";
  }
  return "text";
}

/**
 * Best-effort capability hints for fetched catalogues. Provider model APIs
 * usually return only an id, so every inferred flag remains editable by users.
 */
export function inferModelCapabilities(id: string): string[] {
  const s = id.toLowerCase();
  const capabilities: string[] = [];
  if (/whisper|tts|audio|voice|speech|transcrib|realtime|sensevoice|cosyvoice|sovits/.test(s)) {
    capabilities.push("audio");
  }
  if (/video|sora|veo|kling|cogvideo|hunyuanvideo|wan2(?:\.|-)/.test(s)) {
    capabilities.push("video");
  }
  if (/vision|-vl|vl-|vl$|multimodal|omni|gpt-4o|pixtral|glm-4v|internvl/.test(s)) {
    capabilities.push("image");
  }
  if (
    /reasoning|thinking|deepseek-r1|(?:^|[-_/])r1(?:$|[-_/])|qwq|(?:^|[-_/])o[134](?:$|[-_/])/.test(
      s,
    )
  ) {
    capabilities.push("reasoning");
  }
  return capabilities;
}

// Keyword → kind, so typing a name like "DeepSeek" at creation time selects the
// right kind (and, when it has a preset, pre-fills the base URL + models).
const KIND_KEYWORDS: [string, string][] = [
  ["deepseek", "deepseek"],
  ["openrouter", "openrouter"],
  ["qwen", "qwen"],
  ["千问", "qwen"],
  ["通义", "qwen"],
  ["dashscope", "qwen"],
  ["mimo", "mimo"],
  ["xiaomi", "mimo"],
  ["小米", "mimo"],
  ["kimi", "kimi"],
  ["moonshot", "kimi"],
  ["ollama", "ollama"],
  ["claude", "anthropic"],
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["gpt", "openai"],
];

/** Best-guess provider kind from a display name; defaults to "openai". */
export function inferProviderKind(name: string): string {
  const n = name.trim().toLowerCase();
  if (!n) return "openai";
  // The keyword that appears EARLIEST in the name wins (ties broken by list
  // order), so "OpenAI-compatible DeepSeek proxy" resolves to openai, not deepseek.
  let best: { pos: number; kind: string } | null = null;
  for (const [keyword, kind] of KIND_KEYWORDS) {
    const pos = n.indexOf(keyword);
    if (pos >= 0 && (best === null || pos < best.pos)) {
      best = { pos, kind };
    }
  }
  return best?.kind ?? "openai";
}

/** Defaults filled in when a known provider kind is chosen (base URL + models). */
export interface ProviderPreset {
  baseUrl: string;
  models: ProviderModel[];
}

// Model parameter sizes come straight from the vendor (no name-parsing): flash is
// 284B, pro is 1.6T. The vision model is flash-based (also 284B).
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        capabilities: ["tool", "reasoning"],
        category: "text",
        size: "284B",
        starred: true,
        contextLength: 1_000_000,
        inputPrice: 1,
        outputPrice: 2,
        cacheHitInputPrice: 0.02,
        peakPricingEnabled: false,
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        capabilities: ["tool", "reasoning"],
        category: "text",
        size: "1.6T",
        starred: false,
        contextLength: 1_000_000,
        inputPrice: 3,
        outputPrice: 6,
        cacheHitInputPrice: 0.025,
        peakPricingEnabled: false,
      },
      {
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek V4 Flash Vision",
        capabilities: ["image", "tool", "reasoning"],
        category: "vision",
        size: "284B",
        starred: false,
      },
    ],
  },
};

/** One extra currency an account holds (DeepSeek multi-currency). */
export interface CurrencyBalance {
  currency: string;
  remaining: number;
}

/**
 * Unified account balance across providers. `remaining` + `currency` are always
 * present; the rest are provider-specific and omitted when absent — DeepSeek
 * fills `granted` / `toppedUp` / `otherCurrencies`, OpenRouter fills
 * `totalCredits` / `totalUsage`.
 */
export interface ProviderBalance {
  remaining: number;
  currency: string;
  granted?: number;
  toppedUp?: number;
  totalCredits?: number;
  totalUsage?: number;
  isAvailable: boolean;
  otherCurrencies?: CurrencyBalance[];
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const nowSec = () => Math.floor(Date.now() / 1000);

// The backend derives `supportsBalance` from each provider kind's spec. In
// browser-preview mode there is no backend, so mirror the same set here (the
// only place the kinds are duplicated, and only for offline UI dev).
const PREVIEW_BALANCE_KINDS = new Set(["deepseek", "openrouter"]);
const previewSupportsBalance = (kind: string): boolean => PREVIEW_BALANCE_KINDS.has(kind);

// ── Browser-preview in-memory store (pnpm dev without the Rust backend). Keys are
// only tracked as a boolean here — real keys live in the OS keychain via Rust. ──
const preview: { providers: Provider[]; keys: Set<string>; seq: number } = {
  providers: [],
  keys: new Set(),
  seq: 1,
};

function normalizePreviewDefaults(target?: { providerId: string; modelId: string }): void {
  let kept = false;
  for (const provider of preview.providers) {
    for (const model of provider.models) {
      const shouldStar = target
        ? provider.id === target.providerId && model.id === target.modelId
        : model.starred && !kept;
      model.starred = shouldStar;
      if (shouldStar) kept = true;
    }
  }
}

export async function listProviders(): Promise<Provider[]> {
  if (isTauri()) {
    return invoke<Provider[]>("list_providers");
  }
  normalizePreviewDefaults();
  return preview.providers.map((p) => ({
    ...p,
    hasKey: preview.keys.has(p.id),
    supportsBalance: previewSupportsBalance(p.kind),
  }));
}

export async function createProvider(
  name: string,
  kind: string,
  baseUrl: string,
): Promise<Provider> {
  if (isTauri()) {
    return invoke<Provider>("create_provider", { name, kind, baseUrl });
  }
  const ts = nowSec();
  const provider: Provider = {
    id: `provider-${preview.seq++}`,
    name,
    kind,
    baseUrl,
    enabled: true,
    models: [],
    createdAt: ts,
    updatedAt: ts,
    hasKey: false,
    supportsBalance: previewSupportsBalance(kind),
  };
  preview.providers.push(provider);
  return provider;
}

export async function updateProvider(provider: Provider): Promise<Provider> {
  const { id, name, kind, baseUrl, enabled, models } = provider;
  if (isTauri()) {
    return invoke<Provider>("update_provider", { id, name, kind, baseUrl, enabled, models });
  }
  const existing = preview.providers.find((p) => p.id === id);
  if (existing) {
    Object.assign(existing, { name, kind, baseUrl, enabled, models, updatedAt: nowSec() });
    normalizePreviewDefaults();
    return {
      ...existing,
      hasKey: preview.keys.has(id),
      supportsBalance: previewSupportsBalance(kind),
    };
  }
  throw new Error("服务商不存在");
}

/** Atomically replace the one global default model. */
export async function setDefaultModel(providerId: string, modelId: string): Promise<Provider[]> {
  if (isTauri()) {
    return invoke<Provider[]>("set_default_model", { providerId, modelId });
  }
  const provider = preview.providers.find((item) => item.id === providerId);
  const model = provider?.models.find((item) => item.id === modelId);
  if (!provider || !model) throw new Error("模型不存在");
  if (!isChatModel(model)) throw new Error("只有文本或视觉模型可以设为全局默认模型");
  normalizePreviewDefaults({ providerId, modelId });
  return listProviders();
}

export async function setProviderEnabled(id: string, enabled: boolean): Promise<void> {
  if (isTauri()) {
    await invoke("set_provider_enabled", { id, enabled });
    return;
  }
  const existing = preview.providers.find((p) => p.id === id);
  if (existing) {
    existing.enabled = enabled;
  }
}

export async function deleteProvider(id: string): Promise<void> {
  if (isTauri()) {
    await invoke("delete_provider", { id });
    return;
  }
  preview.providers = preview.providers.filter((p) => p.id !== id);
  preview.keys.delete(id);
}

export async function setProviderKey(id: string, key: string): Promise<void> {
  if (isTauri()) {
    await invoke("set_provider_key", { id, key });
    return;
  }
  if (key.trim()) {
    preview.keys.add(id);
  } else {
    preview.keys.delete(id);
  }
}

export async function testProvider(id: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("test_provider", { id });
  }
  return "预览模式：未连接真实后端";
}

export async function fetchProviderModels(id: string): Promise<string[]> {
  if (isTauri()) {
    return invoke<string[]>("fetch_provider_models", { id });
  }
  return ["gpt-4o", "gpt-4o-mini"];
}

export async function providerBalance(id: string): Promise<ProviderBalance> {
  if (isTauri()) {
    return invoke<ProviderBalance>("provider_balance", { id });
  }
  return {
    remaining: 88.88,
    currency: "CNY",
    granted: 0,
    toppedUp: 88.88,
    isAvailable: true,
  };
}
