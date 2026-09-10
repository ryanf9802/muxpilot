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
      "2026-09-01T12:05:00.000Z"
    );

    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: "planning" }));
  });
});

function projectionStore(order: string[], inputMode: "default" | "plan" = "default") {
  let status: SessionStatus = "generating";
  let state: AppServerReconciliationState | null = null;
  return {
    applyAppServerProjection: vi.fn(async (projection) => {
      order.push("apply");
      if (projection.status) status = projection.status;
      state = { ...reconciliationState(projection.status), ...projection, evidence: projection.evidence };
      return {
        message: projection.message ? { ...projection.message, sessionId: projection.sessionId, sequence: 1 } : null,
        messageInserted: Boolean(projection.message),
        messageChanged: Boolean(projection.message),
        statusChanged: Boolean(projection.status),
        state
      };
    }),
    getAppServerReconciliationState: vi.fn(async () => { order.push("read"); return state; }),
    latestPlanReadyMessage: vi.fn(async () => null),
    getSession: vi.fn(async () => {
      order.push("session");
      return {
        id: "session-1",
        status,
        inputMode,
        provider: { kind: "codex", threadId: "thread-1", rolloutPath: null }
      };
    }),
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
