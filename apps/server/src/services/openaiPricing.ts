export interface OpenAIUsageTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface OpenAIModelPricing {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export type OpenAIModelPricingTable = Record<string, OpenAIModelPricing>;

export interface OpenAICostEstimate {
  estimatedCostUsd: number | null;
  pricingStatus: "priced" | "unpriced";
}

const DEFAULT_PRICING: OpenAIModelPricingTable = {
  "gpt-4.1-mini": {
    inputUsdPerMillion: 0.8,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 3.2
  },
  "gpt-4.1-mini-2025-04-14": {
    inputUsdPerMillion: 0.8,
    cachedInputUsdPerMillion: 0.2,
    outputUsdPerMillion: 3.2
  },
  "gpt-4.1": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.75,
    outputUsdPerMillion: 12
  },
  "gpt-4.1-2025-04-14": {
    inputUsdPerMillion: 3,
    cachedInputUsdPerMillion: 0.75,
    outputUsdPerMillion: 12
  },
  "gpt-4.1-nano": {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.05,
    outputUsdPerMillion: 0.8
  },
  "gpt-4.1-nano-2025-04-14": {
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.05,
    outputUsdPerMillion: 0.8
  }
};

export function buildOpenAIModelPricingTable(overridesJson?: string): OpenAIModelPricingTable {
  if (!overridesJson) return DEFAULT_PRICING;

  try {
    const parsed = JSON.parse(overridesJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_PRICING;
    const overrides: OpenAIModelPricingTable = {};
    for (const [model, value] of Object.entries(parsed)) {
      const rate = parsePricingRate(value);
      if (rate) overrides[model] = rate;
    }
    return { ...DEFAULT_PRICING, ...overrides };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function estimateOpenAICost(
  table: OpenAIModelPricingTable,
  model: string,
  usage: OpenAIUsageTokens
): OpenAICostEstimate {
  const pricing = table[model];
  if (!pricing) return { estimatedCostUsd: null, pricingStatus: "unpriced" };

  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const estimatedCostUsd =
    (uncachedInputTokens * pricing.inputUsdPerMillion +
      usage.cachedInputTokens * pricing.cachedInputUsdPerMillion +
      usage.outputTokens * pricing.outputUsdPerMillion) /
    1_000_000;

  return { estimatedCostUsd, pricingStatus: "priced" };
}

function parsePricingRate(value: unknown): OpenAIModelPricing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rate = value as Partial<Record<keyof OpenAIModelPricing, unknown>>;
  const inputUsdPerMillion = numberValue(rate.inputUsdPerMillion);
  const cachedInputUsdPerMillion = numberValue(rate.cachedInputUsdPerMillion);
  const outputUsdPerMillion = numberValue(rate.outputUsdPerMillion);
  if (inputUsdPerMillion === null || cachedInputUsdPerMillion === null || outputUsdPerMillion === null) {
    return null;
  }
  return { inputUsdPerMillion, cachedInputUsdPerMillion, outputUsdPerMillion };
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}
