import { describe, expect, it } from "vitest";
import {
  claudeAuthenticationFailure,
  claudeProjectionAdapter,
  itemIdentity,
  projectClaudeEvent,
  stableProjectionId
} from "../src/providers/claude/events.js";
import { claudeRecordMessages, todoTaskList } from "../src/providers/claude/messages.js";

const THREAD = "thread-1";
const AT = "2026-09-27T12:00:00.000Z";

function assistant(uuid: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: "assistant", uuid, message: { role: "assistant", content }, ...extra };
}

function user(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "user", uuid, message: { role: "user", content }, ...extra };
}

describe("claudeRecordMessages", () => {
  it("maps assistant text, thinking, and tool calls with per-block item ids", () => {
    const messages = claudeRecordMessages(assistant("a1", [
      { type: "thinking", thinking: "  consider  " },
      { type: "text", text: " Answer " },
      { type: "text", text: "   " },
      { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls -la" } },
      { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/repo/a.ts" } },
      { type: "tool_use", id: "tu-3", name: "Task", input: { description: "review" } },
      { type: "tool_use", id: "tu-4", name: "WebFetch", input: { url: "https://x", prompt: "p", nested: { a: 1 } } },
      { type: "tool_use", id: "tu-5", name: "AskUserQuestion", input: {} }
    ]));
    expect(messages.map(({ itemId, type, role, text, status }) => ({ itemId, type, role, text, status }))).toEqual([
      { itemId: "a1:0", type: "reasoning", role: "assistant", text: "consider", status: "generating" },
      { itemId: "a1:1", type: "assistant", role: "assistant", text: "Answer", status: "generating" },
      { itemId: "a1:3", type: "tool_call", role: "tool", text: "ls -la", status: "executing" },
      { itemId: "a1:4", type: "tool_call", role: "tool", text: "Edit /repo/a.ts", status: "working" },
      { itemId: "a1:5", type: "tool_call", role: "tool", text: "Subagent: review", status: "working" },
      { itemId: "a1:6", type: "tool_call", role: "tool", text: "WebFetch (url: https://x, prompt: p)", status: "working" }
    ]);
    expect(messages[2]!.payload).toEqual({ toolName: "Bash", toolUseId: "tu-1", input: { command: "ls -la" } });
  });

  it("uses the record uuid as item id for single-block records", () => {
    expect(claudeRecordMessages(assistant("a2", [{ type: "text", text: "hi" }]))).toEqual([
      { itemId: "a2", type: "assistant", role: "assistant", text: "hi", status: "generating", payload: {} }
    ]);
  });

  it("wraps ExitPlanMode plans as proposed plans keyed by tool use", () => {
    expect(claudeRecordMessages(assistant("a3", [{ type: "tool_use", id: "tu-plan", name: "ExitPlanMode", input: { plan: "1. Step" } }]))).toEqual([{
      itemId: "plan:tu-plan",
      type: "assistant",
      role: "assistant",
      text: "<proposed_plan>\n1. Step\n</proposed_plan>",
      status: "planning",
      payload: {}
    }]);
  });

  it("maps TodoWrite into a task list", () => {
    const [message] = claudeRecordMessages(assistant("a4", [{
      type: "tool_use",
      id: "tu-todo",
      name: "TodoWrite",
      input: { todos: [{ content: "One", status: "completed" }, { content: "Two", status: "in_progress" }, { activeForm: "Three", status: "weird" }, { status: "pending" }] }
    }]));
    expect(message).toMatchObject({
      type: "tool_call",
      text: "[x] One\n[~] Two\n[ ] Three",
      payload: { taskList: { items: [{ text: "One", status: "completed" }, { text: "Two", status: "in_progress" }, { text: "Three", status: "pending" }] } }
    });
    expect(todoTaskList(null)).toEqual({ items: [] });
    expect(claudeRecordMessages(assistant("a5", [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [] } }]))[0]!.text).toBe("Task list updated");
  });

  it("maps user prompts and hides harness, sidechain, meta, and subagent records", () => {
    expect(claudeRecordMessages(user("u1", " hello "))).toEqual([{ itemId: "u1", type: "user", role: "user", text: "hello", status: null, payload: {} }]);
    expect(claudeRecordMessages(user("u2", [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]))[0]!.text).toBe("a\nb");
    expect(claudeRecordMessages(user("u3", "[Request interrupted by user]"))).toEqual([]);
    expect(claudeRecordMessages(user("u4", "<task-notification>\n<task-id>t</task-id>\n</task-notification>"))).toEqual([]);
    expect(claudeRecordMessages(user("u5", "Background work finished", { promptSource: "system" }))).toEqual([]);
    const synthetic = (extra: Record<string, unknown>) => ({ ...assistant("s1", [{ type: "text", text: "No response requested." }]), ...extra });
    expect(claudeRecordMessages({ ...synthetic({}), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } })).toEqual([]);
    expect(claudeRecordMessages({ ...synthetic({ isApiErrorMessage: true }), message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error: overloaded" }] } }))
      .toEqual([expect.objectContaining({ text: "API Error: overloaded" })]);
    expect(claudeRecordMessages(user("u4", "<command-name>/clear</command-name>"))).toEqual([]);
    expect(claudeRecordMessages(user("u5", "hi", { isSidechain: true }))).toEqual([]);
    expect(claudeRecordMessages(user("u6", "hi", { isMeta: true }))).toEqual([]);
    expect(claudeRecordMessages(user("u7", "hi", { parent_tool_use_id: "tu-1" }))).toEqual([]);
    expect(claudeRecordMessages(user("", "hi"))).toEqual([]);
    expect(claudeRecordMessages({ type: "system", uuid: "s" })).toEqual([]);
  });

  it("classifies tool results from known tool uses or their structured output", () => {
    const bash = claudeRecordMessages(
      user("u1", [{ type: "tool_result", tool_use_id: "tu-1", content: "ignored" }], { toolUseResult: { stdout: "out", stderr: "err" } }),
      { "tu-1": { name: "Bash", input: { command: "make" } } }
    );
    expect(bash).toEqual([{ itemId: "u1", type: "command_output", role: "tool", text: "make\nout\nerr", status: null, payload: { toolName: "Bash", toolUseId: "tu-1" } }]);

    const inferred = claudeRecordMessages(user("u2", [{ type: "tool_result", tool_use_id: "tu-x", content: [{ type: "text", text: "fallback" }] }], {
      tool_use_result: { stdout: "", stderr: "" }
    }));
    expect(inferred[0]).toMatchObject({ type: "command_output", text: "Command\nfallback" });

    const edit = claudeRecordMessages(user("u3", [{ type: "tool_result", tool_use_id: "tu-e", content: "ok" }], {
      toolUseResult: { filePath: "/repo/a.ts", structuredPatch: [{ lines: ["+x"] }] }
    }));
    expect(edit).toEqual([{
      itemId: "u3",
      type: "tool_output",
      role: "tool",
      text: "File change completed: /repo/a.ts",
      status: null,
      payload: { toolName: "Edit", toolUseId: "tu-e", patch: [{ lines: ["+x"] }] }
    }]);

    const failedEdit = claudeRecordMessages(
      user("u4", [{ type: "tool_result", tool_use_id: "tu-w", content: "denied", is_error: true }]),
      { "tu-w": { name: "Write", input: { file_path: "/etc/x" } } }
    );
    expect(failedEdit[0]).toMatchObject({ text: "File change failed: /etc/x\ndenied", payload: { error: true } });

    expect(claudeRecordMessages(user("u5", [{ type: "tool_result", tool_use_id: "q", content: "x" }], { toolUseResult: { questions: [], answers: {} } }))).toEqual([]);
    expect(claudeRecordMessages(user("u6", [{ type: "tool_result", tool_use_id: "t", content: "x" }], { toolUseResult: { newTodos: [] } }))).toEqual([]);

    const multi = claudeRecordMessages(user("u7", [
      { type: "tool_result", tool_use_id: "g", content: "match" },
      { type: "tool_result", tool_use_id: "unknown", content: [{ type: "image" }] }
    ]), { g: { name: "Grep", input: {} } });
    expect(multi.map(({ itemId, text }) => ({ itemId, text }))).toEqual([
      { itemId: "u7:0", text: "Grep\nmatch" },
      { itemId: "u7:1", text: "[image]" }
    ]);
  });

  it("truncates very long tool output", () => {
    const [message] = claudeRecordMessages(user("u1", [{ type: "tool_result", tool_use_id: "g", content: "x".repeat(25_000) }]), { g: { name: "Grep", input: {} } });
    expect(message!.text.endsWith("… [truncated]")).toBe(true);
    expect(message!.text.length).toBeLessThan(20_100);
  });
});

describe("projectClaudeEvent", () => {
  it("projects live assistant messages with transcript-compatible identities", () => {
    const projection = projectClaudeEvent({
      method: "sdk/message",
      params: { threadId: THREAD, turnId: "turn-1", message: assistant("rec-1", [{ type: "text", text: "Hi" }], { timestamp: "2026-09-27T11:00:00.000Z" }) }
    }, AT);
    expect(projection).toMatchObject({
      identity: { threadId: THREAD, turnId: "turn-1", itemId: "rec-1", clientMessageId: null },
      status: "generating",
      transient: false,
      message: {
        id: stableProjectionId(THREAD, "rec-1", "assistant"),
        type: "assistant",
        text: "Hi",
        timestamp: "2026-09-27T11:00:00.000Z",
        payload: {
          source: "claude_host",
          codexItemIdentity: { threadId: THREAD, turnId: "claude", itemId: "rec-1", clientMessageId: null }
        }
      }
    });
    // Identity depends on the record uuid only, never on the muxpilot turn id.
    const replay = projectClaudeEvent({
      method: "sdk/message",
      params: { threadId: THREAD, turnId: null, message: assistant("rec-1", [{ type: "text", text: "Hi" }]) }
    }, AT);
    expect(replay?.message?.id).toBe(projection?.message?.id);
    expect(replay?.status).toBeNull();
    expect(itemIdentity(THREAD, "rec-1", null)).toEqual(projection?.message?.payload?.codexItemIdentity);
  });

  it("classifies tool results with the host-supplied tool uses", () => {
    const projection = projectClaudeEvent({
      method: "sdk/message",
      params: {
        threadId: THREAD,
        turnId: "turn-1",
        message: user("u1", [{ type: "tool_result", tool_use_id: "tu-1", content: "done" }]),
        toolUses: { "tu-1": { name: "Bash", input: { command: "ls" } } }
      }
    }, AT);
    expect(projection?.message).toMatchObject({ type: "command_output", text: "ls\ndone" });
  });

  it("expands multi-block records so every block projects live", () => {
    const event = {
      method: "sdk/message",
      params: {
        threadId: THREAD,
        turnId: "turn-1",
        message: user("u2", [
          { type: "tool_result", tool_use_id: "tu-1", content: "one" },
          { type: "tool_result", tool_use_id: "tu-2", content: "two" }
        ]),
        toolUses: { "tu-1": { name: "Bash", input: { command: "ls" } }, "tu-2": { name: "Bash", input: { command: "pwd" } } }
      },
      receivedAt: AT
    };
    const expanded = claudeProjectionAdapter.expand!(event);
    expect(expanded).toHaveLength(2);
    const projected = expanded.map((item) => projectClaudeEvent(item, AT)?.message);
    expect(projected.map((message) => message?.text)).toEqual(["ls\none", "pwd\ntwo"]);
    expect(new Set(projected.map((message) => message?.id)).size).toBe(2);
    const single = { ...event, params: { ...event.params, message: user("u3", "hello") } };
    expect(claudeProjectionAdapter.expand!(single)).toEqual([single]);
  });

  it("projects stream events as transient liveness and ignores unmapped records", () => {
    expect(projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, turnId: "t", message: { type: "stream_event", uuid: "s" }, transient: true } }, AT))
      .toMatchObject({ status: "generating", transient: true, message: null });
    expect(projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, turnId: "t", message: { type: "result" } } }, AT)).toBeNull();
    expect(projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, message: user("u", "[Request interrupted by user]") } }, AT)).toBeNull();
    expect(projectClaudeEvent({ method: "sdk/message", params: { message: assistant("a", [{ type: "text", text: "x" }]) } }, AT)).toBeNull();
    expect(projectClaudeEvent({ method: "unknown/method", params: { threadId: THREAD } }, AT)).toBeNull();
    expect(projectClaudeEvent({ method: "turn/started", params: null }, AT)).toBeNull();
  });

  it("projects system notices", () => {
    const compact = projectClaudeEvent({
      method: "sdk/message",
      params: { threadId: THREAD, turnId: "t", message: { type: "system", subtype: "compact_boundary", uuid: "c1", compact_metadata: { pre_tokens: 150000 } } }
    }, AT);
    expect(compact?.message).toMatchObject({ type: "status", role: "system", text: "Context compacted from 150,000 tokens." });
    const quietRetry = projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, turnId: "t", message: { type: "system", subtype: "api_retry", uuid: "r", attempt: 1 } } }, AT);
    expect(quietRetry).toMatchObject({ status: "working", transient: true, message: null });
    const loudRetry = projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, turnId: "t", message: { type: "system", subtype: "api_retry", uuid: "r", attempt: 3 } } }, AT);
    expect(loudRetry?.message?.text).toBe("Claude API request failed; retrying (attempt 3).");
    const task = projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, message: { type: "system", subtype: "task_notification", uuid: "n", status: "completed", summary: "built" } } }, AT);
    expect(task?.message?.text).toBe("Background task completed: built");
    expect(projectClaudeEvent({ method: "sdk/message", params: { threadId: THREAD, message: { type: "system", subtype: "init", uuid: "i" } } }, AT)).toBeNull();
  });

  it("projects turn lifecycle and thread status", () => {
    expect(projectClaudeEvent({ method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-1" } } }, AT)).toMatchObject({ status: "working" });
    const status = (value: unknown) => projectClaudeEvent({ method: "thread/status/changed", params: { threadId: THREAD, status: value } }, AT)?.status;
    expect(status({ type: "idle" })).toBe("idle");
    expect(status({ type: "active", activeFlags: [] })).toBe("working");
    expect(status({ type: "active", activeFlags: ["waitingOnUserInput"] })).toBe("question");
    expect(status({ type: "active", activeFlags: ["waitingOnUserInput", "waitingOnApproval"] })).toBe("approval");
    expect(status({ type: "notLoaded" })).toBe("unknown");

    const completed = (turn: Record<string, unknown>) => projectClaudeEvent({ method: "turn/completed", params: { threadId: THREAD, turn } }, AT);
    expect(completed({ id: "t", status: "completed" })).toMatchObject({ status: "idle", message: null });
    expect(completed({ id: "t", status: "completed", items: [{ type: "plan" }] })?.status).toBe("plan_ready");
    expect(completed({ id: "t", status: "interrupted" })).toMatchObject({ status: "waiting", message: null });
    const failed = completed({ id: "t", status: "failed", error: { message: "Bearer sk-ant-secret123 rejected", codexErrorInfo: "usageLimitExceeded" } });
    expect(failed).toMatchObject({
      status: "input_failed",
      message: {
        type: "status",
        id: stableProjectionId(THREAD, "t:turnFailure", "status"),
        text: "Claude could not complete this turn: [credential redacted] rejected",
        payload: { turnFailure: { failureCode: "turn_failed", providerErrorCode: "usageLimitExceeded" } }
      }
    });
    const unexpected = projectClaudeEvent({ method: "turn/completed", params: { threadId: THREAD, turn: { id: "t", status: "interrupted" }, muxpilotUnexpectedInterruption: true } }, AT);
    expect(unexpected?.message?.payload).toMatchObject({ interruption: { kind: "unexpected", turnId: "t" } });
  });

  it("projects accepted input and intentional interruptions", () => {
    const accepted = projectClaudeEvent({
      method: "input/accepted",
      params: { threadId: THREAD, turnId: "turn-1", clientMessageId: "client-1", messageUuid: "uuid-1", text: "hi", acceptedAt: "2026-09-27T10:00:00.000Z" }
    }, AT);
    expect(accepted).toMatchObject({
      identity: { threadId: THREAD, turnId: "turn-1", itemId: "uuid-1", clientMessageId: "client-1" },
      message: {
        id: stableProjectionId(THREAD, "uuid-1", "user"),
        type: "user",
        text: "hi",
        timestamp: "2026-09-27T10:00:00.000Z",
        payload: { codexItemIdentity: { threadId: THREAD, turnId: "claude", itemId: "uuid-1", clientMessageId: "client-1" } }
      }
    });
    // The transcript's user record shares the same stable id, so it deduplicates against the live input.
    expect(accepted?.message?.id).toBe(stableProjectionId(THREAD, "uuid-1", "user"));

    const operator = projectClaudeEvent({ method: "muxpilot/turn/intentionallyInterrupted", params: { threadId: THREAD, turnId: "t" } }, AT);
    expect(operator?.message).toMatchObject({ text: "Turn interrupted by operator.", payload: { source: "muxpilot", interruption: { kind: "operator" } } });
    const budget = projectClaudeEvent({ method: "muxpilot/turn/intentionallyInterrupted", params: { threadId: THREAD, turnId: "t", kind: "budget_guard" } }, AT);
    expect(budget?.message?.text).toContain("budget was exhausted");
  });

  it("projects plan notifications with the same identity as transcript plans", () => {
    const projection = projectClaudeEvent({ method: "plan/proposed", params: { threadId: THREAD, turnId: "t", itemId: "tu-plan", plan: "1. Step" } }, AT);
    expect(projection).toMatchObject({
      status: "planning",
      message: { id: stableProjectionId(THREAD, "plan:tu-plan", "assistant"), text: "<proposed_plan>\n1. Step\n</proposed_plan>" }
    });
    const [transcriptPlan] = claudeRecordMessages(assistant("a", [{ type: "tool_use", id: "tu-plan", name: "ExitPlanMode", input: { plan: "1. Step" } }]));
    expect(stableProjectionId(THREAD, transcriptPlan!.itemId, transcriptPlan!.type)).toBe(projection?.message?.id);
    expect(projectClaudeEvent({ method: "plan/proposed", params: { threadId: THREAD, itemId: "x", plan: "  " } }, AT)).toBeNull();
  });

  it("projects approval requests with scope options", () => {
    const params = {
      threadId: THREAD,
      turnId: "turn-1",
      itemId: "tu-1",
      toolName: "Bash",
      category: "command",
      title: "Run git push",
      command: "git push",
      cwd: "/repo",
      reason: "network",
      prefixRule: ["git", "push"],
      input: { command: "git push" }
    };
    const projection = projectClaudeEvent({ method: "claude/approval", params: { requestId: "req:tu-1", params, openedAt: "2026-09-27T09:00:00.000Z" } }, AT);
    expect(projection).toMatchObject({
      identity: { threadId: THREAD, turnId: "turn-1", itemId: "tu-1" },
      status: "approval",
      message: {
        id: stableProjectionId(THREAD, "tu-1:req:tu-1", "approval_request"),
        type: "approval_request",
        text: "Run git push",
        timestamp: "2026-09-27T09:00:00.000Z",
        payload: {
          approval: {
            id: "req:tu-1",
            requestId: "req:tu-1",
            kind: "command",
            command: "git push",
            toolName: "Bash",
            prefixRule: ["git", "push"]
          }
        }
      }
    });
    const decisions = (projection?.message?.payload?.approval as { options: Array<{ decision: string }> }).options.map((option) => option.decision);
    expect(decisions).toEqual(["approve_once", "approve_for_session", "approve_for_prefix", "deny"]);

    const noPrefix = projectClaudeEvent({ method: "claude/approval", params: { requestId: "r", params: { ...params, prefixRule: [] } } }, AT);
    expect((noPrefix?.message?.payload?.approval as { options: Array<{ decision: string }>; prefixRule: unknown }).options.map((option) => option.decision))
      .toEqual(["approve_once", "approve_for_session", "deny"]);
    expect(projectClaudeEvent({ method: "claude/approval", params: { requestId: "r", params: { ...params, turnId: "" } } }, AT)).toBeNull();
  });

  it("projects question requests", () => {
    const projection = projectClaudeEvent({
      method: "claude/question",
      params: {
        requestId: "req:ask",
        params: {
          threadId: THREAD,
          turnId: "turn-1",
          itemId: "ask",
          questions: [{ id: "q0", header: "H", question: "Q?", multiSelect: true, options: [{ label: "A", description: "a" }] }]
        }
      }
    }, AT);
    expect(projection).toMatchObject({
      status: "question",
      message: {
        type: "question_request",
        text: "Claude needs your input",
        timestamp: AT,
        payload: {
          question: {
            id: "req:ask",
            requestId: "req:ask",
            questions: [{ id: "q0", header: "H", question: "Q?", options: [{ label: "A", description: "a" }] }],
            autoResolutionMs: null,
            createdAt: AT
          }
        }
      }
    });
    expect(projectClaudeEvent({ method: "claude/question", params: { requestId: "r", params: { threadId: THREAD, turnId: "t", itemId: "i", questions: [] } } }, AT)).toBeNull();
  });

  it("recognizes interactive requests in the projection adapter", () => {
    expect(claudeProjectionAdapter.isInteractiveServerRequest?.({ method: "claude/approval", params: {}, receivedAt: AT })).toBe(true);
    expect(claudeProjectionAdapter.isInteractiveServerRequest?.({ method: "claude/question", params: {}, receivedAt: AT })).toBe(true);
    expect(claudeProjectionAdapter.isInteractiveServerRequest?.({ method: "sdk/message", params: {}, receivedAt: AT })).toBe(false);
  });
});

describe("claudeAuthenticationFailure", () => {
  it("detects authentication failures and redacts credentials", () => {
    const suffix = " Sign in with `claude auth login` on the muxpilot host, then resume this session.";
    expect(claudeAuthenticationFailure("auth/failed", { message: "OAuth token expired: access_token=abc123" }))
      .toBe(`OAuth token expired: access_token=[credential redacted]${suffix}`);
    expect(claudeAuthenticationFailure("auth/failed", {})).toBe(`Claude authentication failed.${suffix}`);
    expect(claudeAuthenticationFailure("turn/completed", { turn: { status: "failed", error: { message: "Please run /login", codexErrorInfo: "authenticationFailed" } } }))
      .toBe(`Please run /login${suffix}`);
    expect(claudeAuthenticationFailure("turn/completed", { turn: { status: "failed", error: { message: "rate limited", codexErrorInfo: "usageLimitExceeded" } } })).toBeNull();
    expect(claudeAuthenticationFailure("connection/error", { message: "Not logged in · Please run /login" })).toBe(`Not logged in · Please run /login${suffix}`);
    expect(claudeAuthenticationFailure("connection/error", { message: "socket closed" })).toBeNull();
    expect(claudeAuthenticationFailure("auth/failed", { message: "bad key sk-ant-api03-SECRET" })).toBe(`bad key [credential redacted]${suffix}`);
    expect(claudeProjectionAdapter.authenticationFailure).toBe(claudeAuthenticationFailure);
  });
});
