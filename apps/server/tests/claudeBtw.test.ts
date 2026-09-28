import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ManagedSession } from "@muxpilot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBtwEngine } from "../src/providers/claude/btw.js";
import type { BtwGenerationListener, BtwGenerationRequest } from "../src/providers/shared/btw.js";
import { fakeQueryFactory, flush } from "./helpers/claudeFakes.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function session(model: string | null = "claude-sonnet"): ManagedSession {
  return {
    id: "session-1",
    cwd: "/repo/worktree",
    models: { default: { model, reasoningEffort: "high" }, plan: { model, reasoningEffort: "high" } }
  } as unknown as ManagedSession;
}

function request(overrides: Partial<BtwGenerationRequest> = {}): BtwGenerationRequest {
  return {
    session: session(),
    sourceThreadId: "thread-1",
    question: "What is this repo?",
    documentsRoot: null,
    sourceCwd: "/repo/worktree",
    documentsUnavailable: false,
    signal: new AbortController().signal,
    ...overrides
  };
}

function listener() {
  const events: string[] = [];
  const value: BtwGenerationListener = {
    delta: vi.fn((text: string) => { events.push(`delta:${text}`); }),
    completed: vi.fn(() => { events.push("completed"); }),
    interrupted: vi.fn(() => { events.push("interrupted"); }),
    failed: vi.fn((message: string) => { events.push(`failed:${message}`); }),
    closed: vi.fn((message: string) => { events.push(`closed:${message}`); })
  };
  return { value, events };
}

function engine() {
  const queries = fakeQueryFactory();
  const btw = new ClaudeBtwEngine({ claudePath: "/usr/bin/claude", configDir: "/cfg", environment: { HOME: "/home/u" }, queryFactory: queries.factory });
  return { btw, queries };
}

const stream = (event: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", uuid: "s", session_id: "x", parent_tool_use_id: parent, event });
const textStart = () => stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const textDelta = (text: string, parent: string | null = null) => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent);
const success = { type: "result", subtype: "success", is_error: false, result: "done", uuid: "r", session_id: "x" };

