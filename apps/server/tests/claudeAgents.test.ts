import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionAgent } from "@muxpilot/core";
import { agentTranscriptMessages, mergeAgents, recordedAgents, sessionAgent } from "../src/providers/claude/agents.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muxpilot-claude-agents-"));
  roots.push(root);
  const transcriptPath = join(root, `${THREAD}.jsonl`);
  writeFileSync(transcriptPath, "");
  const subagents = join(root, THREAD, "subagents");
  mkdirSync(subagents, { recursive: true });
  return { transcriptPath, subagents };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude agents", () => {
  it("lists subagents recorded on disk with their metadata", async () => {
    const { transcriptPath, subagents } = fixture();
    writeFileSync(join(subagents, "agent-abc.jsonl"), "");
    writeFileSync(join(subagents, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", description: "Map the parser", toolUseId: "tu-1", spawnDepth: 1, requestShape: "background" }));
    writeFileSync(join(subagents, "agent-def.jsonl"), "");
    writeFileSync(join(subagents, "notes.txt"), "");
    const agents = await recordedAgents(transcriptPath);
    expect(agents.map(({ id, agentType, description, toolUseId, background, status }) => ({ id, agentType, description, toolUseId, background, status }))).toEqual(expect.arrayContaining([
      { id: "abc", agentType: "Explore", description: "Map the parser", toolUseId: "tu-1", background: true, status: "completed" },
      { id: "def", agentType: null, description: "Subagent def", toolUseId: null, background: false, status: "completed" }
    ]));
    expect(await recordedAgents(null)).toEqual([]);
    expect(await recordedAgents(join(tmpdir(), "missing-session.jsonl"))).toEqual([]);
  });

  it("prefers live host state over recorded agents", () => {
    const recorded = { id: "abc", status: "completed", startedAt: "2026-09-27T12:00:00.000Z" } as SessionAgent;
    const live = sessionAgent({
      taskId: "abc", toolUseId: "tu-1", taskType: "local_agent", subagentType: "Explore", description: "Map", status: "running",
      backgrounded: true, depth: 1, lastToolName: "Read", summary: "Reading", error: null, usage: null, ambient: false,
      startedAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:01.000Z"
    });
    expect(live).toMatchObject({ id: "abc", kind: "subagent", agentType: "Explore", background: true });
    expect(mergeAgents([live], [recorded, { ...recorded, id: "old", startedAt: "2026-09-27T11:00:00.000Z" }]).map((agent) => [agent.id, agent.status]))
      .toEqual([["old", "completed"], ["abc", "running"]]);
    expect(sessionAgent({ ...live as never, taskId: "s", taskType: "local_bash" } as never).kind).toBe("shell");
  });

  it("reads a subagent transcript, including its sidechain records", async () => {
    const { transcriptPath, subagents } = fixture();
    const lines = [
      { type: "user", uuid: "u1", isSidechain: true, agentId: "abc", timestamp: "2026-09-27T12:00:00.000Z", message: { role: "user", content: "Map the parser" } },
      { type: "assistant", uuid: "a1", isSidechain: true, agentId: "abc", timestamp: "2026-09-27T12:00:01.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "/repo/a.ts" } }] } },
      { type: "user", uuid: "u2", isSidechain: true, agentId: "abc", timestamp: "2026-09-27T12:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-read", content: "export {}" }] } },
      { type: "assistant", uuid: "a2", isSidechain: true, agentId: "abc", timestamp: "2026-09-27T12:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "The parser is fine." }] } }
    ];
    writeFileSync(join(subagents, "agent-abc.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
    const messages = await agentTranscriptMessages("session-1", THREAD, transcriptPath, "abc");
    expect(messages.map(({ type, text, sequence }) => ({ type, text, sequence }))).toEqual([
      { type: "user", text: "Map the parser", sequence: 1 },
      { type: "tool_call", text: "Read (file_path: /repo/a.ts)", sequence: 2 },
      { type: "tool_output", text: "Read\nexport {}", sequence: 3 },
      { type: "assistant", text: "The parser is fine.", sequence: 4 }
    ]);
    expect(messages[0]!.payload).toMatchObject({ agentId: "abc" });
    await expect(agentTranscriptMessages("session-1", THREAD, transcriptPath, "missing")).resolves.toEqual([]);
    await expect(agentTranscriptMessages("session-1", THREAD, transcriptPath, "../escape")).rejects.toThrow("Invalid agent id");
  });
});
