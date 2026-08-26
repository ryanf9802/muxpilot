import type { SessionDisplayStatus } from "@muxpilot/core";
import { sessionStatusSeverity } from "../utils/sessionStatus.js";

export function StatusPill({ status, detail }: { status: SessionDisplayStatus; detail?: string | null }) {
  const label = statusLabel(status);
  const description = detail ? `${label} · ${detail}` : label;
  return (
    <span className={`status status-${sessionStatusSeverity(status)}`} aria-label={description} title={description}>
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

function statusLabel(status: SessionDisplayStatus): string {
  if (status === "executing" || status === "generating") return "working";
  if (status === "plan_ready") return "plan ready";
  if (status === "input_failed") return "input failed";
  if (status === "startup_failed") return "startup failed";
  return status;
}
