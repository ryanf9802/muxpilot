import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serializeSessionWaitEvent, type ChatMessage, type ManagedSession, type QueuedInput, type SessionHistoryResult, type TranscriptPageResponse } from "@muxpilot/core";
import { AppDatabase, type StoredGitWorkspace } from "../src/db/database.js";

describe("AppDatabase session visibility", () => {
  it("defaults legacy sessions to Ask and persists per-session approval mode", async () => {
    const db = await tempDb();
    const current = testSession("approval-mode");
    const { approvalMode: _approvalMode, ...legacy } = current;
    await db.upsertSession(legacy as ManagedSession, "2026-09-10T00:00:00.000Z");

    expect((await db.getSession(current.id))?.approvalMode).toBe("ask");
    await db.setSessionApprovalMode(current.id, "auto", "2026-09-10T00:00:01.000Z");
    expect((await db.getSession(current.id))?.approvalMode).toBe("auto");
    await db.close();
  });

  it("stores the app-wide approval reviewer settings", async () => {
    const db = await tempDb();
    expect(await db.getApprovalReviewerSettings()).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "low" });
    await db.setApprovalReviewerSettings({ model: "gpt-5.6-sol", reasoningEffort: "medium" }, "2026-09-10T00:00:00.000Z");
    expect(await db.getApprovalReviewerSettings()).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
    await db.close();
  });

  it("reopens canonical session data without changing runtime fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-reopen-"));
    const path = join(dir, "test.db");
    const original = testSession("canonical-runtime");
    const initial = new AppDatabase(path);
    await initial.upsertSession(original, "2026-08-31T00:00:00.000Z");
    await initial.close();

    const reopened = new AppDatabase(path);
    const session = await reopened.getSession(original.id);
    expect(session).toMatchObject({
      name: original.name,
      cwd: original.cwd,
      provider: { kind: "codex", threadId: "codex-session", rolloutPath: "/tmp/codex.jsonl" },
      runtime: original.runtime,
      resourceUnit: null
    });
    await reopened.close();
  });

  it("removes persisted context guards without clearing an exhausted work-token budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const legacyOwnership = (budgetExhaustedAt: string | null) => ({
      parentSessionId: "parent",
      rootSessionId: "parent",
      origin: "created" as const,
      createdAt: "2026-08-25T00:00:00.000Z",
      workTokenBaseline: 0,
      workTokenBudget: 1_000_000,
      completedAt: null,
      budgetExhaustedAt,
      contextPausedAt: "2026-08-25T00:01:00.000Z",
      highContextApprovedAt: null
    }) as ManagedSession["agentOwnership"];
    const db = new AppDatabase(path);
    await db.upsertSession({ ...testSession("context-only"), status: "blocked", agentOwnership: legacyOwnership(null) }, "2026-08-25T00:01:00.000Z");
    await db.upsertSession({ ...testSession("budget-blocked"), status: "blocked", agentOwnership: legacyOwnership("2026-08-25T00:01:00.000Z") }, "2026-08-25T00:01:00.000Z");
    await db.close();

    const restarted = new AppDatabase(path);
    const contextOnly = await restarted.getSession("context-only");
    const budgetBlocked = await restarted.getSession("budget-blocked");
    expect(contextOnly?.status).toBe("waiting");
    expect(contextOnly?.agentOwnership).not.toHaveProperty("contextPausedAt");
    expect(contextOnly?.agentOwnership).not.toHaveProperty("highContextApprovedAt");
    expect(budgetBlocked).toMatchObject({ status: "blocked", agentOwnership: { budgetExhaustedAt: "2026-08-25T00:01:00.000Z" } });
    expect(budgetBlocked?.agentOwnership).not.toHaveProperty("contextPausedAt");
    await restarted.close();
  });

  it("persists event-driven agent waits across database restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const session = testSession("waiting-parent");
    const db = new AppDatabase(path);
    await db.upsertSession(session, "2026-08-25T00:00:00.000Z");
    await db.upsertAgentWait({
      actorSessionId: session.id,
      sessionIds: ["child-a", "child-b"],
      mode: "all",
      expiresAt: 123456,
      readyAt: null
    }, "2026-08-25T00:00:01.000Z");
    await db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listAgentWaits()).toEqual([{
      actorSessionId: session.id,
      sessionIds: ["child-a", "child-b"],
      mode: "all",
      expiresAt: 123456,
      readyAt: null
    }]);
    await restarted.deleteAgentWait(session.id);
    expect(await restarted.listAgentWaits()).toEqual([]);
    await restarted.close();
  });

  it("repairs persisted orchestration wake echoes into one system event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const paired = testSession("wait-paired");
    const rawOnly = testSession("wait-raw-only");
    const event = { version: 1 as const, kind: "resume_requested" as const, sessions: [{ id: "child-1" }] };
    const marker = serializeSessionWaitEvent(event);
    const db = new AppDatabase(path);
    await db.upsertSession(paired, "2026-08-25T00:00:00.000Z");
    await db.upsertSession(rawOnly, "2026-08-25T00:00:00.000Z");
    await db.appendMessage({
      ...testMessage(paired.id, 1, "system", "Agent session wait resumed", "2026-08-25T00:00:01.000Z", "status"),
      payload: { agentSessionWait: event }
    });
    await db.appendMessage(testMessage(paired.id, 2, "user", marker, "2026-08-25T00:00:01.100Z"));
    await db.appendMessage(testMessage(rawOnly.id, 1, "user", marker, "2026-08-25T00:00:02.000Z"));
    await db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listMessages(paired.id, 0)).toMatchObject([
      { role: "system", type: "status", payload: { agentSessionWait: event } }
    ]);
    expect(await restarted.listMessages(rawOnly.id, 0)).toMatchObject([
      { role: "system", type: "status", text: "Agent session wait resumed", payload: { agentSessionWait: event } }
    ]);
    expect(await restarted.listPromptHistory("muxpilot_session_wait", 10)).toEqual([]);
    await restarted.close();
  });

  it("deduplicates normalized orchestration wakes across parser batches", async () => {
    const db = await tempDb();
    const session = testSession("wait-deduped");
    const event = { version: 1 as const, kind: "resume_requested" as const, sessions: [] };
    await db.upsertSession(session, "2026-08-25T00:00:00.000Z");
    const first = {
      ...testMessage(session.id, 1, "system", "Agent session wait resumed", "2026-08-25T00:00:01.000Z", "status"),
      payload: { agentSessionWait: event }
    };
    expect(await db.appendMessage(first)).toBe(true);
    expect(await db.appendMessage({ ...first, id: `${session.id}-2`, sequence: 2, timestamp: "2026-08-25T00:00:01.100Z" })).toBe(false);
    await db.close();
  });

  it("removes only valid internal wait markers from the persisted input queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const session = testSession("wait-queue-repair");
    const db = new AppDatabase(path);
    await db.upsertSession(session, "2026-08-25T00:00:00.000Z");
    await db.appendQueuedInput(testQueuedInput(session.id, {
      id: "valid-wait",
      text: serializeSessionWaitEvent({ version: 1, kind: "timeout", sessions: [] }),
      status: "queued"
    }));
    await db.appendQueuedInput(testQueuedInput(session.id, {
      id: "malformed-wait",
      text: '<muxpilot_session_wait>{"version":2,"kind":"timeout","sessions":[]}</muxpilot_session_wait>',
      status: "queued"
    }));
    await db.appendQueuedInput(testQueuedInput(session.id, {
      id: "operator-input",
      text: "Keep this queued message",
      status: "queued"
    }));
    await db.close();

    const restarted = new AppDatabase(path);
    expect((await restarted.listQueuedInputs(session.id)).map((input) => input.id)).toEqual([
      "malformed-wait",
      "operator-input"
    ]);
    await restarted.close();
  });

  it("persists runtime and pending crash-recovery state", async () => {
    const db = await tempDb();
    const updatedAt = "2026-08-17T20:00:00.000Z";
    await db.setSessionRecoveryRuntime({ runId: "run-1", cleanShutdown: false, updatedAt, sessionIds: ["session-1"] });
    await db.setSessionRecoveryIncident({
      id: "incident-1",
      detectedAt: updatedAt,
      sessions: [{
        ...sessionHistoryResult(testSession("session-1")),
        previousStatus: "working"
      }]
    }, updatedAt);

    expect(await db.getSessionRecoveryRuntime()).toEqual({ runId: "run-1", cleanShutdown: false, updatedAt, sessionIds: ["session-1"] });
    expect(await db.getSessionRecoveryIncident()).toMatchObject({ id: "incident-1", sessions: [{ sessionId: "session-1", previousStatus: "working" }] });
    await db.setSessionRecoveryIncident(null, updatedAt);
    expect(await db.getSessionRecoveryIncident()).toBeNull();
    await db.close();
  });

  it("filters missing rows in SQL before session hydration", async () => {
    const db = await tempDb();
    const active = testSession("session-active");
    const missing = { ...testSession("session-missing"), status: "missing" as const };
    await db.upsertSession(active, "2026-07-07T00:00:00.000Z");
    await db.upsertSession(missing, "2026-07-07T00:00:00.000Z");

    expect((await db.listSessions(false, false)).map((session) => session.id)).toEqual([active.id]);
    expect((await db.listSessions(false, true)).map((session) => session.id).sort()).toEqual([active.id, missing.id].sort());
    await db.close();
  });

  it("does not let an older discovery snapshot overwrite newer session state", async () => {
    const db = await tempDb();
    const session = testSession("session-concurrent-update");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    await db.setSessionInputMode(session.id, "plan", "2026-07-07T00:00:02.000Z");
    await db.setSessionStatus(session.id, "planning", "2026-07-07T00:00:02.000Z");

    await db.upsertSession(
      { ...session, status: "waiting", inputMode: "default" },
      "2026-07-07T00:00:01.000Z",
      true
    );

    expect(await db.getSession(session.id)).toMatchObject({ status: "planning", inputMode: "plan" });
    await db.close();
  });
});

