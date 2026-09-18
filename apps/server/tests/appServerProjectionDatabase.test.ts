import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db/database.js";

describe("app-server projection persistence", () => {
  it("loads durable intentional interruption kinds by exact thread and turn", async () => {
    const { db, sessionId } = await projectionDb();
    expect(await db.getAppServerTurnInterruptionKind(sessionId, "thread-1", "turn-1")).toBeNull();
    await db.appendMessage({
      id: "budget-interruption",
      sessionId,
      sequence: 1,
      type: "status",
      role: "system",
      timestamp: "2026-09-01T00:00:01.000Z",
      text: "Turn interrupted because the agent work-token budget was exhausted.",
      payload: {
        interruption: {
          kind: "budget_guard",
          threadId: "thread-1",
          turnId: "turn-1",
          observedAt: "2026-09-01T00:00:01.000Z"
        }
      }
    });

    expect(await db.getAppServerTurnInterruptionKind(sessionId, "thread-1", "turn-1")).toBe("budget_guard");
    expect(await db.getAppServerTurnInterruptionKind(sessionId, "thread-1", "turn-other")).toBeNull();
    await db.close();
  });

  it("atomically applies completed content and replay-safe reconciliation state", async () => {
    const { db, path, sessionId } = await projectionDb();
    const projection = {
      sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      clientMessageId: "client-message-1",
      method: "item/completed",
      status: "generating" as const,
      message: {
        id: "stable-agent-1",
        type: "assistant" as const,
        role: "assistant" as const,
        timestamp: "2026-09-01T00:00:01.000Z",
        text: "Authoritative answer",
        payload: {
          source: "codex_app_server",
          codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1" },
          appServerIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1" }
        }
      },
      evidence: { item: { id: "agent-1", type: "agentMessage" } },
      observedAt: "2026-09-01T00:00:02.000Z"
    };

    expect(await db.applyAppServerProjection(projection)).toMatchObject({
      messageInserted: true,
      messageChanged: true,
      statusChanged: true,
      message: { id: "stable-agent-1", sequence: 1 },
      state: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", status: "generating" }
    });
    expect(await db.applyAppServerProjection({
      ...projection,
      clientMessageId: null,
      status: null,
      evidence: { replayed: true },
      observedAt: "2026-09-01T00:00:03.000Z"
    })).toMatchObject({
      messageInserted: false,
      messageChanged: false,
      statusChanged: false,
      message: null,
      state: {
        clientMessageId: null,
        status: "generating",
        evidence: { replayed: true },
        observedAt: "2026-09-01T00:00:03.000Z"
      }
    });
    expect((await db.listRecentMessages(sessionId, 10)).items).toHaveLength(1);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT status FROM managed_sessions WHERE id = ?").get(sessionId)).toEqual({ status: "generating" });
    expect(raw.prepare(
      "SELECT method, evidence_json, observed_at FROM app_server_reconciliation WHERE session_id = ?"
    ).get(sessionId)).toEqual({
      method: "item/completed",
      evidence_json: JSON.stringify({ replayed: true }),
      observed_at: "2026-09-01T00:00:03.000Z"
    });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId)).toEqual({ count: 1 });
    raw.close();
  });

  it("upgrades a rollout row in place when authoritative app-server content arrives", async () => {
    const { db, path, sessionId } = await projectionDb();
    const rolloutPayload = {
      type: "response_item",
      payload: { id: "agent-1", type: "message", role: "assistant" },
      codexItemIdentity: { turnId: "turn-1", itemId: "agent-1", clientMessageId: null }
    };
    expect(await db.appendMessage({
      id: "rollout-message-1",
      sessionId,
      sequence: 1,
      type: "assistant",
      role: "assistant",
      timestamp: "2026-09-01T00:00:01.000Z",
      text: "rollout copy",
      payload: rolloutPayload
    })).toBe(true);

    expect(await db.applyAppServerProjection(projectionInput(sessionId))).toMatchObject({
      messageInserted: false,
      messageChanged: true,
      message: {
        id: "rollout-message-1",
        sequence: 1,
        text: "Authoritative answer",
        payload: { source: "codex_app_server" }
      }
    });
    expect(await db.listMessages(sessionId)).toMatchObject([
      { id: "rollout-message-1", sequence: 1, text: "Authoritative answer" }
    ]);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const item = raw.prepare(
      `SELECT message_id, app_server_message_id, rollout_message_id
       FROM codex_item_messages WHERE session_id = ?`
    ).get(sessionId);
    expect(item).toEqual({
      message_id: "rollout-message-1",
      app_server_message_id: "stable-agent-1",
      rollout_message_id: "rollout-message-1"
    });
    raw.close();
  });

  it("durably retains late rollout evidence without duplicating an app-server message", async () => {
    const { db, path, sessionId } = await projectionDb();
    expect(await db.applyAppServerProjection(projectionInput(sessionId))).toMatchObject({
      messageInserted: true,
      messageChanged: true
    });
    expect(await db.appendMessage({
      id: "late-rollout-message",
      sessionId,
      sequence: 2,
      type: "assistant",
      role: "assistant",
      timestamp: "2026-09-01T00:00:03.000Z",
      text: "late rollout copy",
      payload: {
        type: "response_item",
        codexItemIdentity: { turnId: "turn-1", itemId: "agent-1", clientMessageId: null }
      }
    })).toBe(false);
    expect((await db.listRecentMessages(sessionId, 10)).items).toHaveLength(1);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM codex_item_messages
       WHERE session_id = ? AND app_server_message_id IS NOT NULL AND rollout_message_id IS NOT NULL`
    ).get(sessionId)).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId)).toEqual({ count: 1 });
    raw.close();
  });

  it("reconciles a late rollout plan whose item id differs from the live plan", async () => {
    const { db, path, sessionId } = await projectionDb();
    expect(await db.applyAppServerProjection(planProjectionInput(sessionId))).toMatchObject({
      messageInserted: true,
      messageChanged: true
    });
    expect(await db.appendMessage(rolloutPlanMessage(sessionId, 2))).toBe(false);
    expect(await db.listMessages(sessionId)).toMatchObject([
      { id: "app-server-plan", sequence: 1, text: "<proposed_plan>\nBuild it\n</proposed_plan>" }
    ]);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      `SELECT item_id, app_server_message_id, rollout_message_id
       FROM codex_item_messages WHERE session_id = ?`
    ).get(sessionId)).toEqual({
      item_id: "turn-1-plan",
      app_server_message_id: "app-server-plan",
      rollout_message_id: "rollout-plan"
    });
    raw.close();
  });

  it("upgrades an earlier rollout plan when the differently identified live plan arrives", async () => {
    const { db, path, sessionId } = await projectionDb();
    expect(await db.appendMessage(rolloutPlanMessage(sessionId, 1))).toBe(true);
    expect(await db.applyAppServerProjection(planProjectionInput(sessionId))).toMatchObject({
      messageInserted: false,
      messageChanged: true,
      message: { id: "rollout-plan", sequence: 1 }
    });
    expect(await db.listMessages(sessionId)).toMatchObject([
      { id: "rollout-plan", sequence: 1, text: "<proposed_plan>\nBuild it\n</proposed_plan>" }
    ]);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      `SELECT item_id, app_server_message_id, rollout_message_id
       FROM codex_item_messages WHERE session_id = ?`
    ).get(sessionId)).toEqual({
      item_id: "rollout-plan-item",
      app_server_message_id: "app-server-plan",
      rollout_message_id: "rollout-plan"
    });
    raw.close();
  });

  it("keeps a revised plan from the same turn as a distinct message", async () => {
    const { db, sessionId } = await projectionDb();
    expect(await db.applyAppServerProjection(planProjectionInput(sessionId))).toMatchObject({ messageInserted: true });
    const revised = rolloutPlanMessage(sessionId, 2);
    revised.text = "<proposed_plan>\nBuild it differently\n</proposed_plan>";
    expect(await db.appendMessage(revised)).toBe(true);
    expect(await db.listMessages(sessionId)).toHaveLength(2);
    await db.close();
  });

  it("reconciles native and rollout plan ids by turn and normalized content", async () => {
    const { db, sessionId } = await projectionDb();
    const planText = "<proposed_plan>\n# Build it\n\nProceed.\n</proposed_plan>";
    await db.applyAppServerProjection({
      ...projectionInput(sessionId),
      itemId: "turn-1-plan",
      message: {
        ...projectionInput(sessionId).message,
        id: "native-plan",
        text: planText,
        payload: {
          source: "codex_app_server",
          codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "turn-1-plan" },
          appServerIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "turn-1-plan" }
        }
      }
    });

    expect(await db.appendMessage({
      id: "rollout-plan",
      sessionId,
      sequence: 2,
      type: "assistant",
      role: "assistant",
      timestamp: "2026-09-01T00:00:02.004Z",
      text: `${planText}\n\n<oai-mem-citation>ignored</oai-mem-citation>`,
      payload: {
        type: "response_item",
        codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "rollout-message-id" }
      }
    })).toBe(false);
    expect(await db.listMessages(sessionId)).toMatchObject([{ id: "native-plan", text: planText }]);
    await db.close();
  });

  it("repairs persisted duplicate plans and backfills an unambiguous implementation decision", async () => {
    const { db, path, sessionId } = await projectionDb();
    const planText = "<proposed_plan>\n# Existing plan\n</proposed_plan>";
    await db.appendMessage({
      id: "existing-native-plan",
      sessionId,
      sequence: 1,
      type: "assistant",
      role: "assistant",
      timestamp: "2026-09-01T00:00:01.000Z",
      text: planText,
      payload: {
        source: "codex_app_server",
        codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "turn-1-plan" }
      }
    });
    await db.close();

    const raw = new DatabaseSync(path);
    raw.prepare(
      `INSERT INTO messages (id, session_id, sequence, type, role, timestamp, text, payload_json)
       VALUES (?, ?, 2, 'assistant', 'assistant', ?, ?, ?)`
    ).run(
      "existing-rollout-plan",
      sessionId,
      "2026-09-01T00:00:01.004Z",
      planText,
      JSON.stringify({ codexItemIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "rollout-plan-message" } })
    );
    raw.prepare(
      `INSERT INTO codex_item_messages
        (session_id, thread_id, turn_id, item_id, message_id, rollout_message_id, rollout_observed_at)
       VALUES (?, 'thread-1', 'turn-1', 'rollout-plan-message', 'existing-rollout-plan', 'existing-rollout-plan', ?)`
    ).run(sessionId, "2026-09-01T00:00:01.004Z");
    raw.prepare(
      `INSERT INTO messages (id, session_id, sequence, type, role, timestamp, text, payload_json)
       VALUES ('implementation-input', ?, 3, 'user', 'user', ?, 'Implement the plan.', '{}')`
    ).run(sessionId, "2026-09-01T00:00:02.000Z");
    raw.close();

    const reopened = new AppDatabase(path);
    expect(await reopened.listMessages(sessionId)).toMatchObject([
      {
        id: "existing-native-plan",
        payload: { interactionOutcome: { kind: "plan", status: "answered", decision: "implement" } }
      },
      { id: "implementation-input" }
    ]);
    expect(await reopened.latestPlanReadyMessage(sessionId)).toBeNull();
    await reopened.close();
  });

  it("upgrades a rollout question by its wire call id instead of creating a second prompt", async () => {
    const { db, path, sessionId } = await projectionDb();
    expect(await db.appendMessage({
      id: "rollout-question",
      sessionId,
      sequence: 1,
      type: "question_request",
      role: "system",
      timestamp: "2026-09-01T00:00:01.000Z",
      text: "Question requested\nChoice: Continue?",
      payload: {
        question: {
          id: "call-question",
          questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }]
        },
        codexItemIdentity: { turnId: "turn-1", itemId: "fc-question", clientMessageId: null }
      }
    })).toBe(true);

    expect(await db.applyAppServerProjection(questionProjectionInput(sessionId))).toMatchObject({
      messageInserted: false,
      messageChanged: true,
      message: {
        id: "rollout-question",
        sequence: 1,
        text: "Codex needs your input",
        payload: { source: "codex_app_server", question: { requestId: 0 } }
      }
    });
    expect(await db.listMessages(sessionId)).toHaveLength(1);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      `SELECT item_id, message_id, app_server_message_id, rollout_message_id
       FROM codex_item_messages WHERE session_id = ?`
    ).get(sessionId)).toEqual({
      item_id: "call-question",
      message_id: "rollout-question",
      app_server_message_id: "app-server-question",
      rollout_message_id: "rollout-question"
    });
    raw.close();
  });

  it("removes already-persisted duplicate rollout questions when reopening", async () => {
    const { db, path, sessionId } = await projectionDb();
    await db.appendMessage({
      id: "legacy-rollout-question",
      sessionId,
      sequence: 1,
      type: "question_request",
      role: "system",
      timestamp: "2026-09-01T00:00:01.000Z",
      text: "Question requested",
      payload: {
        question: { id: "call-question", questions: [] },
        codexItemIdentity: { turnId: "turn-1", itemId: "fc-question", clientMessageId: null }
      }
    });
    await db.close();
    const raw = new DatabaseSync(path);
    raw.prepare(
      `INSERT INTO messages (id, session_id, sequence, type, role, timestamp, text, payload_json)
       VALUES (?, ?, 2, 'question_request', 'system', ?, 'Codex needs your input', ?)`
    ).run(
      "legacy-app-server-question",
      sessionId,
      "2026-09-01T00:00:01.001Z",
      JSON.stringify({
        source: "codex_app_server",
        method: "item/tool/requestUserInput",
        question: { id: "0", requestId: 0, questions: [] },
        appServerIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "call-question" }
      })
    );
    raw.close();

    const reopened = new AppDatabase(path);
    expect(await reopened.listMessages(sessionId)).toMatchObject([
      { id: "legacy-app-server-question", text: "Codex needs your input" }
    ]);
    await reopened.close();
  });

  it("removes already-persisted duplicate plan copies when reopening", async () => {
    const { db, path, sessionId } = await projectionDb();
    await db.applyAppServerProjection(planProjectionInput(sessionId));
    await db.appendMessage({
      id: "accepted-plan",
      sessionId,
      sequence: 2,
      type: "user",
      role: "user",
      timestamp: "2026-09-01T00:00:02.000Z",
      text: "Implement the plan.",
      payload: {}
    });
    await db.close();
    const raw = new DatabaseSync(path);
    const delayed = rolloutPlanMessage(sessionId, 3);
    raw.prepare(
      `INSERT INTO messages (id, session_id, sequence, type, role, timestamp, text, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      delayed.id, delayed.sessionId, delayed.sequence, delayed.type, delayed.role,
      delayed.timestamp, delayed.text, JSON.stringify(delayed.payload)
    );
    raw.prepare(
      `INSERT INTO codex_item_messages
        (session_id, thread_id, turn_id, item_id, message_id, rollout_message_id, rollout_observed_at)
       VALUES (?, 'thread-1', 'turn-1', 'rollout-plan-item', ?, ?, ?)`
    ).run(sessionId, delayed.id, delayed.id, delayed.timestamp);
    raw.close();

    const reopened = new AppDatabase(path);
    expect(await reopened.listMessages(sessionId)).toMatchObject([
      { id: "app-server-plan", sequence: 1, text: "<proposed_plan>\nBuild it\n</proposed_plan>" },
      { id: "accepted-plan", sequence: 2, text: "Implement the plan." }
    ]);
    expect(await reopened.latestPlanReadyMessage(sessionId)).toBeNull();
    await reopened.close();

    const verified = new DatabaseSync(path, { readOnly: true });
    expect(verified.prepare(
      `SELECT item_id, app_server_message_id, rollout_message_id
       FROM codex_item_messages WHERE session_id = ?`
    ).get(sessionId)).toEqual({
      item_id: "turn-1-plan",
      app_server_message_id: "app-server-plan",
      rollout_message_id: "rollout-plan"
    });
    verified.close();
  });

  it("keeps item ownership through a session rekey and removes it with transcript history", async () => {
    const { db, path, sessionId } = await projectionDb();
    await db.applyAppServerProjection(projectionInput(sessionId));
    const session = await db.getSession(sessionId);
    expect(session).not.toBeNull();
    const rekeyedId = "session-projection-rekeyed";
    await db.rekeySession(
      sessionId,
      { ...session!, id: rekeyedId },
      null,
      "2026-09-01T00:00:03.000Z"
    );

    let raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT session_id FROM codex_item_messages").get()).toEqual({ session_id: rekeyedId });
    raw.close();

    await db.clearSessionTranscript(rekeyedId);
    await db.close();
    raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM codex_item_messages").get()).toEqual({ count: 0 });
    raw.close();
  });

  it("persists exact live command ownership across database reopen and session rekey", async () => {
    const { db, path, sessionId } = await projectionDb();
    const process = {
      sessionId,
      threadId: "thread-1",
      turnId: "turn-active",
      itemId: "item-active",
      processId: "process-active",
      observedAt: "2026-09-01T00:00:01.000Z"
    };
    await db.upsertAppServerCommandProcess(process);
    expect(await db.listAppServerCommandProcesses(sessionId, "thread-1")).toEqual([process]);
    await db.close();

    const reopened = new AppDatabase(path);
    expect(await reopened.listAppServerCommandProcesses(sessionId, "thread-1")).toEqual([process]);
    const session = await reopened.getSession(sessionId);
    expect(session).not.toBeNull();
    const rekeyedId = "session-process-rekeyed";
    await reopened.rekeySession(sessionId, { ...session!, id: rekeyedId }, null, "2026-09-01T00:00:02.000Z");
    expect(await reopened.listAppServerCommandProcesses(rekeyedId, "thread-1")).toEqual([
      { ...process, sessionId: rekeyedId }
    ]);
    expect(await reopened.removeAppServerCommandProcess(
      rekeyedId, "thread-1", "item-active", "process-active"
    )).toBe(true);
    expect(await reopened.listAppServerCommandProcesses(rekeyedId, "thread-1")).toEqual([]);
    await reopened.upsertAppServerCommandProcess({ ...process, sessionId: rekeyedId });
    expect(await reopened.removeAppServerTurnCommandProcess(
      rekeyedId, "thread-1", "turn-active", "process-active"
    )).toBe(true);
    expect(await reopened.listAppServerCommandProcesses(rekeyedId, "thread-1")).toEqual([]);
    await reopened.upsertAppServerCommandProcess({ ...process, sessionId: rekeyedId });
    expect(await reopened.removeAppServerTurnCommandProcesses(rekeyedId, "thread-1", "turn-active")).toBe(1);
    await reopened.upsertAppServerCommandProcess({ ...process, sessionId: rekeyedId });
    expect(await reopened.clearAppServerCommandProcesses(rekeyedId)).toBe(1);
    await reopened.close();
  });

  it("removes foreign-thread projections while preserving the root transcript", async () => {
    const { db, path, sessionId } = await projectionDb();
    await db.applyAppServerProjection(projectionInput(sessionId));
    await db.applyAppServerProjection({
      ...projectionInput(sessionId),
      threadId: "thread-child",
      turnId: "turn-child",
      itemId: "agent-child",
      message: {
        ...projectionInput(sessionId).message,
        id: "stable-agent-child",
        text: "Child-only answer",
        payload: {
          source: "codex_app_server",
          codexItemIdentity: {
            threadId: "thread-child",
            turnId: "turn-child",
            itemId: "agent-child",
            clientMessageId: null
          }
        }
      }
    });
    await db.upsertAppServerCommandProcess({
      sessionId,
      threadId: "thread-child",
      turnId: "turn-child",
      itemId: "command-child",
      processId: "process-child",
      observedAt: "2026-09-01T00:00:03.000Z"
    });

    expect(await db.repairAppServerProjectionThread(sessionId, "thread-1")).toEqual({
      messagesRemoved: 1,
      processesRemoved: 1,
      reconciliationReset: true
    });
    expect(await db.listMessages(sessionId)).toMatchObject([
      { id: "stable-agent-1", text: "Authoritative answer" }
    ]);
    expect(await db.getAppServerReconciliationState(sessionId)).toBeNull();
    expect(await db.listAppServerCommandProcesses(sessionId, "thread-child")).toEqual([]);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM codex_item_messages WHERE session_id = ?")
      .get(sessionId)).toEqual({ count: 1 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(sessionId)).toEqual({ count: 1 });
    raw.close();
  });

  it("rejects invalid reconciliation state without mutating transcript or status", async () => {
    const { db, path, sessionId } = await projectionDb();
    expect(() => db.applyAppServerProjection({
      sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      clientMessageId: null,
      method: "item/completed",
      status: { invalid: true } as never,
      message: {
        id: "stable-agent-1",
        type: "assistant",
        role: "assistant",
        timestamp: "2026-09-01T00:00:01.000Z",
        text: "Must not persist",
        payload: {}
      },
      evidence: { item: { id: "agent-1" } },
      observedAt: "2026-09-01T00:00:02.000Z"
    })).toThrow();
    expect((await db.listRecentMessages(sessionId, 10)).items).toEqual([]);
    expect(await db.getAppServerReconciliationState(sessionId)).toBeNull();
    await db.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT status FROM managed_sessions WHERE id = ?").get(sessionId)).toEqual({ status: "idle" });
    raw.close();
  });
});

