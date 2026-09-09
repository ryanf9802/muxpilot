import type { ManagedSession } from "@muxpilot/core";

export function sessionDisplayName(session: ManagedSession, sessions: ManagedSession[] = [session]): string {
  const baseName = sessionBaseName(session);
  if (!isAmbiguousSessionName(session, sessions, baseName)) return baseName;
  return `${baseName} · ${sessionIdentitySuffix(session)}`;
}

export function sessionBaseName(session: ManagedSession): string {
  return session.name.trim() || "session";
}

function isAmbiguousSessionName(session: ManagedSession, sessions: ManagedSession[], baseName: string): boolean {
  return sessions.some((candidate) => candidate.id !== session.id && sessionBaseName(candidate) === baseName);
}

function sessionIdentitySuffix(session: ManagedSession): string {
  return session.id.slice(0, 8);
}
