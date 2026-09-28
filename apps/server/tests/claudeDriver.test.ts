import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { ManagedSession } from "@muxpilot/core";
import { describe, expect, it, vi } from "vitest";
import { AppServerLaunchAttemptError, AppServerSteerUnavailableError } from "../src/providers/codex/driver.js";
import { ClaudeSessionDriver } from "../src/providers/claude/driver.js";
import {
  HOST_ERROR,
  submissionMessageUuid,
  type HostLaunchConfig,
  type HostSessionState
} from "../src/providers/claude/host/protocol.js";
import type { DriverEvent, RuntimeProxyConnection, RuntimeSupervisor, SystemdSessionRuntimeRef } from "../src/providers/types.js";
import { JsonRpcConnection, JsonRpcResponseError, type JsonRpcServerRequest } from "../src/runtime/jsonRpcConnection.js";
import { flush } from "./helpers/claudeFakes.js";

const runtime: SystemdSessionRuntimeRef = {
  kind: "systemd_service",
  unit: "muxpilot-session-0123456789abcdef01234567.service",
  socketPath: "/run/muxpilot/claude.sock",
  state: "connected",
  agentVersion: null
};

const LAUNCH: HostLaunchConfig = {
  model: null,
  effort: null,
  fastMode: null,
  permissionMode: "default",
  systemPromptAppend: null,
  mcpServers: [],
  writableRoots: [],
  allowUnixSockets: [],
  settingSources: ["user"],
  pluginDirs: [],
  claudePath: "/usr/bin/claude"
};

type Handler = (params: Record<string, unknown>) => unknown;

/** An in-memory Claude host speaking the JSON-RPC protocol over a stream pair. */
class FakeHost {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly handlers = new Map<string, Handler>();
  connection: JsonRpcConnection | null = null;

