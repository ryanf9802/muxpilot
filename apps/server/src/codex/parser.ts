import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { appendSkillNamesToText, normalizeSubagentNotificationText, normalizeUserContextText } from "@muxpilot/core";
import type { ApprovalKind, ApprovalRequest, ChatMessage, CollaborationMode, MessageType, QuestionRequest } from "@muxpilot/core";

export const PARSER_VERSION = "codex-jsonl-v1";

interface RawEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & {
    type?: string;
    role?: string;
    name?: string;
    call_id?: string;
    output?: string;
    message?: string;
    content?: unknown;
    arguments?: string;
    collaboration_mode_kind?: string;
    collaboration_mode?: unknown;
  };
}

type ParsedApproval = Omit<ApprovalRequest, "sessionId" | "messageId">;
type ParsedQuestion = Omit<QuestionRequest, "sessionId" | "messageId">;

export interface ParseResult {
  messages: Omit<ChatMessage, "sessionId" | "sequence">[];
  nextOffset: number;
  pendingSkillNames: string[];
  complete: boolean;
}

export async function parseCodexJsonl(path: string, offset: number): Promise<ParseResult> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (offset > stat.size) offset = 0;
    const length = Math.max(0, stat.size - offset);
    if (length === 0) return { messages: [], nextOffset: offset, pendingSkillNames: [], complete: true };
    const buffer = Buffer.allocUnsafe(Math.min(length, 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const parsed = parseCodexJsonlChunk(chunk, offset);
    return { ...parsed, complete: parsed.nextOffset >= stat.size };
  } finally {
    await file.close();
  }
}

function parseCodexJsonlChunk(chunk: string, offset: number): Omit<ParseResult, "complete"> {
  const lines = chunk.split("\n");
  const completeLines = chunk.endsWith("\n") ? lines.slice(0, -1) : lines.slice(0, -1);
  let consumed = offset;
  const messages: Omit<ChatMessage, "sessionId" | "sequence">[] = [];
  const pendingSkillNames: string[] = [];
  let collaborationMode: CollaborationMode | null = null;

  for (const line of completeLines) {
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    collaborationMode = collaborationModeFromLine(line) ?? collaborationMode;
    const standaloneSkillNames = standaloneSkillContextNames(line);
    if (standaloneSkillNames.length > 0) {
      if (!mergeSkillNamesIntoPreviousUserMessage(messages, standaloneSkillNames)) {
        mergeSkillNames(pendingSkillNames, standaloneSkillNames);
      }
      continue;
    }
    const mapped = mapEvent(line, collaborationMode);
    if (mapped && !isDuplicateUserEcho(mapped, messages)) messages.push(mapped);
  }

  return { messages, nextOffset: consumed, pendingSkillNames };
}

export async function parseCodexJsonlFromStart(path: string): Promise<Omit<ChatMessage, "sessionId" | "sequence">[]> {
  const result = await parseCodexJsonl(path, 0);
  return result.messages;
}

