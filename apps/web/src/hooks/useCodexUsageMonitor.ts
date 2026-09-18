import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import type {
  CodexUsageSummaryResponse,
  ConsumeCodexResetCreditOutcome,
  ConsumeCodexResetCreditResponse
} from "@muxpilot/core";
import { api } from "../api/client.js";

export const CODEX_USAGE_POLL_INTERVAL_MS = 10_000;
export const CODEX_USAGE_RETRY_DELAYS_MS = [20_000, 40_000, 60_000] as const;
export const CODEX_RESET_CONFIRM_INTERVAL_MS = 5_000;
export const CODEX_RESET_CONFIRM_TIMEOUT_MS = 20_000;
export const PENDING_RESET_KEY = "muxpilot.codex-usage.pending-reset.v1";

export interface PendingResetAttempt {
  idempotencyKey: string;
  creditId: string | null;
  recoveryAttempted: boolean;
}

export type ResetAction = "using" | "confirming" | "retrying";

export interface CodexUsageMonitor {
  summary: CodexUsageSummaryResponse | null;
  initialLoading: boolean;
  refreshError: string | null;
  pendingAttempt: PendingResetAttempt | null;
  resetAction: ResetAction | null;
  resetError: string | null;
  resetOutcome: ConsumeCodexResetCreditOutcome | null;
  resetRevision: number;
  consumeReset: (attempt: PendingResetAttempt, action: ResetAction, persist?: boolean) => Promise<void>;
}

const resetRequests = new Map<string, Promise<ConsumeCodexResetCreditResponse>>();
const resetConfirmations = new Map<string, Promise<void>>();

export function useCodexUsageMonitor(): CodexUsageMonitor {
  const [summary, setSummary] = useState<CodexUsageSummaryResponse | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pendingAttempt, setPendingAttempt] = useState<PendingResetAttempt | null>(() => loadPendingResetAttempt());
  const [resetAction, setResetAction] = useState<ResetAction | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetOutcome, setResetOutcome] = useState<ConsumeCodexResetCreditOutcome | null>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const summaryRef = useRef<CodexUsageSummaryResponse | null>(null);
  const requestIdRef = useRef(0);
  const resetBusyRef = useRef(false);

  const acceptSummary = useCallback((next: CodexUsageSummaryResponse) => {
    summaryRef.current = next;
    setSummary(next);
    setInitialLoading(false);
    setRefreshError(null);
  }, []);

  const refreshSummary = useCallback(async (force = false): Promise<CodexUsageSummaryResponse> => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await api.codexUsageSummary(force);
      if (!next.available) throw new Error(next.error ?? "Codex usage is unavailable.");
      if (requestId === requestIdRef.current) acceptSummary(next);
      return next;
    } catch (error) {
      if (requestId === requestIdRef.current) {
        const message = error instanceof Error ? error.message : "Codex usage could not be refreshed.";
        setRefreshError(message);
        if (!summaryRef.current) {
          setSummary(unavailableSummary(message));
          setInitialLoading(false);
        }
      }
      throw error;
    }
  }, [acceptSummary]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let failureCount = 0;
    let polling = false;
    const schedule = (delay: number) => {
      if (!stopped) timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible" || polling) return;
      polling = true;
      try {
        await refreshSummary();
        failureCount = 0;
        schedule(CODEX_USAGE_POLL_INTERVAL_MS);
      } catch {
        const delay = CODEX_USAGE_RETRY_DELAYS_MS[Math.min(failureCount, CODEX_USAGE_RETRY_DELAYS_MS.length - 1)];
        failureCount += 1;
        schedule(delay!);
      } finally {
        polling = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        return;
      }
      failureCount = 0;
      if (timer !== null) window.clearTimeout(timer);
      if (!polling) void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshSummary]);

  const consumeReset = useCallback(async (attempt: PendingResetAttempt, action: ResetAction, persist = true) => {
    if (resetBusyRef.current) return;
    resetBusyRef.current = true;
    setResetAction(action);
    setResetError(null);
    setResetOutcome(null);
    setPendingAttempt(attempt);
    if (persist) savePendingResetAttempt(attempt);
    const before = summaryRef.current;
    try {
      const response = await requestReset(attempt);
      clearPendingResetAttempt(attempt);
      const nextAttempt = loadPendingResetAttempt();
      setPendingAttempt(nextAttempt);
      if (!nextAttempt) setResetOutcome(response.outcome);
      requestIdRef.current += 1;
      acceptSummary(response.summary);
      setResetRevision((value) => value + 1);
      if (!nextAttempt && (response.outcome === "reset" || response.outcome === "alreadyRedeemed")) {
        await confirmResetAttempt(attempt, before, response.summary, refreshSummary);
      }
    } catch (error) {
      setResetError(error instanceof Error ? error.message : "The reset attempt could not be confirmed.");
    } finally {
      resetBusyRef.current = false;
      setResetAction(null);
    }
  }, [acceptSummary, refreshSummary]);

  useEffect(() => {
    const restoredAttempt = loadPendingResetAttempt();
    if (!restoredAttempt || restoredAttempt.recoveryAttempted) return;
    const recoveryAttempt = { ...restoredAttempt, recoveryAttempted: true };
    if (!replacePendingResetAttempt(restoredAttempt, recoveryAttempt)) {
      setPendingAttempt(loadPendingResetAttempt());
      return;
    }
    setPendingAttempt(recoveryAttempt);
    void consumeReset(recoveryAttempt, "confirming", false);
  }, [consumeReset]);

  useEffect(() => {
    if (pendingAttempt && !resetAction) {
      setResetError((current) => current ?? "A previous reset attempt did not receive a confirmed result.");
    }
  }, [pendingAttempt, resetAction]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PENDING_RESET_KEY) return;
      const nextAttempt = loadPendingResetAttempt();
      setPendingAttempt(nextAttempt);
      if (!nextAttempt) setResetError(null);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return { summary, initialLoading, refreshError, pendingAttempt, resetAction, resetError, resetOutcome, resetRevision, consumeReset };
}

