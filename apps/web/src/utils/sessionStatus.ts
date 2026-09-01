import {
  operatorAttentionDescendants,
  operatorSessionStatusPresentation,
  type ManagedSession,
  type OperatorActionableAgentStatus,
  type SessionDisplayStatus
} from "@muxpilot/core";

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
  return ["working", "running", "generating", "executing", "planning", "queued", "unknown"];
}

export function isSessionStatusSeverity(value: string | null): value is SessionStatusSeverity {
  return value === "red" || value === "yellow" || value === "green";
}

export const sessionStatusPresentation = operatorSessionStatusPresentation;

export interface ChildSessionAttentionItem {
  session: ManagedSession;
  status: OperatorActionableAgentStatus;
  detail: string;
}

const CHILD_ATTENTION_PRIORITY: Record<OperatorActionableAgentStatus, number> = {
  approval: 0,
  question: 1,
  input_failed: 2,
  blocked: 3,
  plan_ready: 4
};

export function childSessionAttentionItems(parent: ManagedSession, sessions: readonly ManagedSession[]): ChildSessionAttentionItem[] {
  return operatorAttentionDescendants(parent, sessions)
    .map((session) => ({ session, status: session.status, detail: childAttentionDetail(session) }))
    .sort((left, right) =>
      CHILD_ATTENTION_PRIORITY[left.status] - CHILD_ATTENTION_PRIORITY[right.status]
      || sessionActivityTime(right.session) - sessionActivityTime(left.session)
      || left.session.id.localeCompare(right.session.id)
    );
}

function sessionActivityTime(session: ManagedSession): number {
  const timestamp = session.lastActivityAt ? Date.parse(session.lastActivityAt) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function childAttentionDetail(session: ManagedSession): string {
  if (session.status === "approval") return "Approval required";
  if (session.status === "question") return "Answer requested";
  if (session.status === "plan_ready") return "Plan decision required";
  if (session.status === "input_failed") return "Input delivery needs recovery";
  const contextBlocked = Boolean(session.agentOwnership?.contextPausedAt);
  const budgetBlocked = Boolean(session.agentOwnership?.budgetExhaustedAt);
  if (contextBlocked && budgetBlocked) return "High context and work-token budget need attention";
  if (contextBlocked) {
    const percent = session.contextUsage?.contextPercent;
    return typeof percent === "number" && Number.isFinite(percent) ? `Paused at ${Math.round(percent)}% context` : "Paused by the high-context guard";
  }
  if (budgetBlocked) return "Work-token budget exhausted";
  return "Child session is blocked";
}

export function countSessionStatuses(sessions: readonly ManagedSession[]): SessionStoplightCounts {
  const counts: SessionStoplightCounts = { red: 0, yellow: 0, green: 0 };
  const roots = sessions.filter((session) => !session.agentOwnership || !sessions.some((candidate) => candidate.id === session.agentOwnership?.parentSessionId));
  for (const session of roots) {
    if (session.initializing) continue;
    counts[sessionStatusSeverity(sessionStatusPresentation(session, sessions).status)] += 1;
  }
  return counts;
}
