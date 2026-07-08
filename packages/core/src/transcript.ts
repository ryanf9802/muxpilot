import type { ChatMessage, TranscriptItem } from "./types.js";
import { appendSkillNamesToText, normalizeSubagentNotificationText, normalizeUserContextText } from "./userContext.js";

type InternalTranscriptItem =
  | { type: "message"; message: ChatMessage }
  | { type: "user_action"; message: ChatMessage }
  | { type: "stack"; messages: ChatMessage[] }
  | { type: "activity"; messages: ChatMessage[] };

export function buildTranscriptItems(messages: ChatMessage[]): TranscriptItem[] {
  return groupTurnActivity(messages).map(toTranscriptItem);
}

export function buildExpandedTranscriptItems(messages: ChatMessage[]): TranscriptItem[] {
  return groupEventStackItems(displayMessages(messages)).flatMap((item) => {
    if (item.type === "stack") return item.messages.map((message) => messageToTranscriptItem(message));
    return [toTranscriptItem(item)];
  });
}

export function transcriptMessages(items: TranscriptItem[]): ChatMessage[] {
  return items.flatMap((item) => (item.type === "message" || item.type === "user_action" ? [item.message] : []));
}

export function itemFirstSequence(item: TranscriptItem): number {
  return item.firstSequence;
}

export function itemLastSequence(item: TranscriptItem): number {
  return item.lastSequence;
}

function groupTurnActivity(messages: ChatMessage[]): InternalTranscriptItem[] {
  const items: InternalTranscriptItem[] = [];
  let turnMessages: ChatMessage[] = [];
  let looseMessages: ChatMessage[] = [];
  let hasPrompt = false;

  function flushLooseMessages() {
    if (looseMessages.length === 0) return;
    items.push(...groupLooseActivityItems(looseMessages));
    looseMessages = [];
  }

  function flushTurnMessages() {
    if (!hasPrompt) {
      flushLooseMessages();
      return;
    }
    appendTurnActivity(items, turnMessages);
    turnMessages = [];
    hasPrompt = false;
  }

  for (const message of displayMessages(messages)) {
    if (isUserActionMessage(message)) {
      if (hasPrompt) flushTurnMessages();
      else flushLooseMessages();
      items.push({ type: "user_action", message });
      continue;
    }

    if (isStandaloneActionMessage(message)) {
      if (hasPrompt) {
        appendTurnActivity(items, turnMessages);
        turnMessages = [];
      } else {
        flushLooseMessages();
      }
      items.push({ type: "message", message });
      continue;
    }

    if (message.role === "user") {
      if (hasPrompt) flushTurnMessages();
      else flushLooseMessages();
      items.push({ type: "message", message });
      hasPrompt = true;
      continue;
    }

    if (hasPrompt) turnMessages.push(message);
    else looseMessages.push(message);
  }

  if (hasPrompt) flushTurnMessages();
  else flushLooseMessages();
  return items;
}

function groupEventStackItems(messages: ChatMessage[]): InternalTranscriptItem[] {
  const items: InternalTranscriptItem[] = [];
  let stack: ChatMessage[] = [];

  for (const message of messages) {
    if (isUserActionMessage(message)) {
      flushStack(items, stack);
      stack = [];
      items.push({ type: "user_action", message });
      continue;
    }

    if (isStackableMessage(message)) {
      stack.push(message);
      continue;
    }

    flushStack(items, stack);
    stack = [];
    items.push({ type: "message", message });
  }

  flushStack(items, stack);
  return items;
}

function groupLooseActivityItems(messages: ChatMessage[]): InternalTranscriptItem[] {
  const visibleIndex = latestVisibleAssistantIndex(messages);
  if (visibleIndex < 0) return groupEventStackItems(messages);

  const items: InternalTranscriptItem[] = [];
  const beforeVisible = messages.slice(0, visibleIndex);
  const visibleMessage = messages[visibleIndex];
  const afterVisible = messages.slice(visibleIndex + 1);

  pushActivity(items, beforeVisible);
  if (visibleMessage) items.push({ type: "message", message: visibleMessage });
  items.push(...groupEventStackItems(afterVisible));
  return items;
}

