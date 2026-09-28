import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { HostOperationError, HostSession, InputQueue, type PersistedHostState } from "../src/providers/claude/host/hostSession.js";
import { HOST_ERROR, HOST_NOTIFICATION, type HostLaunchConfig, type SessionOpenParams } from "../src/providers/claude/host/protocol.js";
import { fakeQueryFactory, flush } from "./helpers/claudeFakes.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_UUID = "22222222-2222-4222-8222-222222222222";
const STEER_UUID = "33333333-3333-4333-8333-333333333333";

function launch(overrides: Partial<HostLaunchConfig> = {}): HostLaunchConfig {
  return {
    model: "claude-opus",
    effort: "high",
    fastMode: null,
    permissionMode: "default",
    systemPromptAppend: "muxpilot instructions",
    mcpServers: [{ name: "muxpilot_sessions", command: "node", args: ["mcp.js"] }],
    writableRoots: ["/shared/docs"],
    allowUnixSockets: ["/run/git.sock"],
    settingSources: ["user", "project"],
    pluginDirs: ["/plugins/a"],
    claudePath: "/usr/bin/claude",
    ...overrides
  };
}

function openParams(overrides: Partial<SessionOpenParams> = {}): SessionOpenParams {
  return { mode: "start", sessionId: SESSION_ID, cwd: "/repo", launch: launch(), ...overrides };
}

function harness(options: { persistState?: (state: PersistedHostState) => Promise<void> } = {}) {
  const queries = fakeQueryFactory();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nowMs = Date.parse("2026-09-27T12:00:00.000Z");
  const session = new HostSession({
    queryFactory: queries.factory,
    notify: (method, params) => notifications.push({ method, params: params as Record<string, unknown> }),
    configDir: "/home/user/.muxpilot/claude",
    environment: { PATH: "/usr/bin" },
    persistState: options.persistState,
    now: () => new Date(nowMs)
  });
  return {
    session,
    queries,
    notifications,
    advance: (ms: number) => { nowMs += ms; },
    methods: () => notifications.map((entry) => entry.method),
    of: (method: string) => notifications.filter((entry) => entry.method === method).map((entry) => entry.params),
    canUseTool: () => queries.latest().options.canUseTool as CanUseTool
  };
}

async function startTurn(h: ReturnType<typeof harness>, clientMessageId = "client-1", messageUuid = TURN_UUID) {
  return h.session.startTurn({
    clientMessageId,
    messageUuid,
    content: [{ type: "text", value: "hello" }, { type: "text", value: " world" }],
    mode: "default",
    model: null,
    effort: null,
    fastMode: null
  });
}

function result(uuids: string[], overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    uuid: `result-${uuids.join("-")}`,
    session_id: SESSION_ID,
    user_message_uuids: uuids,
    ...overrides
  };
}

function toolOptions(toolUseID: string, signal = new AbortController().signal) {
  return { signal, toolUseID, suggestions: [] } as unknown as Parameters<CanUseTool>[2];
}

