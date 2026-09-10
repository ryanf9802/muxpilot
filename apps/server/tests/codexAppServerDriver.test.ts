import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import {
  AppServerSteerUnavailableError,
  CodexAppServerDriver,
  type AppServerDriverEventSink,
  type AppServerProcessStore,
  type AppServerRequestStore
} from "../src/services/sessionDrivers/codexAppServerDriver.js";
import type { AppServerSessionConnection, AppServerSessionHandlers } from "../src/services/sessionDrivers/codexAppServerConnectionManager.js";
import { JsonRpcResponseError, type JsonRpcConnection } from "../src/services/sessionDrivers/jsonRpcConnection.js";
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
      planActions: true
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
    await expect(harness.driver.steer(session, "follow up", "client-2")).resolves.toMatchObject({
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
        status: { type: "idle" }
      }
    }).mockResolvedValueOnce({
      data: [{ id: "turn-existing", items: [{ type: "userMessage", clientId: "client-1" }] }],
      nextCursor: null
    });
    await expect(harness.driver.reconcileInput(managedSession(), "client-1")).resolves.toEqual({
      clientMessageId: "client-1",
      threadId: "thread-1",
      turnId: "turn-existing",
      acceptedAt: "2026-09-01T12:00:00.000Z"
    });

    harness.rpc.request.mockResolvedValueOnce({ thread: { id: "thread-1", status: { type: "idle" } } })
      .mockResolvedValueOnce({ data: [], nextCursor: null });
    await expect(harness.driver.reconcileInput(managedSession(), "missing-client")).resolves.toBeNull();
  });

  it("fails definitively when there is no active turn to steer", async () => {
    const harness = createHarness();

    await expect(harness.driver.steer(managedSession(), "follow up", "client-2"))
      .rejects.toBeInstanceOf(AppServerSteerUnavailableError);
    expect(harness.rpc.request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
  });

  it("classifies Codex non-steerable turn responses as definitive", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.sendMessage(session, "hello", "client-1");
    harness.rpc.request.mockRejectedValueOnce(new JsonRpcResponseError(
      -32600,
      "The active turn is not steerable",
      { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } }
    ));

    await expect(harness.driver.steer(session, "follow up", "client-2"))
      .rejects.toBeInstanceOf(AppServerSteerUnavailableError);
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

  it("isolates built-in subagent activity while preserving its interactive requests", async () => {
    const store = requestStore();
    store.upsertAppServerRequest.mockResolvedValue({ state: "pending", response: null });
    const processStore = processStoreHarness();
    const sink = {
      handle: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined)
    } satisfies AppServerDriverEventSink;
    const harness = createHarness(
      store as unknown as AppServerRequestStore,
      sink,
      processStore
    );
    await harness.driver.start(launchSpec());
    await harness.handlers.notification?.({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-root" } }
    });
    sink.handle.mockClear();

    await harness.handlers.notification?.({
      method: "turn/started",
      params: { threadId: "thread-child", turn: { id: "turn-child" } }
    });
    await harness.handlers.notification?.({
      method: "item/started",
      params: {
        threadId: "thread-child",
        turnId: "turn-child",
        item: { id: "command-child", type: "commandExecution", processId: "process-child" }
      }
    });
    await harness.handlers.notification?.({
      method: "item/completed",
      params: {
        threadId: "thread-child",
        turnId: "turn-child",
        item: { id: "agent-child", type: "agentMessage", text: "child-only answer" }
      }
    });
    expect(sink.handle).not.toHaveBeenCalled();
    expect(processStore.upsertAppServerCommandProcess).not.toHaveBeenCalled();

    await harness.handlers.serverRequest?.({
      id: "child-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-child", turnId: "turn-child", itemId: "command-child" }
    });
    expect(store.upsertAppServerRequest).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      threadId: "thread-child",
      turnId: "turn-child"
    }));
    expect(sink.handle).toHaveBeenCalledOnce();
    await harness.driver.answerApproval(managedSession(), "child-approval", "deny");
    expect(harness.rpc.respond).toHaveBeenCalledWith("child-approval", { decision: "decline" });

    await harness.handlers.notification?.({
      method: "turn/completed",
      params: { threadId: "thread-child", turn: { id: "turn-child", status: "completed" } }
    });
    expect(store.resolveAppServerTurnRequests).toHaveBeenCalledWith(
      "session-1",
      "thread-child",
      "turn-child",
      "2026-09-01T12:00:00.000Z"
    );
    await expect(harness.driver.answerApproval(managedSession(), "child-approval", "deny")).rejects.toThrow("Unknown");

    await harness.driver.interrupt(managedSession(), null);
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-root"
    });
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
    expect(sink.restore).toHaveBeenCalledWith(
      "session-1",
      "thread-1",
      { type: "idle" },
      "2026-09-01T12:00:00.000Z"
    );
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

  it("replays an interactive request when Codex reports the gate without delivering it", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(undefined, undefined, undefined, 100);
      await harness.driver.start(launchSpec());
      harness.rpc.request.mockImplementation(async (method: string) => {
        if (method === "thread/read") {
          return { thread: { id: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } } };
        }
        if (method === "thread/resume") return { thread: { id: "thread-1" } };
        return {};
      });

      await harness.handlers.notification?.({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }
      });
      await harness.handlers.serverRequest?.({
        id: "child-question",
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-child", turnId: "turn-child", itemId: "call-child-question" }
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(harness.rpc.request).toHaveBeenCalledWith("thread/read", { threadId: "thread-1", includeTurns: false });
      expect(harness.rpc.request).toHaveBeenCalledWith("thread/resume", { threadId: "thread-1", excludeTurns: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay when the native interactive request follows its status", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(undefined, undefined, undefined, 100);
      await harness.driver.start(launchSpec());
      await harness.handlers.notification?.({
        method: "thread/status/changed",
        params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }
      });
      await harness.handlers.serverRequest?.({
        id: 0,
        method: "item/tool/requestUserInput",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "call-question" }
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(harness.rpc.request).not.toHaveBeenCalledWith("thread/read", expect.anything());
      expect(harness.rpc.request).not.toHaveBeenCalledWith("thread/resume", expect.anything());
    } finally {
      vi.useRealTimers();
    }
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

  it("accepts a new pending request when Codex reuses a responded wire id", async () => {
    const store = requestStore();
    store.upsertAppServerRequest.mockResolvedValue({ state: "pending", response: null });
    const harness = createHarness(store as unknown as AppServerRequestStore);
    const session = managedSession();
    await harness.driver.start(launchSpec());
    await harness.handlers.serverRequest?.({
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1" }
    });
    await harness.driver.answerApproval(session, 0, "deny");

    await harness.handlers.serverRequest?.({
      id: 0,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-2", itemId: "question-1" }
    });
    await expect(harness.driver.answerQuestion(
      session,
      0,
      { answers: { choice: { answers: ["yes"] } } }
    )).resolves.toBeUndefined();
    expect(harness.rpc.respond).toHaveBeenLastCalledWith(0, {
      answers: { choice: { answers: ["yes"] } }
    });
  });

  it("implements plans on the current thread and in a genuinely fresh thread", async () => {
    const harness = createHarness();
    const session = managedSession();
    session.inputMode = "plan";
    session.models.default = { model: null, reasoningEffort: null };
    session.models.plan = { model: null, reasoningEffort: null };
    await harness.driver.start(launchSpec());
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "model/list") return { data: [{ model: "gpt-default", isDefault: true }] };
      if (method === "collaborationMode/list") return { data: [{ mode: "default", reasoning_effort: "medium" }] };
      return {};
    });

    const implemented = await harness.driver.choosePlanAction(session, "implement", {
      plan: "1. Build it",
      clientMessageId: "implement-message"
    });
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "thread-1",
      clientUserMessageId: "implement-message",
      input: [{ type: "text", text: "Implement the plan." }],
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-default",
          reasoning_effort: "medium",
          developer_instructions: null
        }
      }
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
      input: [{ type: "text", text: expect.stringContaining("Implement the plan in a fresh context") }],
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-default",
          reasoning_effort: "medium",
          developer_instructions: null
        }
      }
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
      settings: expect.objectContaining({
        cwd: "/repo",
        runtimeWorkspaceRoots: ["/repo"]
      }),
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

    expect(harness.rpc.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" }
    );
    expect(harness.rpc.request).toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      { threadId: "thread-1", processId: "process-1" }
    );
    await expect(harness.driver.interrupt(session, null)).rejects.toThrow("without an active turn id");
  });

  it("persists command ownership before exposing lifecycle events and removes it on completion", async () => {
    const processStore = processStoreHarness();
    const sink = {
      handle: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined)
    } satisfies AppServerDriverEventSink;
    const harness = createHarness(undefined, sink, processStore);
    await harness.driver.start(launchSpec());
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", processId: "process-1" }
    };

    await harness.handlers.notification?.({ method: "item/started", params });
    expect(processStore.upsertAppServerCommandProcess).toHaveBeenCalledWith({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      processId: "process-1",
      observedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(processStore.upsertAppServerCommandProcess.mock.invocationCallOrder[0]).toBeLessThan(
      sink.handle.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );

    await harness.handlers.notification?.({ method: "item/completed", params });
    expect(processStore.removeAppServerCommandProcess).toHaveBeenCalledWith(
      "session-1", "thread-1", "command-1", "process-1"
    );
  });

  it("restores exact active interruption ownership when Codex omits all live commands from reconnect", async () => {
    const harness = createHarness();
    harness.connections.reconnect.mockImplementationOnce(async () => ({
      ...harness.connection,
      reconciliation: {
        ...harness.connection.reconciliation,
        current: {
          thread: {
            id: "thread-1",
            status: { type: "active" },
            turns: [
              {
                id: "turn-completed",
                status: "completed",
                itemsView: "full",
                items: [{ id: "item-completed-output", type: "agentMessage" }]
              },
              {
                id: "turn-restored",
                status: "inProgress",
                itemsView: "full",
                items: [{ id: "item-user", type: "userMessage" }]
              }
            ]
          }
        },
        journalProcessOwnership: [
          { threadId: "thread-1", turnId: "turn-completed", itemId: "item-persistent", processId: "process-persistent" },
          { threadId: "thread-1", turnId: "turn-restored", itemId: "item-restored", processId: "process-restored" }
        ]
      }
    }));
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/backgroundTerminals/list") {
        return { data: [
          { itemId: "item-restored", processId: "process-restored" },
          { itemId: "item-persistent", processId: "process-persistent" }
        ] };
      }
      return {};
    });

    await harness.driver.resume(launchSpec("thread-1"));
    await harness.driver.interrupt(managedSession(), null);

    expect(harness.rpc.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-restored" }
    );
    expect(harness.rpc.request).toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      { threadId: "thread-1", processId: "process-restored" }
    );
    expect(harness.rpc.request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      { threadId: "thread-1", processId: "process-persistent" }
    );
  });

  it("does not infer terminal ownership without durable correlation", async () => {
    const harness = createHarness();
    harness.connections.reconnect.mockImplementationOnce(async () => ({
      ...harness.connection,
      reconciliation: {
        ...harness.connection.reconciliation,
        current: {
          thread: {
            id: "thread-1",
            status: { type: "active" },
            turns: [
              { id: "turn-completed", status: "completed", itemsView: "summary", items: [] },
              { id: "turn-restored", status: "inProgress", itemsView: "full", items: [] }
            ]
          }
        }
      }
    }));
    harness.rpc.request.mockImplementation(async (method: string) =>
      method === "thread/backgroundTerminals/list"
        ? { data: [{ itemId: "item-unknown", processId: "process-unknown" }] }
        : {}
    );

    await harness.driver.resume(launchSpec("thread-1"));
    await harness.driver.interrupt(managedSession(), null);

    expect(harness.rpc.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-restored" }
    );
    expect(harness.rpc.request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      expect.anything()
    );
  });

  it("uses database ownership when the corresponding journal entry has rotated away", async () => {
    const processStore = processStoreHarness();
    processStore.listAppServerCommandProcesses.mockResolvedValue([
      {
        sessionId: "session-1", threadId: "thread-1", turnId: "turn-completed",
        itemId: "item-persistent", processId: "process-persistent", observedAt: "2026-09-01T11:00:00.000Z"
      },
      {
        sessionId: "session-1", threadId: "thread-1", turnId: "turn-restored",
        itemId: "item-restored", processId: "process-restored", observedAt: "2026-09-01T12:00:00.000Z"
      }
    ]);
    const harness = createHarness(undefined, undefined, processStore);
    harness.connections.reconnect.mockImplementationOnce(async () => ({
      ...harness.connection,
      reconciliation: {
        ...harness.connection.reconciliation,
        current: {
          thread: {
            id: "thread-1",
            status: { type: "active" },
            turns: [
              { id: "turn-completed", status: "completed", itemsView: "full", items: [] },
              { id: "turn-restored", status: "inProgress", itemsView: "full", items: [] }
            ]
          }
        }
      }
    }));
    harness.rpc.request.mockImplementation(async (method: string) => method === "thread/backgroundTerminals/list"
      ? { data: [
          { itemId: "item-restored", processId: "process-restored" },
          { itemId: "item-persistent", processId: "process-persistent" }
        ] }
      : {});

    await harness.driver.resume(launchSpec("thread-1"));
    await harness.driver.interrupt(managedSession(), null);

    expect(harness.rpc.request).toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      { threadId: "thread-1", processId: "process-restored" }
    );
    expect(harness.rpc.request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/terminate",
      { threadId: "thread-1", processId: "process-persistent" }
    );
    expect(processStore.removeAppServerTurnCommandProcesses).toHaveBeenCalledWith(
      "session-1", "thread-1", "turn-restored"
    );
  });

  it("preserves a newer turn notification that races reconnect reconciliation", async () => {
    const harness = createHarness();
    await harness.driver.sendMessage(managedSession(), "old work", "client-old");
    harness.connections.reconnect.mockImplementationOnce(async (spec: { handlers?: AppServerSessionHandlers }) => {
      await spec.handlers?.notification?.({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-new" } }
      });
      return {
        ...harness.connection,
        reconciliation: {
          ...harness.connection.reconciliation,
          current: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } }
        }
      };
    });

    await harness.driver.resume(launchSpec("thread-1"));
    harness.rpc.request.mockResolvedValue({});
    await harness.driver.interrupt(managedSession(), null);

    expect(harness.rpc.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-new" }
    );
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

  it("clears a stale active turn only after an authoritative idle terminal read", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.sendMessage(session, "work", "client-1");
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "thread-1",
            status: { type: "idle" }
          }
        };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed" }], nextCursor: null };
      }
      if (method === "thread/backgroundTerminals/list") return { data: [] };
      return {};
    });

    await expect(harness.driver.hibernate(session)).resolves.toMatchObject({ state: "hibernated" });
    expect(harness.connections.close).toHaveBeenCalledWith(session.id);
    expect(harness.supervisor.stop).toHaveBeenCalledWith(runtime);
  });

  it.each([
    ["a failed authoritative read", async () => { throw new Error("read failed"); }],
    ["a mismatched thread", async () => ({
      thread: { id: "thread-other", status: { type: "idle" }, turns: [{ id: "turn-1", status: "completed" }] }
    })],
    ["an active thread", async () => ({
      thread: { id: "thread-1", status: { type: "active" }, turns: [{ id: "turn-1", status: "completed" }] }
    })],
    ["a missing turn", async () => ({
      thread: { id: "thread-1", status: { type: "idle" }, turns: [] }
    })],
    ["a nonterminal turn", async () => ({
      thread: { id: "thread-1", status: { type: "idle" }, turns: [{ id: "turn-1", status: "inProgress" }] }
    })]
  ])("keeps the active-turn blocker for %s", async (_name, readThread) => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.sendMessage(session, "work", "client-1");
    let inspectedThread: Awaited<ReturnType<typeof readThread>> | null = null;
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") {
        inspectedThread = await readThread();
        return inspectedThread;
      }
      if (method === "thread/turns/list") {
        return {
          data: inspectedThread && "thread" in inspectedThread && Array.isArray(inspectedThread.thread.turns)
            ? inspectedThread.thread.turns
            : [],
          nextCursor: null
        };
      }
      if (method === "thread/backgroundTerminals/list") return { data: [] };
      return {};
    });

    await expect(harness.driver.hibernationBlockers(session)).resolves.toEqual(["active_turn"]);
  });

  it("does not clear a newer turn that starts during stale-turn reconciliation", async () => {
    const harness = createHarness();
    const session = managedSession();
    await harness.driver.start(launchSpec());
    await harness.driver.sendMessage(session, "old work", "client-1");
    harness.rpc.request.mockImplementation(async (method: string) => {
      if (method === "thread/read") {
        await harness.handlers.notification?.({
          method: "turn/started",
          params: { threadId: "thread-1", turn: { id: "turn-new" } }
        });
        return {
          thread: {
            id: "thread-1",
            status: { type: "idle" }
          }
        };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed" }], nextCursor: null };
      }
      if (method === "thread/backgroundTerminals/list") return { data: [] };
      return {};
    });

    await expect(harness.driver.hibernationBlockers(session)).resolves.toEqual(["active_turn"]);
    harness.rpc.request.mockResolvedValue({});
    await harness.driver.interrupt(session, null);
    expect(harness.rpc.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-new"
    });
  });
});

