import type { ManagedSession, SessionEvent, SessionStatus } from "@muxpilot/core";

export type SessionStatusSeverity = "red" | "yellow" | "green";

export interface SessionStoplightCounts {
  red: number;
  yellow: number;
  green: number;
}

export const SESSION_STATUS_RECONCILE_INTERVAL_MS = 10_000;
export const SESSION_STATUS_EVENT_DEBOUNCE_MS = 2000;
export const SESSION_STATUS_SEVERITIES: readonly SessionStatusSeverity[] = ["red", "yellow", "green"];

export function sessionStatusSeverity(status: SessionStatus): SessionStatusSeverity {
  if (status === "approval" || status === "question" || status === "plan_ready" || status === "blocked" || status === "missing") {
    return "red";
  }
  if (status === "waiting" || status === "idle") return "green";
  return "yellow";
}

export function sessionStatusesForSeverity(severity: SessionStatusSeverity): readonly SessionStatus[] {
  if (severity === "red") return ["approval", "question", "plan_ready", "blocked", "missing"];
  if (severity === "green") return ["waiting", "idle"];
  return ["working", "generating", "executing", "planning", "unknown"];
}

export function isSessionStatusSeverity(value: string | null): value is SessionStatusSeverity {
  return value === "red" || value === "yellow" || value === "green";
}

export function countSessionStatuses(sessions: readonly Pick<ManagedSession, "status">[]): SessionStoplightCounts {
  const counts: SessionStoplightCounts = { red: 0, yellow: 0, green: 0 };
  for (const session of sessions) {
    counts[sessionStatusSeverity(session.status)] += 1;
  }
  return counts;
}

export function shouldRefreshSessionsForEvent(event: Pick<SessionEvent, "type"> | { type: string }): boolean {
  return event.type === "session.updated" || event.type === "status.changed" || event.type === "message.appended";
}