function projectionInput(sessionId: string) {
  return {
    sessionId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "agent-1",
    clientMessageId: null,
    method: "item/completed",
    status: "generating" as const,
    message: {
      id: "stable-agent-1",
      type: "assistant" as const,
      role: "assistant" as const,
      timestamp: "2026-09-01T00:00:02.000Z",
      text: "Authoritative answer",
      payload: {
        source: "codex_app_server",
        codexItemIdentity: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "agent-1",
          clientMessageId: null
        }
      }
    },
    evidence: { item: { id: "agent-1", type: "agentMessage" } },
    observedAt: "2026-09-01T00:00:02.000Z"
  };
}

function questionProjectionInput(sessionId: string) {
  return {
    sessionId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "call-question",
    clientMessageId: null,
    method: "item/tool/requestUserInput",
    status: "question" as const,
    message: {
      id: "app-server-question",
      type: "question_request" as const,
      role: "system" as const,
      timestamp: "2026-09-01T00:00:01.001Z",
      text: "Codex needs your input",
      payload: {
        source: "codex_app_server",
        method: "item/tool/requestUserInput",
        question: {
          id: "0",
          requestId: 0,
          questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }]
        },
        codexItemIdentity: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-question",
          clientMessageId: null
        },
        appServerIdentity: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-question",
          clientMessageId: null
        }
      }
    },
    evidence: { requestId: 0 },
    observedAt: "2026-09-01T00:00:01.001Z"
  };
}

