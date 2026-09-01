import { describe, expect, it } from "vitest";
import { managedSessionCwd, managedSessionName, normalizeManagedSessionRuntime } from "./sessionRuntime.js";
import type { ManagedSession } from "./types.js";

function legacySession(): ManagedSession {
  return {
    id: "legacy-1",
    tmux: {
      sessionId: "tmux-1", sessionName: "work", windowId: "@1", windowIndex: 1,
      windowName: "codex", paneId: "%1", paneIndex: 0, paneActive: true,
      cwd: "/repo", currentCommand: "codex", title: "codex", pid: 123, size: "120x40"
    },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1", codexJsonlPath: "/rollout.jsonl", discoveryConfidence: "high",
    status: "waiting", lastActivityAt: null, preview: "", recentUserPrompts: [],
    activitySummary: null, activitySummaryGeneratedAt: null, activitySummarySourceSequence: null,
    inputMode: "default", models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0, unreadCount: 0, pinned: false, archived: false
  };
}

describe("session runtime compatibility", () => {
  it("normalizes legacy tmux records without removing legacy fields", () => {
    const legacy = { ...legacySession(), resourceScope: "muxpilot-session.scope" };
    const normalized = normalizeManagedSessionRuntime(legacy);

    expect(normalized).toMatchObject({
      name: "codex",
      cwd: "/repo",
      provider: { kind: "codex", threadId: "thread-1", rolloutPath: "/rollout.jsonl" },
      driverKind: "codex_tmux",
      runtime: { kind: "tmux", pane: legacy.tmux },
      capabilities: { verifiedInput: true, terminalAttach: true, hibernate: false },
      resourceUnit: "muxpilot-session.scope",
      tmux: legacy.tmux
    });
  });

  it("preserves explicit app-server metadata and stable display fields", () => {
    const session = {
      ...legacySession(),
      name: "Feature work",
      cwd: "/repo/worktree",
      driverKind: "codex_app_server" as const,
      runtime: {
        kind: "app_server" as const,
        serviceUnit: "muxpilot-session-1.service",
        socketPath: "/run/user/1000/muxpilot/1.sock",
        journalPath: "/state/1/events.jsonl",
        protocolVersion: "1"
      }
    };

    expect(managedSessionName(session)).toBe("Feature work");
    expect(managedSessionCwd(session)).toBe("/repo/worktree");
    expect(normalizeManagedSessionRuntime(session).driverKind).toBe("codex_app_server");
  });
});
