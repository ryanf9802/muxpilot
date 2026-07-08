import type { SessionStatus } from "@muxpilot/core";
import { sessionStatusSeverity } from "../utils/sessionStatus.js";

export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`status status-${sessionStatusSeverity(status)}`}>{statusLabel(status)}</span>;
}

function statusLabel(status: SessionStatus): string {
  if (status === "executing" || status === "generating") return "working";
  if (status === "plan_ready") return "plan ready";
  return status;
}
