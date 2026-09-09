import { describe, expect, it } from "vitest";
import {
  CodexUsageService,
  normalizeCodexModelDefaults,
  normalizeCodexModels,
  normalizeCodexUsage,
  selectCodexRateLimitSnapshot,
  type AccountReadResponse,
  type RateLimitsReadResponse
} from "../src/services/codexUsage.js";

describe("CodexUsageService", () => {
  it("single-flights concurrent reads and caches successful summaries", async () => {
    let now = 1_000;
    let requests = 0;
    const client = {
      request: async <T>(method: string): Promise<T> => {
        requests += 1;
        if (method === "account/read") return account({ email: "engineer@example.com", planType: "plus" }) as T;
        return rateLimits({ rateLimits: snapshot("codex", "codex usage", 10, 20), rateLimitsByLimitId: null }) as T;
      },
      stop: () => undefined
    };
    const service = new CodexUsageService({ codexHome: "/tmp/codex", client, now: () => now });

    const [first, second] = await Promise.all([service.summary(), service.summary()]);
    const cached = await service.summary();

    expect(first).toBe(second);
    expect(cached).toBe(first);
    expect(requests).toBe(2);

    now += 60_001;
    await service.summary();
    expect(requests).toBe(4);
  });

  it("briefly caches unavailable results before retrying", async () => {
    let now = 1_000;
    let requests = 0;
    const service = new CodexUsageService({
      codexHome: "/tmp/codex",
      now: () => now,
      client: {
        request: async () => {
          requests += 1;
          throw new Error("offline");
        },
        stop: () => undefined
      }
    });

    expect((await service.summary()).available).toBe(false);
    expect((await service.summary()).available).toBe(false);
    expect(requests).toBe(1);

    now += 10_001;
    await service.summary();
    expect(requests).toBe(2);
  });

  it("reads and caches account token activity independently", async () => {
    let requests = 0;
    const service = new CodexUsageService({
      codexHome: "/tmp/codex",
      client: {
        request: async <T>(method: string): Promise<T> => {
          expect(method).toBe("account/usage/read");
          requests += 1;
          return {
            summary: { lifetimeTokens: 100, peakDailyTokens: 30, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 4 },
            dailyUsageBuckets: Array.from({ length: 10 }, (_, index) => ({ startDate: `2026-07-${String(index + 1).padStart(2, "0")}`, tokens: index }))
          } as T;
        },
        stop: () => undefined
      }
    });

    const sevenDays = await service.tokenUsage(7);
    const thirtyDays = await service.tokenUsage(30);

    expect(requests).toBe(1);
    expect(sevenDays.points).toHaveLength(7);
    expect(sevenDays.points?.[0]?.date).toBe("2026-07-04");
    expect(thirtyDays.points).toHaveLength(10);
  });

  it("consumes a selected reset token and refreshes the account snapshot", async () => {
    const requests: Array<{ method: string; params?: unknown }> = [];
    const service = new CodexUsageService({
      codexHome: "/tmp/codex",
      client: {
        request: async <T>(method: string, params?: unknown): Promise<T> => {
          requests.push({ method, params });
          if (method === "account/rateLimitResetCredit/consume") return { outcome: "reset" } as T;
          if (method === "account/read") return account({ email: "engineer@example.com", planType: "plus" }) as T;
          return rateLimits({
            rateLimits: snapshot("codex", "codex usage", 0, 20),
            rateLimitsByLimitId: null,
            rateLimitResetCredits: { availableCount: 0, credits: [] }
          }) as T;
        },
        stop: () => undefined
      }
    });

    const result = await service.consumeResetCredit("05f9c8bb-08b1-43ad-b396-31f2b685ba9c", "reset-1");

    expect(result.outcome).toBe("reset");
    expect(result.summary.limits.fiveHour?.usedPercent).toBe(0);
    expect(result.summary.resetCredits).toEqual({ availableCount: 0, credits: [] });
    expect(requests[0]).toEqual({
      method: "account/rateLimitResetCredit/consume",
      params: { idempotencyKey: "05f9c8bb-08b1-43ad-b396-31f2b685ba9c", creditId: "reset-1" }
    });
  });

  it("does not let an older summary read replace a forced refresh", async () => {
    let resolveOld!: (value: RateLimitsReadResponse) => void;
    const oldRateLimits = new Promise<RateLimitsReadResponse>((resolve) => {
      resolveOld = resolve;
    });
    let rateLimitReads = 0;
    const service = new CodexUsageService({
      codexHome: "/tmp/codex",
      client: {
        request: async <T>(method: string): Promise<T> => {
          if (method === "account/read") return account({ email: null, planType: "plus" }) as T;
          rateLimitReads += 1;
          if (rateLimitReads === 1) return oldRateLimits as T;
          return rateLimits({ rateLimits: snapshot("codex", "codex usage", 5, 10), rateLimitsByLimitId: null }) as T;
        },
        stop: () => undefined
      }
    });

    const older = service.summary();
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = await service.summary(true);
    resolveOld(rateLimits({ rateLimits: snapshot("codex", "codex usage", 90, 95), rateLimitsByLimitId: null }));
    await older;

    expect(refreshed.limits.fiveHour?.usedPercent).toBe(5);
    expect((await service.summary()).limits.fiveHour?.usedPercent).toBe(5);
  });
});

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
    expect(summary.resetCredits).toBeNull();
  });

  it("normalizes reset-token details without deriving the authoritative count", () => {
    const summary = normalizeCodexUsage(
      account({ email: null, planType: "plus" }),
      rateLimits({
        rateLimits: snapshot("codex", "codex usage", 1, 2),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: {
          availableCount: 3,
          credits: [{ id: "reset-1", resetType: "codexRateLimits", status: "available", grantedAt: 100, expiresAt: 200, title: null, description: null }]
        }
      }),
      "2026-07-07T12:00:00.000Z"
    );

    expect(summary.resetCredits?.availableCount).toBe(3);
    expect(summary.resetCredits?.credits).toHaveLength(1);
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

describe("normalizeCodexModels", () => {
  it("maps visible app-server model records to UI model options", () => {
    expect(
      normalizeCodexModels({
        data: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Frontier coding model",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deeper" }
            ],
            defaultReasoningEffort: "medium",
            serviceTiers: [{ id: "fast", name: "Fast", description: "Priority processing" }]
          },
          {
            id: "hidden",
            model: "hidden",
            displayName: "Hidden",
            hidden: true
          }
        ],
        nextCursor: null
      })
    ).toEqual([
      {
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier coding model",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper" }
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [{ id: "fast", name: "Fast", description: "Priority processing" }]
      }
    ]);
  });

  it("resolves Codex Normal and Plan presets against the default model", () => {
    const models = normalizeCodexModels({
      data: [{
        model: "gpt-default",
        isDefault: true,
        defaultReasoningEffort: "medium"
      }]
    });

    expect(normalizeCodexModelDefaults(models, {
      data: [
        { mode: "default", reasoning_effort: "high" },
        { mode: "plan", reasoning_effort: "xhigh" }
      ]
    })).toEqual({
      default: { model: "gpt-default", reasoningEffort: "high" },
      plan: { model: "gpt-default", reasoningEffort: "xhigh" }
    });
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
