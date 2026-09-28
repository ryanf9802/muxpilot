import type { ChatMessage, SessionStatus, TranscriptTaskList } from "@muxpilot/core";

/**
 * Sentinel turn id for Claude item identities. Live events and transcript records agree on record uuids but not
 * on muxpilot turn ids, so live/transcript deduplication keys on `(thread, CLAUDE_ITEM_TURN, uuid)`.
 */
export const CLAUDE_ITEM_TURN = "claude";

export const CLAUDE_LIVE_SOURCE = "claude_host";
export const CLAUDE_TRANSCRIPT_SOURCE = "claude_transcript";

/** Tools whose calls are represented by muxpilot interactions rather than transcript tool rows. */
const INTERACTION_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_TOOL_TEXT = 20_000;

export interface ClaudeToolUse {
  name: string;
  input: unknown;
}

/** A transcript-visible message derived from one Claude record, independent of whether it arrived live. */
export interface ClaudeRecordMessage {
  itemId: string;
  type: ChatMessage["type"];
  role: ChatMessage["role"];
  text: string;
  status: SessionStatus | null;
  payload: Record<string, unknown>;
}

/**
 * Converts an SDK message or transcript record (assistant/user) into muxpilot messages. `toolUses` resolves tool
 * results to the call that produced them; without it, results are classified from their structured output.
 */
export function claudeRecordMessages(
  record: Record<string, unknown>,
  toolUses: Record<string, ClaudeToolUse> = {}
): ClaudeRecordMessage[] {
  const uuid = string(record.uuid);
  if (!uuid) return [];
  if (string(record.parent_tool_use_id) || record.isSidechain === true || record.isMeta === true) return [];
  const message = objectValue(record.message);
  const content = message?.content;
  if (record.type === "assistant") return assistantMessages(uuid, Array.isArray(content) ? content : []);
  if (record.type === "user") {
    // Prompts Claude Code injects itself (background task notifications and similar) are not operator input.
    const systemPrompt = record.promptSource === "system";
    return userMessages(uuid, content, objectValue(record.tool_use_result ?? record.toolUseResult), toolUses, systemPrompt);
  }
  return [];
}

function assistantMessages(uuid: string, blocks: unknown[]): ClaudeRecordMessage[] {
  const results: ClaudeRecordMessage[] = [];
  blocks.forEach((value, index) => {
    const block = objectValue(value);
    if (!block) return;
    const itemId = blocks.length > 1 ? `${uuid}:${index}` : uuid;
    if (block.type === "text") {
      const text = string(block.text)?.trim();
      if (text) results.push({ itemId, type: "assistant", role: "assistant", text, status: "generating", payload: {} });
      return;
    }
    if (block.type === "thinking") {
      const text = string(block.thinking)?.trim();
      if (text) results.push({ itemId, type: "reasoning", role: "assistant", text, status: "generating", payload: {} });
      return;
    }
    if (block.type === "tool_use") {
      const name = string(block.name) ?? "Tool";
      if (name === "ExitPlanMode") {
        const plan = string(objectValue(block.input)?.plan)?.trim();
        const toolUseId = string(block.id);
        if (plan && toolUseId) {
          results.push({
            itemId: planItemId(toolUseId),
            type: "assistant",
            role: "assistant",
            text: plan.includes("<proposed_plan>") ? plan : `<proposed_plan>\n${plan}\n</proposed_plan>`,
            status: "planning",
            payload: {}
          });
        }
        return;
      }
      if (INTERACTION_TOOLS.has(name)) return;
      results.push(toolCallMessage(itemId, name, objectValue(block.input) ?? {}, string(block.id)));
    }
  });
  return results;
}

function toolCallMessage(itemId: string, name: string, input: Record<string, unknown>, toolUseId: string | null): ClaudeRecordMessage {
  const base = { itemId, type: "tool_call" as const, role: "tool" as const, payload: { toolName: name, toolUseId, input } };
  if (name === "Bash") {
    const command = string(input.command) ?? "command";
    return { ...base, text: command, status: "executing" };
  }
  if (FILE_TOOLS.has(name)) {
    const path = string(input.file_path) ?? string(input.notebook_path) ?? "file";
    return { ...base, text: `${name} ${path}`, status: "working" };
  }
  if (name === "TodoWrite") {
    const taskList = todoTaskList(input.todos);
    return {
      ...base,
      text: taskList.items.map((item) => `${taskMarker(item.status)} ${item.text}`).join("\n") || "Task list updated",
      status: "working",
      payload: { ...base.payload, taskList }
    };
  }
  if (name === "Task" || name === "Agent") {
    const description = string(input.description) ?? string(input.subagent_type) ?? "delegated task";
    return { ...base, text: `Subagent: ${description}`, status: "working" };
  }
  return { ...base, text: `${name}${summarizeInput(input)}`, status: "working" };
}

