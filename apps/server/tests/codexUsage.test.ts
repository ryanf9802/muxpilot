import { describe, expect, it } from "vitest";
import {
  CodexUsageService,
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
