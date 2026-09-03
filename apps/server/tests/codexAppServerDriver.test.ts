import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import {
  CodexAppServerDriver,
  type AppServerDriverEventSink,
  type AppServerRequestStore
} from "../src/services/sessionDrivers/codexAppServerDriver.js";
import type { AppServerSessionConnection, AppServerSessionHandlers } from "../src/services/sessionDrivers/codexAppServerConnectionManager.js";
import type { JsonRpcConnection } from "../src/services/sessionDrivers/jsonRpcConnection.js";
import type { RuntimeStartSpec, RuntimeSupervisor, SystemdSessionRuntimeRef } from "../src/services/sessionDrivers/types.js";

const runtime: SystemdSessionRuntimeRef = {
  kind: "systemd_service",
  unit: "muxpilot-session-0123456789abcdef01234567.service",
  socketPath: "/run/muxpilot/app.sock",
  state: "connected",
  codexVersion: "0.152.0"
};

describe("CodexAppServerDriver", () => {
  it("starts, resumes, and forks through durable runtime establishment", async () => {
    const harness = createHarness();
    const start = await harness.driver.start(launchSpec());
    const resume = await harness.driver.resume(launchSpec("source-thread"));
    const fork = await harness.driver.fork(launchSpec("source-thread"));

    expect(harness.supervisor.start).toHaveBeenCalledTimes(3);
    expect(harness.connections.start).toHaveBeenCalledOnce();
    expect(harness.connections.reconnect).toHaveBeenCalledOnce();
    expect(harness.connections.fork).toHaveBeenCalledOnce();
    expect([start, resume, fork].map((result) => result.provider.threadId)).toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(start.capabilities).toMatchObject({
      sendMessage: true,
      approvals: true,
      questions: true,
      planActions: true,
      rawTerminalCapture: false
    });
  });

  it("sends verified structured turns only on the reconciled thread", async () => {
    const harness = createHarness();
    const session = managedSession();
    const receipt = await harness.driver.sendMessage(session, "hello", "client-1");

    expect(harness.rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      clientUserMessageId: "client-1",
      cwd: "/repo"
    }));
    expect(receipt).toEqual({
      clientMessageId: "client-1",
      threadId: "thread-1",
      turnId: "turn-1",
      acceptedAt: "2026-09-01T12:00:00.000Z"
    });
    harness.rpc.request.mockResolvedValueOnce({ turnId: "turn-1" });
    await expect(harness.driver.steer(session, "follow up", "turn-1", "client-2")).resolves.toMatchObject({
      clientMessageId: "client-2",
      turnId: "turn-1"
    });
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "follow up" }],
      clientUserMessageId: "client-2"
    });

    harness.connection.threadId = "different-thread";
    await expect(harness.driver.sendMessage(session, "unsafe", "client-3")).rejects.toThrow("not reconciled");
  });

  it("reconciles a stable client message identity before input retry", async () => {
    const harness = createHarness();
    harness.rpc.request.mockResolvedValueOnce({
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-existing", items: [{ type: "userMessage", clientId: "client-1" }] }]
      }
    });
    await expect(harness.driver.reconcileInput(managedSession(), "client-1")).resolves.toEqual({
      clientMessageId: "client-1",
      threadId: "thread-1",
      turnId: "turn-existing",
      acceptedAt: "2026-09-01T12:00:00.000Z"
    });

    harness.rpc.request.mockResolvedValueOnce({ thread: { id: "thread-1", turns: [] } });
    await expect(harness.driver.reconcileInput(managedSession(), "missing-client")).resolves.toBeNull();
  });

  it("resolves the Codex default model when switching collaboration modes", async () => {
    const harness = createHarness();
    const session = managedSession();
    session.models.plan = { model: null, reasoningEffort: null };
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "model/list") return { data: [{ model: "gpt-default", isDefault: true }] };
      if (method === "collaborationMode/list") return { data: [{ mode: "plan", reasoning_effort: "medium" }] };
      return {};
    });

    await harness.driver.setPreferences(session, { mode: "plan" });

    expect(harness.rpc.request).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "thread-1",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-default",
          reasoning_effort: "medium",
          developer_instructions: null
        }
      }
    });
  });

  it("fans out protocol events without allowing a subscriber to fail transport", async () => {
    const harness = createHarness();
    const observed: string[] = [];
    await harness.driver.start(launchSpec());
    await harness.driver.subscribe(managedSession(), () => { throw new Error("UI failed"); });
    const subscription = await harness.driver.subscribe(managedSession(), (event) => observed.push(event.method));
    await expect(harness.handlers.notification?.({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-9" } }
    })).resolves.toBeUndefined();
    await harness.handlers.serverRequest?.({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-9" }
    });
    expect(observed).toEqual(["turn/started", "item/fileChange/requestApproval"]);
    await subscription.close();
  });

  it("awaits durable event reconciliation before subscriber delivery and restores resume state", async () => {
    const order: string[] = [];
    const sink = {
      handle: vi.fn(async () => { order.push("persisted"); }),
      restore: vi.fn(async () => { order.push("restored"); })
    } satisfies AppServerDriverEventSink;
    const harness = createHarness(undefined, sink);
    await harness.driver.start(launchSpec());
    await harness.driver.subscribe(managedSession(), () => { order.push("subscriber"); });
    await harness.handlers.notification?.({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } }
    });
    expect(order).toEqual(["persisted", "subscriber"]);
    expect(sink.handle).toHaveBeenCalledWith("session-1", expect.objectContaining({
      method: "turn/started",
      receivedAt: "2026-09-01T12:00:00.000Z"
    }));

    await harness.driver.resume(launchSpec("thread-1"));
    expect(sink.restore).toHaveBeenCalledWith("session-1", "thread-1", "2026-09-01T12:00:00.000Z");
    expect(order).toContain("restored");

    sink.restore.mockRejectedValueOnce(new Error("checkpoint mismatch"));
    await expect(harness.driver.resume(launchSpec("thread-1"))).rejects.toThrow("checkpoint mismatch");
    expect(harness.connections.close).toHaveBeenCalledWith("session-1");
    expect(harness.supervisor.stop).toHaveBeenCalledWith(runtime);
  });

  it("resolves replayable approvals and questions exactly once until Codex confirms resolution", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());
    await harness.handlers.serverRequest?.({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", proposedExecpolicyAmendment: ["git", "status"] }
    });
    await harness.handlers.serverRequest?.({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1" }
    });

    await harness.driver.answerApproval(session, "approval-1", "approve_for_prefix");
    expect(harness.rpc.respond).toHaveBeenCalledWith("approval-1", {
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }
    });
    await expect(harness.driver.answerApproval(session, "approval-1", "approve_once")).rejects.toThrow("already answered");
    await harness.driver.answerQuestion(session, "question-1", { answers: { choice: { answers: ["yes"] } } });
    expect(harness.rpc.respond).toHaveBeenCalledWith("question-1", { answers: { choice: { answers: ["yes"] } } });

    await harness.handlers.notification?.({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "approval-1" }
    });
    await expect(harness.driver.answerApproval(session, "approval-1", "approve_once")).rejects.toThrow("Unknown");
  });

  it("maps permission-profile grant scopes and denial without inventing permissions", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());
    await harness.handlers.serverRequest?.({
      id: 17,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-1",
        permissions: { network: { enabled: true } }
      }
    });
    await harness.driver.answerApproval(session, 17, "approve_for_session");
    expect(harness.rpc.respond).toHaveBeenCalledWith(17, {
      permissions: { network: { enabled: true } },
      scope: "session"
    });

    await harness.handlers.serverRequest?.({
      id: "permission-deny",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-2",
        permissions: { fileSystem: { write: ["/repo"] } }
      }
    });
    await harness.driver.answerApproval(session, "permission-deny", "deny");
    expect(harness.rpc.respond).toHaveBeenCalledWith("permission-deny", { permissions: {}, scope: "turn" });
  });

  it("implements plans on the current thread and in a genuinely fresh thread", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());

    const implemented = await harness.driver.choosePlanAction(session, "implement", {
      plan: "1. Build it",
      clientMessageId: "implement-message"
    });
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread-1",
      clientUserMessageId: "implement-message",
      input: [{ type: "text", text: "Implement the plan." }]
    }));
    expect(implemented).toMatchObject({
      provider: { threadId: "thread-1" },
      receipt: { clientMessageId: "implement-message", threadId: "thread-1" }
    });

    harness.connection.threadId = "thread-fresh";
    const cleared = await harness.driver.choosePlanAction(session, "clear_context_implement", {
      plan: "1. Build it",
      clientMessageId: "clear-message",
      launchOptions: { model: "gpt-5.6", writableRoots: ["/repo"], developerInstructions: "Use the repository rules." }
    });
    expect(harness.connections.start).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-1",
      settings: expect.objectContaining({
        cwd: "/repo",
        model: "gpt-5.6",
        runtimeWorkspaceRoots: ["/repo"]
      })
    }));
    expect(harness.rpc.request).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({
      threadId: "thread-fresh",
      clientUserMessageId: "clear-message",
      input: [{ type: "text", text: expect.stringContaining("Implement the plan in a fresh context") }]
    }));
    expect(cleared).toMatchObject({
      provider: { threadId: "thread-fresh" },
      receipt: { clientMessageId: "clear-message", threadId: "thread-fresh" }
    });

    const requestCount = harness.rpc.request.mock.calls.length;
    await expect(harness.driver.choosePlanAction(session, "stay_in_plan", {
      plan: null,
      clientMessageId: null
    })).resolves.toMatchObject({ provider: { threadId: "thread-1" }, receipt: null });
    expect(harness.rpc.request).toHaveBeenCalledTimes(requestCount);
  });

  it("persists gates before delivery and seeds reconnect replay from durable state", async () => {
    const store = requestStore();
    const sink = { handle: vi.fn(async () => undefined), restore: vi.fn(async () => undefined) };
    store.listUnresolvedAppServerRequests.mockResolvedValue([
      { requestId: "approval-1", state: "pending", response: null },
      { requestId: 2, state: "responded", response: { decision: "accept" } }
    ]);
    const harness = createHarness(store as unknown as AppServerRequestStore, sink);
    await harness.driver.resume(launchSpec("thread-1"));
    expect(harness.connections.reconnect).toHaveBeenCalledWith(expect.objectContaining({
      expectedPendingRequestIds: ["approval-1", 2]
    }));
    expect(harness.rpc.respond).toHaveBeenCalledWith(2, { decision: "accept" });

    await harness.handlers.serverRequest?.({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" }
    });
    expect(store.upsertAppServerRequest).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      requestId: "approval-1",
      threadId: "thread-1",
      turnId: "turn-1"
    }));
    expect(sink.handle).toHaveBeenCalledWith("session-1", expect.objectContaining({
      method: "item/commandExecution/requestApproval",
      params: expect.objectContaining({ requestId: "approval-1" })
    }));
    expect(store.upsertAppServerRequest.mock.invocationCallOrder[0]).toBeLessThan(
      sink.handle.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    await harness.driver.answerApproval(managedSession(), "approval-1", "approve_once");
    expect(store.claimAppServerRequestResponse).toHaveBeenCalledWith(
      "session-1",
      "approval-1",
      { decision: "accept" },
      "2026-09-01T12:00:00.000Z"
    );
    expect(store.claimAppServerRequestResponse.mock.invocationCallOrder[0]).toBeLessThan(
      harness.rpc.respond.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY
    );
    await harness.handlers.notification?.({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "approval-1" }
    });
    expect(store.resolveAppServerRequest).toHaveBeenCalledWith(
      "session-1",
      "approval-1",
      "2026-09-01T12:00:00.000Z"
    );

    await harness.handlers.serverRequest?.({
      id: "terminal-approval",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-2" }
    });
    store.resolveAppServerTurnRequests.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(harness.handlers.notification?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2" } }
    })).rejects.toThrow("database unavailable");
    await expect(harness.driver.answerApproval(
      managedSession(),
      "terminal-approval",
      "approve_once"
    )).resolves.toBeUndefined();
    await expect(harness.handlers.notification?.({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-2" } }
    })).resolves.toBeUndefined();
    expect(store.resolveAppServerTurnRequests).toHaveBeenLastCalledWith(
      "session-1",
      "thread-1",
      "turn-2",
      "2026-09-01T12:00:00.000Z"
    );
    await expect(harness.driver.answerApproval(
      managedSession(),
      "terminal-approval",
      "approve_once"
    )).rejects.toThrow("Unknown");
  });

  it("interrupts active work, terminates background processes, and stops the service on kill", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.sendMessage(session, "work", "client-1");
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/backgroundTerminals/list") return { data: [{ processId: "process-1" }] };
      return {};
    });

    await harness.driver.kill(session);

    expect(harness.rpc.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "thread-1", turnId: "turn-1" });
    expect(harness.rpc.request).toHaveBeenCalledWith("thread/backgroundTerminals/terminate", {
      threadId: "thread-1",
      processId: "process-1"
    });
    expect(harness.connections.close).toHaveBeenCalledWith("session-1");
    expect(harness.supervisor.stop).toHaveBeenCalledWith(runtime);
  });

  it("interrupts the turn and terminates surviving background terminals", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());
    await harness.driver.sendMessage(session, "work", "client-1");
    await harness.handlers.notification?.({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", processId: "process-1" }
      }
    });
    harness.rpc.request.mockResolvedValue({});

    await harness.driver.interrupt(session, null);

    expect(harness.rpc.request.mock.calls.slice(-2)).toEqual([
      ["turn/interrupt", { threadId: "thread-1", turnId: "turn-1" }],
      ["thread/backgroundTerminals/terminate", { threadId: "thread-1", processId: "process-1" }]
    ]);
    await expect(harness.driver.interrupt(session, null)).rejects.toThrow("without an active turn id");
  });

  it("blocks hibernation for background terminals and otherwise stops cleanly", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());
    harness.rpc.request.mockImplementation(async (method: string) =>
      method === "thread/backgroundTerminals/list" ? { data: [{ processId: "dev-server" }] } : {}
    );
    await expect(harness.driver.hibernationBlockers(session)).resolves.toContain("background_terminal");
    await expect(harness.driver.hibernate(session)).rejects.toThrow("background_terminal");
    expect(harness.supervisor.stop).not.toHaveBeenCalled();

    harness.rpc.request.mockImplementation(async (method: string) =>
      method === "thread/backgroundTerminals/list" ? { data: [] } : {}
    );
    await expect(harness.driver.hibernate(session)).resolves.toMatchObject({ state: "hibernated" });
    expect(harness.connections.close).toHaveBeenCalledWith(session.id);
    expect(harness.supervisor.stop).toHaveBeenCalledWith(runtime);
  });
});

