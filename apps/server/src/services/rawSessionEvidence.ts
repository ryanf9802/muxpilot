import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ManagedSession } from "@muxpilot/core";

const execFileAsync = promisify(execFile);
const DEFAULT_FILE_READ_BYTES = 64 * 1024;
const MAX_PROCESS_COUNT = 64;
const MAX_PROC_FILE_BYTES = 64 * 1024;
const PANE_FIELDS = [
  "session_id",
  "session_name",
  "window_id",
  "window_index",
  "window_name",
  "pane_id",
  "pane_index",
  "pane_active",
  "pane_current_path",
  "pane_current_command",
  "pane_title",
  "pane_pid",
  "pane_width_x_height",
  "tmux_server_pid",
  "session_created"
] as const;
const PANE_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_title}",
  "#{pane_pid}",
  "#{pane_width}x#{pane_height}",
  "#{pid}",
  "#{session_created}"
].join("\t");
const APP_SERVER_UNIT = /^muxpilot-session-[a-f0-9]{24}\.service$/;

type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

export interface RawCodexFile {
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface RawProcessRecord {
  pid: number;
  parentPid: number | null;
  cmdline: string | null;
  status: string | null;
  cgroup: string | null;
  children: string | null;
  truncatedFields: string[];
  error: string | null;
}

export interface RawSessionEvidence {
  listTmuxPanes(): Promise<{ fields: readonly string[]; output: string }>;
  captureTmuxPane(paneId: string, lines: number, includeAnsi: boolean, joinWrappedLines: boolean): Promise<{ paneId: string; output: string }>;
  readTmuxProcessTree(paneId: string): Promise<{ paneId: string; rootPid: number; processes: RawProcessRecord[]; truncated: boolean }>;
  readSessionRuntime(session: ManagedSession): Promise<Record<string, unknown>>;
  readSessionProcessTree(session: ManagedSession): Promise<{ sessionId: string; rootPid: number | null; processes: RawProcessRecord[]; truncated: boolean }>;
  readSessionProtocolJournal(session: ManagedSession, offset: number | null, length: number): Promise<{
    sessionId: string;
    fileSize: number;
    startOffset: number;
    endOffset: number;
    text: string;
  }>;
  listCodexSessionFiles(limit: number, offset: number): Promise<{ root: string; files: RawCodexFile[]; nextOffset: number | null }>;
  readCodexSessionFile(relativePath: string, offset: number | null, length: number): Promise<{
    relativePath: string;
    fileSize: number;
    startOffset: number;
    endOffset: number;
    text: string;
  }>;
}

export class RawSessionEvidenceReader implements RawSessionEvidence {
  private readonly codexSessionsRoot: string;

  constructor(
    codexHome: string,
    private readonly runCommand: CommandRunner = async (command, args) => execFileAsync(command, args, { maxBuffer: 4 * 1024 * 1024 }),
    private readonly procRoot = "/proc",
    private readonly dataDir: string | null = null
  ) {
    this.codexSessionsRoot = resolve(codexHome, "sessions");
  }

  async listTmuxPanes(): Promise<{ fields: readonly string[]; output: string }> {
    const { stdout } = await this.runCommand("tmux", ["list-panes", "-a", "-F", PANE_FORMAT]);
    return { fields: PANE_FIELDS, output: stdout };
  }

  async captureTmuxPane(
    paneId: string,
    lines: number,
    includeAnsi: boolean,
    joinWrappedLines: boolean
  ): Promise<{ paneId: string; output: string }> {
    await this.panePid(paneId);
    const args = ["capture-pane", "-p", "-N", "-S", `-${lines}`, "-t", paneId];
    if (includeAnsi) args.splice(2, 0, "-e");
    if (joinWrappedLines) args.splice(2, 0, "-J");
    const { stdout } = await this.runCommand("tmux", args);
    return { paneId, output: stdout };
  }

  async readTmuxProcessTree(paneId: string): Promise<{
    paneId: string;
    rootPid: number;
    processes: RawProcessRecord[];
    truncated: boolean;
  }> {
    const rootPid = await this.panePid(paneId);
    const tree = await this.readProcessTree(rootPid);
    return { paneId, rootPid, ...tree };
  }

