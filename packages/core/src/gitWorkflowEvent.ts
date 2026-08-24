export const GIT_WORKFLOW_EVENT_TAG = "muxpilot_git_workflow";
export const GIT_WORKFLOW_PAYLOAD_KEY = "muxpilotGitWorkflow";

export type GitWorkflowEventKind =
  | "workflow_initialized"
  | "worktree_created"
  | "worktree_adopted"
  | "target_changed"
  | "review_required"
  | "integration_completed"
  | "workflow_blocked"
  | "workflow_failed";

export type GitWorkflowOperation = "initialize" | "begin" | "target" | "finish";

export interface GitWorkflowEvent {
  version: 1;
  eventId: string;
  kind: GitWorkflowEventKind;
  operation: GitWorkflowOperation;
  workspaceId: string;
  targetBranch: string;
  skill: "$muxpilot-git-workflow";
  executionMode?: "managed" | "standalone";
  targetSha?: string;
  previousTargetBranch?: string;
  sessionBranch?: string;
  worktreePath?: string;
  reviewRequired?: boolean;
  reason?: string;
  cleanup?: "removed" | "retained";
  broker?: "authenticated";
  error?: string;
}

export interface NormalizedGitWorkflowEvent {
  event: GitWorkflowEvent;
  rawText: string;
}

const EVENT_ID = /^mwf-[a-f0-9]{12}$/;
const EVENT_PATTERN = /<muxpilot_git_workflow>\s*([\s\S]*?)\s*<\/muxpilot_git_workflow>/gi;
const EVENT_KINDS: readonly GitWorkflowEventKind[] = [
  "workflow_initialized",
  "worktree_created",
  "worktree_adopted",
  "target_changed",
  "review_required",
  "integration_completed",
  "workflow_blocked",
  "workflow_failed"
];
const OPERATIONS: readonly GitWorkflowOperation[] = ["initialize", "begin", "target", "finish"];

export function serializeGitWorkflowEvent(event: GitWorkflowEvent): string {
  return `<${GIT_WORKFLOW_EVENT_TAG}>\n${JSON.stringify(event)}\n</${GIT_WORKFLOW_EVENT_TAG}>`;
}

export function normalizeGitWorkflowEvent(text: string): NormalizedGitWorkflowEvent | null {
  const events = extractGitWorkflowEvents(text);
  if (events.length !== 1) return null;
  const cleaned = cleanText(text);
  return cleaned === events[0]?.rawText ? events[0] : null;
}

export function extractGitWorkflowEvents(text: string): NormalizedGitWorkflowEvent[] {
  const cleaned = cleanText(text);
  const events: NormalizedGitWorkflowEvent[] = [];
  for (const match of cleaned.matchAll(EVENT_PATTERN)) {
    if (!match[0] || !match[1]) continue;
    try {
      const event = parseEvent(JSON.parse(match[1]) as unknown);
      if (event) events.push({ event, rawText: match[0] });
    } catch {
      // Ignore malformed event tags without hiding the surrounding tool output.
    }
  }
  return events;
}

export function gitWorkflowEventSummary(event: GitWorkflowEvent): string {
  switch (event.kind) {
    case "workflow_initialized": return "Standalone Git workflow initialized";
    case "worktree_created": return "Implementation worktree created";
    case "worktree_adopted": return "Existing implementation worktree adopted";
    case "target_changed": return "Git target branch changed";
    case "review_required": return "Fresh validation and self-review required";
    case "integration_completed": return "Changes integrated locally";
    case "workflow_blocked": return "Git workflow blocked";
    case "workflow_failed": return "Git workflow action failed";
  }
}

export function gitWorkflowEventDirection(event: GitWorkflowEvent): string {
  return event.kind === "review_required" || event.kind === "workflow_blocked" || event.kind === "workflow_failed"
    ? "Git → Agent"
    : "Agent → Git";
}

