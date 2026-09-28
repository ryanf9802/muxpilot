import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentProviderKind, ProviderUsageSummary } from "@muxpilot/core";
import { api } from "../api/client.js";
import { providerLabel } from "../utils/providers.js";

export const PROVIDER_USAGE_POLL_INTERVAL_MS = 10_000;
export const PROVIDER_USAGE_RETRY_DELAYS_MS = [20_000, 40_000, 60_000] as const;

export interface ProviderUsageMonitor {
  provider: AgentProviderKind;
  enabled: boolean;
  summary: ProviderUsageSummary | null;
  initialLoading: boolean;
  refreshError: string | null;
  refreshSummary: (force?: boolean, quiet?: boolean) => Promise<ProviderUsageSummary>;
  /** Accepts a summary obtained outside polling (e.g. from a reset response) and supersedes in-flight polls. */
  acceptExternalSummary: (summary: ProviderUsageSummary) => void;
  currentSummary: () => ProviderUsageSummary | null;
}

/** Polls one provider's account limits while the page is visible, backing off after failures. */
export function useProviderUsageMonitor(provider: AgentProviderKind, enabled: boolean): ProviderUsageMonitor {
  const [summary, setSummary] = useState<ProviderUsageSummary | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const summaryRef = useRef<ProviderUsageSummary | null>(null);
  const requestIdRef = useRef(0);

  const acceptSummary = useCallback((next: ProviderUsageSummary) => {
    summaryRef.current = next;
    setSummary(next);
    setInitialLoading(false);
    setRefreshError(null);
  }, []);

  const refreshSummary = useCallback(async (force = false, quiet = false): Promise<ProviderUsageSummary> => {
    const requestId = ++requestIdRef.current;
    try {
      const next = await api.providerUsageSummary(provider, force);
      if (next.accountStatus === "signed_out") {
        if (requestId === requestIdRef.current) acceptSummary(next);
        return next;
      }
      if (!next.available && requestId === requestIdRef.current && next.account && summaryRef.current?.account && !sameAccount(next.account, summaryRef.current.account)) {
        summaryRef.current = next;
        setSummary(next);
      }
      if (!next.available) throw new UsageResponseError(next);
      if (requestId === requestIdRef.current) acceptSummary(next);
      return next;
    } catch (error) {
      if (requestId === requestIdRef.current && !quiet) {
        const message = error instanceof Error ? error.message : `${providerLabel(provider)} usage could not be refreshed.`;
        setRefreshError(message);
        if (!summaryRef.current) {
          setSummary(nextUnavailableSummary(provider, error, message));
          setInitialLoading(false);
        }
      }
      throw error;
    }
  }, [acceptSummary, provider]);

  const acceptExternalSummary = useCallback((next: ProviderUsageSummary) => {
    requestIdRef.current += 1;
    if (next.available) acceptSummary(next);
  }, [acceptSummary]);

  const currentSummary = useCallback(() => summaryRef.current, []);

  useEffect(() => {
    if (!enabled) return undefined;
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
        schedule(PROVIDER_USAGE_POLL_INTERVAL_MS);
      } catch {
        const delay = PROVIDER_USAGE_RETRY_DELAYS_MS[Math.min(failureCount, PROVIDER_USAGE_RETRY_DELAYS_MS.length - 1)];
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
  }, [enabled, refreshSummary]);

  return useMemo(() => ({
    provider,
    enabled,
    summary,
    initialLoading: enabled && initialLoading,
    refreshError,
    refreshSummary,
    acceptExternalSummary,
    currentSummary
  }), [acceptExternalSummary, currentSummary, enabled, initialLoading, provider, refreshError, refreshSummary, summary]);
}

function unavailableSummary(provider: AgentProviderKind, error: string): ProviderUsageSummary {
  return { provider, available: false, error, refreshedAt: new Date().toISOString(), accountStatus: "unknown", account: null, limits: [], resetCredits: null };
}

function nextUnavailableSummary(provider: AgentProviderKind, error: unknown, message: string): ProviderUsageSummary {
  if (error instanceof UsageResponseError) return error.summary;
  return unavailableSummary(provider, message);
}

class UsageResponseError extends Error {
  constructor(readonly summary: ProviderUsageSummary) {
    super(summary.error ?? `${providerLabel(summary.provider)} usage is unavailable.`);
  }
}

function sameAccount(left: NonNullable<ProviderUsageSummary["account"]>, right: NonNullable<ProviderUsageSummary["account"]>): boolean {
  return left.kind === right.kind && left.email === right.email;
}