function userMessages(
  uuid: string,
  content: unknown,
  toolUseResult: Record<string, unknown> | null,
  toolUses: Record<string, ClaudeToolUse>,
  systemPrompt = false
): ClaudeRecordMessage[] {
  if (typeof content === "string") {
    if (systemPrompt) return [];
    const text = content.trim();
    return text && !isHarnessText(text) ? [{ itemId: uuid, type: "user", role: "user", text, status: null, payload: {} }] : [];
  }
  if (!Array.isArray(content)) return [];
  const toolResults = content.map(objectValue).filter((block): block is Record<string, unknown> => block?.type === "tool_result");
  if (toolResults.length === 0) {
    if (systemPrompt) return [];
    const text = content.map(objectValue).flatMap((block) => block?.type === "text" && string(block.text) ? [string(block.text)!] : [])
      .join("\n").trim();
    return text && !isHarnessText(text) ? [{ itemId: uuid, type: "user", role: "user", text, status: null, payload: {} }] : [];
  }
  return toolResults.flatMap((block, index) => {
    const toolUseId = string(block.tool_use_id);
    const toolUse = toolUseId ? toolUses[toolUseId] : undefined;
    const itemId = toolResults.length > 1 ? `${uuid}:${index}` : uuid;
    return toolResultMessage(itemId, toolUseId, toolUse, block, toolResults.length === 1 ? toolUseResult : null);
  });
}

function toolResultMessage(
  itemId: string,
  toolUseId: string | null,
  toolUse: ClaudeToolUse | undefined,
  block: Record<string, unknown>,
  structured: Record<string, unknown> | null
): ClaudeRecordMessage[] {
  const name = toolUse?.name ?? inferToolName(structured);
  if (name && INTERACTION_TOOLS.has(name)) return [];
  const isError = block.is_error === true;
  const resultText = toolResultText(block.content);
  const payload: Record<string, unknown> = { toolName: name, toolUseId, ...(isError ? { error: true } : {}) };
  if (name === "Bash") {
    const input = objectValue(toolUse?.input);
    const command = string(input?.command) ?? "Command";
    const stdout = string(structured?.stdout) ?? "";
    const stderr = string(structured?.stderr) ?? "";
    const output = (stdout || stderr) ? [stdout, stderr].filter(Boolean).join("\n") : resultText;
    return [{
      itemId,
      type: "command_output",
      role: "tool",
      text: truncate(output ? `${command}\n${output}` : command),
      status: null,
      payload
    }];
  }
  if (name && FILE_TOOLS.has(name)) {
    const path = string(structured?.filePath) ?? string(objectValue(toolUse?.input)?.file_path) ?? "file";
    return [{
      itemId,
      type: "tool_output",
      role: "tool",
      text: isError ? truncate(`File change failed: ${path}\n${resultText}`) : `File change completed: ${path}`,
      status: null,
      payload: { ...payload, ...(Array.isArray(structured?.structuredPatch) ? { patch: structured.structuredPatch } : {}) }
    }];
  }
  if (name === "TodoWrite") return [];
  return [{
    itemId,
    type: "tool_output",
    role: "tool",
    text: truncate(name ? `${name}\n${resultText}`.trim() : resultText || "Tool result"),
    status: null,
    payload
  }];
}

/** Item identity of a proposed plan, shared by the ExitPlanMode record and the host's plan notification. */
export function planItemId(toolUseId: string): string {
  return `plan:${toolUseId}`;
}

/** Maps TodoWrite items to muxpilot's provider-neutral task list. */
export function todoTaskList(value: unknown): TranscriptTaskList {
  const todos = Array.isArray(value) ? value : [];
  return {
    items: todos.flatMap((entry) => {
      const todo = objectValue(entry);
      const text = string(todo?.content) ?? string(todo?.activeForm);
      if (!text) return [];
      const status = todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending";
      return [{ text, status }];
    })
  };
}

function inferToolName(structured: Record<string, unknown> | null): string | null {
  if (!structured) return null;
  if ("stdout" in structured || "stderr" in structured) return "Bash";
  if (typeof structured.filePath === "string" && ("structuredPatch" in structured || "originalFile" in structured)) return "Edit";
  if (Array.isArray(structured.newTodos) || Array.isArray(structured.oldTodos)) return "TodoWrite";
  if (Array.isArray(structured.questions) && structured.answers) return "AskUserQuestion";
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((entry) => {
    const block = objectValue(entry);
    if (block?.type === "text" && typeof block.text === "string") return [block.text];
    if (block?.type === "image") return ["[image]"];
    return [];
  }).join("\n");
}

function isHarnessText(text: string): boolean {
  return /^\[Request interrupted by user/.test(text)
    || text.startsWith("<command-name>")
    || text.startsWith("<task-notification>")
    || text.startsWith("<local-command-")
    || text.startsWith("Caveat: The messages below were generated");
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(([, value]) => typeof value === "string" || typeof value === "number");
  if (entries.length === 0) return "";
  const text = entries.slice(0, 3).map(([key, value]) => `${key}: ${String(value).slice(0, 200)}`).join(", ");
  return ` (${text})`;
}

function taskMarker(status: string): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… [truncated]` : text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
