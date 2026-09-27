import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";
import type {
  AgentProviderKind,
  ConsumeCodexResetCreditOutcome,
  ConsumeCodexResetCreditResponse,
  ProviderUsageSummary
} from "@muxpilot/core";
import { ApiError, api } from "../api/client.js";
import type { ProviderUsageMonitor } from "./useProviderUsageMonitor.js";

export const RESET_CONFIRM_INTERVAL_MS = 5_000;
export const RESET_CONFIRM_TIMEOUT_MS = 20_000;
export const RESET_RESULT_DISPLAY_MS = 8_000;

/** The Codex key predates multi-provider support and must stay stable so pending attempts survive upgrades. */
export function pendingResetStorageKey(provider: AgentProviderKind): string {
  return `muxpilot.${provider}-usage.pending-reset.v1`;
}

export interface PendingResetAttempt {
  idempotencyKey: string;
  creditId: string | null;
  recoveryAttempted: boolean;
}

export type ResetAction = "using" | "confirming" | "retrying";
export type ResetObservation = "confirmed" | "refreshed" | "delayed";

export interface ResetCreditsMonitor {
  pendingAttempt: PendingResetAttempt | null;
  resetAction: ResetAction | null;
  resetError: string | null;
  resetOutcome: ConsumeCodexResetCreditOutcome | null;
  resetObservation: ResetObservation | null;
  resetRevision: number;
  consumeReset: (attempt: PendingResetAttempt, action: ResetAction, persist?: boolean) => Promise<void>;
}

const resetRequests = new Map<string, Promise<ConsumeCodexResetCreditResponse>>();
const resetConfirmations = new Map<string, Promise<boolean>>();

