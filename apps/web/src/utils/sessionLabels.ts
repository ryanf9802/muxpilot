import type { ManagedSession } from "@muxpilot/core";

const GENERIC_TMUX_WINDOW_NAMES = new Set(["node"]);

export function sessionDisplayName(session: ManagedSession, sessions: ManagedSession[] = [session]): string {
  const baseName = sessionBaseName(session);
  if (!isAmbiguousSessionName(session, sessions, baseName)) return baseName;
  return `${baseName} · ${sessionIdentitySuffix(session)}`;
}

export function sessionBaseName(session: ManagedSession): string {
  return session.tmux.windowName.trim() || session.tmux.sessionName.trim() || "session";
}

function isAmbiguousSessionName(session: ManagedSession, sessions: ManagedSession[], baseName: string): boolean {
  if (GENERIC_TMUX_WINDOW_NAMES.has(baseName.toLowerCase())) return true;
  return sessions.some((candidate) => candidate.id !== session.id && sessionBaseName(candidate) === baseName);
}

function sessionIdentitySuffix(session: ManagedSession): string {
  return `${session.tmux.sessionName}:${session.tmux.windowIndex}.${session.tmux.paneIndex} ${session.tmux.paneId}`;
}
