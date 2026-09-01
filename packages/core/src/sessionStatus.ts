import type { ManagedSession, SessionDisplayStatus, SessionStatus } from "./types.js";

const SESSION_STATUS_PRIORITY: readonly SessionStatus[] = [
  "approval",
  "question",
  "input_failed",
  "startup_failed",
  "blocked",
  "plan_ready",
  "working",
  "running",
  "planning",
  "executing",
  "generating",
  "queued",
  "unknown",
  "waiting",
  "idle",
  "missing"
];

export type OperatorActionableAgentStatus = "approval" | "question" | "plan_ready" | "input_failed" | "blocked";
export type OperatorAttentionSession = ManagedSession & { status: OperatorActionableAgentStatus };

const OPERATOR_ACTIONABLE_AGENT_STATUSES = new Set<SessionStatus>([
  "approval",
  "question",
  "plan_ready",
  "input_failed",
  "blocked"
]);

const AGENT_INTERNAL_ATTENTION_STATUSES = new Set<SessionStatus>(["startup_failed"]);

export function isOperatorActionableAgentStatus(status: SessionStatus): status is OperatorActionableAgentStatus {
  return OPERATOR_ACTIONABLE_AGENT_STATUSES.has(status);
}

export function highestPrioritySession<T extends { status: SessionStatus }>(sessions: readonly T[]): T | null {
  for (const status of SESSION_STATUS_PRIORITY) {
    const session = sessions.find((candidate) => candidate.status === status);
    if (session) return session;
  }
  return null;
}

export interface SessionStatusPresentation {
  status: SessionDisplayStatus;
  sourceSessionId: string;
  inherited: boolean;
}

export function agentSessionRoot(session: ManagedSession, sessions: readonly ManagedSession[]): ManagedSession {
  const rootSessionId = session.agentOwnership?.rootSessionId;
  return rootSessionId ? sessions.find((candidate) => candidate.id === rootSessionId) ?? session : session;
}

export function liveSessionSubtree(session: ManagedSession, sessions: readonly ManagedSession[]): ManagedSession[] {
  const result = session.agentOwnership?.completedAt ? [] : [session];
  const pending = [session.id];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const parentId = pending.shift()!;
    for (const candidate of sessions) {
      if (candidate.agentOwnership?.parentSessionId !== parentId || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      if (candidate.agentOwnership.completedAt || candidate.archived || candidate.status === "missing") continue;
      result.push(candidate);
      pending.push(candidate.id);
    }
  }
  return result;
}

export function sessionStatusPresentation(session: ManagedSession, sessions: readonly ManagedSession[]): SessionStatusPresentation {
  const subtree = liveSessionSubtree(session, sessions);
  if (session.agentOwnership?.completedAt && subtree.length === 0) {
    return { status: "completed", sourceSessionId: session.id, inherited: false };
  }
  const effective = highestPrioritySession(subtree.length > 0 ? subtree : [session]) ?? session;
  return { status: effective.status, sourceSessionId: effective.id, inherited: effective.id !== session.id };
}

export function operatorSessionStatusPresentation(session: ManagedSession, sessions: readonly ManagedSession[]): SessionStatusPresentation {
  const subtree = liveSessionSubtree(session, sessions);
  if (session.agentOwnership?.completedAt && subtree.length === 0) {
    return { status: "completed", sourceSessionId: session.id, inherited: false };
  }
  const operatorVisible = subtree.filter((candidate) => candidate.id === session.id || !AGENT_INTERNAL_ATTENTION_STATUSES.has(candidate.status));
  const effective = highestPrioritySession(operatorVisible.length > 0 ? operatorVisible : [session]) ?? session;
  return { status: effective.status, sourceSessionId: effective.id, inherited: effective.id !== session.id };
}

export function operatorAttentionDescendants(session: ManagedSession, sessions: readonly ManagedSession[]): OperatorAttentionSession[] {
  return liveSessionSubtree(session, sessions).filter(
    (candidate): candidate is OperatorAttentionSession => candidate.id !== session.id && isOperatorActionableAgentStatus(candidate.status)
  );
}
