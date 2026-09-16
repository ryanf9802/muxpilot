import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { StoredGitWorkspace } from "../src/db/database.js";
import { EventBus } from "../src/services/eventBus.js";
import { latestCodexFastModeFromText, managedCodexLaunchOptions, normalizeRepositoryApprovalPrefix, sessionChanged, SessionManager } from "../src/services/sessionManager.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SessionManager app-server helpers", () => {
  it("uses available authentication for fresh sessions while existing-session input stays reconciled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muxpilot-auth-admission-"));
    temporaryRoots.push(directory);
    const available = vi.fn();
    const reconciled = vi.fn(() => { throw new Error("reconciliation pending"); });
    const launch = vi.fn(async () => managedSession());
    const addAudit = vi.fn(async () => undefined);
    const codexStore = { stop: vi.fn() };
    const manager = new SessionManager(
      { addAudit } as never,
      codexStore as never,
      new EventBus(),
      60_000,
      60_000,
      { newScopeId: vi.fn(() => "scope-1") } as never,
      null,
      null,
      null,
      null,
      {},
      null,
      { has: vi.fn(() => true), require: vi.fn(() => ({})) } as never
    );
    manager.setAuthenticationGuard(reconciled);
    manager.setAuthenticationAvailabilityGuard(available);
    Object.assign(manager as object, {
      withDocumentLaunchOptions: vi.fn(async (options: object) => options),
      prepareOrchestratedLaunch: vi.fn(async (options: object) => ({ options, capabilityId: null })),
      launchAppServerSession: launch,
      publish: vi.fn()
    });

    await expect(manager.createSessionInDirectory(directory, "fresh-session", {
      model: null,
      reasoningEffort: null
    })).resolves.toEqual(managedSession());
    expect(available).toHaveBeenCalledTimes(2);
    expect(reconciled).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();

    await expect(manager.sendInput("session-1", "more work")).rejects.toThrow("reconciliation pending");
    expect(reconciled).toHaveBeenCalledOnce();
    manager.stop();
  });

  it("rechecks authentication availability immediately before a fresh session launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muxpilot-auth-launch-race-"));
    temporaryRoots.push(directory);
    const available = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error("authentication changed"); });
    const launch = vi.fn(async () => managedSession());
    const codexStore = { stop: vi.fn() };
    const manager = new SessionManager(
      { addAudit: vi.fn(async () => undefined) } as never,
      codexStore as never,
      new EventBus(),
      60_000,
      60_000,
      { newScopeId: vi.fn(() => "scope-1") } as never,
      null,
      null,
      null,
      null,
      {},
      null,
      { has: vi.fn(() => true), require: vi.fn(() => ({})) } as never
    );
    manager.setAuthenticationAvailabilityGuard(available);
    Object.assign(manager as object, {
      withDocumentLaunchOptions: vi.fn(async (options: object) => options),
      prepareOrchestratedLaunch: vi.fn(async (options: object) => ({ options, capabilityId: null })),
      launchAppServerSession: launch
    });

    await expect(manager.createSessionInDirectory(directory, "fresh-session", {
      model: null,
      reasoningEffort: null
    })).rejects.toThrow("authentication changed");
    expect(available).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    manager.stop();
  });

  it("can start periodic management without scheduling duplicate app-server recovery", () => {
    const events = new EventBus();
    const codexStore = { stop: vi.fn() };
    const manager = new SessionManager(
      {} as never,
      codexStore as never,
      events,
      60_000,
      60_000,
      {} as never
    );
    const recoverAppServerSessions = vi.fn(async () => undefined);
    manager.recoverAppServerSessions = recoverAppServerSessions;

    manager.start({ runInitialTick: false, recoverAppServerSessions: false });

    expect(recoverAppServerSessions).not.toHaveBeenCalled();
    manager.stop();
  });

  it("processes queued input when app-server reconciliation makes a session idle", async () => {
    const events = new EventBus();
    const codexStore = { stop: vi.fn() };
    const manager = new SessionManager(
      {} as never,
      codexStore as never,
      events,
      1_000,
      1_000,
      {} as never
    );
    const processQueuedInputs = vi.fn(async () => undefined);
    (manager as unknown as { processQueuedInputs: typeof processQueuedInputs }).processQueuedInputs = processQueuedInputs;

    events.publish({
      id: "event-1",
      type: "status.changed",
      sessionId: "session-1",
      payload: { status: "idle" },
      timestamp: "2026-09-15T05:04:30.822Z"
    });

    await vi.waitFor(() => expect(processQueuedInputs).toHaveBeenCalledWith("session-1"));
    manager.stop();
    expect(codexStore.stop).toHaveBeenCalledOnce();
    events.publish({
      id: "event-2",
      type: "status.changed",
      sessionId: "session-1",
      payload: { status: "waiting" },
      timestamp: "2026-09-15T05:04:31.822Z"
    });
    expect(processQueuedInputs).toHaveBeenCalledOnce();
  });

  it("resumes a connected session when Codex unloads its thread", async () => {
    const observedAt = "2026-09-15T14:59:52.794Z";
    const session = { ...managedSession(), status: "unknown" as const };
    const reconciliation = {
      sessionId: session.id,
      threadId: session.provider?.threadId ?? "thread-1",
      turnId: null,
      itemId: null,
      clientMessageId: null,
      method: "thread/status/changed",
      status: "unknown" as const,
      evidence: { threadId: "thread-1", status: { type: "notLoaded" } },
      observedAt
    };
    const db = {
      getAppServerReconciliationState: vi.fn(async () => reconciliation),
      getSession: vi.fn(async () => session),
      addAudit: vi.fn(async () => undefined)
    };
    const codexStore = { stop: vi.fn() };
    const events = new EventBus();
    const manager = new SessionManager(
      db as never,
      codexStore as never,
      events,
      1_000,
      1_000,
      {} as never
    );
    const resumeAppServerSession = vi.fn(async () => ({ ...session, status: "idle" as const }));
    (manager as unknown as { resumeAppServerSession: typeof resumeAppServerSession }).resumeAppServerSession = resumeAppServerSession;

    events.publish({
      id: "event-not-loaded",
      type: "status.changed",
      sessionId: session.id,
      payload: { status: "unknown" },
      timestamp: observedAt
    });

    await vi.waitFor(() => expect(resumeAppServerSession).toHaveBeenCalledWith(session));
    expect(db.getAppServerReconciliationState).toHaveBeenCalledTimes(2);
    expect(db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:recover_not_loaded",
      session.id,
      "ok",
      expect.any(String)
    );
    manager.stop();
  });

  it.each([
    ["a system error", { type: "systemError" }, "2026-09-15T14:59:52.794Z"],
    ["stale not-loaded evidence", { type: "notLoaded" }, "2026-09-15T14:59:51.000Z"]
  ])("does not auto-resume from %s", async (_label, status, eventTimestamp) => {
    const observedAt = "2026-09-15T14:59:52.794Z";
    const session = { ...managedSession(), status: "unknown" as const };
    const db = {
      getAppServerReconciliationState: vi.fn(async () => ({
        sessionId: session.id,
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        clientMessageId: null,
        method: "thread/status/changed",
        status: "unknown",
        evidence: { threadId: "thread-1", status },
        observedAt
      })),
      getSession: vi.fn(async () => session)
    };
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db,
      runtimeOperationTails: new Map<string, Promise<void>>(),
      resumeAppServerSession: vi.fn()
    }) as SessionManager;

    await (manager as unknown as {
      recoverNotLoadedAppServerSession(sessionId: string, timestamp: string): Promise<void>;
    }).recoverNotLoadedAppServerSession(session.id, eventTimestamp);

    expect((manager as unknown as { resumeAppServerSession: ReturnType<typeof vi.fn> }).resumeAppServerSession).not.toHaveBeenCalled();
    expect(db.getSession).not.toHaveBeenCalled();
  });

  it("abandons not-loaded recovery when newer reconciliation evidence wins the runtime lock", async () => {
    const observedAt = "2026-09-15T14:59:52.794Z";
    const session = { ...managedSession(), status: "unknown" as const };
    const notLoaded = {
      sessionId: session.id,
      threadId: "thread-1",
      turnId: null,
      itemId: null,
      clientMessageId: null,
      method: "thread/status/changed",
      status: "unknown" as const,
      evidence: { threadId: "thread-1", status: { type: "notLoaded" } },
      observedAt
    };
    const db = {
      getAppServerReconciliationState: vi.fn()
        .mockResolvedValueOnce(notLoaded)
        .mockResolvedValueOnce({ ...notLoaded, status: "idle", observedAt: "2026-09-15T15:00:00.000Z" }),
      getSession: vi.fn(async () => session)
    };
    const resumeAppServerSession = vi.fn();
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db,
      runtimeOperationTails: new Map<string, Promise<void>>(),
      resumeAppServerSession
    }) as SessionManager;

    await (manager as unknown as {
      recoverNotLoadedAppServerSession(sessionId: string, timestamp: string): Promise<void>;
    }).recoverNotLoadedAppServerSession(session.id, observedAt);

    expect(resumeAppServerSession).not.toHaveBeenCalled();
  });

  it("surfaces a failed not-loaded resume without recording recovery success", async () => {
    const observedAt = "2026-09-15T14:59:52.794Z";
    const session = { ...managedSession(), status: "unknown" as const };
    const db = {
      getAppServerReconciliationState: vi.fn(async () => ({
        sessionId: session.id,
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        clientMessageId: null,
        method: "thread/status/changed",
        status: "unknown",
        evidence: { threadId: "thread-1", status: { type: "notLoaded" } },
        observedAt
      })),
      getSession: vi.fn(async () => session),
      addAudit: vi.fn(async () => undefined)
    };
    const failure = new Error("resume failed");
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db,
      runtimeOperationTails: new Map<string, Promise<void>>(),
      resumeAppServerSession: vi.fn(async () => { throw failure; })
    }) as SessionManager;

    await expect((manager as unknown as {
      recoverNotLoadedAppServerSession(sessionId: string, timestamp: string): Promise<void>;
    }).recoverNotLoadedAppServerSession(session.id, observedAt)).rejects.toBe(failure);
    expect(db.addAudit).not.toHaveBeenCalled();
  });

  it("reports every source of automatic work that can resume an idle session", async () => {
    const session = { ...managedSession(), gitWorkspace: { id: "workspace-1" } } as ManagedSession;
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => session),
        listQueuedInputs: vi.fn(async () => [{ id: "queued-1" }]),
        activeBtwExchange: vi.fn(async () => ({ id: "btw-1" })),
        listAgentWaits: vi.fn(async () => [{ actorSessionId: session.id }])
      },
      deliveringInputSessionIds: new Set([session.id]),
      processingQueuedSessionIds: new Set<string>(),
      heavyCommandQueue: { hasActive: vi.fn(async () => true) }
    }) as SessionManager;

    await expect(manager.notificationPendingWorkReasons(session.id)).resolves.toEqual([
      "input_delivery",
      "queued_input",
      "btw_handoff",
      "orchestration_continuation",
      "heavy_command"
    ]);
  });

  it("does not promote a rejected transcript-only question to actionable status", async () => {
    const path = await rejectedQuestionRollout();
    const session = { ...managedSession(), codexJsonlPath: path, provider: { kind: "codex" as const, threadId: "thread-1", rolloutPath: path } };
    const setSessionStatus = vi.fn(async () => undefined);
    const publish = vi.fn();
    const manager = ingestManager(session, { setSessionStatus }, publish);

    await manager.ingest();

    expect(setSessionStatus).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "message.appended",
      sessionId: session.id,
      payload: expect.objectContaining({ type: "question_request", text: expect.stringContaining("Runbook form") })
    }));
  });

  it("restores question status only from app-server-backed transcript messages", async () => {
    const path = await rejectedQuestionRollout();
    const session = {
      ...managedSession(),
      status: "question" as const,
      codexJsonlPath: path,
      provider: { kind: "codex" as const, threadId: "thread-1", rolloutPath: path },
      transcriptSyncing: true
    };
    const latestQuestionMessage = vi.fn(async () => null);
    const upsertSession = vi.fn(async () => undefined);
    const manager = ingestManager(session, { latestQuestionMessage, upsertSession }, vi.fn());

    await manager.ingest();

    expect(latestQuestionMessage).toHaveBeenCalledWith(session.id, true);
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id, status: "waiting", transcriptSyncing: false }),
      expect.any(String)
    );

    const authoritativeQuestion = {
      id: "app-server-question",
      sessionId: session.id,
      sequence: 3,
      type: "question_request" as const,
      role: "system" as const,
      timestamp: "2026-09-13T16:51:31.576Z",
      text: "Codex needs your input",
      payload: {
        source: "codex_app_server",
        method: "item/tool/requestUserInput",
        question: { id: "12", questions: [] }
      }
    };
    const activeUpsertSession = vi.fn(async () => undefined);
    const activeManager = ingestManager(
      { ...session, status: "waiting" },
      { latestQuestionMessage: vi.fn(async () => authoritativeQuestion), upsertSession: activeUpsertSession },
      vi.fn()
    );

    await activeManager.ingest();

    expect(activeUpsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id, status: "question", transcriptSyncing: false }),
      expect.any(String)
    );
  });

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

  it("rejects approval mode overrides on agent-managed children", async () => {
    const session = {
      ...managedSession(),
      agentOwnership: {
        parentSessionId: "parent",
        rootSessionId: "parent",
        origin: "created" as const,
        createdAt: "2026-09-13T00:00:00.000Z",
        workTokenBaseline: 0,
        workTokenBudget: 1_000_000,
        completedAt: null,
        budgetExhaustedAt: null
      }
    };
    const setSessionApprovalMode = vi.fn(async () => session);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: { getSession: vi.fn(async () => session), setSessionApprovalMode },
      sessionDrivers: { has: () => true, require: () => ({}) }
    }) as SessionManager;

    await expect(manager.act(session.id, { type: "setApprovalMode", mode: "full" })).rejects.toThrow("inherited from its parent");
    expect(setSessionApprovalMode).not.toHaveBeenCalled();
  });

  it("kills attached descendants deepest-first and leaves detached sessions alone", async () => {
    const root = { ...managedSession(), id: "root" };
    const child = {
      ...managedChild("child", "root", "root", "hibernated"),
      gitWorkspace: gitWorkspace("main", "child-workspace")
    };
    const grandchild = managedChild("grandchild", "child", "root");
    const detached = { ...managedSession(), id: "detached" };
    const harness = killTreeManager([root, child, grandchild, detached]);

    const result = await harness.manager.act(root.id, { type: "kill" });

    expect(harness.kill).toHaveBeenCalledTimes(3);
    expect(harness.kill.mock.calls.map(([session]) => session.id)).toEqual(["grandchild", "child", "root"]);
    expect(result?.status).toBe("missing");
    expect(harness.sessions.get("detached")?.status).toBe("waiting");
    expect(harness.sessions.get("child")?.agentOwnership).toEqual(child.agentOwnership);
    expect(harness.sessions.get("child")?.gitWorkspace).toEqual(child.gitWorkspace);
    expect(harness.sessions.get("grandchild")?.agentOwnership?.completedAt).toBeNull();
    expect(harness.cancelWorkspace).toHaveBeenCalledWith("child-workspace", "owning session was killed");
    expect(harness.publish.mock.calls.map(([, id]) => id)).toEqual(["grandchild", "child", "root"]);
  });

  it("kills live descendants when the selected parent is already missing", async () => {
    const root = {
      ...managedSession(),
      id: "root",
      status: "missing" as const,
      runtime: { ...managedSession().runtime!, state: "stopped" as const }
    };
    const child = managedChild("child", "root", "root");
    const stopped = managedChild("stopped", "root", "root", "stopped");
    const completed = {
      ...managedChild("completed", "root", "root", "stopped"),
      status: "missing" as const,
      agentOwnership: {
        ...managedChild("completed", "root", "root").agentOwnership!,
        completedAt: "2026-09-15T01:00:00.000Z"
      }
    };
    const harness = killTreeManager([root, child, stopped, completed]);

    await harness.manager.act(root.id, { type: "kill" });

    expect(harness.kill.mock.calls.map(([session]) => session.id)).toEqual(["child"]);
    expect(harness.sessions.get("child")?.status).toBe("missing");
    expect(harness.sessions.get("stopped")?.status).toBe("missing");
    expect(harness.sessions.get("completed")?.archived).toBe(true);
    expect(harness.addAudit).toHaveBeenCalledWith("local", "kill", "root", "already_missing", expect.any(String));
  });

  it("leaves ancestors running after a descendant kill fails and resumes safely on retry", async () => {
    const root = { ...managedSession(), id: "root" };
    const child = managedChild("child", "root", "root");
    const grandchild = managedChild("grandchild", "child", "root");
    const harness = killTreeManager([root, child, grandchild]);
    harness.kill.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error("stop failed"));

    await expect(harness.manager.act(root.id, { type: "kill" })).rejects.toThrow("stop failed");
    expect(harness.sessions.get("grandchild")?.status).toBe("missing");
    expect(harness.sessions.get("child")?.status).toBe("waiting");
    expect(harness.sessions.get("root")?.status).toBe("waiting");

    harness.kill.mockResolvedValue(undefined);
    await harness.manager.act(root.id, { type: "kill" });
    expect(harness.kill.mock.calls.map(([session]) => session.id)).toEqual(["grandchild", "child", "child", "root"]);
    expect(harness.sessions.get("root")?.status).toBe("missing");
  });

  it.each(["agentCreateChild", "agentClaim"] as const)("rejects %s after the parent becomes missing", async (operation) => {
    const parent = { ...managedSession(), id: "parent", status: "missing" as const };
    const child = { ...managedSession(), id: "child" };
    const sessions = new Map([[parent.id, parent], [child.id, child]]);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: { getSession: vi.fn(async (id: string) => sessions.get(id) ?? null) },
      agentMutationQueue: Promise.resolve(),
      managedEnvironment: { MUXPILOT_SESSION_SCOPES_AVAILABLE: "1" }
    }) as SessionManager;

    const action = operation === "agentCreateChild"
      ? manager.agentCreateChild(parent.id, "child", "task")
      : manager.agentClaim(parent.id, child.id);
    await expect(action).rejects.toThrow("Only live sessions can");
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

  it("restarts a pending approval when inherited policy changes during review", async () => {
    const automatic = { ...managedSession(), status: "approval" as const, approvalMode: "auto" as const };
    const full = { ...automatic, approvalMode: "full" as const };
    const approval = pendingApproval(automatic.id);
    let finishReview!: () => void;
    const review = vi.fn(() => new Promise<{ decision: "approve"; explanation: string }>((resolve) => {
      finishReview = () => resolve({ decision: "approve", explanation: "In scope" });
    }));
    const resolveApproval = vi.fn(async () => undefined);
    const manager = Object.assign(Object.create(SessionManager.prototype), {
      db: {
        getSession: vi.fn(async () => full),
        getApprovalReviewerSettings: vi.fn(async () => ({ model: "gpt-5.6-luna", reasoningEffort: "low" })),
        addAudit: vi.fn(async () => undefined)
      },
      approvalReviewer: { review },
      automatedApprovalMessageIds: new Set<string>(),
      approvalAutomationGenerations: new Map<string, number>(),
      recordApprovalReview: vi.fn(async () => undefined),
      getPendingApproval: vi.fn(async () => approval),
      resolveApproval
    }) as SessionManager;
    (manager as unknown as { db: { getSession: ReturnType<typeof vi.fn> } }).db.getSession.mockResolvedValueOnce(automatic);

    const running = manager.handleAutomatedApproval(automatic.id, approval.messageId);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    (manager as unknown as { bumpApprovalAutomationGeneration: (id: string) => void }).bumpApprovalAutomationGeneration(automatic.id);
    finishReview();
    await running;
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledWith(
      automatic.id,
      { decision: "approve_once", messageId: approval.messageId },
      { resolvedBy: "full" }
    ));
    expect(review).toHaveBeenCalledOnce();
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

describe("SessionManager Codex authentication runtime safety", () => {
  it.each([
    "executing",
    "planning",
    "question",
    "approval",
    "startup_failed",
    "unknown"
  ] as const)("defers runtime replacement while a session is %s", async (status) => {
    const harness = authenticationManager({ ...managedSession(), status });

    await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

    expect(harness.driver.hibernationBlockers).not.toHaveBeenCalled();
    expect(harness.driver.kill).not.toHaveBeenCalled();
    expect(harness.db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:auth_restart_deferred",
      "session-1",
      JSON.stringify({ blockers: [`status_${status}`] }),
      expect.any(String)
    );
  });

  it("defers runtime replacement while recovery is initializing", async () => {
    const session = managedSession();
    const harness = authenticationManager({
      ...session,
      status: "unknown",
      initializing: true,
      runtime: { ...session.runtime!, state: "starting" }
    });

    await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

    expect(harness.driver.kill).not.toHaveBeenCalled();
    expect(harness.db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:auth_restart_deferred",
      "session-1",
      JSON.stringify({ blockers: ["runtime_starting", "initializing", "status_unknown"] }),
      expect.any(String)
    );
  });

  it("keeps authentication admission held after failed recovery", async () => {
    const session = managedSession();
    const harness = authenticationManager({
      ...session,
      status: "startup_failed",
      runtime: { ...session.runtime!, state: "failed" }
    });

    await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

    expect(harness.driver.kill).not.toHaveBeenCalled();
    expect(harness.db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:auth_restart_deferred",
      "session-1",
      JSON.stringify({ blockers: ["runtime_failed", "status_startup_failed"] }),
      expect.any(String)
    );
  });

  it.each(["active_turn", "interactive_request", "background_terminal"])(
    "defers runtime replacement when live runtime evidence reports %s",
    async (runtimeBlocker) => {
      const harness = authenticationManager(managedSession(), [runtimeBlocker]);

      await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

      expect(harness.driver.kill).not.toHaveBeenCalled();
      expect(harness.db.addAudit).toHaveBeenCalledWith(
        "muxpilot",
        "runtime:auth_restart_deferred",
        "session-1",
        JSON.stringify({ blockers: [runtimeBlocker] }),
        expect.any(String)
      );
    }
  );

  it("fails closed when live runtime evidence is unavailable", async () => {
    const harness = authenticationManager(managedSession());
    harness.driver.hibernationBlockers.mockRejectedValueOnce(new Error("connection unavailable"));

    await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

    expect(harness.driver.kill).not.toHaveBeenCalled();
    expect(harness.db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:auth_restart_deferred",
      "session-1",
      JSON.stringify({ blockers: ["runtime_evidence_unavailable"] }),
      expect.any(String)
    );
  });

  it.each(["idle", "waiting", "plan_ready"] as const)(
    "restarts a %s runtime only after positive idle evidence",
    async (status) => {
      const harness = authenticationManager({ ...managedSession(), status });

      await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual([]);

      expect(harness.driver.hibernationBlockers).toHaveBeenCalledWith(expect.objectContaining({ status }));
      expect(harness.driver.kill).toHaveBeenCalledOnce();
      expect(harness.resumeAppServerSession).toHaveBeenCalledWith(expect.objectContaining({
        runtime: expect.objectContaining({ state: "stopped" })
      }));
      expect(harness.db.addAudit).toHaveBeenCalledWith(
        "muxpilot",
        "runtime:auth_restarted",
        "session-1",
        JSON.stringify({ blockers: [] }),
        expect.any(String)
      );
    }
  );

  it("rechecks eligibility inside the runtime lock", async () => {
    const observed = { ...managedSession(), status: "idle" as const };
    const locked = { ...observed, status: "executing" as const };
    const harness = authenticationManager(observed, [], locked);

    await expect(harness.manager.reconcileCodexAuthentication()).resolves.toEqual(["session-1"]);

    expect(harness.driver.kill).not.toHaveBeenCalled();
  });

  it("retries only the sessions captured by the authentication reconciliation cohort", async () => {
    const captured = managedSession();
    const admitted = {
      ...managedSession(),
      id: "session-admitted-during-reconciliation",
      provider: { kind: "codex" as const, threadId: "thread-new", rolloutPath: null },
      codexSessionId: "thread-new",
      codexJsonlPath: null
    };
    const harness = authenticationManager(captured);
    harness.db.listSessions.mockResolvedValue([captured, admitted]);

    await expect(harness.manager.reconcileCodexAuthentication([captured.id])).resolves.toEqual([]);

    expect(harness.driver.kill).toHaveBeenCalledOnce();
    expect(harness.driver.kill).toHaveBeenCalledWith(expect.objectContaining({ id: captured.id }));
    expect(harness.driver.kill).not.toHaveBeenCalledWith(expect.objectContaining({ id: admitted.id }));
  });

  it("does not stop an unsafe runtime during sign-out", async () => {
    const harness = authenticationManager({ ...managedSession(), status: "question" });

    await expect(harness.manager.suspendForCodexSignOut()).resolves.toEqual(["session-1"]);

    expect(harness.driver.kill).not.toHaveBeenCalled();
    expect(harness.db.addAudit).toHaveBeenCalledWith(
      "muxpilot",
      "runtime:auth_signout_deferred",
      "session-1",
      JSON.stringify({ blockers: ["status_question"] }),
      expect.any(String)
    );
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

function authenticationManager(
  observed: ManagedSession,
  runtimeBlockers: string[] = [],
  locked: ManagedSession = observed
) {
  let current = locked;
  const driver = {
    hibernationBlockers: vi.fn(async () => runtimeBlockers),
    kill: vi.fn(async () => undefined)
  };
  const db = {
    listSessions: vi.fn(async () => [observed]),
    getSession: vi.fn(async () => current),
    upsertSession: vi.fn(async (session: ManagedSession) => { current = session; }),
    addAudit: vi.fn(async () => undefined)
  };
  const resumeAppServerSession = vi.fn(async (session: ManagedSession) => session);
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    db,
    sessionDrivers: {
      has: vi.fn(() => true),
      require: vi.fn(() => driver)
    },
    runtimeOperationTails: new Map<string, Promise<void>>(),
    resumeAppServerSession,
    publish: vi.fn()
  }) as SessionManager;
  return { manager, db, driver, resumeAppServerSession };
}

function managedChild(
  id: string,
  parentSessionId: string,
  rootSessionId: string,
  runtimeState: NonNullable<ManagedSession["runtime"]>["state"] = "connected"
): ManagedSession {
  return {
    ...managedSession(),
    id,
    runtime: { ...managedSession().runtime!, state: runtimeState },
    agentOwnership: {
      parentSessionId,
      rootSessionId,
      origin: "created",
      createdAt: "2026-09-15T00:00:00.000Z",
      workTokenBaseline: 0,
      workTokenBudget: 1_000_000,
      completedAt: null,
      budgetExhaustedAt: null
    }
  };
}

function killTreeManager(initialSessions: ManagedSession[]) {
  const sessions = new Map(initialSessions.map((session) => [session.id, session]));
  const kill = vi.fn(async (_session: ManagedSession) => undefined);
  const addAudit = vi.fn(async () => undefined);
  const publish = vi.fn();
  const cancelWorkspace = vi.fn(async () => undefined);
  const db = {
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    listSessions: vi.fn(async () => [...sessions.values()]),
    upsertSession: vi.fn(async (session: ManagedSession) => { sessions.set(session.id, session); }),
    markSessionArchived: vi.fn(async (id: string) => {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, archived: true });
    }),
    addAudit
  };
  const manager = Object.assign(Object.create(SessionManager.prototype), {
    db,
    agentMutationQueue: Promise.resolve(),
    runtimeOperationTails: new Map<string, Promise<void>>(),
    readySessionDiscoveryGeneration: new Map<string, number>(),
    heavyCommandQueue: { cancelWorkspace },
    requireAppServerDriver: () => ({ kill }),
    publish
  }) as SessionManager;
  return { manager, sessions, kill, addAudit, publish, cancelWorkspace };
}

function ingestManager(
  session: ManagedSession,
  overrides: Record<string, unknown>,
  publish: ReturnType<typeof vi.fn>
): SessionManager {
  let sequence = 0;
  const db = {
    listSessions: vi.fn(async () => [session]),
    listParserOffsets: vi.fn(async () => ({})),
    hasParserOffset: vi.fn(async () => false),
    getParserOffset: vi.fn(async () => 0),
    nextSequence: vi.fn(async () => ++sequence),
    appendMessage: vi.fn(async () => true),
    deleteEchoedSentQueuedInputs: vi.fn(async () => 0),
    listQueuedInputs: vi.fn(async () => []),
    getSession: vi.fn(async () => session),
    setParserOffset: vi.fn(async () => undefined),
    latestQuestionMessage: vi.fn(async () => null),
    latestQuestionAnswerMessage: vi.fn(async () => null),
    latestUserMessage: vi.fn(async () => null),
    latestPlanReadyMessage: vi.fn(async () => null),
    latestTurnLifecycleMessage: vi.fn(async () => null),
    upsertSession: vi.fn(async () => undefined),
    ...overrides
  };
  return new SessionManager(
    db as never,
    { listRecent: vi.fn(async () => []), stop: vi.fn() } as never,
    { publish, subscribe: vi.fn(() => () => undefined) } as never,
    1_000,
    1_000,
    {} as never
  );
}

async function rejectedQuestionRollout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-rejected-question-"));
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, [
    JSON.stringify({
      timestamp: "2026-09-13T16:51:31.576Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        arguments: JSON.stringify({ questions: [{
          header: "Runbook form",
          id: "runbook_execution",
          question: "Should each runbook include commands plus evidence-capture templates?",
          options: [
            { label: "Commands + evidence (Recommended)", description: "Make every gate executable." },
            { label: "Procedural only", description: "Describe actions without commands." }
          ]
        }] }),
        call_id: "call-rejected-question"
      }
    }),
    JSON.stringify({
      timestamp: "2026-09-13T16:51:31.702Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-rejected-question",
        output: "request_user_input is unavailable in Default mode"
      }
    }),
    ""
  ].join("\n"));
  return path;
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
