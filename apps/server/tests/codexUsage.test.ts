import { describe, expect, it } from "vitest";
import {
  normalizeCodexUsage,
  selectCodexRateLimitSnapshot,
  type AccountReadResponse,
  type RateLimitsReadResponse
} from "../src/services/codexUsage.js";

describe("normalizeCodexUsage", () => {
  it("maps account identity and primary/secondary Codex limit windows", () => {
    const summary = normalizeCodexUsage(
      account({ email: "engineer@example.com", planType: "plus" }),
      rateLimits({
        rateLimits: snapshot("fallback", "fallback", 12, 34),
        rateLimitsByLimitId: {
          codex: snapshot("codex", "codex usage", 45.4, 72.2)
        }
      }),
      "2026-07-07T12:00:00.000Z"
    );

    expect(summary.available).toBe(true);
    expect(summary.account).toEqual({ kind: "chatgpt", email: "engineer@example.com", planType: "plus" });
    expect(summary.limits.fiveHour).toMatchObject({
      label: "5h limit",
      limitName: "codex usage",
      usedPercent: 45.4,
      remainingPercent: 54.6,
      windowDurationMins: 300,
      resetsAt: 1_784_000_000
    });
    expect(summary.limits.weekly).toMatchObject({
      label: "Weekly limit",
      usedPercent: 72.2,
      windowDurationMins: 10_080,
      resetsAt: 1_784_300_000
    });
    expect(summary.limits.weekly?.remainingPercent).toBeCloseTo(27.8);
  });

  it("falls back to the legacy single-bucket rate limit payload", () => {
    const response = rateLimits({
      rateLimits: snapshot("legacy", "legacy codex", 8, 9),
      rateLimitsByLimitId: null
    });

    expect(selectCodexRateLimitSnapshot(response)?.limitId).toBe("legacy");
  });

  it("clamps invalid percentages while preserving unavailable windows", () => {
    const summary = normalizeCodexUsage(
      { account: { type: "apiKey" }, requiresOpenaiAuth: false },
      rateLimits({
        rateLimits: {
          ...snapshot("codex", "codex usage", 120, 0),
          secondary: null
        },
        rateLimitsByLimitId: null
      }),
      "2026-07-07T12:00:00.000Z"
    );

    expect(summary.account).toEqual({ kind: "apiKey", email: null, planType: null });
    expect(summary.limits.fiveHour?.usedPercent).toBe(100);
    expect(summary.limits.fiveHour?.remainingPercent).toBe(0);
    expect(summary.limits.weekly).toBeNull();
  });
});

function account(input: { email: string | null; planType: string | null }): AccountReadResponse {
  return {
    account: { type: "chatgpt", email: input.email, planType: input.planType },
    requiresOpenaiAuth: false
  };
}

function rateLimits(input: RateLimitsReadResponse): RateLimitsReadResponse {
  return input;
}

function snapshot(limitId: string, limitName: string, primaryUsed: number, secondaryUsed: number) {
  return {
    limitId,
    limitName,
    primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt: 1_784_000_000 },
    secondary: { usedPercent: secondaryUsed, windowDurationMins: 10_080, resetsAt: 1_784_300_000 },
    planType: "plus"
  };
}