function appendTurnActivity(items: InternalTranscriptItem[], messages: ChatMessage[]): void {
  if (messages.length === 0) return;
  const visibleIndex = latestVisibleAssistantIndex(messages);
  if (visibleIndex < 0) {
    pushActivity(items, messages);
    return;
  }
  const beforeVisible = messages.slice(0, visibleIndex);
  const visibleMessage = messages[visibleIndex];
  const afterVisible = messages.slice(visibleIndex + 1);

  pushActivity(items, beforeVisible);
  if (visibleMessage) items.push({ type: "message", message: visibleMessage });
  items.push(...groupEventStackItems(afterVisible));
}

function latestVisibleAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isRegularAssistantMessage(message)) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAssistantUpdate(message)) return index;
  }
  return -1;
}

function pushActivity(items: InternalTranscriptItem[], messages: ChatMessage[]): void {
  const activityMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (isStandaloneActionMessage(message)) {
      pushActivityChunk(items, activityMessages);
      activityMessages.length = 0;
      items.push({ type: "message", message });
      continue;
    }
    activityMessages.push(message);
  }

  pushActivityChunk(items, activityMessages);
}

function pushActivityChunk(items: InternalTranscriptItem[], messages: ChatMessage[]): void {
  if (messages.length === 0) return;
  items.push({ type: "activity", messages });
}

function flushStack(items: InternalTranscriptItem[], stack: ChatMessage[]): void {
  if (stack.length === 0) return;
  items.push({ type: "stack", messages: stack });
}

function toTranscriptItem(item: InternalTranscriptItem): TranscriptItem {
  if (item.type === "message" || item.type === "user_action") return messageToTranscriptItem(item.message, item.type);
  const first = item.messages[0]!;
  const last = item.messages.at(-1) ?? first;
  return {
    type: "range",
    id: `${item.type}-${first.id}-${last.id}-${item.messages.length}`,
    rangeKind: item.type,
    label: item.type === "activity" ? activityLabel(item.messages) : stackLabel(item.messages),
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    messageCount: item.messages.length
  };
}

function messageToTranscriptItem(message: ChatMessage, type: "message" | "user_action" = "message"): TranscriptItem {
  return {
    type,
    id: message.id,
    message,
    firstSequence: message.sequence,
    lastSequence: message.sequence
  };
}

function displayMessages(messages: ChatMessage[]): ChatMessage[] {
  const visibleMessages: ChatMessage[] = [];
  for (const rawMessage of messages) {
    const normalized = rawMessage.role === "user" ? normalizeUserContextText(rawMessage.text) : null;
    if (normalized?.kind === "hidden" && normalized.skillNames.length > 0) {
      mergeSkillNamesIntoPreviousUserMessage(visibleMessages, normalized.skillNames);
      continue;
    }

    const message = displayMessage(rawMessage);
    if (message && replaceDuplicateAssistantUpdateResponse(visibleMessages, message)) continue;
    if (message) visibleMessages.push(message);
  }
  return visibleMessages;
}

function replaceDuplicateAssistantUpdateResponse(messages: ChatMessage[], message: ChatMessage): boolean {
  const previous = messages.at(-1);
  if (!previous || !isAssistantUpdate(previous) || !isRegularAssistantMessage(message)) return false;
  if (previous.text !== message.text) return false;
  messages[messages.length - 1] = message;
  return true;
}

function displayMessage(message: ChatMessage): ChatMessage | null {
  if (message.role !== "user") return message;
  const subagentNotification = normalizeSubagentNotificationText(message.text);
  if (subagentNotification) {
    return {
      ...message,
      role: "system",
      type: "status",
      text: subagentNotification.text,
      payload: { ...message.payload, subagentNotification }
    };
  }
  const normalized = normalizeUserContextText(message.text);
  if (normalized.kind === "action") return { ...message, role: "system", type: "status", text: normalized.text };
  if (normalized.kind === "hidden") return null;
  return normalized.text === message.text ? message : { ...message, text: normalized.text };
}

