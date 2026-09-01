import type { ManagedSession, SessionCapabilities } from "./types.js";

const LEGACY_TMUX_CAPABILITIES: SessionCapabilities = {
  start: true,
  resume: true,
  fork: true,
  verifiedInput: true,
  interrupt: true,
  kill: true,
  approvals: true,
  questions: true,
  planActions: true,
  rawTerminalCapture: true,
  terminalAttach: true,
  hibernate: false
};

/** Adds the provider-neutral runtime contract to persisted pre-runtime sessions. */
export function normalizeManagedSessionRuntime(session: ManagedSession): ManagedSession {
  const name = session.name?.trim()
    || session.tmux.windowName?.trim()
    || session.tmux.sessionName?.trim()
    || session.repo.name?.trim()
    || session.id;
  const cwd = session.cwd?.trim() || session.tmux.cwd;
  const provider = session.provider ?? {
    kind: "codex" as const,
    threadId: session.codexSessionId,
    rolloutPath: session.codexJsonlPath
  };
  const runtime = session.runtime ?? { kind: "tmux" as const, pane: session.tmux };

  return {
    ...session,
    name,
    cwd,
    provider,
    driverKind: session.driverKind ?? (runtime.kind === "app_server" ? "codex_app_server" : "codex_tmux"),
    runtime,
    capabilities: session.capabilities ?? { ...LEGACY_TMUX_CAPABILITIES },
    resourceUnit: session.resourceUnit ?? session.resourceScope ?? null
  };
}

export function managedSessionName(session: ManagedSession): string {
  return normalizeManagedSessionRuntime(session).name!;
}

export function managedSessionCwd(session: ManagedSession): string {
  return normalizeManagedSessionRuntime(session).cwd!;
}