  async proxy(): Promise<RuntimeProxyConnection> {
    const toHost = new PassThrough();
    const toDriver = new PassThrough();
    let opened!: Promise<JsonRpcConnection>;
    opened = JsonRpcConnection.connect("host", { input: toDriver, output: toHost, close: async () => { toDriver.end(); } }, { append: async () => undefined }, {
      serverRequest: async (request: JsonRpcServerRequest) => {
        const connection = await opened;
        const params = (request.params ?? {}) as Record<string, unknown>;
        this.requests.push({ method: request.method, params });
        const handler = this.handlers.get(request.method);
        try {
          if (!handler) throw new JsonRpcResponseError(-32601, `unhandled ${request.method}`);
          await connection.respond(request.id, (await handler(params)) ?? null);
        } catch (error) {
          const code = error instanceof JsonRpcResponseError ? error.code : -32000;
          await connection.respondError(request.id, { code, message: (error as Error).message });
        }
      }
    });
    this.connection = await opened;
    return { input: toHost, output: toDriver, close: async () => { toHost.end(); } };
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  last(method: string): Record<string, unknown> | undefined {
    return this.requests.filter((request) => request.method === method).at(-1)?.params;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.connection!.notify(method, params);
    await flush();
  }
}

function hostState(overrides: Partial<HostSessionState> = {}): HostSessionState {
  return {
    sessionId: "thread-1",
    cwd: "/repo",
    transcriptPath: "/cfg/projects/-repo/thread-1.jsonl",
    status: { type: "idle" },
    activeTurn: null,
    latestTurn: null,
    pendingRequests: [],
    backgroundTasks: [],
    permissionMode: "default",
    model: null,
    effort: null,
    fastMode: null,
    ...overrides
  };
}

function harness(options: { initialState?: HostSessionState | null; launchDisposition?: "started" | "reused" } = {}) {
  const host = new FakeHost();
  host.on("initialize", () => ({
    protocolVersion: 1,
    hostVersion: "1",
    sdkVersion: "0.3.283",
    claudeVersion: "2.1.300",
    hostInstanceId: "host-1",
    state: options.initialState ?? null
  }));
  host.on("session/open", (params) => hostState({
    sessionId: params.mode === "resume" ? String(params.sourceSessionId) : String(params.sessionId),
    transcriptPath: `/cfg/${String(params.sessionId)}.jsonl`
  }));
  const supervisor = {
    start: vi.fn(async () => ({ ...runtime, launchDisposition: options.launchDisposition ?? "started" })),
    reconnect: vi.fn(() => host.proxy()),
    stop: vi.fn(async (value: SystemdSessionRuntimeRef) => ({ ...value, state: "stopped" as const })),
    inspect: vi.fn()
  };
  const eventSink = {
    handle: vi.fn(async (_sessionId: string, _event: DriverEvent) => undefined),
    restore: vi.fn(async () => undefined),
    recordIntentionalInterruption: vi.fn(async () => undefined)
  };
  const onRateLimit = vi.fn();
  const driver = new ClaudeSessionDriver(supervisor as unknown as RuntimeSupervisor, {
    runtimeSpec: (spec) => ({
      sessionId: spec.sessionId,
      capabilityId: "0123456789abcdef01234567",
      cwd: spec.cwd,
      agentVersion: null,
      command: () => ["node", "claudeHostMain.js"],
      environment: {},
      mcpServers: []
    }),
    hostLaunch: () => LAUNCH,
    journalFor: () => ({ append: async () => undefined }),
    eventSink,
    onRateLimit,
    now: () => new Date("2026-09-27T12:00:00.000Z")
  });
  return { host, supervisor, eventSink, onRateLimit, driver };
}

function managedSession(threadId: string): ManagedSession {
  return {
    id: "session-1",
    name: "Session",
    cwd: "/repo",
    provider: { kind: "claude", threadId, transcriptPath: null },
    runtime,
    capabilities: {} as ManagedSession["capabilities"],
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    discoveryConfidence: "high",
    status: "idle",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    approvalMode: "ask",
    inputMode: "default",
    models: {
      default: { model: "claude-opus", reasoningEffort: "high" },
      plan: { model: "claude-opus", reasoningEffort: "max" }
    },
    fastMode: false,
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  } as ManagedSession;
}

const spec = { sessionId: "session-1", name: "Session", cwd: "/repo", options: {} };
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

describe("ClaudeSessionDriver", () => {
  it("starts a runtime, initializes the host, and opens a new Claude session", async () => {
    const h = harness();
    const result = await h.driver.start(spec);
    expect(h.host.methods()).toEqual(["initialize", "session/open"]);
    expect(h.host.last("initialize")).toMatchObject({ protocolVersion: 1 });
    const open = h.host.last("session/open")!;
    expect(open).toMatchObject({ mode: "start", cwd: "/repo", launch: LAUNCH, replace: false });
    expect(open).not.toHaveProperty("sourceSessionId");
    expect(result).toMatchObject({
      sessionId: "session-1",
      provider: { kind: "claude", threadId: open.sessionId, transcriptPath: `/cfg/${String(open.sessionId)}.jsonl` },
      runtime: { agentVersion: "2.1.300" },
      launchDisposition: "started",
      capabilities: { steer: true, terminalAttach: false }
    });
    expect(h.eventSink.restore).not.toHaveBeenCalled();
  });

  it("resumes a session the host already owns without reopening it", async () => {
    const h = harness({
      initialState: hostState({ activeTurn: { id: "turn-9", status: "inProgress" }, status: { type: "active", activeFlags: [] } }),
      launchDisposition: "reused"
    });
    const result = await h.driver.resume({ ...spec, sourceThreadId: "thread-1" });
    expect(h.host.methods()).toEqual(["initialize"]);
    expect(result.provider.threadId).toBe("thread-1");
    expect(h.eventSink.restore).toHaveBeenCalledWith("session-1", "thread-1", { type: "active", activeFlags: [] }, { id: "turn-9", status: "inProgress" }, "2026-09-27T12:00:00.000Z");

    // The restored active turn is steerable.
    h.host.on("turn/steer", (params) => ({ turnId: params.expectedTurnId, messageUuid: params.messageUuid }));
    await h.driver.steer(managedSession("thread-1"), "more", "client-2");
    expect(h.host.last("turn/steer")).toMatchObject({ expectedTurnId: "turn-9", clientMessageId: "client-2", content: [{ type: "text", value: "more" }] });
  });

  it("replaces a different host session when resuming", async () => {
    const h = harness({ initialState: hostState({ sessionId: "stale" }) });
    await h.driver.resume({ ...spec, sourceThreadId: "thread-1" });
    expect(h.host.last("session/open")).toMatchObject({ mode: "resume", sessionId: "thread-1", sourceSessionId: "thread-1", replace: true });
    expect(() => h.driver.fork({ ...spec })).toThrow("requires a source session id");
  });

  it("stops a freshly started runtime when launch fails", async () => {
    const h = harness();
    h.host.on("session/open", () => { throw new Error("claude exploded"); });
    const failure = await h.driver.start(spec).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppServerLaunchAttemptError);
    expect(h.supervisor.stop).toHaveBeenCalledOnce();

    const reused = harness({ launchDisposition: "reused" });
    reused.host.on("session/open", () => { throw new Error("claude exploded"); });
    await expect(reused.driver.start(spec)).rejects.toBeInstanceOf(AppServerLaunchAttemptError);
    expect(reused.supervisor.stop).not.toHaveBeenCalled();
  });

  it("sends turns with deterministic submission uuids and maps steer rejections", async () => {
    const h = harness();
    const { provider } = await h.driver.start(spec);
    const session = managedSession(provider.threadId!);
    h.host.on("turn/start", (params) => ({ turnId: params.messageUuid, messageUuid: params.messageUuid }));
    const receipt = await h.driver.sendMessage({ ...session, inputMode: "plan", fastMode: true }, "hello", "client-1");
    const expectedUuid = submissionMessageUuid("session-1", "client-1", sha256Hex);
    expect(h.host.last("turn/start")).toEqual({
      clientMessageId: "client-1",
      messageUuid: expectedUuid,
      content: [{ type: "text", value: "hello" }],
      mode: "plan",
      model: "claude-opus",
      effort: "max",
      fastMode: true
    });
    expect(receipt).toEqual({ clientMessageId: "client-1", threadId: provider.threadId, turnId: expectedUuid, acceptedAt: "2026-09-27T12:00:00.000Z" });

    h.host.on("turn/steer", () => { throw new JsonRpcResponseError(HOST_ERROR.noActiveTurn, "Claude has no active turn to steer"); });
    await expect(h.driver.steer(session, "more", "client-2")).rejects.toBeInstanceOf(AppServerSteerUnavailableError);
    // The stale turn is forgotten, so the next steer fails without contacting the host.
    const steers = h.host.methods().filter((method) => method === "turn/steer").length;
    await expect(h.driver.steer(session, "more", "client-3")).rejects.toBeInstanceOf(AppServerSteerUnavailableError);
    expect(h.host.methods().filter((method) => method === "turn/steer")).toHaveLength(steers);

    await expect(h.driver.sendMessage(managedSession("other-thread"), "x", "c")).rejects.toThrow("not reconciled");
  });

  it("tracks turns from notifications and forwards events to subscribers and the event sink", async () => {
    const h = harness();
    const { provider } = await h.driver.start(spec);
    const threadId = provider.threadId!;
    const session = managedSession(threadId);
    const events: DriverEvent[] = [];
    const subscription = await h.driver.subscribe(session, (event) => events.push(event));

    await h.host.notify("turn/started", { threadId, turn: { id: "turn-1", status: "inProgress" } });
    h.host.on("turn/interrupt", () => ({ outcome: "interrupted" }));
    await expect(h.driver.interrupt(session, null, "operator" as never)).resolves.toBe("interrupted");
    expect(h.host.last("turn/interrupt")).toEqual({ turnId: "turn-1" });
    expect(h.eventSink.recordIntentionalInterruption).toHaveBeenCalledWith("session-1", threadId, "turn-1", "operator", "2026-09-27T12:00:00.000Z");

    await h.host.notify("sdk/message", { threadId, turnId: "turn-1", message: { type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.5 } } });
    expect(h.onRateLimit).toHaveBeenCalledWith({ status: "allowed", utilization: 0.5 });

    await h.host.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "interrupted" } });
    expect(events.map((event) => event.method)).toEqual(["turn/started", "sdk/message", "turn/completed"]);
    expect(h.eventSink.handle).toHaveBeenCalledTimes(3);
    h.host.on("turn/interrupt", (params) => ({ outcome: params.turnId ? "interrupted" : "already_idle" }));
    await expect(h.driver.interrupt(session, null)).resolves.toBe("already_idle");

    await subscription.close();
    await h.host.notify("thread/status/changed", { threadId, status: { type: "idle" } });
    expect(events).toHaveLength(3);
  });

  it("surfaces host requests as interactive events and answers them once", async () => {
    const h = harness();
    const { provider } = await h.driver.start(spec);
    const threadId = provider.threadId!;
    const session = managedSession(threadId);
    const events: DriverEvent[] = [];
    await h.driver.subscribe(session, (event) => events.push(event));
    const approvalParams = { threadId, turnId: "turn-1", itemId: "tu-1", toolName: "Bash", category: "command", title: "Run x", command: "x", cwd: "/repo", reason: null, prefixRule: ["x"], input: {} };

    await h.host.notify("request/opened", { requestId: "req:tu-1", method: "claude/approval", params: approvalParams, openedAt: "2026-09-27T11:00:00.000Z" });
    expect(events.at(-1)).toEqual({
      method: "claude/approval",
      params: { requestId: "req:tu-1", params: approvalParams, openedAt: "2026-09-27T11:00:00.000Z" },
      receivedAt: "2026-09-27T12:00:00.000Z"
    });

    h.host.on("request/respond", () => ({ accepted: true }));
    await expect(h.driver.answerQuestion(session, "req:tu-1", { answers: {} } as never)).rejects.toThrow("is not a claude/question request");
    await h.driver.answerApproval(session, "req:tu-1", "approve_for_prefix");
    expect(h.host.last("request/respond")).toEqual({ requestId: "req:tu-1", response: { behavior: "allow", scope: "prefix" } });
    await expect(h.driver.answerApproval(session, "req:tu-1", "deny")).rejects.toThrow("already answered");
    await expect(h.driver.answerApproval(session, "missing", "deny")).rejects.toThrow("Unknown Claude request id");

    for (const [decision, response] of [
      ["approve_once", { behavior: "allow", scope: "once" }],
      ["approve_for_session", { behavior: "allow", scope: "session" }],
      ["deny", { behavior: "deny" }]
    ] as const) {
      await h.host.notify("request/opened", { requestId: `req:${decision}`, method: "claude/approval", params: { ...approvalParams, itemId: decision } });
      await h.driver.answerApproval(session, `req:${decision}`, decision);
      expect(h.host.last("request/respond")).toEqual({ requestId: `req:${decision}`, response });
    }

    const questionParams = { threadId, turnId: "turn-1", itemId: "ask-1", questions: [{ id: "q0", header: "", question: "Q?", options: [], multiSelect: false }] };
    await h.host.notify("request/opened", { requestId: "req:ask-1", method: "claude/question", params: questionParams });
    await h.driver.answerQuestion(session, "req:ask-1", { answers: { q0: { answers: ["yes"] } } } as never);
    expect(h.host.last("request/respond")).toEqual({ requestId: "req:ask-1", response: { answers: { q0: { answers: ["yes"] } } } });

    // A request the host no longer holds is reported as stale.
    await h.host.notify("request/opened", { requestId: "req:gone", method: "claude/approval", params: { ...approvalParams, itemId: "gone" } });
    h.host.on("request/respond", () => ({ accepted: false }));
    await expect(h.driver.answerApproval(session, "req:gone", "approve_once")).rejects.toThrow("no longer waiting");
    await expect(h.driver.answerApproval(session, "req:gone", "approve_once")).rejects.toThrow("Unknown Claude request id");

    // Resolution and turn completion forget pending requests.
    await h.host.notify("request/opened", { requestId: "req:resolved", method: "claude/approval", params: { ...approvalParams, itemId: "resolved" } });
    await h.host.notify("serverRequest/resolved", { threadId, requestId: "req:resolved", resolution: "cancelled" });
    await expect(h.driver.answerApproval(session, "req:resolved", "deny")).rejects.toThrow("Unknown Claude request id");
    await h.host.notify("request/opened", { requestId: "req:ended", method: "claude/approval", params: { ...approvalParams, itemId: "ended" } });
    await h.host.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
    await expect(h.driver.answerApproval(session, "req:ended", "deny")).rejects.toThrow("Unknown Claude request id");

    // Malformed request notifications are dropped.
    const count = events.length;
    await h.host.notify("request/opened", { requestId: "req:bad", method: "claude/approval", params: { threadId } });
    expect(events).toHaveLength(count);
  });

  it("reports hibernation blockers from host state", async () => {
    const h = harness();
    const { provider } = await h.driver.start(spec);
    const session = managedSession(provider.threadId!);
    h.host.on("state/read", () => hostState({
      activeTurn: { id: "t", status: "inProgress" },
      pendingRequests: [{ requestId: "r", method: "claude/approval", params: {} as never, openedAt: "" }],
      backgroundTasks: [{ taskId: "task", toolUseId: null, turnId: null, description: "" }]
    }));
    await expect(h.driver.hibernationBlockers(session)).resolves.toEqual(["active_turn", "interactive_request", "background_terminal"]);
    await expect(h.driver.hibernate(session)).rejects.toThrow("cannot hibernate");

    h.host.on("state/read", () => hostState());
    h.host.on("shutdown", () => ({}));
    await expect(h.driver.hibernate(session)).resolves.toMatchObject({ state: "hibernated" });
    expect(h.host.last("shutdown")).toEqual({ force: false });
    expect(h.supervisor.stop).toHaveBeenCalledOnce();
  });

  it("maps preferences to host settings updates", async () => {
    const h = harness();
    const { provider } = await h.driver.start(spec);
    const session = managedSession(provider.threadId!);
    h.host.on("settings/update", () => ({}));
    await h.driver.setPreferences(session, { mode: "plan", fastMode: true });
    expect(h.host.last("settings/update")).toEqual({ permissionMode: "plan", model: "claude-opus", effort: "max", fastMode: true });
  });
});
