import { createHash } from "node:crypto";
import type { ChatMessage, SessionStatus } from "@muxpilot/core";
import type { JsonRpcNotification } from "../../runtime/jsonRpcConnection.js";
import { providerTurnFailure } from "../../utils/turnFailure.js";
import type { AppServerEventIdentity, AppServerEventProjection } from "../codex/events.js";
import type { ProjectionAdapter } from "../shared/projectionReconciler.js";
import type { DriverEvent } from "../types.js";
import {
  CLAUDE_ITEM_TURN,
  CLAUDE_LIVE_SOURCE,
  claudeRecordMessages,
  planItemId,
  type ClaudeToolUse
} from "./messages.js";
import type { HostApprovalParams, HostQuestionParams } from "./host/protocol.js";

export const CLAUDE_APPROVAL_METHOD = "claude/approval";
export const CLAUDE_QUESTION_METHOD = "claude/question";

export const claudeProjectionAdapter: ProjectionAdapter = {
  project: projectClaudeEvent,
  expand: expandClaudeEvent,
  authenticationFailure: claudeAuthenticationFailure,
  isInteractiveServerRequest: (event: DriverEvent) => event.method === CLAUDE_APPROVAL_METHOD || event.method === CLAUDE_QUESTION_METHOD
};

/**
 * An SDK record can carry several content blocks (parallel tool results, text plus tool use). Each block becomes
 * its own event so every block is projected live, not only after the transcript is parsed.
 */
export function expandClaudeEvent(event: DriverEvent): DriverEvent[] {
  if (event.method !== "sdk/message") return [event];
  const params = record(event.params);
  const message = record(params?.message);
  if (!params || !message || (message.type !== "assistant" && message.type !== "user")) return [event];
  const toolUses = record(params.toolUses) as Record<string, ClaudeToolUse> | null;
  const count = claudeRecordMessages(message, toolUses ?? {}).length;
  if (count <= 1) return [event];
  return Array.from({ length: count }, (_, blockIndex) => ({ ...event, params: { ...params, blockIndex } }));
}

/** Projects one Claude host notification (or driver-synthesized request event) into muxpilot state. */
export function projectClaudeEvent(notification: JsonRpcNotification, receivedAt: string): AppServerEventProjection | null {
  const params = record(notification.params);
  if (!params) return null;
  if (notification.method === CLAUDE_APPROVAL_METHOD || notification.method === CLAUDE_QUESTION_METHOD) {
    return requestProjection(notification, params, receivedAt);
  }
  const threadId = string(params.threadId);
  if (!threadId) return null;

  switch (notification.method) {
    case "thread/status/changed":
      return projection(notification, identity(threadId, null, null, null), threadStatus(params.status), false, null);
    case "turn/started": {
      const turnId = string(record(params.turn)?.id);
      return turnId ? projection(notification, identity(threadId, turnId, null, null), "working", false, null) : null;
    }
    case "input/accepted":
      return inputAcceptedProjection(notification, params, threadId, receivedAt);
    case "turn/completed":
      return turnCompletedProjection(notification, params, threadId, receivedAt);
    case "muxpilot/turn/intentionallyInterrupted":
      return intentionalInterruptionProjection(notification, params, threadId, receivedAt);
    case "plan/proposed":
      return planProjection(notification, params, threadId, receivedAt);
    case "sdk/message":
      return sdkMessageProjection(notification, params, threadId, receivedAt);
    default:
      return null;
  }
}

function sdkMessageProjection(
  notification: JsonRpcNotification,
  params: Record<string, unknown>,
  threadId: string,
  receivedAt: string
): AppServerEventProjection | null {
  const message = record(params.message);
  if (!message) return null;
  const turnId = string(params.turnId);
  if (message.type === "stream_event") {
    return projection(notification, identity(threadId, turnId, null, null), turnId ? "generating" : null, true, null);
  }
  if (message.type === "system") return systemMessageProjection(notification, message, threadId, turnId, receivedAt);
  if (message.type !== "assistant" && message.type !== "user") return null;
  const toolUses = record(params.toolUses) as Record<string, ClaudeToolUse> | null;
  const blockIndex = typeof params.blockIndex === "number" ? params.blockIndex : 0;
  const mapped = claudeRecordMessages(message, toolUses ?? {})[blockIndex];
  if (!mapped) return null;
  const eventIdentity = identity(threadId, turnId, mapped.itemId, null);
  return projection(notification, eventIdentity, turnId ? mapped.status : null, false, {
    id: stableProjectionId(threadId, mapped.itemId, mapped.type),
    type: mapped.type,
    role: mapped.role,
    timestamp: string(message.timestamp) ?? receivedAt,
    text: mapped.text,
    payload: {
      source: CLAUDE_LIVE_SOURCE,
      method: notification.method,
      codexItemIdentity: itemIdentity(threadId, mapped.itemId, null),
      appServerIdentity: eventIdentity,
      ...mapped.payload
    }
  });
}

