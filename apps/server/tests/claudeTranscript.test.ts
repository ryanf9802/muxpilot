import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { itemIdentity, stableProjectionId } from "../src/providers/claude/events.js";
import { locateClaudeTranscript, parseClaudeJsonl } from "../src/providers/claude/transcript.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "muxpilot-claude-transcript-"));
  temporary.push(path);
  return path;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function assistantRecord(uuid: string, messageId: string, content: unknown[], usage: Record<string, number> | null, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
    sessionId: SESSION,
    timestamp: "2026-09-27T12:00:01.000Z",
    message: { id: messageId, role: "assistant", model: "claude-opus-4", content, ...(usage ? { usage } : {}) },
    ...extra
  };
}

const USER = { type: "user", uuid: "u1", sessionId: SESSION, timestamp: "2026-09-27T12:00:00.000Z", message: { role: "user", content: "Run the tests" } };
const TOOL_CALL = assistantRecord("a1", "msg-1", [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } }], {
  input_tokens: 10,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 100,
  output_tokens: 50
});
// Claude Code writes one record per content block; blocks of the same API message repeat its usage.
const TEXT_SAME_MESSAGE = assistantRecord("a2", "msg-1", [{ type: "text", text: "Running tests" }], {
  input_tokens: 10,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 100,
  output_tokens: 50
});
const TOOL_RESULT = {
  type: "user",
  uuid: "u2",
  sessionId: SESSION,
  timestamp: "2026-09-27T12:00:02.000Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
  toolUseResult: { stdout: "3 passed", stderr: "" }
};
const SIDECHAIN = assistantRecord("s1", "msg-side", [{ type: "text", text: "subagent" }], { input_tokens: 5_000, output_tokens: 5_000 }, { isSidechain: true });
const FINAL = assistantRecord("a3", "msg-2", [{ type: "text", text: "All tests passed." }], {
  input_tokens: 20,
  cache_read_input_tokens: 1_200,
  cache_creation_input_tokens: 0,
  output_tokens: 30
});