  async readSessionRuntime(session: ManagedSession): Promise<Record<string, unknown>> {
    if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") {
      return {
        sessionId: session.id,
        driverKind: session.driverKind,
        runtime: session.runtime,
        resourceUnit: session.resourceUnit ?? session.resourceScope ?? null,
        attachmentCommand: `tmux select-window -t ${shellQuote(`${session.tmux.sessionName}:${session.tmux.windowIndex}`)} && tmux attach-session -t ${shellQuote(session.tmux.sessionName)}`
      };
    }
    const runtime = session.runtime;
    if (!APP_SERVER_UNIT.test(runtime.unit)) throw new Error("Refusing non-muxpilot app-server unit");
    const { stdout } = await this.runCommand("systemctl", [
      "--user", "show", runtime.unit,
      "--property=Id", "--property=ActiveState", "--property=SubState", "--property=MainPID", "--property=ControlGroup",
      "--no-pager"
    ]);
    const properties = parseProperties(stdout);
    const socket = await stat(runtime.socketPath).catch(() => null);
    return {
      sessionId: session.id,
      driverKind: session.driverKind,
      runtime,
      resourceUnit: session.resourceUnit ?? runtime.unit,
      systemd: properties,
      socketPresent: socket?.isSocket() === true,
      attachmentCommand: `codex --remote ${shellQuote(`unix://${runtime.socketPath}`)}`
    };
  }

