import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { extract, pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../src/db/database.js";
import type { SessionManager } from "../src/services/sessionManager.js";
import { SessionTransferError, SessionTransferService, sessionTransferFilename } from "../src/services/sessionTransfer.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("SessionTransferService", () => {
  it("round-trips multiple plaintext sessions and groups shared directory mappings", async () => {
    const fixture = await createFixture();
    const service = transferService(fixture.sessions);
    await service.initialize();

    const archive = await service.export(fixture.sessions.map((session) => session.id));
    const file = archive.contents;
    expect(archive.filename).toBe("muxpilot-2-sessions.mpsession");
    expect(file.subarray(0, 8).toString("ascii")).toBe("MPSESSN2");
    expect(file[8]).toBe(0);
    const entries = await tarEntries(gunzipSync(file.subarray(9)));
    expect([...entries.keys()]).toEqual(["manifest.json", "sessions/0001.jsonl", "sessions/0002.jsonl"]);
    expect(JSON.parse(entries.get("manifest.json")!.toString("utf8"))).toMatchObject({ formatVersion: 3, gitBranches: [] });
    expect([...entries.keys()].join(" ")).not.toContain(fixture.sessions[0]!.codexSessionId);

    const preview = await service.inspect(file);
    expect(preview.encrypted).toBe(false);
    expect(preview.formatVersion).toBe(3);
    expect(preview.sessions).toHaveLength(2);
    expect(preview.mappings).toEqual([{ sourceCwd: fixture.root, repoName: "fixture", workspaceMode: "directory", targetBranch: null, branches: [] }]);
    await service.cancel(preview.token);
    await expect(service.inspect(Buffer.concat([Buffer.from("MPSESSN1", "ascii"), Buffer.from([0])]))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("encrypts exports and rejects missing, wrong, and tampered keys", async () => {
    const fixture = await createFixture(1);
    const encrypted = transferService(fixture.sessions, "correct horse battery staple");
    await encrypted.initialize();
    const archive = await encrypted.export([fixture.sessions[0]!.id]);
    const file = archive.contents;
    expect(archive.filename).toMatch(/^muxpilot-encrypted-\d{8}T\d{6}Z\.mpsession$/);
    expect(archive.filename).not.toContain("work-0");
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

  it("uses a safe session name for single plaintext exports", async () => {
    const fixture = await createFixture(1);
    fixture.sessions[0]!.tmux.windowName = "Release notes / Q3";
    const archive = await transferService(fixture.sessions).export([fixture.sessions[0]!.id]);
    expect(archive.filename).toBe("Release-notes-Q3.mpsession");
    expect(sessionTransferFilename(["..."], false, "2026-07-11T12:00:00.000Z")).toBe("muxpilot-session.mpsession");
    expect(sessionTransferFilename(["a".repeat(120)], false, "2026-07-11T12:00:00.000Z")).toBe(`${"a".repeat(80)}.mpsession`);
  });

  it("includes committed managed Git branch state in format v3", async () => {
    const fixture = await createFixture(1);
    await git(fixture.root, ["init", "-b", "main"]);
    await git(fixture.root, ["config", "user.email", "muxpilot@example.com"]);
    await git(fixture.root, ["config", "user.name", "Muxpilot"]);
    await git(fixture.root, ["add", "."]);
    await git(fixture.root, ["commit", "-m", "local branch"]);
    const session = fixture.sessions[0]!;
    session.gitWorkspace = {
      workflowVersion: 1,
      id: "workspace-1",
      state: "idle",
      entryPath: fixture.root,
      repoRoot: fixture.root,
      targetBranch: "main",
      targetSha: await git(fixture.root, ["rev-parse", "main"]),
      sessionBranch: null,
      worktreePath: null,
      lastError: null,
      updatedAt: "2026-07-11T12:01:00.000Z",
      dependencyLinks: []
    };

    const archive = await transferService(fixture.sessions).export([session.id]);
    const entries = await tarEntries(gunzipSync(archive.contents.subarray(9)));
    expect([...entries.keys()]).toEqual(["manifest.json", "sessions/0001.jsonl", "git/0001.bundle"]);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.gitBranches).toEqual([expect.objectContaining({
      branchName: "main",
      bundleMode: "full",
      upstreamRemote: null
    })]);

    const preview = await transferService(fixture.sessions).inspect(archive.contents);
    expect(preview.mappings[0]?.branches).toEqual([expect.objectContaining({
      branchName: "main",
      tipSha: session.gitWorkspace.targetSha
    })]);
  });

  it("continues to inspect legacy format-v2 archives", async () => {
    const fixture = await createFixture(1);
    const service = transferService(fixture.sessions);
    const current = await service.export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(current.contents.subarray(9)));
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    manifest.formatVersion = 2;
    delete manifest.gitBranches;
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const legacy = Buffer.concat([
      Buffer.from("MPSESSN2", "ascii"),
      Buffer.from([0]),
      gzipSync(await tarArchive(entries))
    ]);

    const preview = await service.inspect(legacy);
    expect(preview.formatVersion).toBe(2);
    expect(preview.mappings[0]).toMatchObject({ targetBranch: null, branches: [] });
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

async function tarEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  const tar = extract();
  const entries = new Map<string, Buffer>();
  const completed = new Promise<void>((resolve, reject) => {
    tar.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => { entries.set(header.name, Buffer.concat(chunks)); next(); });
      stream.on("error", reject);
    });
    tar.on("finish", resolve);
    tar.on("error", reject);
  });
  tar.end(archive);
  await completed;
  return entries;
}

async function tarArchive(entries: Map<string, Buffer>): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    tar.on("data", (chunk: Buffer) => chunks.push(chunk));
    tar.on("end", () => resolve(Buffer.concat(chunks)));
    tar.on("error", reject);
  });
  for (const [name, contents] of entries) tar.entry({ name, mode: 0o600 }, contents);
  tar.finalize();
  return completed;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
