import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeControlClient,
  ClaudeModelsService,
  ClaudeTokenHistory,
  ClaudeUsageService
} from "../src/providers/claude/usage.js";
import { fakeQueryFactory } from "./helpers/claudeFakes.js";

const temporary: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "muxpilot-claude-usage-"));
  temporary.push(path);
  return path;
}

function fakeControl(query: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  const control = {
    run: vi.fn(async <T>(operation: (value: Query) => Promise<T>) => operation(query as unknown as Query)),
    invalidate: vi.fn(),
    stop: vi.fn()
  };
  return { control, asControl: control as unknown as ClaudeControlClient };
}

const PROBE_QUERY = {
  accountInfo: vi.fn(async () => ({ email: "dev@example.com", subscriptionType: "max", tokenSource: "oauth" })),
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: 40, resets_at: "2026-09-27T15:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
      seven_day_opus: null
    }
  }))
};

describe("ClaudeUsageService", () => {
  it("maps the SDK usage probe and caches it briefly", async () => {
    const { control, asControl } = fakeControl(PROBE_QUERY);
    const service = new ClaudeUsageService(asControl, new ClaudeTokenHistory(tempDir()));
    const summary = await service.summary();
    expect(summary).toEqual({
      provider: "claude",
      available: true,
      error: null,
      refreshedAt: "2026-09-27T12:00:00.000Z",
      accountStatus: "authenticated",
      account: { kind: "claudeAi", email: "dev@example.com", planType: "max" },
      limits: [
        { id: "five_hour", label: "5h limit", limitName: null, usedPercent: 40, remainingPercent: 60, windowDurationMins: 300, resetsAt: Date.parse("2026-09-27T15:00:00.000Z") / 1_000 },
        { id: "weekly", label: "Weekly limit", limitName: null, usedPercent: 10, remainingPercent: 90, windowDurationMins: 10_080, resetsAt: null }
      ],
      resetCredits: null
    });
    expect(PROBE_QUERY.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledWith({ skipBehaviors: true });
    const calls = control.run.mock.calls.length;
    await service.summary();
    expect(control.run.mock.calls.length).toBe(calls);
    await service.summary(true);
    expect(control.run.mock.calls.length).toBe(calls * 2);
  });

  it("merges newer live rate-limit observations over the probe", async () => {
    const { asControl } = fakeControl(PROBE_QUERY);
    const service = new ClaudeUsageService(asControl, new ClaudeTokenHistory(tempDir()));
    // An observation older than the probe is superseded by it.
    vi.setSystemTime(new Date("2026-09-27T11:59:00.000Z"));
    service.observeRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.05, resetsAt: 1 });
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    expect((await service.summary()).limits.find((limit) => limit.id === "five_hour")).toMatchObject({ usedPercent: 40 });

    vi.setSystemTime(new Date("2026-09-27T12:00:05.000Z"));
    // SDK rate_limit_event: one window per event, utilization as a fraction.
    service.observeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1_790_000_000 });
    service.observeRateLimit({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 55 });
    service.observeRateLimit({ status: "allowed", rateLimitType: "overage", utilization: 0.5 });
    service.observeRateLimit({ status: "allowed", rateLimitType: "seven_day" });
    const merged = await service.summary();
    expect(merged.limits).toEqual([
      expect.objectContaining({ id: "five_hour", usedPercent: 90, remainingPercent: 10, resetsAt: 1_790_000_000 }),
      expect.objectContaining({ id: "weekly", usedPercent: 10 }),
      { id: "weekly_opus", label: "Weekly Opus limit", limitName: null, usedPercent: 55, remainingPercent: 45, windowDurationMins: 10_080, resetsAt: null }
    ]);

    // A unifiedWindows map is also accepted.
    service.observeRateLimit({ unifiedWindows: { seven_day_sonnet: { utilization: 1.5 } } });
    expect((await service.summary()).limits.find((limit) => limit.id === "weekly_sonnet")).toMatchObject({ usedPercent: 1.5 });

    service.invalidateAuthentication();
    expect((await service.summary()).limits.map((limit) => limit.id)).toEqual(["five_hour", "weekly"]);
  });

  it("reports signed-out and unavailable probes", async () => {
    const signedOut = new ClaudeUsageService(
      fakeControl({ accountInfo: async () => { throw new Error("Not logged in · Please run /login"); } }).asControl,
      new ClaudeTokenHistory(tempDir())
    );
    await expect(signedOut.summary()).resolves.toMatchObject({ available: false, accountStatus: "signed_out", account: null, limits: [], error: "Not logged in · Please run /login" });

    const partial = new ClaudeUsageService(
      fakeControl({
        accountInfo: async () => ({ apiProvider: "bedrock" }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error("timeout"); }
      }).asControl,
      new ClaudeTokenHistory(tempDir())
    );
    await expect(partial.summary()).resolves.toMatchObject({ available: false, accountStatus: "authenticated", account: { kind: "bedrock" } });
  });

  it("invalidates and stops the shared control client", () => {
    const { control, asControl } = fakeControl(PROBE_QUERY);
    const service = new ClaudeUsageService(asControl, new ClaudeTokenHistory(tempDir()));
    service.invalidateAuthentication();
    service.stop();
    expect(control.invalidate).toHaveBeenCalledOnce();
    expect(control.stop).toHaveBeenCalledOnce();
  });
});

