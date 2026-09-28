import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, SessionContextUsage } from "@muxpilot/core";
import type { ParseResult } from "../codex/parser.js";
import { claudeProjectSlug } from "./host/protocol.js";
import { CLAUDE_TRANSCRIPT_SOURCE, claudeRecordMessages, type ClaudeToolUse } from "./messages.js";
import { itemIdentity, stableProjectionId } from "./events.js";

export const CLAUDE_PARSER_VERSION = "claude-jsonl-v1";
const BATCH_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const USAGE_CARRY_WINDOW_BYTES = 256 * 1024;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;

export interface ClaudeTranscriptContext {
  threadId: string | null;
  /** Usage recorded before `offset`; lifetime totals continue from it. */
  previousContextUsage: SessionContextUsage | null;
}

/**
 * Incrementally parses a Claude Code session transcript. Records share uuids with the live SDK stream, so
 * messages carry the same item identity as live projections and deduplicate against them.
 */
export async function parseClaudeJsonl(path: string, offset: number, context: ClaudeTranscriptContext): Promise<ParseResult> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    // Claude Code creates the transcript with the session's first message; until then there is nothing to read.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { messages: [], nextOffset: offset, pendingSkillNames: [], notices: [], complete: true, contextUsage: null };
  }
  try {
    const size = (await file.stat()).size;
    const start = Math.min(offset, size);
    let length = Math.min(BATCH_BYTES, size - start);
    let buffer = Buffer.alloc(0);
    let lastNewline = -1;
    while (length > 0) {
      buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      buffer = buffer.subarray(0, bytesRead);
      lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline >= 0 || start + length >= size) break;
      if (length >= MAX_RECORD_BYTES) throw new Error(`Claude transcript record exceeds ${MAX_RECORD_BYTES} bytes`);
      length = Math.min(length * 2, size - start);
    }
    const consumed = lastNewline >= 0 ? lastNewline + 1 : 0;
    const text = buffer.subarray(0, consumed).toString("utf8");
    const nextOffset = start + consumed;
    const carriedMessageId = start > 0 ? await lastAssistantMessageId(file, start) : null;
    const parsed = parseRecords(text.split("\n").filter(Boolean), context, offset === 0, carriedMessageId);
    return {
      messages: parsed.messages,
      nextOffset,
      pendingSkillNames: [],
      notices: parsed.notices,
      complete: nextOffset >= size,
      contextUsage: parsed.contextUsage
    };
  } finally {
    await file.close();
  }
}

/**
 * Claude Code writes one record per content block, repeating the API message's usage on each. The last main-chain
 * assistant message before `offset` was already counted by the previous parse, so records continuing it after the
 * offset must not count its usage again.
 */
async function lastAssistantMessageId(file: FileHandle, offset: number): Promise<string | null> {
  const length = Math.min(offset, USAGE_CARRY_WINDOW_BYTES);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset - length);
  const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
  // Unless the window starts at the file start, its first line may be a fragment of a longer record.
  if (length < offset) lines.shift();
  for (const line of lines.reverse()) {
    if (!line.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "assistant" || record.isSidechain === true) continue;
      return string(objectValue(record.message)?.id);
    } catch {
      continue;
    }
  }
  return null;
}

function parseRecords(lines: string[], context: ClaudeTranscriptContext, fromStart: boolean, carriedMessageId: string | null) {
  const messages: Omit<ChatMessage, "sessionId" | "sequence">[] = [];
  const notices: string[] = [];
  const toolUses: Record<string, ClaudeToolUse> = {};
  const usage = new UsageAccumulator(fromStart ? null : context.previousContextUsage, carriedMessageId);
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      notices.push("Skipped an unreadable Claude transcript record.");
      continue;
    }
    if (record.type !== "assistant" && record.type !== "user") continue;
    const threadId = string(record.sessionId) ?? context.threadId;
    if (!threadId) continue;
    if (record.type === "assistant") {
      rememberToolUses(record, toolUses);
      if (record.isSidechain !== true) usage.observe(record);
    }
    const timestamp = string(record.timestamp) ?? new Date(0).toISOString();
    for (const mapped of claudeRecordMessages(record, toolUses)) {
      messages.push({
        id: stableProjectionId(threadId, mapped.itemId, mapped.type),
        type: mapped.type,
        role: mapped.role,
        timestamp,
        text: mapped.text,
        payload: {
          source: CLAUDE_TRANSCRIPT_SOURCE,
          codexItemIdentity: itemIdentity(threadId, mapped.itemId, null),
          ...mapped.payload
        }
      });
    }
  }
  return { messages, notices, contextUsage: usage.result() };
}

