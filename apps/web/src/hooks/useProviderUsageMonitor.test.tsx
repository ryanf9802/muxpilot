// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderKind, ProviderUsageSummary } from "@muxpilot/core";

const apiMocks = vi.hoisted(() => ({
  providerUsageSummary: vi.fn(),
  consumeResetCredit: vi.fn()
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));

vi.mock("../api/client.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../api/client.js")>(), api: apiMocks }));
vi.mock("react-toastify", () => ({ toast: toastMocks }));

import { PROVIDER_USAGE_POLL_INTERVAL_MS, useProviderUsageMonitor, type ProviderUsageMonitor } from "./useProviderUsageMonitor.js";
import { observedReset, pendingResetStorageKey, useResetCredits, type ResetCreditsMonitor } from "./useResetCredits.js";
import { ApiError } from "../api/client.js";

type CodexUsageMonitor = ProviderUsageMonitor & ResetCreditsMonitor;
const PENDING_RESET_KEY = pendingResetStorageKey("codex");
const CODEX_USAGE_POLL_INTERVAL_MS = PROVIDER_USAGE_POLL_INTERVAL_MS;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("usage reset observation", () => {
  it("recognizes full capacity or a usage decrease without accepting an unchanged full limit", () => {
    expect(observedReset(summary(60), summary(0))).toBe(true);
    expect(observedReset(summary(60), summary(25))).toBe(true);
    expect(observedReset(summary(0), summary(0))).toBe(false);
  });

  it("matches limits by id rather than position", () => {
    const before = { ...summary(60), limits: [{ ...summary(60).limits[0]!, id: "weekly_opus" }, summary(10).limits[0]!] };
    const after = { ...summary(60), limits: [summary(10).limits[0]!, { ...summary(20).limits[0]!, id: "weekly_opus" }] };
    expect(observedReset(before, after)).toBe(true);
    expect(observedReset(before, { ...after, limits: [summary(10).limits[0]!, { ...summary(60).limits[0]!, id: "weekly_opus" }] })).toBe(false);
  });

  it("keeps the pre-existing Codex pending-reset storage key", () => {
    expect(pendingResetStorageKey("codex")).toBe("muxpilot.codex-usage.pending-reset.v1");
    expect(pendingResetStorageKey("claude")).toBe("muxpilot.claude-usage.pending-reset.v1");
  });
});

