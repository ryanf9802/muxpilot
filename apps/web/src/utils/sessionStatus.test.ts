import { describe, expect, it } from "vitest";
import type { ManagedSession, SessionStatus } from "@muxpilot/core";
import { countSessionStatuses, SESSION_STATUS_RECONCILE_INTERVAL_MS, sessionStatusPresentation, sessionStatusesForSeverity, sessionStatusSeverity } from "./sessionStatus.js";

it("uses a 30-second visible-session fallback cadence", () => {
  expect(SESSION_STATUS_RECONCILE_INTERVAL_MS).toBe(30_000);
});

describe("sessionStatusSeverity", () => {
  it("maps every session status to the shared stoplight severity", () => {
    const expected: Record<SessionStatus, ReturnType<typeof sessionStatusSeverity>> = {
      idle: "green",
      generating: "yellow",
      executing: "yellow",
      working: "yellow",
      planning: "yellow",
      queued: "yellow",
      waiting: "green",
      approval: "red",
      question: "red",
      plan_ready: "red",
      blocked: "red",
      input_failed: "red",
      startup_failed: "red",
      missing: "red",
      unknown: "yellow"
    };

    for (const [status, severity] of Object.entries(expected)) {
      expect(sessionStatusSeverity(status as SessionStatus)).toBe(severity);
    }
    expect(sessionStatusSeverity("completed")).toBe("green");
  });
});

describe("sessionStatusesForSeverity", () => {
  it("returns the statuses included in each stoplight bucket", () => {
    expect(sessionStatusesForSeverity("red")).toEqual(["approval", "question", "plan_ready", "blocked", "input_failed", "startup_failed", "missing"]);
    expect(sessionStatusesForSeverity("yellow")).toEqual(["working", "generating", "executing", "planning", "queued", "unknown"]);
    expect(sessionStatusesForSeverity("green")).toEqual(["waiting", "idle", "completed"]);
  });
});

describe("countSessionStatuses", () => {
  it("counts sessions by shared stoplight severity", () => {
    expect(
      countSessionStatuses([
        { status: "approval" },
        { status: "question" },
        { status: "working" },
        { status: "unknown" },
        { status: "missing", initializing: true },
        { status: "waiting" }
      ] as ManagedSession[])
    ).toEqual({ red: 2, yellow: 2, green: 1 });
  });

  it("counts a nested tree once using its representative status", () => {
    const root = session("root", "waiting");
    const child = {
      ...session("child", "working"),
      agentOwnership: ownership(root.id)
    };

    expect(countSessionStatuses([root, child])).toEqual({ red: 0, yellow: 1, green: 0 });
    expect(sessionStatusPresentation(root, [root, child])).toEqual({
      status: "working",
      sourceSessionId: child.id,
      inherited: true
    });
  });

  it("renders completed children without contributing stale blocked state to their parent", () => {
    const root = session("root", "waiting");
    const child = {
      ...session("child", "blocked"),
      agentOwnership: { ...ownership(root.id), completedAt: "2026-08-25T01:00:00.000Z", contextPausedAt: "2026-08-25T00:59:00.000Z" }
    };

    expect(sessionStatusPresentation(root, [root, child]).status).toBe("waiting");
    expect(sessionStatusPresentation(child, [root, child]).status).toBe("completed");
  });

  it("keeps a live blocked child visible without making the root count red", () => {
    const root = session("root", "waiting");
    const child = {
      ...session("child", "blocked"),
      agentOwnership: ownership(root.id)
    };

    expect(countSessionStatuses([root, child])).toEqual({ red: 0, yellow: 0, green: 1 });
    expect(sessionStatusPresentation(root, [root, child]).status).toBe("waiting");
    expect(sessionStatusPresentation(child, [root, child]).status).toBe("blocked");
  });
});

function session(id: string, status: SessionStatus): ManagedSession {
  return {
    id,
    tmux: { sessionId: "$1", sessionName: "muxpilot", windowId: `@${id}`, windowIndex: 1, windowName: id, paneId: `%${id}`, paneIndex: 0, paneActive: false, cwd: "/repo", currentCommand: "node", title: id, pid: 1, size: "80x24" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: `codex-${id}`,
    codexJsonlPath: null,
    discoveryConfidence: "high",
    status,
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}

function ownership(parentSessionId: string) {
  return {
    parentSessionId,
    rootSessionId: parentSessionId,
    origin: "created" as const,
    createdAt: "2026-08-25T00:00:00.000Z",
    workTokenBaseline: 0,
    workTokenBudget: 1_000_000,
    completedAt: null
  };
}
