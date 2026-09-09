import type { ManagedSession } from "./types.js";

interface LegacySessionFields {
  name?: string;
  cwd?: string;
  driverKind?: string;
  tmux?: { windowName?: string; sessionName?: string; cwd?: string };
  runtime?: { kind?: string };
}

/** Adds the provider-neutral runtime contract to persisted pre-runtime sessions. */
export function normalizeManagedSessionRuntime(session: ManagedSession): ManagedSession {
  const legacy = session as ManagedSession & LegacySessionFields;
  const name = legacy.name?.trim()
    || legacy.tmux?.windowName?.trim()
    || legacy.tmux?.sessionName?.trim()
    || session.repo.name?.trim()
    || session.id;
  const cwd = legacy.cwd?.trim() || legacy.tmux?.cwd?.trim() || session.repo.root || ".";
  const provider = session.provider ?? {
    kind: "codex" as const,
    threadId: session.codexSessionId,
    rolloutPath: session.codexJsonlPath
  };
  const runtime = legacy.runtime?.kind === "systemd_service" ? session.runtime : undefined;
  const normalized = { ...session, name, cwd, provider, runtime } as ManagedSession & LegacySessionFields;
  delete normalized.tmux;
  delete normalized.driverKind;

  return {
    ...normalized,
    resourceUnit: session.resourceUnit ?? session.resourceScope ?? null
  };
}

export function managedSessionName(session: ManagedSession): string {
  return normalizeManagedSessionRuntime(session).name;
}

export function managedSessionCwd(session: ManagedSession): string {
  return normalizeManagedSessionRuntime(session).cwd;
}