describe("ClaudeControlClient", () => {
  it("lazily opens one idle unpersisted query and restarts it after a failure", async () => {
    const queries = fakeQueryFactory();
    const workDir = join(tempDir(), "control");
    const client = new ClaudeControlClient({ claudePath: "/usr/bin/claude", configDir: "/cfg", environment: { A: "1" }, workDir, queryFactory: queries.factory });
    await expect(client.run(async () => "first")).resolves.toBe("first");
    await expect(client.run(async () => "second")).resolves.toBe("second");
    expect(queries.queries).toHaveLength(1);
    expect(queries.latest().options).toMatchObject({
      cwd: workDir,
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      env: { A: "1", CLAUDE_CONFIG_DIR: "/cfg" },
      persistSession: false,
      settingSources: [],
      tools: []
    });

    await expect(client.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(queries.queries[0]!.close).toHaveBeenCalled();
    await client.run(async () => undefined);
    expect(queries.queries).toHaveLength(2);
    client.stop();
    expect(queries.queries[1]!.close).toHaveBeenCalled();
  });
});

describe("ClaudeControlClient invalidation", () => {
  it("retries once on a fresh session when an invalidation closes the query mid-request", async () => {
    const queries = fakeQueryFactory();
    const client = new ClaudeControlClient({ claudePath: "/usr/bin/claude", configDir: "/cfg", environment: {}, workDir: join(tempDir(), "control"), queryFactory: queries.factory });
    let calls = 0;
    const result = client.run(async () => {
      calls += 1;
      if (calls === 1) {
        client.invalidate();
        throw new Error("Query closed before response received");
      }
      return "fresh";
    });
    await expect(result).resolves.toBe("fresh");
    expect(queries.queries).toHaveLength(2);
    client.stop();
  });
});

describe("ClaudeModelsService", () => {
  it("maps supported models and falls back to an empty catalog", async () => {
    const service = new ClaudeModelsService(fakeControl({
      supportedModels: async () => [
        { value: "default", displayName: "Default", description: "Recommended", supportedEffortLevels: ["low", "high"], supportsFastMode: true },
        { value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false, supportedEffortLevels: ["low"] }
      ]
    }).asControl);
    const catalog = await service.catalog();
    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "default", isDefault: true, defaultReasoningEffort: "high", supportsFastMode: true, supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fastest responses with minimal thinking" },
        { reasoningEffort: "high", description: "Deep reasoning" }
      ] }),
      expect.objectContaining({ id: "haiku", isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: null, supportsFastMode: false })
    ]);
    expect(catalog.defaults).toEqual({ default: { model: "default", reasoningEffort: "high" }, plan: { model: "default", reasoningEffort: "high" } });

    const failing = new ClaudeModelsService(fakeControl({ supportedModels: async () => { throw new Error("down"); } }).asControl);
    await expect(failing.catalog()).resolves.toMatchObject({ provider: "claude", models: [] });
  });
});

