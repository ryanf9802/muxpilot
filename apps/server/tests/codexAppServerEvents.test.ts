import { describe, expect, it } from "vitest";
import { projectAppServerEvent } from "../src/services/sessionDrivers/codexAppServerEvents.js";

const receivedAt = "2026-09-01T12:00:00.000Z";

describe("projectAppServerEvent", () => {
  it("keeps deltas transient and maps activity statuses", () => {
    expect(projectAppServerEvent({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" }
    }, receivedAt)).toMatchObject({
      identity: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      status: "generating",
      transient: true,
      message: null
    });
    expect(projectAppServerEvent({
      method: "item/plan/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "step" }
    }, receivedAt)?.status).toBe("planning");
    expect(projectAppServerEvent({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", delta: "output" }
    }, receivedAt)?.status).toBe("executing");
  });

  it("projects completed items with stable identity and authoritative content", () => {
    const event = {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_788_278_400_000,
        item: { id: "agent-1", type: "agentMessage", text: "Final answer" }
      }
    };
    const first = projectAppServerEvent(event, receivedAt);
    const replay = projectAppServerEvent(event, "2026-09-01T13:00:00.000Z");
    expect(first).toMatchObject({
      transient: false,
      message: {
        type: "assistant",
        role: "assistant",
        text: "Final answer",
        payload: {
          codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1" },
          appServerIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1" }
        }
      }
    });
    expect(replay?.message?.id).toBe(first?.message?.id);
    expect(first?.message?.timestamp).toBe("2026-09-01T16:00:00.000Z");
  });

  it("preserves client message correlation and normalizes completed plans", () => {
    const user = projectAppServerEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_788_278_400_000,
        item: {
          id: "user-1",
          clientId: "client-message-1",
          type: "userMessage",
          content: [{ type: "text", text: "Implement it" }]
        }
      }
    }, receivedAt);
    expect(user).toMatchObject({
      identity: { clientMessageId: "client-message-1" },
      message: { type: "user", role: "user", text: "Implement it" }
    });

    const plan = projectAppServerEvent({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 1_788_278_400_000,
        item: { id: "plan-1", type: "plan", text: "1. Build it" }
      }
    }, receivedAt);
    expect(plan?.message?.text).toBe("<proposed_plan>\n1. Build it\n</proposed_plan>");
    expect(plan?.status).toBe("plan_ready");
    expect(projectAppServerEvent({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [{ id: "plan-1", type: "plan", text: "1. Build it" }] }
      }
    }, receivedAt)?.status).toBe("plan_ready");
  });

  it("maps explicit wait flags and fails unknown states closed", () => {
    expect(projectAppServerEvent({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } }
    }, receivedAt)?.status).toBe("approval");
    expect(projectAppServerEvent({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnUserInput"] } }
    }, receivedAt)?.status).toBe("question");
    expect(projectAppServerEvent({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "futureStatus" } }
    }, receivedAt)?.status).toBe("unknown");
    expect(projectAppServerEvent({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "futureStatus" } }
    }, receivedAt)?.status).toBe("unknown");
    expect(projectAppServerEvent({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed" } }
    }, receivedAt)?.status).toBe("waiting");
  });
});
