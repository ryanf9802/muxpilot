import { createHash } from "node:crypto";

/**
 * Stable 24-hex identity for a session runtime. It names the systemd unit and private socket/journal
 * directories, so it must stay unchanged for existing sessions across upgrades.
 */
export function sessionRuntimeCapabilityId(sessionId: string, namespace = "default"): string {
  if (!sessionId.trim()) throw new Error("App-server session id must not be empty");
  if (!namespace.trim()) throw new Error("App-server capability namespace must not be empty");
  const prefix = namespace === "default" ? "muxpilot-app-server" : `muxpilot-app-server:${namespace}`;
  return createHash("sha256").update(`${prefix}:${sessionId}`).digest("hex").slice(0, 24);
}