  async readSessionProcessTree(session: ManagedSession): Promise<{
    sessionId: string;
    rootPid: number | null;
    processes: RawProcessRecord[];
    truncated: boolean;
  }> {
    if (session.driverKind !== "codex_app_server" || session.runtime?.kind !== "systemd_service") {
      const tree = await this.readTmuxProcessTree(session.tmux.paneId);
      return { sessionId: session.id, rootPid: tree.rootPid, processes: tree.processes, truncated: tree.truncated };
    }
    if (!APP_SERVER_UNIT.test(session.runtime.unit)) throw new Error("Refusing non-muxpilot app-server unit");
    const { stdout } = await this.runCommand("systemctl", ["--user", "show", session.runtime.unit, "--property=MainPID", "--value"]);
    const rootPid = Number(stdout.trim());
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
      return { sessionId: session.id, rootPid: null, processes: [], truncated: false };
    }
    return { sessionId: session.id, rootPid, ...await this.readProcessTree(rootPid) };
  }

  async readSessionProtocolJournal(session: ManagedSession, offset: number | null, length: number): Promise<{
    sessionId: string;
    fileSize: number;
    startOffset: number;
    endOffset: number;
    text: string;
  }> {
    if (session.driverKind !== "codex_app_server") throw new Error("Protocol journals are available only for app-server sessions");
    if (!this.dataDir) throw new Error("App-server protocol journal storage is unavailable");
    const capabilityId = createHash("sha256").update(`muxpilot-app-server:${session.id}`).digest("hex").slice(0, 24);
    const path = join(resolve(this.dataDir), "protocol", "app-server-sessions", capabilityId, "protocol.jsonl");
    const result = await readFileSlice(path, offset, length);
    return { sessionId: session.id, ...result };
  }

  private async readProcessTree(rootPid: number): Promise<{ processes: RawProcessRecord[]; truncated: boolean }> {
    const pending: Array<{ pid: number; parentPid: number | null }> = [{ pid: rootPid, parentPid: null }];
    const seen = new Set<number>();
    const processes: RawProcessRecord[] = [];
    while (pending.length > 0 && processes.length < MAX_PROCESS_COUNT) {
      const candidate = pending.shift();
      if (!candidate || seen.has(candidate.pid)) continue;
      seen.add(candidate.pid);
      const record = await this.readProcess(candidate.pid, candidate.parentPid);
      processes.push(record);
      for (const childPid of processIds(record.children)) pending.push({ pid: childPid, parentPid: candidate.pid });
    }
    return { processes, truncated: pending.length > 0 };
  }

  async listCodexSessionFiles(limit: number, offset: number): Promise<{ root: string; files: RawCodexFile[]; nextOffset: number | null }> {
    const files = await walkJsonlFiles(this.codexSessionsRoot);
    const records = (await Promise.all(files.map(async (path) => {
      const metadata = await stat(path).catch(() => null);
      if (!metadata?.isFile()) return null;
      return {
        relativePath: relative(this.codexSessionsRoot, path),
        sizeBytes: metadata.size,
        modifiedAtMs: metadata.mtimeMs
      } satisfies RawCodexFile;
    }))).filter((record): record is RawCodexFile => record !== null)
      .sort((first, second) => second.modifiedAtMs - first.modifiedAtMs || first.relativePath.localeCompare(second.relativePath));
    const filesPage = records.slice(offset, offset + limit);
    const nextOffset = offset + filesPage.length < records.length ? offset + filesPage.length : null;
    return { root: this.codexSessionsRoot, files: filesPage, nextOffset };
  }

  async readCodexSessionFile(relativePath: string, offset: number | null, length: number): Promise<{
    relativePath: string;
    fileSize: number;
    startOffset: number;
    endOffset: number;
    text: string;
  }> {
    const path = await this.resolveCodexJsonl(relativePath);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("Codex session path is not a file");
    const startOffset = offset === null ? Math.max(0, metadata.size - length) : Math.min(offset, metadata.size);
    const readLength = Math.min(length, Math.max(0, metadata.size - startOffset));
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(readLength);
      const { bytesRead } = await file.read(buffer, 0, readLength, startOffset);
      const content = buffer.subarray(0, bytesRead);
      return {
        relativePath,
        fileSize: metadata.size,
        startOffset,
        endOffset: startOffset + bytesRead,
        text: content.toString("utf8")
      };
    } finally {
      await file.close();
    }
  }

  private async panePid(paneId: string): Promise<number> {
    if (!/^%\d+$/.test(paneId)) throw new Error("paneId must be an exact tmux pane id");
    const { stdout } = await this.runCommand("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
    const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(`${paneId}\t`));
    const pid = Number(line?.split("\t")[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Tmux pane not found: ${paneId}`);
    return pid;
  }

  private async readProcess(pid: number, parentPid: number | null): Promise<RawProcessRecord> {
    const root = resolve(this.procRoot, String(pid));
    const [cmdline, status, cgroup, children] = await Promise.all([
      readBoundedText(resolve(root, "cmdline")),
      readBoundedText(resolve(root, "status")),
      readBoundedText(resolve(root, "cgroup")),
      readBoundedText(resolve(root, "task", String(pid), "children"))
    ]);
    const values = { cmdline, status, cgroup, children };
    const missing = Object.values(values).every((value) => value.content === null);
    return {
      pid,
      parentPid,
      cmdline: cmdline.content,
      status: status.content,
      cgroup: cgroup.content,
      children: children.content,
      truncatedFields: Object.entries(values).filter(([, value]) => value.truncated).map(([name]) => name),
      error: missing ? "process exited while being sampled" : null
    };
  }

  private async resolveCodexJsonl(relativePath: string): Promise<string> {
    if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0") || !relativePath.endsWith(".jsonl")) {
      throw new Error("relativePath must identify a Codex JSONL file");
    }
    const root = await realpath(this.codexSessionsRoot);
    const candidate = await realpath(resolve(root, relativePath));
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("Codex session path escapes the configured sessions root");
    return candidate;
  }
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return walkJsonlFiles(path);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  }));
  return nested.flat();
}

function processIds(value: string | null): number[] {
  if (!value) return [];
  return value.trim().split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function readBoundedText(path: string): Promise<{ content: string | null; truncated: boolean }> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return { content: null, truncated: false };
  try {
    const buffer = Buffer.alloc(MAX_PROC_FILE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return {
      content: buffer.subarray(0, Math.min(bytesRead, MAX_PROC_FILE_BYTES)).toString("utf8"),
      truncated: bytesRead > MAX_PROC_FILE_BYTES
    };
  } catch {
    return { content: null, truncated: false };
  } finally {
    await file.close();
  }
}

async function readFileSlice(path: string, offset: number | null, length: number): Promise<{
  fileSize: number;
  startOffset: number;
  endOffset: number;
  text: string;
}> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Evidence path is not a file");
  const startOffset = offset === null ? Math.max(0, metadata.size - length) : Math.min(offset, metadata.size);
  const readLength = Math.min(length, Math.max(0, metadata.size - startOffset));
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await file.read(buffer, 0, readLength, startOffset);
    return {
      fileSize: metadata.size,
      startOffset,
      endOffset: startOffset + bytesRead,
      text: buffer.subarray(0, bytesRead).toString("utf8")
    };
  } finally {
    await file.close();
  }
}

function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const RAW_CODEX_DEFAULT_READ_BYTES = DEFAULT_FILE_READ_BYTES;
