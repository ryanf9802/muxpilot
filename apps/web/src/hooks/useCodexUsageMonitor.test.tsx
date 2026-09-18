// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSummaryResponse } from "@muxpilot/core";

const apiMocks = vi.hoisted(() => ({
  codexUsageSummary: vi.fn(),
  consumeCodexResetCredit: vi.fn()
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));

vi.mock("../api/client.js", () => ({ api: apiMocks }));
vi.mock("react-toastify", () => ({ toast: toastMocks }));

import {
  CODEX_USAGE_POLL_INTERVAL_MS,
  PENDING_RESET_KEY,
  notifyThresholdCrossings,
  observedReset,
  useCodexUsageMonitor,
  type CodexUsageMonitor
} from "./useCodexUsageMonitor.js";

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("Codex usage thresholds", () => {
  beforeEach(() => {
    installLocalStorage();
    toastMocks.warning.mockReset();
    toastMocks.error.mockReset();
  });

  it("silently establishes a baseline and emits only the highest newly crossed threshold", () => {
    notifyThresholdCrossings(null, summary(40));
    expect(toastMocks.warning).not.toHaveBeenCalled();

    notifyThresholdCrossings(summary(40), summary(76));
    expect(toastMocks.warning).toHaveBeenCalledOnce();
    expect(toastMocks.warning).toHaveBeenLastCalledWith(expect.stringContaining("76% used"));

    notifyThresholdCrossings(summary(76), summary(91));
    expect(toastMocks.warning).toHaveBeenCalledTimes(2);

    notifyThresholdCrossings(summary(91), summary(100));
    expect(toastMocks.error).toHaveBeenCalledOnce();
    expect(toastMocks.error).toHaveBeenCalledWith(expect.stringContaining("100% used"));
  });

  it("treats a new usage window as a silent baseline", () => {
    notifyThresholdCrossings(null, summary(40));
    notifyThresholdCrossings(summary(40), summary(76));
    toastMocks.warning.mockClear();

    notifyThresholdCrossings(summary(76), summary(80, 1_900_000_000));
    expect(toastMocks.warning).not.toHaveBeenCalled();
  });

  it("silences the first reading after an app reload while retaining threshold deduplication", () => {
    notifyThresholdCrossings(null, summary(40));
    notifyThresholdCrossings(null, summary(76));
    expect(toastMocks.warning).not.toHaveBeenCalled();

    notifyThresholdCrossings(summary(76), summary(91));
    expect(toastMocks.warning).toHaveBeenCalledOnce();
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining("91% used"));
  });

  it("recognizes full capacity or a usage decrease without accepting an unchanged full limit", () => {
    expect(observedReset(summary(60), summary(0))).toBe(true);
    expect(observedReset(summary(60), summary(25))).toBe(true);
    expect(observedReset(summary(0), summary(0))).toBe(false);
  });
});

describe("useCodexUsageMonitor", () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let current: CodexUsageMonitor | null;

  beforeEach(() => {
    vi.useFakeTimers();
    installLocalStorage();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    apiMocks.codexUsageSummary.mockReset().mockResolvedValue(summary(10));
    apiMocks.consumeCodexResetCredit.mockReset();
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
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failed refresh and resumes the normal cadence after success", async () => {
    apiMocks.codexUsageSummary.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(summary(10));
    await renderMonitor((monitor) => { current = monitor; });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(CODEX_USAGE_POLL_INTERVAL_MS); });
    expect(apiMocks.codexUsageSummary).toHaveBeenCalledTimes(3);
  });

  it("uses one token attempt and confirms success when refreshed capacity is full", async () => {
    apiMocks.codexUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeCodexResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(0) });
    await renderMonitor((monitor) => { current = monitor; });
    const attempt = { idempotencyKey: "attempt-1", creditId: "credit-1", recoveryAttempted: false };

    await act(async () => { await current!.consumeReset(attempt, "using"); });

    expect(apiMocks.consumeCodexResetCredit).toHaveBeenCalledOnce();
    expect(apiMocks.consumeCodexResetCredit).toHaveBeenCalledWith({ idempotencyKey: "attempt-1", creditId: "credit-1" });
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(toastMocks.success).toHaveBeenCalledWith("Usage reset confirmed. 100% capacity is available.");
  });

  it("confirms a reset when running work consumes some of the restored capacity", async () => {
    apiMocks.codexUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeCodexResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(55) });
    await renderMonitor((monitor) => { current = monitor; });

    await act(async () => {
      await current!.consumeReset({ idempotencyKey: "attempt-running", creditId: "credit-1", recoveryAttempted: false }, "using");
    });

    expect(apiMocks.consumeCodexResetCredit).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith("Usage reset confirmed. 45% capacity is currently available.");
  });

  it("still reports successful redemption when refreshed limits remain delayed", async () => {
    apiMocks.codexUsageSummary.mockResolvedValue(summary(60));
    apiMocks.consumeCodexResetCredit.mockResolvedValue({ outcome: "reset", summary: summary(60) });
    await renderMonitor((monitor) => { current = monitor; });
    let redemption!: Promise<void>;

    act(() => {
      redemption = current!.consumeReset({ idempotencyKey: "attempt-delayed", creditId: "credit-1", recoveryAttempted: false }, "using");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await redemption;
    });

    expect(apiMocks.consumeCodexResetCredit).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith("Reset token redeemed. Updated usage has not yet been confirmed.");
  });

  async function renderMonitor(onMonitor: (monitor: CodexUsageMonitor) => void) {
    await act(async () => {
      root?.render(<MonitorProbe onMonitor={onMonitor} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

function MonitorProbe({ onMonitor }: { onMonitor: (monitor: CodexUsageMonitor) => void }) {
  const monitor = useCodexUsageMonitor();
  useEffect(() => onMonitor(monitor), [monitor, onMonitor]);
  return null;
}

function summary(usedPercent: number, resetsAt = 1_800_000_000): CodexUsageSummaryResponse {
  return {
    available: true,
    error: null,
    refreshedAt: "2026-09-18T12:00:00.000Z",
    account: { kind: "chatgpt", email: "engineer@example.com", planType: "plus" },
    limits: {
      fiveHour: {
        label: "5h limit",
        limitName: "codex",
        usedPercent,
        remainingPercent: 100 - usedPercent,
        windowDurationMins: 300,
        resetsAt
      },
      weekly: null
    },
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
