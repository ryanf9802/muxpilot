import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodexRateLimitResetCredit,
  CodexTokenUsageDailyPoint,
  CodexTokenUsageResponse,
  CodexUsageLimit,
  CodexUsageSummaryResponse,
  ConsumeCodexResetCreditOutcome
} from "@muxpilot/core";
import { api } from "../api/client.js";
import type { CodexUsageMonitor } from "../hooks/useCodexUsageMonitor.js";
import { Button, DialogActions } from "./Button.js";
import { Modal } from "./Modal.js";

const CODEX_USAGE_RECONCILE_INTERVAL_MS = 10_000;
const CODEX_USAGE_HISTORY_DAYS = 30;

export function CodexUsagePanel({
  summary,
  usageMonitor
}: {
  summary: CodexUsageSummaryResponse | null;
  usageMonitor: Pick<CodexUsageMonitor, "pendingAttempt" | "resetAction" | "resetError" | "resetOutcome" | "resetRevision" | "consumeReset" | "refreshError">;
}) {
  const [history, setHistory] = useState<CodexTokenUsageResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyRefreshError, setHistoryRefreshError] = useState<string | null>(null);
  const [selectedCredit, setSelectedCredit] = useState<CodexRateLimitResetCredit | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const historyRequestIdRef = useRef(0);
  const historyInFlightRef = useRef<Promise<void> | null>(null);
  const accountLabel = summary ? formatCodexAccount(summary) : "loading";
  const planLabel = summary?.account?.planType ? summary.account.planType : null;
  const { pendingAttempt, resetAction, resetError, resetOutcome, resetRevision, consumeReset, refreshError } = usageMonitor;

  const loadHistory = useCallback((refresh = false): Promise<void> => {
    if (historyInFlightRef.current) {
      return refresh
        ? historyInFlightRef.current.catch(() => undefined).then(() => loadHistory(true))
        : historyInFlightRef.current;
    }
    const requestId = ++historyRequestIdRef.current;
    setHistoryLoading(true);
    const request = (async () => {
      try {
        const nextHistory = await api.codexUsageHistory(CODEX_USAGE_HISTORY_DAYS, refresh);
        if (!nextHistory.available) throw new Error(nextHistory.error ?? "Codex token usage is unavailable.");
        if (requestId === historyRequestIdRef.current) {
          setHistory(nextHistory);
          setHistoryRefreshError(null);
        }
      } catch (error) {
        if (requestId === historyRequestIdRef.current) {
          const message = error instanceof Error ? error.message : "Codex token usage is unavailable.";
          setHistoryRefreshError(message);
          setHistory((current) => current ?? {
            available: false,
            error: message,
            refreshedAt: new Date().toISOString(),
            days: CODEX_USAGE_HISTORY_DAYS,
            summary: null,
            points: null
          });
        }
        throw error;
      } finally {
        if (requestId === historyRequestIdRef.current) setHistoryLoading(false);
      }
    })();
    historyInFlightRef.current = request;
    void request.finally(() => {
      if (historyInFlightRef.current === request) historyInFlightRef.current = null;
    }).catch(() => undefined);
    return request;
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    let stopped = false;
    let failureCount = 0;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      await loadHistory().then(() => { failureCount = 0; }).catch(() => { failureCount += 1; });
      if (!stopped) timer = window.setTimeout(() => void poll(), failureCount ? Math.min(60_000, 10_000 * 2 ** failureCount) : CODEX_USAGE_RECONCILE_INTERVAL_MS);
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
  }, [loadHistory]);

  const previousResetRevision = useRef(resetRevision);
  useEffect(() => {
    if (resetRevision === previousResetRevision.current) return;
    previousResetRevision.current = resetRevision;
    void loadHistory(true).catch(() => undefined);
  }, [loadHistory, resetRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const resetBusy = resetAction !== null;

  function confirmReset() {
    const attempt = {
      idempotencyKey: createIdempotencyKey(),
      creditId: selectedCredit?.id ?? null,
      recoveryAttempted: false
    };
    setSelectedCredit(undefined);
    void consumeReset(attempt, "using");
  }

  const credits = useMemo(
    () => [...(summary?.resetCredits?.credits ?? [])].sort((left, right) => expirationSortValue(left.expiresAt) - expirationSortValue(right.expiresAt)),
    [summary?.resetCredits?.credits]
  );
  const availableCount = summary?.resetCredits?.availableCount ?? null;

  return (
    <section className="usage-panel codex-usage-panel">
      <div className="usage-panel-head">
        <div>
          <h2>Codex usage</h2>
          <p>{summary?.available ? "Account limits" : summary?.error ?? "Account limits"}</p>
        </div>
        <div className="usage-panel-controls">
          <div className="usage-total">
            <strong>{accountLabel}</strong>
            <span>{planLabel ?? (summary ? formatCodexRefresh(summary.refreshedAt) : "loading")}</span>
          </div>
        </div>
      </div>

      <div className="codex-limit-list">
        <CodexLimitRow label="5h limit" limit={summary?.limits.fiveHour ?? null} loading={!summary} />
        <CodexLimitRow label="Weekly limit" limit={summary?.limits.weekly ?? null} loading={!summary} />
      </div>

      <div className="codex-reset-section">
        <div className="codex-section-head">
          <div>
            <h3>Usage reset tokens</h3>
            <p>{resetCreditsDescription(summary, credits.length)}</p>
          </div>
          <strong className="codex-reset-count">{availableCount === null ? "—" : availableCount}</strong>
        </div>

        {credits.length > 0 ? (
          <div className="codex-reset-list">
            {credits.map((credit) => (
              <div className="codex-reset-row" key={credit.id}>
                <div>
                  <strong>{credit.title ?? "Rate-limit reset"}</strong>
                  {credit.description ? <p>{credit.description}</p> : null}
                  <span>{formatCreditExpiration(credit.expiresAt, now)}</span>
                </div>
                <Button variant="secondary" onClick={() => setSelectedCredit(credit)} disabled={resetBusy || Boolean(pendingAttempt) || credit.status !== "available" || isExpired(credit.expiresAt, now)}>Use token</Button>
              </div>
            ))}
          </div>
        ) : availableCount && availableCount > 0 ? (
          <Button variant="secondary" onClick={() => setSelectedCredit(null)} disabled={resetBusy || Boolean(pendingAttempt)}>Use next token</Button>
        ) : null}

        {pendingAttempt && resetAction === "confirming" ? (
          <p className="codex-reset-result" role="status">Confirming previous reset…</p>
        ) : null}
        {pendingAttempt && resetError && !resetBusy ? (
          <div className="codex-reset-result usage-error" role="alert">
            <span>{resetError} Retry to check the same reset attempt without spending another token.</span>
            <Button variant="secondary" onClick={() => void consumeReset(pendingAttempt, "retrying", false)}>Retry</Button>
          </div>
        ) : null}
        {resetOutcome ? <p className="codex-reset-result" role="status">{resetOutcomeMessage(resetOutcome)}</p> : null}
      </div>

      <div className="codex-history-section">
        <div className="codex-section-head">
          <div>
            <h3>Token activity</h3>
            <p>Daily account token usage</p>
          </div>
        </div>
        <CodexTokenUsageChart history={history} loading={historyLoading} />
      </div>

      {summary ? (
        <div className="usage-stats">
          <span>{formatCodexRefresh(summary.refreshedAt)}</span>
          {history?.summary?.lifetimeTokens === null || history?.summary?.lifetimeTokens === undefined ? null : <span>{formatNumber(history.summary.lifetimeTokens)} lifetime tokens</span>}
          {summary.available ? null : <span>Unavailable</span>}
        </div>
      ) : null}
      {refreshError || historyRefreshError ? <p className="usage-note usage-error" role="alert">{refreshError ?? historyRefreshError}</p> : null}

      {selectedCredit !== undefined ? (
        <Modal open title="Use usage reset token?" onClose={() => setSelectedCredit(undefined)} dismissible={!resetBusy} panelClassName="codex-reset-dialog">
          <p>This consumes one reset token and resets the eligible Codex usage window selected by Codex.</p>
          {selectedCredit ? <p className="dialog-help">{selectedCredit.title ?? "Rate-limit reset"} · {formatCreditExpiration(selectedCredit.expiresAt, now)}</p> : null}
          <DialogActions>
            <Button variant="ghost" onClick={() => setSelectedCredit(undefined)} disabled={resetBusy}>Cancel</Button>
            <Button variant="primary" onClick={confirmReset} disabled={resetBusy} busy={resetBusy} busyLabel="Using token">Use reset token</Button>
          </DialogActions>
        </Modal>
      ) : null}
    </section>
  );
}

function CodexLimitRow({ label, limit, loading }: { label: string; limit: CodexUsageLimit | null; loading: boolean }) {
  const remainingPercent = limit?.remainingPercent ?? 0;
  return (
    <div className="codex-limit-row">
      <div className="codex-limit-meta">
        <span>{label}</span>
        <span>{loading ? "loading" : limit?.remainingPercent === null || !limit ? "unavailable" : `${Math.round(limit.remainingPercent)}% remaining`}</span>
      </div>
      <div className="codex-limit-track" aria-label={`${label} usage`}>
        <div className="codex-limit-fill" style={{ width: `${Math.max(0, Math.min(100, remainingPercent))}%` }} />
      </div>
      <div className="codex-limit-foot">
        <span>{limit?.remainingPercent === null || !limit ? "" : `${Math.round(limit.remainingPercent)}% remaining`}</span>
        <span>{limit?.resetsAt ? `Resets ${formatTimestamp(limit.resetsAt)}` : ""}</span>
      </div>
    </div>
  );
}

function CodexTokenUsageChart({ history, loading }: { history: CodexTokenUsageResponse | null; loading: boolean }) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const points = history?.points ?? null;
  if (loading && !history) return <div className="codex-history-empty">Loading token activity…</div>;
  if (!history?.available) return <div className="codex-history-empty">{history?.error ?? "Token activity is unavailable."}</div>;
  if (points === null) return <div className="codex-history-empty">Daily token activity is unavailable for this account.</div>;
  if (points.length === 0) return <div className="codex-history-empty">No daily token activity was returned.</div>;
  const max = Math.max(...points.map((point) => point.tokens), 1);
  const activePoint = points.find((point) => point.date === activeDate) ?? null;
  return (
    <>
      <div className="codex-token-chart" role="group" aria-label={`Codex token activity over ${history.days} days`}>
        {points.map((point) => (
          <CodexTokenBar key={point.date} point={point} max={max} onActivate={() => setActiveDate(point.date)} />
        ))}
      </div>
      {activePoint ? <div className="codex-token-chart-detail" role="status">{formatDate(activePoint.date)} · {formatNumber(activePoint.tokens)} tokens</div> : null}
    </>
  );
}

