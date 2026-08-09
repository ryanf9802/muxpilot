import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@muxpilot/core";
import { countSessionStatuses, SESSION_STATUS_RECONCILE_INTERVAL_MS, sessionStatusesForSeverity, sessionStatusSeverity } from "./sessionStatus.js";

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
      waiting: "green",
      approval: "red",
      question: "red",
      plan_ready: "red",
      blocked: "red",
      startup_failed: "red",
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
    expect(sessionStatusesForSeverity("red")).toEqual(["approval", "question", "plan_ready", "blocked", "startup_failed", "missing"]);
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
        { status: "missing", initializing: true },
        { status: "waiting" }
      ])
    ).toEqual({ red: 2, yellow: 2, green: 1 });
  });
});
