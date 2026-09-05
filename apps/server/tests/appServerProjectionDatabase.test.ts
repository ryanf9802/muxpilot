import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db/database.js";

describe("app-server projection persistence", () => {
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
    expect(await reopened.removeAppServerTurnCommandProcesses(rekeyedId, "thread-1", "turn-active")).toBe(1);
    await reopened.upsertAppServerCommandProcess({ ...process, sessionId: rekeyedId });
    expect(await reopened.clearAppServerCommandProcesses(rekeyedId)).toBe(1);
    await reopened.close();
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
    tmux: { windowName: "projection", sessionName: "projection", cwd: "/repo" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    status: "idle",
    lastActivityAt: null
  }), "2026-09-01T00:00:00.000Z");
  raw.close();
  return { db, path, sessionId };
}