describe("useProviderUsageMonitor with reset credits", () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let current: CodexUsageMonitor | null;

  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorage();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    apiMocks.providerUsageSummary.mockReset().mockResolvedValue(summary(10));
    apiMocks.consumeResetCredit.mockReset();
    toastMocks.success.mockReset();
    toastMocks.warning.mockReset();
    toastMocks.error.mockReset();
    current = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("polls every ten seconds, pauses while hidden, and refreshes on return", async () => {
    await renderMonitor((monitor) => { current = monitor; });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failed refresh and resumes the normal cadence after success", async () => {
    apiMocks.providerUsageSummary.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(summary(10));
    await renderMonitor((monitor) => { current = monitor; });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledTimes(3);
  });

  it("keeps verified limits during a failed refresh, recovers, and clears them on sign-out", async () => {
    apiMocks.providerUsageSummary.mockResolvedValueOnce(summary(40))
      .mockResolvedValueOnce({ ...summary(40), available: false, error: "limits delayed", limits: [] })
      .mockResolvedValueOnce(summary(35))
      .mockResolvedValueOnce({ ...summary(35), available: false, accountStatus: "signed_out", account: null, limits: [], resetCredits: null });
    await renderMonitor((monitor) => { current = monitor; });
    const first = current!.summary;
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(current!.summary).toBe(first);
    expect(current!.refreshError).toBe("limits delayed");
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(current!.summary?.limits[0]?.usedPercent).toBe(35);
    expect(current!.refreshError).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(current!.summary).toMatchObject({ accountStatus: "signed_out", account: null, limits: [] });
  });

  it("shows an unknown account after the first transport failure", async () => {
    apiMocks.providerUsageSummary.mockResolvedValueOnce({ ...summary(40), available: false, accountStatus: "unknown", account: null, error: "offline", limits: [] });
    await renderMonitor((monitor) => { current = monitor; });
    expect(current!.summary).toMatchObject({ accountStatus: "unknown", account: null });
    expect(current!.refreshError).toBe("offline");
  });

  it("uses one token attempt and confirms success when refreshed capacity is full", async () => {
    apiMocks.providerUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(0) });
    await renderMonitor((monitor) => { current = monitor; });
    const attempt = { idempotencyKey: "attempt-1", creditId: "credit-1", recoveryAttempted: false };

    await act(async () => { await current!.consumeReset(attempt, "using"); });

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(apiMocks.consumeResetCredit).toHaveBeenCalledWith("codex", { idempotencyKey: "attempt-1", creditId: "credit-1" });
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(toastMocks.success).toHaveBeenCalledWith("Usage reset confirmed. 100% capacity is available.");
  });

  it("confirms a reset when running work consumes some of the restored capacity", async () => {
    apiMocks.providerUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(55) });
    await renderMonitor((monitor) => { current = monitor; });

    await act(async () => {
      await current!.consumeReset({ idempotencyKey: "attempt-running", creditId: "credit-1", recoveryAttempted: false }, "using");
    });

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith("Usage reset confirmed. 45% capacity is currently available.");
  });

  it("still reports successful redemption when refreshed limits remain delayed", async () => {
    apiMocks.providerUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(60) });
    await renderMonitor((monitor) => { current = monitor; });
    let redemption!: Promise<void>;

    act(() => {
      redemption = current!.consumeReset({ idempotencyKey: "attempt-delayed", creditId: "credit-1", recoveryAttempted: false }, "using");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await redemption;
    });

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith("Reset token redeemed. Updated usage has not yet been confirmed.");
    expect(current!.resetObservation).toBe("delayed");
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(current!.resetOutcome).toBeNull();
  });

  it("keeps the last valid limits while a redeemed token's summary is temporarily unavailable", async () => {
    apiMocks.providerUsageSummary.mockResolvedValueOnce(summary(60)).mockResolvedValue(summary(0));
    apiMocks.consumeResetCredit.mockResolvedValue({
      outcome: "reset",
      summary: { ...summary(60), available: false, error: "temporarily unavailable", limits: [] }
    });
    await renderMonitor((monitor) => { current = monitor; });
    let redemption!: Promise<void>;

    act(() => {
      redemption = current!.consumeReset({ idempotencyKey: "attempt-unavailable", creditId: "credit-1", recoveryAttempted: false }, "using");
    });
    await act(async () => { await Promise.resolve(); });
    expect(current!.summary?.limits[0]?.usedPercent).toBe(60);
    expect(current!.refreshError).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await redemption;
    });
    expect(current!.summary?.limits[0]?.usedPercent).toBe(0);
    expect(current!.resetObservation).toBe("confirmed");
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(current!.resetOutcome).toBeNull();
  });

  it("does not automatically repeat a rejected reset request", async () => {
    apiMocks.consumeResetCredit.mockRejectedValue(new ApiError("Invalid credit", 400));
    await renderMonitor((monitor) => { current = monitor; });

    await act(async () => {
      await current!.consumeReset({ idempotencyKey: "attempt-invalid", creditId: "credit-1", recoveryAttempted: false }, "using");
    });

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(current!.pendingAttempt).toBeNull();
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(current!.resetError).toContain("rejected");
  });

  it("polls the requested provider and stays idle while disabled", async () => {
    apiMocks.providerUsageSummary.mockResolvedValue({ ...summary(10), provider: "claude" });
    await renderMonitor((monitor) => { current = monitor; }, { provider: "claude", enabled: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS * 3); });
    expect(apiMocks.providerUsageSummary).not.toHaveBeenCalled();
    expect(current!.initialLoading).toBe(false);

    await renderMonitor((monitor) => { current = monitor; }, { provider: "claude", enabled: true });
    expect(apiMocks.providerUsageSummary).toHaveBeenCalledWith("claude", false);
    expect(current!.summary?.provider).toBe("claude");
  });

  it("does not recover a pending reset attempt while reset credits are disabled", async () => {
    window.localStorage.setItem(pendingResetStorageKey("claude"), JSON.stringify({ idempotencyKey: "attempt-claude", creditId: null }));
    await renderMonitor((monitor) => { current = monitor; }, { provider: "claude", enabled: false });
    expect(apiMocks.consumeResetCredit).not.toHaveBeenCalled();
    expect(current!.resetError).toBeNull();
  });

  async function renderMonitor(onMonitor: (monitor: CodexUsageMonitor) => void, options: { provider?: AgentProviderKind; enabled?: boolean } = {}) {
    await act(async () => {
      root?.render(<MonitorProbe onMonitor={onMonitor} provider={options.provider} enabled={options.enabled} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function MonitorProbe({ onMonitor, provider = "codex", enabled = true }: { onMonitor: (monitor: CodexUsageMonitor) => void; provider?: AgentProviderKind; enabled?: boolean }) {
  const usage = useProviderUsageMonitor(provider, enabled);
  const resetCredits = useResetCredits(provider, usage, enabled);
  useEffect(() => onMonitor({ ...usage, ...resetCredits }), [onMonitor, resetCredits, usage]);
  return null;
}

function summary(usedPercent: number, resetsAt = 1_800_000_000): ProviderUsageSummary {
  return {
    provider: "codex",
    available: true,
    error: null,
    refreshedAt: "2026-09-18T12:00:00.000Z",
    accountStatus: "authenticated",
    account: { kind: "chatgpt", email: "engineer@example.com", planType: "plus" },
    limits: [{
      id: "five_hour",
      label: "5h limit",
      limitName: "codex",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowDurationMins: 300,
      resetsAt
    }],
    resetCredits: { availableCount: 1, credits: [] }
  };
}

function installLocalStorage(): void {
  const stored = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear()
    }
  });
}