function systemMessageProjection(
  notification: JsonRpcNotification,
  message: Record<string, unknown>,
  threadId: string,
  turnId: string | null,
  receivedAt: string
): AppServerEventProjection | null {
  const uuid = string(message.uuid);
  const notice = (text: string, extra: Record<string, unknown> = {}) => {
    if (!uuid) return null;
    const eventIdentity = identity(threadId, turnId, uuid, null);
    return projection(notification, eventIdentity, null, false, {
      id: stableProjectionId(threadId, uuid, "status"),
      type: "status",
      role: "system",
      timestamp: receivedAt,
      text,
      payload: {
        source: CLAUDE_LIVE_SOURCE,
        method: notification.method,
        codexItemIdentity: itemIdentity(threadId, uuid, null),
        appServerIdentity: eventIdentity,
        ...extra
      }
    });
  };
  switch (message.subtype) {
    case "compact_boundary": {
      const metadata = record(message.compact_metadata);
      const tokens = typeof metadata?.pre_tokens === "number" ? ` from ${metadata.pre_tokens.toLocaleString("en-US")} tokens` : "";
      return notice(`Context compacted${tokens}.`, { compaction: metadata });
    }
    case "api_retry": {
      const attempt = typeof message.attempt === "number" ? message.attempt : 0;
      if (attempt < 3) return projection(notification, identity(threadId, turnId, null, null), turnId ? "working" : null, true, null);
      return notice(`Claude API request failed; retrying (attempt ${attempt}).`);
    }
    case "permission_denied":
      return notice(`Claude was denied ${string(message.tool_name) ?? "a tool"}: ${string(message.message) ?? "not permitted"}`);
    case "task_notification": {
      const status = string(message.status) ?? "finished";
      const summary = string(message.summary);
      return notice(`Background task ${status}${summary ? `: ${summary}` : ""}`);
    }
    default:
      return null;
  }
}

function inputAcceptedProjection(
  notification: JsonRpcNotification,
  params: Record<string, unknown>,
  threadId: string,
  receivedAt: string
): AppServerEventProjection | null {
  const messageUuid = string(params.messageUuid);
  const clientMessageId = string(params.clientMessageId);
  const turnId = string(params.turnId);
  if (!messageUuid || !clientMessageId) return null;
  const eventIdentity = identity(threadId, turnId, messageUuid, clientMessageId);
  return projection(notification, eventIdentity, null, false, {
    id: stableProjectionId(threadId, messageUuid, "user"),
    type: "user",
    role: "user",
    timestamp: string(params.acceptedAt) ?? receivedAt,
    text: string(params.text) ?? "",
    payload: {
      source: CLAUDE_LIVE_SOURCE,
      method: notification.method,
      codexItemIdentity: itemIdentity(threadId, messageUuid, clientMessageId),
      appServerIdentity: eventIdentity
    }
  });
}

function turnCompletedProjection(
  notification: JsonRpcNotification,
  params: Record<string, unknown>,
  threadId: string,
  receivedAt: string
): AppServerEventProjection | null {
  const turn = record(params.turn);
  const turnId = string(turn?.id);
  if (!turn || !turnId) return null;
  const eventIdentity = identity(threadId, turnId, null, null);
  const failure = providerTurnFailure(params);
  const unexpected = params.muxpilotUnexpectedInterruption === true;
  const status = completedTurnStatus(turn);
  const message = failure
    ? statusMessage(notification, eventIdentity, "turnFailure", receivedAt, `Claude could not complete this turn: ${failure.failureReason}`, { turnFailure: failure })
    : unexpected
      ? statusMessage(
          notification,
          eventIdentity,
          "unexpectedInterruption",
          receivedAt,
          "Claude stopped this turn before completion. The interruption cause could not be confirmed. Partial work may already exist.",
          { interruption: { kind: "unexpected", threadId, turnId, observedAt: receivedAt } }
        )
      : null;
  return projection(notification, eventIdentity, status, false, message);
}