function mapEvent(line: string, collaborationMode: CollaborationMode | null): Omit<ChatMessage, "sessionId" | "sequence"> | null {
  let event: RawEvent;
  try {
    event = JSON.parse(line) as RawEvent;
  } catch {
    return null;
  }

  const timestamp = event.timestamp ?? new Date().toISOString();
  const payloadType = event.payload?.type;
  const topType = event.type;
  const approval = extractApproval(event, timestamp);
  const question = extractQuestion(event, timestamp);

  if (approval) {
    return approvalMessage(timestamp, approval, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (question) {
    return questionMessage(timestamp, question, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "event_msg" && payloadType === "user_message") {
    const rawMessage = String(event.payload?.message ?? "");
    const subagentNotification = normalizeSubagentNotificationText(rawMessage);
    if (subagentNotification) {
      return message(
        "status",
        "system",
        timestamp,
        subagentNotification.text,
        { ...(event as unknown as Record<string, unknown>), subagentNotification },
        collaborationMode
      );
    }
    return userMessageFromText(rawMessage, timestamp, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "event_msg" && payloadType === "agent_message") {
    return message(
      "assistant_update",
      "assistant",
      timestamp,
      String(event.payload?.message ?? ""),
      event as unknown as Record<string, unknown>,
      collaborationMode
    );
  }

  if (topType === "response_item" && payloadType === "function_call") {
    const command = event.payload?.name ? `${event.payload.name}(${event.payload.arguments ?? ""})` : "Tool call";
    return message("tool_call", "tool", timestamp, command, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "response_item" && payloadType === "custom_tool_call") {
    const input = stringValue(event.payload?.input) ?? "";
    const command = event.payload?.name ? `${event.payload.name}(${input})` : "Tool call";
    return message("tool_call", "tool", timestamp, command, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "response_item" && payloadType === "function_call_output") {
    const output = String(event.payload?.output ?? "");
    const type: MessageType = output.includes("Process exited with code") ? "command_output" : "tool_output";
    return message(type, "tool", timestamp, output, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "event_msg" && payloadType && payloadType !== "token_count") {
    return message("status", "system", timestamp, payloadType, event as unknown as Record<string, unknown>, collaborationMode);
  }

  if (topType === "response_item" && payloadType === "message") {
    const role = event.payload?.role;
    if (role === "assistant" || role === "user") {
      const text = contentToText(event.payload?.content);
      if (!text) return null;
      if (role === "user") return userMessageFromText(text, timestamp, event as unknown as Record<string, unknown>, collaborationMode);
      return message(role, role, timestamp, text, event as unknown as Record<string, unknown>, collaborationMode);
    }
  }

  return null;
}

function userMessageFromText(
  text: string,
  timestamp: string,
  payload: Record<string, unknown>,
  collaborationMode: CollaborationMode | null
): Omit<ChatMessage, "sessionId" | "sequence"> | null {
  const normalized = normalizeUserContextText(text);
  if (normalized.kind === "action") return message("status", "system", timestamp, normalized.text, payload, collaborationMode);
  if (normalized.kind === "hidden") return null;
  return message("user", "user", timestamp, normalized.text, payload, collaborationMode);
}

function isDuplicateUserEcho(
  message: Omit<ChatMessage, "sessionId" | "sequence">,
  messages: Omit<ChatMessage, "sessionId" | "sequence">[]
): boolean {
  if (message.role !== "user") return false;
  const previousUser = findPreviousUserMessage(messages);
  if (!previousUser || !userEchoTextMatches(previousUser.text, message.text)) return false;
  return (
    isResponseItemUserMessage(message) !== isResponseItemUserMessage(previousUser) &&
    timestampsAreNear(previousUser.timestamp, message.timestamp)
  );
}

function userEchoTextMatches(first: string, second: string): boolean {
  if (first === second) return true;
  return normalizeImageEchoText(first) === normalizeImageEchoText(second);
}

function normalizeImageEchoText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function findPreviousUserMessage(
  messages: Omit<ChatMessage, "sessionId" | "sequence">[]
): Omit<ChatMessage, "sessionId" | "sequence"> | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

function isResponseItemUserMessage(message: Omit<ChatMessage, "sessionId" | "sequence">): boolean {
  const payload = message.payload;
  const item = recordValue(payload.payload);
  return payload.type === "response_item" && item?.type === "message" && item.role === "user";
}

function timestampsAreNear(first: string, second: string): boolean {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return first === second;
  return Math.abs(firstMs - secondMs) <= 5_000;
}

function extractApproval(event: RawEvent, timestamp: string): ParsedApproval | null {
  if (event.type === "response_item" && event.payload?.type === "function_call") {
    return approvalFromFunctionCall(event, timestamp);
  }

  if (event.type === "response_item" && event.payload?.type === "custom_tool_call") {
    return approvalFromCustomToolCall(event, timestamp);
  }

  if (event.type !== "event_msg") return null;

  if (event.payload?.type === "exec_approval_request") {
    return approvalFromEventPayload("command", "Command approval required", event.payload, timestamp);
  }

  if (event.payload?.type === "apply_patch_approval_request") {
    return approvalFromEventPayload("patch", "Patch approval required", event.payload, timestamp);
  }

  return null;
}

function approvalFromCustomToolCall(event: RawEvent, timestamp: string): ParsedApproval | null {
  if (event.payload?.name !== "exec") return null;
  const input = stringValue(event.payload.input);
  if (!input || !/tools\.exec_command\s*\(/.test(input)) return null;
  if (!/["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/.test(input)) return null;

  const command = quotedJsProperty(input, "cmd") ?? quotedJsProperty(input, "command");
  const prefixRule = quotedJsArrayProperty(input, "prefix_rule");
  return {
    id: stringValue(event.payload.call_id) ?? approvalId(`${timestamp}:exec:${command ?? ""}`),
    kind: "command",
    title: "Command approval required",
    command,
    toolName: "exec_command",
    cwd: quotedJsProperty(input, "workdir") ?? quotedJsProperty(input, "cwd"),
    reason: quotedJsProperty(input, "justification"),
    prefixRule,
    options: approvalOptions(prefixRule),
    createdAt: timestamp
  };
}

function quotedJsProperty(input: string, name: string): string | null {
  const match = input.match(
    new RegExp(`(?:^|[,{]\\s*)["']?${name}["']?\\s*:\\s*(["'])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`)
  );
  if (!match?.[2]) return null;
  return match[2].replace(/\\([\\'"`])/g, "$1");
}

function quotedJsArrayProperty(input: string, name: string): string[] | null {
  const match = input.match(new RegExp(`(?:^|[,{]\\s*)["']?${name}["']?\\s*:\\s*\\[([^\\]]*)\\]`, "s"));
  if (!match?.[1]) return null;
  const values = [...match[1].matchAll(/(["'])((?:\\.|(?!\1)[\s\S])*?)\1/g)]
    .map((item) => item[2]?.replace(/\\([\\'"`])/g, "$1") ?? "")
    .filter(Boolean);
  return values.length > 0 ? values : null;
}

function approvalFromFunctionCall(event: RawEvent, timestamp: string): ParsedApproval | null {
  const args = parseJsonObject(event.payload?.arguments);
  if (!args) return null;

  const sandbox = stringValue(args.sandbox_permissions);
  if (sandbox !== "require_escalated") return null;

  const toolName = stringValue(event.payload?.name);
  const command = commandText(args.cmd) ?? commandText(args.command);
  const kind: ApprovalKind = toolName === "apply_patch" ? "patch" : toolName === "exec_command" ? "command" : "tool";
  const title = kind === "command" ? "Command approval required" : kind === "patch" ? "Patch approval required" : "Tool approval required";
  const id = stringValue(event.payload?.call_id) ?? approvalId(`${timestamp}:${toolName ?? ""}:${command ?? ""}`);

  return {
    id,
    kind,
    title,
    command,
    toolName,
    cwd: stringValue(args.cwd),
    reason: stringValue(args.justification),
    prefixRule: stringArray(args.prefix_rule),
    options: approvalOptions(stringArray(args.prefix_rule)),
    createdAt: timestamp
  };
}

function approvalFromEventPayload(
  kind: ApprovalKind,
  title: string,
  payload: Record<string, unknown>,
  timestamp: string
): ParsedApproval {
  const id =
    stringValue(payload.approval_id) ??
    stringValue(payload.approvalId) ??
    stringValue(payload.call_id) ??
    stringValue(payload.callId) ??
    approvalId(`${timestamp}:${payload.type ?? ""}:${JSON.stringify(payload).slice(0, 200)}`);

  const prefixRule = prefixRuleFromPayload(payload);
  return {
    id,
    kind,
    title,
    command: commandText(payload.command) ?? commandText(payload.execve),
    toolName: stringValue(payload.tool_name) ?? stringValue(payload.toolName),
    cwd: stringValue(payload.cwd),
    reason: stringValue(payload.reason) ?? stringValue(payload.justification),
    prefixRule,
    options: approvalOptions(prefixRule),
    createdAt: timestamp
  };
}

function approvalOptions(prefixRule: string[] | null): ParsedApproval["options"] {
  return [
    { decision: "approve_once", label: "Approve once", description: "Run this tool call and continue." },
    ...(prefixRule
      ? [{ decision: "approve_for_prefix" as const, label: "Always allow prefix", description: "Remember this command prefix." }]
      : []),
    { decision: "deny", label: "Deny", description: "Cancel this tool call." }
  ];
}

function approvalMessage(
  timestamp: string,
  approval: ParsedApproval,
  payload: Record<string, unknown>,
  collaborationMode: CollaborationMode | null
): Omit<ChatMessage, "sessionId" | "sequence"> {
  const subject = approval.command ?? approval.toolName ?? approval.title;
  const lines = [`${approval.title}: ${subject}`];
  if (approval.cwd) lines.push(`cwd: ${approval.cwd}`);
  if (approval.reason) lines.push(`reason: ${approval.reason}`);
  if (approval.prefixRule?.length) lines.push(`prefix: ${approval.prefixRule.join(" ")}`);
  return message("approval_request", "system", timestamp, lines.join("\n"), { ...payload, approval }, collaborationMode);
}

function extractQuestion(event: RawEvent, timestamp: string): ParsedQuestion | null {
  if (event.type !== "response_item" || event.payload?.type !== "function_call") return null;
  const toolName = stringValue(event.payload.name);
  if (toolName !== "request_user_input" && toolName !== "functions.request_user_input") return null;

  const args = parseJsonObject(event.payload.arguments);
  if (!args) return null;

  const questions = questionPrompts(args.questions);
  if (!questions) return null;

  const autoResolutionMs = numberValue(args.autoResolutionMs);
  const expiresAt = autoResolutionMs === null ? null : timestampPlusMs(timestamp, autoResolutionMs);
  const id = stringValue(event.payload.call_id) ?? approvalId(`${timestamp}:${toolName}:${JSON.stringify(args).slice(0, 200)}`);

  return {
    id,
    questions,
    autoResolutionMs,
    createdAt: timestamp,
    expiresAt,
    countdownStartedAt: null,
    countdownExpiresAt: null
  };
}

function questionPrompts(value: unknown): ParsedQuestion["questions"] | null {
  if (!Array.isArray(value)) return null;
  const questions = value.map(questionPrompt).filter((item): item is ParsedQuestion["questions"][number] => Boolean(item));
  return questions.length > 0 ? questions : null;
}

function questionPrompt(value: unknown): ParsedQuestion["questions"][number] | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const question = stringValue(value.question);
  if (!id || !question) return null;
  return {
    id,
    header: stringValue(value.header) ?? "",
    question,
    options: questionOptions(value.options)
  };
}

function questionOptions(value: unknown): ParsedQuestion["questions"][number]["options"] {
  if (!Array.isArray(value)) return [];
  return value.map(questionOption).filter((item): item is ParsedQuestion["questions"][number]["options"][number] => Boolean(item));
}

function questionOption(value: unknown): ParsedQuestion["questions"][number]["options"][number] | null {
  if (!isRecord(value)) return null;
  const label = stringValue(value.label);
  if (!label) return null;
  return {
    label,
    description: stringValue(value.description) ?? ""
  };
}

function questionMessage(
  timestamp: string,
  question: ParsedQuestion,
  payload: Record<string, unknown>,
  collaborationMode: CollaborationMode | null
): Omit<ChatMessage, "sessionId" | "sequence"> {
  const lines = ["Question requested"];
  for (const prompt of question.questions) {
    const label = prompt.header ? `${prompt.header}: ${prompt.question}` : prompt.question;
    lines.push(label);
  }
  return message("question_request", "system", timestamp, lines.join("\n"), { ...payload, question }, collaborationMode);
}

function message(
  type: MessageType,
  role: ChatMessage["role"],
  timestamp: string,
  text: string,
  payload: Record<string, unknown>,
  collaborationMode: CollaborationMode | null = null
): Omit<ChatMessage, "sessionId" | "sequence"> {
  const id = createHash("sha256").update(`${timestamp}:${type}:${text}`).digest("hex");
  return {
    id,
    type,
    role,
    timestamp,
    text: cleanText(text),
    payload: payloadWithCollaborationMode(payload, collaborationMode)
  };
}

function collaborationModeFromLine(line: string): CollaborationMode | null {
  let event: RawEvent;
  try {
    event = JSON.parse(line) as RawEvent;
  } catch {
    return null;
  }
  return collaborationModeFromEvent(event);
}

function collaborationModeFromEvent(event: RawEvent): CollaborationMode | null {
  if (event.type === "event_msg" && event.payload?.type === "task_started") {
    return collaborationModeValue(event.payload.collaboration_mode_kind);
  }
  if (event.type === "turn_context") {
    return collaborationModeValue(recordValue(event.payload?.collaboration_mode)?.mode);
  }
  return null;
}

function collaborationModeValue(value: unknown): CollaborationMode | null {
  if (value === "default" || value === "plan") return value;
  return null;
}

function payloadWithCollaborationMode(
  payload: Record<string, unknown>,
  collaborationMode: CollaborationMode | null
): Record<string, unknown> {
  if (!collaborationMode) return payload;
  return { ...payload, collaborationMode };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (item && typeof item === "object" && "text" in item) {
        return String((item as { text: unknown }).text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function standaloneSkillContextNames(line: string): string[] {
  let event: RawEvent;
  try {
    event = JSON.parse(line) as RawEvent;
  } catch {
    return [];
  }

  if (event.type !== "event_msg" || event.payload?.type !== "user_message") return [];
  const rawMessage = String(event.payload.message ?? "");
  const normalized = normalizeUserContextText(rawMessage);
  return normalized.kind === "hidden" ? normalized.skillNames : [];
}

function mergeSkillNamesIntoPreviousUserMessage(
  messages: Omit<ChatMessage, "sessionId" | "sequence">[],
  names: string[]
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current || current.role !== "user") continue;
    const nextText = appendSkillNamesToText(current.text, names);
    current.text = nextText;
    current.id = createHash("sha256").update(`${current.timestamp}:${current.type}:${nextText}`).digest("hex");
    return true;
  }
  return false;
}

export function appendSkillNamesForDisplay(text: string, names: string[]): string {
  return appendSkillNamesToText(text, names);
}

function mergeSkillNames(current: string[], incoming: string[]): string[] {
  for (const name of incoming) {
    if (name && !current.includes(name)) current.push(name);
  }
  return current;
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function commandText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  if (isRecord(value)) {
    return commandText(value.argv) ?? commandText(value.command) ?? commandText(value.cmd);
  }
  return null;
}

function prefixRuleFromPayload(payload: Record<string, unknown>): string[] | null {
  const direct = stringArray(payload.prefix_rule) ?? stringArray(payload.prefixRule);
  if (direct) return direct;

  const amendment = recordValue(payload.proposed_execpolicy_amendment) ?? recordValue(payload.proposedExecpolicyAmendment);
  if (amendment) return stringArray(amendment.command) ?? stringArray(amendment.pattern);

  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function timestampPlusMs(timestamp: string, ms: number): string | null {
  const start = new Date(timestamp).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + ms).toISOString();
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function approvalId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function cleanText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}
