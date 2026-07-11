import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../src/db/database.js";
import type { SessionManager } from "../src/services/sessionManager.js";
import { SessionTransferError, SessionTransferService } from "../src/services/sessionTransfer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("SessionTransferService", () => {
  it("round-trips multiple plaintext sessions and groups shared directory mappings", async () => {
    const fixture = await createFixture();
    const service = transferService(fixture.sessions);
    await service.initialize();

    const file = await service.export(fixture.sessions.map((session) => session.id));
    expect(file.subarray(0, 8).toString("ascii")).toBe("MPSESSN1");
    expect(file[8]).toBe(0);

    const preview = await service.inspect(file);
    expect(preview.encrypted).toBe(false);
    expect(preview.sessions).toHaveLength(2);
    expect(preview.mappings).toEqual([{ sourceCwd: fixture.root, repoName: "fixture", workspaceMode: "directory", targetBranch: null }]);
    await service.cancel(preview.token);
  });

  it("encrypts exports and rejects missing, wrong, and tampered keys", async () => {
    const fixture = await createFixture(1);
    const encrypted = transferService(fixture.sessions, "correct horse battery staple");
    await encrypted.initialize();
    const file = await encrypted.export([fixture.sessions[0]!.id]);
    expect(file[8]).toBe(1);
    await expect(transferService(fixture.sessions).inspect(file)).rejects.toMatchObject({ statusCode: 422 });
    await expect(transferService(fixture.sessions, "incorrect horse battery staple").inspect(file)).rejects.toMatchObject({ statusCode: 422 });
    const tampered = Buffer.from(file);
    tampered[tampered.length - 20] ^= 1;
    await expect(encrypted.inspect(tampered)).rejects.toBeInstanceOf(SessionTransferError);
    expect((await encrypted.inspect(file)).sessions[0]?.codexSessionId).toBe(fixture.sessions[0]?.codexSessionId);
  });

  it("rejects selecting duplicate records for one Codex session", async () => {
    const fixture = await createFixture();
    fixture.sessions[1] = { ...fixture.sessions[1]!, codexSessionId: fixture.sessions[0]!.codexSessionId, codexJsonlPath: fixture.sessions[0]!.codexJsonlPath };
    const service = transferService(fixture.sessions);
    await expect(service.export(fixture.sessions.map((session) => session.id))).rejects.toMatchObject({ statusCode: 409 });
  });
});

async function createFixture(count = 2): Promise<{ root: string; sessions: ManagedSession[] }> {
  const root = await mkdtemp(join(tmpdir(), "muxpilot-transfer-test-"));
  roots.push(root);
  const sessions: ManagedSession[] = [];
  for (let index = 0; index < count; index += 1) {
    const codexSessionId = `019f-session-${index}-abcdef`;
    const transcriptPath = join(root, `${index}.jsonl`);
    await writeFile(transcriptPath, `${JSON.stringify({ timestamp: "2026-07-11T12:00:00.000Z", type: "session_meta", payload: { id: codexSessionId, cwd: root } })}\n${JSON.stringify({ timestamp: "2026-07-11T12:01:00.000Z", type: "event_msg", payload: { type: "user_message", message: `prompt ${index}` } })}\n`);
    sessions.push({
      id: `session-${index}`,
      tmux: { sessionId: "muxpilot", sessionName: "muxpilot", windowId: `@${index}`, windowIndex: index, windowName: `work-${index}`, paneId: `%${index}`, paneIndex: 0, paneActive: false, cwd: root, currentCommand: "codex", title: "", pid: 1, size: "80x24" },
      repo: { root, name: "fixture", branch: "main", dirty: false, worktree: null },
      codexSessionId,
      codexJsonlPath: transcriptPath,
      discoveryConfidence: "high",
      status: "missing",
      lastActivityAt: "2026-07-11T12:01:00.000Z",
      preview: "",
      recentUserPrompts: [],
      activitySummary: null,
      activitySummaryGeneratedAt: null,
      activitySummarySourceSequence: null,
      inputMode: "default",
      models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
      transcriptSize: 0,
      unreadCount: 0,
      pinned: index === 0,
      archived: false,
      gitWorkspace: null
    });
  }
  return { root, sessions };
}

function transferService(sessions: ManagedSession[], key?: string): SessionTransferService {
  const db = { getSession: async (id: string) => sessions.find((session) => session.id === id) ?? null } as AppDatabase;
  return new SessionTransferService(db, {} as SessionManager, key);
}