export function gitWorkflowEventContext(event: GitWorkflowEvent, maxLength = 96): string {
  let value: string;
  switch (event.kind) {
    case "workflow_initialized":
      value = `${event.targetBranch}${event.targetSha ? ` @ ${event.targetSha.slice(0, 8)}` : ""}`;
      break;
    case "worktree_created":
    case "worktree_adopted":
      value = `${event.sessionBranch ?? "worktree"} → ${event.targetBranch}`;
      break;
    case "target_changed":
      value = `${event.previousTargetBranch ?? "previous target"} → ${event.targetBranch}`;
      break;
    case "integration_completed":
      value = `${event.targetBranch}${event.targetSha ? ` @ ${event.targetSha.slice(0, 8)}` : ""}`;
      break;
    case "review_required":
      value = event.reason ?? event.targetBranch;
      break;
    case "workflow_blocked":
    case "workflow_failed":
      value = event.error ?? event.operation;
      break;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function gitWorkflowEventFromPayload(payload: Record<string, unknown>): NormalizedGitWorkflowEvent | null {
  const value = payload[GIT_WORKFLOW_PAYLOAD_KEY];
  if (!isRecord(value)) return null;
  const event = parseEvent(value.event);
  const rawText = typeof value.rawText === "string" ? value.rawText : "";
  return event && rawText ? { event, rawText } : null;
}

export function withGitWorkflowEventPayload(
  payload: Record<string, unknown>,
  normalized: NormalizedGitWorkflowEvent
): Record<string, unknown> {
  return {
    ...payload,
    [GIT_WORKFLOW_PAYLOAD_KEY]: {
      event: normalized.event,
      rawText: normalized.rawText
    }
  };
}

function parseEvent(value: unknown): GitWorkflowEvent | null {
  if (!isRecord(value) || value.version !== 1 || !EVENT_ID.test(String(value.eventId))) return null;
  if (!EVENT_KINDS.includes(value.kind as GitWorkflowEventKind)) return null;
  if (!OPERATIONS.includes(value.operation as GitWorkflowOperation)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  if (typeof value.targetBranch !== "string" || !value.targetBranch.trim()) return null;
  if (value.skill !== "$muxpilot-git-workflow") return null;

  const event: GitWorkflowEvent = {
    version: 1,
    eventId: String(value.eventId),
    kind: value.kind as GitWorkflowEventKind,
    operation: value.operation as GitWorkflowOperation,
    workspaceId: value.workspaceId,
    targetBranch: value.targetBranch,
    skill: "$muxpilot-git-workflow"
  };
  copyString(value, event, "targetSha");
  copyString(value, event, "previousTargetBranch");
  copyString(value, event, "sessionBranch");
  copyString(value, event, "worktreePath");
  copyString(value, event, "reason");
  copyString(value, event, "error");
  if (value.executionMode === "managed" || value.executionMode === "standalone") event.executionMode = value.executionMode;
  if (typeof value.reviewRequired === "boolean") event.reviewRequired = value.reviewRequired;
  if (value.cleanup === "removed" || value.cleanup === "retained") event.cleanup = value.cleanup;
  if (value.broker === "authenticated") event.broker = value.broker;

  if (event.kind === "workflow_initialized" && (event.operation !== "initialize" || !event.targetSha || event.executionMode !== "standalone")) return null;
  if ((event.kind === "worktree_created" || event.kind === "worktree_adopted") && (!event.sessionBranch || !event.worktreePath)) return null;
  if (event.kind === "target_changed" && (!event.previousTargetBranch || !event.targetSha)) return null;
  if (event.kind === "review_required" && !event.reason) return null;
  if (event.kind === "integration_completed" && (!event.targetSha || !event.cleanup)) return null;
  if ((event.kind === "workflow_blocked" || event.kind === "workflow_failed") && !event.error) return null;
  return event;
}

function copyString(source: Record<string, unknown>, target: GitWorkflowEvent, key: keyof GitWorkflowEvent): void {
  const value = source[key];
  if (typeof value === "string" && value.trim()) Object.assign(target, { [key]: value });
}

function cleanText(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