/** Reset-token redemption with crash-safe idempotent retries; inert when `enabled` is false. */
export function useResetCredits(
  provider: AgentProviderKind,
  usage: Pick<ProviderUsageMonitor, "refreshSummary" | "acceptExternalSummary" | "currentSummary">,
  enabled: boolean
): ResetCreditsMonitor {
  const storageKey = pendingResetStorageKey(provider);
  const [pendingAttempt, setPendingAttempt] = useState<PendingResetAttempt | null>(() => loadPendingResetAttempt(storageKey));
  const [resetAction, setResetAction] = useState<ResetAction | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetOutcome, setResetOutcome] = useState<ConsumeCodexResetCreditOutcome | null>(null);
  const [resetObservation, setResetObservation] = useState<ResetObservation | null>(null);
  const [resetRevision, setResetRevision] = useState(0);
  const resetBusyRef = useRef(false);
  const { refreshSummary, acceptExternalSummary, currentSummary } = usage;

  const consumeReset = useCallback(async (attempt: PendingResetAttempt, action: ResetAction, persist = true) => {
    if (resetBusyRef.current) return;
    resetBusyRef.current = true;
    setResetAction(action);
    setResetError(null);
    setResetOutcome(null);
    setResetObservation(null);
    setPendingAttempt(attempt);
    const pendingStored = persist ? savePendingResetAttempt(storageKey, attempt) : sameAttempt(loadPendingResetAttempt(storageKey), attempt);
    const before = currentSummary();
    try {
      let currentAttempt = attempt;
      let response: ConsumeCodexResetCreditResponse;
      try {
        response = await requestReset(provider, currentAttempt);
      } catch (error) {
        if (currentAttempt.recoveryAttempted || !isRetryableResetError(error)) throw error;
        const recoveryAttempt = { ...currentAttempt, recoveryAttempted: true };
        if (!replacePendingResetAttempt(storageKey, currentAttempt, recoveryAttempt)) throw error;
        currentAttempt = recoveryAttempt;
        setPendingAttempt(currentAttempt);
        setResetAction("confirming");
        response = await requestReset(provider, currentAttempt);
      }
      clearPendingResetAttempt(storageKey, currentAttempt);
      const nextAttempt = loadPendingResetAttempt(storageKey);
      setPendingAttempt(nextAttempt);
      if (!nextAttempt) setResetOutcome(response.outcome);
      acceptExternalSummary(response.summary);
      setResetRevision((value) => value + 1);
      if (!nextAttempt && (response.outcome === "reset" || response.outcome === "alreadyRedeemed")) {
        if (response.outcome === "alreadyRedeemed" && response.summary.available) {
          setResetObservation("refreshed");
          toast.success("Reset token redeemed. Account limits refreshed.");
        } else {
          const observed = await confirmResetAttempt(currentAttempt, before, response.summary, (force) => refreshSummary(force, true));
          setResetObservation(observed ? "confirmed" : "delayed");
        }
      }
    } catch (error) {
      const storedAttempt = loadPendingResetAttempt(storageKey);
      if (storedAttempt && !sameAttempt(storedAttempt, attempt)) {
        setPendingAttempt(storedAttempt);
        return;
      }
      if (pendingStored && !storedAttempt) {
        setPendingAttempt(null);
        void refreshSummary(true, true).catch(() => undefined);
        return;
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && !isRetryableResetError(error)) {
        clearPendingResetAttempt(storageKey, attempt);
        setPendingAttempt(loadPendingResetAttempt(storageKey));
        setResetError(error.status === 401 ? "Sign in again before using a reset token." : "The reset request was rejected. Refresh account limits before trying again.");
      } else {
        setResetError("We couldn't confirm whether the reset token was used.");
      }
    } finally {
      resetBusyRef.current = false;
      setResetAction(null);
    }
  }, [acceptExternalSummary, currentSummary, provider, refreshSummary, storageKey]);

  useEffect(() => {
    if (!resetOutcome || resetAction) return;
    const timer = window.setTimeout(() => {
      setResetOutcome(null);
      setResetObservation(null);
    }, RESET_RESULT_DISPLAY_MS);
    return () => window.clearTimeout(timer);
  }, [resetOutcome, resetAction]);

  useEffect(() => {
    if (!enabled) return;
    const restoredAttempt = loadPendingResetAttempt(storageKey);
    if (!restoredAttempt || restoredAttempt.recoveryAttempted) return;
    const recoveryAttempt = { ...restoredAttempt, recoveryAttempted: true };
    if (!replacePendingResetAttempt(storageKey, restoredAttempt, recoveryAttempt)) {
      setPendingAttempt(loadPendingResetAttempt(storageKey));
      return;
    }
    setPendingAttempt(recoveryAttempt);
    void consumeReset(recoveryAttempt, "confirming", false);
  }, [consumeReset, enabled, storageKey]);

  useEffect(() => {
    if (enabled && pendingAttempt && !resetAction) {
      setResetError((current) => current ?? "A previous reset attempt did not receive a confirmed result.");
    }
  }, [enabled, pendingAttempt, resetAction]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const nextAttempt = loadPendingResetAttempt(storageKey);
      setPendingAttempt(nextAttempt);
      if (!nextAttempt) setResetError(null);
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [storageKey]);

  return useMemo(
    () => ({ pendingAttempt, resetAction, resetError, resetOutcome, resetObservation, resetRevision, consumeReset }),
    [consumeReset, pendingAttempt, resetAction, resetError, resetObservation, resetOutcome, resetRevision]
  );
}

function confirmResetAttempt(
  attempt: PendingResetAttempt,
  before: ProviderUsageSummary | null,
  initial: ProviderUsageSummary,
  refresh: (force?: boolean) => Promise<ProviderUsageSummary>
): Promise<boolean> {
  const key = `${initial.provider}:${attempt.idempotencyKey}:${attempt.creditId ?? ""}`;
  const existing = resetConfirmations.get(key);
  if (existing) return existing;
  const confirmation = confirmResetUsage(before, initial, refresh)
    .finally(() => resetConfirmations.delete(key));
  resetConfirmations.set(key, confirmation);
  return confirmation;
}

