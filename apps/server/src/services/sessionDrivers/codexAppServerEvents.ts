import { createHash } from "node:crypto";
import type { ChatMessage, SessionStatus } from "@muxpilot/core";
import type { JsonRpcNotification } from "./jsonRpcConnection.js";

export interface AppServerEventIdentity {
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  clientMessageId: string | null;
}

export interface AppServerEventProjection {
  identity: AppServerEventIdentity;
  method: string;
  status: SessionStatus | null;
  transient: boolean;
  message: Omit<ChatMessage, "sessionId" | "sequence"> | null;
  payload: unknown;
}

type ProjectedApproval = { title: string } & Record<string, unknown>;

export function projectAppServerEvent(
  notification: JsonRpcNotification,
  receivedAt: string
): AppServerEventProjection | null {
  const params = record(notification.params);
  if (!params) return null;
  const serverRequest = serverRequestProjection(notification, params, receivedAt);
  if (serverRequest) return serverRequest;
  const threadId = string(params.threadId);
  if (!threadId) return null;

  if (notification.method === "thread/status/changed") {
    return projection(notification, identity(threadId, null, null, null), threadStatus(params.status), false, null);
  }

  const turn = record(params.turn);
  const turnId = string(params.turnId) ?? string(turn?.id);
  if (!turnId) return null;

  if (notification.method === "turn/started") {
    return projection(notification, identity(threadId, turnId, null, null), "working", false, null);
  }
  if (notification.method === "turn/completed") {
    return projection(notification, identity(threadId, turnId, null, null), completedTurnStatus(turn), false, null);
  }

  const item = record(params.item);
  const itemId = string(params.itemId) ?? string(item?.id);
  if (!itemId) return null;
  const clientMessageId = string(item?.clientId);
  const eventIdentity = identity(threadId, turnId, itemId, clientMessageId);

  if (notification.method === "item/completed") {
    if (!item) return null;
    const timestamp = millisecondTimestamp(params.completedAtMs) ?? receivedAt;
    return projection(
      notification,
      eventIdentity,
      itemStatus(item, false),
      false,
      completedItemMessage(eventIdentity, item, timestamp, notification)
    );
  }
  if (notification.method === "item/started") {
    return projection(notification, eventIdentity, itemStatus(item, true), false, null);
  }
  if (notification.method === "item/agentMessage/delta") {
    return projection(notification, eventIdentity, "generating", true, null);
  }
  if (notification.method === "item/plan/delta") {
    return projection(notification, eventIdentity, "planning", true, null);
  }
  if (notification.method === "item/commandExecution/outputDelta") {
    return projection(notification, eventIdentity, "executing", true, null);
  }
  return null;
}

function serverRequestProjection(
  notification: JsonRpcNotification,
  envelope: Record<string, unknown>,
  receivedAt: string
): AppServerEventProjection | null {
  const params = record(envelope.params);
  const requestId = jsonRpcRequestId(envelope.requestId);
  if (!params || requestId === null) return null;
  const threadId = string(params.threadId);
  const turnId = string(params.turnId);
  const itemId = string(params.itemId);
  if (!threadId || !turnId || !itemId) return null;
  const eventIdentity = identity(threadId, turnId, itemId, null);
  const timestamp = millisecondTimestamp(params.startedAtMs) ?? receivedAt;
  const basePayload = {
    source: "codex_app_server",
    method: notification.method,
    appServerIdentity: eventIdentity
  };

  if (notification.method === "item/tool/requestUserInput") {
    if (!Array.isArray(params.questions) || params.questions.length === 0) return null;
    return projection(notification, eventIdentity, "question", false, {
      id: stableServerRequestId(eventIdentity, notification.method, requestId),
      type: "question_request",
      role: "system",
      timestamp,
      text: "Codex needs your input",
      payload: {
        ...basePayload,
        question: {
          id: String(requestId),
          requestId,
          questions: params.questions,
          autoResolutionMs: safeInteger(params.autoResolutionMs),
          createdAt: timestamp
        }
      }
    });
  }

  const approval = approvalRequest(notification.method, params);
  if (!approval) return null;
  return projection(notification, eventIdentity, "approval", false, {
    id: stableServerRequestId(eventIdentity, notification.method, requestId),
    type: "approval_request",
    role: "system",
    timestamp,
    text: approval.title,
    payload: {
      ...basePayload,
      approval: {
        id: String(requestId),
        requestId,
        createdAt: timestamp,
        ...approval
      }
    }
  });
}

