import { describe, expect, it } from "vitest";
import type { ManagedSession, SessionStatus } from "./types.js";
import { agentSessionRoot, highestPrioritySession, operatorAttentionDescendants, operatorSessionStatusPresentation, sessionStatusPresentation } from "./sessionStatus.js";

describe("highestPrioritySession", () => {
  it("prefers attention over active work and active work over ready states", () => {
    const waiting = { id: "parent", status: "waiting" as const };
    const working = { id: "worker", status: "working" as const };
    const running = { id: "runner", status: "running" as const };
    const approval = { id: "approval", status: "approval" as const };

    expect(highestPrioritySession([waiting, working])).toBe(working);
    expect(highestPrioritySession([waiting, running])).toBe(running);
    expect(highestPrioritySession([waiting, working, running, approval])).toBe(approval);
  });

  it("treats unknown state as active rather than ready", () => {
    const waiting = { id: "parent", status: "waiting" as const };
    const unknown = { id: "child", status: "unknown" as const };

    expect(highestPrioritySession([waiting, unknown])).toBe(unknown);
  });
});

describe("agent tree status", () => {
  it("uses a live child's attention status and resolves its root", () => {
    const root = session("root", "waiting");
    const child = session("child", "approval", root.id);

    expect(agentSessionRoot(child, [root, child])).toBe(root);
    expect(sessionStatusPresentation(root, [root, child])).toEqual({
      status: "approval",
      sourceSessionId: child.id,
      inherited: true
    });
  });

  it("excludes completed children from the effective status", () => {
    const root = session("root", "waiting");
    const child = session("child", "blocked", root.id, "2026-08-26T00:00:00.000Z");

    expect(sessionStatusPresentation(root, [root, child]).status).toBe("waiting");
    expect(sessionStatusPresentation(child, [root, child]).status).toBe("completed");
  });

  it.each(["question", "input_failed", "blocked", "plan_ready"] as const)(
    "rolls a child's actionable %s status into the operator presentation",
    (status) => {
      const root = session("root", "waiting");
      const child = session("child", status, root.id);

      expect(sessionStatusPresentation(root, [root, child]).status).toBe(status);
      expect(operatorSessionStatusPresentation(root, [root, child])).toEqual({
        status,
        sourceSessionId: child.id,
        inherited: true
      });
      expect(operatorSessionStatusPresentation(child, [root, child]).status).toBe(status);
    }
  );

  it("keeps a child startup failure internal to the agent tree", () => {
    const root = session("root", "waiting");
    const child = session("child", "startup_failed", root.id);

    expect(operatorSessionStatusPresentation(root, [root, child])).toEqual({
      status: "waiting",
      sourceSessionId: root.id,
      inherited: false
    });
  });

  it.each(["working", "running", "approval"] as const)("rolls a child's %s status into the operator presentation", (status) => {
    const root = session("root", "waiting");
    const child = session("child", status, root.id);

    expect(operatorSessionStatusPresentation(root, [root, child])).toEqual({
      status,
      sourceSessionId: child.id,
      inherited: true
    });
  });

  it("returns actionable live descendants recursively and excludes completed history", () => {
    const root = session("root", "waiting");
    const child = session("child", "working", root.id);
    const grandchild = {
      ...session("grandchild", "question", root.id),
      agentOwnership: {
        ...session("grandchild", "question", root.id).agentOwnership!,
        parentSessionId: child.id
      }
    };
    const completed = session("completed", "blocked", root.id, "2026-08-26T00:00:00.000Z");

    expect(operatorAttentionDescendants(root, [root, child, grandchild, completed])).toEqual([grandchild]);
  });
});

function session(id: string, status: SessionStatus, rootSessionId?: string, completedAt: string | null = null): ManagedSession {
  return {
    id,
    status,
    archived: false,
    agentOwnership: rootSessionId ? {
      parentSessionId: rootSessionId,
      rootSessionId,
      origin: "created",
      createdAt: "2026-08-26T00:00:00.000Z",
      workTokenBaseline: 0,
      workTokenBudget: 1_000_000,
      completedAt
    } : null
  } as ManagedSession;
}
