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

  it("projects exact command, file, and permission approval requests", () => {
    const command = projectAppServerEvent({
      method: "item/commandExecution/requestApproval",
      params: {
        requestId: 7,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          command: ["git", "status"],
          cwd: "/repo",
          reason: "Needs permission",
          proposedExecpolicyAmendment: ["git", "status"],
          startedAtMs: 1_788_278_400_000
        }
      }
    }, receivedAt);
    expect(command).toMatchObject({
      status: "approval",
      transient: false,
      message: {
        type: "approval_request",
        timestamp: "2026-09-01T16:00:00.000Z",
        payload: {
          approval: {
            id: "7",
            requestId: 7,
            kind: "command",
            command: "git status",
            cwd: "/repo",
            prefixRule: ["git", "status"]
          }
        }
      }
    });
    expect(command?.message?.payload.approval).toMatchObject({
      options: expect.arrayContaining([expect.objectContaining({ decision: "approve_for_prefix" })])
    });

    expect(projectAppServerEvent({
      method: "item/fileChange/requestApproval",
      params: { requestId: "file-1", params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", cwd: "/repo" } }
    }, receivedAt)).toMatchObject({ message: { payload: { approval: { requestId: "file-1", kind: "patch" } } } });

    expect(projectAppServerEvent({
      method: "item/permissions/requestApproval",
      params: {
        requestId: "permissions-1",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "permissions-1", permissions: { network: { enabled: true } } }
      }
    }, receivedAt)).toMatchObject({ message: { payload: { approval: { requestId: "permissions-1", kind: "permissions" } } } });
  });

  it("projects structured questions and preserves typed request identity across replay", () => {
    const event = {
      method: "item/tool/requestUserInput",
      params: {
        requestId: 9,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          autoResolutionMs: 30_000,
          questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Continue." }] }]
        }
      }
    };
    const first = projectAppServerEvent(event, receivedAt);
    const replay = projectAppServerEvent(event, "2026-09-01T13:00:00.000Z");
    expect(first).toMatchObject({
      status: "question",
      message: {
        type: "question_request",
        payload: { question: { id: "9", requestId: 9, autoResolutionMs: 30_000 } }
      }
    });
    expect(replay?.message?.id).toBe(first?.message?.id);
    expect(projectAppServerEvent({ ...event, params: { ...event.params, requestId: "9" } }, receivedAt)?.message?.id)
      .not.toBe(first?.message?.id);
  });
});