function createHarness(requestStore?: AppServerRequestStore, eventSink?: AppServerDriverEventSink): {
  driver: CodexAppServerDriver;
  supervisor: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  connections: Record<string, ReturnType<typeof vi.fn>>;
  connection: { threadId: string; rpc: JsonRpcConnection };
  rpc: { request: ReturnType<typeof vi.fn>; respond: ReturnType<typeof vi.fn> };
  handlers: AppServerSessionHandlers;
} {
  const rpc = {
    request: vi.fn(async (method: string) => method === "turn/start" ? { turn: { id: "turn-1" } } : {}),
    respond: vi.fn(async () => undefined)
  };
  const connection = {
    sessionId: "session-1",
    threadId: "thread-1",
    connectionId: "connection-1",
    rpc: rpc as unknown as JsonRpcConnection,
    reconciliation: {},
    close: vi.fn(async () => undefined)
  } as unknown as AppServerSessionConnection & { threadId: string };
  let handlers: AppServerSessionHandlers = {};
  const establish = async (spec: { handlers?: AppServerSessionHandlers }) => {
    handlers = spec.handlers ?? {};
    return connection;
  };
  const connections = {
    start: vi.fn(establish),
    reconnect: vi.fn(establish),
    fork: vi.fn(establish),
    get: vi.fn(() => connection),
    close: vi.fn(async () => undefined)
  };
  const supervisor = {
    start: vi.fn(async () => runtime),
    stop: vi.fn(async () => ({ ...runtime, state: "stopped" as const }))
  };
  const driver = new CodexAppServerDriver(
    supervisor as unknown as RuntimeSupervisor,
    connections as unknown as ConstructorParameters<typeof CodexAppServerDriver>[1],
    {
      runtimeSpec: (spec) => ({
        sessionId: spec.sessionId,
        capabilityId: "0123456789abcdef01234567",
        cwd: spec.cwd,
        codexHome: "/codex",
        codexVersion: "0.152.0",
        environment: {}
      } satisfies RuntimeStartSpec),
      requestStore,
      eventSink,
      now: () => new Date("2026-09-01T12:00:00.000Z")
    }
  );
  return { driver, supervisor, connections, connection, rpc, get handlers() { return handlers; } };
}

function requestStore() {
  return {
    upsertAppServerRequest: vi.fn(async () => ({})),
    listUnresolvedAppServerRequests: vi.fn(async () => [] as Array<{
      requestId: string | number;
      state: "pending" | "responded" | "resolved";
    }>),
    claimAppServerRequestResponse: vi.fn(async () => ({})),
    resolveAppServerRequest: vi.fn(async () => true),
    resolveAppServerTurnRequests: vi.fn(async () => 0)
  };
}

function launchSpec(sourceThreadId?: string) {
  return {
    sessionId: "session-1",
    name: "Session",
    cwd: "/repo",
    sourceThreadId,
    options: { model: "gpt-5.6", reasoningEffort: "high", writableRoots: ["/repo"] }
  };
}

function managedSession(): ManagedSession {
  return {
    id: "session-1",
    name: "Session",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: null },
    driverKind: "codex_app_server",
    runtime,
    capabilities: {} as ManagedSession["capabilities"],
    tmux: {} as ManagedSession["tmux"],
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "idle",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: {
      default: { model: "gpt-5.6", reasoningEffort: "high" },
      plan: { model: "gpt-5.6", reasoningEffort: "high" }
    },
    fastMode: true,
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
