import { useEffect, useMemo, useState } from "react";
import type { CodexRateLimitResetCredit, ConsumeCodexResetCreditOutcome, ProviderUsageSummary } from "@muxpilot/core";
import type { ResetCreditsMonitor, ResetObservation } from "../hooks/useResetCredits.js";
import { Button, DialogActions } from "./Button.js";
import { Modal } from "./Modal.js";

/** Codex rate-limit reset tokens: listing, confirmation and the redemption status line. */
export function CodexResetCreditsSection({
  summary,
  stale,
  resetCredits
}: {
  summary: ProviderUsageSummary | null;
  stale: boolean;
  resetCredits: ResetCreditsMonitor;
}) {
  const [selectedCredit, setSelectedCredit] = useState<CodexRateLimitResetCredit | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const { pendingAttempt, resetAction, resetError, resetOutcome, resetObservation, consumeReset } = resetCredits;
  const resetBusy = resetAction !== null;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const credits = useMemo(
    () => [...(summary?.resetCredits?.credits ?? [])].sort((left, right) => expirationSortValue(left.expiresAt) - expirationSortValue(right.expiresAt)),
    [summary?.resetCredits?.credits]
  );
  const availableCount = summary?.resetCredits?.availableCount ?? null;

  function confirmReset() {
    if (stale) return;
    const attempt = {
      idempotencyKey: createIdempotencyKey(),
      creditId: selectedCredit?.id ?? null,
      recoveryAttempted: false
    };
    setSelectedCredit(undefined);
    void consumeReset(attempt, "using");
  }

  return (
    <div className="codex-reset-section">
      <div className="usage-section-head">
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
              <Button variant="secondary" onClick={() => setSelectedCredit(credit)} disabled={stale || resetBusy || Boolean(pendingAttempt) || credit.status !== "available" || isExpired(credit.expiresAt, now)}>Use token</Button>
            </div>
          ))}
        </div>
      ) : availableCount && availableCount > 0 ? (
        <Button variant="secondary" onClick={() => setSelectedCredit(null)} disabled={stale || resetBusy || Boolean(pendingAttempt)}>Use next token</Button>
      ) : null}

      {pendingAttempt && resetAction && !resetOutcome ? (
        <p className="codex-reset-result" role="status">{resetAction === "using" ? "Using reset token…" : "Confirming reset…"}</p>
      ) : null}
      {resetError && !resetBusy ? (
        <div className="codex-reset-result usage-error" role="alert">
          <span>{resetError}{pendingAttempt ? " Retry to check the same reset attempt without spending another token." : ""}</span>
          {pendingAttempt ? <Button variant="secondary" onClick={() => void consumeReset(pendingAttempt, "retrying", false)}>Retry</Button> : null}
        </div>
      ) : null}
      {resetOutcome ? <p className="codex-reset-result" role="status">{resetOutcomeMessage(resetOutcome, resetObservation)}</p> : null}

      {selectedCredit !== undefined ? (
        <Modal open title="Use usage reset token?" onClose={() => setSelectedCredit(undefined)} dismissible={!resetBusy} panelClassName="codex-reset-dialog">
          <p>This consumes one reset token and resets the eligible Codex usage window selected by Codex.</p>
          {selectedCredit ? <p className="dialog-help">{selectedCredit.title ?? "Rate-limit reset"} · {formatCreditExpiration(selectedCredit.expiresAt, now)}</p> : null}
          <DialogActions>
            <Button variant="ghost" onClick={() => setSelectedCredit(undefined)} disabled={resetBusy}>Cancel</Button>
            <Button variant="primary" onClick={confirmReset} disabled={stale || resetBusy} busy={resetBusy} busyLabel="Using token">Use reset token</Button>
          </DialogActions>
        </Modal>
      ) : null}
    </div>
  );
}

function resetCreditsDescription(summary: ProviderUsageSummary | null, detailCount: number): string {
  if (!summary) return "Loading reset tokens";
  if (!summary.available) return "Reset-token data is unavailable";
  const resetCredits = summary.resetCredits;
  if (!resetCredits) return "Reset tokens are not available for this account";
  if (resetCredits.availableCount === 0) return "No reset tokens available";
  if (resetCredits.credits === null) return `${resetCredits.availableCount} available; individual expiration details were not returned`;
  if (detailCount < resetCredits.availableCount) return `${resetCredits.availableCount} available; showing ${detailCount} with expiration details`;
  return `${resetCredits.availableCount} available`;
}

function resetOutcomeMessage(outcome: ConsumeCodexResetCreditOutcome, observation: ResetObservation | null): string {
  if (outcome === "reset" || outcome === "alreadyRedeemed") {
    if (observation === "confirmed") return "Reset complete. Updated account limits are shown.";
    if (observation === "refreshed") return "Reset complete. Account limits refreshed.";
    if (observation === "delayed") return "Reset token redeemed. Updated limits are still catching up.";
    return "Reset token redeemed. Confirming updated account limits…";
  }
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

export function timestampMillis(value: number): number {
  return value < 10_000_000_000 ? value * 1000 : value;
}

function expirationSortValue(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : timestampMillis(value);
}

function isExpired(value: number | null, now: number): boolean {
  return value !== null && timestampMillis(value) <= now;
}

function createIdempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
