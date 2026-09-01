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
        payload: { appServerIdentity: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1" } }
      },
      evidence: { item: { id: "agent-1", type: "agentMessage" } },
      observedAt: "2026-09-01T00:00:02.000Z"
    };

    expect(await db.applyAppServerProjection(projection)).toMatchObject({
      messageInserted: true,
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
