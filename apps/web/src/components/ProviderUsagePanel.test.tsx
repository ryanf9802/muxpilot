// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDescriptor, ProviderUsageSummary } from "@muxpilot/core";

const apiMocks = vi.hoisted(() => ({
  providerUsageSummary: vi.fn(),
  providerUsageHistory: vi.fn(),
  consumeResetCredit: vi.fn()
}));

vi.mock("../api/client.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../api/client.js")>(), api: apiMocks }));

import { ProviderUsagePanel } from "./ProviderUsagePanel.js";
import { useProviderUsageMonitor } from "../hooks/useProviderUsageMonitor.js";
import { useResetCredits } from "../hooks/useResetCredits.js";
import { ApiError } from "../api/client.js";

const PENDING_RESET_KEY = "muxpilot.codex-usage.pending-reset.v1";
const summary: ProviderUsageSummary = {
  provider: "codex",
  available: true,
  error: null,
  refreshedAt: "2026-09-09T12:00:00.000Z",
  accountStatus: "authenticated",
  account: { kind: "chatgpt", email: "engineer@example.com", planType: "plus" },
  limits: [
    { id: "five_hour", label: "5h limit", limitName: "codex", usedPercent: 40, remainingPercent: 60, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    { id: "weekly", label: "Weekly limit", limitName: "codex", usedPercent: 70, remainingPercent: 30, windowDurationMins: 10_080, resetsAt: 1_801_000_000 }
  ],
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

describe("ProviderUsagePanel Codex reset interactions", () => {
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
    apiMocks.providerUsageHistory.mockReset().mockResolvedValue({
      provider: "codex",
      available: true,
      error: null,
      refreshedAt: "2026-09-09T12:00:00.000Z",
      days: 30,
      summary: { lifetimeTokens: 30, peakDailyTokens: 20, longestRunningTurnSec: 10, currentStreakDays: 2, longestStreakDays: 3 },
      points: [{ date: "2026-09-08", tokens: 10 }, { date: "2026-09-09", tokens: 20 }]
    });
    apiMocks.providerUsageSummary.mockReset().mockResolvedValue(summary);
    apiMocks.consumeResetCredit.mockReset();
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
    apiMocks.consumeResetCredit.mockResolvedValue({ outcome: "reset", summary: { ...summary, resetCredits: { availableCount: 0, credits: [] } } });

    await clickButton("Use token");
    expect(container.textContent).toContain("Use usage reset token?");
    expect(apiMocks.consumeResetCredit).not.toHaveBeenCalled();

    await clickButton("Use reset token");

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(apiMocks.consumeResetCredit.mock.calls[0]?.[0]).toBe("codex");
    expect(apiMocks.consumeResetCredit.mock.calls[0]?.[1]).toMatchObject({ creditId: "reset-1" });
    expect(apiMocks.consumeResetCredit.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
    expect(container.textContent).toContain("Reset token redeemed. Confirming updated account limits");
    expect(container.querySelector('[aria-label="Refresh Codex usage"]')).toBeNull();
  });

  it("always loads 30 days without a range selector", () => {
    expect(apiMocks.providerUsageHistory).toHaveBeenCalledWith("codex", 30, false);
    expect(container.querySelector('[aria-label="Usage history range"]')).toBeNull();
    const buttonLabels = Array.from(container.querySelectorAll("button"), (button) => button.textContent?.trim());
    expect(buttonLabels).not.toContain("7d");
    expect(buttonLabels).not.toContain("30d");
  });

  it("keeps stale limits visible with a quiet retry status and disables reset tokens", async () => {
    apiMocks.providerUsageSummary.mockRejectedValueOnce(new Error("limits delayed"));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Unable to refresh; retrying");
    expect(container.textContent).toContain("60% remaining");
    expect(container.textContent).toContain("engineer@example.com");
    expect(container.querySelector(".codex-reset-row button")?.hasAttribute("disabled")).toBe(true);
    expect(container.querySelector('.usage-error[role="alert"]')).toBeNull();
  });

  it("confirms an uncertain attempt immediately with the same identifiers", async () => {
    apiMocks.consumeResetCredit
      .mockRejectedValueOnce(new ApiError("Internal Server Error", 500))
      .mockResolvedValueOnce({ outcome: "alreadyRedeemed", summary: { ...summary, limits: [{ ...summary.limits[0]!, usedPercent: 0, remainingPercent: 100 }, summary.limits[1]!] } });

    await clickButton("Use token");
    await clickButton("Use reset token");

    const firstAttempt = apiMocks.consumeResetCredit.mock.calls[0]?.[1];
    expect(apiMocks.consumeResetCredit).toHaveBeenCalledTimes(2);
    expect(apiMocks.consumeResetCredit.mock.calls[1]?.[1]).toEqual(firstAttempt);
    expect(container.textContent).toContain("Reset complete");
    expect(container.textContent).not.toContain("Internal Server Error");
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("keeps an uncertain attempt after two failed checks without another automatic request on remount", async () => {
    apiMocks.consumeResetCredit
      .mockRejectedValueOnce(new Error("Connection closed"))
      .mockRejectedValueOnce(new Error("Still offline"));

    await clickButton("Use token");
    await clickButton("Use reset token");

    const firstAttempt = apiMocks.consumeResetCredit.mock.calls[0]?.[1];
    expect(apiMocks.consumeResetCredit).toHaveBeenCalledTimes(2);
    expect(apiMocks.consumeResetCredit.mock.calls[1]?.[1]).toEqual(firstAttempt);
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toContain('"recoveryAttempted":true');
    expect(container.textContent).toContain("Retry to check the same reset attempt");

    await act(async () => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    await renderPanel();
    expect(apiMocks.consumeResetCredit).toHaveBeenCalledTimes(2);

    apiMocks.consumeResetCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed", summary });
    await clickButton("Retry");
    expect(apiMocks.consumeResetCredit.mock.calls[2]?.[1]).toEqual(firstAttempt);
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("does not show an error while a new reset is in flight", async () => {
    let resolveReset!: (value: unknown) => void;
    apiMocks.consumeResetCredit.mockReturnValue(new Promise((resolve) => { resolveReset = resolve; }));

    await clickButton("Use token");
    await clickButton("Use reset token");

    expect(container.textContent).not.toContain("previous reset attempt");
    await act(async () => resolveReset({ outcome: "reset", summary }));
  });

  it("shares an in-flight request when recovery remounts", async () => {
    let resolveReset!: (value: unknown) => void;
    apiMocks.consumeResetCredit.mockReturnValue(new Promise((resolve) => { resolveReset = resolve; }));
    await clickButton("Use token");
    await clickButton("Use reset token");

    await act(async () => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    await renderPanel();

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Confirming reset");
    await act(async () => resolveReset({ outcome: "reset", summary }));
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  it("runs automatic recovery only once and preserves the exact attempt for manual retry", async () => {
    const attempt = {
      idempotencyKey: "2b86245c-5b67-4f22-877f-805f06437a1e",
      creditId: "reset-original"
    };
    await remountWithPending(attempt);
    apiMocks.consumeResetCredit.mockRejectedValueOnce(new Error("Still offline"));

    await renderPanel();

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(apiMocks.consumeResetCredit.mock.calls[0]?.[1]).toEqual(attempt);
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toContain('"recoveryAttempted":true');
    expect(container.textContent).toContain("We couldn't confirm whether the reset token was used");

    await act(async () => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    await renderPanel();
    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();

    apiMocks.consumeResetCredit.mockResolvedValueOnce({ outcome: "alreadyRedeemed", summary });
    await clickButton("Retry");
    expect(apiMocks.consumeResetCredit.mock.calls[1]?.[1]).toEqual(attempt);
  });

  it("does not let an older completion clear a newer pending attempt", async () => {
    let resolveReset!: (value: unknown) => void;
    apiMocks.consumeResetCredit.mockReturnValue(new Promise((resolve) => { resolveReset = resolve; }));
    await clickButton("Use token");
    await clickButton("Use reset token");

    const newerAttempt = {
      idempotencyKey: "1f5ba965-50e2-49a7-a8a2-5555ef9ed662",
      creditId: "reset-newer",
      recoveryAttempted: true
    };
    await act(async () => {
      window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify(newerAttempt));
      window.dispatchEvent(new StorageEvent("storage", { key: PENDING_RESET_KEY }));
    });
    await act(async () => resolveReset({ outcome: "reset", summary }));

    expect(JSON.parse(window.localStorage.getItem(PENDING_RESET_KEY)!)).toEqual(newerAttempt);
    expect(container.textContent).not.toContain("Usage limit reset");
  });

  it("does not retry or report an older failed request against a newer pending attempt", async () => {
    let rejectReset!: (error: Error) => void;
    apiMocks.consumeResetCredit.mockReturnValue(new Promise((_, reject) => { rejectReset = reject; }));
    await clickButton("Use token");
    await clickButton("Use reset token");

    const newerAttempt = {
      idempotencyKey: "4dfb0c0b-5ec3-4c1e-bb31-68266847eb80",
      creditId: "reset-newer",
      recoveryAttempted: true
    };
    await act(async () => {
      window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify(newerAttempt));
      window.dispatchEvent(new StorageEvent("storage", { key: PENDING_RESET_KEY }));
      rejectReset(new Error("Old request failed"));
    });

    expect(apiMocks.consumeResetCredit).toHaveBeenCalledOnce();
    expect(JSON.parse(window.localStorage.getItem(PENDING_RESET_KEY)!)).toEqual(newerAttempt);
    expect(container.textContent).not.toContain("Old request failed");
  });

  it("discards malformed saved attempts without making a redemption request", async () => {
    await act(async () => root.unmount());
    container.replaceChildren();
    window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify({ idempotencyKey: "", creditId: "reset-1" }));
    root = createRoot(container);

    await renderPanel();

    expect(apiMocks.consumeResetCredit).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PENDING_RESET_KEY)).toBeNull();
  });

  async function renderPanel() {
    await act(async () => {
      root.render(<TestPanel />);
      await Promise.resolve();
    });
  }

  async function remountWithPending(attempt: { idempotencyKey: string; creditId: string | null }) {
    await act(async () => root.unmount());
    container.replaceChildren();
    window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify(attempt));
    root = createRoot(container);
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

function TestPanel() {
  const usage = useProviderUsageMonitor("codex", true);
  const resetCredits = useResetCredits("codex", usage, true);
  return <ProviderUsagePanel provider="codex" summary={usage.summary ?? summary} refreshError={usage.refreshError} resetCredits={resetCredits} />;
}

describe("ProviderUsagePanel for Claude", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    apiMocks.providerUsageHistory.mockReset().mockResolvedValue({
      provider: "claude",
      available: true,
      error: null,
      refreshedAt: "2026-09-09T12:00:00.000Z",
      days: 30,
      summary: null,
      points: [{ date: "2026-09-09", tokens: 42 }]
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders every reported limit and never offers reset tokens", async () => {
    await act(async () => {
      root.render(<ProviderUsagePanel provider="claude" descriptor={claudeDescriptor("ready")} summary={claudeSummary} refreshError={null} />);
      await Promise.resolve();
    });

    expect(container.querySelector("h2")?.textContent).toBe("Claude usage");
    expect(Array.from(container.querySelectorAll(".usage-limit-row"), (row) => row.getAttribute("data-limit")))
      .toEqual(["five_hour", "weekly", "weekly_opus", "weekly_sonnet"]);
    expect(container.textContent).toContain("Opus weekly limit");
    expect(container.textContent).toContain("88% remaining");
    expect(container.textContent).toContain("claude@example.com");
    expect(container.textContent).not.toContain("Usage reset tokens");
    expect(container.querySelector(".codex-reset-section")).toBeNull();
    expect(container.textContent).toContain("Token activity");
    expect(apiMocks.providerUsageHistory).toHaveBeenCalledWith("claude", 30, false);
    expect(container.querySelector(".provider-auth-callout")).toBeNull();
  });

  it("hides token activity when the provider does not report history", async () => {
    const descriptor = claudeDescriptor("ready");
    descriptor.capabilities = { ...descriptor.capabilities, tokenUsageHistory: false };
    await act(async () => {
      root.render(<ProviderUsagePanel provider="claude" descriptor={descriptor} summary={claudeSummary} refreshError={null} />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Token activity");
    expect(apiMocks.providerUsageHistory).not.toHaveBeenCalled();
  });

  it("explains a signed-out provider with a copyable login command and no in-browser sign-in", async () => {
    const checkAgain = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ProviderUsagePanel
          provider="claude"
          descriptor={claudeDescriptor("signed_out")}
          summary={{ ...claudeSummary, available: false, accountStatus: "signed_out", account: null, limits: [] }}
          refreshError={null}
          onCheckAuth={checkAgain}
        />
      );
      await Promise.resolve();
    });

    const callout = container.querySelector(".provider-auth-callout");
    expect(callout?.textContent).toContain("Claude is not signed in on this host.");
    expect(callout?.querySelector("code")?.textContent).toBe("claude auth login");
    expect(container.querySelector('[aria-label="Copy claude auth login"]')).not.toBeNull();
    expect(container.querySelector(".provider-auth-status")?.textContent).toBe("Signed out");
    const buttonLabels = Array.from(container.querySelectorAll("button"), (button) => button.textContent?.trim() ?? "");
    expect(buttonLabels.some((label) => /sign in|log in|login/i.test(label))).toBe(false);

    const check = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Check again");
    await act(async () => {
      check!.click();
      await Promise.resolve();
    });
    expect(checkAgain).toHaveBeenCalledOnce();
  });
});

const claudeSummary: ProviderUsageSummary = {
  provider: "claude",
  available: true,
  error: null,
  refreshedAt: "2026-09-09T12:00:00.000Z",
  accountStatus: "authenticated",
  account: { kind: "claudeAi", email: "claude@example.com", planType: "max" },
  limits: [
    { id: "five_hour", label: "5h limit", limitName: null, usedPercent: 12, remainingPercent: 88, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    { id: "weekly", label: "Weekly limit", limitName: null, usedPercent: 50, remainingPercent: 50, windowDurationMins: 10_080, resetsAt: 1_801_000_000 },
    { id: "weekly_opus", label: "Opus weekly limit", limitName: null, usedPercent: 20, remainingPercent: 80, windowDurationMins: 10_080, resetsAt: null },
    { id: "weekly_sonnet", label: "Sonnet weekly limit", limitName: null, usedPercent: null, remainingPercent: null, windowDurationMins: null, resetsAt: null }
  ],
  resetCredits: null
};

function claudeDescriptor(status: ProviderDescriptor["auth"]["status"]): ProviderDescriptor {
  return {
    kind: "claude",
    displayName: "Claude",
    enabled: true,
    compatibility: { provider: "claude", status: "available", available: true, version: "2.1.0", detail: "ready", checkedAt: "2026-09-09T12:00:00.000Z", missingCapabilities: [] },
    capabilities: {
      fastMode: false, reasoningEffort: true, planMode: true, steer: true, fork: true, btw: true, approvalReview: false, hibernate: true,
      terminalAttach: false, resetCredits: false, tokenUsageHistory: true, usageLimits: true, goals: false, backgroundTerminals: false,
      transcriptTransfer: true, imageInput: true, rawTranscriptEvidence: true
    },
    auth: { provider: "claude", status, account: null, revision: 1, observedAt: "2026-09-09T12:00:00.000Z", error: null, admissionHeld: false, pendingSessionIds: [] },
    skillInvocation: { prefix: "/", position: "start" },
    loginCommand: "claude auth login"
  };
}