function intentionalInterruptionProjection(
  notification: JsonRpcNotification,
  params: Record<string, unknown>,
  threadId: string,
  receivedAt: string
): AppServerEventProjection | null {
  const turnId = string(params.turnId);
  if (!turnId) return null;
  const eventIdentity = identity(threadId, turnId, null, null);
  const kind = params.kind === "budget_guard" ? "budget_guard" : "operator";
  return projection(notification, eventIdentity, null, false, {
    ...statusMessage(
      notification,
      eventIdentity,
      `${kind}Interruption`,
      receivedAt,
      kind === "budget_guard"
        ? "Turn interrupted because the agent work-token budget was exhausted."
        : "Turn interrupted by operator.",
      { interruption: { kind, threadId, turnId, observedAt: receivedAt } }
    ),
    payload: {
      source: "muxpilot",
      method: notification.method,
      codexItemIdentity: { threadId, turnId, itemId: `${kind}Interruption`, clientMessageId: null },
      appServerIdentity: eventIdentity,
      interruption: { kind, threadId, turnId, observedAt: receivedAt }
    }
  });
}

function planProjection(
  notification: JsonRpcNotification,
  params: Record<string, unknown>,
  threadId: string,
  receivedAt: string
): AppServerEventProjection | null {
  const turnId = string(params.turnId);
  const itemId = string(params.itemId);
  const plan = string(params.plan)?.trim();
  if (!itemId || !plan) return null;
  const eventIdentity = identity(threadId, turnId, itemId, null);
  return projection(notification, eventIdentity, "planning", false, {
    id: stableProjectionId(threadId, planItemId(itemId), "assistant"),
    type: "assistant",
    role: "assistant",
    timestamp: receivedAt,
    text: plan.includes("<proposed_plan>") ? plan : `<proposed_plan>\n${plan}\n</proposed_plan>`,
    payload: {
      source: CLAUDE_LIVE_SOURCE,
      method: notification.method,
      codexItemIdentity: itemIdentity(threadId, planItemId(itemId), null),
      appServerIdentity: eventIdentity
    }
  });
}

function requestProjection(
  notification: JsonRpcNotification,
  envelope: Record<string, unknown>,
  receivedAt: string
): AppServerEventProjection | null {
  const requestId = string(envelope.requestId);
  const params = record(envelope.params);
  if (!requestId || !params) return null;
  const threadId = string(params.threadId);
  const turnId = string(params.turnId);
  const itemId = string(params.itemId);
  if (!threadId || !turnId || !itemId) return null;
  const eventIdentity = identity(threadId, turnId, itemId, null);
  const timestamp = string(envelope.openedAt) ?? receivedAt;
  const basePayload = { source: CLAUDE_LIVE_SOURCE, method: notification.method, appServerIdentity: eventIdentity };

  if (notification.method === CLAUDE_QUESTION_METHOD) {
    const question = params as unknown as HostQuestionParams;
    if (!Array.isArray(question.questions) || question.questions.length === 0) return null;
    return projection(notification, eventIdentity, "question", false, {
      id: stableProjectionId(threadId, `${itemId}:${requestId}`, "question_request"),
      type: "question_request",
      role: "system",
      timestamp,
      text: "Claude needs your input",
      payload: {
        ...basePayload,
        codexItemIdentity: { threadId, turnId, itemId, clientMessageId: null },
        question: {
          id: requestId,
          requestId,
          questions: question.questions.map(({ id, header, question: text, options }) => ({ id, header, question: text, options })),
          autoResolutionMs: null,
          createdAt: timestamp
        }
      }
    });
  }

  const approval = params as unknown as HostApprovalParams;
  const prefixRule = Array.isArray(approval.prefixRule) && approval.prefixRule.length > 0 ? approval.prefixRule : null;
  return projection(notification, eventIdentity, "approval", false, {
    id: stableProjectionId(threadId, `${itemId}:${requestId}`, "approval_request"),
    type: "approval_request",
    role: "system",
    timestamp,
    text: approval.title,
    payload: {
      ...basePayload,
      approval: {
        id: requestId,
        requestId,
        createdAt: timestamp,
        kind: approval.category,
        title: approval.title,
        command: approval.command,
        toolName: approval.toolName,
        cwd: approval.cwd,
        reason: approval.reason,
        prefixRule,
        options: [
          { decision: "approve_once", label: "Approve once", description: "Allow this action and continue." },
          { decision: "approve_for_session", label: "Approve for session", description: "Allow matching actions for the rest of this Claude session." },
          ...(prefixRule ? [{ decision: "approve_for_prefix", label: "Always allow prefix", description: `Allow commands starting with ${prefixRule.join(" ")} for this session.` }] : []),
          { decision: "deny", label: "Deny", description: "Cancel this action." }
        ]
      }
    }
  });
}

