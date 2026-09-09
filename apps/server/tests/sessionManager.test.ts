import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { StoredGitWorkspace } from "../src/db/database.js";
import { latestCodexFastModeFromText, normalizeRepositoryApprovalPrefix, sessionChanged, SessionManager } from "../src/services/sessionManager.js";

describe("SessionManager app-server helpers", () => {
  it("resumes an agent wait only when ready without queueing the wake", async () => {
    const session = managedSession();
    const sendMessage = vi.fn(async () => undefined);
    const db = {
      getSession: vi.fn(async () => session),
      listQueuedInputs: vi.fn(async () => []),
      setSessionStatus: vi.fn(async () => undefined),
      addAudit: vi.fn(async () => undefined)
    };
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db,
      deliveringInputSessionIds: new Set(),
      processingQueuedSessionIds: new Set(),
      serializeRuntimeOperation: async (_id: string, operation: () => Promise<boolean>) => operation(),
      appServerDriver: () => ({ sendMessage }),
      publish: vi.fn(),
      sendInput: vi.fn(() => { throw new Error("Wake must not use the input queue"); })
    }) as SessionManager;
    session.status = "working";
    expect(await manager.resumeAgentWait(session.id, "wake")).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    session.status = "waiting";
    expect(await manager.resumeAgentWait(session.id, "wake")).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(session, "wake", expect.any(String));
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("detects session discovery changes from canonical runtime fields", () => {
    const session = managedSession();
    expect(sessionChanged(session, { ...session, runtime: { ...session.runtime!, state: "hibernated" } })).toBe(true);
    expect(sessionChanged(session, { ...session })).toBe(false);
  });

  it("reads the latest structured Fast mode setting", () => {
    const text = [
      JSON.stringify({ payload: { type: "thread_settings_applied", thread_settings: { service_tier: "default" } } }),
      JSON.stringify({ payload: { type: "thread_settings_applied", thread_settings: { service_tier: "fast" } } })
    ].join("\n");
    expect(latestCodexFastModeFromText(text)).toBe(true);
  });

  it("normalizes repository approval paths to the managed worktree token", () => {
    const workspace = { summary: { worktreePath: "/worktrees/task" }, implementationRoot: "/worktrees" } as StoredGitWorkspace;
    expect(normalizeRepositoryApprovalPrefix(["git", "-C", "/worktrees/task", "status"], workspace))
      .toEqual(["git", "-C", "$MUXPILOT_WORKTREE", "status"]);
  });

  it("reconciles managed Git targets without live runtime or rollout activity", async () => {
    const hibernated = managedSession();
    hibernated.codexSessionId = null;
    hibernated.codexJsonlPath = null;
    hibernated.runtime = { ...hibernated.runtime!, state: "hibernated" };
    hibernated.gitWorkspace = gitWorkspace("dev", "workspace-1");
    const unchangedRollout = {
      ...managedSession(),
      id: "session-2",
      gitWorkspace: gitWorkspace("dev", "workspace-2")
    };
    const sessions = new Map([hibernated, unchangedRollout].map((session) => [session.id, session]));
    const setSessionGitWorkspace = vi.fn(async (sessionId: string, workspace: NonNullable<ManagedSession["gitWorkspace"]>) => {
      const current = sessions.get(sessionId)!;
      const updated = { ...current, gitWorkspace: workspace, repo: { ...current.repo, branch: workspace.targetBranch } };
      sessions.set(sessionId, updated);
      return updated;
    });
    const publish = vi.fn();
    const listSessions = vi.fn(async () => [...sessions.values()]);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: { listSessions, setSessionGitWorkspace },
      codexStore: {
        listRecent: vi.fn(async () => [{
          sessionId: "thread-1",
          path: "/codex/rollout.jsonl",
          cwd: "/repo",
          startedAtMs: 1,
          updatedAtMs: 2,
          sizeBytes: 3,
          cliVersion: "0.152.0"
        }])
      },
      gitWorkspaces: {
        getBySession: vi.fn(async (sessionId: string) => ({ summary: sessions.get(sessionId)!.gitWorkspace })),
        refresh: vi.fn(async (stored: { summary: NonNullable<ManagedSession["gitWorkspace"]> }) => ({
          summary: gitWorkspace("feature/current-target", stored.summary.id)
        }))
      },
      publish,
      recoveryRunId: null
    }) as SessionManager;

    await manager.discover();
    await manager.discover();

    expect(setSessionGitWorkspace).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenCalledWith(false, false);
    expect([...sessions.values()].map((session) => ({
      id: session.id,
      runtime: session.runtime?.state,
      target: session.gitWorkspace?.targetBranch,
      branch: session.repo.branch
    }))).toEqual([
      { id: "session-1", runtime: "hibernated", target: "feature/current-target", branch: "feature/current-target" },
      { id: "session-2", runtime: "connected", target: "feature/current-target", branch: "feature/current-target" }
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("session.updated", "session-1", sessions.get("session-1"));
  });
});

function gitWorkspace(targetBranch: string, id: string): NonNullable<ManagedSession["gitWorkspace"]> {
  return {
    workflowVersion: 1,
    id,
    state: "idle",
    entryPath: "/repo",
    repoRoot: "/repo",
    targetBranch,
    targetSha: "abcdef1234567890",
    sessionBranch: null,
    worktreePath: null,
    lastError: null,
    updatedAt: "2026-09-09T11:00:00.000Z",
    dependencyLinks: []
  };
}

function managedSession(): ManagedSession {
  return {
    id: "session-1",
    name: "work",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: "/codex/rollout.jsonl" },
    runtime: { kind: "systemd_service", unit: "muxpilot-session-0123456789abcdef01234567.service", socketPath: "/run/user/1000/muxpilot/session.sock", state: "connected", codexVersion: "0.152.0" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: "/codex/rollout.jsonl",
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}