describe("HostSession", () => {
  it("launches the SDK query with muxpilot's sandbox and session options", async () => {
    const h = harness();
    const state = await h.session.open(openParams());
    const options = h.queries.latest().options;
    expect(options).toMatchObject({
      cwd: "/repo",
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/home/user/.muxpilot/claude" },
      model: "claude-opus",
      effort: "high",
      permissionMode: "default",
      includePartialMessages: true,
      sessionId: SESSION_ID,
      additionalDirectories: ["/shared/docs"],
      allowedTools: ["mcp__muxpilot_sessions__*"],
      mcpServers: { muxpilot_sessions: { type: "stdio", command: "node", args: ["mcp.js"] } },
      plugins: [{ type: "local", path: "/plugins/a" }],
      systemPrompt: { type: "preset", preset: "claude_code", append: "muxpilot instructions", snapshot: false }
    });
    expect(options.disallowedTools).toContain("EnterPlanMode");
    expect((options.settings as { sandbox: { filesystem: { allowWrite: string[] } } }).sandbox.filesystem.allowWrite).toEqual(["/repo", "/shared/docs"]);
    expect(options).not.toHaveProperty("resume");
    expect(state).toMatchObject({
      sessionId: SESSION_ID,
      cwd: "/repo",
      transcriptPath: `/home/user/.muxpilot/claude/projects/-repo/${SESSION_ID}.jsonl`,
      status: { type: "idle" },
      activeTurn: null,
      pendingRequests: []
    });
  });

  it("passes resume and fork options and refuses to switch sessions without replace", async () => {
    const resumed = harness();
    await resumed.session.open(openParams({ mode: "resume", sessionId: "ignored", sourceSessionId: "source-1" }));
    expect(resumed.queries.latest().options).toMatchObject({ resume: "source-1" });
    expect(resumed.session.sessionId).toBe("source-1");
    // Reopening the same session is idempotent.
    await expect(resumed.session.open(openParams({ mode: "resume", sessionId: "x", sourceSessionId: "source-1" }))).resolves.toMatchObject({ sessionId: "source-1" });
    expect(resumed.queries.queries).toHaveLength(1);
    await expect(resumed.session.open(openParams({ sessionId: "other" }))).rejects.toMatchObject({ code: HOST_ERROR.invalidParams });

    const forked = harness();
    await forked.session.open(openParams({ mode: "fork", sessionId: "fork-1", sourceSessionId: "source-1" }));
    expect(forked.queries.latest().options).toMatchObject({ resume: "source-1", forkSession: true, sessionId: "fork-1" });

    const missing = harness();
    await expect(missing.session.open(openParams({ mode: "resume" }))).rejects.toMatchObject({ code: HOST_ERROR.invalidParams });
  });

  it("rejects turn operations while the session is not open", async () => {
    const h = harness();
    await expect(startTurn(h)).rejects.toMatchObject({ code: HOST_ERROR.notOpen });
    await expect(h.session.updateSettings({ model: "x" })).rejects.toBeInstanceOf(HostOperationError);
    expect(h.session.state()).toBeNull();
  });

  it("starts a turn and completes it only after every turn input has finished", async () => {
    const persisted: PersistedHostState[] = [];
    const h = harness({ persistState: async (state) => { persisted.push(structuredClone(state)); } });
    await h.session.open(openParams());
    const receipt = await startTurn(h);
    expect(receipt).toEqual({ turnId: TURN_UUID, messageUuid: TURN_UUID });
    await flush();
    const query = h.queries.latest();
    expect(query.prompts).toEqual([{
      type: "user",
      uuid: TURN_UUID,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }] }
    }]);
    expect(h.of(HOST_NOTIFICATION.inputAccepted)).toEqual([expect.objectContaining({
      threadId: SESSION_ID,
      turnId: TURN_UUID,
      clientMessageId: "client-1",
      messageUuid: TURN_UUID,
      text: "hello world",
      acceptedAt: "2026-09-27T12:00:00.000Z"
    })]);
    expect(h.of(HOST_NOTIFICATION.turnStarted)).toEqual([{
      threadId: SESSION_ID,
      turn: { id: TURN_UUID, status: "inProgress" },
      clientMessageId: "client-1",
      messageUuid: TURN_UUID
    }]);
    expect(h.of(HOST_NOTIFICATION.threadStatus).at(-1)).toEqual({ threadId: SESSION_ID, status: { type: "active", activeFlags: [] } });
    expect(persisted.at(-1)).toMatchObject({ activeTurn: { id: TURN_UUID, status: "inProgress" }, inputs: [{ clientMessageId: "client-1", messageUuid: TURN_UUID, turnId: TURN_UUID }] });

    // Duplicate submissions return the original receipt; a second turn is rejected while one is active.
    await expect(startTurn(h)).rejects.toMatchObject({ code: HOST_ERROR.turnActive });
    expect(h.session.lookupInput("client-1")).toEqual({ turnId: TURN_UUID, messageUuid: TURN_UUID });
    expect(h.session.lookupInput("missing")).toBeNull();

    const steer = await h.session.steerTurn({
      expectedTurnId: TURN_UUID,
      clientMessageId: "client-2",
      messageUuid: STEER_UUID,
      content: [{ type: "text", value: "also this" }]
    });
    expect(steer).toEqual({ turnId: TURN_UUID, messageUuid: STEER_UUID });
    await flush();
    expect(query.prompts[1]).toMatchObject({ uuid: STEER_UUID, priority: "next" });
    await expect(h.session.steerTurn({ expectedTurnId: TURN_UUID, clientMessageId: "client-2", messageUuid: "other", content: [] }))
      .resolves.toEqual({ turnId: TURN_UUID, messageUuid: STEER_UUID });

    // A result without submission identity closes an aborted streaming segment, not the turn.
    query.push(result([], { user_message_uuids: undefined }));
    // The first input's result arrives while the steer input is still queued.
    query.push(result([TURN_UUID]));
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)).toEqual([]);
    expect(h.session.hasActiveTurn()).toBe(true);

    query.push({ type: "command_lifecycle", command_uuid: STEER_UUID, state: "completed" });
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)).toEqual([{
      threadId: SESSION_ID,
      turn: { id: TURN_UUID, status: "completed" },
      result: expect.objectContaining({ user_message_uuids: [TURN_UUID] })
    }]);
    expect(h.session.state()).toMatchObject({ status: { type: "idle" }, activeTurn: null, latestTurn: { id: TURN_UUID, status: "completed" } });
    await flush();
    expect(persisted.at(-1)).toMatchObject({ activeTurn: null, latestTurn: { id: TURN_UUID, status: "completed" } });
  });

  it("opens an autonomous turn when Claude wakes itself and closes it on the result", async () => {
    const h = harness();
    await h.session.open(openParams());
    await flush();
    const query = h.queries.latest();
    query.push({ type: "assistant", uuid: "wake-1", parent_tool_use_id: null, session_id: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: "The task finished." }] } });
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnStarted)).toEqual([{
      threadId: SESSION_ID,
      turn: { id: "auto-wake-1", status: "inProgress" },
      clientMessageId: null,
      messageUuid: null
    }]);
    expect(h.of(HOST_NOTIFICATION.threadStatus).at(-1)).toEqual({ threadId: SESSION_ID, status: { type: "active", activeFlags: [] } });
    query.push(result([]));
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)).toEqual([expect.objectContaining({ turn: { id: "auto-wake-1", status: "completed" } })]);
    expect(h.of(HOST_NOTIFICATION.threadStatus).at(-1)).toEqual({ threadId: SESSION_ID, status: { type: "idle" } });
    // A later muxpilot turn starts normally.
    await expect(startTurn(h)).resolves.toEqual({ turnId: TURN_UUID, messageUuid: TURN_UUID });
  });

  it("completes a steered turn from one result naming every input", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    await h.session.steerTurn({ expectedTurnId: TURN_UUID, clientMessageId: "client-2", messageUuid: STEER_UUID, content: [{ type: "text", value: "x" }] });
    h.queries.latest().push(result([TURN_UUID, STEER_UUID]));
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)).toHaveLength(1);
  });

  it("rejects steering without a matching active turn", async () => {
    const h = harness();
    await h.session.open(openParams());
    const steer = { expectedTurnId: TURN_UUID, clientMessageId: "c", messageUuid: STEER_UUID, content: [] };
    await expect(h.session.steerTurn(steer)).rejects.toMatchObject({ code: HOST_ERROR.noActiveTurn });
    await startTurn(h);
    await expect(h.session.steerTurn({ ...steer, expectedTurnId: "other" })).rejects.toMatchObject({ code: HOST_ERROR.noActiveTurn });
    await h.session.interrupt(TURN_UUID);
    await expect(h.session.steerTurn(steer)).rejects.toMatchObject({ code: HOST_ERROR.noActiveTurn });
  });

  it("applies per-turn settings before sending input", async () => {
    const h = harness();
    await h.session.open(openParams());
    await h.session.startTurn({
      clientMessageId: "c",
      messageUuid: TURN_UUID,
      content: [{ type: "text", value: "plan it" }],
      mode: "plan",
      model: "claude-sonnet",
      effort: "low",
      fastMode: true
    });
    const query = h.queries.latest();
    expect(query.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(query.setModel).toHaveBeenCalledWith("claude-sonnet");
    expect(query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "low", fastMode: true });
    expect(h.session.state()).toMatchObject({ permissionMode: "plan", model: "claude-sonnet", effort: "low", fastMode: true });
  });

  it("interrupts the active turn, cancels its requests, and reports it interrupted", async () => {
    const h = harness();
    await h.session.open(openParams());
    expect(await h.session.interrupt(null)).toBe("already_idle");
    await startTurn(h);
    expect(await h.session.interrupt("other-turn")).toBe("already_idle");

    const approval = h.canUseTool()("Bash", { command: "make deploy" }, toolOptions("tool-1"));
    await flush();
    expect(await h.session.interrupt(TURN_UUID)).toBe("interrupted");
    await expect(approval).resolves.toEqual({ behavior: "deny", message: "The turn was interrupted." });
    expect(h.of(HOST_NOTIFICATION.requestResolved)).toEqual([{ threadId: SESSION_ID, requestId: "req:tool-1", resolution: "interrupted" }]);
    expect(h.queries.latest().interrupt).toHaveBeenCalledOnce();

    // After an interrupt, even a result without submission identity ends the turn.
    h.queries.latest().push(result([], { user_message_uuids: undefined, subtype: "error_during_execution", is_error: true, errors: [] }));
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)).toEqual([expect.objectContaining({ turn: { id: TURN_UUID, status: "interrupted" } })]);
  });

  it("reports aborted results as interrupted and failures with provider codes", async () => {
    const aborted = harness();
    await aborted.session.open(openParams());
    await startTurn(aborted);
    aborted.queries.latest().push(result([TURN_UUID], { terminal_reason: "aborted_streaming" }));
    await flush();
    expect(aborted.of(HOST_NOTIFICATION.turnCompleted)[0]).toMatchObject({ turn: { status: "interrupted" } });

    const failed = harness();
    await failed.session.open(openParams());
    await startTurn(failed);
    failed.queries.latest().push({ type: "rate_limit_event", rate_limit_info: { status: "rejected" }, uuid: "r", session_id: SESSION_ID });
    failed.queries.latest().push(result([TURN_UUID], { subtype: "error_during_execution", is_error: true, errors: ["quota", "exceeded"] }));
    await flush();
    expect(failed.of(HOST_NOTIFICATION.turnCompleted)[0]).toMatchObject({
      turn: { status: "failed", error: { message: "quota; exceeded", codexErrorInfo: "usageLimitExceeded" } }
    });

    const auth = harness();
    await auth.session.open(openParams());
    await startTurn(auth);
    auth.queries.latest().push({
      type: "assistant",
      uuid: "a1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      error: "authentication_failed",
      message: { role: "assistant", content: [{ type: "text", text: "Please run /login" }] }
    });
    auth.queries.latest().push(result([TURN_UUID], { is_error: true, result: "Please run /login" }));
    await flush();
    expect(auth.of(HOST_NOTIFICATION.authFailed)).toEqual([{ threadId: SESSION_ID, message: "Please run /login" }]);
    expect(auth.of(HOST_NOTIFICATION.turnCompleted)[0]).toMatchObject({
      turn: { status: "failed", error: { message: "Please run /login", codexErrorInfo: "authenticationFailed" } }
    });
  });

  it("fails the active turn when the SDK query throws or stops", async () => {
    const thrown = harness();
    await thrown.session.open(openParams());
    await startTurn(thrown);
    thrown.queries.latest().fail(new Error("Invalid API key · Please run /login"));
    await flush();
    expect(thrown.methods()).toContain(HOST_NOTIFICATION.hostError);
    expect(thrown.of(HOST_NOTIFICATION.authFailed)).toHaveLength(1);
    expect(thrown.of(HOST_NOTIFICATION.turnCompleted)).toEqual([expect.objectContaining({
      turn: { id: TURN_UUID, status: "failed", error: { message: "Invalid API key · Please run /login", codexErrorInfo: null } }
    })]);
    expect(thrown.session.isOpen()).toBe(false);
    expect(thrown.session.state()?.status).toEqual({ type: "notLoaded" });

    const stopped = harness();
    await stopped.session.open(openParams());
    await startTurn(stopped);
    stopped.queries.latest().end();
    await flush();
    expect(stopped.of(HOST_NOTIFICATION.turnCompleted)[0]).toMatchObject({
      turn: { status: "failed", error: { message: "The Claude runtime stopped unexpectedly." } }
    });
  });

  it("bridges tool approvals through request notifications and operator responses", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const canUseTool = h.canUseTool();

    await expect(canUseTool("Read", { file_path: "/etc/hosts" }, toolOptions("read-1"))).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "/etc/hosts" } });
    await expect(canUseTool("CronCreate", {}, toolOptions("cron-1"))).resolves.toMatchObject({ behavior: "deny" });

    const allowed = canUseTool("Bash", { command: "npm publish" }, {
      ...toolOptions("tool-1"),
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm publish:*" }] }]
    } as never);
    await flush();
    const opened = h.of(HOST_NOTIFICATION.requestOpened);
    expect(opened).toEqual([{
      requestId: "req:tool-1",
      method: "claude/approval",
      openedAt: "2026-09-27T12:00:00.000Z",
      params: {
        threadId: SESSION_ID,
        turnId: TURN_UUID,
        itemId: "tool-1",
        toolName: "Bash",
        category: "command",
        title: "Run npm publish",
        command: "npm publish",
        cwd: "/repo",
        reason: null,
        prefixRule: ["npm", "publish"],
        input: { command: "npm publish" }
      }
    }]);
    expect(h.session.state()?.status).toEqual({ type: "active", activeFlags: ["waitingOnApproval"] });
    expect(h.session.state()?.pendingRequests).toEqual([expect.objectContaining({ requestId: "req:tool-1", method: "claude/approval" })]);

    expect(h.session.respond("req:tool-1", { behavior: "allow", scope: "prefix" })).toBe(true);
    await expect(allowed).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "npm publish" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm publish:*" }], behavior: "allow", destination: "session" }]
    });
    expect(h.of(HOST_NOTIFICATION.requestResolved)).toEqual([{ threadId: SESSION_ID, requestId: "req:tool-1", resolution: "answered" }]);
    expect(h.session.respond("req:tool-1", { behavior: "deny" })).toBe(false);

    const denied = canUseTool("Write", { file_path: "/etc/motd" }, toolOptions("tool-2"));
    await flush();
    h.session.respond("req:tool-2", { behavior: "deny" });
    await expect(denied).resolves.toEqual({ behavior: "deny", message: "The operator denied this action." });

    const custom = canUseTool("Write", { file_path: "/etc/motd" }, toolOptions("tool-3"));
    await flush();
    h.session.respond("req:tool-3", { behavior: "deny", message: "Not there." });
    await expect(custom).resolves.toEqual({ behavior: "deny", message: "Not there." });
  });

  it("maps AskUserQuestion to a question request and returns answers keyed by question text", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const input = {
      questions: [
        { header: "DB", question: "Which database?", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "Redis", description: "KV" }] },
        { header: "Features", question: "Which features?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }
      ]
    };
    const pending = h.canUseTool()("AskUserQuestion", input, toolOptions("ask-1"));
    await flush();
    expect(h.of(HOST_NOTIFICATION.requestOpened)[0]).toMatchObject({
      requestId: "req:ask-1",
      method: "claude/question",
      params: {
        threadId: SESSION_ID,
        turnId: TURN_UUID,
        itemId: "ask-1",
        questions: [
          { id: "q0", header: "DB", question: "Which database?", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "Redis", description: "KV" }] },
          { id: "q1", header: "Features", question: "Which features?", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }
        ]
      }
    });
    expect(h.session.state()?.status).toEqual({ type: "active", activeFlags: ["waitingOnUserInput"] });
    h.session.respond("req:ask-1", { answers: { q0: { answers: ["Postgres"] }, q1: { answers: ["A", "B"] } } });
    await expect(pending).resolves.toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Which database?": "Postgres", "Which features?": "A, B" } }
    });

    const dismissed = h.canUseTool()("AskUserQuestion", input, toolOptions("ask-2"));
    await flush();
    h.session.respond("req:ask-2", { cancelled: true });
    await expect(dismissed).resolves.toEqual({ behavior: "deny", message: "The operator dismissed the question." });
  });

  it("records ExitPlanMode as a proposed plan and marks the completed turn", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const decision = await h.canUseTool()("ExitPlanMode", { plan: "1. Do it" }, toolOptions("plan-1"));
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(h.of(HOST_NOTIFICATION.planProposed)).toEqual([{ threadId: SESSION_ID, turnId: TURN_UUID, itemId: "plan-1", plan: "1. Do it" }]);
    h.queries.latest().push(result([TURN_UUID]));
    await flush();
    expect(h.of(HOST_NOTIFICATION.turnCompleted)[0]).toMatchObject({ turn: { status: "completed", items: [{ type: "plan" }] } });
  });

  it("cancels a request when the SDK aborts the tool call and when the turn ends", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const controller = new AbortController();
    const aborted = h.canUseTool()("Bash", { command: "sleep 100" }, toolOptions("tool-1", controller.signal));
    const question = h.canUseTool()("AskUserQuestion", { questions: [{ question: "Q?" }] }, toolOptions("ask-1"));
    await flush();
    controller.abort();
    await expect(aborted).resolves.toEqual({ behavior: "deny", message: "The request was cancelled." });
    h.queries.latest().push(result([TURN_UUID]));
    await expect(question).resolves.toEqual({ behavior: "deny", message: "The operator dismissed the question." });
    expect(h.of(HOST_NOTIFICATION.requestResolved).map((entry) => entry.resolution)).toEqual(["cancelled", "turn_ended"]);
  });

  it("replays pending requests after reconnect and reports them in state", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    void h.canUseTool()("Bash", { command: "make release" }, toolOptions("tool-1"));
    await flush();
    const first = h.of(HOST_NOTIFICATION.requestOpened);
    h.notifications.length = 0;

    // muxpilot reconnecting: a same-session open is a no-op that returns current state.
    const state = await h.session.open(openParams());
    expect(h.queries.queries).toHaveLength(1);
    expect(state.pendingRequests).toEqual([{ requestId: "req:tool-1", method: "claude/approval", params: first[0]!.params, openedAt: first[0]!.openedAt }]);
    h.session.replayPendingRequests();
    expect(h.of(HOST_NOTIFICATION.requestOpened)).toEqual(first);
  });

  it("refuses to replace a session while a turn is active and resets history on replace", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    await expect(h.session.open(openParams({ sessionId: "new", replace: true }))).rejects.toMatchObject({ code: HOST_ERROR.turnActive });
    h.queries.latest().push(result([TURN_UUID]));
    await flush();
    const first = h.queries.latest();
    const state = await h.session.open(openParams({ sessionId: "new", replace: true }));
    expect(first.close).toHaveBeenCalled();
    expect(h.queries.queries).toHaveLength(2);
    expect(state).toMatchObject({ sessionId: "new", latestTurn: null });
  });

  it("throttles stream events into transient liveness notifications", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const query = h.queries.latest();
    const stream = (uuid: string) => ({ type: "stream_event", uuid, session_id: SESSION_ID, parent_tool_use_id: null, event: { type: "content_block_delta" } });
    query.push(stream("s1"));
    query.push(stream("s2"));
    await flush();
    h.advance(749);
    query.push(stream("s3"));
    await flush();
    h.advance(1);
    query.push(stream("s4"));
    await flush();
    expect(h.of(HOST_NOTIFICATION.sdkMessage)).toEqual([
      { threadId: SESSION_ID, turnId: TURN_UUID, message: { type: "stream_event", uuid: "s1" }, transient: true },
      { threadId: SESSION_ID, turnId: TURN_UUID, message: { type: "stream_event", uuid: "s4" }, transient: true }
    ]);
  });

  it("forwards SDK messages with tool-use context and tracks background tasks", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const query = h.queries.latest();
    query.push({ type: "system", subtype: "init", uuid: "init-1", session_id: SESSION_ID, model: "claude-opus", tools: [] });
    query.push({
      type: "assistant",
      uuid: "a1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }] }
    });
    const toolResult = {
      type: "user",
      uuid: "u1",
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file" }, { type: "tool_result", tool_use_id: "unknown", content: "" }] }
    };
    query.push(toolResult);
    query.push({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "tu-1", description: "watch logs", uuid: "t1", session_id: SESSION_ID });
    await flush();
    expect(h.session.listTasks()).toEqual([{ taskId: "task-1", toolUseId: "tu-1", turnId: TURN_UUID, description: "watch logs" }]);
    query.push({ type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", uuid: "t2", session_id: SESSION_ID });
    query.push({ type: "auth_status", isAuthenticating: false, output: [], error: "token expired", uuid: "au", session_id: SESSION_ID });
    await flush();
    expect(h.session.listTasks()).toEqual([]);

    const messages = h.of(HOST_NOTIFICATION.sdkMessage);
    expect(messages.map((entry) => (entry.message as { uuid: string }).uuid)).toEqual(["init-1", "a1", "u1", "t1", "t2", "au"]);
    expect(messages[2]).toEqual({ threadId: SESSION_ID, turnId: TURN_UUID, message: toolResult, toolUses: { "tu-1": { name: "Bash", input: { command: "ls" } } } });
    expect(h.of(HOST_NOTIFICATION.authFailed)).toEqual([{ threadId: SESSION_ID, message: "token expired" }]);

    await h.session.stopTask("task-9");
    expect(query.stopTask).toHaveBeenCalledWith("task-9");
    await expect(h.session.contextUsage()).resolves.toEqual({ totalTokens: 1 });
  });

  it("restores persisted state and reports an unfinished turn as interrupted", () => {
    const h = harness();
    h.session.restorePersisted({
      sessionId: SESSION_ID,
      cwd: "/repo",
      launch: launch({ permissionMode: "plan" }),
      activeTurn: { id: TURN_UUID, status: "inProgress" },
      latestTurn: null,
      inputs: [{ clientMessageId: "client-1", messageUuid: TURN_UUID, turnId: TURN_UUID }]
    });
    expect(h.session.isOpen()).toBe(false);
    expect(h.session.state()).toMatchObject({
      status: { type: "notLoaded" },
      latestTurn: { id: TURN_UUID, status: "interrupted" },
      permissionMode: "plan"
    });
    expect(h.session.lookupInput("client-1")).toEqual({ turnId: TURN_UUID, messageUuid: TURN_UUID });
  });

  it("denies pending requests on close", async () => {
    const h = harness();
    await h.session.open(openParams());
    await startTurn(h);
    const pending = h.canUseTool()("Bash", { command: "x" }, toolOptions("tool-1"));
    await flush();
    await h.session.close();
    await expect(pending).resolves.toEqual({ behavior: "deny", message: "The session is shutting down." });
    expect(h.session.isOpen()).toBe(false);
  });
});

describe("InputQueue", () => {
  it("delivers queued and awaited messages in order and ends on close", async () => {
    const queue = new InputQueue();
    const message = (uuid: string) => ({ type: "user", uuid, parent_tool_use_id: null, message: { role: "user", content: uuid } }) as never;
    queue.push(message("a"));
    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { uuid: "a" }, done: false });
    const waiting = iterator.next();
    queue.push(message("b"));
    await expect(waiting).resolves.toMatchObject({ value: { uuid: "b" }, done: false });
    const ended = iterator.next();
    queue.close();
    await expect(ended).resolves.toEqual({ value: undefined, done: true });
    expect(() => queue.push(message("c"))).toThrow("Claude input is closed");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("drains queued messages pushed before close", async () => {
    const queue = new InputQueue();
    queue.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "x" } });
    queue.close();
    const seen: unknown[] = [];
    for await (const item of queue) seen.push(item);
    expect(seen).toHaveLength(1);
  });
});
