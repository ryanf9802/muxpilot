import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@muxpilot/core";
import { RawSessionEvidenceReader } from "../src/services/rawSessionEvidence.js";

describe("RawSessionEvidenceReader", () => {
  it("rejects tmux evidence without executing tmux when the runtime is unavailable", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "must not run" }));
    const reader = new RawSessionEvidenceReader("/tmp/codex", runCommand, "/proc", null, false);

    await expect(reader.listTmuxPanes()).rejects.toMatchObject({
      code: "session_driver_unavailable",
      driverKind: "codex_tmux",
      statusCode: 503
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns verbatim pane listings and captures with explicit tmux options", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "list-panes" && args.at(-1) === "#{pane_id}\t#{pane_pid}") return { stdout: "%7\t700\n" };
      if (args[0] === "list-panes") return { stdout: "$1\tmuxpilot\t@2\t0\twork\t%7\n" };
      if (args[0] === "capture-pane") return { stdout: "physical wrap\ncontinues here\n\u001b[31mred\u001b[0m\n" };
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const reader = new RawSessionEvidenceReader("/tmp/codex", runCommand);

    await expect(reader.listTmuxPanes()).resolves.toMatchObject({
      fields: expect.arrayContaining(["session_name", "pane_id", "pane_pid"]),
      output: "$1\tmuxpilot\t@2\t0\twork\t%7\n"
    });
    await expect(reader.captureTmuxPane("%7", 321, true, true)).resolves.toEqual({
      paneId: "%7",
      output: "physical wrap\ncontinues here\n\u001b[31mred\u001b[0m\n"
    });
    expect(runCommand).toHaveBeenLastCalledWith("tmux", [
      "capture-pane", "-p", "-J", "-e", "-N", "-S", "-321", "-t", "%7"
    ]);
  });

  it("rejects pane ids that are not present in the live tmux listing", async () => {
    const reader = new RawSessionEvidenceReader("/tmp/codex", async () => ({ stdout: "%1\t100\n" }));
    await expect(reader.captureTmuxPane("%2", 20, false, false)).rejects.toThrow("Tmux pane not found: %2");
    await expect(reader.captureTmuxPane("all", 20, false, false)).rejects.toThrow("exact tmux pane id");
  });

  it("returns direct proc evidence for the current pane-rooted process tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "muxpilot-raw-proc-"));
    await writeProcess(root, 700, "701 702 703 ", "bash\0launcher\0", "Name:\tbash\n", "0::/scope\n");
    await writeProcess(root, 701, "", "codex\0resume\0abc\0", "Name:\tcodex\n", "0::/scope\n");
    await writeProcess(root, 703, "", "x".repeat(70 * 1024), "Name:\tlarge\n", "0::/scope\n");
    const reader = new RawSessionEvidenceReader("/tmp/codex", async () => ({ stdout: "%7\t700\n" }), root);

    await expect(reader.readTmuxProcessTree("%7")).resolves.toEqual({
      paneId: "%7",
      rootPid: 700,
      truncated: false,
      processes: [
        expect.objectContaining({ pid: 700, parentPid: null, cmdline: "bash\0launcher\0", children: "701 702 703 ", truncatedFields: [], error: null }),
        expect.objectContaining({ pid: 701, parentPid: 700, cmdline: "codex\0resume\0abc\0", children: "", truncatedFields: [], error: null }),
        expect.objectContaining({ pid: 702, parentPid: 700, cmdline: null, truncatedFields: [], error: "process exited while being sampled" }),
        expect.objectContaining({ pid: 703, parentPid: 700, truncatedFields: ["cmdline"], error: null })
      ]
    });
  });

  it("lists Codex JSONL files by filesystem recency and reads exact bounded bytes", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-raw-codex-"));
    const sessions = join(codexHome, "sessions", "2026", "08");
    await mkdir(sessions, { recursive: true });
    const first = join(sessions, "first.jsonl");
    const second = join(sessions, "second.jsonl");
    await writeFile(first, "first-line\nsecond-line\n");
    await writeFile(second, "other\n");
    const reader = new RawSessionEvidenceReader(codexHome);

    const listing = await reader.listCodexSessionFiles(1, 0);
    expect(listing.files).toHaveLength(1);
    expect(listing.nextOffset).toBe(1);
    await expect(reader.listCodexSessionFiles(1, 1)).resolves.toMatchObject({ nextOffset: null });
    const relativePath = "2026/08/first.jsonl";
    await expect(reader.readCodexSessionFile(relativePath, 6, 9)).resolves.toEqual({
      relativePath,
      fileSize: 23,
      startOffset: 6,
      endOffset: 15,
      text: "line\nseco"
    });
    await expect(reader.readCodexSessionFile(relativePath, null, 5)).resolves.toMatchObject({
      startOffset: 18,
      endOffset: 23,
      text: "line\n"
    });
  });

  it("refuses traversal and symlink escapes from the configured Codex sessions root", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "muxpilot-raw-codex-"));
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions);
    const outside = join(codexHome, "outside.jsonl");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(sessions, "link.jsonl"));
    const reader = new RawSessionEvidenceReader(codexHome);

    await expect(reader.readCodexSessionFile("../outside.jsonl", 0, 100)).rejects.toThrow("escapes");
    await expect(reader.readCodexSessionFile("link.jsonl", 0, 100)).rejects.toThrow("escapes");
    await expect(reader.readCodexSessionFile(outside, 0, 100)).rejects.toThrow("relativePath");
    await expect(reader.readCodexSessionFile("not-jsonl.txt", 0, 100)).rejects.toThrow("JSONL");
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
    const reader = new RawSessionEvidenceReader(join(root, "codex"), runCommand, procRoot, dataDir);

    await expect(reader.readSessionRuntime(session)).resolves.toMatchObject({
      sessionId: session.id,
      driverKind: "codex_app_server",
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
    driverKind: "codex_app_server",
    runtime: {
      kind: "systemd_service",
      unit: "muxpilot-session-0123456789abcdef01234567.service",
      socketPath: `/tmp/${id}.sock`,
      state: "connected",
      codexVersion: "0.152.0"
    },
    resourceUnit: "muxpilot-session-0123456789abcdef01234567.service",
    tmux: { sessionName: "muxpilot", windowIndex: 1, paneId: "%1" }
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