async function confirmResetUsage(
  before: ProviderUsageSummary | null,
  initial: ProviderUsageSummary,
  refresh: (force?: boolean) => Promise<ProviderUsageSummary>
): Promise<boolean> {
  let current = initial;
  const deadline = Date.now() + RESET_CONFIRM_TIMEOUT_MS;
  while (!observedReset(before, current) && Date.now() < deadline) {
    await delay(RESET_CONFIRM_INTERVAL_MS);
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
  return observedReset(before, current);
}

function isRetryableResetError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

function limitPairs(before: ProviderUsageSummary | null, after: ProviderUsageSummary) {
  return after.limits.map((current) => ({ current, previous: before?.limits.find((limit) => limit.id === current.id) ?? null }));
}

export function observedReset(before: ProviderUsageSummary | null, after: ProviderUsageSummary): boolean {
  return limitPairs(before, after).some(({ previous, current }) => {
    if (current.remainingPercent === null) return false;
    if (current.remainingPercent >= 100 && (!previous || (previous.remainingPercent ?? 0) < 100)) return true;
    return previous?.usedPercent !== null && previous?.usedPercent !== undefined
      && current.usedPercent !== null
      && current.usedPercent < previous.usedPercent;
  });
}

function highestObservedRemaining(before: ProviderUsageSummary | null, after: ProviderUsageSummary): number | null {
  const observed = limitPairs(before, after).flatMap(({ previous, current }) => {
    if (current.remainingPercent === null) return [];
    if (current.remainingPercent >= 100 || (previous?.usedPercent != null && current.usedPercent != null && current.usedPercent < previous.usedPercent)) {
      return [current.remainingPercent];
    }
    return [];
  });
  return observed.length ? Math.max(...observed) : null;
}

function requestReset(provider: AgentProviderKind, attempt: PendingResetAttempt): Promise<ConsumeCodexResetCreditResponse> {
  const key = `${provider}\u0000${attempt.idempotencyKey}\u0000${attempt.creditId ?? ""}`;
  const existing = resetRequests.get(key);
  if (existing) return existing;
  const request = api.consumeResetCredit(provider, { idempotencyKey: attempt.idempotencyKey, creditId: attempt.creditId })
    .finally(() => resetRequests.delete(key));
  resetRequests.set(key, request);
  return request;
}

export function loadPendingResetAttempt(storageKey: string): PendingResetAttempt | null {
  try {
    const value = window.localStorage.getItem(storageKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PendingResetAttempt>;
    if (typeof parsed.idempotencyKey !== "string" || !parsed.idempotencyKey || (parsed.creditId !== null && typeof parsed.creditId !== "string")) throw new Error("invalid");
    return { idempotencyKey: parsed.idempotencyKey, creditId: parsed.creditId ?? null, recoveryAttempted: parsed.recoveryAttempted === true };
  } catch {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // Recovery remains available in memory when storage is unavailable.
    }
    return null;
  }
}

function savePendingResetAttempt(storageKey: string, attempt: PendingResetAttempt): boolean {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(attempt));
    return true;
  } catch {
    // The mounted shell retains the attempt when storage is unavailable.
    return false;
  }
}

function replacePendingResetAttempt(storageKey: string, expected: PendingResetAttempt, replacement: PendingResetAttempt): boolean {
  const current = loadPendingResetAttempt(storageKey);
  if (!sameAttempt(current, expected) || current?.recoveryAttempted !== expected.recoveryAttempted) return false;
  return savePendingResetAttempt(storageKey, replacement);
}

function clearPendingResetAttempt(storageKey: string, expected: PendingResetAttempt): void {
  try {
    if (sameAttempt(loadPendingResetAttempt(storageKey), expected)) window.localStorage.removeItem(storageKey);
  } catch {
    // The in-memory attempt is still cleared by the caller.
  }
}

function sameAttempt(left: PendingResetAttempt | null, right: PendingResetAttempt): boolean {
  return left?.idempotencyKey === right.idempotencyKey && left.creditId === right.creditId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
