import { operatorSessionStatusPresentation, type ManagedSession, type SessionDisplayStatus } from "@muxpilot/core";

export type SessionStatusSeverity = "red" | "yellow" | "green";

export interface SessionStoplightCounts {
  red: number;
  yellow: number;
  green: number;
}

export const SESSION_STATUS_RECONCILE_INTERVAL_MS = 30_000;
export const SESSION_STATUS_SEVERITIES: readonly SessionStatusSeverity[] = ["red", "yellow", "green"];

export function sessionStatusSeverity(status: SessionDisplayStatus): SessionStatusSeverity {
  if (status === "approval" || status === "question" || status === "plan_ready" || status === "blocked" || status === "input_failed" || status === "startup_failed" || status === "missing") {
    return "red";
  }
  if (status === "waiting" || status === "idle" || status === "completed") return "green";
  return "yellow";
}

export function sessionStatusesForSeverity(severity: SessionStatusSeverity): readonly SessionDisplayStatus[] {
  if (severity === "red") return ["approval", "question", "plan_ready", "blocked", "input_failed", "startup_failed", "missing"];
  if (severity === "green") return ["waiting", "idle", "completed"];
  return ["working", "generating", "executing", "planning", "queued", "unknown"];
}

export function isSessionStatusSeverity(value: string | null): value is SessionStatusSeverity {
  return value === "red" || value === "yellow" || value === "green";
}

export const sessionStatusPresentation = operatorSessionStatusPresentation;

export function countSessionStatuses(sessions: readonly ManagedSession[]): SessionStoplightCounts {
  const counts: SessionStoplightCounts = { red: 0, yellow: 0, green: 0 };
  const roots = sessions.filter((session) => !session.agentOwnership || !sessions.some((candidate) => candidate.id === session.agentOwnership?.parentSessionId));
  for (const session of roots) {
    if (session.initializing) continue;
    counts[sessionStatusSeverity(sessionStatusPresentation(session, sessions).status)] += 1;
  }
  return counts;
}
