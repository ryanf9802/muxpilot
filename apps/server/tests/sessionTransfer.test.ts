import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { extract, pack } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import type { AppDatabase } from "../src/db/database.js";
import type { SessionManager } from "../src/services/sessionManager.js";
import { SessionTransferError, SessionTransferService, sessionTransferFilename } from "../src/services/sessionTransfer.js";
import type { SessionEnvironmentService } from "../src/services/sessionEnvironment.js";

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
    expect(JSON.parse(entries.get("manifest.json")!.toString("utf8"))).toMatchObject({
      formatVersion: 8,
      gitBranches: [],
      sessions: [
        expect.objectContaining({ fastMode: true, name: "work-0", cwd: fixture.root }),
        expect.objectContaining({ fastMode: false, name: "work-1", cwd: fixture.root })
      ]
    });
    expect(JSON.parse(entries.get("manifest.json")!.toString("utf8")).sessions[0]).not.toHaveProperty("runtime");
    expect([...entries.keys()].join(" ")).not.toContain(fixture.sessions[0]!.provider.threadId);

    const preview = await service.inspect(file);
    expect(preview.encrypted).toBe(false);
    expect(preview.formatVersion).toBe(8);
    expect(preview.sessions.every((session) => session.documentCount === 0)).toBe(true);
    expect(preview.sessions).toHaveLength(2);
    expect(preview.mappings).toEqual([{ sourceCwd: fixture.root, repoName: "fixture", workspaceMode: "directory", targetBranch: null, branches: [] }]);
    await service.cancel(preview.token);
    await expect(service.inspect(Buffer.concat([Buffer.from("MPSESSN1", "ascii"), Buffer.from([0])]))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("exports fork origins without machine-local session ids", async () => {
    const fixture = await createFixture(1);
    fixture.sessions[0]!.forkedFrom = {
      provider: "codex",
      threadId: "019f-parent-session-abcdef",
      sessionId: "local-parent-session",
      sessionName: "parent-session"
    };

    const archive = await transferService(fixture.sessions).export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(archive.contents.subarray(9)));
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.sessions[0].forkedFrom).toEqual({
      provider: "codex",
      threadId: "019f-parent-session-abcdef",
      sessionId: null,
      sessionName: "parent-session"
    });
  });

  it("exports validated Markdown documents with opaque entries and hashes", async () => {
    const fixture = await createFixture(1);
    const documents = new Map([[fixture.sessions[0]!.id, [{
      name: "INDEX.md",
      contents: Buffer.from("# Durable plan\n"),
      updatedAt: "2026-08-25T00:00:00.000Z"
    }]]]);
    const archive = await transferService(fixture.sessions, undefined, documents).export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(archive.contents.subarray(9)));
    expect([...entries.keys()]).toEqual(["manifest.json", "sessions/0001.jsonl", "documents/0001/0001.md"]);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.sessions[0].documents).toEqual([expect.objectContaining({
      name: "INDEX.md",
      entry: "documents/0001/0001.md",
      bytes: 15
    })]);
    expect((await transferService(fixture.sessions, undefined, documents).inspect(archive.contents)).sessions[0]!.documentCount).toBe(1);

    manifest.sessions[0].documents[0].sha256 = "0".repeat(64);
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const tampered = Buffer.concat([Buffer.from("MPSESSN2", "ascii"), Buffer.from([0]), gzipSync(await tarArchive(entries))]);
    await expect(transferService(fixture.sessions, undefined, documents).inspect(tampered)).rejects.toBeInstanceOf(SessionTransferError);
  });

  it("passes validated documents into import before the manager resumes the session", async () => {
    const fixture = await createFixture(1);
    const documents = [{ name: "plan.md", contents: Buffer.from("- [ ] ship\n"), updatedAt: "2026-08-25T00:00:00.000Z" }];
    const importPortableSession = vi.fn(async (
      session: { provider: "codex" | "claude"; threadId: string; sessionName: string },
      _transcript: Buffer,
      _mapping: unknown,
      _documents: unknown
    ) => ({
      provider: session.provider,
      threadId: session.threadId,
      sessionName: session.sessionName,
      status: "resumed" as const,
      sessionId: "imported-session",
      error: null
    }));
    const manager = {
      snapshotDocuments: async () => documents,
      ensureTranscriptAvailable: async () => undefined,
      assertPortableRuntimeAvailable: () => undefined,
      validatePortableMapping: async () => undefined,
      importPortableSession
    } as unknown as SessionManager;
    const db = { getSession: async () => fixture.sessions[0] } as AppDatabase;
    const service = new SessionTransferService(db, manager);
    await service.initialize();
    const archive = await service.export([fixture.sessions[0]!.id]);
    const preview = await service.inspect(archive.contents);

    await service.import(preview.token, [{ sourceCwd: fixture.root, destinationCwd: fixture.root }]);

    expect(importPortableSession).toHaveBeenCalledTimes(1);
    expect(importPortableSession.mock.calls[0]?.[2]).toEqual({ sourceCwd: fixture.root, destinationCwd: fixture.root });
    expect(importPortableSession.mock.calls[0]?.[3]).toEqual([expect.objectContaining({ name: "plan.md", contents: Buffer.from("- [ ] ship\n") })]);
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
    expect((await encrypted.inspect(file)).sessions[0]?.threadId).toBe(fixture.sessions[0]?.provider.threadId);
  });

  it("encrypts environment values with a passphrase and expands child exports to include their parent", async () => {
    const fixture = await createFixture();
    fixture.sessions[1]!.agentOwnership = {
      parentSessionId: fixture.sessions[0]!.id,
      rootSessionId: fixture.sessions[0]!.id,
      origin: "created", createdAt: new Date(0).toISOString(), workTokenBaseline: 0,
      workTokensUsed: 0, workTokenBudget: 1, completedAt: null, budgetExhaustedAt: null
    };
    const imported: Array<{ sessionId: string; values: Record<string, string>; parentSessionId?: string | null }> = [];
    const environment = {
      requiredAncestors: async () => [fixture.sessions[1]!.id, fixture.sessions[0]!.id],
      exportOwned: async (id: string) => id === fixture.sessions[0]!.id ? { PAYLOCITY_SECRET: "archive-secret" } : {},
      importOwned: async (sessionId: string, values: Record<string, string>, parentSessionId?: string | null) => { imported.push({ sessionId, values, parentSessionId }); }
    } as unknown as SessionEnvironmentService;
    const db = { getSession: async (id: string) => fixture.sessions.find((session) => session.id === id) ?? null } as AppDatabase;
    const manager = {
      snapshotDocuments: async () => [], assertPortableRuntimeAvailable: () => undefined,
      ensureTranscriptAvailable: async () => undefined,
      validatePortableMapping: async () => undefined,
      importPortableSession: async (session: { provider: "codex" | "claude"; threadId: string; sessionName: string }) => ({ provider: session.provider, threadId: session.threadId, sessionName: session.sessionName, status: "resumed" as const, sessionId: `imported-${session.threadId}`, error: null })
    } as unknown as SessionManager;
    const service = new SessionTransferService(db, manager, environment);
    await service.initialize();
    const archive = await service.export([fixture.sessions[1]!.id], "correct horse battery staple");
    expect(archive.contents.toString("utf8")).not.toContain("archive-secret");
    const preview = await service.inspect(archive.contents, "correct horse battery staple");
    expect(preview.sessions).toHaveLength(2);
    await service.import(preview.token, [{ sourceCwd: fixture.root, destinationCwd: fixture.root }]);
    expect(imported).toContainEqual(expect.objectContaining({ values: { PAYLOCITY_SECRET: "archive-secret" } }));
    expect(imported.find((entry) => entry.values.PAYLOCITY_SECRET === undefined)?.parentSessionId).toBe(`imported-${fixture.sessions[0]!.provider.threadId}`);
  });

  it("rejects selecting duplicate records for one Codex session", async () => {
    const fixture = await createFixture();
    fixture.sessions[1] = { ...fixture.sessions[1]!, provider: { ...fixture.sessions[0]!.provider } };
    const service = transferService(fixture.sessions);
    await expect(service.export(fixture.sessions.map((session) => session.id))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("imports format 6 Codex archives into the provider-neutral shape", async () => {
    const fixture = await createFixture(1);
    const service = transferService(fixture.sessions);
    const archive = await service.export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(archive.contents.subarray(9)));
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    const { provider, threadId, ...rest } = manifest.sessions[0];
    manifest.formatVersion = 6;
    manifest.sessions[0] = {
      ...rest,
      codexSessionId: threadId,
      provider: { kind: provider, threadId, rolloutPath: null },
      forkedFrom: { codexSessionId: "019f-parent-session-abcdef", sessionId: null, sessionName: "parent" }
    };
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const legacy = Buffer.concat([Buffer.from("MPSESSN2", "ascii"), Buffer.from([0]), gzipSync(await tarArchive(entries))]);

    const preview = await service.inspect(legacy);

    expect(preview.formatVersion).toBe(6);
    expect(preview.sessions[0]).toMatchObject({ provider: "codex", threadId: fixture.sessions[0]!.provider.threadId });
  });

  it("exports Claude transcripts and validates their session identity", async () => {
    const fixture = await createFixture(1);
    const threadId = "4f7a8c2e-1111-4222-8333-944455556666";
    const transcriptPath = join(fixture.root, "claude.jsonl");
    await writeFile(transcriptPath, `${JSON.stringify({ type: "user", sessionId: threadId, uuid: "u-1", message: { role: "user", content: "hi" } })}\n`);
    fixture.sessions[0] = { ...fixture.sessions[0]!, provider: { kind: "claude", threadId, transcriptPath } };
    const service = transferService(fixture.sessions);
    const archive = await service.export([fixture.sessions[0]!.id]);

    const preview = await service.inspect(archive.contents);
    expect(preview.sessions[0]).toMatchObject({ provider: "claude", threadId });

    const entries = await tarEntries(gunzipSync(archive.contents.subarray(9)));
    const foreign = Buffer.from(`${JSON.stringify({ type: "user", sessionId: "4f7a8c2e-0000-4222-8333-944455556666", uuid: "u-1" })}\n`);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    manifest.sessions[0].transcriptBytes = foreign.length;
    manifest.sessions[0].transcriptSha256 = createHash("sha256").update(foreign).digest("hex");
    entries.set("sessions/0001.jsonl", foreign);
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const tampered = Buffer.concat([Buffer.from("MPSESSN2", "ascii"), Buffer.from([0]), gzipSync(await tarArchive(entries))]);
    await expect(service.inspect(tampered)).rejects.toThrow(/Transcript identity does not match/);
  });

  it("uses a safe session name for single plaintext exports", async () => {
    const fixture = await createFixture(1);
    fixture.sessions[0]!.name = "Release notes / Q3";
    const archive = await transferService(fixture.sessions).export([fixture.sessions[0]!.id]);
    expect(archive.filename).toBe("Release-notes-Q3.mpsession");
    expect(sessionTransferFilename(["..."], false, "2026-07-11T12:00:00.000Z")).toBe("muxpilot-session.mpsession");
    expect(sessionTransferFilename(["a".repeat(120)], false, "2026-07-11T12:00:00.000Z")).toBe(`${"a".repeat(80)}.mpsession`);
  });

  it("includes committed managed Git branch state in format v6", async () => {
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

  it.each([2, 3, 4, 5])("rejects unsupported format-v%s archives", async (formatVersion) => {
    const fixture = await createFixture(1);
    const service = transferService(fixture.sessions);
    const current = await service.export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(current.contents.subarray(9)));
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    manifest.formatVersion = formatVersion;
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const unsupported = Buffer.concat([
      Buffer.from("MPSESSN2", "ascii"),
      Buffer.from([0]),
      gzipSync(await tarArchive(entries))
    ]);

    await expect(service.inspect(unsupported)).rejects.toThrow("Unsupported or invalid session archive manifest");
  });

  it("rejects undeclared session metadata", async () => {
    const fixture = await createFixture(1);
    const service = transferService(fixture.sessions);
    const current = await service.export([fixture.sessions[0]!.id]);
    const entries = await tarEntries(gunzipSync(current.contents.subarray(9)));
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    manifest.sessions[0].runtimeSelector = "unsupported";
    entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    const unsupported = Buffer.concat([
      Buffer.from("MPSESSN2", "ascii"),
      Buffer.from([0]),
      gzipSync(await tarArchive(entries))
    ]);

    await expect(service.inspect(unsupported)).rejects.toThrow("invalid session metadata");
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
      name: `work-${index}`,
      cwd: root,
      provider: { kind: "codex", threadId: codexSessionId, transcriptPath: transcriptPath },
      repo: { root, name: "fixture", branch: "main", dirty: false, worktree: null },
      discoveryConfidence: "high",
      status: "missing",
      lastActivityAt: "2026-07-11T12:01:00.000Z",
      preview: "",
      recentUserPrompts: [],
      approvalMode: "ask",
      inputMode: "default",
      models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
      fastMode: index === 0,
      transcriptSize: 0,
      unreadCount: 0,
      pinned: index === 0,
      archived: false,
      gitWorkspace: null
    });
  }
  return { root, sessions };
}

function transferService(
  sessions: ManagedSession[],
  key?: string,
  documents = new Map<string, Array<{ name: string; contents: Buffer; updatedAt: string }>>()
): SessionTransferService {
  const db = { getSession: async (id: string) => sessions.find((session) => session.id === id) ?? null } as AppDatabase;
  const manager = {
    snapshotDocuments: async (id: string) => documents.get(id) ?? [],
    ensureTranscriptAvailable: async () => undefined
  } as unknown as SessionManager;
  return new SessionTransferService(db, manager, key);
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
