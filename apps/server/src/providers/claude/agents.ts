import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, SessionAgent } from "@muxpilot/core";
import { stableProjectionId } from "./events.js";
import type { HostAgent } from "./host/protocol.js";
import { claudeRecordMessages, type ClaudeToolUse } from "./messages.js";
import { sessionDirectory } from "./transcriptArchive.js";

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AGENT_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export function sessionAgent(agent: HostAgent): SessionAgent {
  return {
    id: agent.taskId,
    toolUseId: agent.toolUseId,
    kind: agentKind(agent.taskType),
    agentType: agent.subagentType,
    description: agent.description,
    status: agent.status,
    background: agent.backgrounded,
    depth: agent.depth,
    lastToolName: agent.lastToolName,
    summary: agent.summary,
    error: agent.error,
    usage: agent.usage,
    ambient: agent.ambient,
    startedAt: agent.startedAt,
    updatedAt: agent.updatedAt
  };
}

/**
 * Subagents recorded on disk (`<session>/subagents/agent-<id>.meta.json`), for sessions whose runtime is not running
 * or whose host no longer remembers them. Live host state wins for agents present in both.
 */
export async function recordedAgents(transcriptPath: string | null): Promise<SessionAgent[]> {
  if (!transcriptPath) return [];
  const directory = join(sessionDirectory(transcriptPath), "subagents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const agents: SessionAgent[] = [];
  for (const name of names) {
    const match = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
    if (!match) continue;
    const id = match[1]!;
    const meta = await readFile(join(directory, `agent-${id}.meta.json`), "utf8")
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => ({} as Record<string, unknown>));
    const info = await stat(join(directory, name)).catch(() => null);
    const timestamp = (info?.mtime ?? new Date(0)).toISOString();
    agents.push({
      id,
      toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null,
      kind: "subagent",
      agentType: typeof meta.agentType === "string" ? meta.agentType : null,
      description: typeof meta.description === "string" && meta.description.trim() ? meta.description : `Subagent ${id}`,
      status: "completed",
      background: meta.requestShape === "background",
      depth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : null,
      lastToolName: null,
      summary: null,
      error: null,
      usage: null,
      ambient: false,
      startedAt: (info?.birthtime ?? info?.mtime ?? new Date(0)).toISOString(),
      updatedAt: timestamp
    });
  }
  return agents.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** Live agents first-class, recorded ones filling in agents the host has forgotten. */
export function mergeAgents(live: SessionAgent[], recorded: SessionAgent[]): SessionAgent[] {
  const known = new Set(live.map((agent) => agent.id));
  return [...recorded.filter((agent) => !known.has(agent.id)), ...live]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

/** A subagent's conversation, parsed from its own transcript with the same mapping as the main transcript. */
export async function agentTranscriptMessages(
  sessionId: string,
  threadId: string,
  transcriptPath: string,
  agentId: string
): Promise<ChatMessage[]> {
  if (!AGENT_ID.test(agentId)) throw new Error("Invalid agent id");
  const path = join(sessionDirectory(transcriptPath), "subagents", `agent-${agentId}.jsonl`);
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.size > MAX_AGENT_TRANSCRIPT_BYTES) throw new Error("Agent transcript is too large to display");
  const toolUses: Record<string, ClaudeToolUse> = {};
  const messages: ChatMessage[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    rememberToolUses(record, toolUses);
    for (const mapped of claudeRecordMessages(record, toolUses, { includeSidechain: true })) {
      messages.push({
        id: stableProjectionId(threadId, `agent:${agentId}:${mapped.itemId}`, mapped.type),
        sessionId,
        sequence: messages.length + 1,
        type: mapped.type,
        role: mapped.role,
        timestamp: typeof record.timestamp === "string" ? record.timestamp : info.mtime.toISOString(),
        text: mapped.text,
        payload: { ...mapped.payload, agentId }
      });
    }
  }
  return messages;
}

function rememberToolUses(record: Record<string, unknown>, toolUses: Record<string, ClaudeToolUse>): void {
  if (record.type !== "assistant") return;
  const message = record.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolUses[block.id] = { name: block.name, input: block.input };
    }
  }
}

function agentKind(taskType: string | null): SessionAgent["kind"] {
  if (taskType === "local_agent" || taskType === "remote_agent" || taskType === null) return "subagent";
  if (taskType === "local_bash") return "shell";
  if (taskType === "monitor") return "monitor";
  if (taskType === "local_workflow") return "workflow";
  return "other";
}