function createHarness(
  requestStore?: AppServerRequestStore,
  eventSink?: AppServerDriverEventSink,
  processStore?: AppServerProcessStore,
  interactiveRequestReplayDelayMs?: number
): {
  driver: CodexAppServerDriver;
  supervisor: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  connections: Record<string, ReturnType<typeof vi.fn>>;
  connection: AppServerSessionConnection & { threadId: string };
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
    reconciliation: {
      initialize: { userAgent: "codex", codexHome: "/codex", platformFamily: "unix", platformOs: "linux" },
      established: { thread: { id: "thread-1" } },
      current: { thread: { id: "thread-1", status: { type: "idle" }, turns: [] } },
      replayedRequestIds: [],
      journalProcessOwnership: []
    },
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
        environment: {},
        mcpServers: spec.options.mcpServers ?? []
      } satisfies RuntimeStartSpec),
      requestStore,
      processStore,
      eventSink,
      interactiveRequestReplayDelayMs,
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

function processStoreHarness() {
  return {
    upsertAppServerCommandProcess: vi.fn(async () => undefined),
    removeAppServerCommandProcess: vi.fn(async () => true),
    removeAppServerTurnCommandProcesses: vi.fn(async () => 0),
    clearAppServerCommandProcesses: vi.fn(async () => 0),
    listAppServerCommandProcesses: vi.fn(async () => [])
  } satisfies AppServerProcessStore;
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
    runtime,
    capabilities: {} as ManagedSession["capabilities"],
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status: "idle",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    approvalMode: "ask",
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
