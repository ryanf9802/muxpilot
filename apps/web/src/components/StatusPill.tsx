import type { SessionStatus } from "@muxpilot/core";
import { sessionStatusSeverity } from "../utils/sessionStatus.js";

export function StatusPill({ status }: { status: SessionStatus }) {
  const label = statusLabel(status);
  return (
    <span className={`status status-${sessionStatusSeverity(status)}`} aria-label={label} title={label}>
      <span className="status-text">{label}</span>
    </span>
  );
}

export function LoadingStatusPill() {
  return (
    <span className="status status-loading" aria-label="loading" title="loading">
      <span className="status-text">loading</span>
    </span>
  );
}

function statusLabel(status: SessionStatus): string {
  if (status === "executing" || status === "generating") return "working";
  if (status === "plan_ready") return "plan ready";
  return status;
}
