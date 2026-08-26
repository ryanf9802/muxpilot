export const SESSION_WAIT_EVENT_TAG = "muxpilot_session_wait";
export const SESSION_WAIT_PAYLOAD_KEY = "agentSessionWait";

export interface SessionWaitEvent {
  version: 1;
  kind: "resume_requested" | "timeout";
  sessions: Array<Record<string, unknown>>;
}

export interface NormalizedSessionWaitEvent {
  event: SessionWaitEvent;
  rawText: string;
}

const EVENT_PATTERN = /^<muxpilot_session_wait>\s*([\s\S]*?)\s*<\/muxpilot_session_wait>$/;

export function serializeSessionWaitEvent(event: SessionWaitEvent): string {
  return `<${SESSION_WAIT_EVENT_TAG}>${JSON.stringify(event)}</${SESSION_WAIT_EVENT_TAG}>`;
}

export function normalizeSessionWaitEvent(text: string): NormalizedSessionWaitEvent | null {
  const cleaned = text.replace(/\r/g, "").trim();
  const match = cleaned.match(EVENT_PATTERN);
  if (!match?.[1]) return null;
  try {
    const event = parseEvent(JSON.parse(match[1]) as unknown);
    return event ? { event, rawText: cleaned } : null;
  } catch {
    return null;
  }
}

export function sessionWaitEventSummary(event: SessionWaitEvent): string {
  return event.kind === "timeout" ? "Agent session wait timed out" : "Agent session wait resumed";
}

export function sessionWaitEventFromPayload(payload: Record<string, unknown>): SessionWaitEvent | null {
  return parseEvent(payload[SESSION_WAIT_PAYLOAD_KEY]);
}

export function withSessionWaitEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedSessionWaitEvent
): Record<string, unknown> {
  return { ...payload, [SESSION_WAIT_PAYLOAD_KEY]: normalized.event };
}

function parseEvent(value: unknown): SessionWaitEvent | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.kind !== "resume_requested" && value.kind !== "timeout") return null;
  if (!Array.isArray(value.sessions) || !value.sessions.every(isRecord)) return null;
  return { version: 1, kind: value.kind, sessions: value.sessions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
