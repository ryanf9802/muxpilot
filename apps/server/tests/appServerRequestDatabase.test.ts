import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db/database.js";

describe("app-server request persistence", () => {
  it("preserves replayed requests and claims responses exactly once across database reopen", async () => {
    const { db, path, sessionId } = await requestDb("gate-restart");
    const received = {
      sessionId,
      requestId: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", command: "git status" },
      threadId: "thread-1",
      turnId: "turn-1",
      receivedAt: "2026-09-01T00:00:01.000Z",
      lastSeenAt: "2026-09-01T00:00:01.000Z"
    };
    expect(await db.upsertAppServerRequest(received)).toMatchObject({ state: "pending", response: null });
    expect(await db.claimAppServerRequestResponse(
      sessionId,
      received.requestId,
      { decision: "accept" },
      "2026-09-01T00:00:02.000Z"
    )).toMatchObject({ state: "responded", response: { decision: "accept" } });
    expect(await db.claimAppServerRequestResponse(
      sessionId,
      received.requestId,
      { decision: "decline" },
      "2026-09-01T00:00:03.000Z"
    )).toBeNull();

    await db.upsertAppServerRequest({
      ...received,
      params: { ...received.params, replayed: true },
      lastSeenAt: "2026-09-01T00:00:04.000Z"
    });
    expect(await db.listUnresolvedAppServerRequests(sessionId)).toEqual([
      expect.objectContaining({
        requestId: "approval-1",
        state: "responded",
        response: { decision: "accept" },
        params: expect.objectContaining({ replayed: true }),
        receivedAt: "2026-09-01T00:00:01.000Z",
        lastSeenAt: "2026-09-01T00:00:04.000Z"
      })
    ]);
    await db.upsertAppServerRequest({ ...received, requestId: "approval-2" });
    expect(await db.resolveAppServerRequest(sessionId, "approval-2", "2026-09-01T00:00:05.000Z")).toBe(true);
    expect(await db.resolveAppServerRequest(sessionId, "approval-2", "2026-09-01T00:00:06.000Z")).toBe(false);
    await db.close();

    const reopened = new DatabaseSync(path, { readOnly: true });
    expect(reopened.prepare(
      "SELECT state, response_json, last_seen_at FROM app_server_requests WHERE session_id = ? AND request_id_json = ?"
    ).get(sessionId, JSON.stringify(received.requestId))).toEqual({
      state: "responded",
      response_json: JSON.stringify({ decision: "accept" }),
      last_seen_at: "2026-09-01T00:00:04.000Z"
    });
    reopened.close();
  });

  it("resolves a terminal turn without conflating numeric and string request ids", async () => {
    const { db, sessionId } = await requestDb("typed-ids");
    for (const requestId of [7, "7"] as const) {
      await db.upsertAppServerRequest({
        sessionId,
        requestId,
        method: "item/tool/requestUserInput",
        params: {},
        threadId: "thread-1",
        turnId: "turn-1",
        receivedAt: `2026-09-01T00:00:0${typeof requestId === "number" ? 1 : 2}.000Z`,
        lastSeenAt: "2026-09-01T00:00:03.000Z"
      });
    }
    expect(await db.listUnresolvedAppServerRequests(sessionId)).toHaveLength(2);
    expect(await db.resolveAppServerTurnRequests(
      sessionId,
      "thread-1",
      "turn-1",
      "2026-09-01T00:00:04.000Z"
    )).toBe(2);
    expect(await db.listUnresolvedAppServerRequests(sessionId)).toEqual([]);
    await db.close();
  });
});

async function requestDb(suffix: string): Promise<{ db: AppDatabase; path: string; sessionId: string }> {
  const directory = await mkdtemp(join(tmpdir(), `muxpilot-app-server-${suffix}-`));
  const path = join(directory, "test.db");
  const sessionId = `session-${suffix}`;
  const db = new AppDatabase(path);
  const sessionData = {
    id: sessionId,
    name: suffix,
    cwd: "/repo",
    tmux: { windowName: suffix, sessionName: suffix, cwd: "/repo" },
    repo: { root: "/repo", name: "repo", branch: "main", dirty: false, worktree: null },
    codexSessionId: "thread-1",
    codexJsonlPath: null,
    status: "idle",
    lastActivityAt: null
  };
  const raw = new DatabaseSync(path);
  raw.prepare(
    `INSERT INTO managed_sessions
      (id, data_json, status, last_activity_at, preview, unread_count, archived, updated_at)
     VALUES (?, ?, 'idle', NULL, '', 0, 0, ?)`
  ).run(sessionId, JSON.stringify(sessionData), "2026-09-01T00:00:00.000Z");
  raw.close();
  return { db, path, sessionId };
}