function approvalRequest(method: string, params: Record<string, unknown>): ProjectedApproval | null {
  const reason = string(params.reason);
  const cwd = string(params.cwd);
  if (method === "item/commandExecution/requestApproval") {
    const command = commandText(params.command);
    const prefixRule = stringArrayOrNull(params.proposedExecpolicyAmendment);
    return {
      kind: "command",
      title: command ? `Run ${command}` : "Run this command?",
      command,
      cwd,
      reason,
      prefixRule,
      options: [
        approvalOption("approve_once", "Approve once", "Run this command and continue."),
        approvalOption("approve_for_session", "Approve for session", "Allow this request for the current Codex session."),
        ...(prefixRule ? [approvalOption("approve_for_prefix", "Always allow prefix", "Remember this command prefix.")] : []),
        approvalOption("deny", "Deny", "Cancel this command.")
      ]
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "patch",
      title: "Apply proposed file changes?",
      command: null,
      cwd,
      reason,
      prefixRule: null,
      options: [
        approvalOption("approve_once", "Approve once", "Apply these changes and continue."),
        approvalOption("approve_for_session", "Approve for session", "Allow file changes for the current Codex session."),
        approvalOption("deny", "Deny", "Cancel these file changes.")
      ]
    };
  }
  if (method === "item/permissions/requestApproval" && record(params.permissions)) {
    return {
      kind: "permissions",
      title: "Grant additional permissions?",
      command: null,
      cwd,
      reason,
      prefixRule: null,
      options: [
        approvalOption("approve_once", "Approve once", "Grant these permissions for this turn."),
        approvalOption("approve_for_session", "Approve for session", "Grant these permissions for this session."),
        approvalOption("deny", "Deny", "Continue without granting these permissions.")
      ]
    };
  }
  return null;
}

function approvalOption(decision: string, label: string, description: string): Record<string, string> {
  return { decision, label, description };
}

function projection(
  notification: JsonRpcNotification,
  eventIdentity: AppServerEventIdentity,
  status: SessionStatus | null,
  transient: boolean,
  message: Omit<ChatMessage, "sessionId" | "sequence"> | null
): AppServerEventProjection {
  return {
    identity: eventIdentity,
    method: notification.method,
    status,
    transient,
    message,
    payload: notification.params
  };
}

function completedItemMessage(
  eventIdentity: AppServerEventIdentity,
  item: Record<string, unknown>,
  timestamp: string,
  notification: JsonRpcNotification
): Omit<ChatMessage, "sessionId" | "sequence"> | null {
  const type = string(item.type);
  const mapped = completedItemContent(type, item);
  if (!mapped || !mapped.text) return null;
  const identityPayload = { ...eventIdentity };
  return {
    id: stableProjectionId(eventIdentity, type ?? "unknown"),
    type: mapped.type,
    role: mapped.role,
    timestamp,
    text: mapped.text,
    payload: {
      source: "codex_app_server",
      method: notification.method,
      codexItemIdentity: identityPayload,
      appServerIdentity: identityPayload,
      item
    }
  };
}