function rememberToolUses(record: Record<string, unknown>, toolUses: Record<string, ClaudeToolUse>): void {
  const content = objectValue(record.message)?.content;
  if (!Array.isArray(content)) return;
  for (const value of content) {
    const block = objectValue(value);
    if (block?.type === "tool_use" && string(block.id)) toolUses[block.id as string] = { name: string(block.name) ?? "Tool", input: block.input };
  }
}

/** Derives muxpilot context usage from Claude assistant usage, counting each API message once. */
class UsageAccumulator {
  private readonly seen = new Set<string>();
  private latest: { active: number; window: number } | null = null;
  private input: number;
  private cached: number;
  private output: number;
  private changed = false;

  constructor(private readonly previous: SessionContextUsage | null, carriedMessageId: string | null) {
    // Continuing totals already include the carried message; a from-scratch parse must count it.
    if (previous && carriedMessageId) this.seen.add(carriedMessageId);
    this.input = previous?.lifetimeInputTokens ?? 0;
    this.cached = previous?.lifetimeCachedInputTokens ?? 0;
    this.output = previous?.lifetimeOutputTokens ?? 0;
  }

  observe(record: Record<string, unknown>): void {
    const message = objectValue(record.message);
    const usage = objectValue(message?.usage);
    const messageId = string(message?.id);
    if (!usage || !messageId || this.seen.has(messageId)) return;
    this.seen.add(messageId);
    const input = number(usage.input_tokens);
    const cacheRead = number(usage.cache_read_input_tokens);
    const cacheCreation = number(usage.cache_creation_input_tokens);
    const output = number(usage.output_tokens);
    this.input += input + cacheRead + cacheCreation;
    this.cached += cacheRead;
    this.output += output;
    const model = string(message?.model) ?? "";
    const active = input + cacheRead + cacheCreation + output;
    const window = /\[1m\]|1m/i.test(model) || active > DEFAULT_CONTEXT_WINDOW_TOKENS
      ? EXTENDED_CONTEXT_WINDOW_TOKENS
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.latest = { active, window };
    this.changed = true;
  }

  result(): SessionContextUsage | null {
    if (!this.changed) return null;
    const active = this.latest?.active ?? this.previous?.activeTokens ?? 0;
    const window = this.latest?.window ?? this.previous?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    return {
      activeTokens: active,
      contextWindowTokens: window,
      contextPercent: window > 0 ? Math.min(100, (active / window) * 100) : 0,
      lifetimeInputTokens: this.input,
      lifetimeCachedInputTokens: this.cached,
      lifetimeOutputTokens: this.output,
      lifetimeReasoningTokens: 0,
      lifetimeTotalTokens: this.input + this.output,
      // Work tokens exclude cache reads, matching how delegated budgets count Codex usage.
      lifetimeWorkTokens: this.input - this.cached + this.output,
      sampledAt: new Date().toISOString()
    };
  }
}

/** Expected transcript path for a session, or the first match anywhere under the projects root. */
export async function locateClaudeTranscript(configDir: string, sessionId: string, cwd: string | null): Promise<string | null> {
  const projects = join(configDir, "projects");
  if (cwd) {
    const expected = join(projects, claudeProjectSlug(cwd), `${sessionId}.jsonl`);
    if (await isFile(expected)) return expected;
  }
  const directories = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const candidate = join(projects, directory.name, `${sessionId}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((value) => value.isFile()).catch(() => false);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
