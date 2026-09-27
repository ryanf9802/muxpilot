import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentProviderKind, ProviderTokenUsageDailyPoint, ProviderTokenUsageResponse } from "@muxpilot/core";
import { api } from "../api/client.js";
import { providerLabel } from "../utils/providers.js";

const TOKEN_USAGE_RECONCILE_INTERVAL_MS = 10_000;
export const TOKEN_USAGE_HISTORY_DAYS = 30;

/** Polls a provider's daily token history while visible; reloads immediately when `revision` changes. */
export function useTokenUsageHistory(provider: AgentProviderKind, enabled: boolean, revision: number) {
  const [history, setHistory] = useState<ProviderTokenUsageResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const loadHistory = useCallback((refresh = false): Promise<void> => {
    if (inFlightRef.current) {
      return refresh
        ? inFlightRef.current.catch(() => undefined).then(() => loadHistory(true))
        : inFlightRef.current;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const unavailableMessage = `${providerLabel(provider)} token usage is unavailable.`;
    const request = (async () => {
      try {
        const nextHistory = await api.providerUsageHistory(provider, TOKEN_USAGE_HISTORY_DAYS, refresh);
        if (!nextHistory.available) throw new Error(nextHistory.error ?? unavailableMessage);
        if (requestId === requestIdRef.current) {
          setHistory(nextHistory);
          setRefreshError(null);
        }
      } catch (error) {
        if (requestId === requestIdRef.current) {
          const message = error instanceof Error ? error.message : unavailableMessage;
          setRefreshError(message);
          setHistory((current) => current ?? {
            provider,
            available: false,
            error: message,
            refreshedAt: new Date().toISOString(),
            days: TOKEN_USAGE_HISTORY_DAYS,
            summary: null,
            points: null
          });
        }
        throw error;
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    })();
    inFlightRef.current = request;
    void request.finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null;
    }).catch(() => undefined);
    return request;
  }, [provider]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: number | null = null;
    let stopped = false;
    let failureCount = 0;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      await loadHistory().then(() => { failureCount = 0; }).catch(() => { failureCount += 1; });
      if (!stopped) timer = window.setTimeout(() => void poll(), failureCount ? Math.min(60_000, 10_000 * 2 ** failureCount) : TOKEN_USAGE_RECONCILE_INTERVAL_MS);
    };
    const onVisibilityChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "visible") void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, loadHistory]);

  const previousRevision = useRef(revision);
  useEffect(() => {
    if (revision === previousRevision.current) return;
    previousRevision.current = revision;
    if (enabled) void loadHistory(true).catch(() => undefined);
  }, [enabled, loadHistory, revision]);

  return { history, loading, refreshError };
}

export function TokenUsageChart({
  provider,
  history,
  loading
}: {
  provider: AgentProviderKind;
  history: ProviderTokenUsageResponse | null;
  loading: boolean;
}) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const points = history?.points ?? null;
  if (loading && !history) return <div className="usage-history-empty">Loading token activity…</div>;
  if (!history?.available) return <div className="usage-history-empty">{history?.error ?? "Token activity is unavailable."}</div>;
  if (points === null) return <div className="usage-history-empty">Daily token activity is unavailable for this account.</div>;
  if (points.length === 0) return <div className="usage-history-empty">No daily token activity was returned.</div>;
  const max = Math.max(...points.map((point) => point.tokens), 1);
  const activePoint = points.find((point) => point.date === activeDate) ?? null;
  return (
    <>
      <div className="usage-token-chart" role="group" aria-label={`${providerLabel(provider)} token activity over ${history.days} days`}>
        {points.map((point) => (
          <TokenBar key={point.date} point={point} max={max} onActivate={() => setActiveDate(point.date)} />
        ))}
      </div>
      {activePoint ? <div className="usage-token-chart-detail" role="status">{formatDate(activePoint.date)} · {formatNumber(activePoint.tokens)} tokens</div> : null}
    </>
  );
}

function TokenBar({ point, max, onActivate }: { point: ProviderTokenUsageDailyPoint; max: number; onActivate: () => void }) {
  const label = `${formatDate(point.date)}: ${formatNumber(point.tokens)} tokens`;
  return (
    <button
      className="usage-token-bar"
      type="button"
      aria-label={label}
      title={label}
      style={{ height: `${Math.max(2, (point.tokens / max) * 100)}%` }}
      onMouseEnter={onActivate}
      onFocus={onActivate}
      onClick={onActivate}
    />
  );
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
