import type { MuxpilotGuard } from "./types.js";

export const APPROVAL_DECISION_EVENT_TAG = "muxpilot_approval_decision";
export const APPROVAL_DECISION_PAYLOAD_KEY = "muxpilotApprovalDecision";

export interface ApprovalDecisionEvent {
  version: 1;
  approvalId: string;
  decision: "approved" | "denied";
  guards: MuxpilotGuard[];
  action: string;
  consequences: string;
}

export interface NormalizedApprovalDecisionEvent {
  event: ApprovalDecisionEvent;
  rawText: string;
}

const APPROVED_CONTINUATION =
  "The operator or session approval mode authorized only the stated operation and guard exceptions. Continue from the approval boundary.";
const DENIED_CONTINUATION =
  "The stated guard exceptions were denied. Keep those guards in effect, do not perform the proposed action, and continue safely or report the blocker.";
const EVENT_PATTERN = /^<muxpilot_approval_decision>\s*([\s\S]*?)\s*<\/muxpilot_approval_decision>\s*\n\s*([\s\S]+)$/;
const MUXPILOT_GUARDS = new Set<MuxpilotGuard>([
  "worktree-isolation",
  "same-agent-review",
  "focused-validation",
  "atomic-commits",
  "clean-target",
  "fixed-target",
  "local-target-only",
  "automatic-cleanup",
  "no-pull-push"
]);

export function serializeApprovalDecisionEvent(event: ApprovalDecisionEvent): string {
  const continuation = event.decision === "approved" ? APPROVED_CONTINUATION : DENIED_CONTINUATION;
  return `<${APPROVAL_DECISION_EVENT_TAG}>\n${JSON.stringify(event)}\n</${APPROVAL_DECISION_EVENT_TAG}>\n${continuation}`;
}

export function normalizeApprovalDecisionEvent(text: string): NormalizedApprovalDecisionEvent | null {
  const cleaned = text.replace(/\r/g, "").trim();
  const match = cleaned.match(EVENT_PATTERN);
  if (!match?.[1] || !match[2]) return null;
  try {
    const event = parseEvent(JSON.parse(match[1]) as unknown);
    if (!event || match[2].trim() !== continuationFor(event.decision)) return null;
    return { event, rawText: cleaned };
  } catch {
    return null;
  }
}

export function approvalDecisionEventSummary(event: ApprovalDecisionEvent): string {
  return `Muxpilot gate ${event.decision}`;
}

export function approvalDecisionEventFromPayload(payload: Record<string, unknown>): ApprovalDecisionEvent | null {
  return parseEvent(payload[APPROVAL_DECISION_PAYLOAD_KEY]);
}

export function withApprovalDecisionEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedApprovalDecisionEvent
): Record<string, unknown> {
  return { ...payload, [APPROVAL_DECISION_PAYLOAD_KEY]: normalized.event };
}

function continuationFor(decision: ApprovalDecisionEvent["decision"]): string {
  return decision === "approved" ? APPROVED_CONTINUATION : DENIED_CONTINUATION;
}

function parseEvent(value: unknown): ApprovalDecisionEvent | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (typeof value.approvalId !== "string" || !value.approvalId.trim()) return null;
  if (value.decision !== "approved" && value.decision !== "denied") return null;
  if (!Array.isArray(value.guards) || !value.guards.every(isMuxpilotGuard)) return null;
  if (typeof value.action !== "string" || !value.action.trim()) return null;
  if (typeof value.consequences !== "string" || !value.consequences.trim()) return null;
  return {
    version: 1,
    approvalId: value.approvalId,
    decision: value.decision,
    guards: value.guards,
    action: value.action,
    consequences: value.consequences
  };
}

function isMuxpilotGuard(value: unknown): value is MuxpilotGuard {
  return typeof value === "string" && MUXPILOT_GUARDS.has(value as MuxpilotGuard);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
