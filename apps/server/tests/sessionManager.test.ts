import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { StoredGitWorkspace } from "../src/db/database.js";
import { latestCodexFastModeFromText, managedCodexLaunchOptions, normalizeRepositoryApprovalPrefix, sessionChanged, SessionManager } from "../src/services/sessionManager.js";

describe("SessionManager app-server helpers", () => {
  it("fully approves a pending request once without creating persistent rules", async () => {
    const session = { ...managedSession(), status: "approval" as const, approvalMode: "full" as const };
    const approval = pendingApproval(session.id);
    const resolveApproval = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: { getSession: vi.fn(async () => session), addAudit: vi.fn(async () => undefined) },
      automatedApprovalMessageIds: new Set(),
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval
    }) as SessionManager;

    await manager.handleAutomatedApproval(session.id, approval.messageId);

    expect(resolveApproval).toHaveBeenCalledWith(
      session.id,
      { decision: "approve_once", messageId: approval.messageId },
      { resolvedBy: "full" }
    );
  });

  it("leaves an escalated automatic review for the operator", async () => {
    const session = { ...managedSession(), status: "approval" as const, approvalMode: "auto" as const };
    const approval = pendingApproval(session.id);
    const resolveApproval = vi.fn(async () => undefined);
    const addAudit = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => session),
        getApprovalReviewerSettings: vi.fn(async () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" })),
        addAudit
      },
      approvalReviewer: { review: vi.fn(async () => ({ decision: "escalate", explanation: "High impact" })) },
      automatedApprovalMessageIds: new Set(),
      recordApprovalReview: vi.fn(async () => undefined),
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval
    }) as SessionManager;

    await manager.handleAutomatedApproval(session.id, approval.messageId);

    expect(resolveApproval).not.toHaveBeenCalled();
    expect(addAudit).toHaveBeenCalledWith("local", "approval_review_escalated", session.id, expect.stringContaining("High impact"), expect.any(String));
  });

  it("discards an automatic decision after the session returns to Ask mode", async () => {
    const session = { ...managedSession(), status: "approval" as const, approvalMode: "auto" as const };
    const approval = pendingApproval(session.id);
    const resolveApproval = vi.fn(async () => undefined);
    const getSession = vi.fn()
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({ ...session, approvalMode: "ask" });
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession,
        getApprovalReviewerSettings: vi.fn(async () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" })),
        addAudit: vi.fn(async () => undefined)
      },
      approvalReviewer: { review: vi.fn(async () => ({ decision: "approve", explanation: "In scope" })) },
      automatedApprovalMessageIds: new Set(),
      recordApprovalReview: vi.fn(async () => undefined),
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval
    }) as SessionManager;

    await manager.handleAutomatedApproval(session.id, approval.messageId);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("submits automatic deny decisions with reviewer provenance", async () => {
    const session = { ...managedSession(), status: "approval" as const, approvalMode: "auto" as const };
    const approval = pendingApproval(session.id);
    const resolveApproval = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => session),
        getApprovalReviewerSettings: vi.fn(async () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" })),
        addAudit: vi.fn(async () => undefined)
      },
      approvalReviewer: { review: vi.fn(async () => ({ decision: "deny", explanation: "Unrelated to the task" })) },
      automatedApprovalMessageIds: new Set(),
      recordApprovalReview: vi.fn(async () => undefined),
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval
    }) as SessionManager;

    await manager.handleAutomatedApproval(session.id, approval.messageId);

    expect(resolveApproval).toHaveBeenCalledWith(
      session.id,
      { decision: "deny", messageId: approval.messageId },
      { resolvedBy: "auto", reviewerModel: "gpt-5.6-luna", reviewerExplanation: "Unrelated to the task" }
    );
  });

  it("escalates reviewer failures and suppresses duplicate concurrent reviews", async () => {
    const session = { ...managedSession(), status: "approval" as const, approvalMode: "auto" as const };
    const approval = pendingApproval(session.id);
    let rejectReview!: (error: Error) => void;
    const review = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectReview = reject; }));
    const recordApprovalReview = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => session),
        getApprovalReviewerSettings: vi.fn(async () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" })),
        addAudit: vi.fn(async () => undefined)
      },
      approvalReviewer: { review },
      automatedApprovalMessageIds: new Set(),
      recordApprovalReview,
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval: vi.fn(async () => undefined)
    }) as SessionManager;

    const first = manager.handleAutomatedApproval(session.id, approval.messageId);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    await manager.handleAutomatedApproval(session.id, approval.messageId);
    rejectReview(new Error("reviewer unavailable"));
    await first;

    expect(review).toHaveBeenCalledOnce();
    expect(recordApprovalReview).toHaveBeenLastCalledWith(
      session.id,
      approval.messageId,
      "escalated",
      "gpt-5.6-luna",
      "reviewer unavailable"
    );
  });

  it("recovers unresolved automatic approvals without touching Ask sessions", async () => {
    const automatic = { ...managedSession(), id: "auto", status: "approval" as const, approvalMode: "auto" as const };
    const manual = { ...managedSession(), id: "ask", status: "approval" as const, approvalMode: "ask" as const };
    const approval = pendingApproval(automatic.id);
    const handleAutomatedApproval = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: { listSessions: vi.fn(async () => [automatic, manual]) },
      getPendingApproval: vi.fn(async () => approval),
      handleAutomatedApproval
    }) as SessionManager;

    await manager.recoverAutomatedApprovals();
    await vi.waitFor(() => expect(handleAutomatedApproval).toHaveBeenCalledWith(automatic.id, approval.messageId));
    expect(handleAutomatedApproval).toHaveBeenCalledOnce();
  });

  it("rejects a stale plan action when a newer plan is pending", async () => {
    const session = managedSession();
    const plan = {
      id: "current-plan",
      sessionId: session.id,
      sequence: 2,
      type: "assistant",
      role: "assistant",
      timestamp: "2026-09-01T00:00:02.000Z",
      text: "<proposed_plan>\nCurrent\n</proposed_plan>",
      payload: {}
    } as const;
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => session),
        latestPlanReadyMessage: vi.fn(async () => plan)
      },
      requireAppServerDriver: () => ({})
    }) as SessionManager;

    await expect(manager.act(session.id, {
      type: "choosePlanAction",
      action: "implement",
      messageId: "stale-plan"
    } as Parameters<SessionManager["act"]>[1])).rejects.toThrow("proposed plan changed");
  });

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

  it("instructs managed Git sessions to honor repository build gates", () => {
    const workspace = {
      summary: gitWorkspace("feature/current-target", "workspace-1"),
      implementationRoot: "/worktrees",
      controlPath: "/sessions/workspace-1",
      commonGitDir: "/repo/.git"
    } as StoredGitWorkspace;
    const instructions = managedCodexLaunchOptions(workspace, "/codex", "/worktrees").developerInstructions;

    expect(instructions).toContain("run any full build required by repository guidance");
    expect(instructions).toContain("Repository-required builds are authorized validation");
    expect(instructions).toContain("Run other repository-wide scans or test suites only when the user explicitly requests them");
    expect(instructions).toContain("Report the integrated commit and the focused checks and repository-required build that succeeded");
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
    approvalMode: "ask",
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    pinned: false,
    archived: false
  };
}

function pendingApproval(sessionId: string) {
  return {
    id: "approval-1",
    requestId: 1,
    sessionId,
    messageId: "message-1",
    kind: "command" as const,
    title: "Run command",
    command: "git status",
    toolName: null,
    cwd: "/repo",
    reason: "Inspect state",
    prefixRule: null,
    options: [
      { decision: "approve_once" as const, label: "Approve once", description: "" },
      { decision: "deny" as const, label: "Deny", description: "" }
    ],
    createdAt: "2026-09-10T00:00:00.000Z"
  };
}