function confirmResetAttempt(
  attempt: PendingResetAttempt,
  before: CodexUsageSummaryResponse | null,
  initial: CodexUsageSummaryResponse,
  refresh: (force?: boolean) => Promise<CodexUsageSummaryResponse>
): Promise<void> {
  const key = `${attempt.idempotencyKey}:${attempt.creditId ?? ""}`;
  const existing = resetConfirmations.get(key);
  if (existing) return existing;
  const confirmation = confirmResetUsage(before, initial, refresh)
    .finally(() => resetConfirmations.delete(key));
  resetConfirmations.set(key, confirmation);
  return confirmation;
}

async function confirmResetUsage(
  before: CodexUsageSummaryResponse | null,
  initial: CodexUsageSummaryResponse,
  refresh: (force?: boolean) => Promise<CodexUsageSummaryResponse>
): Promise<void> {
  let current = initial;
  const deadline = Date.now() + CODEX_RESET_CONFIRM_TIMEOUT_MS;
  while (!observedReset(before, current) && Date.now() < deadline) {
    await delay(CODEX_RESET_CONFIRM_INTERVAL_MS);
    try {
      current = await refresh(true);
    } catch {
      // The confirmed redemption remains successful even when observation is delayed.
    }
  }
  if (observedReset(before, current)) {
    const remaining = highestObservedRemaining(before, current);
    toast.success(remaining === 100
      ? "Usage reset confirmed. 100% capacity is available."
      : `Usage reset confirmed. ${Math.round(remaining ?? 0)}% capacity is currently available.`);
  } else {
    toast.success("Reset token redeemed. Updated usage has not yet been confirmed.");
  }
}

export function observedReset(before: CodexUsageSummaryResponse | null, after: CodexUsageSummaryResponse): boolean {
  return (["fiveHour", "weekly"] as const).some((key) => {
    const previous = before?.limits[key];
    const current = after.limits[key];
    if (!current || current.remainingPercent === null) return false;
    if (current.remainingPercent >= 100 && (!previous || (previous.remainingPercent ?? 0) < 100)) return true;
    return previous?.usedPercent !== null && previous?.usedPercent !== undefined
      && current.usedPercent !== null && current.usedPercent !== undefined
      && current.usedPercent < previous.usedPercent;
  });
}

function highestObservedRemaining(before: CodexUsageSummaryResponse | null, after: CodexUsageSummaryResponse): number | null {
  const observed = (["fiveHour", "weekly"] as const).flatMap((key) => {
    const previous = before?.limits[key];
    const current = after.limits[key];
    if (!current?.remainingPercent && current?.remainingPercent !== 0) return [];
    if (current.remainingPercent >= 100 || (previous?.usedPercent != null && current.usedPercent != null && current.usedPercent < previous.usedPercent)) {
      return [current.remainingPercent];
    }
    return [];
  });
  return observed.length ? Math.max(...observed) : null;
}

function requestReset(attempt: PendingResetAttempt): Promise<ConsumeCodexResetCreditResponse> {
  const key = `${attempt.idempotencyKey}\u0000${attempt.creditId ?? ""}`;
  const existing = resetRequests.get(key);
  if (existing) return existing;
  const request = api.consumeCodexResetCredit({ idempotencyKey: attempt.idempotencyKey, creditId: attempt.creditId })
    .finally(() => resetRequests.delete(key));
  resetRequests.set(key, request);
  return request;
}

export function loadPendingResetAttempt(): PendingResetAttempt | null {
  try {
    const value = window.localStorage.getItem(PENDING_RESET_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PendingResetAttempt>;
    if (typeof parsed.idempotencyKey !== "string" || !parsed.idempotencyKey || (parsed.creditId !== null && typeof parsed.creditId !== "string")) throw new Error("invalid");
    return { idempotencyKey: parsed.idempotencyKey, creditId: parsed.creditId ?? null, recoveryAttempted: parsed.recoveryAttempted === true };
  } catch {
    try {
      window.localStorage.removeItem(PENDING_RESET_KEY);
    } catch {
      // Recovery remains available in memory when storage is unavailable.
    }
    return null;
  }
}

function savePendingResetAttempt(attempt: PendingResetAttempt): boolean {
  try {
    window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify(attempt));
    return true;
  } catch {
    // The mounted shell retains the attempt when storage is unavailable.
    return false;
  }
}

function replacePendingResetAttempt(expected: PendingResetAttempt, replacement: PendingResetAttempt): boolean {
  const current = loadPendingResetAttempt();
  if (!sameAttempt(current, expected)) return false;
  return savePendingResetAttempt(replacement);
}

function clearPendingResetAttempt(expected: PendingResetAttempt): void {
  try {
    if (sameAttempt(loadPendingResetAttempt(), expected)) window.localStorage.removeItem(PENDING_RESET_KEY);
  } catch {
    // The in-memory attempt is still cleared by the caller.
  }
}

function sameAttempt(left: PendingResetAttempt | null, right: PendingResetAttempt): boolean {
  return left?.idempotencyKey === right.idempotencyKey && left.creditId === right.creditId;
}

function unavailableSummary(error: string): CodexUsageSummaryResponse {
  return { available: false, error, refreshedAt: new Date().toISOString(), account: null, limits: { fiveHour: null, weekly: null }, resetCredits: null };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
