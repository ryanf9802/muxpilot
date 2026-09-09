// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSummaryResponse } from "@muxpilot/core";

const apiMocks = vi.hoisted(() => ({
  codexUsageHistory: vi.fn(),
  consumeCodexResetCredit: vi.fn()
}));

vi.mock("../api/client.js", () => ({ api: apiMocks }));

import { CodexUsagePanel } from "./CodexUsagePanel.js";

const PENDING_RESET_KEY = "muxpilot.codex-usage.pending-reset.v1";
const summary: CodexUsageSummaryResponse = {
  available: true,
  error: null,
  refreshedAt: "2026-09-09T12:00:00.000Z",
  account: { kind: "chatgpt", email: "engineer@example.com", planType: "plus" },
  limits: {
    fiveHour: { label: "5h limit", limitName: "codex", usedPercent: 40, remainingPercent: 60, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    weekly: { label: "Weekly limit", limitName: "codex", usedPercent: 70, remainingPercent: 30, windowDurationMins: 10_080, resetsAt: 1_801_000_000 }
  },
  resetCredits: {
    availableCount: 1,
    credits: [{
      id: "reset-1",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1_780_000_000,
      expiresAt: 1_900_000_000,
      title: "Rate-limit reset",
      description: "Reset an eligible Codex rate-limit window."
    }]
  }
};

describe("CodexUsagePanel interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    apiMocks.codexUsageHistory.mockReset().mockResolvedValue({
      available: true,
      error: null,
      refreshedAt: "2026-09-09T12:00:00.000Z",
      days: 30,
      summary: { lifetimeTokens: 30, peakDailyTokens: 20, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 3 },
      points: [{ date: "2026-09-08", tokens: 10 }, { date: "2026-09-09", tokens: 20 }]
    });
    apiMocks.consumeCodexResetCredit.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await renderPanel();
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  it("confirms before consuming a selected reset token", async () => {
    apiMocks.consumeCodexResetCredit.mockResolvedValue({ outcome: "reset", summary: { ...summary, resetCredits: { availableCount: 0, credits: [] } } });

    await clickButton("Use token");
    expect(container.textContent).toContain("Use usage reset token?");
    expect(apiMocks.consumeCodexResetCredit).not.toHaveBeenCalled();

    await clickButton("Use reset token");

    expect(apiMocks.consumeCodexResetCredit).toHaveBeenCalledOnce();
    expect(apiMocks.consumeCodexResetCredit.mock.calls[0]?.[0]).toMatchObject({ creditId: "reset-1" });
    expect(apiMocks.consumeCodexResetCredit.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(container.textContent).toContain("Usage limit reset");
  });

  it("always loads 30 days without a range selector", () => {
    expect(apiMocks.codexUsageHistory).toHaveBeenCalledWith(30, false);
    expect(container.querySelector('[aria-label="Usage history range"]')).toBeNull();
    expect([...container.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("7d");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("30d");
  });

  it("reuses an uncertain attempt after the panel remounts", async () => {
    apiMocks.consumeCodexResetCredit.mockRejectedValueOnce(new Error("Connection closed"));

    await clickButton("Use token");
    await clickButton("Use reset token");

    const firstAttempt = apiMocks.consumeCodexResetCredit.mock.calls[0]?.[0];
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toContain(firstAttempt.idempotencyKey);
    expect(container.textContent).toContain("Retry to check the same reset attempt");

    await act(async () => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    apiMocks.consumeCodexResetCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed", summary });
    await renderPanel();
    await clickButton("Retry");

    expect(apiMocks.consumeCodexResetCredit.mock.calls[1]?.[0]).toEqual(firstAttempt);
    expect(container.textContent).toContain("already completed");
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(<CodexUsagePanel summary={summary} />);
      await Promise.resolve();
    });
  }

  async function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});
