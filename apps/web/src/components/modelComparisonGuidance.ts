export type ComparisonLevel = 1 | 2 | 3 | 4 | 5;

export interface ModelCombinationGuidance {
  quality: ComparisonLevel;
  usage: ComparisonLevel;
  qualityLabel: string;
  usageLabel: string;
  summary: string;
  sourceUrl: string;
  reviewedAt: string;
}

export interface PublishedModelGuidance {
  allowance: string;
  credits: string;
}

export const comparisonGuidanceSource = {
  url: "https://learn.chatgpt.com/docs/pricing",
  reviewedAt: "2026-09-09"
} as const;

function guidance(
  quality: ComparisonLevel,
  usage: ComparisonLevel,
  qualityLabel: string,
  usageLabel: string,
  summary: string
): ModelCombinationGuidance {
  return {
    quality,
    usage,
    qualityLabel,
    usageLabel,
    summary,
    sourceUrl: comparisonGuidanceSource.url,
    reviewedAt: comparisonGuidanceSource.reviewedAt
  };
}

export const modelCombinationGuidance: Readonly<Record<string, Readonly<Record<string, ModelCombinationGuidance>>>> = {
  "gpt-6-astra": {
    low: guidance(4, 4, "Very high", "High", "Strong coding judgment with the lightest Astra reasoning setting."),
    medium: guidance(5, 5, "Exceptional", "Very high", "Flagship capability with more room for analysis and tool use."),
    high: guidance(5, 5, "Exceptional", "Very high", "Deep flagship reasoning for difficult, ambiguous engineering work."),
    xhigh: guidance(5, 5, "Exceptional", "Very high", "Extended analysis for the hardest sustained coding work."),
    max: guidance(5, 5, "Exceptional", "Very high", "Maximum supported Astra reasoning depth."),
    ultra: guidance(5, 5, "Exceptional", "Very high", "Maximum supported Astra reasoning depth.")
  },
  "gpt-5.6-sol": {
    low: guidance(4, 3, "Very high", "Moderate", "High-end coding capability with restrained reasoning."),
    medium: guidance(4, 3, "Very high", "Moderate", "A strong default for complex implementation and debugging."),
    high: guidance(5, 4, "Exceptional", "High", "Deeper reasoning for ambiguous or high-stakes engineering work."),
    xhigh: guidance(5, 5, "Exceptional", "Very high", "Extended reasoning for difficult, long-horizon work."),
    max: guidance(5, 5, "Exceptional", "Very high", "Maximum supported Sol reasoning depth."),
    ultra: guidance(5, 5, "Exceptional", "Very high", "Maximum supported Sol reasoning depth.")
  },
  "gpt-5.6-terra": {
    low: guidance(3, 2, "High", "Low", "Efficient production coding for focused, well-defined tasks."),
    medium: guidance(4, 2, "Very high", "Low", "Balanced capability and allowance use for everyday engineering."),
    high: guidance(4, 3, "Very high", "Moderate", "More analysis for complex implementation and review."),
    xhigh: guidance(4, 4, "Very high", "High", "Extended Terra reasoning when a task needs more depth."),
    max: guidance(5, 4, "Exceptional", "High", "Maximum supported Terra reasoning depth."),
    ultra: guidance(5, 5, "Exceptional", "Very high", "Maximum supported Terra reasoning depth.")
  },
  "gpt-5.6-luna": {
    low: guidance(2, 1, "Moderate", "Very low", "Fast, economical help for narrow and routine coding tasks."),
    medium: guidance(3, 1, "High", "Very low", "More careful work while retaining Luna's allowance advantage."),
    high: guidance(3, 2, "High", "Low", "Additional reasoning for focused tasks that need extra care."),
    xhigh: guidance(4, 2, "Very high", "Low", "The deepest practical Luna setting for involved work."),
    max: guidance(4, 3, "Very high", "Moderate", "Maximum supported Luna reasoning depth."),
    ultra: guidance(4, 3, "Very high", "Moderate", "Maximum supported Luna reasoning depth.")
  },
  "gpt-5.5": {
    low: guidance(3, 4, "High", "High", "Capable coding with restrained reasoning on a higher-consumption model."),
    medium: guidance(4, 4, "Very high", "High", "Strong general coding quality with substantial allowance use."),
    high: guidance(4, 5, "Very high", "Very high", "Deeper analysis with very high expected allowance use."),
    xhigh: guidance(5, 5, "Exceptional", "Very high", "Maximum supported GPT-5.5 reasoning depth.")
  }
};

export const publishedModelGuidance: Readonly<Record<string, PublishedModelGuidance>> = {
  "gpt-6-astra": { allowance: "5–45 local messages per 5 hours on Plus", credits: "250 input / 25 cached / 1,250 output credits per 1M tokens" },
  "gpt-5.6-sol": { allowance: "10–100 local messages per 5 hours on Plus", credits: "100 input / 10 cached / 500 output credits per 1M tokens" },
  "gpt-5.6-terra": { allowance: "25–200 local messages per 5 hours on Plus", credits: "50 input / 5 cached / 300 output credits per 1M tokens" },
  "gpt-5.6-luna": { allowance: "250–2,000 local messages per 5 hours on Plus", credits: "5 input / 0.5 cached / 30 output credits per 1M tokens" },
  "gpt-5.5": { allowance: "No local-message range published on the referenced page", credits: "125 input / 12.5 cached / 750 output credits per 1M tokens" }
};

export function comparisonGuidance(model: string, effort: string | null): ModelCombinationGuidance | null {
  return modelCombinationGuidance[model]?.[effort ?? "none"] ?? null;
}