describe("ClaudeTokenHistory", () => {
  function usageLine(id: string, timestamp: string, usage: Record<string, number>, type = "assistant"): string {
    return `${JSON.stringify({ type, timestamp, message: { id, usage } })}\n`;
  }

  it("aggregates daily tokens across projects incrementally and deduplicates API messages", async () => {
    const projects = tempDir();
    mkdirSync(join(projects, "-repo"));
    mkdirSync(join(projects, "-other"));
    const first = join(projects, "-repo", "a.jsonl");
    writeFileSync(first, [
      usageLine("m1", "2026-09-27T01:00:00.000Z", { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 20 }),
      // A second content block of the same API message repeats its usage.
      usageLine("m1", "2026-09-27T01:00:01.000Z", { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 20 }),
      usageLine("m2", "2026-09-26T01:00:00.000Z", { input_tokens: 100, output_tokens: 0 }),
      usageLine("u1", "2026-09-26T01:00:00.000Z", { input_tokens: 999 }, "user"),
      "not json with \"usage\"\n"
    ].join(""));
    writeFileSync(join(projects, "-other", "b.jsonl"), usageLine("m3", "2026-09-24T01:00:00.000Z", { input_tokens: 7 }));
    writeFileSync(join(projects, "-other", "notes.txt"), usageLine("m9", "2026-09-27T01:00:00.000Z", { input_tokens: 1_000_000 }));

    const history = new ClaudeTokenHistory(projects);
    const week = await history.tokenUsage(7);
    expect(week).toMatchObject({
      provider: "claude",
      available: true,
      days: 7,
      summary: { lifetimeTokens: 35 + 100 + 7, peakDailyTokens: 100, currentStreakDays: 2, longestStreakDays: 2, longestRunningTurnSec: null }
    });
    expect(week.points).toEqual([
      { date: "2026-09-21", tokens: 0 },
      { date: "2026-09-22", tokens: 0 },
      { date: "2026-09-23", tokens: 0 },
      { date: "2026-09-24", tokens: 7 },
      { date: "2026-09-25", tokens: 0 },
      { date: "2026-09-26", tokens: 100 },
      { date: "2026-09-27", tokens: 35 }
    ]);
    expect((await history.tokenUsage(30)).points).toHaveLength(30);

    // Appended records (including a repeat of an already-counted message) are scanned incrementally on refresh.
    appendFileSync(first, usageLine("m1", "2026-09-27T02:00:00.000Z", { input_tokens: 10, output_tokens: 20 })
      + usageLine("m4", "2026-09-27T02:00:00.000Z", { output_tokens: 65 })
      + "{\"type\":\"assistant\",\"usage\"");
    const refreshed = await history.tokenUsage(7, true);
    expect(refreshed.points?.at(-1)).toEqual({ date: "2026-09-27", tokens: 100 });

    // A truncated (rewritten) transcript is rescanned from the start.
    writeFileSync(first, usageLine("m5", "2026-09-27T03:00:00.000Z", { input_tokens: 1 }));
    const rewritten = await history.tokenUsage(7, true);
    expect(rewritten.points?.at(-1)).toEqual({ date: "2026-09-27", tokens: 1 });
    expect(rewritten.summary?.lifetimeTokens).toBe(1 + 7);

    rmSync(join(projects, "-other"), { recursive: true });
    expect((await history.tokenUsage(7, true)).summary?.lifetimeTokens).toBe(1);
  });

  it("reports empty history when the projects directory is missing", async () => {
    const history = new ClaudeTokenHistory(join(tempDir(), "missing"));
    await expect(history.tokenUsage(7)).resolves.toMatchObject({ available: true, summary: { lifetimeTokens: 0, peakDailyTokens: 0, currentStreakDays: 0 } });
  });
});
