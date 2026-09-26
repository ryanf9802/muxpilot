export interface TurnFailureEvent {
  failureCode: "turn_failed";
  providerErrorCode: string | null;
  failureReason: string;
}

export function turnFailureEventFromPayload(payload: unknown): TurnFailureEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const failure = (payload as Record<string, unknown>).turnFailure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const event = failure as Record<string, unknown>;
  if (event.failureCode !== "turn_failed" || typeof event.failureReason !== "string" || !event.failureReason.trim()) return null;
  if (event.providerErrorCode !== null && event.providerErrorCode !== undefined && typeof event.providerErrorCode !== "string") return null;
  return {
    failureCode: "turn_failed",
    providerErrorCode: typeof event.providerErrorCode === "string" ? event.providerErrorCode : null,
    failureReason: event.failureReason
  };
}

export function turnFailureEventLabel(event: TurnFailureEvent): string {
  return event.providerErrorCode === "usageLimitExceeded"
    ? "Session stopped — usage limit reached"
    : "Codex turn failed";
}
