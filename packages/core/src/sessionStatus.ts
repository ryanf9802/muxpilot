import type { SessionStatus } from "./types.js";

const SESSION_STATUS_PRIORITY: readonly SessionStatus[] = [
  "approval",
  "question",
  "input_failed",
  "startup_failed",
  "blocked",
  "plan_ready",
  "working",
  "planning",
  "executing",
  "generating",
  "queued",
  "unknown",
  "waiting",
  "idle",
  "missing"
];

export function highestPrioritySession<T extends { status: SessionStatus }>(sessions: readonly T[]): T | null {
  for (const status of SESSION_STATUS_PRIORITY) {
    const session = sessions.find((candidate) => candidate.status === status);
    if (session) return session;
  }
  return null;
}
