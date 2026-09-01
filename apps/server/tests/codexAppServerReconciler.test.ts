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

    expect(order).toEqual(["read", "apply", "session", "publish:message.appended", "publish:status.changed", "publish:session.updated"]);
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

  it("restores only a checkpoint owned by the resumed thread", async () => {
    const store = projectionStore([]);
    const publish = vi.fn();
    const reconciler = new CodexAppServerReconciler(store as unknown as AppServerProjectionStore, { publish });
    store.getAppServerReconciliationState.mockResolvedValue(reconciliationState("working"));
    await reconciler.restore("session-1", "thread-1", "2026-09-01T12:05:00.000Z");
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual(["status.changed", "session.updated"]);
    expect(publish.mock.calls.map(([event]) => event.timestamp)).toEqual([
      "2026-09-01T12:05:00.000Z",
      "2026-09-01T12:05:00.000Z"
    ]);
    await expect(reconciler.restore(
      "session-1",
      "different-thread",
      "2026-09-01T12:06:00.000Z"
    )).rejects.toThrow("thread mismatch");
  });
});

function projectionStore(order: string[]) {
  return {
    applyAppServerProjection: vi.fn(async (projection) => {
      order.push("apply");
      return {
        message: projection.message ? { ...projection.message, sessionId: projection.sessionId, sequence: 1 } : null,
        messageInserted: Boolean(projection.message),
        statusChanged: Boolean(projection.status),
        state: { ...reconciliationState(projection.status), ...projection, evidence: projection.evidence }
      };
    }),
    getAppServerReconciliationState: vi.fn(async () => { order.push("read"); return null; }),
    getSession: vi.fn(async () => { order.push("session"); return { id: "session-1", status: "generating" }; })
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
