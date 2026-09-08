import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@muxpilot/core";
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

  it("keeps deltas transient and preserves plan-ready across the following idle notification", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });
    await reconciler.handle("session-1", {
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "step" },
      receivedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(store.applyAppServerProjection).not.toHaveBeenCalled();

    store.getAppServerReconciliationState.mockResolvedValueOnce(reconciliationState("plan_ready"));
    await reconciler.handle("session-1", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
      receivedAt: "2026-09-01T12:00:01.000Z"
    });
    expect(store.applyAppServerProjection).toHaveBeenCalledWith(expect.objectContaining({ status: null }));
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
});

function projectionStore(order: string[]) {
  return {
    applyAppServerProjection: vi.fn(async (projection) => {
      order.push("apply");
      return {
        message: projection.message ? { ...projection.message, sessionId: projection.sessionId, sequence: 1 } : null,
        messageInserted: Boolean(projection.message),
        messageChanged: Boolean(projection.message),
        statusChanged: Boolean(projection.status),
        state: { ...reconciliationState(projection.status), ...projection, evidence: projection.evidence }
      };
    }),
    getAppServerReconciliationState: vi.fn(async () => { order.push("read"); return null; }),
    getSession: vi.fn(async () => {
      order.push("session");
      return {
        id: "session-1",
        status: "generating",
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