function completedItemContent(
  type: string | null,
  item: Record<string, unknown>
): Pick<ChatMessage, "type" | "role" | "text"> | null {
  if (type === "userMessage") {
    const text = inputText(item.content);
    return text ? { type: "user", role: "user", text } : null;
  }
  if (type === "agentMessage") {
    const text = string(item.text);
    return text ? { type: "assistant", role: "assistant", text } : null;
  }
  if (type === "plan") {
    const text = string(item.text);
    return text ? { type: "assistant", role: "assistant", text: proposedPlan(text) } : null;
  }
  if (type === "reasoning") {
    const text = stringArray(item.summary).join("\n");
    return text ? { type: "assistant_update", role: "assistant", text } : null;
  }
  if (type === "commandExecution") {
    const command = string(item.command) ?? "Command";
    const output = string(item.aggregatedOutput);
    return { type: "command_output", role: "tool", text: output ? `${command}\n${output}` : command };
  }
  if (type === "fileChange") {
    return { type: "tool_output", role: "tool", text: `File change ${string(item.status) ?? "completed"}` };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = string(item.tool) ?? "Tool";
    const output = item.result ?? item.error ?? item.contentItems;
    return { type: "tool_output", role: "tool", text: output === undefined || output === null ? tool : `${tool}\n${jsonText(output)}` };
  }
  if (type === "collabAgentToolCall") {
    return { type: "tool_output", role: "tool", text: `Agent ${string(item.tool) ?? "operation"}: ${string(item.status) ?? "completed"}` };
  }
  if (type === "subAgentActivity") {
    return { type: "status", role: "system", text: `Subagent ${string(item.kind) ?? "activity"}: ${string(item.agentPath) ?? string(item.agentThreadId) ?? "unknown"}` };
  }
  return null;
}

function threadStatus(value: unknown): SessionStatus {
  const status = record(value);
  const type = string(status?.type);
  if (type === "idle") return "idle";
  if (type === "systemError" || type === "notLoaded") return "unknown";
  if (type !== "active") return "unknown";
  const flags = stringArray(status?.activeFlags);
  if (flags.includes("waitingOnApproval")) return "approval";
  if (flags.includes("waitingOnUserInput")) return "question";
  return "working";
}

function completedTurnStatus(turn: Record<string, unknown> | null): SessionStatus {
  if (turn?.status === "completed") {
    const hasPlan = Array.isArray(turn.items) && turn.items.some((item) => record(item)?.type === "plan");
    return hasPlan ? "plan_ready" : "idle";
  }
  if (turn?.status === "interrupted" || turn?.status === "failed") return "waiting";
  return "unknown";
}

function itemStatus(item: Record<string, unknown> | null, started: boolean): SessionStatus | null {
  const type = string(item?.type);
  if (type === "agentMessage") return "generating";
  if (type === "plan") return started ? "planning" : "plan_ready";
  if (type === "commandExecution") {
    const processId = string(item?.processId);
    return started && processId ? "running" : "executing";
  }
  if (type === "fileChange" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "collabAgentToolCall") {
    return "working";
  }
  return null;
}

function identity(
  threadId: string,
  turnId: string | null,
  itemId: string | null,
  clientMessageId: string | null
): AppServerEventIdentity {
  return { threadId, turnId, itemId, clientMessageId };
}

function stableProjectionId(eventIdentity: AppServerEventIdentity, itemType: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["codex_app_server", eventIdentity.threadId, eventIdentity.turnId, eventIdentity.itemId, itemType]))
    .digest("hex");
}

function stableServerRequestId(
  eventIdentity: AppServerEventIdentity,
  method: string,
  requestId: string | number
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "codex_app_server_request",
      eventIdentity.threadId,
      eventIdentity.turnId,
      eventIdentity.itemId,
      method,
      typeof requestId,
      requestId
    ]))
    .digest("hex");
}

function proposedPlan(text: string): string {
  return text.includes("<proposed_plan>") ? text : `<proposed_plan>\n${text}\n</proposed_plan>`;
}

function inputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const input = record(part);
    return string(input?.text) ?? "";
  }).filter(Boolean).join("\n");
}

function millisecondTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return "[unserializable output]"; }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  return value;
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const parts = stringArrayOrNull(value);
  return parts?.join(" ") ?? null;
}

function jsonRpcRequestId(value: unknown): string | number | null {
  if (typeof value === "string" && value.length > 0) return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