function CodexTokenBar({ point, max, onActivate }: { point: CodexTokenUsageDailyPoint; max: number; onActivate: () => void }) {
  const label = `${formatDate(point.date)}: ${formatNumber(point.tokens)} tokens`;
  return (
    <button
      className="codex-token-bar"
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

function resetCreditsDescription(summary: CodexUsageSummaryResponse | null, detailCount: number): string {
  if (!summary) return "Loading reset tokens";
  if (!summary.available) return "Reset-token data is unavailable";
  const resetCredits = summary.resetCredits;
  if (!resetCredits) return "Reset tokens are not available for this account";
  if (resetCredits.availableCount === 0) return "No reset tokens available";
  if (resetCredits.credits === null) return `${resetCredits.availableCount} available; individual expiration details were not returned`;
  if (detailCount < resetCredits.availableCount) return `${resetCredits.availableCount} available; showing ${detailCount} with expiration details`;
  return `${resetCredits.availableCount} available`;
}

function resetOutcomeMessage(outcome: ConsumeCodexResetCreditOutcome): string {
  if (outcome === "reset") return "Reset token redeemed. Confirming updated account limits…";
  if (outcome === "alreadyRedeemed") return "This reset attempt was already completed. Confirming updated account limits…";
  if (outcome === "nothingToReset") return "No eligible usage limit currently needs resetting.";
  return "No reset token is available for this account.";
}

function formatCreditExpiration(value: number | null, now: number): string {
  if (value === null) return "Does not expire";
  const expiresAt = timestampMillis(value);
  const remaining = expiresAt - now;
  if (remaining <= 0) return `Expired ${new Date(expiresAt).toLocaleString()}`;
  const minutes = Math.ceil(remaining / 60_000);
  const relative = minutes < 60 ? `${minutes}m` : minutes < 1_440 ? `${Math.ceil(minutes / 60)}h` : `${Math.ceil(minutes / 1_440)}d`;
  return `Expires ${new Date(expiresAt).toLocaleString()} (${relative} remaining)`;
}

function formatTimestamp(value: number): string {
  return new Date(timestampMillis(value)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function timestampMillis(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function expirationSortValue(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : timestampMillis(value);
}

function isExpired(value: number | null, now: number): boolean {
  return value !== null && timestampMillis(value) <= now;
}

function formatCodexAccount(summary: CodexUsageSummaryResponse): string {
  if (!summary.account) return "Not signed in";
  if (summary.account.kind === "chatgpt") return summary.account.email ?? "ChatGPT";
  if (summary.account.kind === "apiKey") return "API key";
  if (summary.account.kind === "amazonBedrock") return "Amazon Bedrock";
  return "Unknown account";
}

function formatCodexRefresh(value: string): string {
  return `Updated ${new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function createIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
