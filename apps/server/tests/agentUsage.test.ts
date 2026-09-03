import { describe, expect, it } from "vitest";
import type { AgentSessionOwnership, SessionContextUsage } from "@muxpilot/core";
import { accountAgentWorkTokens, agentWorkTokensUsed } from "../src/services/agentUsage.js";

describe("agent work-token accounting", () => {
  it("bootstraps legacy ownership across a lifetime counter reset", () => {
    const ownership = testOwnership();
    expect(agentWorkTokensUsed(ownership, usage(1_200, "2026-08-25T00:01:00.000Z"))).toBe(200);
    expect(agentWorkTokensUsed(ownership, usage(100, "2026-08-25T00:01:00.000Z"))).toBe(100);
  });

  it("does not initialize a legacy tracker from a pre-ownership sample", () => {
    const ownership = testOwnership();
    expect(accountAgentWorkTokens(ownership, usage(900, "2026-08-24T23:59:00.000Z"))).toBe(ownership);
  });

  it("accumulates work across later lifetime counter resets without double counting", () => {
    let ownership = accountAgentWorkTokens(testOwnership(), usage(1_200, "2026-08-25T00:01:00.000Z"));
    ownership = accountAgentWorkTokens(ownership, usage(1_300, "2026-08-25T00:02:00.000Z"));
    ownership = accountAgentWorkTokens(ownership, usage(50, "2026-08-25T00:03:00.000Z"));

    expect(agentWorkTokensUsed(ownership, usage(50, "2026-08-25T00:03:00.000Z"))).toBe(350);
    expect(accountAgentWorkTokens(ownership, usage(999, "2026-08-25T00:02:30.000Z"))).toBe(ownership);
  });
});

function testOwnership(): AgentSessionOwnership {
  return {
    parentSessionId: "parent",
    rootSessionId: "parent",
    origin: "claimed",
    createdAt: "2026-08-25T00:00:00.000Z",
    workTokenBaseline: 1_000,
    workTokenBudget: 1_000_000,
    completedAt: null,
    budgetExhaustedAt: null
  };
}

function usage(lifetimeWorkTokens: number, sampledAt: string): SessionContextUsage {
  return {
    activeTokens: 10,
    contextWindowTokens: 100,
    contextPercent: 10,
    lifetimeTotalTokens: lifetimeWorkTokens,
    lifetimeCachedInputTokens: 0,
    lifetimeWorkTokens,
    sampledAt
  };
}