describe("ClaudeBtwEngine", () => {
  it("runs an unpersisted fork of the session with read-only tools", async () => {
    const { btw, queries } = engine();
    await btw.generate(request(), listener().value);
    const query = queries.latest();
    expect(query.options).toMatchObject({
      cwd: "/repo/worktree",
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      env: { HOME: "/home/u", CLAUDE_CONFIG_DIR: "/cfg" },
      resume: "thread-1",
      forkSession: true,
      persistSession: false,
      model: "claude-sonnet",
      effort: "low",
      tools: ["Read", "Grep", "Glob"],
      settingSources: [],
      permissionMode: "default",
      maxTurns: 24,
      systemPrompt: { type: "preset", preset: "claude_code", snapshot: false }
    });
    expect(query.options).not.toHaveProperty("additionalDirectories");
    expect((query.options.systemPrompt as { append: string }).append).toContain("strictly read-only");
    await flush();
    expect(query.prompts).toEqual([{ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "What is this repo?" }] } }]);

    await btw.generate(request({ session: session(null) }), listener().value);
    expect(queries.latest().options).not.toHaveProperty("model");
  });

  it("streams top-level text deltas with blank lines between text blocks, then completes", async () => {
    const { btw, queries } = engine();
    const { value, events } = listener();
    await btw.generate(request(), value);
    const query = queries.latest();
    query.push(textStart());
    query.push(textDelta("Hello"));
    query.push(textDelta(""));
    query.push(textDelta("subagent text", "tool-1"));
    query.push({ type: "assistant", uuid: "a", session_id: "x", parent_tool_use_id: null, message: { role: "assistant", content: [] } });
    query.push(textStart());
    query.push(textDelta("World"));
    query.push(success);
    await flush();
    expect(events).toEqual(["delta:Hello", "delta:\n\n", "delta:World", "completed"]);
  });

  it("reports failed results", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...success, is_error: true, result: "API Error:   overloaded" }, "failed:API Error: overloaded"],
      [{ type: "result", subtype: "error_max_turns", is_error: true, errors: [] }, "failed:Claude reached the BTW turn limit before answering."],
      [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["a", "b"] }, "failed:a b"],
      [{ type: "result", subtype: "error_during_execution", is_error: true, errors: [] }, "failed:Claude could not answer this BTW question."]
    ];
    for (const [result, expected] of cases) {
      const { btw, queries } = engine();
      const { value, events } = listener();
      await btw.generate(request(), value);
      queries.latest().push(result);
      await flush();
      expect(events).toEqual([expected]);
    }
  });

  it("fails when the query ends or throws without a result", async () => {
    const ended = engine();
    const endedListener = listener();
    await ended.btw.generate(request(), endedListener.value);
    ended.queries.latest().end();
    await flush();
    expect(endedListener.events).toEqual(["failed:Claude stopped before answering this BTW question."]);

    const thrown = engine();
    const thrownListener = listener();
    await thrown.btw.generate(request(), thrownListener.value);
    thrown.queries.latest().fail(new Error("spawn claude ENOENT"));
    await flush();
    expect(thrownListener.events).toEqual(["failed:spawn claude ENOENT"]);
  });

  it("reports interrupted after interrupt or an aborted request signal", async () => {
    const { btw, queries } = engine();
    const { value, events } = listener();
    const generation = await btw.generate(request(), value);
    const query = queries.latest();
    await generation.interrupt();
    expect((query.options.abortController as AbortController).signal.aborted).toBe(true);
    query.push(success);
    await flush();
    expect(events).toEqual(["interrupted"]);

    const second = engine();
    const secondListener = listener();
    const controller = new AbortController();
    await second.btw.generate(request({ signal: controller.signal }), secondListener.value);
    controller.abort();
    second.queries.latest().fail(new Error("aborted by user"));
    await flush();
    expect(secondListener.events).toEqual(["interrupted"]);

    const third = engine();
    const thirdListener = listener();
    await third.btw.generate(request(), thirdListener.value);
    third.btw.stop();
    third.queries.latest().fail(new Error("Operation aborted"));
    await flush();
    expect(thirdListener.events).toEqual(["interrupted"]);
  });

  it("does not start a query when the request was already cancelled", async () => {
    const { btw, queries } = engine();
    const controller = new AbortController();
    controller.abort();
    const generation = await btw.generate(request({ signal: controller.signal }), listener().value);
    expect(queries.queries).toHaveLength(0);
    await expect(generation.dispose()).resolves.toBeUndefined();
  });

  it("stops calling the listener after disposal", async () => {
    const { btw, queries } = engine();
    const { value, events } = listener();
    const generation = await btw.generate(request(), value);
    const query = queries.latest();
    query.push(textDelta("before"));
    await flush();
    await generation.dispose();
    query.push(textDelta("after"));
    query.push(success);
    await flush();
    expect(events).toEqual(["delta:before"]);
    expect((query.options.abortController as AbortController).signal.aborted).toBe(true);
  });

  it("allows only read tools without a documents root", async () => {
    const { btw, queries } = engine();
    await btw.generate(request(), listener().value);
    const canUseTool = queries.latest().options.canUseTool as CanUseTool;
    const options = {} as Parameters<CanUseTool>[2];
    await expect(canUseTool("Read", { file_path: "/etc/hosts" }, options)).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "/etc/hosts" } });
    await expect(canUseTool("Grep", { pattern: "x" }, options)).resolves.toMatchObject({ behavior: "allow" });
    await expect(canUseTool("Write", { file_path: "/repo/worktree/a.md" }, options)).resolves.toEqual({ behavior: "deny", message: "BTW answers cannot use this tool." });
    await expect(canUseTool("Bash", { command: "ls" }, options)).resolves.toMatchObject({ behavior: "deny" });
  });

  it("confines document writes to the documents root", async () => {
    const base = mkdtempSync(join(tmpdir(), "muxpilot-claude-btw-"));
    temporary.push(base);
    const documentsRoot = join(base, "docs");
    mkdirSync(documentsRoot);
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(documentsRoot, "link"));

    const { btw, queries } = engine();
    await btw.generate(request({ documentsRoot }), listener().value);
    const query = queries.latest();
    expect(query.options).toMatchObject({ tools: ["Read", "Grep", "Glob", "Write", "Edit"], additionalDirectories: [documentsRoot] });
    expect((query.options.systemPrompt as { append: string }).append).toContain(JSON.stringify(documentsRoot));
    const canUseTool = query.options.canUseTool as CanUseTool;
    const options = {} as Parameters<CanUseTool>[2];
    await expect(canUseTool("Write", { file_path: join(documentsRoot, "NOTES.md") }, options)).resolves.toMatchObject({ behavior: "allow" });
    await expect(canUseTool("Edit", { file_path: join(documentsRoot, "sub", "INDEX.md") }, options)).resolves.toMatchObject({ behavior: "allow" });
    const denied = { behavior: "deny", message: `BTW answers may only write inside ${documentsRoot}.` };
    await expect(canUseTool("Write", { file_path: "/repo/worktree/src/a.ts" }, options)).resolves.toEqual(denied);
    await expect(canUseTool("Write", { file_path: join(documentsRoot, "..", "escape.md") }, options)).resolves.toEqual(denied);
    await expect(canUseTool("Write", { file_path: join(documentsRoot, "link", "escape.md") }, options)).resolves.toEqual(denied);
    await expect(canUseTool("Edit", {}, options)).resolves.toEqual(denied);
    await expect(canUseTool("MultiEdit", { file_path: join(documentsRoot, "a.md") }, options)).resolves.toEqual({ behavior: "deny", message: "BTW answers cannot use this tool." });
  });

  it("notes unavailable documents in read-only instructions", async () => {
    const { btw, queries } = engine();
    await btw.generate(request({ documentsUnavailable: true }), listener().value);
    expect((queries.latest().options.systemPrompt as { append: string }).append).toContain("Document editing is unavailable");
  });
});