describe("AppDatabase session prompts", () => {
  it("invalidates cached recent prompts when a user message is appended", async () => {
    const db = await tempDb();
    const session = testSession("session-prompt-cache");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    await db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    expect((await db.getSession(session.id))?.recentUserPrompts).toEqual(["First prompt"]);

    await db.appendMessage(testMessage(session.id, 2, "user", "Second prompt"));
    expect((await db.getSession(session.id))?.recentUserPrompts).toEqual(["Second prompt", "First prompt"]);
    await db.close();
  });

  it("reconciles a Codex user echo into a persisted muxpilot submission", async () => {
    const db = await tempDb();
    const session = testSession("session-submitted-input");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Implement the change"),
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: {
          codexSessionId: "codex-session",
          state: "pending",
          lastAttemptAt: "2026-07-07T00:00:01.000Z"
        }
      }
    };
    const echoed = {
      ...testMessage(session.id, 2, "user", "Implement the change"),
      payload: { type: "event_msg", payload: { type: "user_message", message: "Implement the change" } }
    };

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(echoed)).toBe(false);

    const messages = await db.listMessages(session.id, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: submitted.id,
      sequence: 1,
      payload: {
        ...echoed.payload,
        collaborationMode: "plan",
        muxpilotSubmission: {
          ...submitted.payload.muxpilotSubmission,
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          acknowledgedBy: "user_echo",
          failureReason: null
        }
      }
    });
    expect((await db.getSession(session.id))?.unreadCount).toBe(1);
    await db.close();
  });

  it("allocates and appends a message sequence in one database operation", async () => {
    const db = await tempDb();
    const session = testSession("session-atomic-sequence");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    await db.appendMessage(testMessage(session.id, 1, "assistant", "Existing event"));
    const { sequence: _ignored, ...candidate } = testMessage(
      session.id,
      999,
      "user",
      "Persist without a split sequence allocation"
    );

    const appended = await db.appendMessageWithNextSequence(candidate);

    expect(appended).toMatchObject({ sequence: 2, text: "Persist without a split sequence allocation" });
    expect((await db.listMessages(session.id, 0)).map((message) => message.sequence)).toEqual([1, 2]);
    await db.close();
  });

  it("reconciles a delayed retry echo against the latest delivery attempt without duplicating the prompt", async () => {
    const db = await tempDb();
    const session = testSession("session-retried-input");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Retry this", "2026-07-07T00:00:01.000Z"),
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: {
          state: "pending",
          attemptCount: 2,
          lastAttemptAt: "2026-07-07T00:10:00.000Z"
        }
      }
    };
    const echoed = {
      ...testMessage(session.id, 2, "user", "Retry this", "2026-07-07T00:10:01.000Z"),
      payload: { type: "event_msg", payload: { type: "user_message", message: "Retry this" } }
    };

    await db.appendMessage(submitted);
    expect(await db.appendMessage(echoed)).toBe(false);
    expect(await db.listMessages(session.id, 0)).toMatchObject([{
      id: submitted.id,
      payload: { muxpilotSubmission: { state: "acknowledged", attemptCount: 2 } }
    }]);
    await db.close();
  });

  it("merges input delivery state into the latest projected payload atomically", async () => {
    const db = await tempDb();
    const session = testSession("session-atomic-input-delivery");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Keep projected identity", "2026-07-07T00:00:01.000Z"),
      payload: { muxpilotSubmission: { state: "pending", attemptCount: 1 } }
    };
    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.updateMessagePayload(submitted, {
      source: "codex_app_server",
      codexItemIdentity: {
        threadId: "thread-atomic",
        turnId: "turn-atomic",
        itemId: "item-atomic",
        clientMessageId: submitted.id
      },
      muxpilotSubmission: submitted.payload.muxpilotSubmission
    })).not.toBeNull();

    expect(await db.updateMuxpilotSubmission(submitted, {
      state: "acknowledged",
      acknowledgedBy: "app_server_receipt",
      threadId: "thread-atomic",
      turnId: "turn-atomic"
    })).toMatchObject({
      id: submitted.id,
      payload: {
        source: "codex_app_server",
        codexItemIdentity: { clientMessageId: submitted.id },
        muxpilotSubmission: {
          state: "acknowledged",
          attemptCount: 1,
          acknowledgedBy: "app_server_receipt",
          threadId: "thread-atomic",
          turnId: "turn-atomic"
        }
      }
    });
    await db.close();
  });

  it("binds a receipt-acknowledged app-server submission before the rollout echo arrives", async () => {
    const db = await tempDb();
    const session = testSession("session-app-server-submission-race");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Reply exactly CHILD_OK", "2026-07-07T00:00:01.000Z"),
      payload: {
        collaborationMode: "plan",
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "delivering",
          lastAttemptAt: "2026-07-07T00:00:01.000Z"
        }
      }
    };
    const appServerIdentity = {
      threadId: "thread-app",
      turnId: "turn-app",
      itemId: "item-user-app-server",
      clientMessageId: submitted.id
    };
    const rolloutIdentity = {
      threadId: "thread-app",
      turnId: "turn-app",
      itemId: "item-user-rollout",
      clientMessageId: null
    };
    const hiddenContext = {
      ...testMessage(session.id, 2, "user", "<environment_context>hidden</environment_context>", "2026-07-07T00:00:01.050Z"),
      payload: { hidden: true }
    };
    const appServerEcho = {
      ...testMessage(session.id, 3, "user", submitted.text, "2026-07-07T00:00:01.100Z"),
      payload: {
        source: "codex_app_server",
        codexItemIdentity: appServerIdentity,
        appServerIdentity
      }
    };
    const rolloutEcho = {
      ...testMessage(session.id, 4, "user", submitted.text, "2026-07-07T00:00:01.200Z"),
      payload: {
        source: "rollout",
        codexItemIdentity: rolloutIdentity
      }
    };

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(hiddenContext)).toBe(true);
    expect(await db.updateMessagePayload(submitted, {
      ...submitted.payload,
      muxpilotSubmission: {
        ...submitted.payload.muxpilotSubmission,
        state: "acknowledged",
        deliveryPhase: "acknowledged",
        acknowledgedBy: "app_server_receipt",
        clientMessageId: submitted.id,
        threadId: appServerIdentity.threadId,
        turnId: appServerIdentity.turnId
      }
    })).toMatchObject({ id: submitted.id });
    expect(await db.appendMessage(appServerEcho)).toBe(false);
    expect(await db.appendMessage(rolloutEcho)).toBe(false);

    const messages = await db.listMessages(session.id, 0);
    expect(messages).toHaveLength(2);
    const taskMessage = messages.find((message) => message.text === submitted.text)!;
    expect(taskMessage).toMatchObject({
      id: submitted.id,
      sequence: submitted.sequence,
      payload: {
        collaborationMode: "plan",
        source: "codex_app_server",
        codexItemIdentity: appServerIdentity,
        muxpilotSubmission: {
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          acknowledgedBy: "app_server_receipt"
        }
      }
    });
    await db.close();
  });

  it("reconciles a delayed app-server echo by exact client message identity", async () => {
    const db = await tempDb();
    const session = testSession("session-delayed-app-server-echo");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Queued during recovery", "2026-07-07T00:00:01.000Z"),
      payload: {
        muxpilotSubmission: {
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          lastAttemptAt: "2026-07-07T00:00:01.000Z",
          clientMessageId: `${session.id}-1`
        }
      }
    };
    const identity = {
      threadId: "thread-app",
      turnId: "turn-app",
      itemId: "item-user-app-server",
      clientMessageId: submitted.id
    };
    const delayedEcho = {
      ...testMessage(session.id, 2, "user", submitted.text, "2026-07-07T00:00:07.000Z"),
      payload: {
        source: "codex_app_server",
        codexItemIdentity: identity,
        appServerIdentity: identity
      }
    };

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(delayedEcho)).toBe(false);
    expect(await db.listMessages(session.id, 0)).toEqual([
      expect.objectContaining({
        id: submitted.id,
        sequence: submitted.sequence,
        text: submitted.text,
        payload: expect.objectContaining({
          source: "codex_app_server",
          codexItemIdentity: identity,
          muxpilotSubmission: submitted.payload.muxpilotSubmission
        })
      })
    ]);
    await db.close();
  });

  it("reconciles a delayed rollout echo by an unambiguous receipt turn identity", async () => {
    const db = await tempDb();
    const session = {
      ...testSession("session-delayed-rollout-echo"),
      codexSessionId: "thread-app",
      provider: { kind: "codex" as const, threadId: "thread-app", rolloutPath: "/tmp/codex.jsonl" }
    };
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Queued during recovery", "2026-07-07T00:00:01.000Z"),
      payload: {
        muxpilotSubmission: {
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          lastAttemptAt: "2026-07-07T00:00:01.000Z",
          threadId: "thread-app",
          turnId: "turn-app"
        }
      }
    };
    const rolloutIdentity = {
      turnId: "turn-app",
      itemId: "item-user-rollout",
      clientMessageId: null
    };
    const delayedEcho = {
      ...testMessage(session.id, 2, "user", submitted.text, "2026-07-07T00:00:07.000Z"),
      payload: { source: "rollout", codexItemIdentity: rolloutIdentity }
    };

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(delayedEcho)).toBe(false);
    expect(await db.listMessages(session.id, 0)).toEqual([
      expect.objectContaining({
        id: submitted.id,
        sequence: submitted.sequence,
        text: submitted.text,
        payload: expect.objectContaining({
          source: "rollout",
          codexItemIdentity: rolloutIdentity,
          muxpilotSubmission: submitted.payload.muxpilotSubmission
        })
      })
    ]);
    await db.close();
  });

  it("keeps delayed same-turn text ambiguous when multiple submissions match", async () => {
    const db = await tempDb();
    const session = { ...testSession("session-ambiguous-rollout-echo"), codexSessionId: "thread-app" };
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (const sequence of [1, 2]) {
      expect(await db.appendMessage({
        ...testMessage(session.id, sequence, "user", "Repeated prompt", `2026-07-07T00:00:0${sequence}.000Z`),
        payload: {
          muxpilotSubmission: {
            state: "acknowledged",
            lastAttemptAt: `2026-07-07T00:00:0${sequence}.000Z`,
            threadId: "thread-app",
            turnId: "turn-app"
          }
        }
      })).toBe(true);
    }
    const delayedEcho = {
      ...testMessage(session.id, 3, "user", "Repeated prompt", "2026-07-07T00:00:09.000Z"),
      payload: {
        source: "rollout",
        codexItemIdentity: { turnId: "turn-app", itemId: "item-user-rollout", clientMessageId: null }
      }
    };

    expect(await db.appendMessage(delayedEcho)).toBe(true);
    expect((await db.listMessages(session.id, 0)).filter((message) => message.text === "Repeated prompt")).toHaveLength(3);
    await db.close();
  });

  it("upgrades the same reconciled submission when the rollout echo wins the race", async () => {
    const db = await tempDb();
    const session = testSession("session-rollout-submission-race");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Reply exactly CHILD_OK", "2026-07-07T00:00:01.000Z"),
      payload: {
        muxpilotSubmission: {
          state: "pending",
          deliveryPhase: "delivering",
          lastAttemptAt: "2026-07-07T00:00:01.000Z"
        }
      }
    };
    const appServerIdentity = {
      threadId: "thread-app",
      turnId: "turn-app",
      itemId: "item-user-app-server",
      clientMessageId: submitted.id
    };
    const rolloutIdentity = {
      threadId: "thread-app",
      turnId: "turn-app",
      itemId: "item-user-rollout",
      clientMessageId: null
    };
    const hiddenContext = {
      ...testMessage(session.id, 2, "user", "<environment_context>hidden</environment_context>", "2026-07-07T00:00:01.050Z"),
      payload: { hidden: true }
    };
    const rolloutEcho = {
      ...testMessage(session.id, 3, "user", submitted.text, "2026-07-07T00:00:01.100Z"),
      payload: { source: "rollout", codexItemIdentity: rolloutIdentity }
    };
    const appServerEcho = {
      ...testMessage(session.id, 4, "user", submitted.text, "2026-07-07T00:00:01.200Z"),
      payload: {
        source: "codex_app_server",
        codexItemIdentity: appServerIdentity,
        appServerIdentity
      }
    };

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(hiddenContext)).toBe(true);
    expect(await db.appendMessage(rolloutEcho)).toBe(false);
    expect(await db.appendMessage(appServerEcho)).toBe(false);

    const messages = await db.listMessages(session.id, 0);
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.text === submitted.text)).toMatchObject({
      id: submitted.id,
      sequence: submitted.sequence,
      payload: {
        source: "codex_app_server",
        codexItemIdentity: appServerIdentity,
        appServerIdentity,
        muxpilotSubmission: {
          state: "acknowledged",
          deliveryPhase: "acknowledged",
          acknowledgedBy: "user_echo"
        }
      }
    });
    await db.close();
  });

  it("keeps a later identical prompt distinct from an unmatched muxpilot submission", async () => {
    const db = await tempDb();
    const session = testSession("session-repeated-submitted-input");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const submitted = {
      ...testMessage(session.id, 1, "user", "Repeat this", "2026-07-07T00:00:01.000Z"),
      payload: { muxpilotSubmission: { codexSessionId: "codex-session" } }
    };
    const later = testMessage(session.id, 2, "user", "Repeat this", "2026-07-07T00:01:01.000Z");

    expect(await db.appendMessage(submitted)).toBe(true);
    expect(await db.appendMessage(later)).toBe(true);
    expect(await db.listMessages(session.id, 0)).toHaveLength(2);
    await db.close();
  });

  it("excludes initial instruction context from recent prompt metadata", async () => {
    const db = await tempDb();
    const session = testSession("session-context-preview");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", initialInstructionContext(), "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "Second prompt", "2026-07-07T00:00:03.000Z"));

    const hydrated = db.getSession(session.id);

    expect(hydrated?.preview).toBe("Second prompt");
    expect(hydrated?.recentUserPrompts).toEqual(["Second prompt", "First prompt"]);
    expect(hydrated?.lastActivityAt).toBe("2026-07-07T00:00:03.000Z");
    db.close();
  });

  it("searches displayable prompt history across active, archived, and missing sessions", async () => {
    const db = await tempDb();
    const active = testSession("session-history-active");
    const archived = { ...testSession("session-history-archived"), archived: true };
    const missing = { ...testSession("session-history-missing"), status: "missing" as const };
    db.upsertSession(active, "2026-07-07T00:00:00.000Z");
    db.upsertSession(archived, "2026-07-07T00:00:00.000Z");
    db.upsertSession(missing, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(active.id, 1, "user", "Build prompt history search", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(archived.id, 1, "user", "Archived prompt history result", "2026-07-07T00:00:03.000Z"));
    db.appendMessage(testMessage(missing.id, 1, "user", "Missing session prompt history result", "2026-07-07T00:00:02.000Z"));

    const history = await db.listPromptHistory("history", 10);

    expect(history.map((result) => result.text)).toEqual(expect.arrayContaining([
      "Archived prompt history result",
      "Missing session prompt history result",
      "Build prompt history search"
    ]));
    expect(history.map((result) => result.sessionId)).toEqual(expect.arrayContaining([archived.id, missing.id, active.id]));
    db.close();
  });

  it("excludes hidden and action user context from prompt history", async () => {
    const db = await tempDb();
    const session = testSession("session-history-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", initialInstructionContext(), "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", subagentNotificationContext(), "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "Actual searchable prompt", "2026-07-07T00:00:03.000Z"));

    const history = await db.listPromptHistory("", 10);

    expect(history.map((result) => result.text)).toEqual(["Actual searchable prompt"]);
    db.close();
  });

  it("ranks indexed prompt history by exact and token matches", async () => {
    const db = await tempDb();
    const session = testSession("session-history-ranking");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "xylophone graph", "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "graph", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 3, "user", "build a graph view", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(session.id, 4, "user", "gather rough app hints", "2026-07-07T00:00:03.000Z"));

    const history = await db.listPromptHistory("graph", 10);

    expect(history.map((result) => result.text)).toEqual(["graph", "xylophone graph", "build a graph view"]);
    db.close();
  });

  it("searches restorable session history through the prompt index", async () => {
    const db = await tempDb();
    const active = { ...testSession("session-history-active"), codexSessionId: "codex-active" };
    const missingBase = testSession("session-history-missing");
    const missing = {
      ...missingBase,
      repo: { ...missingBase.repo, branch: "muxpilot/session-task" },
      codexSessionId: "codex-missing",
      status: "missing" as const
    };
    const noCodex = testSession("session-history-no-codex");
    db.upsertSession(active, "2026-07-07T00:00:00.000Z");
    db.upsertSession(missing, "2026-07-07T00:00:00.000Z");
    db.upsertSession(noCodex, "2026-07-07T00:00:00.000Z");
    db.upsertGitWorkspace(testGitWorkspace(missing.id), "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(active.id, 1, "user", "Build indexed session history", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(missing.id, 1, "user", "Restore indexed session history", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(noCodex.id, 1, "user", "No Codex session history", "2026-07-07T00:00:03.000Z"));

    const history = await db.listSessionHistory("indexed history", 10);

    expect(history.map((result) => result.codexSessionId).sort()).toEqual(["codex-active", "codex-missing"]);
    expect(history.flatMap((result) => result.matchedPrompts.map((prompt) => prompt.text))).toEqual(
      expect.arrayContaining(["Build indexed session history", "Restore indexed session history"])
    );
    expect(history.find((result) => result.sessionId === missing.id)?.gitWorkspace).toEqual({
      id: "workspace-rekey",
      worktreePath: "/tmp/workspace-rekey",
      sessionBranch: "muxpilot/workspace-rekey",
      targetBranch: "main"
    });
    expect(history.find((result) => result.sessionId === missing.id)?.repoBranch).toBe("main");
    db.close();
  });

  it("searches restorable session history by canonical session name", async () => {
    const db = await tempDb();
    const named = {
      ...testSession("session-history-named"),
      name: "codex-app-server-runtime",
      codexSessionId: "codex-named"
    };
    const promptOnly = {
      ...testSession("session-history-prompt-only"),
      name: "unrelated-session",
      codexSessionId: "codex-prompt-only"
    };
    db.upsertSession(named, "2026-07-07T00:00:00.000Z");
    db.upsertSession(promptOnly, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(named.id, 1, "user", "Unrelated prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(promptOnly.id, 1, "user", "Investigate app server behavior", "2026-07-07T00:00:02.000Z"));

    const history = await db.listSessionHistory("app server", 10);

    expect(history.map((result) => result.sessionId)).toEqual(expect.arrayContaining([named.id, promptOnly.id]));
    expect(history.find((result) => result.sessionId === named.id)?.matchedPrompts).toEqual([]);
    expect(history.find((result) => result.sessionId === promptOnly.id)?.matchedPrompts[0]?.text).toBe("Investigate app server behavior");
    db.close();
  });

  it("keeps the same Codex session distinct across managed worktrees", async () => {
    const db = await tempDb();
    const first = { ...testSession("history-workspace-first"), codexSessionId: "shared-codex", lastActivityAt: "2026-07-07T00:00:01.000Z" };
    const second = { ...testSession("history-workspace-second"), codexSessionId: "shared-codex", lastActivityAt: "2026-07-07T00:00:02.000Z" };
    db.upsertSession(first, first.lastActivityAt);
    db.upsertSession(second, second.lastActivityAt);
    db.upsertGitWorkspace(testGitWorkspace(first.id, "workspace-first"), first.lastActivityAt);
    db.upsertGitWorkspace(testGitWorkspace(second.id, "workspace-second"), second.lastActivityAt);

    const history = await db.listSessionHistory("", 10);

    expect(history.map((result) => result.gitWorkspace?.id)).toEqual(["workspace-second", "workspace-first"]);
    db.close();
  });

  it("shares approval prefixes by repository common Git directory", async () => {
    const db = await tempDb();
    const prefix = ["pnpm", "test"];

    await db.addRepositoryApprovalRule("/repo/.git", prefix, "2026-07-10T00:00:00.000Z");

    expect(await db.hasRepositoryApprovalRule("/repo/.git", prefix)).toBe(true);
    expect(await db.hasRepositoryApprovalRule("/other/.git", prefix)).toBe(false);
    expect(await db.hasRepositoryApprovalRule("/repo/.git", ["pnpm", "install"])).toBe(false);
    db.close();
  });

  it("continues collapsing unmanaged history by Codex session", async () => {
    const db = await tempDb();
    const older = { ...testSession("history-unmanaged-old"), codexSessionId: "shared-unmanaged", lastActivityAt: "2026-07-07T00:00:01.000Z" };
    const newer = { ...testSession("history-unmanaged-new"), codexSessionId: "shared-unmanaged", lastActivityAt: "2026-07-07T00:00:02.000Z" };
    db.upsertSession(older, older.lastActivityAt);
    db.upsertSession(newer, newer.lastActivityAt);

    const history = await db.listSessionHistory("", 10);

    expect(history).toHaveLength(1);
    expect(history[0]?.sessionId).toBe(newer.id);
    db.close();
  });

  it("rekeys a managed session without duplicating transcript history", async () => {
    const db = await tempDb();
    const oldSession = { ...testSession("session-rekey-old"), codexSessionId: "codex-rekey", codexJsonlPath: "/tmp/rekey.jsonl" };
    const newSession = {
      ...oldSession,
      id: "session-rekey-new",
      name: "restored",
      status: "unknown" as const,
      archived: false
    };
    db.upsertSession({ ...oldSession, status: "missing", archived: true }, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(oldSession.id, 1, "user", "Rekey searchable prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(oldSession.id, 2, "assistant", "Rekey answer", "2026-07-07T00:00:02.000Z"));
    db.setNotificationRule("device-rekey", "session", oldSession.id, "done_task", true, "2026-07-07T00:00:04.000Z");
    db.setParserOffset("old-offset", 1234, "parser-test", "2026-07-07T00:00:05.000Z");
    db.upsertGitWorkspace(testGitWorkspace(oldSession.id), "2026-07-07T00:00:05.000Z");

    const rebound = db.rekeySession(oldSession.id, newSession, { from: "old-offset", to: "new-offset" }, "2026-07-07T00:00:06.000Z");

    expect(rebound?.id).toBe(newSession.id);
    expect(db.getSession(oldSession.id)).toBeNull();
    expect(db.listMessages(newSession.id, 0).map((message) => message.text)).toEqual(["Rekey searchable prompt", "Rekey answer"]);
    expect(db.listMessages(oldSession.id, 0)).toEqual([]);
    expect(db.listPromptHistory("rekey", 10).map((result) => result.sessionId)).toEqual([newSession.id]);
    expect(db.getNotificationSettings("device-rekey").sessionRules[newSession.id]).toEqual(["done_task"]);
    expect(db.getParserOffset("old-offset")).toBe(0);
    expect(db.getParserOffset("new-offset")).toBe(1234);
    expect(db.getGitWorkspaceBySession(newSession.id)?.id).toBe("workspace-rekey");
    expect(db.getGitWorkspaceBySession(oldSession.id)).toBeNull();
    expect(db.appendMessage(testMessage(oldSession.id, 3, "assistant", "Stale parser write"))).toBe(false);
    expect(db.listMessages(newSession.id, 0).map((message) => message.text)).toEqual(["Rekey searchable prompt", "Rekey answer"]);
    db.close();
  });

  it("returns newest prompt history for an empty query", async () => {
    const db = await tempDb();
    const session = testSession("session-history-newest");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Old prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(session.id, 2, "user", "New prompt", "2026-07-07T00:00:02.000Z"));

    const history = await db.listPromptHistory("", 1);

    expect(history.map((result) => result.text)).toEqual(["New prompt"]);
    db.close();
  });

  it("hydrates transcript size from message count", async () => {
    const db = await tempDb();
    const session = testSession("session-size");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Progress"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output"));

    const hydrated = db.getSession(session.id);

    expect(hydrated?.transcriptSize).toBe(3);
    db.close();
  });

  it("persists session input mode in session data", async () => {
    const db = await tempDb();
    const session = testSession("session-input-mode");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    const updated = db.setSessionInputMode(session.id, "plan", "2026-07-07T00:00:01.000Z");

    expect(updated?.inputMode).toBe("plan");
    expect(db.getSession(session.id)?.inputMode).toBe("plan");
    db.close();
  });

  it("persists Fast mode in session data", async () => {
    const db = await tempDb();
    const session = testSession("session-fast-mode");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    const updated = db.setSessionFastMode(session.id, true, "2026-07-07T00:00:01.000Z");

    expect(updated?.fastMode).toBe(true);
    expect(db.getSession(session.id)?.fastMode).toBe(true);
    db.close();
  });

  it("hydrates missing legacy Fast mode state as unknown", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-legacy-fast-mode") };
    delete (legacySession as Partial<ManagedSession>).fastMode;
    delete (legacySession as Partial<ManagedSession>).fastModeAvailable;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)).toMatchObject({ fastMode: null, fastModeAvailable: null });
    db.close();
  });

  it("hydrates missing legacy session model selections", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-legacy-models") };
    delete (legacySession as Partial<ManagedSession>).models;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)?.models).toEqual({
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    });
    db.close();
  });

  it("hydrates missing legacy session pin state as unpinned", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-legacy-pinned") };
    delete (legacySession as Partial<ManagedSession>).pinned;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)?.pinned).toBe(false);
    db.close();
  });

  it("hydrates and updates session initialization state", async () => {
    const db = await tempDb();
    const legacySession = { ...testSession("session-initializing") };
    delete (legacySession as Partial<ManagedSession>).initializing;
    db.upsertSession(legacySession as ManagedSession, "2026-07-07T00:00:00.000Z");

    expect(db.getSession(legacySession.id)?.initializing).toBe(false);
    expect(db.setSessionInitializing(legacySession.id, true, "2026-07-07T00:00:01.000Z")?.initializing).toBe(true);
    db.upsertSession({ ...legacySession, initializing: false }, "2026-07-07T00:00:01.500Z");
    expect(db.getSession(legacySession.id)?.initializing).toBe(true);
    expect(db.setSessionInitializing(legacySession.id, false, "2026-07-07T00:00:02.000Z")?.initializing).toBe(false);
    db.upsertSession({ ...legacySession, initializing: true }, "2026-07-07T00:00:02.500Z");
    expect(db.getSession(legacySession.id)?.initializing).toBe(false);
    db.close();
  });

  it("persists session pin state across session upserts", async () => {
    const db = await tempDb();
    const session = testSession("session-pinned");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    expect(db.setSessionPinned(session.id, true, "2026-07-07T00:00:01.000Z")?.pinned).toBe(true);
    db.upsertSession({ ...session, lastActivityAt: "2026-07-07T00:00:02.000Z" }, "2026-07-07T00:00:02.000Z");

    expect(db.getSession(session.id)?.pinned).toBe(true);
    db.close();
  });

  it("persists session model settings per collaboration mode", async () => {
    const db = await tempDb();
    const session = testSession("session-models");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");

    const normal = db.setSessionModelSettings(session.id, "default", "gpt-5.4", "medium", "2026-07-07T00:00:01.000Z");
    const plan = db.setSessionModelSettings(
      session.id,
      "plan",
      "gpt-5.5",
      "high",
      "2026-07-07T00:00:02.000Z",
      false,
      false
    );

    expect(normal?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: null, reasoningEffort: null }
    });
    expect(plan?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: "gpt-5.5", reasoningEffort: "high" }
    });
    expect(plan).toMatchObject({ fastMode: false, fastModeAvailable: false });
    expect(db.getSession(session.id)?.models).toEqual({
      default: { model: "gpt-5.4", reasoningEffort: "medium" },
      plan: { model: "gpt-5.5", reasoningEffort: "high" }
    });
    db.close();
  });

  it("persists global Normal and Plan model defaults", async () => {
    const db = await tempDb();

    expect(db.getGlobalModelSettings()).toEqual({
      default: { model: null, reasoningEffort: null },
      plan: { model: null, reasoningEffort: null }
    });
    db.setGlobalModelSettings("default", "gpt-normal", "medium", "2026-07-07T00:00:01.000Z");
    db.setGlobalModelSettings("plan", "gpt-plan", "high", "2026-07-07T00:00:02.000Z");

    expect(db.getGlobalModelSettings()).toEqual({
      default: { model: "gpt-normal", reasoningEffort: "medium" },
      plan: { model: "gpt-plan", reasoningEffort: "high" }
    });
    db.close();
  });

  it("pages recent and older transcript messages without loading the full chat", async () => {
    const db = await tempDb();
    const session = testSession("session-pages");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, sequence % 2 === 0 ? "assistant" : "user", `message ${sequence}`));
    }

    const recent = db.listRecentMessages(session.id, 3);
    const older = db.listMessagesBefore(session.id, recent.items[0]?.firstSequence ?? 0, 3);

    expect(itemSpans(recent)).toEqual([[5, 5, "message"], [6, 6, "message"], [7, 7, "message"]]);
    expect(recent.hasMoreBefore).toBe(true);
    expect(recent.hasMoreAfter).toBe(false);
    expect(itemSpans(older)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"]]);
    expect(older.hasMoreBefore).toBe(true);
    db.close();
  });

  it("loads an active transcript tail from the previous assistant output through the latest prompt", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Older answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Older tool output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 5, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 6, "user", "Current prompt"));
    for (let sequence = 7; sequence <= 16; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 4);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"],
      [5, 5, "range:stack"],
      [6, 6, "message"],
      [7, 16, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 3);
    expect(itemSpans(older)).toEqual([]);
    expect(older.hasMoreBefore).toBe(false);
    db.close();
  });

  it("backfills older visible turns when current noise collapses under the page size", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-visible-page");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "First hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Second hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "user", "Current prompt"));
    for (let sequence = 10; sequence <= 30; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 8);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"],
      [5, 5, "message"],
      [6, 6, "range:stack"],
      [7, 7, "message"],
      [8, 8, "range:stack"],
      [9, 9, "message"],
      [10, 30, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("does not show older pagination for a short active visible tail", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-short-visible");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Previous prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 6, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 80);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 4, "message"],
      [5, 5, "message"],
      [6, 6, "message"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("shows older pagination for a long transcript even when the active tail is short", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-long-visible-history");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 90; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, sequence % 2 === 0 ? "assistant" : "user", `Earlier message ${sequence}`));
    }
    db.appendMessage(testMessage(session.id, 91, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 92, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 93, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 80);

    expect(itemSpans(tail)[0]).toEqual([14, 14, "message"]);
    expect(itemSpans(tail).slice(-3)).toEqual([[91, 91, "message"], [92, 92, "message"], [93, 93, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);

    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 80);
    expect(older.items).toHaveLength(13);
    expect(older.items[0]?.firstSequence).toBe(1);
    expect(older.items.at(-1)?.lastSequence).toBe(13);
    expect(older.hasMoreBefore).toBe(false);
    db.close();
  });

  it("shows older pagination when the active tail fills the visible item page", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-full-visible-page");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Previous prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 6, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("bounds the active transcript tail by visible items", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-visible-limit");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "First hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Second hidden output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool before current prompt", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "user", "Current prompt"));
    for (let sequence = 10; sequence <= 120; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Collapsed row ${sequence}`, undefined, "tool_output"));
    }

    const tail = db.listActiveTailMessages(session.id, 3);
    const older = db.listMessagesBefore(session.id, tail.items[0]?.firstSequence ?? 0, 4);
    const activeRange = tail.items.at(-1);
    const expandedRange =
      activeRange?.type === "range" ? db.listMessageRange(session.id, activeRange.firstSequence, activeRange.lastSequence) : null;

    expect(itemSpans(tail)).toEqual([
      [5, 5, "message"],
      [6, 6, "range:stack"],
      [7, 7, "message"],
      [8, 8, "range:stack"],
      [9, 9, "message"],
      [10, 120, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.hasMoreAfter).toBe(false);
    expect(itemSpans(older)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "range:stack"],
      [4, 4, "message"]
    ]);
    expect(expandedRange?.items[0]).toMatchObject({ type: "message", message: { text: "Collapsed row 10" } });
    db.close();
  });

  it("keeps repeated assistant output visible throughout the active turn", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-assistant-churn");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Older answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool batch 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 5, "assistant", "Assistant update 1"));
    db.appendMessage(testMessage(session.id, 6, "tool", "Tool batch 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "assistant", "Assistant update 2"));
    db.appendMessage(testMessage(session.id, 8, "tool", "Tool batch 3", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 9, "assistant", "Newest assistant output"));
    db.appendMessage(testMessage(session.id, 10, "tool", "Trailing tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 10);
    const assistantMessages = tail.items.filter((item) => item.type === "message" && item.message.role === "assistant");
    const expandedRangeMessages = tail.items.flatMap((item) =>
      item.type === "range"
        ? db.listMessageRange(session.id, item.firstSequence, item.lastSequence).items.flatMap((expanded) =>
            expanded.type === "message" ? [expanded.message] : []
          )
        : []
    );

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 4, "range:activity"],
      [5, 5, "message"],
      [6, 6, "range:activity"],
      [7, 7, "message"],
      [8, 8, "range:activity"],
      [9, 9, "message"],
      [10, 10, "range:stack"]
    ]);
    expect(assistantMessages.map((item) => (item.type === "message" ? item.message.text : ""))).toEqual([
      "Older answer",
      "Assistant update 1",
      "Assistant update 2",
      "Newest assistant output"
    ]);
    expect(expandedRangeMessages.map((message) => message.text)).toEqual([
      "Tool batch 1",
      "Tool batch 2",
      "Tool batch 3",
      "Trailing tool output"
    ]);
    expect(expandedRangeMessages.some((message) => message.role === "assistant")).toBe(false);
    db.close();
  });

  it("keeps subagent notifications inside the collapsed active turn range", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-subagents");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Previous answer"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool batch 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 5, "user", subagentNotificationContext()));
    db.appendMessage(testMessage(session.id, 6, "tool", "Tool batch 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 7, "user", subagentNotificationContext()));
    db.appendMessage(testMessage(session.id, 8, "assistant", "Current answer"));

    const tail = db.listActiveTailMessages(session.id, 10);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "message"],
      [3, 3, "message"],
      [4, 7, "range:activity"],
      [8, 8, "message"]
    ]);
    expect(tail.items.find((item) => item.type === "range" && item.label.includes("subagent"))).toBeUndefined();
    db.close();
  });

  it("skips hidden user context rows when choosing the active tail prompt anchor", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-hidden-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Current assistant output"));
    db.appendMessage(testMessage(session.id, 5, "user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"]]);
    expect(tail.hasMoreBefore).toBe(true);
    db.close();
  });

  it("skips instruction plus environment context rows when choosing the active tail prompt anchor", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-instruction-context");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Prior assistant output"));
    db.appendMessage(testMessage(session.id, 3, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Current assistant output"));
    db.appendMessage(testMessage(session.id, 5, "user", initialInstructionContext()));

    const tail = db.listActiveTailMessages(session.id, 4);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "message"], [4, 4, "message"], [5, 5, "user_action"]]);
    expect(tail.hasMoreBefore).toBe(true);
    db.close();
  });

  it("starts active tail at the latest visible prompt when there is no prior assistant output", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-no-output");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "tool", "Initial system-ish output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 2, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 2);

    expect(itemSpans(tail)).toEqual([[2, 2, "message"], [3, 3, "range:activity"]]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("deduplicates progress and response records across the active-tail pagination boundary", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-duplicate-progress");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Older prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "Checking files", undefined, "assistant_update"));
    db.appendMessage(testMessage(session.id, 3, "assistant", "Checking files", undefined, "assistant"));
    db.appendMessage(testMessage(session.id, 4, "user", "Current prompt"));
    db.appendMessage(testMessage(session.id, 5, "tool", "Tool output", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 3);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [3, 3, "message"],
      [4, 4, "message"],
      [5, 5, "range:activity"]
    ]);
    expect(tail.hasMoreBefore).toBe(false);
    db.close();
  });

  it("falls back to a fixed recent page when active tail has no visible prompt", async () => {
    const db = await tempDb();
    const session = testSession("session-active-tail-no-prompt");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "tool", "Tool 1", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 2, "tool", "Tool 2", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool 3", undefined, "tool_output"));

    const tail = db.listActiveTailMessages(session.id, 2);

    expect(itemSpans(tail)).toEqual([[1, 3, "range:stack"]]);
    expect(tail.hasMoreBefore).toBe(false);
    expect(tail.hasMoreAfter).toBe(false);
    db.close();
  });

  it("keeps question requests outside collapsed transcript ranges", async () => {
    const db = await tempDb();
    const session = testSession("session-question-request-range");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "tool", "Tool before question", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 3, "system", "Question requested", undefined, "question_request"));
    db.appendMessage(testMessage(session.id, 4, "tool", "Tool after question", undefined, "tool_output"));

    const tail = db.listRecentMessages(session.id, 10);

    expect(itemSpans(tail)).toEqual([
      [1, 1, "message"],
      [2, 2, "range:activity"],
      [3, 3, "message"],
      [4, 4, "range:activity"]
    ]);
    db.close();
  });

  it("pages earliest and newer transcript messages without loading the full chat", async () => {
    const db = await tempDb();
    const session = testSession("session-pages-forward");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "user", `message ${sequence}`));
    }

    const earliest = db.listEarliestMessages(session.id, 3);
    const newer = db.listMessagesAfterPage(session.id, earliest.items.at(-1)?.lastSequence ?? 0, 3);

    expect(itemSpans(earliest)).toEqual([[1, 1, "message"], [2, 2, "message"], [3, 3, "message"]]);
    expect(earliest.hasMoreBefore).toBe(false);
    expect(earliest.hasMoreAfter).toBe(true);
    expect(itemSpans(newer)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(newer.hasMoreAfter).toBe(true);
    db.close();
  });

  it("searches the full persisted transcript and returns match metadata", async () => {
    const db = await tempDb();
    const session = testSession("session-transcript-search");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    await db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    await db.appendMessage(testMessage(session.id, 2, "assistant", "Intermediate answer"));
    await db.appendMessage(testMessage(session.id, 3, "tool", "Tool output with distant needle", undefined, "tool_output"));
    await db.appendMessage(testMessage(session.id, 4, "assistant", "<oai-mem-citation>needle hidden metadata</oai-mem-citation>"));
    await db.appendMessage(testMessage(session.id, 5, "user", initialInstructionContext()));

    const search = await db.searchMessages(session.id, "needle", 10);

    expect(search.total).toBe(1);
    expect(search.matches).toEqual([
      expect.objectContaining({
        sequence: 3,
        messageId: `${session.id}-3`,
        itemId: `${session.id}-3`,
        preview: expect.stringContaining("distant needle")
      })
    ]);
    db.close();
  });

  it("loads a bounded expanded transcript page around a search match", async () => {
    const db = await tempDb();
    const session = testSession("session-transcript-around");
    await db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      const role = sequence === 1 || sequence === 9 ? "user" : "tool";
      const type = role === "tool" ? "tool_output" : "user";
      await db.appendMessage(testMessage(session.id, sequence, role, `message ${sequence}`, undefined, type));
    }

    const page = await db.listMessagesAround(session.id, 5, 3);

    expect(itemSpans(page)).toEqual([[4, 4, "message"], [5, 5, "message"], [6, 6, "message"]]);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(true);
    db.close();
  });

  it("keeps assistant activity visible when a newer transcript page starts mid-turn", async () => {
    const db = await tempDb();
    const session = testSession("session-newer-page-mid-turn");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "Prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    db.appendMessage(testMessage(session.id, 3, "tool", "Tool output", undefined, "tool_output"));
    db.appendMessage(testMessage(session.id, 4, "assistant", "Second answer"));
    db.appendMessage(testMessage(session.id, 5, "user", "Next prompt"));

    const newer = db.listMessagesAfterPage(session.id, 1, 10);

    expect(itemSpans(newer)).toEqual([
      [2, 2, "message"],
      [3, 3, "range:activity"],
      [4, 4, "message"],
      [5, 5, "message"]
    ]);
    db.close();
  });

  it("applies transcript page limits to collapsed visible items instead of raw messages", async () => {
    const db = await tempDb();
    const session = testSession("session-visible-item-pages");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendMessage(testMessage(session.id, 1, "user", "First prompt"));
    db.appendMessage(testMessage(session.id, 2, "assistant", "First answer"));
    for (let sequence = 3; sequence <= 20; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `First hidden row ${sequence}`, undefined, "tool_output"));
    }
    db.appendMessage(testMessage(session.id, 21, "user", "Second prompt"));
    db.appendMessage(testMessage(session.id, 22, "assistant", "Second answer"));
    for (let sequence = 23; sequence <= 40; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "tool", `Second hidden row ${sequence}`, undefined, "tool_output"));
    }

    const recent = db.listRecentMessages(session.id, 4);
    const older = db.listMessagesBefore(session.id, recent.items[0]?.firstSequence ?? 0, 4);

    expect(itemSpans(recent)).toEqual([
      [3, 20, "range:stack"],
      [21, 21, "message"],
      [22, 22, "message"],
      [23, 40, "range:stack"]
    ]);
    expect(recent.hasMoreBefore).toBe(true);
    expect(itemSpans(older)).toEqual([[1, 1, "message"], [2, 2, "message"]]);
    expect(older.hasMoreBefore).toBe(false);
    expect(older.hasMoreAfter).toBe(true);
    db.close();
  });

  it("reports no older transcript page when the oldest row is loaded", async () => {
    const db = await tempDb();
    const session = testSession("session-page-end");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      db.appendMessage(testMessage(session.id, sequence, "user", `message ${sequence}`));
    }

    const recent = db.listRecentMessages(session.id, 5);

    expect(itemSpans(recent)).toEqual([[1, 1, "message"], [2, 2, "message"], [3, 3, "message"]]);
    expect(recent.hasMoreBefore).toBe(false);
    expect(recent.hasMoreAfter).toBe(false);
    db.close();
  });

  it("sorts sessions by latest session activity", async () => {
    const db = await tempDb();
    const olderUserInput = testSession("older-user-input");
    const newerSessionActivity = testSession("newer-session-activity");
    db.upsertSession(olderUserInput, "2026-07-07T00:00:00.000Z");
    db.upsertSession(newerSessionActivity, "2026-07-07T00:00:00.000Z");

    db.appendMessage(testMessage(olderUserInput.id, 1, "user", "Older user prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(olderUserInput.id, 2, "assistant", "Later assistant answer", "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(newerSessionActivity.id, 1, "user", "Newer user prompt", "2026-07-07T00:00:02.000Z"));
    db.appendMessage(testMessage(newerSessionActivity.id, 2, "tool", "Tool output", "2026-07-07T00:00:05.000Z", "tool_output"));

    const sessions = db.listSessions();

    expect(sessions.map((session) => session.id)).toEqual([newerSessionActivity.id, olderUserInput.id]);
    expect(sessions[0]?.lastActivityAt).toBe("2026-07-07T00:00:05.000Z");
    expect(sessions[1]?.lastActivityAt).toBe("2026-07-07T00:00:04.000Z");
    db.close();
  });

  it("keeps summaries and previews limited to displayable prompts", async () => {
    const db = await tempDb();
    const contextOnly = testSession("context-only");
    const realPrompt = testSession("real-prompt");
    db.upsertSession(contextOnly, "2026-07-07T00:00:00.000Z");
    db.upsertSession(realPrompt, "2026-07-07T00:00:00.000Z");

    db.appendMessage(testMessage(contextOnly.id, 1, "user", initialInstructionContext(), "2026-07-07T00:00:04.000Z"));
    db.appendMessage(testMessage(realPrompt.id, 1, "user", "Actual prompt", "2026-07-07T00:00:01.000Z"));
    db.appendMessage(testMessage(realPrompt.id, 2, "user", initialInstructionContext(), "2026-07-07T00:00:05.000Z"));

    const sessions = db.listSessions();

    const realPromptSession = sessions.find((session) => session.id === realPrompt.id);
    const contextOnlySession = sessions.find((session) => session.id === contextOnly.id);
    expect(realPromptSession?.lastActivityAt).toBe("2026-07-07T00:00:05.000Z");
    expect(realPromptSession?.recentUserPrompts).toEqual(["Actual prompt"]);
    expect(contextOnlySession?.lastActivityAt).toBe("2026-07-07T00:00:04.000Z");
    expect(contextOnlySession?.recentUserPrompts).toEqual([]);
    db.close();
  });
});

describe("AppDatabase remote access settings", () => {
  it("defaults unrestricted remote access to disabled", async () => {
    const db = await tempDb();

    expect(await db.getUnrestrictedRemoteAccessEnabled()).toBe(false);
    db.close();
  });

  it("persists unrestricted remote access enablement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);

    await db.setUnrestrictedRemoteAccessEnabled(true);
    expect(await db.getUnrestrictedRemoteAccessEnabled()).toBe(true);
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.getUnrestrictedRemoteAccessEnabled()).toBe(true);
    await restarted.setUnrestrictedRemoteAccessEnabled(false);
    expect(await restarted.getUnrestrictedRemoteAccessEnabled()).toBe(false);
    restarted.close();
  });
});

describe("AppDatabase queued inputs", () => {
  it("preserves the delegating agent while an input waits in the queue", async () => {
    const db = await tempDb();
    const session = testSession("session-agent-queue");
    await db.upsertSession(session, "2026-08-25T00:00:00.000Z");
    const input = testQueuedInput(session.id, {
      id: "agent-queued-1",
      text: "Delegated follow-up",
      status: "queued",
      actorSessionId: "parent-session"
    });

    await db.appendQueuedInput(input);

    expect(await db.getQueuedInput(session.id, input.id)).toEqual(input);
    await db.close();
  });

  it("clears sent queued inputs after a normalized transcript echo", async () => {
    const db = await tempDb();
    const session = testSession("session-queue-normalized");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    db.appendQueuedInput(
      testQueuedInput(session.id, {
        id: "queued-1",
        text: "Fix repo validation gaps:\n\n:add prettier to UI dev dependencies",
        status: "sent",
        createdAt: "2026-07-07T00:00:01.000Z",
        updatedAt: "2026-07-07T00:00:03.000Z",
        sentAt: "2026-07-07T00:00:03.000Z"
      })
    );
    db.appendMessage(
      testMessage(
        session.id,
        1,
        "user",
        "Fix repo validation gaps\n\nadd prettier to UI dev dependencies",
        "2026-07-07T00:00:02.000Z"
      )
    );

    expect(await db.deleteEchoedSentQueuedInputs(session.id)).toBe(1);
    expect(await db.listQueuedInputs(session.id)).toEqual([]);
    db.close();
  });

  it("keeps sent queued inputs when later user messages are unrelated", async () => {
    const db = await tempDb();
    const session = testSession("session-queue-unrelated");
    db.upsertSession(session, "2026-07-07T00:00:00.000Z");
    const input = testQueuedInput(session.id, {
      id: "queued-1",
      text: "Implement the custom integration route tests",
      status: "sent",
      createdAt: "2026-07-07T00:00:01.000Z",
      updatedAt: "2026-07-07T00:00:02.000Z",
      sentAt: "2026-07-07T00:00:02.000Z"
    });
    db.appendQueuedInput(input);
    db.appendMessage(testMessage(session.id, 1, "user", "Open the notification settings", "2026-07-07T00:00:03.000Z"));

    expect(await db.deleteEchoedSentQueuedInputs(session.id)).toBe(0);
    expect(await db.listQueuedInputs(session.id)).toEqual([input]);
    db.close();
  });
});

describe("AppDatabase notifications", () => {
  it("persists global and per-session notification rules", async () => {
    const db = await tempDb();
    const deviceId = "device-test";

    expect(await db.getNotificationSettings(deviceId)).toEqual({ globalRules: [], sessionRules: {}, delivery: { pushEnabled: false, soundEnabled: true } });
    await db.setNotificationRule(deviceId, "global", null, "status_change", true, "2026-07-08T00:00:00.000Z");
    await db.setNotificationRule(deviceId, "session", "session-1", "done_task", true, "2026-07-08T00:00:01.000Z");
    await db.setNotificationRule(deviceId, "session", "session-1", "approval_gate", true, "2026-07-08T00:00:02.000Z");

    expect(await db.getNotificationSettings(deviceId)).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate", "done_task"] },
      delivery: { pushEnabled: false, soundEnabled: true }
    });

    await db.setNotificationRule(deviceId, "session", "session-1", "done_task", false, "2026-07-08T00:00:03.000Z");
    expect(await db.getNotificationSettings(deviceId)).toEqual({
      globalRules: ["status_change"],
      sessionRules: { "session-1": ["approval_gate"] },
      delivery: { pushEnabled: false, soundEnabled: true }
    });
    db.close();
  });

  it("keeps notification settings separate per device", async () => {
    const db = await tempDb();

    await db.setNotificationRule("device-one", "global", null, "status_change", true, "2026-07-08T00:00:00.000Z");
    await db.setNotificationRule("device-two", "session", "session-1", "done_task", true, "2026-07-08T00:00:01.000Z");
    await db.setNotificationDeliverySetting("device-two", "sound", false, "2026-07-08T00:00:02.000Z");
    await db.setNotificationDeliverySetting("device-two", "push", true, "2026-07-08T00:00:03.000Z");

    expect(await db.getNotificationSettings("device-one")).toEqual({
      globalRules: ["status_change"],
      sessionRules: {},
      delivery: { pushEnabled: false, soundEnabled: true }
    });
    expect(await db.getNotificationSettings("device-two")).toEqual({
      globalRules: [],
      sessionRules: { "session-1": ["done_task"] },
      delivery: { pushEnabled: true, soundEnabled: false }
    });
    expect(await db.listNotificationSettings()).toEqual({
      "device-one": {
        globalRules: ["status_change"],
        sessionRules: {},
        delivery: { pushEnabled: false, soundEnabled: true }
      },
      "device-two": {
        globalRules: [],
        sessionRules: { "session-1": ["done_task"] },
        delivery: { pushEnabled: true, soundEnabled: false }
      }
    });
    db.close();
  });

  it("persists push subscriptions and VAPID keys", async () => {
    const db = await tempDb();
    const deviceId = "device-test";
    const subscription = {
      endpoint: "https://example.test/push/1",
      expirationTime: null,
      keys: { p256dh: "p256dh", auth: "auth" }
    };

    await db.upsertPushSubscription(deviceId, subscription, "2026-07-08T00:00:00.000Z");
    await db.setPushVapidKeys({ publicKey: "public", privateKey: "private" }, "2026-07-08T00:00:01.000Z");

    expect(await db.listPushSubscriptions(deviceId)).toEqual([{ ...subscription, deviceId }]);
    expect(await db.getPushVapidKeys()).toEqual({ publicKey: "public", privateKey: "private" });
    await db.deletePushSubscription(deviceId, subscription.endpoint);
    expect(await db.listPushSubscriptions(deviceId)).toEqual([]);
    db.close();
  });
});

describe("AppDatabase touched repositories", () => {
  it("persists dismissals until the directory is touched again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);
    const repository = {
      path: "/repo/old",
      label: "old",
      repoRoot: "/repo/old",
      branch: "main",
      lastActivityAt: "2026-07-08T00:00:00.000Z"
    };

    await db.upsertTouchedRepository(repository, "2026-07-08T00:00:00.000Z");
    await db.dismissSessionDirectory(repository.path, "2026-07-08T01:00:00.000Z");
    expect(await db.listDismissedSessionDirectories()).toEqual([repository.path]);
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listDismissedSessionDirectories()).toEqual([repository.path]);
    await restarted.upsertTouchedRepository(
      { ...repository, lastActivityAt: "2026-07-08T00:30:00.000Z" },
      "2026-07-08T03:00:00.000Z"
    );
    expect(await restarted.listDismissedSessionDirectories()).toEqual([repository.path]);
    await restarted.upsertTouchedRepository(
      { ...repository, lastActivityAt: "2026-07-08T02:00:00.000Z" },
      "2026-07-08T03:00:00.000Z"
    );
    expect(await restarted.listDismissedSessionDirectories()).toEqual([]);
    restarted.close();
  });

  it("persists touched repositories in recency order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);

    await db.upsertTouchedRepository(
      {
        path: "/repo/older",
        label: "older",
        repoRoot: "/repo/older",
        branch: "main",
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      },
      "2026-07-08T00:00:00.000Z"
    );
    await db.upsertTouchedRepository(
      {
        path: "/repo/newer",
        label: "newer",
        repoRoot: "/repo/newer",
        branch: "dev",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      "2026-07-08T01:00:00.000Z"
    );
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listTouchedRepositories()).toEqual([
      {
        path: "/repo/newer",
        label: "newer",
        repoRoot: "/repo/newer",
        branch: "dev",
        source: "recent",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      {
        path: "/repo/older",
        label: "older",
        repoRoot: "/repo/older",
        branch: "main",
        source: "recent",
        lastActivityAt: "2026-07-08T00:00:00.000Z"
      }
    ]);
    restarted.close();
  });

  it("keeps the latest repository activity when an older touch is upserted", async () => {
    const db = await tempDb();

    await db.upsertTouchedRepository(
      {
        path: "/repo",
        label: "repo",
        repoRoot: "/repo",
        branch: "main",
        lastActivityAt: "2026-07-08T02:00:00.000Z"
      },
      "2026-07-08T02:00:00.000Z"
    );
    await db.upsertTouchedRepository(
      {
        path: "/repo",
        label: "repo-renamed",
        repoRoot: "/repo",
        branch: "stage",
        lastActivityAt: "2026-07-08T01:00:00.000Z"
      },
      "2026-07-08T03:00:00.000Z"
    );

    expect(await db.listTouchedRepositories()).toEqual([
      {
        path: "/repo",
        label: "repo-renamed",
        repoRoot: "/repo",
        branch: "stage",
        source: "recent",
        lastActivityAt: "2026-07-08T02:00:00.000Z"
      }
    ]);
    db.close();
  });

  it("backfills touched repositories from existing managed sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
    const path = join(dir, "test.db");
    const db = new AppDatabase(path);
    await db.upsertSession(
      {
        ...testSession("session-1"),
        repo: { root: "/repo/backfilled", name: "backfilled", branch: "main", dirty: false, worktree: null },
        cwd: "/repo/backfilled",
        lastActivityAt: "2026-07-08T04:00:00.000Z"
      },
      "2026-07-08T04:00:01.000Z"
    );
    await db.dismissSessionDirectory("/repo/backfilled", "2026-07-08T05:00:00.000Z");
    db.close();

    const restarted = new AppDatabase(path);
    expect(await restarted.listDismissedSessionDirectories()).toEqual(["/repo/backfilled"]);
    expect(await restarted.listTouchedRepositories()).toEqual([
      {
        path: "/repo/backfilled",
        label: "backfilled",
        repoRoot: "/repo/backfilled",
        branch: "main",
        source: "recent",
        lastActivityAt: "2026-07-08T04:00:00.000Z"
      }
    ]);
    restarted.close();
  });
});

async function tempDb(): Promise<AppDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "muxpilot-db-"));
  return new AppDatabase(join(dir, "test.db"));
}

function itemSpans(page: TranscriptPageResponse): Array<[number, number, string]> {
  return page.items.map((item) => [
    item.firstSequence,
    item.lastSequence,
    item.type === "range" ? `range:${item.rangeKind}` : item.type
  ]);
}

function testSession(id: string): ManagedSession {
  return {
    id,
    name: id,
    cwd: "/repo",
    provider: { kind: "codex", threadId: "codex-session", rolloutPath: "/tmp/codex.jsonl" },
    runtime: {
      kind: "systemd_service",
      unit: `muxpilot-codex-${id}.service`,
      socketPath: `/tmp/${id}.sock`,
      state: "connected",
      codexVersion: "0.152.0"
    },
    repo: {
      root: "/repo",
      name: "repo",
      branch: "main",
      dirty: false,
      worktree: null
    },
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex.jsonl",
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

function sessionHistoryResult(session: ManagedSession): SessionHistoryResult {
  return {
    sessionId: session.id,
    codexSessionId: session.codexSessionId ?? "",
    codexJsonlPath: session.codexJsonlPath,
    status: session.status,
    archived: session.archived,
    sessionName: session.name,
    repoName: session.repo.name,
    repoBranch: session.repo.branch,
    cwd: session.cwd,
    lastActivityAt: session.lastActivityAt,
    transcriptSize: session.transcriptSize,
    matchedPrompts: [],
    gitWorkspace: null
  };
}

function testMessage(
  sessionId: string,
  sequence: number,
  role: ChatMessage["role"],
  text: string,
  timestamp = `2026-07-07T00:00:0${sequence}.000Z`,
  type: ChatMessage["type"] = role === "user" ? "user" : "assistant"
): ChatMessage {
  return {
    id: `${sessionId}-${sequence}`,
    sessionId,
    sequence,
    type,
    role,
    timestamp,
    text,
    payload: {}
  };
}

function testQueuedInput(sessionId: string, input: Partial<QueuedInput> & Pick<QueuedInput, "id" | "text" | "status">): QueuedInput {
  return {
    sessionId,
    mode: "default",
    error: null,
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex.jsonl",
    actorSessionId: null,
    createdAt: "2026-07-07T00:00:01.000Z",
    updatedAt: "2026-07-07T00:00:01.000Z",
    sentAt: null,
    ...input
  };
}

function testGitWorkspace(sessionId: string, workspaceId = "workspace-rekey"): StoredGitWorkspace {
  const timestamp = "2026-07-07T00:00:05.000Z";
  return {
    id: workspaceId,
    sessionId,
    commonGitDir: "/repo/.git",
    helperToken: "test-helper-token",
    createdAt: timestamp,
    updatedAt: timestamp,
    summary: {
      workflowVersion: 1,
      id: workspaceId,
      state: "worktree",
      entryPath: "/repo",
      repoRoot: "/repo",
      targetBranch: "main",
      targetSha: "a".repeat(40),
      sessionBranch: `muxpilot/${workspaceId}`,
      worktreePath: `/tmp/${workspaceId}`,
      lastError: null,
      updatedAt: timestamp,
      dependencyLinks: []
    }
  };
}

function initialInstructionContext(): string {
  return [
    "# AGENTS.md instructions for /home/dev/workspace/teamweave",
    "",
    "<INSTRUCTIONS>",
    "# Repository Guidelines",
    "",
    "## Directory-Local Rules",
    "Before changing files in a directory, read that directory's AGENTS.md.",
    "</INSTRUCTIONS>",
    "",
    "<environment_context>",
    "  <cwd>/home/dev/workspace/teamweave</cwd>",
    "  <shell>bash</shell>",
    "</environment_context>"
  ].join("\n");
}

function subagentNotificationContext(): string {
  return [
    "<subagent_notification>",
    JSON.stringify({
      agent_path: "019f428a-0df4-7ef3-acd5-ec042babc237",
      status: {
        completed: "Regression pass found no blocking issues in the staged diff."
      }
    }),
    "</subagent_notification>"
  ].join("\n");
}