describe("parseClaudeJsonl", () => {
  it("parses messages with live-compatible identities and skips non-message records", async () => {
    const path = join(tempDir(), `${SESSION}.jsonl`);
    writeFileSync(path, [
      line({ type: "summary", summary: "x" }),
      line(USER),
      "not json\n",
      line(TOOL_CALL),
      line(TEXT_SAME_MESSAGE),
      line(TOOL_RESULT),
      line(SIDECHAIN),
      line(FINAL)
    ].join(""));

    const result = await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null });
    expect(result.complete).toBe(true);
    expect(result.pendingSkillNames).toEqual([]);
    expect(result.notices).toEqual(["Skipped an unreadable Claude transcript record."]);
    expect(result.messages.map(({ type, text, timestamp }) => ({ type, text, timestamp }))).toEqual([
      { type: "user", text: "Run the tests", timestamp: "2026-09-27T12:00:00.000Z" },
      { type: "tool_call", text: "npm test", timestamp: "2026-09-27T12:00:01.000Z" },
      { type: "assistant", text: "Running tests", timestamp: "2026-09-27T12:00:01.000Z" },
      { type: "command_output", text: "npm test\n3 passed", timestamp: "2026-09-27T12:00:02.000Z" },
      { type: "assistant", text: "All tests passed.", timestamp: "2026-09-27T12:00:01.000Z" }
    ]);
    expect(result.messages[0]).toMatchObject({
      id: stableProjectionId(SESSION, "u1", "user"),
      payload: { source: "claude_transcript", codexItemIdentity: itemIdentity(SESSION, "u1", null) }
    });

    // Each API message counts once; sidechain usage is excluded.
    expect(result.contextUsage).toMatchObject({
      activeTokens: 20 + 1_200 + 30,
      contextWindowTokens: 200_000,
      lifetimeInputTokens: (10 + 1_000 + 100) + (20 + 1_200),
      lifetimeCachedInputTokens: 2_200,
      lifetimeOutputTokens: 80,
      lifetimeReasoningTokens: 0,
      lifetimeTotalTokens: 1_110 + 1_220 + 80,
      lifetimeWorkTokens: 1_110 + 1_220 - 2_200 + 80
    });
    expect(result.contextUsage!.contextPercent).toBeCloseTo((1_250 / 200_000) * 100);
  });

  it("parses incrementally from an offset, holding back a partial trailing record", async () => {
    const path = join(tempDir(), `${SESSION}.jsonl`);
    const firstChunk = line(USER) + line(TOOL_CALL);
    const partial = line(TOOL_RESULT);
    writeFileSync(path, firstChunk + partial.slice(0, 20));

    const first = await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null });
    expect(first.nextOffset).toBe(Buffer.byteLength(firstChunk));
    expect(first.complete).toBe(false);
    expect(first.messages.map((message) => message.type)).toEqual(["user", "tool_call"]);

    appendFileSync(path, partial.slice(20) + line(FINAL));
    const second = await parseClaudeJsonl(path, first.nextOffset, { threadId: null, previousContextUsage: first.contextUsage });
    expect(second.complete).toBe(true);
    // The tool call lies before the offset, so the result is classified from its structured output.
    expect(second.messages.map(({ type, text }) => ({ type, text }))).toEqual([
      { type: "command_output", text: "Command\n3 passed" },
      { type: "assistant", text: "All tests passed." }
    ]);
    // Lifetime totals continue from the previous usage.
    expect(second.contextUsage).toMatchObject({
      activeTokens: 1_250,
      lifetimeInputTokens: 1_110 + 1_220,
      lifetimeCachedInputTokens: 2_200,
      lifetimeOutputTokens: 80
    });

    const idle = await parseClaudeJsonl(path, second.nextOffset, { threadId: null, previousContextUsage: second.contextUsage });
    expect(idle).toMatchObject({ messages: [], complete: true, contextUsage: null, nextOffset: second.nextOffset });
  });

  it("does not recount an API message whose content blocks straddle the parse offset", async () => {
    const path = join(tempDir(), `${SESSION}.jsonl`);
    writeFileSync(path, line(USER) + line(TOOL_CALL));
    const first = await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null });
    expect(first.contextUsage).toMatchObject({ lifetimeInputTokens: 1_110, lifetimeOutputTokens: 50 });

    appendFileSync(path, line(TEXT_SAME_MESSAGE));
    const second = await parseClaudeJsonl(path, first.nextOffset, { threadId: null, previousContextUsage: first.contextUsage });
    expect(second.messages.map((message) => message.text)).toEqual(["Running tests"]);
    // Nothing new was used, so the previous usage stands.
    expect(second.contextUsage).toBeNull();

    appendFileSync(path, line(TOOL_RESULT) + line(FINAL));
    const third = await parseClaudeJsonl(path, second.nextOffset, { threadId: null, previousContextUsage: first.contextUsage });
    expect(third.contextUsage).toMatchObject({ lifetimeInputTokens: 1_110 + 1_220, lifetimeOutputTokens: 80 });
  });

  it("ignores previous usage when reparsing from the start", async () => {
    const path = join(tempDir(), `${SESSION}.jsonl`);
    writeFileSync(path, line(FINAL));
    const result = await parseClaudeJsonl(path, 0, {
      threadId: null,
      previousContextUsage: {
        activeTokens: 1,
        contextWindowTokens: 1,
        contextPercent: 100,
        lifetimeInputTokens: 999_999,
        lifetimeCachedInputTokens: 0,
        lifetimeOutputTokens: 999_999,
        lifetimeReasoningTokens: 0,
        lifetimeTotalTokens: 0,
        lifetimeWorkTokens: 0,
        sampledAt: "2026-09-27T00:00:00.000Z"
      }
    });
    expect(result.contextUsage).toMatchObject({ lifetimeInputTokens: 1_220, lifetimeOutputTokens: 30 });
  });

  it("uses the extended context window for 1M models or oversized contexts", async () => {
    const path = join(tempDir(), `${SESSION}.jsonl`);
    writeFileSync(path, line({
      ...FINAL,
      message: { ...FINAL.message, model: "claude-opus-4[1m]" }
    }));
    expect((await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null })).contextUsage?.contextWindowTokens).toBe(1_000_000);
    writeFileSync(path, line({ ...FINAL, message: { ...FINAL.message, id: "big", usage: { input_tokens: 250_000, output_tokens: 1 } } }));
    expect((await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null })).contextUsage).toMatchObject({
      contextWindowTokens: 1_000_000,
      activeTokens: 250_001
    });
  });

  it("falls back to the context thread id for records without a session id", async () => {
    const path = join(tempDir(), "x.jsonl");
    writeFileSync(path, line({ type: "user", uuid: "u9", message: { role: "user", content: "hi" } }));
    expect((await parseClaudeJsonl(path, 0, { threadId: null, previousContextUsage: null })).messages).toEqual([]);
    const [message] = (await parseClaudeJsonl(path, 0, { threadId: "fallback", previousContextUsage: null })).messages;
    expect(message).toMatchObject({ id: stableProjectionId("fallback", "u9", "user"), timestamp: new Date(0).toISOString() });
  });
});

describe("locateClaudeTranscript", () => {
  it("finds the expected project path first, then searches every project", async () => {
    const config = tempDir();
    const expectedDir = join(config, "projects", "-repo");
    mkdirSync(expectedDir, { recursive: true });
    writeFileSync(join(expectedDir, `${SESSION}.jsonl`), "");
    expect(await locateClaudeTranscript(config, SESSION, "/repo")).toBe(join(expectedDir, `${SESSION}.jsonl`));

    const otherDir = join(config, "projects", "-elsewhere");
    mkdirSync(otherDir);
    writeFileSync(join(otherDir, "other.jsonl"), "");
    expect(await locateClaudeTranscript(config, "other", "/repo")).toBe(join(otherDir, "other.jsonl"));
    expect(await locateClaudeTranscript(config, "missing", null)).toBeNull();
    expect(await locateClaudeTranscript(join(config, "absent"), "missing", null)).toBeNull();
  });
});
