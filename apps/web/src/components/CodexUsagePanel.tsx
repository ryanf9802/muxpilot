import { RefreshCw } from "lucide-react";
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
import { Button, DialogActions } from "./Button.js";
import { Modal } from "./Modal.js";

const PENDING_RESET_KEY = "muxpilot.codex-usage.pending-reset.v1";
const CODEX_USAGE_RECONCILE_INTERVAL_MS = 60_000;

interface PendingResetAttempt {
  idempotencyKey: string;
  creditId: string | null;
}

export function CodexUsagePanel({
  summary,
  onSummaryChange,
  onRefreshSummary
}: {
  summary: CodexUsageSummaryResponse | null;
  onSummaryChange?: (summary: CodexUsageSummaryResponse) => void;
  onRefreshSummary?: () => Promise<void>;
}) {
  const [historyDays, setHistoryDays] = useState<7 | 30>(30);
  const [history, setHistory] = useState<CodexTokenUsageResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [selectedCredit, setSelectedCredit] = useState<CodexRateLimitResetCredit | null | undefined>(undefined);
  const [pendingAttempt, setPendingAttempt] = useState<PendingResetAttempt | null>(() => loadPendingResetAttempt());
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetOutcome, setResetOutcome] = useState<ConsumeCodexResetCreditOutcome | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const historyRequestIdRef = useRef(0);
  const accountLabel = summary ? formatCodexAccount(summary) : "loading";
  const planLabel = summary?.account?.planType ? summary.account.planType : null;

  const loadHistory = useCallback(async (days: 7 | 30, refresh = false) => {
    const requestId = ++historyRequestIdRef.current;
    setHistoryLoading(true);
    try {
      const nextHistory = await api.codexUsageHistory(days, refresh);
      if (requestId === historyRequestIdRef.current) setHistory(nextHistory);
    } catch (error) {
      if (requestId === historyRequestIdRef.current) {
        setHistory({
          available: false,
          error: error instanceof Error ? error.message : "Codex token usage is unavailable.",
          refreshedAt: new Date().toISOString(),
          days,
          summary: null,
          points: null
        });
      }
    } finally {
      if (requestId === historyRequestIdRef.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory(historyDays);
    const timer = window.setInterval(() => void loadHistory(historyDays), CODEX_USAGE_RECONCILE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [historyDays, loadHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (pendingAttempt) setResetError((current) => current ?? "A previous reset attempt did not receive a confirmed result.");
  }, [pendingAttempt]);

  async function refreshAll() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await Promise.all([onRefreshSummary?.(), loadHistory(historyDays, true)]);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Codex usage could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }

  async function consumeReset(attempt: PendingResetAttempt) {
    setResetBusy(true);
    setResetError(null);
    setResetOutcome(null);
    setPendingAttempt(attempt);
    savePendingResetAttempt(attempt);
    try {
      const response = await api.consumeCodexResetCredit({
        idempotencyKey: attempt.idempotencyKey,
        creditId: attempt.creditId
      });
      clearPendingResetAttempt();
      setPendingAttempt(null);
      setSelectedCredit(undefined);
      setResetOutcome(response.outcome);
      onSummaryChange?.(response.summary);
      await loadHistory(historyDays, true);
    } catch (error) {
      setSelectedCredit(undefined);
      setResetError(error instanceof Error ? error.message : "The reset attempt could not be confirmed.");
    } finally {
      setResetBusy(false);
    }
  }

  function confirmReset() {
    const attempt = {
      idempotencyKey: createIdempotencyKey(),
      creditId: selectedCredit?.id ?? null
    };
    void consumeReset(attempt);
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
          <button className="usage-refresh-button" type="button" onClick={() => void refreshAll()} disabled={refreshing} aria-label="Refresh Codex usage" title="Refresh Codex usage">
            <RefreshCw size={15} className={refreshing ? "spin" : undefined} />
          </button>
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

        {pendingAttempt && resetError ? (
          <div className="codex-reset-result usage-error" role="alert">
            <span>{resetError} Retry to check the same reset attempt without spending another token.</span>
            <Button variant="secondary" onClick={() => void consumeReset(pendingAttempt)} disabled={resetBusy} busy={resetBusy} busyLabel="Retrying">Retry</Button>
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
          <div className="codex-history-range" aria-label="Usage history range">
            {([7, 30] as const).map((days) => (
              <button type="button" key={days} className={historyDays === days ? "active" : undefined} aria-pressed={historyDays === days} onClick={() => setHistoryDays(days)}>{days}d</button>
            ))}
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
      {refreshError ? <p className="usage-note usage-error" role="alert">{refreshError}</p> : null}

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
  if (outcome === "reset") return "Usage limit reset. Account limits and reset tokens have been refreshed.";
  if (outcome === "alreadyRedeemed") return "This reset attempt was already completed. Account limits have been refreshed.";
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

function loadPendingResetAttempt(): PendingResetAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(PENDING_RESET_KEY) ?? "null") as Partial<PendingResetAttempt> | null;
    return value && typeof value.idempotencyKey === "string" && (typeof value.creditId === "string" || value.creditId === null)
      ? { idempotencyKey: value.idempotencyKey, creditId: value.creditId }
      : null;
  } catch {
    return null;
  }
}

function savePendingResetAttempt(attempt: PendingResetAttempt): void {
  try {
    window.localStorage.setItem(PENDING_RESET_KEY, JSON.stringify(attempt));
  } catch {
    // Redemption remains safe in-memory when storage is unavailable.
  }
}

function clearPendingResetAttempt(): void {
  try {
    window.localStorage.removeItem(PENDING_RESET_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}