/** A sanitized operator-facing message when a Claude runtime reports failed authentication. */
export function claudeAuthenticationFailure(method: string, value: unknown): string | null {
  const params = record(value);
  let text: string | null = null;
  if (method === "auth/failed") text = string(params?.message) ?? "Claude authentication failed.";
  if (method === "turn/completed") {
    const turn = record(params?.turn);
    const error = record(turn?.error);
    if (turn?.status === "failed" && error?.codexErrorInfo === "authenticationFailed") text = string(error.message);
  }
  if (method === "connection/error" && /\/login|not logged in|authentication|oauth token/i.test(string(params?.message) ?? "")) {
    text = string(params?.message);
  }
  if (!text) return null;
  const sanitized = text
    .replace(/((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[credential redacted]")
    .replace(/(?:sk-ant-|sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .slice(0, 800);
  return `${sanitized} Sign in with \`claude auth login\` on the muxpilot host, then resume this session.`;
}

function statusMessage(
  notification: JsonRpcNotification,
  eventIdentity: AppServerEventIdentity,
  kind: string,
  timestamp: string,
  text: string,
  extra: Record<string, unknown>
): Omit<ChatMessage, "sessionId" | "sequence"> {
  return {
    id: stableProjectionId(eventIdentity.threadId, `${eventIdentity.turnId}:${kind}`, "status"),
    type: "status",
    role: "system",
    timestamp,
    text,
    payload: {
      source: CLAUDE_LIVE_SOURCE,
      method: notification.method,
      codexItemIdentity: { threadId: eventIdentity.threadId, turnId: eventIdentity.turnId, itemId: kind, clientMessageId: null },
      appServerIdentity: eventIdentity,
      ...extra
    }
  };
}

function threadStatus(value: unknown): SessionStatus {
  const status = record(value);
  if (status?.type === "idle") return "idle";
  if (status?.type !== "active") return "unknown";
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  if (flags.includes("waitingOnApproval")) return "approval";
  if (flags.includes("waitingOnUserInput")) return "question";
  return "working";
}

function completedTurnStatus(turn: Record<string, unknown>): SessionStatus {
  if (turn.status === "completed") {
    return Array.isArray(turn.items) && turn.items.some((item) => record(item)?.type === "plan") ? "plan_ready" : "idle";
  }
  if (turn.status === "failed") return "input_failed";
  if (turn.status === "interrupted") return "waiting";
  return "unknown";
}

function projection(
  notification: JsonRpcNotification,
  eventIdentity: AppServerEventIdentity,
  status: SessionStatus | null,
  transient: boolean,
  message: Omit<ChatMessage, "sessionId" | "sequence"> | null
): AppServerEventProjection {
  return { identity: eventIdentity, method: notification.method, status, transient, message, payload: notification.params };
}

function identity(threadId: string, turnId: string | null, itemId: string | null, clientMessageId: string | null): AppServerEventIdentity {
  return { threadId, turnId, itemId, clientMessageId };
}

/** Deduplication marker shared with the transcript parser. */
export function itemIdentity(threadId: string, itemId: string, clientMessageId: string | null): Record<string, string | null> {
  return { threadId, turnId: CLAUDE_ITEM_TURN, itemId, clientMessageId };
}

export function stableProjectionId(threadId: string, itemId: string, type: string): string {
  return createHash("sha256").update(JSON.stringify(["claude", threadId, itemId, type])).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