function isStackableMessage(message: ChatMessage): boolean {
  if (isStandaloneActionMessage(message)) return false;
  if (message.role === "tool" || message.role === "system") return true;
  if (isAssistantUpdate(message)) return true;
  return (
    message.type === "tool_call" ||
    message.type === "tool_output" ||
    message.type === "command_output" ||
    message.type === "status" ||
    message.type === "approval_request" ||
    message.type === "parser_notice"
  );
}

function isStandaloneActionMessage(message: ChatMessage): boolean {
  return message.type === "question_request";
}

function stackLabel(messages: ChatMessage[]): string {
  const counts = messages.reduce(
    (current, message) => {
      if (message.type === "command_output") current.command += 1;
      else if (message.type === "tool_call" || message.type === "tool_output") current.tool += 1;
      else if (isAssistantUpdate(message)) current.progress += 1;
      else if (isTurnAbortedStatus(message)) current.aborted += 1;
      else if (isSubagentMessage(message)) current.subagent += 1;
      else current.system += 1;
      return current;
    },
    { aborted: 0, command: 0, progress: 0, subagent: 0, system: 0, tool: 0 }
  );
  const parts = [
    counts.aborted ? `${counts.aborted} aborted` : "",
    counts.progress ? `${counts.progress} progress` : "",
    counts.command ? `${counts.command} command` : "",
    counts.tool ? `${counts.tool} tool` : "",
    counts.subagent ? `${counts.subagent} subagent` : "",
    counts.system ? `${counts.system} system` : ""
  ].filter(Boolean);
  return `${messages.length} ${messages.length === 1 ? "event" : "events"}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

function activityLabel(messages: ChatMessage[]): string {
  const assistantMessages = messages.filter(isRegularAssistantMessage).length;
  const events = messages.length - assistantMessages;
  if (assistantMessages > 0 && events > 0) {
    return `${messages.length} intermediate ${pluralize(messages.length, "item")}: ${assistantMessages} ${pluralize(
      assistantMessages,
      "message"
    )}, ${events} ${pluralize(events, "event")}`;
  }
  if (assistantMessages > 0) return `${assistantMessages} intermediate ${pluralize(assistantMessages, "message")}`;
  return `${events} intermediate ${pluralize(events, "event")}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function isRegularAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && !isAssistantUpdate(message);
}

function isUserActionMessage(message: ChatMessage): boolean {
  return isTurnAbortedStatus(message) || isInstructionsLoadedStatus(message);
}

function isTurnAbortedStatus(message: ChatMessage): boolean {
  return message.type === "status" && message.role === "system" && message.text === "Turn aborted";
}

function isInstructionsLoadedStatus(message: ChatMessage): boolean {
  if (message.type !== "status" || message.role !== "system") return false;
  return message.text === "Loaded repository instructions" || /^Loaded [^\n]+\.md instructions for [^\n]+$/i.test(message.text);
}

function isAssistantUpdate(message: ChatMessage): boolean {
  if (message.type === "assistant_update") return true;
  if (message.type !== "assistant" || message.role !== "assistant") return false;
  const payloadType = stringRecord(message.payload)?.type;
  const nestedPayload = stringRecord(message.payload?.payload);
  return payloadType === "event_msg" && nestedPayload?.type === "agent_message";
}

function isSubagentMessage(message: ChatMessage): boolean {
  return Boolean(stringRecord(message.payload)?.subagentNotification);
}

function mergeSkillNamesIntoPreviousUserMessage(messages: ChatMessage[], names: string[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current || current.role !== "user") continue;
    messages[index] = { ...current, text: appendSkillNamesToText(current.text, names) };
    return;
  }
}

function stringRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
