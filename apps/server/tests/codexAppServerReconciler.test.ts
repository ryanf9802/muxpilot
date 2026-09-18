import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, SessionStatus } from "@muxpilot/core";
import type { AppServerReconciliationState } from "../src/db/database.js";
import {
  CodexAppServerReconciler,
  type AppServerProjectionStore
} from "../src/services/sessionDrivers/codexAppServerReconciler.js";

describe("CodexAppServerReconciler", () => {
  it("persists completed items before publishing transcript and status", async () => {
    const order: string[] = [];
    const store = projectionStore(order);
    const published: Array<{ type: string; payload: unknown }> = [];
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, {
      publish: (event) => { order.push(`publish:${event.type}`); published.push(event); }
    });

    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_788_278_400_000,
        item: { id: "agent-1", type: "agentMessage", text: "Done" }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(order).toEqual([
      "session",
      "read",
      "apply",
      "session",
      "publish:message.appended",
      "publish:status.changed",
      "publish:session.updated"
    ]);
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      status: "generating",
      message: expect.objectContaining({ text: "Done" })
    }));
    expect(published.map((event) => event.type)).toEqual(["message.appended", "status.changed", "session.updated"]);
  });

  it.each([
    ["turn start", "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } }],
    ["active thread", "thread/status/changed", { threadId: "thread-1", status: { type: "active", activeFlags: [] } }],
    ["command", "item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "command-1", type: "commandExecution" } }],
    ["tool call", "item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "tool-1", type: "mcpToolCall" } }],
    ["assistant message", "item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "Planning" } }]
  ])("keeps Plan-mode %s activity in planning status", async (_label, method, params) => {
    const store = projectionStore([], "plan");
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });

    await reconciler.handle("session-1", {
      method,
      params,
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "planning" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "status.changed",
      payload: { status: "planning" }
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "session.updated",
      payload: expect.objectContaining({ status: "planning" })
    }));
  });

  it("preserves attention and completion states in Plan mode", async () => {
    const store = projectionStore([], "plan");
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "item/tool/requestUserInput",
      params: {
        requestId: "question-1",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "tool-1",
          questions: [{ id: "choice", header: "Choice", question: "Choose", options: [] }]
        }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "question" }));

    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "plan-1", type: "plan", text: "Final plan" }
      },
      receivedAt: "2026-09-01T12:00:01.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenLastCalledWith(expect.objectContaining({ status: "plan_ready" }));
  });

  it("keeps deltas transient and restores plan-ready from the pending plan on idle", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });
    await reconciler.handle("session-1", {
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "step" },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(store.applyAppServerProjection).not.toHaveBeenCalled();

    store.latestPlanReadyMessage.mockResolvedValueOnce(planMessage());
    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T12:00:01.000Z"
    });
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "plan_ready" }));
  });

  it("preserves plan-ready through companion prose and summary-only completion", async () => {
    const store = projectionStore([], "plan");
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "plan-1", type: "plan", text: "Final plan" }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });
    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "agent-1", type: "agentMessage", text: "Plan prepared", phase: "final_answer" }
      },
      receivedAt: "2026-09-01T12:00:01.000Z"
    });
    store.latestPlanReadyMessage.mockResolvedValue(planMessage());
    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T12:00:02.000Z"
    });
    await reconciler.handle("session-1", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          itemsView: "summary",
          items: [{ id: "agent-1", type: "agentMessage", text: "Plan prepared" }]
        }
      },
      receivedAt: "2026-09-01T12:00:03.000Z"
    });

    expect(store.applyAppServerProjection.mock.calls.map(([projection]) => projection.status)).toEqual([
      "plan_ready",
      null,
      "plan_ready",
      "plan_ready"
    ]);
    expect((await store.getSession("session-1"))?.status).toBe("plan_ready");
  });

  it("restores an idle session with an unresolved persisted plan as plan-ready", async () => {
    const store = projectionStore([], "plan");
    store.latestPlanReadyMessage.mockResolvedValue(planMessage());
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      null,
      "2026-09-01T12:05:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "plan_ready" }));
  });

  it("keeps idle when there is no unresolved persisted plan", async () => {
    const store = projectionStore([], "plan");
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T12:05:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
  });

  it("allows a new turn to advance beyond a pending plan", async () => {
    const store = projectionStore([], "plan");
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });
    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "plan-1", type: "plan", text: "Final plan" }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    await reconciler.handle("session-1", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
      receivedAt: "2026-09-01T12:01:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenLastCalledWith(expect.objectContaining({ status: "planning" }));
  });

  it("rejects foreign thread projections as a durable defense in depth", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });

    await reconciler.handle("session-1", {
      method: "item/completed",
      params: {
        threadId: "thread-child",
        turnId: "turn-child",
        item: { id: "agent-child", type: "agentMessage", text: "child-only answer" }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps a foreign subagent approval actionable through the parent session", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "item/commandExecution/requestApproval",
      params: {
        requestId: "child-approval",
        params: {
          threadId: "thread-child",
          turnId: "turn-child",
          itemId: "command-child",
          command: ["git", "status"]
        }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-child",
      turnId: "turn-child",
      status: "approval",
      message: expect.objectContaining({ type: "approval_request" })
    }));
  });

  it("repairs foreign projections and restores status from the resumed root thread", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });
    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "active", activeFlags: [] },
      null,
      "2026-09-01T12:05:00.000Z"
    );
    expect(store.repairAppServerProjectionThread).toHaveBeenCalledWith("session-1", "thread-1");
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      threadId: "thread-1",
      status: "working"
    }));
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual(["status.changed", "session.updated"]);
    expect(publish.mock.calls.map(([event]) => event.timestamp)).toEqual([
      "2026-09-01T12:05:00.000Z",
      "2026-09-01T12:05:00.000Z"
    ]);
  });

  it("restores an active Plan-mode thread as planning", async () => {
    const store = projectionStore([], "plan");
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "active", activeFlags: [] },
      null,
      "2026-09-01T12:05:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "planning" }));
  });

  it("persists an authentication incident and reports it before generic turn completion handling", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const onAuthenticationFailure = vi.fn();
    const reconciler = new CodexAppServerReconciler(
      store as unknown as AppServerProjectionStore,
      { publish },
      onAuthenticationFailure
    );

    await reconciler.handle("session-1", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "Access token unauthorized after signing in to another account" } }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting",
      authenticationResumeRequired: true,
      authenticationError: expect.stringMatching(/Access token unauthorized.*Codex CLI/)
    }), "2026-09-01T12:00:00.000Z");
    expect(onAuthenticationFailure).toHaveBeenCalledWith("session-1", expect.stringContaining("Access token unauthorized"));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "session.updated",
      payload: expect.objectContaining({ authenticationResumeRequired: true })
    }));
  });

  it("classifies a provider-failed turn for actionable persistence", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" }
        }
      },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      turnFailure: {
        failureCode: "turn_failed",
        providerErrorCode: "serverOverloaded",
        failureReason: "Selected model is at capacity."
      }
    }));
  });

  it("classifies an interrupted latest turn during reconnect before restoring idle", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted", error: null },
      "2026-09-01T12:00:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: "turn/completed",
      status: "waiting",
      message: expect.objectContaining({
        type: "status",
        role: "system",
        text: expect.stringContaining("cause could not be confirmed"),
        payload: expect.objectContaining({
          interruption: expect.objectContaining({
            kind: "unexpected",
            threadId: "thread-1",
            turnId: "turn-1"
          })
        })
      }),
      turnFailure: expect.objectContaining({ failureCode: "turn_interrupted" })
    }));
    expect(store.applyAppServerProjection).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: "thread/status/changed"
    }));
  });

  it("does not relabel an operator interruption after its companion status event", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });
    await reconciler.recordIntentionalInterruption(
      "session-1",
      "thread-1",
      "turn-1",
      "operator",
      "2026-09-01T11:58:00.000Z"
    );
    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T11:59:00.000Z"
    });
    store.applyAppServerProjection.mockClear();

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenCalledOnce();
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/completed",
      status: "waiting",
      turnFailure: null
    }));
  });

  it("preserves a budget-blocked session when reconnect finds its interrupted turn", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });
    await reconciler.recordIntentionalInterruption(
      "session-1",
      "thread-1",
      "turn-1",
      "budget_guard",
      "2026-09-01T11:58:00.000Z"
    );
    store.applyAppServerProjection.mockClear();

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );

    expect(store.applyAppServerProjection).not.toHaveBeenCalled();
    expect(store.getAppServerTurnInterruptionKind).toHaveBeenCalledWith("session-1", "thread-1", "turn-1");
  });

  it("does not let a companion idle event clear an exhausted budget block", async () => {
    const store = projectionStore([]);
    store.getSession.mockResolvedValue({
      id: "session-1",
      status: "blocked",
      inputMode: "default",
      provider: { kind: "codex", threadId: "thread-1", rolloutPath: null },
      agentOwnership: {
        parentSessionId: "parent",
        rootSessionId: "parent",
        origin: "created",
        createdAt: "2026-09-01T11:00:00.000Z",
        workTokenBaseline: 0,
        workTokenBudget: 1000,
        completedAt: null,
        budgetExhaustedAt: "2026-09-01T11:59:00.000Z"
      }
    });
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      method: "thread/status/changed",
      status: "blocked"
    }));
  });

  it("does not let stale reconnect evidence overwrite a newer turn notification", async () => {
    const store = projectionStore([]);
    store.getAppServerReconciliationState.mockResolvedValue({
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: null,
      clientMessageId: null,
      method: "turn/started",
      status: "working",
      evidence: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
      observedAt: "2026-09-01T11:59:59.999Z"
    });
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );

    expect(store.applyAppServerProjection).not.toHaveBeenCalled();
  });

  it("abandons stale reconnect evidence when a newer event arrives during repair", async () => {
    const store = projectionStore([]);
    let releaseRepair = () => undefined;
    let markRepairStarted = () => undefined;
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve; });
    store.repairAppServerProjectionThread.mockImplementationOnce(async () => {
      markRepairStarted();
      await new Promise<void>((resolve) => { releaseRepair = resolve; });
      return { messagesRemoved: 0, processesRemoved: 0, reconciliationReset: false };
    });
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });
    const restoring = reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );
    await repairStarted;
    const newer = reconciler.handle("session-1", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2", status: "inProgress" } },
      receivedAt: "2026-09-01T12:00:00.001Z"
    });
    releaseRepair();

    await restoring;
    await newer;

    expect(store.applyAppServerProjection).toHaveBeenCalledOnce();
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/started",
      turnId: "turn-2"
    }));
  });

  it("does not let a foreign child turn suppress root interruption recovery", async () => {
    const store = projectionStore([]);
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish: vi.fn() });
    await reconciler.handle("session-1", {
      method: "turn/started",
      params: { threadId: "thread-child", turn: { id: "turn-child", status: "inProgress" } },
      receivedAt: "2026-09-01T11:59:59.000Z"
    });

    await reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/completed",
      turnId: "turn-1",
      turnFailure: expect.objectContaining({ failureCode: "turn_interrupted" })
    }));
  });

  it("does not let an account update during repair suppress root interruption recovery", async () => {
    const store = projectionStore([]);
    let releaseRepair = () => undefined;
    let markRepairStarted = () => undefined;
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve; });
    store.repairAppServerProjectionThread.mockImplementationOnce(async () => {
      markRepairStarted();
      await new Promise<void>((resolve) => { releaseRepair = resolve; });
      return { messagesRemoved: 0, processesRemoved: 0, reconciliationReset: false };
    });
    const onAccountUpdated = vi.fn();
    const reconciler = new CodexAppServerReconciler(
      store as unknown as AppServerProjectionStore,
      { publish: vi.fn() },
      undefined,
      onAccountUpdated
    );
    const restoring = reconciler.restore(
      "session-1",
      "thread-1",
      { type: "idle" },
      { id: "turn-1", status: "interrupted" },
      "2026-09-01T12:00:00.000Z"
    );
    await repairStarted;
    const accountUpdate = reconciler.handle("session-1", {
      method: "account/updated",
      params: { authMode: "chatgpt" },
      receivedAt: "2026-09-01T12:00:00.001Z"
    });
    releaseRepair();

    await restoring;
    await accountUpdate;

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/completed",
      turnId: "turn-1"
    }));
    expect(onAccountUpdated).toHaveBeenCalledOnce();
  });

  it("forwards account updates before thread-scoped projection filtering", async () => {
    const store = projectionStore([]);
    const onAccountUpdated = vi.fn();
    const reconciler = new CodexAppServerReconciler(
      store as unknown as AppServerProjectionStore,
      { publish: vi.fn() },
      undefined,
      onAccountUpdated
    );

    await reconciler.handle("session-1", {
      method: "account/updated",
      params: { authMode: "chatgpt" },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });

    expect(onAccountUpdated).toHaveBeenCalledOnce();
    expect(store.applyAppServerProjection).not.toHaveBeenCalled();
  });
});

