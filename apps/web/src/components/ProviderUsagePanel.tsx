import type { AgentProviderKind, ProviderDescriptor, ProviderUsageLimit, ProviderUsageSummary } from "@muxpilot/core";
import type { ResetCreditsMonitor } from "../hooks/useResetCredits.js";
import { formatUsageAccount, providerLabel } from "../utils/providers.js";
import { CodexResetCreditsSection, timestampMillis } from "./CodexResetCreditsSection.js";
import { ProviderAuthCallout, ProviderAuthStatus } from "./ProviderAuth.js";
import { ProviderBadge } from "./ProviderBadge.js";
import { formatNumber, TokenUsageChart, useTokenUsageHistory } from "./TokenUsageChart.js";

export function ProviderUsagePanel({
  provider,
  descriptor = null,
  summary,
  refreshError,
  resetCredits = null,
  onCheckAuth
}: {
  provider: AgentProviderKind;
  descriptor?: ProviderDescriptor | null;
  summary: ProviderUsageSummary | null;
  refreshError: string | null;
  resetCredits?: ResetCreditsMonitor | null;
  onCheckAuth?: () => Promise<unknown>;
}) {
  const label = descriptor?.displayName || providerLabel(provider);
  const showResetCredits = Boolean(resetCredits) && (descriptor?.capabilities.resetCredits ?? provider === "codex");
  const showTokenHistory = descriptor?.capabilities.tokenUsageHistory ?? true;
  const { history, loading: historyLoading, refreshError: historyRefreshError } = useTokenUsageHistory(provider, showTokenHistory, resetCredits?.resetRevision ?? 0);
  const stale = Boolean(refreshError) || Boolean(summary && !summary.available);
  const accountLabel = summary ? formatUsageAccount(provider, summary.account, summary.accountStatus) : "loading";
  const planLabel = summary?.account?.planType ? summary.account.planType : null;

  return (
    <section className="usage-panel provider-usage-panel" data-provider={provider} aria-label={`${label} usage`}>
      <div className="usage-panel-head">
        <div>
          <h2 className="usage-panel-title">
            <ProviderBadge provider={provider} iconOnly />
            <span>{label} usage</span>
          </h2>
          <p>{stale && summary?.accountStatus !== "signed_out" ? "Unable to refresh; retrying" : summary?.available ? "Account limits" : summary?.error ?? "Account limits"}</p>
        </div>
        <div className="usage-panel-controls">
          <div className="usage-total">
            <strong>{accountLabel}</strong>
            <span>{planLabel ?? (summary ? formatRefresh(summary.refreshedAt) : "loading")}</span>
          </div>
          {descriptor ? <ProviderAuthStatus auth={descriptor.auth} /> : null}
        </div>
      </div>

      {descriptor && descriptor.auth.status !== "ready" ? <ProviderAuthCallout descriptor={descriptor} onCheckAgain={onCheckAuth} /> : null}

      <div className="usage-limit-list">
        {!summary ? <UsageLimitRow label="Account limits" limit={null} loading /> : null}
        {summary?.limits.map((limit) => <UsageLimitRow key={limit.id} label={limit.label} limit={limit} loading={false} />)}
        {summary && summary.limits.length === 0 ? (
          <p className="usage-limit-empty">{summary.available ? "No usage limits were reported for this account." : "Usage limits are unavailable."}</p>
        ) : null}
      </div>

      {showResetCredits && resetCredits ? <CodexResetCreditsSection summary={summary} stale={stale} resetCredits={resetCredits} /> : null}

      {showTokenHistory ? (
        <div className="usage-history-section">
          <div className="usage-section-head">
            <div>
              <h3>Token activity</h3>
              <p>Daily account token usage</p>
            </div>
          </div>
          <TokenUsageChart provider={provider} history={history} loading={historyLoading} />
        </div>
      ) : null}

      {summary ? (
        <div className="usage-stats">
          <span>{formatRefresh(summary.refreshedAt)}</span>
          {history?.summary?.lifetimeTokens === null || history?.summary?.lifetimeTokens === undefined ? null : <span>{formatNumber(history.summary.lifetimeTokens)} lifetime tokens</span>}
          {summary.available ? null : <span>Unavailable</span>}
        </div>
      ) : null}
      {showTokenHistory && historyRefreshError ? <p className="usage-note usage-error" role="alert">{historyRefreshError}</p> : null}
    </section>
  );
}

function UsageLimitRow({ label, limit, loading }: { label: string; limit: ProviderUsageLimit | null; loading: boolean }) {
  const remainingPercent = limit?.remainingPercent ?? 0;
  const known = limit !== null && limit.remainingPercent !== null;
  return (
    <div className="usage-limit-row" data-limit={limit?.id}>
      <div className="usage-limit-meta">
        <span>{label}</span>
        <span>{loading ? "loading" : known ? `${Math.round(limit.remainingPercent!)}% remaining` : "unavailable"}</span>
      </div>
      <div className="usage-limit-track" aria-label={`${label} usage`}>
        <div className="usage-limit-fill" style={{ width: `${Math.max(0, Math.min(100, remainingPercent))}%` }} />
      </div>
      <div className="usage-limit-foot">
        <span>{known ? `${Math.round(limit.remainingPercent!)}% remaining` : ""}</span>
        <span>{limit?.resetsAt ? `Resets ${formatTimestamp(limit.resetsAt)}` : ""}</span>
      </div>
    </div>
  );
}

function formatTimestamp(value: number): string {
  return new Date(timestampMillis(value)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatRefresh(value: string): string {
  return `Updated ${new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