function planProjectionInput(sessionId: string) {
  return {
    ...projectionInput(sessionId),
    itemId: "turn-1-plan",
    status: "plan_ready" as const,
    message: {
      id: "app-server-plan",
      type: "assistant" as const,
      role: "assistant" as const,
      timestamp: "2026-09-01T00:00:01.000Z",
      text: "<proposed_plan>\nBuild it\n</proposed_plan>",
      payload: {
        source: "codex_app_server",
        method: "item/completed",
        codexItemIdentity: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "turn-1-plan",
          clientMessageId: null
        },
        appServerIdentity: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "turn-1-plan",
          clientMessageId: null
        }
      }
    },
    evidence: { item: { id: "turn-1-plan", type: "plan" } }
  };
}

function rolloutPlanMessage(sessionId: string, sequence: number) {
  return {
    id: "rollout-plan",
    sessionId,
    sequence,
    type: "assistant" as const,
    role: "assistant" as const,
    timestamp: "2026-09-01T00:00:01.001Z",
    text: "Plan ready.\n\n<proposed_plan>\nBuild it\n</proposed_plan>\n\n<oai-mem-citation>ignored</oai-mem-citation>",
    payload: {
      type: "response_item",
      codexItemIdentity: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "rollout-plan-item",
        clientMessageId: null
      }
    }
  };
}

async function projectionDb(): Promise<{ db: AppDatabase; path: string; sessionId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "muxpilot-app-server-projection-"));
  const path = join(directory, "test.db");
  const sessionId = "session-projection";
  const db = new AppDatabase(path);
  const raw = new DatabaseSync(path);
  raw.prepare(
    `INSERT INTO managed_sessions
      (id, data_json, status, last_activity_at, preview, unread_count, archived, updated_at)
     VALUES (?, ?, 'idle', NULL, '', 0, 0, ?)`
  ).run(sessionId, JSON.stringify({
    id: sessionId,
    name: "projection",
    cwd: "/repo",
    provider: { kind: "codex", threadId: "thread-1", rolloutPath: null },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    status: "idle",
    lastActivityAt: null
  }), "2026-09-01T00:00:00.000Z");
  raw.close();
  return { db, path, sessionId };
}
