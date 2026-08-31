// Brand icons the user dropped into src/assets. Vite bundles them as URLs.
const providerModules = import.meta.glob("../assets/providers/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const modelModules = import.meta.glob("../assets/models/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function byBasename(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(modules)) {
    const base = path.split("/").pop()?.replace(/\.svg$/, "");
    if (base) {
      out[base.toLowerCase()] = url;
    }
  }
  return out;
}

const PROVIDER_ICONS = byBasename(providerModules);
const MODEL_ICONS = byBasename(modelModules);

// Argus-style brand resolution: match the provider/model name (or service kind /
// model id) against known brand keywords, in priority order.
const BRAND_RULES: { keys: string[]; icon: string }[] = [
  { keys: ["deepseek"], icon: "deepseek" },
  { keys: ["openrouter"], icon: "openrouter" },
  { keys: ["moonshot", "kimi"], icon: "kimi" },
  { keys: ["ollama"], icon: "ollama-color" },
  { keys: ["lmstudio", "lm studio"], icon: "lmstudio" },
  { keys: ["gemma"], icon: "gemma" },
  { keys: ["gemini"], icon: "gemini" },
  { keys: ["google"], icon: "gemini" },
  { keys: ["claude", "anthropic"], icon: "claude" },
  { keys: ["gpt", "openai", "o1-", "o3-", "o4-", "chatgpt"], icon: "openai" },
  { keys: ["qwen", "通义", "千问", "dashscope", "qwq"], icon: "qwen" },
  { keys: ["alibaba", "aliyun", "阿里"], icon: "alibaba" },
  { keys: ["mimo", "xiaomi", "小米"], icon: "xiaomimimo" },
  { keys: ["grok"], icon: "grok" },
  { keys: ["xai"], icon: "xai" },
  { keys: ["minimax"], icon: "minimax" },
  { keys: ["inclusionai", "ling-", "ring-"], icon: "inclusionai" },
  { keys: ["z-ai", "z.ai"], icon: "z-ai" },
  { keys: ["glm", "zhipu", "智谱", "chatglm"], icon: "zhipu" },
  { keys: ["ernie", "baidu", "文心", "百度"], icon: "baidu" },
  { keys: ["meituan", "longcat", "美团"], icon: "meituan" },
  { keys: ["nvidia", "nemotron"], icon: "nvidia" },
  { keys: ["doubao", "bytedance", "豆包", "字节", "seed"], icon: "bytedance" },
  { keys: ["hunyuan", "tencent", "混元", "腾讯"], icon: "tencent" },
  { keys: ["phi-", "microsoft", "wizardlm"], icon: "microsoft" },
  { keys: ["huggingface", "hugging face"], icon: "huggingface" },
  { keys: ["siliconflow", "硅基"], icon: "siliconflow" },
  { keys: ["kling", "可灵"], icon: "kling" },
  { keys: ["dots"], icon: "dots" },
  { keys: ["moleapi", "mole"], icon: "moleapi" },
];

// providers/ and models/ have slightly different file names for the same brand.
const ALIASES: Record<string, string> = { qwen: "qwenai", qwenai: "qwen" };

function pick(map: Record<string, string>, icon: string): string | null {
  const key = icon.toLowerCase();
  if (map[key]) {
    return map[key];
  }
  const alias = ALIASES[key];
  return alias && map[alias] ? map[alias] : null;
}

function matchIcon(text: string): string | null {
  const lower = text.toLowerCase();
  for (const rule of BRAND_RULES) {
    if (rule.keys.some((keyword) => lower.includes(keyword))) {
      return rule.icon;
    }
  }
  return null;
}

export function providerIconUrl(name: string, kind: string): string | null {
  const icon = matchIcon(`${name} ${kind}`);
  return icon ? pick(PROVIDER_ICONS, icon) : null;
}

export function modelIconUrl(id: string, name: string): string | null {
  const icon = matchIcon(`${id} ${name}`);
  return icon ? pick(MODEL_ICONS, icon) : null;
}
