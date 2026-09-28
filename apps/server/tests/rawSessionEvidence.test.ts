import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { RawSessionEvidenceReader } from "../src/services/rawSessionEvidence.js";

describe("RawSessionEvidenceReader", () => {
   it("lists Codex JSONL files by filesystem recency and reads exact bounded bytes", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-raw-codex-"));
    const sessions = join(codexHome, "sessions", "2026", "08");
    await mkdir(sessions, { recursive: true });
    const first = join(sessions, "first.jsonl");
    const second = join(sessions, "second.jsonl");
    await writeFile(first, "first-line\nsecond-line\n");
    await writeFile(second, "other\n");
    const reader = new RawSessionEvidenceReader({ transcripts: { codex: join(codexHome, "sessions") } });

    const listing = await reader.listTranscriptFiles("codex", 1, 0);
    expect(listing.files).toHaveLength(1);
    expect(listing.nextOffset).toBe(1);
    await expect(reader.listTranscriptFiles("codex", 1, 1)).resolves.toMatchObject({ nextOffset: null });
    const relativePath = "2026/08/first.jsonl";
    await expect(reader.readTranscriptFile("codex", relativePath, 6, 9)).resolves.toEqual({
      relativePath,
      fileSize: 23,
      startOffset: 6,
      endOffset: 15,
      text: "line\nseco"
    });
    await expect(reader.readTranscriptFile("codex", relativePath, null, 5)).resolves.toMatchObject({
      startOffset: 18,
      endOffset: 23,
      text: "line\n"
    });
  });

  it("rejects providers without a configured transcript root", async () => {
    const reader = new RawSessionEvidenceReader({ transcripts: {} });
    await expect(reader.listTranscriptFiles("claude", 1, 0)).rejects.toThrow("Claude transcripts are not available");
  });

  it("refuses traversal and symlink escapes from the configured Codex sessions root", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-raw-codex-"));
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions);
    const outside = join(codexHome, "outside.jsonl");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(sessions, "link.jsonl"));
    const reader = new RawSessionEvidenceReader({ transcripts: { codex: join(codexHome, "sessions") } });

    await expect(reader.readTranscriptFile("codex", "../outside.jsonl", 0, 100)).rejects.toThrow("escapes");
    await expect(reader.readTranscriptFile("codex", "link.jsonl", 0, 100)).rejects.toThrow("escapes");
    await expect(reader.readTranscriptFile("codex", outside, 0, 100)).rejects.toThrow("relativePath");
    await expect(reader.readTranscriptFile("codex", "not-jsonl.txt", 0, 100)).rejects.toThrow("JSONL");
  });

  it("returns neutral app-server service, process, attachment, and protocol evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-raw-app-server-"));
    const procRoot = join(root, "proc");
    const dataDir = join(root, "data");
    const session = appServerSession("app-evidence");
    await writeProcess(procRoot, 700, "701 ", "codex\0app-server\0", "Name:\tcodex\n", "0::/muxpilot.service\n");
    await writeProcess(procRoot, 701, "", "node\0dev-server\0", "Name:\tnode\n", "0::/muxpilot.service\n");
    const journalDir = join(dataDir, "protocol", "app-server-sessions", "0123456789abcdef01234567");
    await mkdir(journalDir, { recursive: true });
    await writeFile(join(journalDir, "protocol.jsonl"), "one\ntwo\n");
    const runCommand = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.includes("--value")
        ? "700\n"
        : `Id=${session.runtime!.kind === "systemd_service" ? session.runtime.unit : ""}\nActiveState=active\nSubState=running\nMainPID=700\nControlGroup=/user.slice/muxpilot.service\n`
    }));
    const reader = new RawSessionEvidenceReader({ transcripts: { codex: join(root, "codex", "sessions") } }, runCommand, procRoot, dataDir);

    await expect(reader.readSessionRuntime(session)).resolves.toMatchObject({
      sessionId: session.id,
      socketPresent: false,
      attachmentCommand: "codex --remote 'unix:///tmp/app-evidence.sock'",
      systemd: { ActiveState: "active", MainPID: "700" }
    });
    await expect(reader.readSessionProcessTree(session)).resolves.toMatchObject({
      sessionId: session.id,
      rootPid: 700,
      processes: [expect.objectContaining({ pid: 700 }), expect.objectContaining({ pid: 701 })]
    });
    await expect(reader.readSessionProtocolJournal(session, null, 4)).resolves.toMatchObject({
      sessionId: session.id,
      startOffset: 4,
      endOffset: 8,
      text: "two\n"
    });
  });
});

function appServerSession(id: string): ManagedSession {
  return {
    id,
    name: id,
    cwd: "/repo",
    provider: { kind: "codex", threadId: id, transcriptPath: null },
    runtime: {
      kind: "systemd_service",
      unit: "muxpilot-session-0123456789abcdef01234567.service",
      socketPath: `/tmp/${id}.sock`,
      state: "connected",
      agentVersion: "0.152.0"
    },
    resourceUnit: "muxpilot-session-0123456789abcdef01234567.service"
  } as ManagedSession;
}

async function writeProcess(root: string, pid: number, children: string, cmdline: string, status: string, cgroup: string): Promise<void> {
  const processRoot = join(root, String(pid));
  await mkdir(join(processRoot, "task", String(pid)), { recursive: true });
  await Promise.all([
    writeFile(join(processRoot, "cmdline"), cmdline),
    writeFile(join(processRoot, "status"), status),
    writeFile(join(processRoot, "cgroup"), cgroup),
    writeFile(join(processRoot, "task", String(pid), "children"), children)
  ]);
}
