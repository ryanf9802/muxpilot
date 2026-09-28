export interface ProviderTurnFailure {
  failureCode: "turn_failed" | "turn_interrupted";
  providerErrorCode: string | null;
  failureReason: string;
}

export function providerTurnInterruption(value: unknown): ProviderTurnFailure | null {
  const turn = record(value);
  if (turn?.status !== "interrupted") return null;
  return {
    failureCode: "turn_interrupted",
    providerErrorCode: null,
    failureReason: "Muxpilot found that the agent marked this turn interrupted after reconnecting. The interruption cause could not be confirmed. Partial work may already exist; resume to inspect it and continue safely."
  };
}

export function providerTurnFailure(value: unknown): ProviderTurnFailure | null {
  const root = record(value);
  const turn = record(root?.turn);
  if (turn?.status !== "failed") return null;
  const error = record(turn.error);
  const providerErrorCode = nonemptyString(error?.codexErrorInfo) ?? nonemptyString(turn.codexErrorInfo);
  const message = nonemptyString(error?.message) ?? "The agent could not complete the turn.";
  return {
    failureCode: "turn_failed",
    providerErrorCode,
    failureReason: sanitizeProviderError(message)
  };
}

function sanitizeProviderError(value: string): string {
  return value
    .replace(/(?:sk-|sess-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .slice(0, 800) || "The agent could not complete the turn.";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