function projectionStore(order: string[], inputMode: "default" | "plan" = "default") {
  let status: SessionStatus = "generating";
  let storedSession: Record<string, unknown> = {
    id: "session-1",
    status,
    inputMode,
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: null }
  };
  let state: AppServerReconciliationState | null = null;
  const intentionalInterruptions = new Map<string, "operator" | "budget_guard">();
  return {
    applyAppServerProjection: vi.fn(async (projection) => {
      order.push("apply");
      const interruption = projection.message?.payload?.interruption as Record<string, unknown> | undefined;
      if (interruption?.kind === "operator" || interruption?.kind === "budget_guard") {
        intentionalInterruptions.set(`${interruption.threadId}:${interruption.turnId}`, interruption.kind);
      }
      if (projection.status) status = projection.status;
      state = { ...reconciliationState(projection.status), ...projection, evidence: projection.evidence };
      return {
        message: projection.message ? { ...projection.message, sessionId: projection.sessionId, sequence: 1 } : null,
        messageInserted: Boolean(projection.message),
        messageChanged: Boolean(projection.message),
        failedSubmission: null,
        statusChanged: Boolean(projection.status),
        state
      };
    }),
    getAppServerReconciliationState: vi.fn(async () => { order.push("read"); return state; }),
    getAppServerTurnInterruptionKind: vi.fn(async (_sessionId, threadId, turnId) => (
      intentionalInterruptions.get(`${threadId}:${turnId}`) ?? null
    )),
    latestPlanReadyMessage: vi.fn(async () => null),
    getSession: vi.fn(async () => {
      order.push("session");
      return { ...storedSession, status };
    }),
    upsertSession: vi.fn(async (session) => { storedSession = { ...session }; status = session.status; }),
    repairAppServerProjectionThread: vi.fn(async () => ({
      messagesRemoved: 0,
      processesRemoved: 0,
      reconciliationReset: false
    }))
  };
}

function planMessage(): ChatMessage {
  return {
    id: "plan-message-1",
    sessionId: "session-1",
    sequence: 1,
    type: "assistant",
    role: "assistant",
    timestamp: "2026-09-01T12:00:00.000Z",
    text: "<proposed_plan>Final plan</proposed_plan>",
    payload: {}
  };
}

function reconciliationState(status: SessionStatus | null): AppServerReconciliationState {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    clientMessageId: null,
    method: "turn/completed",
    status,
    evidence: {},
    observedAt: "2026-09-01T12:00:00.000Z"
  };
}
