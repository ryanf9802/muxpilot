import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@muxpilot/core";
import { countSessionStatuses, sessionStatusesForSeverity, sessionStatusSeverity, shouldRefreshSessionsForEvent } from "./sessionStatus.js";

describe("sessionStatusSeverity", () => {
  it("maps every session status to the shared stoplight severity", () => {
    const expected: Record<SessionStatus, ReturnType<typeof sessionStatusSeverity>> = {
      idle: "green",
      generating: "yellow",
      executing: "yellow",
      working: "yellow",
      planning: "yellow",
      waiting: "green",
      approval: "red",
      question: "red",
      plan_ready: "red",
      blocked: "red",
      missing: "red",
      unknown: "yellow"
    };

    for (const [status, severity] of Object.entries(expected)) {
      expect(sessionStatusSeverity(status as SessionStatus)).toBe(severity);
    }
  });
});

describe("sessionStatusesForSeverity", () => {
  it("returns the statuses included in each stoplight bucket", () => {
    expect(sessionStatusesForSeverity("red")).toEqual(["approval", "question", "plan_ready", "blocked", "missing"]);
    expect(sessionStatusesForSeverity("yellow")).toEqual(["working", "generating", "executing", "planning", "unknown"]);
    expect(sessionStatusesForSeverity("green")).toEqual(["waiting", "idle"]);
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
        { status: "waiting" }
      ])
    ).toEqual({ red: 2, yellow: 2, green: 1 });
  });
});

describe("shouldRefreshSessionsForEvent", () => {
  it("refreshes for session data events", () => {
    expect(shouldRefreshSessionsForEvent({ type: "session.updated" })).toBe(true);
    expect(shouldRefreshSessionsForEvent({ type: "status.changed" })).toBe(true);
    expect(shouldRefreshSessionsForEvent({ type: "message.appended" })).toBe(true);
  });

  it("ignores unrelated events", () => {
    expect(shouldRefreshSessionsForEvent({ type: "connected" })).toBe(false);
    expect(shouldRefreshSessionsForEvent({ type: "notification.created" })).toBe(false);
  });
});
